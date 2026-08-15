/**
 * The weapon carry pose: a held weapon pulls its hand forward, on the side the
 * stickman faces, instead of letting it hang at the hip.
 *
 * Without it the drawn weapon reads as dropped — the rig's rest pose puts the
 * hands level with the hips, behind the body as often as in front of it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  SR_HAND_L,
  SR_HAND_R,
  SR_HIP,
  createStickRangerBody,
  stepStickRangerBody,
  triggerStickRangerRagdoll,
} from '../sim/clusters/stickRangerBody';
import { createWorldState, type WorldState } from '../sim/world';
import { createClusterState } from '../sim/clusters/state';
import {
  equipPlayerWeapon,
  syncStickmanCarryHands,
} from '../sim/weapons/playerWeaponState';

const DT_MS = 1000 / 60;
/** Long enough for a bias at 0.09 per frame to be unmistakable. */
const SETTLE_MS = DT_MS * 90;

function makeWorld(): WorldState {
  const world = createWorldState(DT_MS, 8);
  world.clusters.push(createClusterState(1, 0, 0, 1, 100));
  world.stickRangerBody = createStickRangerBody(0, 0);
  return world;
}

/** Runs the rig in still air for long enough that the pose settles. */
function settle(world: WorldState, ms = SETTLE_MS): void {
  const body = world.stickRangerBody!;
  const steps = Math.ceil(ms / DT_MS);
  for (let i = 0; i < steps; i++) stepStickRangerBody(body, null, 0, DT_MS, false);
}

/** Hand offset ahead of the hip, positive meaning "in the facing direction". */
function forwardOffset(world: WorldState, handIndex: number): number {
  const body = world.stickRangerBody!;
  return (body.x[handIndex] - body.x[SR_HIP]) * body.facingDirection;
}

describe('which hands carry', () => {
  test('unarmed, neither hand carries', () => {
    const world = makeWorld();
    syncStickmanCarryHands(world);
    assert.equal(world.stickRangerBody!.carryHandLeftFlag, 0);
    assert.equal(world.stickRangerBody!.carryHandRightFlag, 0);
  });

  test('a two-handed weapon claims both hands', () => {
    const world = makeWorld();
    equipPlayerWeapon(world.playerWeapon, 'woodenSword'); // grip: twoHand
    syncStickmanCarryHands(world);
    assert.equal(world.stickRangerBody!.carryHandLeftFlag, 1);
    assert.equal(world.stickRangerBody!.carryHandRightFlag, 1);
  });

  test('a one-handed weapon claims only the leading hand', () => {
    const world = makeWorld();
    equipPlayerWeapon(world.playerWeapon, 'goldweaveBlade'); // grip: oneHand

    world.stickRangerBody!.facingDirection = 1;
    syncStickmanCarryHands(world);
    assert.equal(world.stickRangerBody!.carryHandRightFlag, 1);
    assert.equal(world.stickRangerBody!.carryHandLeftFlag, 0);

    world.stickRangerBody!.facingDirection = -1;
    syncStickmanCarryHands(world);
    assert.equal(world.stickRangerBody!.carryHandLeftFlag, 1, 'facing left leads with the left hand');
    assert.equal(world.stickRangerBody!.carryHandRightFlag, 0);
  });

  test('an off-hand weapon claims the remaining hand', () => {
    const world = makeWorld();
    world.stickRangerBody!.facingDirection = 1;
    equipPlayerWeapon(world.playerWeapon, 'goldweaveBlade');
    equipPlayerWeapon(world.playerOffHandWeapon, 'frostweaveBlade');
    syncStickmanCarryHands(world);
    assert.equal(world.stickRangerBody!.carryHandLeftFlag, 1);
    assert.equal(world.stickRangerBody!.carryHandRightFlag, 1);
  });

  test('unequipping releases the hands again', () => {
    const world = makeWorld();
    equipPlayerWeapon(world.playerWeapon, 'woodenSword');
    syncStickmanCarryHands(world);
    equipPlayerWeapon(world.playerWeapon, null);
    syncStickmanCarryHands(world);
    assert.equal(world.stickRangerBody!.carryHandLeftFlag, 0);
    assert.equal(world.stickRangerBody!.carryHandRightFlag, 0);
  });
});

