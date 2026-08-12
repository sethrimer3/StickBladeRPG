import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findGridPath,
  isBlockSolid,
  isStandable,
  PATH_BLOCK_SIZE,
} from '../sim/ai/gridPathfinding';
import type { SolidMask } from '../sim/pixelMaterials/pixelMaterialSolid';

/**
 * Creates a mock SolidMask from an ASCII level grid where '#' is solid and '.' is air.
 */
function createGridMask(lines: string[]): SolidMask {
  const gridH = lines.length;
  const gridW = Math.max(...lines.map(l => l.length));
  const widthPx = gridW * PATH_BLOCK_SIZE;
  const heightPx = gridH * PATH_BLOCK_SIZE;

  const mask = new Uint8Array(widthPx * heightPx);

  for (let gy = 0; gy < gridH; gy++) {
    const row = lines[gy];
    for (let gx = 0; gx < gridW; gx++) {
      const char = row[gx] ?? ' ';
      if (char === '#') {
        const x0 = gx * PATH_BLOCK_SIZE;
        const y0 = gy * PATH_BLOCK_SIZE;
        for (let py = y0; py < y0 + PATH_BLOCK_SIZE; py++) {
          const rowBase = py * widthPx;
          for (let px = x0; px < x0 + PATH_BLOCK_SIZE; px++) {
            mask[rowBase + px] = 1;
          }
        }
      }
    }
  }

  return {
    widthPx,
    heightPx,
    isSolid: (x: number, y: number): boolean => {
      if (x < 0 || y < 0 || x >= widthPx || y >= heightPx) return true;
      return mask[Math.floor(y) * widthPx + Math.floor(x)] === 1;
    },
  } as unknown as SolidMask;
}

test('isBlockSolid and isStandable correctly classify floor and air', () => {
  const level = [
    '......',
    '......',
    '######',
  ];
  const solid = createGridMask(level);

  assert.equal(isBlockSolid(solid, 2, 2), true);
  assert.equal(isBlockSolid(solid, 2, 1), false);
  assert.equal(isStandable(solid, 2, 1), true);
  assert.equal(isStandable(solid, 2, 0), false);
});

test('finds direct flat walking path from left to right', () => {
  const level = [
    '..........',
    '..........',
    '##########',
  ];
  const solid = createGridMask(level);

  const path = findGridPath(solid, 1, 1, 8, 1);
  assert.ok(path.length > 0);
  assert.equal(path[path.length - 1].blockX, 8);
  assert.equal(path[path.length - 1].blockY, 1);
  assert.equal(path[0].action, 'walk');
});

test('finds path jumping up a 1-block ledge', () => {
  const level = [
    '..........',
    '.....####.',
    '##########',
  ];
  const solid = createGridMask(level);

  // Start on lower floor at (2, 1), target on elevated ledge at (7, 0)
  const path = findGridPath(solid, 2, 1, 7, 0);
  assert.ok(path.length > 0);
  assert.equal(path[path.length - 1].blockX, 7);
  assert.equal(path[path.length - 1].blockY, 0);

  // A jump action should be present
  const hasJump = path.some(p => p.action === 'jump');
  assert.equal(hasJump, true, 'path should include jump action for climbing ledge');
});

test('finds path dropping down a ledge', () => {
  const level = [
    '..........',
    '.####.....',
    '##########',
  ];
  const solid = createGridMask(level);

  // Start on elevated platform at (2, 0), target on lower floor at (7, 1)
  const path = findGridPath(solid, 2, 0, 7, 1);
  assert.ok(path.length > 0);
  assert.equal(path[path.length - 1].blockX, 7);
  assert.equal(path[path.length - 1].blockY, 1);
});

test('finds path jumping across a 2-block horizontal pit', () => {
  const level = [
    '..........',
    '..........',
    '####..####',
    '####..####',
  ];
  const solid = createGridMask(level);

  // Start on left ledge (2, 1), jump across 2-block pit (x=4,5) to right ledge (7, 1)
  const path = findGridPath(solid, 2, 1, 7, 1);
  assert.ok(path.length > 0);
  assert.equal(path[path.length - 1].blockX, 7);
  assert.equal(path[path.length - 1].blockY, 1);

  const hasJump = path.some(p => p.action === 'jump');
  assert.equal(hasJump, true, 'should jump across pit gap');
});

test('handles unreachable target by finding closest reachable point without infinite loop', () => {
  const level = [
    '..##........',
    '..##........',
    '####....####',
  ];
  const solid = createGridMask(level);

  // Target trapped behind high ceiling/wall
  const path = findGridPath(solid, 0, 1, 10, 0, { maxNodesExplored: 100 });
  assert.ok(Array.isArray(path));
});
