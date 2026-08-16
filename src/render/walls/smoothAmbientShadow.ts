/**
 * smoothAmbientShadow.ts — Smooth per-pixel gradient block shadow solver & rasterizer.
 *
 * Provides bilinear corner-vertex interpolation and smooth per-pixel gradient
 * darkness rendering for solid walls when graphics quality is set to 'high'.
 *
 * Algorithm & Mathematical Model:
 * ────────────────────────────────
 * 1. For each grid vertex (vx, vy) at the intersection of 4 tile quadrants:
 *    - Open-air tiles have darkness 0.0 (fully lit by ambient light).
 *    - Solid tiles have their computed darkness from `ambientDepths` (e.g. 0.15 for surface,
 *      0.30 for depth 1, 0.70 for depth 2, 1.0 for depth 3+).
 *    - Authored ambient light blocker tiles have darkness 1.0 (opaque to light).
 *    - Out-of-bounds cells have darkness 1.0 (solid earth).
 *    - Vertex darkness V(vx, vy) = average of the 4 surrounding tile darkness values.
 *
 * 2. For each tile [col, col+1] × [row, row+1]:
 *    - Top-Left:     d00 = V(col, row)
 *    - Top-Right:    d10 = V(col + 1, row)
 *    - Bottom-Left:  d01 = V(col, row + 1)
 *    - Bottom-Right: d11 = V(col + 1, row + 1)
 *
 * 3. Inside the tile at normalized position (u, v) ∈ [0, 1] × [0, 1]:
 *    - D(u, v) = (1 - u)(1 - v) d00 + u(1 - v) d10 + (1 - u)v d01 + u v d11.
 *    - At every pixel (px, py), D is sampled at u = (px + 0.5) / tileSizeScreen,
 *      v = (py + 0.5) / tileSizeScreen.
 *
 * Continuity Guarantees:
 * ──────────────────────
 * - Across any shared horizontal or vertical edge between adjacent tiles, the
 *   interpolated values along the edge are identical (C0 continuous).
 * - There are zero seams between tiles and zero chunk boundary artifacts.
 * - Solid surfaces adjacent to open air smoothly fade from lit air into deeper solid rock.
 */

export interface CornerDarkness {
  d00: number;
  d10: number;
  d01: number;
  d11: number;
}

/**
 * Returns the effective darkness alpha for a single tile coordinate (col, row).
 *
 * - Outside room bounds: 1.0 (solid rock)
 * - Solid tile: ambientDepths.get(`${col},${row}`) ?? 1.0
 * - Non-solid blocker: 1.0
 * - Non-solid air: 0.0 (fully lit ambient air)
 */
export function getTileDarkness(
  col: number,
  row: number,
  occupied: ReadonlySet<string>,
  blockers: ReadonlySet<string>,
  ambientDepths: ReadonlyMap<string, number> | null,
  roomWidthBlocks: number,
  roomHeightBlocks: number,
): number {
  if (col < 0 || col >= roomWidthBlocks || row < 0 || row >= roomHeightBlocks) {
    return 1.0;
  }
  const key = `${col},${row}`;
  if (occupied.has(key)) {
    return ambientDepths?.get(key) ?? 1.0;
  }
  if (blockers.has(key)) {
    return 1.0;
  }
  return 0.0;
}

/**
 * Computes the darkness alpha at corner vertex (vx, vy).
 *
 * (vx, vy) is the shared intersection of the 4 tiles:
 * - (vx - 1, vy - 1) [top-left]
 * - (vx,     vy - 1) [top-right]
 * - (vx - 1, vy    ) [bottom-left]
 * - (vx,     vy    ) [bottom-right]
 */
export function computeVertexDarkness(
  vx: number,
  vy: number,
  occupied: ReadonlySet<string>,
  blockers: ReadonlySet<string>,
  ambientDepths: ReadonlyMap<string, number> | null,
  roomWidthBlocks: number,
  roomHeightBlocks: number,
): number {
  const dTL = getTileDarkness(vx - 1, vy - 1, occupied, blockers, ambientDepths, roomWidthBlocks, roomHeightBlocks);
  const dTR = getTileDarkness(vx,     vy - 1, occupied, blockers, ambientDepths, roomWidthBlocks, roomHeightBlocks);
  const dBL = getTileDarkness(vx - 1, vy,     occupied, blockers, ambientDepths, roomWidthBlocks, roomHeightBlocks);
  const dBR = getTileDarkness(vx,     vy,     occupied, blockers, ambientDepths, roomWidthBlocks, roomHeightBlocks);

  return (dTL + dTR + dBL + dBR) * 0.25;
}

/**
 * Returns the 4 corner darkness values for tile (col, row).
 */
