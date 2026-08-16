/**
 * proceduralGrass.ts — procedural grass generation for the Grass block overlay.
 *
 * Produces a list of coloured world pixels that grow downward from a block's
 * upward-facing exposed edges, plus sparse blades that poke up above them.
 * Pure and canvas-free so the look can be unit-tested and previewed as ASCII
 * (see `grassAsciiPreview`) without a renderer.
 *
 * ── Why not 2D Perlin ────────────────────────────────────────────────────────
 * A block is 8 world pixels and the grass creeps only 2-5 px, so a smooth 2D
 * noise field sampled per pixel has nowhere near enough room to resolve — it
 * reads as mush. Instead the randomness lives in ONE dimension: 1D fractal
 * value noise along the edge decides how deep the grass grows in each pixel
 * COLUMN. That is what produces the characteristic clumped, uneven grass line
 * while every individual pixel stays crisp and fully opaque.
 *
 * ── What makes it read as grass rather than a green stripe ───────────────────
 *  1. Clumping, not waviness. Three octaves (broad ~11px clumps, medium ~5px,
 *     fine ~2px jitter) so tufts group together instead of alternating evenly.
 *  2. A DITHERED bottom row. The deepest row is only partially filled, chosen
 *     per pixel, so the grass dissolves into the block instead of ending on a
 *     hard line. This is the main reason it looks painted into the sprite
 *     rather than pasted on top.
 *  3. Blades above the silhouette. 1-2px spikes on a minority of columns,
 *     suppressed adjacent to each other so they scatter rather than forming a
 *     second solid row. Without these it reads as moss, not grass.
 *  4. Patch shading. A slow noise channel shifts whole regions one step up or
 *     down the palette ramp, so the field has lighter and darker areas.
 *  5. Corner drape. Columns whose side is also exposed grow deeper, which
 *     reads as grass hanging over the lip of a ledge.
 *
 * All randomness is a hash of WORLD pixel coordinates, so the result is stable
 * frame to frame, identical across chunk boundaries (no seams), and unchanged
 * by camera movement — the same determinism guarantee the edge overlay's band
 * noise makes (see surfaceEdgeOverlay.ts).
 */

// ── Deterministic hashing / value noise ──────────────────────────────────────

/**
 * Hashes 3 integers to a float in [0, 1). Same MurmurHash3-style mix used by
 * the rest of the block renderer (`hashTilePosition` in
 * proceduralBlockSprite.ts, `_hash4` in surfaceEdgeOverlay.ts).
 */
function _hash3(a: number, b: number, c: number): number {
  let h = (a * 73856093) ^ (b * 19349663) ^ (c * 83492791);
  h |= 0;
  h ^= h >>> 16;
  h = Math.imul(h, 2246822519);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489917);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

/** Smoothstep, used to interpolate between integer noise lattice points. */
function _smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * 1D value noise in [0, 1): hash the two surrounding lattice points at the
 * given period and smoothstep between them. `channel` selects an independent
 * noise stream so several octaves (or unrelated uses) never correlate.
 */
function _valueNoise1D(x: number, period: number, seed: number, channel: number): number {
  const scaled = x / period;
  const i0 = Math.floor(scaled);
  const frac = scaled - i0;
  const a = _hash3(i0, seed, channel);
  const b = _hash3(i0 + 1, seed, channel);
  return a + (b - a) * _smoothstep(frac);
}

/**
 * Three-octave 1D fractal noise in [0, 1). Periods are deliberately coprime-ish
 * (11 / 5 / 2 px) so the octaves do not line up and produce a visible repeat at
 * the small scales this operates on.
 */
function _fbm1D(x: number, seed: number): number {
  const broad = _valueNoise1D(x, 11, seed, 0);
  const medium = _valueNoise1D(x, 5, seed, 1);
  const fine = _valueNoise1D(x, 2, seed, 2);
  return broad * 0.6 + medium * 0.3 + fine * 0.1;
}

// ── Parameters ───────────────────────────────────────────────────────────────

