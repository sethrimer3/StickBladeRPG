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
import type { SolidMask } from '../sim/pixelMaterials/pixelMaterialSolid';
import { createWorldState, type WorldState } from '../sim/world';
import { createClusterState } from '../sim/clusters/state';
import {
  equipPlayerWeapon,
  syncStickmanCarryHands,
} from '../sim/weapons/playerWeaponState';

const DT_MS = 1000 / 60;
const FLOOR_Y = 40;

/**
 * Flat floor, matching `stickRangerBody.test.ts`. The figure has to be STANDING
 * for a carry pose to mean anything — run in free fall it tumbles, and the
 * hands read wherever the tumble happens to have thrown them.
 */
const FLOOR = {
  isSolid: (_x: number, y: number): boolean => y >= FLOOR_Y,
} as unknown as SolidMask;

function makeWorld(): WorldState {
  const world = createWorldState(DT_MS, 8);
  world.clusters.push(createClusterState(1, 0, 0, 1, 100));
  world.stickRangerBody = createStickRangerBody(0, 20);
  return world;
}

/**
 * Runs the rig standing still and returns the MEAN grip offset over the settled
 * window.
 *
 * A mean rather than a final sample: the arms are pendulums hanging off a soft
 * body and never fully stop, so any single frame is a phase reading rather than
 * the pose. Facing is re-asserted each frame because the gait owns it.
 */
function measureCarry(
  world: WorldState,
  facing: 1 | -1 = 1,
  moveDirection = 0,
): { left: number; right: number; grip: number } {
  const body = world.stickRangerBody!;
  let left = 0;
  let right = 0;
  let samples = 0;
  for (let i = 0; i < 400; i++) {
    body.facingDirection = facing;
    stepStickRangerBody(body, FLOOR, moveDirection, DT_MS, false);
    if (i < 60) continue;
    left += (body.x[SR_HAND_L] - body.x[SR_HIP]) * facing;
    right += (body.x[SR_HAND_R] - body.x[SR_HIP]) * facing;
    samples++;
  }
  left /= samples;
  right /= samples;
  // Every point measured in ONE run: each call advances the simulation, so
  // measuring two hands with two calls compares different moments in time.
  return { left, right, grip: (left + right) * 0.5 };
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
  test('a two-handed grip is carried well ahead of the hip', () => {
    // The grip — the midpoint of the hands — is where the weapon is drawn from,
    // so it is the number that decides whether the sword reads as carried.
    const bare = meanForwardOffset(makeWorld(), 'grip');

    const armed = makeWorld();
    equipPlayerWeapon(armed.playerWeapon, 'woodenSword');
    syncStickmanCarryHands(armed);
    const carried = meanForwardOffset(armed, 'grip');

    assert.ok(carried > 4, `grip should be carried in front, got ${carried.toFixed(2)}`);
    assert.ok(carried > bare + 3, `armed ${carried.toFixed(2)} vs unarmed ${bare.toFixed(2)}`);
  });

  test('a one-handed weapon carries its own hand and leaves the other alone', () => {
    const bare = meanForwardOffset(makeWorld(), SR_HAND_R);

    const armed = makeWorld();
    equipPlayerWeapon(armed.playerWeapon, 'goldweaveBlade'); // oneHand
    armed.stickRangerBody!.facingDirection = 1;
    syncStickmanCarryHands(armed);
    const swordHand = meanForwardOffset(armed, SR_HAND_R);

    assert.ok(swordHand > 4, `the sword hand should lead, got ${swordHand.toFixed(2)}`);
    assert.ok(swordHand > bare + 3, `armed ${swordHand.toFixed(2)} vs unarmed ${bare.toFixed(2)}`);

    const offHand = meanForwardOffset(armed, SR_HAND_L);
    assert.ok(offHand < swordHand - 3, `the empty hand should stay back, got ${offHand.toFixed(2)}`);
  });

  test('facing left carries to the left', () => {
    const world = makeWorld();
    equipPlayerWeapon(world.playerWeapon, 'woodenSword');
    syncStickmanCarryHands(world);
    // `meanForwardOffset` folds facing in, so a correct mirror stays positive.
    const carried = meanForwardOffset(world, 'grip', -1);
    assert.ok(carried > 4, `grip should lead leftward, got ${carried.toFixed(2)}`);
  });

  test('the carry survives walking, where the gait pulls hardest', () => {
    const bare = meanForwardOffset(makeWorld(), 'grip', 1, 1);

    const armed = makeWorld();
    equipPlayerWeapon(armed.playerWeapon, 'woodenSword');
    syncStickmanCarryHands(armed);
    const carried = meanForwardOffset(armed, 'grip', 1, 1);

    assert.ok(carried > bare + 5, `walking: armed ${carried.toFixed(2)} vs unarmed ${bare.toFixed(2)}`);
    assert.ok(carried > 0, 'a walking figure should still lead with the weapon');
  });

  test('the two hands of a two-hander are spaced along the grip', () => {
    const world = makeWorld();
    equipPlayerWeapon(world.playerWeapon, 'woodenSword');
    syncStickmanCarryHands(world);
    const left = meanForwardOffset(world, SR_HAND_L);
    const right = meanForwardOffset(makeCarriedWorld(), SR_HAND_R);
    assert.ok(Math.abs(right - left) > 0.3, `hands should not stack, gap ${Math.abs(right - left).toFixed(2)}`);
  });
});

/** A fresh two-handed world, for comparisons that need an untouched run. */
function makeCarriedWorld(): WorldState {
  const world = makeWorld();
  equipPlayerWeapon(world.playerWeapon, 'woodenSword');
  syncStickmanCarryHands(world);
  return world;
}

describe('the bias stays out of the way', () => {
  test('it does not push the body across the room', () => {
    const world = makeCarriedWorld();
    const body = world.stickRangerBody!;
    const startHipX = body.x[SR_HIP];
    for (let i = 0; i < 400; i++) {
      body.facingDirection = 1;
      stepStickRangerBody(body, FLOOR, 0, DT_MS, false);
    }
    const drift = Math.abs(body.x[SR_HIP] - startHipX);
    assert.ok(drift < 3, `hip drifted ${drift.toFixed(2)} world units from arm bias alone`);
  });

  test('a ragdoll is left to flail', () => {
    const world = makeCarriedWorld();
    const body = world.stickRangerBody!;
    triggerStickRangerRagdoll(body);
    const before = body.x[SR_HAND_R] - body.x[SR_HIP];
    stepStickRangerBody(body, FLOOR, 0, DT_MS, false);
    const after = body.x[SR_HAND_R] - body.x[SR_HIP];
    // The carry moves the hand several tenths of a unit in a single frame.
    assert.ok(Math.abs(after - before) < 0.5, 'the carry must not run while ragdolling');
  });

  test('the rig stays finite under a long carry', () => {
    const world = makeCarriedWorld();
    const body = world.stickRangerBody!;
    for (let i = 0; i < 900; i++) stepStickRangerBody(body, FLOOR, i % 120 < 60 ? 1 : 0, DT_MS, false);
    for (let i = 0; i < body.x.length; i++) {
      assert.ok(Number.isFinite(body.x[i]) && Number.isFinite(body.y[i]), `point ${i} went non-finite`);
    }
  });
});
