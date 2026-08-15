/**
 * Tests for the character preview wander AI and live physical simulation in the inventory screen.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  createWanderState,
  updateWanderState,
} from '../ui/characterPreviewRenderer';
import {
  createStickRangerBody,
  stepStickRangerBody,
  SR_HIP,
  SR_FOOT_L,
  SR_FOOT_R,
} from '../sim/clusters/stickRangerBody';
import { SolidMask } from '../sim/pixelMaterials/pixelMaterialSolid';

describe('character preview wander AI', () => {
  test('createWanderState initializes 5-tile bounds (±2 tiles / ±16 world units) and 5-15s idle timer', () => {
    const startX = 25.7;
    const now = 1000;
    const state = createWanderState(startX, now);

    assert.equal(state.startX, startX);
    assert.equal(state.minX, startX - 16);
    assert.equal(state.maxX, startX + 16);
    assert.equal(state.moveDirection, 0);
    assert.ok(state.nextDecisionTime >= now + 5000, 'Next decision should be at least 5s in the future');
    assert.ok(state.nextDecisionTime <= now + 15000, 'Next decision should be at most 15s in the future');
  });

  test('idle state does not move until decision timer expires', () => {
    const startX = 25.7;
    const now = 1000;
    const state = createWanderState(startX, now);
    state.nextDecisionTime = now + 6000;

    // Advance 3 seconds (less than nextDecisionTime)
    updateWanderState(state, startX, now + 3000);
    assert.equal(state.moveDirection, 0);
  });

  test('triggers random walk within [minX, maxX] when decision timer expires', () => {
    const startX = 25.7;
    const now = 1000;
    const state = createWanderState(startX, now);
    state.nextDecisionTime = now + 5000;

    // Timer expires
    const rngVal = 0.8;
    updateWanderState(state, startX, now + 5000, () => rngVal);

    assert.notEqual(state.moveDirection, 0, 'Should start moving');
    assert.ok(state.targetX >= state.minX - 0.1, 'Target should be within min bounds');
    assert.ok(state.targetX <= state.maxX + 0.1, 'Target should be within max bounds');
    assert.equal(state.walkStartTime, now + 5000);
  });

  test('completing a walk resets to idle with new 5-15s timer', () => {
    const startX = 25.7;
    const now = 1000;
    const state = createWanderState(startX, now);
    state.targetX = startX + 8;
    state.moveDirection = 1;
    state.walkStartTime = now;

    // Simulate arriving at targetX
    const arrivalTime = now + 1200;
    updateWanderState(state, state.targetX - 0.2, arrivalTime, () => 0.5);

    assert.equal(state.moveDirection, 0, 'Should stop upon reaching destination');
    assert.equal(state.nextDecisionTime, arrivalTime + 10000, '5000 + 0.5 * 10000 = 10000ms idle');
  });

  test('boundary safety: near left bound only moves right, near right bound only moves left', () => {
    const startX = 25.7;
    const now = 1000;
    const state = createWanderState(startX, now);
    state.nextDecisionTime = now;

    // At far left boundary (minX = startX - 16)
    const atMinX = state.minX;
    updateWanderState(state, atMinX, now, () => 0.1);
    assert.equal(state.moveDirection, 1, 'Must move right when at far left edge');
    assert.ok(state.targetX > atMinX);

    // At far right boundary (maxX = startX + 16)
    state.moveDirection = 0;
    state.nextDecisionTime = now + 1000;
    const atMaxX = state.maxX;
    updateWanderState(state, atMaxX, now + 1000, () => 0.1);
    assert.equal(state.moveDirection, -1, 'Must move left when at far right edge');
    assert.ok(state.targetX < atMaxX);
  });
});

describe('character preview physics integration', () => {
  test('stickman softbody stays on top of SolidMask floor', () => {
    const worldW = 52;
    const worldH = 64;
    const floorY = 46;
    const solidMask = new SolidMask(worldW, worldH);
    solidMask.markRect(0, floorY, worldW, worldH);

    // Spawn hip at floorY - 9.6
    const body = createStickRangerBody(worldW * 0.5, floorY - 9.6);

    // Step physics for 60 frames (1 second) of idle standing
    for (let f = 0; f < 60; f++) {
      stepStickRangerBody(body, solidMask, 0, 16.666);
    }

    // Feet should be supported near floorY without falling through
    assert.ok(body.y[SR_FOOT_L] <= floorY + 1.0, 'Left foot should rest on the floor');
    assert.ok(body.y[SR_FOOT_R] <= floorY + 1.0, 'Right foot should rest on the floor');
    assert.ok(body.y[SR_HIP] < floorY, 'Hip should be above the floor');
    assert.equal(body.groundContactFlag, 1, 'Should register ground contact');
  });

  test('stickman steps forward when moveDirection is active', () => {
    const worldW = 52;
    const worldH = 64;
    const floorY = 46;
    const solidMask = new SolidMask(worldW, worldH);
    solidMask.markRect(0, floorY, worldW, worldH);

    const initialHipX = worldW * 0.5;
    const body = createStickRangerBody(initialHipX, floorY - 9.6);

    // Settle for 10 frames
    for (let f = 0; f < 10; f++) {
      stepStickRangerBody(body, solidMask, 0, 16.666);
    }

    // Walk right (+1) for 40 frames
    for (let f = 0; f < 40; f++) {
      stepStickRangerBody(body, solidMask, 1, 16.666);
    }

    assert.ok(body.x[SR_HIP] > initialHipX + 1.0, 'Stickman should physically step rightward');
    assert.equal(body.facingDirection, 1, 'Facing direction should be right');
  });
});
