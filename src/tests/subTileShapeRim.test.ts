/**
 * Sub-tile shape outlines: stairs, ramps and half-blocks must take part in the
 * exposed-edge rim, tracing their real silhouette rather than the tile square
 * they sit in.
 *
 * Before this, `buildWallLayout` dropped shaped walls from the solidity grid
 * entirely (so a stair got no rim at all) and marked a half-block's whole tile
 * solid (so it got a full-square rim around a half-filled cell). Both are now
 * driven by `subTileRimPixels` — a precomputed, pixel-accurate inward falloff —
 * while the tile-granular `surfaceExposureMap` keeps handling full blocks.
 *
 * Covers:
 *  - a stair's outline follows the staircase profile, not its bounding square;
 *  - each of the four half-block orientations outlines only its solid half;
 *  - the outline is exactly the same depth as a full block's edge band;
 *  - no rim is drawn along a seam where a shape sits flush against a block,
 *    and the neighbouring block likewise draws no rim into the shape;
 *  - every rim pixel is emitted once, so nothing is painted at double strength;
 *  - rooms with no sub-tile shapes produce no extra work at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { WallSnapshot } from '../render/snapshotTypes';
import { getWallLayoutCache } from '../render/walls/blockWallLayoutCache';
import { getSurfaceMaskAtTile } from '../sim/world/surfaceExposure';
import { encodeStairsOrientationIndex, SHAPE_ORIENTATION_NONE } from '../levels/stairsGeometry';
import { DEFAULT_SURFACE_RIM_STYLE } from '../render/walls/surfaceRimStyle';
import {
  HALF_BLOCK_NONE, HALF_BLOCK_LEFT, HALF_BLOCK_RIGHT, HALF_BLOCK_TOP, HALF_BLOCK_BOTTOM,
  halfBlockWorldRect,
} from '../levels/halfBlockGeometry';

const B = 8;

interface Spec {
  x: number; y: number; w: number; h: number;
  shape?: number;
  half?: number;
}

function snapshot(specs: Spec[]): WallSnapshot {
  const count = specs.length;
  return {
    count,
    xWorld: Float32Array.from(specs.map(s => s.x)),
    yWorld: Float32Array.from(specs.map(s => s.y)),
    wWorld: Float32Array.from(specs.map(s => s.w)),
    hWorld: Float32Array.from(specs.map(s => s.h)),
    isPlatformFlag: new Uint8Array(count),
    platformEdge: new Uint8Array(count),
    themeIndex: new Uint8Array(count).fill(255),
    isInvisibleFlag: new Uint8Array(count),
    rampOrientationIndex: Uint8Array.from(specs.map(s => s.shape ?? SHAPE_ORIENTATION_NONE)),
    halfBlockOrientation: Uint8Array.from(specs.map(s => s.half ?? HALF_BLOCK_NONE)),
    // Shapes only get an outline where the Brighten overlay is painted —
    // blocks no longer highlight automatically — so every fixture paints it.
    surfaceRimStyleIndex: new Uint16Array(count).fill(0),
    surfaceRimStyleTable: [DEFAULT_SURFACE_RIM_STYLE],
  };
}

/** Set of `"x,y"` world-pixel keys carrying a sub-tile rim pixel. */
function rimKeys(layout: ReturnType<typeof getWallLayoutCache>): Set<string> {
  return new Set(layout.subTileRimPixels.map(p => `${p.xWorldPx},${p.yWorldPx}`));
}

// A 1x1 stair at tile (2,2), rising right: solid where col + row >= stepCount-1,
// i.e. the lower-right triangle. Its top-left pixel is empty, its bottom-left
// and bottom-right pixels are solid.
const STAIR_AT_2_2: Spec = {
  x: 2 * B, y: 2 * B, w: B, h: B, shape: encodeStairsOrientationIndex(0),
};

test('a stair produces rim pixels, and they trace the staircase profile rather than the tile square', () => {
  const layout = getWallLayoutCache(snapshot([STAIR_AT_2_2]), B, 10, 10);
  const keys = rimKeys(layout);

  assert.ok(keys.size > 0, 'a stair must receive an outline at all');

  // The tile's empty upper-left corner is not part of the shape, so it must
  // carry no rim — this is precisely what a tile-square outline got wrong.
  assert.equal(keys.has(`${2 * B},${2 * B}`), false, 'empty upper-left stair pixel must have no rim');

  // The always-solid bottom-left pixel is on the silhouette and must have one.
  assert.equal(keys.has(`${2 * B},${3 * B - 1}`), true, 'solid bottom-left stair pixel must be rimmed');

  // Nothing may escape the stair's own bounding box.
  assert.ok(layout.subTileRimPixels.every(p =>
    p.xWorldPx >= 2 * B && p.xWorldPx < 3 * B && p.yWorldPx >= 2 * B && p.yWorldPx < 3 * B,
  ), 'rim pixels must stay inside the stair');
});

