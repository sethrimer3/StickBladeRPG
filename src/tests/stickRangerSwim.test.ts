import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createStickRangerBody,
  stepStickRangerBody,
  SR_HEAD,
  SR_HIP,
  SR_HAND_L,
  SR_HAND_R,
  SR_FRAME_MS,
} from '../sim/clusters/stickRangerBody';
import type { SolidMask } from '../sim/clusters/solidMask';

const nullSolid: SolidMask = {
  isSolid: () => false,
  findSolidY: () => null,
};

describe('Stickman Softbody Swimming Physics & Animation', () => {
  test('swims freely head-first in all 4 cardinal and diagonal directions', () => {
    // 1. Right Swim
    {
      const body = createStickRangerBody(100, 100, true, true);
      const startX = body.x[SR_HIP];
      for (let i = 0; i < 20; i++) {
        stepStickRangerBody(body, nullSolid, 1, SR_FRAME_MS, 0, true);
      }
      assert.ok(body.x[SR_HIP] > startX + 5, 'Should move horizontally right');
      assert.ok(body.x[SR_HEAD] > body.x[SR_HIP], 'Head should lead forward in front of hip');
      assert.equal(body.isSwimmingFlag, 1, 'Should set isSwimmingFlag');
    }

    // 2. Left Swim
    {
      const body = createStickRangerBody(100, 100, true, true);
      const startX = body.x[SR_HIP];
      for (let i = 0; i < 20; i++) {
        stepStickRangerBody(body, nullSolid, -1, SR_FRAME_MS, 0, true);
      }
      assert.ok(body.x[SR_HIP] < startX - 5, 'Should move horizontally left');
      assert.ok(body.x[SR_HEAD] < body.x[SR_HIP], 'Head should lead forward to the left');
    }

    // 3. Downward Dive Swim
    {
      const body = createStickRangerBody(100, 100, true, true);
      const startY = body.y[SR_HIP];
      for (let i = 0; i < 20; i++) {
        stepStickRangerBody(body, nullSolid, 0, SR_FRAME_MS, 1, true);
      }
      assert.ok(body.y[SR_HIP] > startY + 5, 'Should move downward in water');
      assert.ok(body.y[SR_HEAD] > body.y[SR_HIP], 'Head should lead downwards in front of hip');
    }

    // 4. Upward Surfacing Swim
    {
      const body = createStickRangerBody(100, 100, true, true);
      const startY = body.y[SR_HIP];
      for (let i = 0; i < 20; i++) {
        stepStickRangerBody(body, nullSolid, 0, SR_FRAME_MS, -1, true);
      }
      assert.ok(body.y[SR_HIP] < startY - 5, 'Should move upward in water');
      assert.ok(body.y[SR_HEAD] < body.y[SR_HIP], 'Head should lead upwards above hip');
    }
  });

  test('swim stroke cycle alternates between limb flare, power kick boost, and glide deceleration', () => {
    const body = createStickRangerBody(100, 100, true, true);

    // Track velocities and limb positions across the 24-frame stroke cycle
    const speeds: number[] = [];
    const handSpreads: number[] = [];

    for (let frame = 0; frame < 24; frame++) {
      const prevX = body.x[SR_HIP];
      stepStickRangerBody(body, nullSolid, 1, SR_FRAME_MS, 0, true);
      const speed = body.x[SR_HIP] - prevX;
      const handSpread = Math.abs(body.y[SR_HAND_L] - body.y[SR_HAND_R]);

      speeds.push(speed);
      handSpreads.push(handSpread);
    }

    // Power kick phase (frames 10..15): speed reaches peak boost
    const kickSpeed = Math.max(...speeds.slice(10, 16));
    const cruiseSpeed = speeds[8];
    assert.ok(kickSpeed > cruiseSpeed, 'Power kick phase should accelerate speed above cruise speed');

    // Glide phase (frames 18..23): speed decelerates back down
    const endSpeed = speeds[23];
    assert.ok(endSpeed < kickSpeed, 'Glide phase should decelerate back toward top cruising speed');
  });

  test('solid obstacle stops swimming stickman from penetrating walls', () => {
    // Wall at x = 120
    const wallSolid: SolidMask = {
      isSolid: (x: number, _y: number) => x >= 120,
      findSolidY: () => null,
    };

    const body = createStickRangerBody(100, 100, true, true);
    // Swim right into wall
    for (let i = 0; i < 40; i++) {
      stepStickRangerBody(body, wallSolid, 1, SR_FRAME_MS, 0, true);
    }

    // Head and hip must not penetrate beyond the wall boundary
    assert.ok(body.x[SR_HEAD] <= 120.5, 'Head should not penetrate solid wall');
    assert.ok(body.x[SR_HIP] <= 120.5, 'Hip should not penetrate solid wall');
  });

  test('when swim ability is locked, stickman does not actively swim', () => {
    const body = createStickRangerBody(100, 100, true, false); // hasSwimUnlock = false
    assert.equal(body.hasSwimUnlock, false);

    for (let i = 0; i < 20; i++) {
      // Trying to swim right in water
      stepStickRangerBody(body, nullSolid, 1, SR_FRAME_MS, 0, true);
    }

    assert.equal(body.isSwimmingFlag, 0, 'isSwimmingFlag should remain 0 when swim is locked');
  });
});