/**
 * Palette ramp, lightest first. Index 0 is the sun-catching top row and blade
 * tips; the last entry is the deepest colour that dithers into the block.
 *
 * Four steps is deliberate: pixel art at this scale reads best with a short,
 * high-contrast ramp, and it leaves room for the patch-shading channel to
 * shift a clump one step either way without running out of colours.
 */
export const DEFAULT_GRASS_PALETTE: readonly string[] = [
  '#8ec44a', // light — top row, blade tips
  '#5f9e3a', // mid
  '#3d7130', // dark
  '#2a5024', // deepest — dithers into the block below
];

export interface GrassParams {
  /** Shallowest grass depth, in world pixels. */
  readonly minDepthPx: number;
  /** Deepest grass depth, in world pixels (before the corner-drape bonus). */
  readonly maxDepthPx: number;
  /** Fraction of columns that grow a blade above the edge, 0..1. */
  readonly bladeChance: number;
  /** Extra depth, in pixels, for columns whose side face is also exposed. */
  readonly drapeBonusPx: number;
  /**
   * Coverage noise below this leaves the column bare, exposing the block.
   * 0 disables bare patches entirely (a fully grassed surface).
   */
  readonly bareThreshold: number;
  /** Palette ramp, lightest first. */
  readonly palette: readonly string[];
  /** Varies the whole field; two walls with different seeds never align. */
  readonly seed: number;
}

export const DEFAULT_GRASS_PARAMS: GrassParams = Object.freeze({
  minDepthPx: 2,
  maxDepthPx: 5,
  bladeChance: 0.30,
  drapeBonusPx: 2,
  bareThreshold: 0.15,
  palette: DEFAULT_GRASS_PALETTE,
  seed: 0,
});

/** One generated grass pixel. `shade` indexes into `GrassParams.palette`. */
export interface GrassPixel {
  readonly x: number;
  readonly y: number;
  readonly shade: number;
}

/**
 * An upward-facing surface pixel: a solid pixel with open air directly above.
 * Grass grows down from `y` and blades grow up from `y - 1`.
 */
export interface GrassAnchor {
  readonly x: number;
  readonly y: number;
}

/** Solidity probe in world pixels. Out-of-bounds should report false (air). */
export type IsSolidAtPx = (xPx: number, yPx: number) => boolean;

// ── Generation ───────────────────────────────────────────────────────────────

/**
 * Expands fBm's output around its midpoint.
 *
 * Averaging octaves pulls the raw value toward 0.5, so an unstretched field
 * would make almost every column the same middling depth — the clumping would
 * exist numerically but never be visible across a 2-5px range. Stretching
 * makes columns actually reach both extremes, which is what turns the grass
 * line from "slightly wavy" into "clumped".
 */
function _expandContrast(t: number): number {
  return Math.max(0, Math.min(1, 0.5 + (t - 0.5) * 2.1));
}

/**
 * Coverage in [0, 1] for a column: how established the grass is here.
 *
 * Without this every surface column grew grass, which made the top of the band
 * one unbroken painted line across the whole level — the single thing that most
 * gave away that it was generated. A slow channel (period ~23px, well above the
 * depth field's 11px clumps so the two never beat against each other) opens up
 * occasional bare patches where the block shows through.
 *
 * The value tapers rather than switching off, so grass thins out approaching a
 * bare patch instead of stopping at a hard vertical edge.
 */
function _coverageForColumn(x: number, y: number, params: GrassParams): number {
  // Folded into the seed, quantized to the block grid: surfaces at different
  // heights get independent coverage, so a platform can never be doomed to be
  // bare just because it happens to sit at the same world X as a bare patch on
  // the ground below. Quantizing (rather than using raw y) keeps a staircase's
  // steps consistent with each other instead of decorrelating every 2px riser.
  const bandSeed = params.seed + Math.floor(y / 8) * 97;
  const n = _valueNoise1D(x, 19, bandSeed, 4);
  if (n <= params.bareThreshold) return 0;
  const taper = params.bareThreshold + 0.14;
  if (n >= taper) return 1;
  return (n - params.bareThreshold) / (taper - params.bareThreshold);
}

