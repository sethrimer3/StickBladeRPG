import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createStickRangerBody,
  stepStickRangerBody,
  requestStickRangerJump,
  SR_HIP,
  SR_FRAME_MS,
  canStickmanJump,
} from '../sim/clusters/stickRangerBody';
import type { SolidMask } from '../sim/clusters/solidMask';

/** A flat floor at y = 100 in world coordinates. */
function createFlatFloorSolid(floorY: number): SolidMask {
  return {
    isSolid: (_x: number, y: number) => y >= floorY,
    findSolidY: (_x: number, _startY: number, _endY: number) => floorY,
  };
}

describe('Stickman Softbody Double-Jump Mechanics', () => {
  test('double jump recharges to 2 when touching ground, and allows mid-air second jump', () => {
    const floorY = 100;
    const solid = createFlatFloorSolid(floorY);

    // Spawn stickman with feet resting on the floor (feet are ~9.6 below hip)
    const body = createStickRangerBody(50, floorY - 9.6, true);
    assert.equal(body.hasDoubleJumpUnlock, true);

    // Step a few frames to settle on ground
    for (let i = 0; i < 5; i++) {
      stepStickRangerBody(body, solid, 0, SR_FRAME_MS);
    }

    assert.ok(canStickmanJump(body, solid), 'Stickman should be able to jump on ground');
    assert.equal(body.jumpsRemaining, 2, 'Jumps should be charged to 2 on ground');

    // 1. Ground Jump
    requestStickRangerJump(body);
    stepStickRangerBody(body, solid, 0, SR_FRAME_MS);

    assert.equal(body.jumpFiredFlag, 1, 'First jump should fire from ground');
    assert.equal(body.jumpsRemaining, 1, 'First jump should leave 1 jump remaining');

    // Let the stickman rise into the air and start falling
    for (let i = 0; i < 15; i++) {
      stepStickRangerBody(body, solid, 0, SR_FRAME_MS);
    }

    assert.equal(canStickmanJump(body, solid), false, 'Stickman is mid-air');
    const prevVy = body.y[SR_HIP] - body.prevY[SR_HIP];

    // 2. Mid-air Double Jump
    requestStickRangerJump(body);
    stepStickRangerBody(body, solid, 0, SR_FRAME_MS);

    assert.equal(body.jumpFiredFlag, 1, 'Double jump should fire in mid-air');
    assert.equal(body.jumpsRemaining, 0, 'Double jump should consume the 2nd jump');

    // Velocity should be reset to upward launch impulse from current position
    const newVy = body.y[SR_HIP] - body.prevY[SR_HIP];
    assert.ok(newVy < 0, 'Velocity should be upward after double jump');
    assert.ok(newVy < prevVy, 'Upward launch should overcome downward falling velocity');

    // 3. Attempting a 3rd jump in mid-air fails
    requestStickRangerJump(body);
    stepStickRangerBody(body, solid, 0, SR_FRAME_MS);
    assert.equal(body.jumpFiredFlag, 0, '3rd jump in mid-air should not fire');

    // 4. Land on ground to recharge (allows airtime + landing absorption/settle)
    for (let i = 0; i < 100; i++) {
      stepStickRangerBody(body, solid, 0, SR_FRAME_MS);
    }

    assert.ok(canStickmanJump(body, solid), 'Stickman lands on ground');
    assert.equal(body.jumpsRemaining, 2, 'Ground contact recharges jumps to 2');
  });

  test('when double-jump is disabled, only 1 jump is allowed before landing', () => {
    const floorY = 100;
    const solid = createFlatFloorSolid(floorY);

    const body = createStickRangerBody(50, floorY - 9.6, false); // hasDoubleJump = false
    assert.equal(body.hasDoubleJumpUnlock, false);

    // Settle on ground
    for (let i = 0; i < 5; i++) {
      stepStickRangerBody(body, solid, 0, SR_FRAME_MS);
    }

    assert.equal(body.jumpsRemaining, 1, 'Only 1 jump on ground when double jump is disabled');

    // Ground Jump
    requestStickRangerJump(body);
    stepStickRangerBody(body, solid, 0, SR_FRAME_MS);
    assert.equal(body.jumpFiredFlag, 1);
    assert.equal(body.jumpsRemaining, 0);

    // Rise into air
    for (let i = 0; i < 10; i++) {
      stepStickRangerBody(body, solid, 0, SR_FRAME_MS);
    }

    // Mid-air jump attempt
    requestStickRangerJump(body);
    stepStickRangerBody(body, solid, 0, SR_FRAME_MS);
    assert.equal(body.jumpFiredFlag, 0, 'Mid-air jump cannot fire without double jump unlock');
  });
});