export function getTileCornerDarkness(
  col: number,
  row: number,
  occupied: ReadonlySet<string>,
  blockers: ReadonlySet<string>,
  ambientDepths: ReadonlyMap<string, number> | null,
  roomWidthBlocks: number,
  roomHeightBlocks: number,
): CornerDarkness {
  const d00 = computeVertexDarkness(col,     row,     occupied, blockers, ambientDepths, roomWidthBlocks, roomHeightBlocks);
  const d10 = computeVertexDarkness(col + 1, row,     occupied, blockers, ambientDepths, roomWidthBlocks, roomHeightBlocks);
  const d01 = computeVertexDarkness(col,     row + 1, occupied, blockers, ambientDepths, roomWidthBlocks, roomHeightBlocks);
  const d11 = computeVertexDarkness(col + 1, row + 1, occupied, blockers, ambientDepths, roomWidthBlocks, roomHeightBlocks);

  return { d00, d10, d01, d11 };
}

/**
 * Bilinear interpolation formula for (u, v) ∈ [0, 1] × [0, 1].
 */
export function interpolateTileDarkness(
  u: number,
  v: number,
  d00: number,
  d10: number,
  d01: number,
  d11: number,
): number {
  const dLeft  = (1 - v) * d00 + v * d01;
  const dRight = (1 - v) * d10 + v * d11;
  return (1 - u) * dLeft + u * dRight;
}

// ── Reusable Scratch Canvas for Pixel Rasterization ───────────────────────────

let _scratchCanvas: HTMLCanvasElement | null = null;
let _scratchCtx: CanvasRenderingContext2D | null = null;
let _scratchImgData: ImageData | null = null;
let _scratchSize = 0;

function _getScratch(size: number): { ctx: CanvasRenderingContext2D; canvas: HTMLCanvasElement; imgData: ImageData } | null {
  if (typeof document === 'undefined') return null;
  if (_scratchCanvas === null) {
    _scratchCanvas = document.createElement('canvas');
    _scratchCtx = _scratchCanvas.getContext('2d', { willReadFrequently: false });
  }
  if (_scratchCtx === null) return null;
  if (_scratchSize < size || _scratchImgData === null) {
    const allocSize = Math.max(size, 64);
    _scratchCanvas.width = allocSize;
    _scratchCanvas.height = allocSize;
    _scratchImgData = _scratchCtx.createImageData(allocSize, allocSize);
    _scratchSize = allocSize;
  }
  return { ctx: _scratchCtx, canvas: _scratchCanvas, imgData: _scratchImgData };
}

/**
 * Renders the smooth per-pixel gradient darkness overlay for a single tile.
 */
export function renderTileSmoothDarkness(
  ctx: CanvasRenderingContext2D,
  tileX: number,
  tileY: number,
  tileSizeScreen: number,
  d00: number,
  d10: number,
  d01: number,
  d11: number,
): void {
  // If fully lit, no darkness overlay to draw.
  if (d00 <= 0 && d10 <= 0 && d01 <= 0 && d11 <= 0) return;

  const S = Math.round(tileSizeScreen);
  if (S <= 0) return;

  // Uniform darkness fast path
  if (d00 === d10 && d00 === d01 && d00 === d11) {
    ctx.fillStyle = `rgba(0,0,0,${d00})`;
    ctx.fillRect(tileX, tileY, S, S);
    return;
  }

  const scratch = _getScratch(S);
  if (scratch === null) {
    // Fallback if DOM canvas is unavailable (e.g. non-browser / headless test)
    const avg = (d00 + d10 + d01 + d11) * 0.25;
    ctx.fillStyle = `rgba(0,0,0,${avg})`;
    ctx.fillRect(tileX, tileY, S, S);
    return;
  }

  const buf32 = new Uint32Array(scratch.imgData.data.buffer);
  const stride = _scratchSize;

  for (let y = 0; y < S; y++) {
    const v = (y + 0.5) / S;
    const dLeft  = (1 - v) * d00 + v * d01;
    const dRight = (1 - v) * d10 + v * d11;
    const rowOffset = y * stride;
    for (let x = 0; x < S; x++) {
      const u = (x + 0.5) / S;
      const d = (1 - u) * dLeft + u * dRight;
      const alpha = Math.min(255, Math.max(0, Math.round(d * 255)));
      // Little-endian RGBA: 0xAABBGGRR -> (alpha << 24) produces black RGB with calculated alpha
      buf32[rowOffset + x] = (alpha << 24) >>> 0;
    }
  }

  scratch.ctx.putImageData(scratch.imgData, 0, 0, 0, 0, S, S);
  ctx.drawImage(scratch.canvas, 0, 0, S, S, tileX, tileY, S, S);
}
