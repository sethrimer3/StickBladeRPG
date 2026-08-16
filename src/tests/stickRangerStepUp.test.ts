import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createStickRangerBody,
  stepStickRangerBody,
  detectStickmanStepUp,
  SR_FRAME_MS,
  SR_HIP,
  SR_HEAD,
  SR_FOOT_L,
  SR_FOOT_R,
  SR_KNEE_L,
  SR_KNEE_R,
  type StickRangerBody,
} from '../sim/clusters/stickRangerBody';
import { SolidMask } from '../sim/pixelMaterials/pixelMaterialSolid';

/**
 * Creates a SolidMask with a base floor and an optional raised step/block.
 * Floor is solid from `baseFloorY` downward.
 * If `step` is provided: [stepX0, stepX1) is solid from `stepTopY` downward.
 */
function createSteppedSolidMask(
  widthPx: number,
  heightPx: number,
  baseFloorY: number,
  step?: { x0: number; x1: number; topY: number },
): SolidMask {
  const mask = new SolidMask(widthPx, heightPx);
  mask.markRect(0, baseFloorY, widthPx, heightPx);
  if (step) {
    mask.markRect(step.x0, step.topY, step.x1, heightPx);
  }
  return mask;
}

/** Advances the body by `frames` simulation steps. */
function advanceBodyFrames(
  body: StickRangerBody,
  solid: SolidMask | null,
  moveDirection: number,
  frames: number,
): void {
  for (let i = 0; i < frames; i++) {
    stepStickRangerBody(body, solid, moveDirection, SR_FRAME_MS);
  }
}

// ── Unit Tests: Step-Up Detection ──────────────────────────────────────────

test('detectStickmanStepUp detects a 1-block (8px) step-up ahead when moving right', () => {
  const floorY = 100;
  const stepTopY = 92; // 8px rise (1 block)
  const mask = createSteppedSolidMask(200, 150, floorY, { x0: 110, x1: 150, topY: stepTopY });
  const body = createStickRangerBody(106, floorY - 9.6);

  // Settle onto the floor
  advanceBodyFrames(body, mask, 0, 30);

  const stepUp = detectStickmanStepUp(body, mask, 1);
  assert.notEqual(stepUp, null, 'step-up should be detected for 8px rise');
  assert.equal(Math.round(stepUp!.rise), 8);
  assert.equal(stepUp!.targetFootY, stepTopY - 0.5);
  assert.ok(stepUp!.targetFootX >= 110);
});

test('detectStickmanStepUp detects a 1-block step-up ahead when moving left', () => {
  const floorY = 100;
  const stepTopY = 92; // 8px rise
  const mask = createSteppedSolidMask(200, 150, floorY, { x0: 50, x1: 90, topY: stepTopY });
  const body = createStickRangerBody(94, floorY - 9.6);

  advanceBodyFrames(body, mask, 0, 30);

  const stepUp = detectStickmanStepUp(body, mask, -1);
  assert.notEqual(stepUp, null, 'step-up should be detected when moving left');
  assert.equal(Math.round(stepUp!.rise), 8);
  assert.equal(stepUp!.targetFootY, stepTopY - 0.5);
  assert.ok(stepUp!.targetFootX <= 90);
});

test('detectStickmanStepUp detects small partial step-ups (2px, 4px, 6px)', () => {
  const floorY = 100;
  for (const rise of [2, 4, 6]) {
    const stepTopY = floorY - rise;
    const mask = createSteppedSolidMask(200, 150, floorY, { x0: 110, x1: 150, topY: stepTopY });
    const body = createStickRangerBody(106, floorY - 9.6);
    advanceBodyFrames(body, mask, 0, 30);

    const stepUp = detectStickmanStepUp(body, mask, 1);
    assert.notEqual(stepUp, null, `step-up should be detected for ${rise}px rise`);
    assert.equal(Math.round(stepUp!.rise), rise);
  }
});

test('detectStickmanStepUp rejects walls taller than 1 block (> 8px rise)', () => {
  const floorY = 100;
  const stepTopY = 84; // 16px rise (2 blocks)
  const mask = createSteppedSolidMask(200, 150, floorY, { x0: 110, x1: 150, topY: stepTopY });
  const body = createStickRangerBody(106, floorY - 9.6);
  advanceBodyFrames(body, mask, 0, 30);

  const stepUp = detectStickmanStepUp(body, mask, 1);
  assert.equal(stepUp, null, 'step-up must reject walls taller than 1 block');
});

test('detectStickmanStepUp returns null on a flat floor', () => {
  const floorY = 100;
  const mask = createSteppedSolidMask(200, 150, floorY);
  const body = createStickRangerBody(100, floorY - 9.6);
  advanceBodyFrames(body, mask, 0, 30);

  const stepUp = detectStickmanStepUp(body, mask, 1);
  assert.equal(stepUp, null, 'flat floor has no step-up');
});

