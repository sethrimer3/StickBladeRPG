/**
 * Guards for the editor live-preview dirty-region tracker.
 *
 * The whole point of this module is that placing one block rebuilds only the
 * chunks around it. These tests pin the two properties that guarantee that:
 * a marked rectangle stays bounded (never silently widens to the room), and
 * the neighbour padding is actually applied — an unpadded rect would leave the
 * edited block's neighbours drawing their old auto-tile sprite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PREVIEW_DIRTY_PAD_BLOCKS,
  createEditorPreviewDirtyState,
  markEditorPreviewDirtyRect,
  markEditorPreviewDirtyAll,
  hasEditorPreviewDirty,
  clearEditorPreviewDirty,
} from '../editor/editorPreviewInvalidation';

test('a fresh state is clean', () => {
  const s = createEditorPreviewDirtyState();
  assert.equal(hasEditorPreviewDirty(s), false);
  assert.equal(s.isAllDirty, false);
});

test('marking one cell pads it by the neighbourhood radius', () => {
  const s = createEditorPreviewDirtyState();
  markEditorPreviewDirtyRect(s, 10, 20, 10, 20);

  const pad = PREVIEW_DIRTY_PAD_BLOCKS;
  assert.equal(hasEditorPreviewDirty(s), true);
  assert.equal(s.isAllDirty, false);
  assert.deepEqual(
    { colMin: s.colMin, rowMin: s.rowMin, colMax: s.colMax, rowMax: s.rowMax },
    { colMin: 10 - pad, rowMin: 20 - pad, colMax: 10 + pad, rowMax: 20 + pad },
  );
});

test('successive marks union into one bounding region', () => {
  const s = createEditorPreviewDirtyState();
  markEditorPreviewDirtyRect(s, 10, 10, 10, 10);
  markEditorPreviewDirtyRect(s, 4, 30, 4, 30);

  const pad = PREVIEW_DIRTY_PAD_BLOCKS;
  assert.equal(s.colMin, 4 - pad);
  assert.equal(s.rowMin, 10 - pad);
  assert.equal(s.colMax, 10 + pad);
  assert.equal(s.rowMax, 30 + pad);
});

test('a paint stroke far from the rest of the room stays a small region', () => {
  // 60 blocks painted along one row — the realistic drag-paint case. The
  // region must track the stroke, not degrade to the whole room.
  const s = createEditorPreviewDirtyState();
  for (let x = 100; x < 160; x++) markEditorPreviewDirtyRect(s, x, 50, x, 50);

  const pad = PREVIEW_DIRTY_PAD_BLOCKS;
  assert.equal(s.isAllDirty, false);
  assert.equal(s.colMin, 100 - pad);
  assert.equal(s.colMax, 159 + pad);
  assert.equal(s.rowMin, 50 - pad);
  assert.equal(s.rowMax, 50 + pad);
});

test('reversed and fractional bounds normalise to an inclusive block rect', () => {
  const s = createEditorPreviewDirtyState();
  markEditorPreviewDirtyRect(s, 12.7, 9, 5, 3.2);

  const pad = PREVIEW_DIRTY_PAD_BLOCKS;
  assert.equal(s.colMin, 5 - pad);
  assert.equal(s.rowMin, 3 - pad);
  assert.equal(s.colMax, 13 + pad);
  assert.equal(s.rowMax, 9 + pad);
});

test('all-dirty wins over any region and is not narrowed by later marks', () => {
  const s = createEditorPreviewDirtyState();
  markEditorPreviewDirtyRect(s, 10, 10, 10, 10);
  markEditorPreviewDirtyAll(s);
  markEditorPreviewDirtyRect(s, 200, 200, 200, 200);

  assert.equal(s.isAllDirty, true);
  assert.equal(s.hasRegion, false);
  assert.equal(hasEditorPreviewDirty(s), true);
});

test('non-finite bounds escalate to a whole-room rebuild rather than being dropped', () => {
  const s = createEditorPreviewDirtyState();
  markEditorPreviewDirtyRect(s, Number.NaN, 0, 4, 4);
  assert.equal(s.isAllDirty, true);
});

test('clearing returns the state to clean', () => {
  const s = createEditorPreviewDirtyState();
  markEditorPreviewDirtyAll(s);
  clearEditorPreviewDirty(s);

  assert.equal(hasEditorPreviewDirty(s), false);
  assert.equal(s.isAllDirty, false);
  assert.equal(s.hasRegion, false);
});
