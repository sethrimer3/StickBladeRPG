import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createStickRangerBody,
  stepStickRangerBody,
  requestStickRangerJump,
  getStickRangerRenderAlpha,
  getStickRangerRenderX,
  SR_FRAME_MS,
  SR_HIP,
  SR_HEAD,
  SR_FOOT_L,
  SR_FOOT_R,
  SR_POINT_COUNT,
  type StickRangerBody,
} from '../sim/clusters/stickRangerBody';
import type { SolidMask } from '../sim/pixelMaterials/pixelMaterialSolid';

/**
 * Minimal stand-in for `SolidMask` — a flat floor at `floorY` with open space
 * above it, so these tests exercise the body's own dynamics rather than the
 * pixel-material system's mask construction.
 */
function flatFloor(floorY: number): SolidMask {
  return {
    isSolid: (_x: number, y: number): boolean => y >= floorY,
  } as unknown as SolidMask;
}

/** A world with no geometry at all, for free-fall assertions. */
const EMPTY_WORLD = null;

/** Runs `frames` fixed body frames worth of host time. */
function advanceFrames(
  body: StickRangerBody,
  solid: SolidMask | null,
  moveDirection: number,
  frames: number,
): void {
  for (let i = 0; i < frames; i++) {
    stepStickRangerBody(body, solid, moveDirection, SR_FRAME_MS);
  }
}

test('body spawns in its constrained rest pose with the head above the feet', () => {
  const body = createStickRangerBody(100, 100);
  assert.equal(body.x.length, SR_POINT_COUNT);
  assert.equal(body.x[SR_HIP], 100);
  assert.equal(body.y[SR_HIP], 100);
  // Screen-space Y grows downward, so "above" means a smaller Y.
  assert.ok(body.y[SR_HEAD] < body.y[SR_HIP], 'head should start above the hip');
  assert.ok(body.y[SR_FOOT_L] > body.y[SR_HIP], 'feet should start below the hip');
});

test('body falls under gravity when there is nothing to stand on', () => {
  const body = createStickRangerBody(100, 100);
  const startY = body.y[SR_HIP];
  advanceFrames(body, EMPTY_WORLD, 0, 30);
  assert.ok(body.y[SR_HIP] > startY + 5, `expected the hip to fall, moved ${body.y[SR_HIP] - startY}`);
});

test('body comes to rest on a floor instead of sinking through it', () => {
  const floorY = 140;
  const body = createStickRangerBody(100, 100);
  advanceFrames(body, flatFloor(floorY), 0, 200);

  // Every point must be above the floor plane — nothing tunnels through.
  for (let i = 0; i < SR_POINT_COUNT; i++) {
    assert.ok(body.y[i] < floorY, `point ${i} sank to ${body.y[i]}, floor is ${floorY}`);
  }
  assert.equal(body.groundContactFlag, 1, 'a body resting on the floor should report ground contact');
});

test('ground contact keeps the gait window open; free fall lets it expire', () => {
  const grounded = createStickRangerBody(100, 100);
  advanceFrames(grounded, flatFloor(140), 0, 120);
  // Contact resets framesSinceGroundContact every frame it happens, so a
  // standing body stays inside the launch window that drives the walk cycle.
  assert.ok(
    grounded.framesSinceGroundContact <= 2,
    `grounded body should keep resetting its gait counter, got ${grounded.framesSinceGroundContact}`,
  );

  const falling = createStickRangerBody(100, 100);
  advanceFrames(falling, EMPTY_WORLD, 0, 40);
  assert.ok(
    falling.framesSinceGroundContact > 10,
    'a body with no contact should fall out of the launch window',
  );
});

test('holding a direction walks the body that way, and the two directions mirror', () => {
  const floor = flatFloor(140);

  const right = createStickRangerBody(100, 100);
  advanceFrames(right, floor, 0, 60);       // settle onto the floor first
  const rightStart = right.x[SR_HIP];
  advanceFrames(right, floor, 1, 120);
  const rightTravel = right.x[SR_HIP] - rightStart;

  const left = createStickRangerBody(100, 100);
  advanceFrames(left, floor, 0, 60);
  const leftStart = left.x[SR_HIP];
  advanceFrames(left, floor, -1, 120);
  const leftTravel = left.x[SR_HIP] - leftStart;

  assert.ok(rightTravel > 5, `holding right should move the body right, moved ${rightTravel}`);
  assert.ok(leftTravel < -5, `holding left should move the body left, moved ${leftTravel}`);
  assert.equal(right.facingDirection, 1);
  assert.equal(left.facingDirection, -1);
  // The gait is emergent, not keyframed, so the two directions need not be
  // bit-identical — but they should be close to mirror images.
  assert.ok(
    Math.abs(rightTravel + leftTravel) < Math.abs(rightTravel) * 0.5,
    `left/right travel should roughly mirror: right=${rightTravel}, left=${leftTravel}`,
  );
});