test('detectStickmanStepUp returns null when moveDirection is 0 or facing away', () => {
  const floorY = 100;
  const mask = createSteppedSolidMask(200, 150, floorY, { x0: 110, x1: 150, topY: 92 });
  const body = createStickRangerBody(106, floorY - 9.6);
  advanceBodyFrames(body, mask, 0, 30);

  assert.equal(detectStickmanStepUp(body, mask, 0), null, 'no step-up with 0 direction');
  assert.equal(detectStickmanStepUp(body, mask, -1), null, 'no step-up when facing away from step');
});

test('detectStickmanStepUp rejects step when ceiling headroom is blocked', () => {
  const floorY = 100;
  const stepTopY = 92;
  const mask = createSteppedSolidMask(200, 150, floorY, { x0: 110, x1: 150, topY: stepTopY });
  // Add a low ceiling directly above the step (headroom blocked at stepTopY - 6)
  mask.markRect(110, 0, 150, stepTopY - 6);

  const body = createStickRangerBody(106, floorY - 9.6);
  advanceBodyFrames(body, mask, 0, 30);

  const stepUp = detectStickmanStepUp(body, mask, 1);
  assert.equal(stepUp, null, 'step-up must be rejected if headroom is blocked');
});

// ── Integration Tests: Locomotion and Stepping Over Obstacles ──────────────

test('stickman walks right and steps up onto a 1-block (8px) ledge', () => {
  const floorY = 100;
  const stepTopY = 92; // 8px rise (1 block)
  const mask = createSteppedSolidMask(300, 150, floorY, { x0: 108, x1: 200, topY: stepTopY });
  const body = createStickRangerBody(102, floorY - 9.6);

  // Settle onto the lower floor
  advanceBodyFrames(body, mask, 0, 30);
  assert.ok(body.y[SR_HIP] > 85, 'hip starts at lower level');

  // Walk right toward and onto the step over 220 frames
  advanceBodyFrames(body, mask, 1, 220);

  // Assert stickman crossed onto the step surface
  assert.ok(body.x[SR_HIP] > 112, `stickman should cross onto step (x > 112), got x=${body.x[SR_HIP]}`);
  // Assert stickman climbed up: hip should be near stepTopY - 9.6 = 82.4
  assert.ok(body.y[SR_HIP] <= stepTopY - 5, `stickman hip should climb onto step, got y=${body.y[SR_HIP]}`);
  const feetY = (body.y[SR_FOOT_L] + body.y[SR_FOOT_R]) * 0.5;
  assert.ok(feetY < floorY - 4, 'feet should be elevated onto the step');
});

test('stickman walks left and steps up onto a 1-block (8px) ledge', () => {
  const floorY = 100;
  const stepTopY = 92; // 8px rise
  const mask = createSteppedSolidMask(300, 150, floorY, { x0: 50, x1: 118, topY: stepTopY });
  const body = createStickRangerBody(124, floorY - 9.6);

  advanceBodyFrames(body, mask, 0, 30);
  assert.ok(body.y[SR_HIP] > 85);

  advanceBodyFrames(body, mask, -1, 220);

  assert.ok(body.x[SR_HIP] < 114, `stickman should cross left onto step (x < 114), got x=${body.x[SR_HIP]}`);
  assert.ok(body.y[SR_HIP] <= stepTopY - 5, `stickman hip should climb onto step, got y=${body.y[SR_HIP]}`);
  const feetY = (body.y[SR_FOOT_L] + body.y[SR_FOOT_R]) * 0.5;
  assert.ok(feetY < floorY - 4, 'feet should be elevated onto the step');
});

test('stickman walks up a multi-step staircase (4px risers)', () => {
  const widthPx = 300;
  const heightPx = 150;
  const mask = new SolidMask(widthPx, heightPx);

  // Build a 4-step staircase:
  // Step 0: floor at y = 100 from x = 0
  // Step 1: y = 96 from x = 80
  // Step 2: y = 92 from x = 100
  // Step 3: y = 88 from x = 120
  // Step 4: y = 84 from x = 140
  mask.markRect(0, 100, widthPx, heightPx);
  mask.markRect(80, 96, widthPx, heightPx);
  mask.markRect(100, 92, widthPx, heightPx);
  mask.markRect(120, 88, widthPx, heightPx);
  mask.markRect(140, 84, widthPx, heightPx);

  const body = createStickRangerBody(60, 100 - 9.6);
  advanceBodyFrames(body, mask, 0, 30);

  // Walk up all 4 steps
  advanceBodyFrames(body, mask, 1, 240);

  assert.ok(body.x[SR_HIP] > 145, `stickman should reach top of stairs (x > 145), got x=${body.x[SR_HIP]}`);
  assert.ok(body.y[SR_HIP] <= 84 - 5, `stickman should ascend to top step (y <= 79), got y=${body.y[SR_HIP]}`);
});