/**
 * Grass depth for one column, in pixels, including the corner-drape bonus.
 * Returns 0 for a bare column.
 */
function _depthForColumn(anchor: GrassAnchor, isSolid: IsSolidAtPx, params: GrassParams): number {
  const coverage = _coverageForColumn(anchor.x, anchor.y, params);
  if (coverage <= 0) return 0;

  const t = _expandContrast(_fbm1D(anchor.x, params.seed));
  const span = Math.max(0, params.maxDepthPx - params.minDepthPx);
  let depth = params.minDepthPx + Math.round(t * span);

  // A column that is also exposed sideways sits on the lip of a ledge — let
  // the grass hang further down it so ledges read as draped rather than
  // sliced flat.
  const sideExposed = !isSolid(anchor.x - 1, anchor.y) || !isSolid(anchor.x + 1, anchor.y);
  if (sideExposed) depth += params.drapeBonusPx;

  // Thin the band out as it approaches a bare patch.
  if (coverage < 1) depth = Math.max(1, Math.round(depth * coverage));

  return depth;
}

/**
 * Palette index for a pixel `row` steps below the top of its column.
 *
 * Keyed on the ABSOLUTE row, not on the row's fraction of the column depth.
 * Normalizing by depth would make a 2px column and a 5px column disagree
 * violently about what colour their second row is, and since depth varies per
 * column that produced a chaotic speckle rather than a shaded band. Keying on
 * absolute depth means every column agrees at a given row, so the field reads
 * as one lit surface whose lower boundary happens to be uneven.
 *
 * A slow patch channel then shifts whole regions one step along the ramp,
 * including the top row — otherwise every column shares one identical
 * highlight and the grass ends in a hard, obviously-procedural bright stripe.
 */
function _shadeForRow(x: number, row: number, params: GrassParams): number {
  const lastShade = params.palette.length - 1;
  let shade = Math.min(row, lastShade);

  const patch = _valueNoise1D(x, 13, params.seed, 3);
  if (patch > 0.70) shade -= 1;
  else if (patch < 0.30) shade += 1;

  return Math.max(0, Math.min(lastShade, shade));
}

/**
 * True when the deepest row of a column should be filled. Only about half of
 * these pixels are kept, so the bottom of the grass dissolves into the block
 * instead of ending on a hard horizontal line.
 */
function _keepDitherPixel(x: number, y: number, params: GrassParams): boolean {
  return _hash3(x, y, params.seed + 101) > 0.45;
}

/**
 * True when a column grows a blade above the edge.
 *
 * Blades are allowed to sit next to each other — real grass grows in tufts,
 * and forbidding adjacency (an earlier attempt) produced lonely evenly-spaced
 * dots that read as speckle rather than vegetation. Only runs of three or more
 * are broken up, which is enough to stop a tuft from flattening into a second
 * solid row. The rule is a pure function of x, so neighbouring columns agree
 * without depending on iteration order.
 */
function _hasBlade(x: number, params: GrassParams): boolean {
  if (params.bladeChance <= 0) return false;
  const qualifies = (col: number): boolean =>
    _hash3(col, 0, params.seed + 202) < params.bladeChance;
  if (!qualifies(x)) return false;
  return !(qualifies(x - 1) && qualifies(x - 2));
}

/**
 * Blade height in pixels (1 or 2). Tufts get their silhouette from mixing the
 * two heights, so this is close to an even split rather than mostly-short.
 */
function _bladeHeight(x: number, params: GrassParams): number {
  return _hash3(x, 1, params.seed + 303) > 0.5 ? 2 : 1;
}

/**
 * Generates every grass pixel for the given upward-facing surface anchors.
 *
 * Growth stops early if the block runs out beneath the anchor, so grass never
 * escapes the geometry it is painted on (thin ledges, stair treads, the top
 * half of a half-block). Blades only occupy pixels that are actually air.
 *
 * The returned list contains each coordinate at most once.
 */
