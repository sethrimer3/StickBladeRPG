import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createStickmanBotState,
  setStickmanBotTarget,
  stepStickmanBotAi,
} from '../sim/ai/stickmanBotAi';
import {
  createStickRangerBody,
  SR_HIP,
  SR_FRAME_MS,
} from '../sim/clusters/stickRangerBody';
import type { SolidMask } from '../sim/pixelMaterials/pixelMaterialSolid';
import { PATH_BLOCK_SIZE } from '../sim/ai/gridPathfinding';

function createFloor(floorY: number): SolidMask {
  return {
    widthPx: 400,
    heightPx: 300,
    isSolid: (_x: number, y: number): boolean => y >= floorY,
  } as unknown as SolidMask;
}

test('bot navigates horizontally towards target block on a flat floor', () => {
  const floorY = 140;
  const solid = createFloor(floorY);
  const body = createStickRangerBody(100, floorY - 9.6);
  const bot = createStickmanBotState();

  const airBlockY = Math.floor(floorY / PATH_BLOCK_SIZE) - 1;

  // Target 10 blocks to the right: (100 / 8 + 10) = (12 + 10) = block 22
  setStickmanBotTarget(bot, 22, airBlockY);

  const startX = body.x[SR_HIP];

  // Advance 150 frames
  for (let f = 0; f < 150; f++) {
    stepStickmanBotAi(bot, body, solid, SR_FRAME_MS);
  }

  assert.ok(body.x[SR_HIP] > startX + 5, `bot should have traveled right toward target block, moved ${body.x[SR_HIP] - startX}`);
  assert.equal(body.facingDirection, 1);
});

test('bot detects arrival and halts when reaching target block', () => {
  const floorY = 140;
  const solid = createFloor(floorY);
  const body = createStickRangerBody(100, floorY - 9.6);
  const bot = createStickmanBotState();

  const curBlockX = Math.floor(body.x[SR_HIP] / PATH_BLOCK_SIZE);
  const airBlockY = Math.floor(floorY / PATH_BLOCK_SIZE) - 1;

  // Set target block to exactly where the stickman already is
  setStickmanBotTarget(bot, curBlockX, airBlockY);

  const res = stepStickmanBotAi(bot, body, solid, SR_FRAME_MS);
  assert.equal(res.isArrived, true);
  assert.equal(res.moveDx, 0);
});

test('changing target block resets path and redirects movement', () => {
  const floorY = 140;
  const solid = createFloor(floorY);
  const body = createStickRangerBody(100, floorY - 9.6);
  const bot = createStickmanBotState();
  const airBlockY = Math.floor(floorY / PATH_BLOCK_SIZE) - 1;

  // Set target to left (block 4)
  setStickmanBotTarget(bot, 4, airBlockY);
  const resLeft = stepStickmanBotAi(bot, body, solid, SR_FRAME_MS);
  assert.equal(resLeft.moveDx, -1);

  // Switch target to right (block 30)
  setStickmanBotTarget(bot, 30, airBlockY);
  const resRight = stepStickmanBotAi(bot, body, solid, SR_FRAME_MS);
  assert.equal(resRight.moveDx, 1);
});
