/**
 * Stickman grapple hang — the figure goes limp, hangs by one hand, and swings
 * without losing energy.
 *
 * These assertions are about the three claims the mechanic makes: the rope is
 * actually held by a hand (not the hip), nothing animates while hanging, and a
 * swing released from a height comes back up to that height indefinitely.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createStickRangerBody,
  stepStickRangerBody,
  attachStickRangerGrapple,
  detachStickRangerGrapple,
  updateStickRangerGrapple,
  isStickRangerGrappleHanging,
  getStickRangerGrappleHandIndex,
  applyStickRangerImpulse,
  SR_FRAME_MS,
  SR_HIP,
  SR_HAND_L,
  SR_HAND_R,
  SR_POINT_COUNT,
  type StickRangerBody,
} from '../sim/clusters/stickRangerBody';

/** Runs `frames` fixed body frames worth of host time, in open air. */
function advance(body: StickRangerBody, frames: number): void {
  for (let i = 0; i < frames; i++) {
    stepStickRangerBody(body, null, 0, SR_FRAME_MS);
  }
}

/** Distance from the anchor to the hand currently holding the rope. */
function ropeDistance(body: StickRangerBody, anchorX: number, anchorY: number): number {
  const i = getStickRangerGrappleHandIndex(body);
  return Math.hypot(body.x[i] - anchorX, body.y[i] - anchorY);
}

/**
 * Hangs a fresh body from an anchor placed `up` above its hip and `across` to
 * one side, so the rope starts off-vertical and the body swings.
 */
function hangingBody(across: number, up: number): { body: StickRangerBody; anchorX: number; anchorY: number } {
  const body = createStickRangerBody(0, 0);
  const anchorX = across;
  const anchorY = -up;
  attachStickRangerGrapple(body, anchorX, anchorY, 20);
  return { body, anchorX, anchorY };
}

test('attaching grabs the rope with the hand nearer the anchor', () => {
  const right = createStickRangerBody(0, 0);
  attachStickRangerGrapple(right, 60, -40, 20);
  assert.equal(getStickRangerGrappleHandIndex(right), SR_HAND_R);

  const left = createStickRangerBody(0, 0);
  attachStickRangerGrapple(left, -60, -40, 20);
  assert.equal(getStickRangerGrappleHandIndex(left), SR_HAND_L);
});

test('the rope length adopted is the hand distance, not the hip distance', () => {
  const body = createStickRangerBody(0, 0);
  const anchorX = 40;
  const anchorY = -30;
  const adopted = attachStickRangerGrapple(body, anchorX, anchorY, 20);
  const handDistance = Math.hypot(body.x[SR_HAND_R] - anchorX, body.y[SR_HAND_R] - anchorY);
  assert.ok(Math.abs(adopted - handDistance) < 1e-4, `adopted ${adopted} vs hand ${handDistance}`);
});

test('the hand stays on the rope circle for the whole swing', () => {
  const { body, anchorX, anchorY } = hangingBody(45, 35);
  const rope = body.grappleLengthWorld;
  for (let i = 0; i < 600; i++) {
    advance(body, 1);
    // A rope pulls but never pushes, so the hand may come inside the circle;
    // what it must never do is stretch past it.
    assert.ok(
      ropeDistance(body, anchorX, anchorY) <= rope + 0.5,
      `frame ${i}: rope stretched to ${ropeDistance(body, anchorX, anchorY)} of ${rope}`,
    );
  }
});

test('the whole body hangs below the anchor, off the roped hand', () => {
  const { body, anchorY } = hangingBody(0, 40);
  // No claim is made about the figure's orientation: limp means limp, and a
  // body with no joint limits will throw its legs about as it swings. What must
  // hold is that every point stays under the anchor, held there by one hand.
  for (let i = 0; i < 300; i++) {
    advance(body, 1);
    for (let p = 0; p < SR_POINT_COUNT; p++) {
      assert.ok(body.y[p] > anchorY, `frame ${i}: point ${p} rose above the anchor`);
    }
  }
  const handIndex = getStickRangerGrappleHandIndex(body);
  assert.ok(handIndex === SR_HAND_L || handIndex === SR_HAND_R, 'still held by a hand');
  assert.ok(body.y[SR_HIP] > body.y[handIndex], 'the hip hangs below the roped hand');
});

