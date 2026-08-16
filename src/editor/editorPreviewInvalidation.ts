/**
 * editorPreviewInvalidation.ts — dirty-region bookkeeping for the editor's
 * live game-accurate room preview.
 *
 * ## Why this exists
 *
 * The preview (see editorPreviewRenderer.ts) draws the room through the real
 * gameplay renderers, which cache rendered tiles in 32×32-block chunk
 * canvases. Rebuilding every chunk after every placed block would make a
 * drag-paint stroke quadratically expensive on a large room, so an edit must
 * invalidate only the chunks it can actually change.
 *
 * This module accumulates the block rectangles touched between two preview
 * frames. The renderer flushes the accumulated region once per frame and
 * hands it to `invalidateChunkRect` / `invalidateBackgroundBlockChunkRect`.
 *
 * ## Neighbourhood padding
 *
 * A block's rendered appearance depends on its neighbours: the auto-tiling
 * sprite selection reads the 4-neighbour occupancy mask, and the surface-edge
 * / seam overlay passes read one tile further out. Editing a single block can
 * therefore change how the surrounding blocks draw, so every marked rectangle
 * is expanded by {@link PREVIEW_DIRTY_PAD_BLOCKS} before being recorded.
 *
 * Pure and Node-safe: no DOM, no canvas, no renderer imports.
 */

/**
 * Blocks of padding added around every marked rectangle, covering the
 * neighbour-dependent parts of a tile's appearance (auto-tile neighbour mask,
 * surface-edge overlay, seam blending).
 */
export const PREVIEW_DIRTY_PAD_BLOCKS = 2;

/**
 * Accumulated dirty region, as a single bounding rectangle in block units.
 *
 * A bounding rectangle (rather than a list of rectangles) is deliberate: chunk
 * invalidation is coarse anyway — 32 blocks per chunk axis — so scattered
 * edits within the same neighbourhood collapse to the same chunk set, and the
 * bookkeeping stays allocation-free.
 */
export interface EditorPreviewDirtyState {
  /** When true the whole room must be rebuilt, and the rect fields are ignored. */
  isAllDirty: boolean;
  /** When true, `colMin`..`rowMax` describe a real region. */
  hasRegion: boolean;
  colMin: number;
  rowMin: number;
  colMax: number;
  rowMax: number;
}

export function createEditorPreviewDirtyState(): EditorPreviewDirtyState {
  return { isAllDirty: false, hasRegion: false, colMin: 0, rowMin: 0, colMax: 0, rowMax: 0 };
}

/**
 * Marks a block rectangle dirty, padded by {@link PREVIEW_DIRTY_PAD_BLOCKS}
 * and unioned into any region already accumulated.
 *
 * Coordinates are inclusive block indices and may be given in any order;
 * out-of-room values are harmless (chunk invalidation clamps to the grid).
 */
export function markEditorPreviewDirtyRect(
  state: EditorPreviewDirtyState,
  colMinBlock: number,
  rowMinBlock: number,
  colMaxBlock: number,
  rowMaxBlock: number,
): void {
  if (state.isAllDirty) return;
  if (!Number.isFinite(colMinBlock) || !Number.isFinite(rowMinBlock) ||
      !Number.isFinite(colMaxBlock) || !Number.isFinite(rowMaxBlock)) {
    // A non-finite bound cannot be turned into a chunk range. Fall back to the
    // always-correct (merely slower) whole-room rebuild rather than silently
    // dropping the edit from the preview.
    state.isAllDirty = true;
    return;
  }

  const pad = PREVIEW_DIRTY_PAD_BLOCKS;
  const lowCol = Math.floor(Math.min(colMinBlock, colMaxBlock)) - pad;
  const lowRow = Math.floor(Math.min(rowMinBlock, rowMaxBlock)) - pad;
  const highCol = Math.ceil(Math.max(colMinBlock, colMaxBlock)) + pad;
  const highRow = Math.ceil(Math.max(rowMinBlock, rowMaxBlock)) + pad;

  if (!state.hasRegion) {
    state.hasRegion = true;
    state.colMin = lowCol;
    state.rowMin = lowRow;
    state.colMax = highCol;
    state.rowMax = highRow;
    return;
  }

  if (lowCol  < state.colMin) state.colMin = lowCol;
  if (lowRow  < state.rowMin) state.rowMin = lowRow;
  if (highCol > state.colMax) state.colMax = highCol;
  if (highRow > state.rowMax) state.rowMax = highRow;
}

/**
 * Marks the entire room dirty. Used for changes with no bounded footprint —
 * room resize, theme or lighting changes, undo/redo, room load — and as the
 * safe fallback whenever an edit's footprint is unknown.
 */
export function markEditorPreviewDirtyAll(state: EditorPreviewDirtyState): void {
  state.isAllDirty = true;
  state.hasRegion = false;
}

/** True when a flush would have anything to do. */
export function hasEditorPreviewDirty(state: EditorPreviewDirtyState): boolean {
  return state.isAllDirty || state.hasRegion;
}

/** Clears all accumulated dirt. Called by the renderer after flushing. */
export function clearEditorPreviewDirty(state: EditorPreviewDirtyState): void {
  state.isAllDirty = false;
  state.hasRegion = false;
  state.colMin = 0;
  state.rowMin = 0;
  state.colMax = 0;
  state.rowMax = 0;
}

// ── Shared editor-session instance ────────────────────────────────────────────

/**
 * The region edited since the last preview frame.
 *
 * A module singleton rather than a field on `EditorState` so that the
 * mutation helpers that actually know an edit's footprint — `placeAt`,
 * `deleteAt` — can report it without the renderer's state being threaded down
 * to them, and without those Node-testable modules taking a dependency on the
 * canvas-bound renderer. `editorPreviewRenderer.ts` flushes it once per frame.
 */
const _sharedDirty = createEditorPreviewDirtyState();

/** The shared dirty region, for the renderer's per-frame flush. */
export function getEditorPreviewDirtyState(): EditorPreviewDirtyState {
  return _sharedDirty;
}

/**
 * Reports the block footprint of an edit so the next preview frame rebuilds
 * only the chunks around it. Bounds are inclusive block indices.
 */
export function markEditorPreviewDirtyBlocks(
  colMinBlock: number,
  rowMinBlock: number,
  colMaxBlock: number,
  rowMaxBlock: number,
): void {
  markEditorPreviewDirtyRect(_sharedDirty, colMinBlock, rowMinBlock, colMaxBlock, rowMaxBlock);
}

/**
 * Marks the whole preview stale. Use for changes with no bounded footprint
 * (room load, resize, undo/redo, theme or lighting changes) and whenever an
 * edit's footprint is not known — correct in every case, merely slower.
 */
export function markEditorPreviewFullyDirty(): void {
  markEditorPreviewDirtyAll(_sharedDirty);
}
