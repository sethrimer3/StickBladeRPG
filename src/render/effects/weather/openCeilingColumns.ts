/**
 * Shared open-ceiling-column detection, used by both the rain/sunny
 * foreground renderers (world-space wall arrays) and the editor's weather
 * dropdown warning (block-space EditorWall list).
 *
 * A column is "open" when nothing seals its ceiling — i.e. the topmost wall
 * surface found in that column is not near the room's top edge. Column width
 * matches the wall grid cell (`CELL_WORLD`).
 */

export const CELL_WORLD = 32;
export const CEILING_OPEN_EPS_WORLD = 10;

/** Minimal world-space wall rect — just enough to derive per-column topmost-surface Y. */
export interface WeatherWallRectWorld {
  xWorld: number;
  yWorld: number;
  wWorld: number;
}

export interface OpenCeilingColumns {
  /** Topmost wall-surface Y per column (world units); room floor when no wall found. */
  columnLandingY: number[];
  /** World-space X (column center) of every open column. */
  openColumnXs: number[];
}

export function computeOpenCeilingColumns(
  worldWidthWorld: number,
  worldHeightWorld: number,
  walls: readonly WeatherWallRectWorld[],
): OpenCeilingColumns {
  const numColumns = Math.max(1, Math.ceil(worldWidthWorld / CELL_WORLD));
  const landingY = new Array<number>(numColumns).fill(worldHeightWorld - 1);
  for (const w of walls) {
    const c0 = Math.max(0, Math.floor(w.xWorld / CELL_WORLD));
    const c1 = Math.min(numColumns - 1, Math.floor((w.xWorld + w.wWorld) / CELL_WORLD));
    for (let c = c0; c <= c1; c++) {
      if (w.yWorld < landingY[c]) landingY[c] = w.yWorld;
    }
  }

  const openColumnXs: number[] = [];
  for (let c = 0; c < numColumns; c++) {
    if (landingY[c] > CEILING_OPEN_EPS_WORLD) {
      openColumnXs.push(c * CELL_WORLD + CELL_WORLD * 0.5);
    }
  }
  return { columnLandingY: landingY, openColumnXs };
}

/** True if the room has at least one column with no ceiling wall sealing it. */
export function hasAnyOpenCeilingColumn(
  worldWidthWorld: number,
  worldHeightWorld: number,
  walls: readonly WeatherWallRectWorld[],
): boolean {
  return computeOpenCeilingColumns(worldWidthWorld, worldHeightWorld, walls).openColumnXs.length > 0;
}
