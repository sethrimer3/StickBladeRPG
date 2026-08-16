import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  SR_CHEST,
  SR_HAND_R,
  createStickRangerBody,
  stepStickRangerBody,
} from '../sim/clusters/stickRangerBody';
import type { SolidMask } from '../sim/pixelMaterials/pixelMaterialSolid';
import { createWorldState, type WorldState } from '../sim/world';
import { createClusterState } from '../sim/clusters/state';
import {
  equipPlayerWeapon,
  syncStickmanCarryHands,
  tryStartPlayerWeaponAttack,
} from '../sim/weapons/playerWeaponState';
import {
  createStickmanEnemyState,
  tickStickmanEnemy,
} from '../sim/clusters/stickmanEnemy';

const DT_MS = 1000 / 60;
const FLOOR_Y = 40;

const FLOOR = {
  isSolid: (_x: number, y: number): boolean => y >= FLOOR_Y,
} as unknown as SolidMask;

function makeWorld(): WorldState {
  const world = createWorldState(DT_MS, 8);
  world.clusters.push(createClusterState(1, 0, 0, 1, 100));
  world.stickRangerBody = createStickRangerBody(0, 20);
  return world;
}

describe('stickman sword swing arm physics', () => {
  describe('swing flags synchronization', () => {
    test('at rest, arms carry but do not swing', () => {
      const world = makeWorld();
      equipPlayerWeapon(world.playerWeapon, 'woodenSword');
      syncStickmanCarryHands(world);

      assert.equal(world.stickRangerBody!.carryHandLeftFlag, 1);
      assert.equal(world.stickRangerBody!.carryHandRightFlag, 1);
      assert.equal(world.stickRangerBody!.swingArmLeftFlag, 0);
      assert.equal(world.stickRangerBody!.swingArmRightFlag, 0);
    });

    test('two-handed weapon swing activates both swing arms with matching angle', () => {
      const world = makeWorld();
      equipPlayerWeapon(world.playerWeapon, 'woodenSword');
      const player = world.clusters[0];
      tryStartPlayerWeaponAttack(world, player, 50, 0, world.rng, world.playerWeapon);
      syncStickmanCarryHands(world);

      assert.equal(world.stickRangerBody!.carryHandLeftFlag, 1);
      assert.equal(world.stickRangerBody!.carryHandRightFlag, 1);
      assert.equal(world.stickRangerBody!.swingArmLeftFlag, 1);
      assert.equal(world.stickRangerBody!.swingArmRightFlag, 1);
      assert.equal(
        world.stickRangerBody!.swingArmLeftAngleRad,
        world.playerWeapon.swing.currentAngleRad,
      );
      assert.equal(
        world.stickRangerBody!.swingArmRightAngleRad,
        world.playerWeapon.swing.currentAngleRad,
      );
    });

    test('one-handed weapon swing activates only dominant swing arm', () => {
      const world = makeWorld();
      equipPlayerWeapon(world.playerWeapon, 'goldweaveBlade'); // 1-handed
      world.stickRangerBody!.facingDirection = 1;
      const player = world.clusters[0];
      player.isFacingLeftFlag = 0;
      tryStartPlayerWeaponAttack(world, player, 50, 0, world.rng, world.playerWeapon);
      syncStickmanCarryHands(world);

      assert.equal(world.stickRangerBody!.swingArmRightFlag, 1);
      assert.equal(world.stickRangerBody!.swingArmLeftFlag, 0);

      // Facing left leads with left hand
      world.stickRangerBody!.facingDirection = -1;
      player.isFacingLeftFlag = 1;
      syncStickmanCarryHands(world);
      assert.equal(world.stickRangerBody!.swingArmLeftFlag, 1);
      assert.equal(world.stickRangerBody!.swingArmRightFlag, 0);
    });

    test('off-hand weapon swing activates off-hand swing arm', () => {
      const world = makeWorld();
      world.stickRangerBody!.facingDirection = 1;
      equipPlayerWeapon(world.playerWeapon, 'goldweaveBlade');
      equipPlayerWeapon(world.playerOffHandWeapon, 'frostweaveBlade');
      const player = world.clusters[0];
      player.isFacingLeftFlag = 0;

      // Swing off-hand weapon only
      tryStartPlayerWeaponAttack(world, player, 50, 0, world.rng, world.playerOffHandWeapon);
      syncStickmanCarryHands(world);

      assert.equal(world.stickRangerBody!.swingArmRightFlag, 0);
      assert.equal(world.stickRangerBody!.swingArmLeftFlag, 1);
    });
  });

  describe('arm straightening and arc following', () => {
    test('arm extends/straightens forward during swing compared to resting carry', () => {
      const world = makeWorld();
      const body = world.stickRangerBody!;
      body.facingDirection = 1;

      // Settle body standing on floor
      for (let i = 0; i < 60; i++) {
        stepStickRangerBody(body, FLOOR, 0, DT_MS, 0, false);
      }

      // 1. Measure rest carry hand-to-chest offset
      body.carryHandLeftFlag = 1;
      body.carryHandRightFlag = 1;
      body.swingArmLeftFlag = 0;
      body.swingArmRightFlag = 0;
      for (let i = 0; i < 30; i++) {
        stepStickRangerBody(body, FLOOR, 0, DT_MS, 0, false);
      }
      const restDx = body.x[SR_HAND_R] - body.x[SR_CHEST];
      const restDy = body.y[SR_HAND_R] - body.y[SR_CHEST];

      // 2. Measure swing hand-to-chest offset (forward horizontal cut angle 0)
      body.swingArmLeftFlag = 1;
      body.swingArmRightFlag = 1;
      body.swingArmLeftAngleRad = 0;
      body.swingArmRightAngleRad = 0;
      for (let i = 0; i < 30; i++) {
        stepStickRangerBody(body, FLOOR, 0, DT_MS, 0, false);
      }
      const swingDx = body.x[SR_HAND_R] - body.x[SR_CHEST];
      const swingDy = body.y[SR_HAND_R] - body.y[SR_CHEST];

      // Forward cut should straighten out the arm horizontally in front of the chest
      assert.ok(
        swingDx > restDx + 0.8,
        `Expected swing forward reach (${swingDx.toFixed(2)}) > rest forward reach (${restDx.toFixed(2)}) + 0.8`,
      );
      assert.ok(
        Math.abs(swingDy) < Math.abs(restDy),
        `Expected horizontal cut Y offset (${swingDy.toFixed(2)}) to be closer to chest level than resting carry (${restDy.toFixed(2)})`,
      );
    });

    test('arm follows angle of the swing arc', () => {
      const world = makeWorld();
      const body = world.stickRangerBody!;
      body.facingDirection = 1;

      // Settle on floor
      for (let i = 0; i < 60; i++) {
        stepStickRangerBody(body, FLOOR, 0, DT_MS, 0, false);
      }

      // Case A: High overhead swing angle (-Math.PI * 0.5 = -90 deg, pointing straight up)
      body.carryHandRightFlag = 1;
      body.swingArmRightFlag = 1;
      body.swingArmRightAngleRad = -Math.PI * 0.5;
      for (let i = 0; i < 30; i++) {
        stepStickRangerBody(body, FLOOR, 0, DT_MS, 0, false);
      }
      const overheadDy = body.y[SR_HAND_R] - body.y[SR_CHEST];
      assert.ok(
        overheadDy < -4.0,
        `Hand should be raised high above chest during overhead swing, got dy=${overheadDy.toFixed(2)}`,
      );

      // Case B: Forward straight cut (angle 0)
      body.swingArmRightAngleRad = 0;
      for (let i = 0; i < 30; i++) {
        stepStickRangerBody(body, FLOOR, 0, DT_MS, 0, false);
      }
      const forwardDx = body.x[SR_HAND_R] - body.x[SR_CHEST];
      assert.ok(
        forwardDx > 5.5,
        `Hand should be extended forward in front of chest during forward cut, got dx=${forwardDx.toFixed(2)}`,
      );

      // Case C: Downward follow-through (+Math.PI * 0.4 = +72 deg, pointing down-forward)
      body.swingArmRightAngleRad = Math.PI * 0.4;
      for (let i = 0; i < 30; i++) {
        stepStickRangerBody(body, FLOOR, 0, DT_MS, 0, false);
      }
      const downDy = body.y[SR_HAND_R] - body.y[SR_CHEST];
      assert.ok(
        downDy > 4.0,
        `Hand should be low below chest during downward follow-through, got dy=${downDy.toFixed(2)}`,
      );
    });
  });

  describe('enemy stickman swing arms', () => {
    test('enemy stickman activates swing arms during melee attack', () => {
      const world = makeWorld();
      const enemyCluster = createClusterState(2, 20, 20, 1, 50);
      world.clusters.push(enemyCluster);
      const enemyState = createStickmanEnemyState(enemyCluster, 'sword');

      // Tick enemy with player in close melee range
      const playerCluster = world.clusters[0];
      playerCluster.positionXWorld = 30;
      playerCluster.positionYWorld = 20;

      tickStickmanEnemy(
        enemyCluster,
        world,
        1 / 60,
        playerCluster.positionXWorld,
        playerCluster.positionYWorld,
        true,
      );

      assert.equal(enemyState.isSwinging, true);
      assert.equal(enemyCluster.stickmanEnemyIsSwinging, 1);
      assert.equal(enemyState.body.swingArmRightFlag, 1);
      assert.equal(enemyState.body.carryHandRightFlag, 1);
      assert.equal(
        enemyState.body.swingArmRightAngleRad,
        enemyState.aimAngleRad,
      );
    });
  });
});
