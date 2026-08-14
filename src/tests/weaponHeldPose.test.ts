/**
 * Held-weapon pose: the carry angle, and the tip's collision with tiles.
 *
 * The bug these pin: the held angle used to come from shoulder → hand, which on
 * this rig points almost straight down, so a blade drawn along it hung through
 * the floor and off the screen.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createWorldState } from '../sim/world';
import { createStickRangerBody } from '../sim/clusters/stickRangerBody';
import {
  computeHeldWeaponPose,
  createHeldWeaponPose,
  resolveHeldRestAngleRad,
  seedHeldWeaponPose,
  HELD_REST_ANGLE_RAD,
} from '../sim/weapons/weaponHeldPose';
import { getWeaponDef } from '../sim/weapons/weaponDefs';
import type { WeaponDef } from '../sim/weapons/weaponDefs';

const SWORD = getWeaponDef('woodenSword') as WeaponDef;

/** A world holding one axis-aligned wall rectangle. */
function makeWorldWithWall(x: number, y: number, w: number, h: number) {
  const world = createWorldState();
  world.wallCount = 1;
  world.wallXWorld[0] = x;
  world.wallYWorld[0] = y;
  world.wallWWorld[0] = w;
  world.wallHWorld[0] = h;
  return world;
}

describe('held weapon rest angle', () => {
  test('the blade rests above horizontal, not hanging down the body', () => {
    const angle = resolveHeldRestAngleRad(SWORD, 1);
    assert.equal(angle, HELD_REST_ANGLE_RAD);
    // Y grows downward, so a carried blade must have a negative Y component.
    assert.ok(Math.sin(angle) < 0, 'the tip should be above the grip');
    assert.ok(Math.cos(angle) > 0, 'the tip should lead in the facing direction');
  });

  test('facing left mirrors the carry rather than inverting it', () => {
    const left = resolveHeldRestAngleRad(SWORD, -1);
    assert.ok(Math.cos(left) < 0, 'the tip should lead left');
    assert.ok(Math.sin(left) < 0, 'the tip should still be above the grip');
  });
});

describe('held weapon tip collision', () => {
  test('an unobstructed blade occupies its full reach', () => {
    const world = createWorldState();
    const body = createStickRangerBody(100, 100);
    const pose = createHeldWeaponPose();

    computeHeldWeaponPose(world, body, SWORD, 20, HELD_REST_ANGLE_RAD, true, pose);

    assert.equal(pose.reachWorld, 20);
    assert.equal(pose.requestedReachWorld, 20);
    assert.equal(pose.tipContactFlag, 0);
    assert.equal(pose.angleRad, HELD_REST_ANGLE_RAD);
  });

  test('a blade pointed into a wall is rotated clear rather than passing through', () => {
    // A tall slab directly ahead of the grip, blocking the rest angle but
    // leaving open air above it.
    const world = makeWorldWithWall(110, 90, 8, 20);
    const body = createStickRangerBody(100, 100);
    const pose = createHeldWeaponPose();

    computeHeldWeaponPose(world, body, SWORD, 20, 0, true, pose);

    assert.notEqual(pose.angleRad, 0, 'the blade should have tilted off the wall');
    assert.equal(pose.tipContactFlag, 0, 'once clear the blade keeps its length');
    assert.equal(pose.reachWorld, 20);
  });

  test('a boxed-in blade keeps its angle and loses length instead', () => {
    // A dead-end corridor: slab ahead, ceiling above, floor below, so no angle
    // in the forward half-plane has room for the blade.
    const world = makeWorldWithWall(104, 60, 8, 100);
    world.wallCount = 3;
    world.wallXWorld[1] = 60; world.wallYWorld[1] = 96;  world.wallWWorld[1] = 100; world.wallHWorld[1] = 2;
    world.wallXWorld[2] = 60; world.wallYWorld[2] = 104; world.wallWWorld[2] = 100; world.wallHWorld[2] = 2;

    const body = createStickRangerBody(100, 100);
    const pose = createHeldWeaponPose();

    computeHeldWeaponPose(world, body, SWORD, 40, 0, true, pose);

    assert.equal(pose.angleRad, 0, 'no angle was clear, so the preferred one is kept');
    assert.equal(pose.tipContactFlag, 1);
    assert.ok(pose.reachWorld < 40, 'the blade is drawn only as far as it fits');
    assert.ok(pose.tipXWorld <= 104, 'the tip stays outside the wall');
  });

  test('a swing loses length but never dodges — the arc must match the damage pass', () => {
    const world = makeWorldWithWall(110, 90, 8, 20);
    const body = createStickRangerBody(100, 100);
    const pose = createHeldWeaponPose();

    computeHeldWeaponPose(world, body, SWORD, 20, 0, false, pose);

    assert.equal(pose.angleRad, 0);
    assert.equal(pose.tipContactFlag, 1);
    assert.ok(pose.reachWorld < 20);
  });
});

describe('held weapon pose seeding', () => {
  test('an equipped weapon has a full-length rest pose before any tick runs', () => {
    const pose = createHeldWeaponPose();
    seedHeldWeaponPose(pose, SWORD, 1);
    assert.equal(pose.reachWorld, SWORD.range);
    assert.equal(pose.requestedReachWorld, SWORD.range);
    assert.equal(pose.tipContactFlag, 0);
  });

  test('an unarmed pose occupies nothing', () => {
    const pose = createHeldWeaponPose();
    seedHeldWeaponPose(pose, SWORD, 1);
    seedHeldWeaponPose(pose, null);
    assert.equal(pose.reachWorld, 0);
  });
});