test('a walking body stays upright rather than collapsing', () => {
  const floor = flatFloor(140);
  const body = createStickRangerBody(100, 100);
  advanceFrames(body, floor, 0, 60);
  advanceFrames(body, floor, 1, 200);

  const feetY = (body.y[SR_FOOT_L] + body.y[SR_FOOT_R]) * 0.5;
  const standingHeight = feetY - body.y[SR_HEAD];
  // Rest lengths sum to 16.8 head-to-foot; a body that had folded up or come
  // apart would be far outside this band.
  assert.ok(
    standingHeight > 8 && standingHeight < 22,
    `walking body should stay roughly upright, head-to-foot height was ${standingHeight}`,
  );
});

test('body stands at very close to its full rest height', () => {
  const floorY = 140;
  // Spawn with the feet already on the floor, so this measures posture rather
  // than a landing.
  const body = createStickRangerBody(100, floorY - 9.6);
  advanceFrames(body, flatFloor(floorY), 0, 180);
  const height = (body.y[SR_FOOT_L] + body.y[SR_FOOT_R]) * 0.5 - body.y[SR_HEAD];
  // Rest lengths sum to 16.8 head-to-foot; the single soft constraint pass
  // settles just under that.
  assert.ok(height > 15.5, `standing height collapsed to ${height}`);
});

test('walking keeps the figure upright rather than folding it over', () => {
  const floorY = 140;
  const body = createStickRangerBody(100, floorY - 9.6);
  const floor = flatFloor(floorY);
  advanceFrames(body, floor, 0, 60);

  // The steering impulses must not pitch the torso far enough to fold the
  // spine. Driving the torso instead of the feet used to drop this to ~8.5.
  let minHeight = Infinity;
  for (let i = 0; i < 180; i++) {
    stepStickRangerBody(body, floor, 1, SR_FRAME_MS);
    const height = (body.y[SR_FOOT_L] + body.y[SR_FOOT_R]) * 0.5 - body.y[SR_HEAD];
    if (height < minHeight) minHeight = height;
  }
  assert.ok(minHeight > 13, `walking figure hunched to ${minHeight}`);
});

test('the gait stays below its tumble threshold', () => {
  const floorY = 140;
  const body = createStickRangerBody(100, floorY - 9.6);
  const floor = flatFloor(floorY);
  advanceFrames(body, floor, 0, 60);
  const startX = body.x[SR_HIP];
  advanceFrames(body, floor, 1, 180);
  const speed = (body.x[SR_HIP] - startX) / 6;

  // Past STEER_FOOT_PUSH ~0.6 the walk destabilises into a tumble, which
  // shows up as speed jumping by several times. Guard the tuned value.
  assert.ok(speed > 8, `walk speed collapsed to ${speed} world units/sec`);
  assert.ok(speed < 40, `walk speed ran away to ${speed} world units/sec — gait has tumbled`);
});

test('body recovers its posture after a hard landing', () => {
  const floorY = 140;
  // Dropped from ~30 world units up: it lands scrambled, then must re-erect.
  const body = createStickRangerBody(100, 100);
  advanceFrames(body, flatFloor(floorY), 0, 180);
  const height = (body.y[SR_FOOT_L] + body.y[SR_FOOT_R]) * 0.5 - body.y[SR_HEAD];
  assert.ok(height > 15, `body failed to stand back up after landing, height ${height}`);
});

test('a queued jump launches the body off the ground', () => {
  const floorY = 140;
  const floor = flatFloor(floorY);
  const body = createStickRangerBody(100, floorY - 9.6);
  advanceFrames(body, floor, 0, 60);
  const restingFeet = (body.y[SR_FOOT_L] + body.y[SR_FOOT_R]) * 0.5;

  requestStickRangerJump(body);
  let peakFeet = restingFeet;
  for (let i = 0; i < 120; i++) {
    stepStickRangerBody(body, floor, 0, SR_FRAME_MS);
    const feet = (body.y[SR_FOOT_L] + body.y[SR_FOOT_R]) * 0.5;
    if (feet < peakFeet) peakFeet = feet;
  }
  const apex = restingFeet - peakFeet;
  assert.ok(apex > 12, `jump barely left the ground: apex ${apex} world units`);
  assert.ok(apex < 60, `jump apex ran away to ${apex} world units`);
});

test('the whole body launches together instead of stretching apart', () => {
  const floorY = 140;
  const floor = flatFloor(floorY);
  const body = createStickRangerBody(100, floorY - 9.6);
  advanceFrames(body, floor, 0, 60);

  // The impulse goes to every point equally so the constraints have nothing
  // to resolve; a torso-only push would visibly stretch the figure.
  requestStickRangerJump(body);
  let minHeight = Infinity;
  for (let i = 0; i < 60; i++) {
    stepStickRangerBody(body, floor, 0, SR_FRAME_MS);
    if (body.groundContactFlag === 1) continue; // in-flight only
    const height = (body.y[SR_FOOT_L] + body.y[SR_FOOT_R]) * 0.5 - body.y[SR_HEAD];
    if (height < minHeight) minHeight = height;
  }
  assert.ok(minHeight > 14, `figure deformed in flight, height fell to ${minHeight}`);
});