describe('the carried hand sits in front', () => {
  test('a two-handed weapon brings both hands forward of the hip', () => {
    const world = makeWorld();
    equipPlayerWeapon(world.playerWeapon, 'woodenSword');
    world.stickRangerBody!.facingDirection = 1;
    syncStickmanCarryHands(world);
    settle(world);

    assert.ok(forwardOffset(world, SR_HAND_L) > 1, `left hand at ${forwardOffset(world, SR_HAND_L)}`);
    assert.ok(forwardOffset(world, SR_HAND_R) > 1, `right hand at ${forwardOffset(world, SR_HAND_R)}`);
  });

  test('an unarmed stickman keeps its hands at the hips', () => {
    const armed = makeWorld();
    equipPlayerWeapon(armed.playerWeapon, 'woodenSword');
    armed.stickRangerBody!.facingDirection = 1;
    syncStickmanCarryHands(armed);
    settle(armed);

    const bare = makeWorld();
    bare.stickRangerBody!.facingDirection = 1;
    syncStickmanCarryHands(bare);
    settle(bare);

    assert.ok(
      forwardOffset(armed, SR_HAND_R) > forwardOffset(bare, SR_HAND_R) + 1,
      'the armed hand should be meaningfully further forward',
    );
  });

  test('facing left carries to the left', () => {
    const world = makeWorld();
    equipPlayerWeapon(world.playerWeapon, 'woodenSword');
    world.stickRangerBody!.facingDirection = -1;
    syncStickmanCarryHands(world);
    settle(world);

    const body = world.stickRangerBody!;
    assert.ok(body.x[SR_HAND_L] < body.x[SR_HIP], 'hands should be on the left of the hip');
    assert.ok(body.x[SR_HAND_R] < body.x[SR_HIP]);
    // `forwardOffset` folds facing in, so it stays positive either way.
    assert.ok(forwardOffset(world, SR_HAND_L) > 1);
  });

  test('a one-handed weapon leaves the off hand where it was', () => {
    const world = makeWorld();
    equipPlayerWeapon(world.playerWeapon, 'goldweaveBlade');
    world.stickRangerBody!.facingDirection = 1;
    syncStickmanCarryHands(world);
    settle(world);

    assert.ok(
      forwardOffset(world, SR_HAND_R) > forwardOffset(world, SR_HAND_L) + 1,
      'only the holding hand should have come forward',
    );
  });

  test('the two hands of a two-hander are offset, not stacked', () => {
    const world = makeWorld();
    equipPlayerWeapon(world.playerWeapon, 'woodenSword');
    world.stickRangerBody!.facingDirection = 1;
    syncStickmanCarryHands(world);
    settle(world);

    const gap = Math.abs(forwardOffset(world, SR_HAND_R) - forwardOffset(world, SR_HAND_L));
    assert.ok(gap > 0.1, `hands should be spaced along the grip, gap ${gap}`);
  });
});

describe('the bias stays out of the way', () => {
  test('it does not push the body across the room', () => {
    const world = makeWorld();
    equipPlayerWeapon(world.playerWeapon, 'woodenSword');
    world.stickRangerBody!.facingDirection = 1;
    syncStickmanCarryHands(world);

    const startHipX = world.stickRangerBody!.x[SR_HIP];
    settle(world, DT_MS * 240);
    const drift = Math.abs(world.stickRangerBody!.x[SR_HIP] - startHipX);
    assert.ok(drift < 2, `hip drifted ${drift} world units from arm bias alone`);
  });

  test('a ragdoll is left to flail', () => {
    const world = makeWorld();
    equipPlayerWeapon(world.playerWeapon, 'woodenSword');
    world.stickRangerBody!.facingDirection = 1;
    syncStickmanCarryHands(world);

    const body = world.stickRangerBody!;
    triggerStickRangerRagdoll(body);
    const before = body.x[SR_HAND_R] - body.x[SR_HIP];
    stepStickRangerBody(body, null, 0, DT_MS, false);
    const after = body.x[SR_HAND_R] - body.x[SR_HIP];
    // The carry would move the hand several tenths of a unit in one frame.
    assert.ok(Math.abs(after - before) < 0.3, 'the carry must not run while ragdolling');
  });

  test('the rig stays finite under a long carry', () => {
    const world = makeWorld();
    equipPlayerWeapon(world.playerWeapon, 'woodenSword');
    syncStickmanCarryHands(world);
    settle(world, DT_MS * 600);
    const body = world.stickRangerBody!;
    for (let i = 0; i < body.x.length; i++) {
      assert.ok(Number.isFinite(body.x[i]) && Number.isFinite(body.y[i]), `point ${i} went non-finite`);
    }
  });
});