test('a stair tile is not reported as a solid square by the tile-granular exposure map', () => {
  const layout = getWallLayoutCache(snapshot([STAIR_AT_2_2]), B, 10, 10);
  // The stair must not masquerade as a full block: that would draw a square
  // band around a diagonal shape.
  assert.deepEqual(
    getSurfaceMaskAtTile(layout.surfaceExposureMap, 2, 2),
    { top: false, right: false, bottom: false, left: false },
  );
});

for (const [name, orientation] of [
  ['left', HALF_BLOCK_LEFT], ['right', HALF_BLOCK_RIGHT],
  ['top', HALF_BLOCK_TOP], ['bottom', HALF_BLOCK_BOTTOM],
] as const) {
  test(`a ${name}-half block outlines only its solid half`, () => {
    const r = halfBlockWorldRect(2, 2, 1, 1, orientation, B);
    const layout = getWallLayoutCache(
      snapshot([{ x: r.x, y: r.y, w: r.w, h: r.h, half: orientation }]), B, 10, 10,
    );
    const pixels = layout.subTileRimPixels;

    assert.ok(pixels.length > 0, 'a half-block must receive an outline');
    assert.ok(
      pixels.every(p => p.xWorldPx >= r.x && p.xWorldPx < r.x + r.w
                     && p.yWorldPx >= r.y && p.yWorldPx < r.y + r.h),
      'no rim pixel may fall in the empty half of the block',
    );
    // A 4x8 (or 8x4) half is entirely within 3px of an edge, so every one of
    // its pixels is rimmed — the whole silhouette reads as edge.
    assert.equal(pixels.length, r.w * r.h);
  });
}

test('the outline is the same 3-pixel depth as a full block edge band, and each pixel gets exactly one depth', () => {
  const layout = getWallLayoutCache(snapshot([
    // A tall half-block: deep enough that depth can actually reach 2.
    { x: 2 * B, y: 2 * B, w: B, h: 4 * B, half: HALF_BLOCK_LEFT },
  ]), B, 10, 10);

  const depths = layout.subTileRimPixels.map(p => p.depth);
  assert.ok(depths.every(d => d >= 0 && d <= 2), 'depth must stay within the 3-band falloff');

  const keys = layout.subTileRimPixels.map(p => `${p.xWorldPx},${p.yWorldPx}`);
  assert.equal(new Set(keys).size, keys.length,
    'each pixel must appear once — a duplicate would paint at double strength');
});

test('no rim is drawn along a seam where a shape sits flush against a full block', () => {
  // A left-half block at tile (2,2) with a full block immediately left at (1,2).
  // The half-block hugs the shared boundary, so that column must not be rimmed.
  const half = halfBlockWorldRect(2, 2, 1, 1, HALF_BLOCK_LEFT, B);
  const layout = getWallLayoutCache(snapshot([
    { x: 1 * B, y: 2 * B, w: B, h: B },
    { x: half.x, y: half.y, w: half.w, h: half.h, half: HALF_BLOCK_LEFT },
  ]), B, 10, 10);

  const keys = rimKeys(layout);
  const seamX = 2 * B; // first pixel column of the half-block, touching the block
  const midY = 2 * B + 4;
  assert.equal(keys.has(`${seamX},${midY}`), false,
    'the flush seam column must carry no rim');

  // Conversely, the full block must not draw a rim into the half-block either:
  // its right side is fully covered by the half-block's solid pixels.
  assert.equal(getSurfaceMaskAtTile(layout.surfaceExposureMap, 1, 2).right, false,
    'the neighbouring block must see the flush half-block as solid');
});

test('a partially covered edge stays exposed — a stair does not fully seal its neighbour', () => {
  // A stair rising right at (2,2) leaves its upper-left empty, so the block
  // above it at (2,1) is only partly covered and must keep its bottom rim.
  const layout = getWallLayoutCache(snapshot([
    { x: 2 * B, y: 1 * B, w: B, h: B },
    STAIR_AT_2_2,
  ]), B, 10, 10);

  assert.equal(getSurfaceMaskAtTile(layout.surfaceExposureMap, 2, 1).bottom, true,
    'a partially covered edge must remain exposed');
});

test('rooms without sub-tile shapes produce no sub-tile rim work at all', () => {
  const layout = getWallLayoutCache(snapshot([
    { x: 2 * B, y: 2 * B, w: 2 * B, h: 2 * B },
  ]), B, 10, 10);
  assert.equal(layout.subTileRimPixels.length, 0);
  assert.equal(layout.subTileRimByChunkKey.size, 0);
  // The plain block still gets its normal tile-based outline.
  assert.deepEqual(getSurfaceMaskAtTile(layout.surfaceExposureMap, 2, 2),
    { top: true, right: false, bottom: false, left: true });
});

test('sub-tile rim pixels are bucketed into the chunk that contains them', () => {
  const layout = getWallLayoutCache(snapshot([STAIR_AT_2_2]), B, 10, 10);
  const bucketed = Array.from(layout.subTileRimByChunkKey.values()).flat();
  assert.equal(bucketed.length, layout.subTileRimPixels.length,
    'every rim pixel must be reachable from exactly one chunk bucket');
});