test('landing is absorbed rather than crumpling the figure', () => {
  const floorY = 140;
  const floor = flatFloor(floorY);
  const body = createStickRangerBody(100, floorY - 9.6);
  advanceFrames(body, floor, 0, 60);

  requestStickRangerJump(body);
  let minHeight = Infinity;
  for (let i = 0; i < 140; i++) {
    stepStickRangerBody(body, floor, 0, SR_FRAME_MS);
    const height = (body.y[SR_FOOT_L] + body.y[SR_FOOT_R]) * 0.5 - body.y[SR_HEAD];
    if (height < minHeight) minHeight = height;
  }
  // Without LANDING_ABSORB this bottomed out at 6.2 of a 16.5 standing height.
  assert.ok(minHeight > 11, `landing crushed the figure to ${minHeight}`);
});

test('a mid-air jump is refused once coyote time has lapsed', () => {
  const body = createStickRangerBody(100, 100);
  advanceFrames(body, EMPTY_WORLD, 0, 30);   // well past JUMP_COYOTE_FRAMES
  const beforeY = body.y[SR_HIP];
  requestStickRangerJump(body);
  advanceFrames(body, EMPTY_WORLD, 0, 10);
  assert.ok(body.y[SR_HIP] > beforeY, 'body should still be falling, not double-jumping');
});

test('a jump queued just before landing still fires (jump buffer)', () => {
  const floorY = 140;
  const floor = flatFloor(floorY);
  const body = createStickRangerBody(100, floorY - 40);  // falling from height
  // Queue while still airborne and a few frames from touchdown.
  let framesToGround = 0;
  while (body.groundContactFlag === 0 && framesToGround < 200) {
    stepStickRangerBody(body, floor, 0, SR_FRAME_MS);
    framesToGround++;
  }
  assert.ok(framesToGround < 200, 'test setup: body never reached the floor');

  const restingFeet = (body.y[SR_FOOT_L] + body.y[SR_FOOT_R]) * 0.5;
  requestStickRangerJump(body);
  let peakFeet = restingFeet;
  for (let i = 0; i < 90; i++) {
    stepStickRangerBody(body, floor, 0, SR_FRAME_MS);
    const feet = (body.y[SR_FOOT_L] + body.y[SR_FOOT_R]) * 0.5;
    if (feet < peakFeet) peakFeet = feet;
  }
  assert.ok(restingFeet - peakFeet > 10, 'buffered jump was swallowed');
});

test('body never produces NaN, even when crushed between solids', () => {
  // Everything is solid: every point is in permanent contact from frame one.
  const allSolid = { isSolid: (): boolean => true } as unknown as SolidMask;
  const body = createStickRangerBody(100, 100);
  advanceFrames(body, allSolid, 1, 120);
  for (let i = 0; i < SR_POINT_COUNT; i++) {
    assert.ok(Number.isFinite(body.x[i]), `point ${i} x became ${body.x[i]}`);
    assert.ok(Number.isFinite(body.y[i]), `point ${i} y became ${body.y[i]}`);
  }
});

test('render interpolation is bounded and tracks the accumulator', () => {
  const body = createStickRangerBody(100, 100);
  // Half a body frame of host time: no frame steps, alpha lands mid-way.
  stepStickRangerBody(body, EMPTY_WORLD, 0, SR_FRAME_MS * 0.5);
  const alpha = getStickRangerRenderAlpha(body);
  assert.ok(alpha >= 0 && alpha <= 1, `alpha out of range: ${alpha}`);
  assert.ok(Math.abs(alpha - 0.5) < 1e-6, `expected alpha ~0.5, got ${alpha}`);

  // With no frame stepped yet, interpolation returns the spawn position.
  assert.ok(Number.isFinite(getStickRangerRenderX(body, SR_HIP, alpha)));
});

test('a long host stall does not spiral or teleport the body', () => {
  const floor = flatFloor(140);
  const body = createStickRangerBody(100, 100);
  advanceFrames(body, floor, 0, 60);
  const beforeX = body.x[SR_HIP];
  const beforeY = body.y[SR_HIP];

  // Ten seconds of missed host time arriving in one tick.
  stepStickRangerBody(body, floor, 0, 10_000);

  assert.ok(Number.isFinite(body.x[SR_HIP]) && Number.isFinite(body.y[SR_HIP]));
  assert.ok(
    Math.abs(body.x[SR_HIP] - beforeX) < 20 && Math.abs(body.y[SR_HIP] - beforeY) < 20,
    'a stalled frame should be dropped, not simulated as a huge jump',
  );
  assert.ok(body.accumulatorMs < SR_FRAME_MS, 'backlog should be cleared, not carried forward');
});
