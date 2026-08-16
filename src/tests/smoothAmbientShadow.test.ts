/**
 * Unit tests for smoothAmbientShadow.ts — Smooth per-pixel gradient block shadow solver.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getTileDarkness,
  computeVertexDarkness,
  getTileCornerDarkness,
  interpolateTileDarkness,
  renderTileSmoothDarkness,
} from '../render/walls/smoothAmbientShadow';

test('getTileDarkness resolves correct darkness across all cell classifications', () => {
  const roomW = 10;
  const roomH = 10;
  const occupied = new Set(['2,2', '3,2', '2,3', '3,3']);
  const blockers = new Set(['5,5']);
  const ambientDepths = new Map([
    ['2,2', 0.15],
    ['3,2', 0.30],
    ['2,3', 0.70],
    ['3,3', 1.00],
  ]);

  // Inside bounds: solid with known depth
  assert.equal(getTileDarkness(2, 2, occupied, blockers, ambientDepths, roomW, roomH), 0.15);
  assert.equal(getTileDarkness(3, 2, occupied, blockers, ambientDepths, roomW, roomH), 0.30);
  assert.equal(getTileDarkness(2, 3, occupied, blockers, ambientDepths, roomW, roomH), 0.70);
  assert.equal(getTileDarkness(3, 3, occupied, blockers, ambientDepths, roomW, roomH), 1.00);

  // Inside bounds: solid missing from depths map defaults to 1.0
  const occupiedMissing = new Set(['1,1']);
  assert.equal(getTileDarkness(1, 1, occupiedMissing, blockers, null, roomW, roomH), 1.0);

  // Inside bounds: open air
  assert.equal(getTileDarkness(0, 0, occupied, blockers, ambientDepths, roomW, roomH), 0.0);
  assert.equal(getTileDarkness(1, 2, occupied, blockers, ambientDepths, roomW, roomH), 0.0);

  // Inside bounds: authored ambient blocker
  assert.equal(getTileDarkness(5, 5, occupied, blockers, ambientDepths, roomW, roomH), 1.0);

  // Out of bounds: all borders are solid rock (1.0)
  assert.equal(getTileDarkness(-1, 0, occupied, blockers, ambientDepths, roomW, roomH), 1.0);
  assert.equal(getTileDarkness(0, -1, occupied, blockers, ambientDepths, roomW, roomH), 1.0);
  assert.equal(getTileDarkness(10, 5, occupied, blockers, ambientDepths, roomW, roomH), 1.0);
  assert.equal(getTileDarkness(5, 10, occupied, blockers, ambientDepths, roomW, roomH), 1.0);
});

function assertClose(actual: number, expected: number, eps = 1e-9): void {
  assert.ok(
    Math.abs(actual - expected) < eps,
    `Expected ${actual} to be close to ${expected} (diff: ${Math.abs(actual - expected)})`,
  );
}

test('computeVertexDarkness averages the four surrounding tile quadrants', () => {
  const roomW = 10;
  const roomH = 10;

  // Scenario 1: Exposed convex (outer) corner at vertex (2, 2)
  // Only tile (2, 2) is solid (darkness 0.20), tiles (1,1), (2,1), (1,2) are air (0.0).
  const occupied1 = new Set(['2,2']);
  const depths1 = new Map([['2,2', 0.20]]);
  const blockersEmpty = new Set<string>();

  const vOuter = computeVertexDarkness(2, 2, occupied1, blockersEmpty, depths1, roomW, roomH);
  // (0 + 0 + 0 + 0.20) / 4 = 0.05
  assertClose(vOuter, 0.05);

  // Scenario 2: Flat horizontal surface edge at vertex (2, 2)
  // Air above at (1,1) and (2,1), solid below at (1,2) [0.20] and (2,2) [0.20].
  const occupied2 = new Set(['1,2', '2,2']);
  const depths2 = new Map([['1,2', 0.20], ['2,2', 0.20]]);
  const vEdgeH = computeVertexDarkness(2, 2, occupied2, blockersEmpty, depths2, roomW, roomH);
  // (0 + 0 + 0.20 + 0.20) / 4 = 0.10
  assertClose(vEdgeH, 0.10);

  // Scenario 3: Flat vertical surface edge at vertex (2, 2)
  // Solid on left at (1,1) [0.20] and (1,2) [0.20], air on right at (2,1) and (2,2).
  const occupied3 = new Set(['1,1', '1,2']);
  const depths3 = new Map([['1,1', 0.20], ['1,2', 0.20]]);
  const vEdgeV = computeVertexDarkness(2, 2, occupied3, blockersEmpty, depths3, roomW, roomH);
  // (0.20 + 0 + 0.20 + 0) / 4 = 0.10
  assertClose(vEdgeV, 0.10);

  // Scenario 4: Concave (inner) corner at vertex (2, 2)
  // 3 solid tiles (1,1), (1,2), (2,2) [each 0.20], only (2,1) is air (0.0).
  const occupied4 = new Set(['1,1', '1,2', '2,2']);
  const depths4 = new Map([['1,1', 0.20], ['1,2', 0.20], ['2,2', 0.20]]);
  const vInner = computeVertexDarkness(2, 2, occupied4, blockersEmpty, depths4, roomW, roomH);
  // (0.20 + 0 + 0.20 + 0.20) / 4 = 0.15
  assertClose(vInner, 0.15);

  // Scenario 5: Deep buried terrain (all 4 tiles solid with depth darkness 0.80)
  const occupied5 = new Set(['1,1', '2,1', '1,2', '2,2']);
  const depths5 = new Map([['1,1', 0.80], ['2,1', 0.80], ['1,2', 0.80], ['2,2', 0.80]]);
  const vBuried = computeVertexDarkness(2, 2, occupied5, blockersEmpty, depths5, roomW, roomH);
  assertClose(vBuried, 0.80);
});

test('getTileCornerDarkness correctly queries the four corners of a tile', () => {
  const roomW = 10;
  const roomH = 10;
  // A 2x2 solid block at (2,2)-(3,3) in open air
  const occupied = new Set(['2,2', '3,2', '2,3', '3,3']);
  const depths = new Map([
    ['2,2', 0.2],
    ['3,2', 0.2],
    ['2,3', 0.2],
    ['3,3', 0.2],
  ]);
  const blockers = new Set<string>();

  const cornersTL = getTileCornerDarkness(2, 2, occupied, blockers, depths, roomW, roomH);
  // d00 is top-left outer corner at (2, 2): only tile (2,2) is solid -> 0.2 / 4 = 0.05
  assertClose(cornersTL.d00, 0.05);
  // d10 is top-right edge at (3, 2): tiles (2,2) and (3,2) are solid -> 0.4 / 4 = 0.10
  assertClose(cornersTL.d10, 0.10);
  // d01 is bottom-left edge at (2, 3): tiles (2,2) and (2,3) are solid -> 0.4 / 4 = 0.10
  assertClose(cornersTL.d01, 0.10);
  // d11 is center vertex at (3, 3): all four tiles (2,2),(3,2),(2,3),(3,3) are solid -> 0.8 / 4 = 0.20
  assertClose(cornersTL.d11, 0.20);
});

test('interpolateTileDarkness computes exact bilinear values across the unit square', () => {
  const d00 = 0.0;
  const d10 = 0.4;
  const d01 = 0.6;
  const d11 = 1.0;

  // Exact corners
  assertClose(interpolateTileDarkness(0, 0, d00, d10, d01, d11), 0.0);
  assertClose(interpolateTileDarkness(1, 0, d00, d10, d01, d11), 0.4);
  assertClose(interpolateTileDarkness(0, 1, d00, d10, d01, d11), 0.6);
  assertClose(interpolateTileDarkness(1, 1, d00, d10, d01, d11), 1.0);

  // Exact midpoints of the 4 edges
  assertClose(interpolateTileDarkness(0.5, 0, d00, d10, d01, d11), 0.2);
  assertClose(interpolateTileDarkness(0.5, 1, d00, d10, d01, d11), 0.8);
  assertClose(interpolateTileDarkness(0, 0.5, d00, d10, d01, d11), 0.3);
  assertClose(interpolateTileDarkness(1, 0.5, d00, d10, d01, d11), 0.7);

  // Exact center
  assertClose(interpolateTileDarkness(0.5, 0.5, d00, d10, d01, d11), 0.5);
});

test('continuity guarantee: adjacent tiles evaluate to identical values along shared edges', () => {
  const roomW = 20;
  const roomH = 20;
  const occupied = new Set(['3,3', '4,3', '3,4', '4,4', '5,3', '5,4']);
  const depths = new Map([
    ['3,3', 0.15], ['4,3', 0.30], ['5,3', 0.45],
    ['3,4', 0.50], ['4,4', 0.70], ['5,4', 0.90],
  ]);
  const blockers = new Set<string>();

  // Horizontal adjacency: Tile (3,3) right edge (u=1) vs Tile (4,3) left edge (u=0)
  const c33 = getTileCornerDarkness(3, 3, occupied, blockers, depths, roomW, roomH);
  const c43 = getTileCornerDarkness(4, 3, occupied, blockers, depths, roomW, roomH);

  for (let step = 0; step <= 10; step++) {
    const v = step / 10;
    const valLeft = interpolateTileDarkness(1.0, v, c33.d00, c33.d10, c33.d01, c33.d11);
    const valRight = interpolateTileDarkness(0.0, v, c43.d00, c43.d10, c43.d01, c43.d11);
    assert.ok(
      Math.abs(valLeft - valRight) < 1e-9,
      `Horizontal seam at v=${v}: left=${valLeft} vs right=${valRight}`,
    );
  }

  // Vertical adjacency: Tile (3,3) bottom edge (v=1) vs Tile (3,4) top edge (v=0)
  const c34 = getTileCornerDarkness(3, 4, occupied, blockers, depths, roomW, roomH);

  for (let step = 0; step <= 10; step++) {
    const u = step / 10;
    const valTop = interpolateTileDarkness(u, 1.0, c33.d00, c33.d10, c33.d01, c33.d11);
    const valBottom = interpolateTileDarkness(u, 0.0, c34.d00, c34.d10, c34.d01, c34.d11);
    assert.ok(
      Math.abs(valTop - valBottom) < 1e-9,
      `Vertical seam at u=${u}: top=${valTop} vs bottom=${valBottom}`,
    );
  }
});

test('renderTileSmoothDarkness handles zero, uniform, and gradient cases gracefully', () => {
  let fillRectCalls = 0;
  let lastFillStyle = '';
  const mockCtx = {
    set fillStyle(val: string) {
      lastFillStyle = val;
    },
    fillRect(_x: number, _y: number, _w: number, _h: number) {
      fillRectCalls++;
    },
  } as unknown as CanvasRenderingContext2D;

  // Case 1: Fully lit (all corners 0) -> no draw call
  renderTileSmoothDarkness(mockCtx, 0, 0, 16, 0, 0, 0, 0);
  assert.equal(fillRectCalls, 0);

  // Case 2: Degenerate size <= 0 -> no draw call
  renderTileSmoothDarkness(mockCtx, 0, 0, 0, 0.5, 0.5, 0.5, 0.5);
  assert.equal(fillRectCalls, 0);

  // Case 3: Uniform darkness fast path -> single fillRect
  renderTileSmoothDarkness(mockCtx, 10, 20, 16, 0.3, 0.3, 0.3, 0.3);
  assert.equal(fillRectCalls, 1);
  assert.equal(lastFillStyle, 'rgba(0,0,0,0.3)');

  // Case 4: Non-uniform corners (in headless/node test environment where document is undefined)
  // Falls back to average fillRect gracefully without crashing
  renderTileSmoothDarkness(mockCtx, 10, 20, 16, 0.1, 0.3, 0.5, 0.7);
  assert.equal(fillRectCalls, 2);
  assert.equal(lastFillStyle, 'rgba(0,0,0,0.4)');
});
