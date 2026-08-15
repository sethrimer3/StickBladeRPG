import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SLIME_HALF_SIZE_WORLD,
  SLIME_BASE_PAUSE_SEC,
  SLIME_GRAVITY_WORLD_PER_SEC2,
  SLIME_MAX_FALL_WORLD_PER_SEC,
  computeSlimeHopVelocity,
  getSlimePauseTicks,
  applySlimeAI,
} from '../sim/clusters/slimeAi';
import { createClusterState } from '../sim/clusters/state';
import { createWorldState } from '../sim/world';
import { getEnemyFootprintBlocks } from '../editor/editorRendererHelpers';
import type { EditorEnemy } from '../editor/editorElementTypes';

describe('Green Slime dimensions and pause calculation', () => {
  test('SLIME_HALF_SIZE_WORLD represents 16x16 in-game pixels (half-size 8)', () => {
    assert.equal(SLIME_HALF_SIZE_WORLD, 8);
  });

  test('SLIME_BASE_PAUSE_SEC is 3.0 seconds', () => {
    assert.equal(SLIME_BASE_PAUSE_SEC, 3.0);
  });

  test('editor footprint is 2x2 blocks for 16x16 pixels', () => {
    const enemy = { isSlimeFlag: 1 } as EditorEnemy;
    const footprint = getEnemyFootprintBlocks(enemy);
    assert.deepEqual(footprint, { wBlock: 2, hBlock: 2 });
  });

  test('getSlimePauseTicks calculates 3.0s at 100% HP and 0s at 0% HP', () => {
    const dtSec = 1 / 60; // 60 Hz
    // 100% HP -> 180 ticks (3.0 seconds)
    assert.equal(getSlimePauseTicks(10, 10, dtSec), 180);
    // 50% HP -> 90 ticks (1.5 seconds)
    assert.equal(getSlimePauseTicks(5, 10, dtSec), 90);
    // 25% HP -> 45 ticks (0.75 seconds)
    assert.equal(getSlimePauseTicks(25, 100, dtSec), 45);
    // 0% HP -> 0 ticks (0.0 seconds)
    assert.equal(getSlimePauseTicks(0, 10, dtSec), 0);
  });

  test('getSlimePauseTicks clamps out-of-range HP values safely', () => {
    const dtSec = 1 / 60;
    // Overhealed / capped at 100%
    assert.equal(getSlimePauseTicks(15, 10, dtSec), 180);
    // Negative HP capped at 0%
    assert.equal(getSlimePauseTicks(-5, 10, dtSec), 0);
  });
});

describe('Green Slime parabolic hop velocity calculation', () => {
  test('launches in positive X direction when player is to the right', () => {
    const slimeX = 100;
    const slimeY = 100;
    const playerX = 180;
    const playerY = 100;

    const { vx, vy } = computeSlimeHopVelocity(slimeX, slimeY, playerX, playerY);
    assert.ok(vx > 0, `Expected vx > 0, got ${vx}`);
    assert.ok(vy < 0, `Expected vy < 0 (upward launch), got ${vy}`);

    // Verify parabolic flight reaches near target in calculated flight time
    const g = SLIME_GRAVITY_WORLD_PER_SEC2;
    const tUp = -vy / g;
    const tDown = Math.sqrt(((vy * vy) / (2 * g)) * 2 / g);
    const flightTime = tUp + tDown;
    const distanceTraveled = vx * flightTime;
    assert.ok(Math.abs(distanceTraveled - (playerX - slimeX)) < 1.0);
  });

  test('launches in negative X direction when player is to the left', () => {
    const slimeX = 200;
    const slimeY = 100;
    const playerX = 120;
    const playerY = 100;

    const { vx, vy } = computeSlimeHopVelocity(slimeX, slimeY, playerX, playerY);
    assert.ok(vx < 0, `Expected vx < 0, got ${vx}`);
    assert.ok(vy < 0, `Expected vy < 0, got ${vy}`);
  });

  test('elevates apex when player is on a higher platform', () => {
    const slimeX = 100;
    const slimeY = 150;
    const playerX = 160;
    const playerY = 100; // 50 units higher

    const levelHop = computeSlimeHopVelocity(slimeX, slimeY, playerX, slimeY);
    const elevatedHop = computeSlimeHopVelocity(slimeX, slimeY, playerX, playerY);

    // Upward velocity should be stronger to reach the higher platform
    assert.ok(Math.abs(elevatedHop.vy) > Math.abs(levelHop.vy), 'Elevated jump should have stronger upward launch');
  });

  test('handles zero horizontal distance cleanly without NaN', () => {
    const slimeX = 100;
    const slimeY = 100;
    const { vx, vy } = computeSlimeHopVelocity(slimeX, slimeY, slimeX, slimeY);
    assert.equal(vx, 0);
    assert.ok(Number.isFinite(vy) && vy < 0);
  });
});