export function generateGrassPixels(
  anchors: Iterable<GrassAnchor>,
  isSolid: IsSolidAtPx,
  params: GrassParams = DEFAULT_GRASS_PARAMS,
): GrassPixel[] {
  const out: GrassPixel[] = [];
  const seen = new Set<string>();

  const emit = (x: number, y: number, shade: number): void => {
    const key = `${x},${y}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ x, y, shade });
  };

  for (const anchor of anchors) {
    const depth = _depthForColumn(anchor, isSolid, params);

    // ── Downward band, into the block ──
    // `depth` counts FULLY filled rows, so it is the creep depth a level
    // designer actually sees. The dithered dissolve is one extra row below
    // that — folding it into `depth` (an earlier attempt) silently stole a
    // pixel from every column and skewed the visible range shallow.
    const lastShade = params.palette.length - 1;
    let filled = 0;
    for (let row = 0; row < depth; row++) {
      const y = anchor.y + row;
      if (!isSolid(anchor.x, y)) break; // ran out of block — stop, never overhang
      emit(anchor.x, y, _shadeForRow(anchor.x, row, params));
      filled++;
    }

    // ── Dissolve row ──
    // Pinned to the darkest colour and only half-filled, so the band breaks up
    // into the block instead of ending on a hard line. Letting patch shading
    // vary this row too made the boundary read as speckle rather than a fade.
    if (filled === depth) {
      const y = anchor.y + depth;
      if (isSolid(anchor.x, y) && _keepDitherPixel(anchor.x, y, params)) {
        emit(anchor.x, y, lastShade);
      }
    }

    // ── Blades, above the silhouette ──
    // Bare columns grow nothing at all, blades included.
    if (depth > 0 && _hasBlade(anchor.x, params)) {
      const height = _bladeHeight(anchor.x, params);
      for (let k = 1; k <= height; k++) {
        const y = anchor.y - k;
        if (isSolid(anchor.x, y)) break; // blocked by geometry above
        // Tips use the lightest shade; the base of a 2px blade is one step down
        // so tall blades still read as having a lit tip.
        emit(anchor.x, y, k === height ? 0 : 1);
      }
    }
  }

  return out;
}

/**
 * Collects every upward-facing surface pixel in a rectangular world-pixel
 * region: a solid pixel whose neighbour directly above is air.
 */
export function collectGrassAnchors(
  x0: number, y0: number, x1: number, y1: number,
  isSolid: IsSolidAtPx,
): GrassAnchor[] {
  const anchors: GrassAnchor[] = [];
  for (let x = x0; x < x1; x++) {
    for (let y = y0; y < y1; y++) {
      if (!isSolid(x, y)) continue;
      if (isSolid(x, y - 1)) continue;
      anchors.push({ x, y });
    }
  }
  return anchors;
}

// ── ASCII preview (development aid) ──────────────────────────────────────────

/**
 * Renders a generated grass field as text, one character per world pixel, so
 * the look can be judged and regression-tested without a canvas:
 *   `0`-`3` grass pixels by palette index (0 = lightest)
 *   `#`     solid block with no grass on it
 *   `.`     empty air
 */
export function grassAsciiPreview(
  pixels: readonly GrassPixel[],
  isSolid: IsSolidAtPx,
  x0: number, y0: number, x1: number, y1: number,
): string {
  const byKey = new Map<string, number>();
  for (const p of pixels) byKey.set(`${p.x},${p.y}`, p.shade);

  const rows: string[] = [];
  for (let y = y0; y < y1; y++) {
    let line = '';
    for (let x = x0; x < x1; x++) {
      const shade = byKey.get(`${x},${y}`);
      line += shade !== undefined ? String(shade) : (isSolid(x, y) ? '#' : '.');
    }
    rows.push(line);
  }
  return rows.join('\n');
}