test('stickman walks up a continuous ramp slope', () => {
  const widthPx = 300;
  const heightPx = 150;
  const mask = new SolidMask(widthPx, heightPx);

  // Flat ground before ramp: y = 100
  mask.markRect(0, 100, widthPx, heightPx);
  // Ramp from x = 80 to x = 144 (slope: rises 1px every 2px)
  for (let x = 80; x <= 144; x++) {
    const risePx = Math.floor((x - 80) / 2);
    mask.markRect(x, 100 - risePx, widthPx, heightPx);
  }
  // High floor from x = 144 onwards: y = 68
  mask.markRect(144, 68, widthPx, heightPx);

  const body = createStickRangerBody(60, 100 - 9.6);
  advanceBodyFrames(body, mask, 0, 30);

  // Walk right up the ramp
  advanceBodyFrames(body, mask, 1, 260);

  assert.ok(body.x[SR_HIP] > 140, `stickman should climb ramp (x > 140), got x=${body.x[SR_HIP]}`);
  assert.ok(body.y[SR_HIP] < 80, `stickman should ascend ramp, got y=${body.y[SR_HIP]}`);
});

test('stickman stops against a 2-block (16px) tall wall and does not climb it', () => {
  const floorY = 100;
  const stepTopY = 84; // 16px rise (2 blocks)
  const mask = createSteppedSolidMask(300, 150, floorY, { x0: 110, x1: 200, topY: stepTopY });
  const body = createStickRangerBody(90, floorY - 9.6);

  advanceBodyFrames(body, mask, 0, 30);
  advanceBodyFrames(body, mask, 1, 150);

  // Stickman should be stopped at the wall (x <= 110) and remain on the lower floor
  assert.ok(body.x[SR_HIP] < 112, `stickman should stop at 16px wall, got x=${body.x[SR_HIP]}`);
  assert.ok(body.y[SR_HIP] > 85, `stickman should remain on lower floor, got y=${body.y[SR_HIP]}`);
});

test('stickman idle in front of a step does not step up without input', () => {
  const floorY = 100;
  const stepTopY = 92;
  const mask = createSteppedSolidMask(300, 150, floorY, { x0: 105, x1: 200, topY: stepTopY });
  const body = createStickRangerBody(95, floorY - 9.6);

  advanceBodyFrames(body, mask, 0, 100);

  // Should stay idle on the lower floor
  assert.ok(body.x[SR_HIP] < 100);
  assert.ok(body.y[SR_HIP] > 85);
});

test('stickman raises its leg and bends the knee when stepping up', () => {
  const floorY = 100;
  const stepTopY = 92; // 8px rise
  const mask = createSteppedSolidMask(300, 150, floorY, { x0: 105, x1: 200, topY: stepTopY });
  const body = createStickRangerBody(100, floorY - 9.6);

  advanceBodyFrames(body, mask, 0, 30);

  let legRaised = false;
  let kneeBent = false;

  for (let frame = 0; frame < 120; frame++) {
    stepStickRangerBody(body, mask, 1, SR_FRAME_MS);

    const activeFoot = body.swingFoot;
    const activeKnee = activeFoot === SR_FOOT_L ? SR_KNEE_L : SR_KNEE_R;

    // Check if the swing foot is lifted above the floor (higher than floorY - 3)
    if (body.y[activeFoot] < floorY - 3) {
      legRaised = true;
    }
    // Check if the knee is raised (higher than hip + 3)
    if (body.y[activeKnee] < body.y[SR_HIP] + 3) {
      kneeBent = true;
    }
  }

  assert.ok(legRaised, 'swing foot should be raised during step-up');
  assert.ok(kneeBent, 'swing knee should be bent/raised during step-up');
});

test('stickman maintains upright posture during and after stepping up', () => {
  const floorY = 100;
  const stepTopY = 92;
  const mask = createSteppedSolidMask(300, 150, floorY, { x0: 115, x1: 200, topY: stepTopY });
  const body = createStickRangerBody(95, floorY - 9.6);

  advanceBodyFrames(body, mask, 0, 30);

  const heights: number[] = [];
  for (let frame = 0; frame < 150; frame++) {
    stepStickRangerBody(body, mask, 1, SR_FRAME_MS);
    const feetY = (body.y[SR_FOOT_L] + body.y[SR_FOOT_R]) * 0.5;
    const height = feetY - body.y[SR_HEAD];
    heights.push(height);
  }

  const sorted = [...heights].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const minHeight = sorted[0];

  assert.ok(median > 13, `median height should stay upright, got ${median}`);
  assert.ok(minHeight > 9, `minimum height should not collapse, got ${minHeight}`);
});