describe('Green Slime AI simulation behavior and state machine', () => {
  function setupTestWorld(): { world: ReturnType<typeof createWorldState>; player: ReturnType<typeof createClusterState>; slime: ReturnType<typeof createClusterState> } {
    const world = createWorldState(1000 / 60); // 60 FPS
    world.worldWidthWorld = 400;
    world.worldHeightWorld = 300;

    const player = createClusterState(1, 150, 100, 0, 10);
    player.isPlayerFlag = 1;
    player.isAliveFlag = 1;

    const slime = createClusterState(2, 100, 100, 0, 10);
    slime.isSlimeFlag = 1;
    slime.isAliveFlag = 1;
    slime.maxHealthPoints = 10;
    slime.healthPoints = 10;
    slime.isGroundedFlag = 1;
    slime.slimeHopTimerTicks = 180;

    world.clusters = [player, slime];
    return { world, player, slime };
  }

  test('grounded slime remains stationary and counts down pause timer', () => {
    const { world, slime } = setupTestWorld();
    slime.slimeHopTimerTicks = 100;
    slime.velocityXWorld = 50; // any lingering horizontal speed should be cleared while grounded

    applySlimeAI(world);

    assert.equal(slime.velocityXWorld, 0, 'Horizontal velocity must be zero while resting on ground');
    assert.equal(slime.slimeHopTimerTicks, 99, 'Timer should decrement by 1 tick');
  });

  test('grounded slime launches jump when timer reaches zero and updates facing', () => {
    const { world, slime } = setupTestWorld();
    slime.slimeHopTimerTicks = 1;
    slime.isGroundedFlag = 1;

    applySlimeAI(world);

    assert.ok(slime.velocityXWorld > 0, 'Should launch towards player (player is to the right)');
    assert.ok(slime.velocityYWorld < 0, 'Should launch upward');
    assert.equal(slime.isGroundedFlag, 0, 'Should become airborne');
    assert.equal(slime.isFacingLeftFlag, 0, 'Should face right towards the jump direction');
    assert.equal(slime.slimeHopTimerTicks, 180, 'Timer should reset to full pause for next touchdown');
  });

  test('airborne slime accelerates downward under gravity and caps at max fall speed', () => {
    const { world, slime } = setupTestWorld();
    slime.isGroundedFlag = 0;
    slime.velocityYWorld = 0;

    const dtSec = world.dtMs * 0.001;
    applySlimeAI(world);

    assert.ok(slime.velocityYWorld > 0, 'Gravity should pull airborne slime downward');
    assert.equal(slime.velocityYWorld, SLIME_GRAVITY_WORLD_PER_SEC2 * dtSec);

    // Test terminal fall speed cap
    slime.velocityYWorld = 500;
    applySlimeAI(world);
    assert.equal(slime.velocityYWorld, SLIME_MAX_FALL_WORLD_PER_SEC);
  });

  test('taking damage while grounded immediately reduces remaining pause timer', () => {
    const { world, slime } = setupTestWorld();
    slime.slimeHopTimerTicks = 160;
    slime.healthPoints = 2; // reduced to 20% HP (20% of 180 = 36 ticks)

    applySlimeAI(world);

    // Timer was 160, but max pause for 20% HP is 36 ticks, so it should clamp to 36 and decrement to 35
    assert.equal(slime.slimeHopTimerTicks, 35);
  });

  test('at 0% HP, slime hops immediately upon touching ground', () => {
    const { world, slime } = setupTestWorld();
    slime.healthPoints = 0;
    slime.isGroundedFlag = 1;
    slime.slimeHopTimerTicks = 0;

    applySlimeAI(world);

    assert.ok(slime.velocityXWorld > 0, 'Should launch hop immediately');
    assert.ok(slime.velocityYWorld < 0, 'Should launch upward');
    assert.equal(slime.isGroundedFlag, 0);
  });
});