test('the swing keeps coming back to its starting height', () => {
  const { body } = hangingBody(50, 30);
  const startHipY = body.y[SR_HIP];

  // Ten seconds of swinging at the body's own clock.
  const frames = Math.round(10_000 / SR_FRAME_MS);
  let highest = Number.POSITIVE_INFINITY; // smallest y = highest point
  for (let i = 0; i < frames; i++) {
    advance(body, 1);
    if (i > frames / 2 && body.y[SR_HIP] < highest) highest = body.y[SR_HIP];
  }

  // The peak reached during the *second half* of the run is still within a
  // world unit of where the swing started: no decay.
  assert.ok(
    highest <= startHipY + 1,
    `swing decayed: started at y=${startHipY}, later peak only reached y=${highest}`,
  );
});

test('a hanging figure is limp — no gait, no pose bias, no input response', () => {
  const { body } = hangingBody(0, 40);
  advance(body, 60);
  const walkCounterBefore = body.walkStepCounter;

  // Hold a direction for a second. `tickStickRangerPlayer` passes 0 while
  // hanging, but even if a direction reaches the body it must not steer.
  const steered = createStickRangerBody(0, 0);
  attachStickRangerGrapple(steered, 0, -40, 20);
  for (let i = 0; i < 60; i++) stepStickRangerBody(steered, null, 1, SR_FRAME_MS);

  assert.equal(walkCounterBefore, 0, 'the gait counter must not run while hanging');
  assert.equal(steered.walkStepCounter, 0, 'held input must not start a stride while hanging');
  assert.equal(steered.facingDirection, 1, 'steering must not touch the body while hanging');
});

test('detaching leaves the swing momentum on the body', () => {
  const { body } = hangingBody(50, 30);
  advance(body, 40);
  const velocityX = body.x[SR_HIP] - body.prevX[SR_HIP];
  assert.ok(Math.abs(velocityX) > 0.05, 'the swing should have built real horizontal speed');

  detachStickRangerGrapple(body);
  assert.equal(isStickRangerGrappleHanging(body), false);
  assert.equal(getStickRangerGrappleHandIndex(body), -1);

  advance(body, 1);
  const afterX = body.x[SR_HIP] - body.prevX[SR_HIP];
  assert.ok(
    Math.sign(afterX) === Math.sign(velocityX) && Math.abs(afterX) > Math.abs(velocityX) * 0.5,
    `release should carry the swing: ${velocityX} → ${afterX}`,
  );
});

test('a jump-off impulse moves every point upward at once', () => {
  const { body } = hangingBody(0, 40);
  advance(body, 30);
  const before = Array.from({ length: SR_POINT_COUNT }, (_, i) => body.y[i] - body.prevY[i]);
  applyStickRangerImpulse(body, 0, -200);
  const after = Array.from({ length: SR_POINT_COUNT }, (_, i) => body.y[i] - body.prevY[i]);
  for (let i = 0; i < SR_POINT_COUNT; i++) {
    assert.ok(after[i] < before[i], `point ${i} should have gained upward velocity`);
  }
});

test('reeling the rope in shortens it and pulls the hand along', () => {
  const { body, anchorX, anchorY } = hangingBody(0, 40);
  advance(body, 30);
  const shortened = body.grappleLengthWorld - 10;
  updateStickRangerGrapple(body, anchorX, anchorY, shortened);
  advance(body, 10);
  assert.ok(
    ropeDistance(body, anchorX, anchorY) <= shortened + 0.5,
    'the hand must follow the shortened rope inward',
  );
});
