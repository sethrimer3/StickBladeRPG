/**
 * Block Overlay system: the Grass overlay, and Brighten as a peer kind.
 *
 * The exposed-edge highlight is not a separate system — it is the 'brighten'
 * kind of the same per-wall overlay style, sharing one table, one per-wall
 * index and one serialization path. These tests pin that relationship down,
 * plus the parts of the grass generator that are contracts rather than taste:
 * where it may draw, that it is deterministic, and that it replaces (rather
 * than stacks with) the brighten highlight.
 *
 * The *look* of the grass is deliberately not asserted pixel-for-pixel — that
 * would freeze an aesthetic that should stay tunable. What is asserted is the
 * behaviour a level designer depends on.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { WallSnapshot } from '../render/snapshotTypes';
import { getWallLayoutCache } from '../render/walls/blockWallLayoutCache';
import {
  DEFAULT_SURFACE_RIM_STYLE, GRASS_BLOCK_OVERLAY,
  normalizeSurfaceRimStyle, surfaceRimStylesEqual, hashSurfaceRimStyle,
  encodeSurfaceRimStyle, decodeSurfaceRimStyle,
  internSurfaceRimStyle, SURFACE_RIM_STYLE_INDEX_DEFAULT,
  type SurfaceRimStyle,
} from '../render/walls/surfaceRimStyle';
import {
  generateGrassPixels, collectGrassAnchors, DEFAULT_GRASS_PARAMS,
} from '../render/walls/proceduralGrass';
import { SHAPE_ORIENTATION_NONE, encodeStairsOrientationIndex } from '../levels/stairsGeometry';
import { HALF_BLOCK_NONE } from '../levels/halfBlockGeometry';

const B = 8;

function snapshot(specs: { x: number; y: number; w: number; h: number; style?: SurfaceRimStyle; shape?: number }[]): WallSnapshot {
  const table = specs.flatMap(s => (s.style ? [s.style] : []));
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
    halfBlockOrientation: new Uint8Array(count).fill(HALF_BLOCK_NONE),
    surfaceRimStyleIndex: Uint16Array.from(specs.map(s => (s.style ? table.indexOf(s.style) : 0xFFFF))),
    surfaceRimStyleTable: table,
  };
}

// ── The overlay model ────────────────────────────────────────────────────────

test('Brighten is the default overlay kind, so pre-overlay styles are unchanged', () => {
  assert.equal(DEFAULT_SURFACE_RIM_STYLE.kind, 'brighten');
  assert.equal(normalizeSurfaceRimStyle(undefined).kind, 'brighten');
  assert.equal(normalizeSurfaceRimStyle({ mode: 'solid' }).kind, 'brighten');
});

test('Grass and Brighten are never equal, hash differently, and round-trip through the compact form', () => {
  assert.equal(surfaceRimStylesEqual(GRASS_BLOCK_OVERLAY, DEFAULT_SURFACE_RIM_STYLE), false);
  assert.notEqual(hashSurfaceRimStyle(GRASS_BLOCK_OVERLAY), hashSurfaceRimStyle(DEFAULT_SURFACE_RIM_STYLE));
  assert.equal(decodeSurfaceRimStyle(encodeSurfaceRimStyle(GRASS_BLOCK_OVERLAY)).kind, 'grass');
});

test('every grass wall canonicalizes to one object, so the room dedup table never grows per grass block', () => {
  const a = normalizeSurfaceRimStyle({ kind: 'grass', color: 'ff0000', widthPx: 9 });
  const b = normalizeSurfaceRimStyle({ kind: 'grass', opacity: 0.1 });
  assert.equal(a, b, 'grass ignores brighten knobs and interns to a single style');
  assert.ok(surfaceRimStylesEqual(a, GRASS_BLOCK_OVERLAY));
});

// ── Generation through the real layout cache ─────────────────────────────────

test('a grass-painted block grows grass; an unpainted one does not', () => {
  const plain = getWallLayoutCache(snapshot([{ x: 2 * B, y: 2 * B, w: 2 * B, h: 2 * B }]), B, 10, 10);
  assert.equal(plain.grassPixels.length, 0, 'no overlay painted — no grass');

  const grassed = getWallLayoutCache(
    snapshot([{ x: 2 * B, y: 2 * B, w: 2 * B, h: 2 * B, style: GRASS_BLOCK_OVERLAY }]), B, 10, 10,
  );
  assert.ok(grassed.grassPixels.length > 0, 'a painted block must grow grass');
});

test('grass only grows from upward-facing surfaces, never the underside or buried faces', () => {
  const layout = getWallLayoutCache(
    snapshot([{ x: 2 * B, y: 2 * B, w: 2 * B, h: 2 * B, style: GRASS_BLOCK_OVERLAY }]), B, 10, 10,
  );
  const topY = 2 * B;
  const bottomY = 4 * B - 1;
  assert.ok(layout.grassPixels.some(p => p.yWorldPx === topY), 'the exposed top must be grassed');
  assert.equal(layout.grassPixels.some(p => p.yWorldPx === bottomY), false,
    'the underside must never be grassed');
});

test('a covered surface grows nothing — grass needs open air above', () => {
  // Two stacked blocks: the lower one is painted, but its top is buried.
  const layout = getWallLayoutCache(snapshot([
    { x: 2 * B, y: 2 * B, w: B, h: B },
    { x: 2 * B, y: 3 * B, w: B, h: B, style: GRASS_BLOCK_OVERLAY },
  ]), B, 10, 10);
  assert.equal(layout.grassPixels.length, 0, 'a buried top must grow no grass');
});

test('painting one block does not grow grass on an unpainted neighbour', () => {
  const layout = getWallLayoutCache(snapshot([
    { x: 2 * B, y: 4 * B, w: B, h: B, style: GRASS_BLOCK_OVERLAY },
    { x: 3 * B, y: 4 * B, w: B, h: B },
  ]), B, 10, 10);
  assert.ok(layout.grassPixels.length > 0);
  assert.ok(layout.grassPixels.every(p => p.xWorldPx < 3 * B),
    'grass must stay within the painted wall footprint');
});

test('grass pixels are bucketed per chunk and each coordinate appears once', () => {
  const layout = getWallLayoutCache(
    snapshot([{ x: 2 * B, y: 4 * B, w: 4 * B, h: B, style: GRASS_BLOCK_OVERLAY }]), B, 12, 12,
  );
  const bucketed = Array.from(layout.grassByChunkKey.values()).flat();
  assert.equal(bucketed.length, layout.grassPixels.length);
  const keys = layout.grassPixels.map(p => `${p.xWorldPx},${p.yWorldPx}`);
  assert.equal(new Set(keys).size, keys.length, 'no coordinate may be emitted twice');
});

// ── Generator contracts ──────────────────────────────────────────────────────

test('generation is deterministic — the same world position always yields the same grass', () => {
  const isSolid = (x: number, y: number) => y >= 10 && y < 20 && x >= 0 && x < 60;
  const run = () => generateGrassPixels(collectGrassAnchors(0, 0, 60, 20, isSolid), isSolid);
  assert.deepEqual(run(), run(), 'grass must never flicker between frames');
});

test('grass never escapes the geometry sideways, and blades only occupy air', () => {
  const isSolid = (x: number, y: number) => x >= 10 && x < 20 && y >= 10 && y < 20;
  const px = generateGrassPixels(collectGrassAnchors(0, 0, 40, 30, isSolid), isSolid);
  assert.ok(px.length > 0);
  for (const p of px) {
    assert.ok(p.x >= 10 && p.x < 20, `grass column ${p.x} escaped the block`);
    if (p.y < 10) continue;                       // blade, above the surface — air by construction
    assert.ok(isSolid(p.x, p.y), 'body pixels must lie inside the block');
  }
});

test('creep depth stays within the configured range', () => {
  const isSolid = (x: number, y: number) => y >= 10 && y < 40;
  const anchors = Array.from({ length: 300 }, (_, x) => ({ x, y: 10 }));
  const px = generateGrassPixels(anchors, isSolid, { ...DEFAULT_GRASS_PARAMS, drapeBonusPx: 0 });

  const deepestByCol = new Map<number, number>();
  for (const p of px) {
    if (p.y < 10) continue;
    deepestByCol.set(p.x, Math.max(deepestByCol.get(p.x) ?? 10, p.y));
  }
  // maxDepthPx fully-filled rows plus the one dithered dissolve row below them.
  const limit = DEFAULT_GRASS_PARAMS.maxDepthPx + 1;
  for (const [, deepest] of deepestByCol) {
    assert.ok(deepest - 10 + 1 <= limit, `creep ${deepest - 10 + 1}px exceeded ${limit}px`);
  }
});

test('bare patches appear, so the grass line is never one unbroken painted stripe', () => {
  const isSolid = (x: number, y: number) => y >= 10 && y < 20;
  const anchors = Array.from({ length: 400 }, (_, x) => ({ x, y: 10 }));
  const px = generateGrassPixels(anchors, isSolid);
  const grassed = new Set(px.map(p => p.x));
  assert.ok(grassed.size < 400, 'some columns must be left bare');
  assert.ok(grassed.size > 400 * 0.5, 'but the surface must still read as mostly grassy');
});

test('disabling bare patches covers every column, for callers wanting solid coverage', () => {
  const isSolid = (x: number, y: number) => y >= 10 && y < 20;
  const anchors = Array.from({ length: 100 }, (_, x) => ({ x, y: 10 }));
  const px = generateGrassPixels(anchors, isSolid, { ...DEFAULT_GRASS_PARAMS, bareThreshold: 0 });
  assert.equal(new Set(px.map(p => p.x)).size, 100);
});

// ── Highlights are opt-in ────────────────────────────────────────────────────
//
// Blocks used to receive the exposed-edge highlight automatically. It is now
// the 'brighten' overlay, painted per block, so an unpainted block must render
// completely bare — no bands, no sub-tile outline, no baked sprite shading.

test('an unpainted block produces no edge treatment at all', () => {
  const layout = getWallLayoutCache(
    snapshot([{ x: 2 * B, y: 2 * B, w: 2 * B, h: 2 * B }]), B, 10, 10,
  );
  assert.equal(layout.subTileRimPixels.length, 0);
  assert.equal(layout.grassPixels.length, 0);
  assert.equal(layout.customSurfaceRimPixels.length, 0);
  assert.equal(layout.tileSurfaceRim.size, 0,
    'an unpainted block must resolve to no overlay style at all');
});

test('an unpainted sub-tile shape gets no outline, but a Brighten-painted one does', () => {
  const stair = { x: 2 * B, y: 2 * B, w: B, h: B, shape: encodeStairsOrientationIndex(0) };
  const bare = getWallLayoutCache(snapshot([stair]), B, 10, 10);
  assert.equal(bare.subTileRimPixels.length, 0, 'unpainted shapes render bare');

  const painted = getWallLayoutCache(
    snapshot([{ ...stair, style: DEFAULT_SURFACE_RIM_STYLE }]), B, 10, 10,
  );
  assert.ok(painted.subTileRimPixels.length > 0, 'a painted shape gets its outline back');
});

test('an explicitly painted Brighten is interned rather than collapsing to "unpainted"', () => {
  const table: SurfaceRimStyle[] = [];
  const index = internSurfaceRimStyle(table, DEFAULT_SURFACE_RIM_STYLE);
  assert.notEqual(index, SURFACE_RIM_STYLE_INDEX_DEFAULT,
    'painting Brighten must store a real entry, else it renders as unpainted');
  assert.equal(table.length, 1);

  assert.equal(internSurfaceRimStyle(table, undefined), SURFACE_RIM_STYLE_INDEX_DEFAULT,
    'absence is what means "no overlay"');
});
