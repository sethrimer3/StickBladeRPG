import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createStickRangerBody,
  stepStickRangerBody,
  requestStickRangerJump,
  canStickmanJump,
  canFootJump,
  getStickRangerRenderAlpha,
  getStickRangerRenderX,
  SR_FRAME_MS,
  STICKMAN_TIME_SCALE,
  STICKMAN_MAX_STEER_SPEED_PX_PER_SEC,
  STICKMAN_WALK_STEP_FRAMES,
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

/** Wall-clock seconds that `frames` body frames represent, at any time scale. */
function framesToSeconds(frames: number): number {
  return (frames * SR_FRAME_MS) / 1000;
}

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
  const WALK_FRAMES = 180;
  advanceFrames(body, floor, 1, WALK_FRAMES);
  const speed = (body.x[SR_HIP] - startX) / framesToSeconds(WALK_FRAMES);

  // Past STEER_FOOT_PUSH ~0.6 the walk destabilises into a tumble, which
  // shows up as speed jumping by several times. Bounds are expressed against
  // STICKMAN_TIME_SCALE so retuning the feel knob doesn't invalidate them:
  // walking is ~16 world units/sec per unit of scale.
  const perScale = speed / STICKMAN_TIME_SCALE;
  assert.ok(perScale > 8, `walk speed collapsed to ${perScale} units/sec per unit scale`);
  assert.ok(perScale < 40, `walk ran away to ${perScale} units/sec per unit scale — gait has tumbled`);
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

test('hip velocity stays stable when the host clock does not divide the body clock', () => {
  // The body runs on its own fixed clock, so a host tick may advance zero body
  // frames or two. Reading velocity by differencing position across a host tick
  // aliases badly against that beat; reading the hip's Verlet velocity does not.
  // stickRangerPlayer mirrors the latter onto the cluster — this guards it.
  const floorY = 140;
  const floor = flatFloor(floorY);
  const body = createStickRangerBody(100, floorY - 9.6);
  advanceFrames(body, floor, 0, 200);

  const perSecond = 1000 / SR_FRAME_MS;
  const hostTickMs = 1000 / 60;
  const samples: number[] = [];
  for (let t = 0; t < 120; t++) {
    stepStickRangerBody(body, floor, 1, hostTickMs);
    samples.push((body.x[SR_HIP] - body.prevX[SR_HIP]) * perSecond);
  }

  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const peak = Math.max(...samples.map(Math.abs));
  // Walking is ~16 world units/sec per unit of time scale.
  const expected = 16 * STICKMAN_TIME_SCALE;
  assert.ok(
    Math.abs(mean - expected) < expected * 0.35,
    `mean reported velocity ${mean} is far from the true walk speed ~${expected}`,
  );
  // Per-tick differencing peaked at 2.7x the true speed here; Verlet velocity
  // should stay within a modest factor accounted for by the gait's own bob.
  assert.ok(peak < expected * 1.8, `velocity spiked to ${peak}, expected under ${expected * 1.8}`);
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

test('walking alternates foot impulses across step intervals', () => {
  const floor = flatFloor(140);
  const body = createStickRangerBody(100, 130);
  advanceFrames(body, floor, 0, 30); // settle

  assert.equal(body.walkStepCounter, 0);
  advanceFrames(body, floor, 1, 1);
  assert.equal(body.walkStepCounter, 1, 'walkStepCounter increments when walking');

  // Step for STICKMAN_WALK_STEP_FRAMES and verify counter advances and body travels right
  advanceFrames(body, floor, 1, STICKMAN_WALK_STEP_FRAMES * 2);
  assert.equal(body.walkStepCounter, 1 + STICKMAN_WALK_STEP_FRAMES * 2);

  // Stopping resets the walk counter
  advanceFrames(body, floor, 0, 1);
  assert.equal(body.walkStepCounter, 0, 'releasing move input resets walkStepCounter');
});

test('lateral steering force does not accelerate foot beyond 100 px/s cap', () => {
  const floor = flatFloor(140);
  const body = createStickRangerBody(100, 130);
  advanceFrames(body, floor, 0, 30);

  // Artificially propel active foot (SR_FOOT_L) to >100 px/s in the rightward direction (+1)
  const fps = 1000 / SR_FRAME_MS;
  // Setting prevX so current velocity is 120 px/s rightward
  body.prevX[SR_FOOT_L] = body.x[SR_FOOT_L] - (120 / fps);

  // Advance 1 frame with rightward input (+1)
  advanceFrames(body, floor, 1, 1);

  // Because initial foot speed was 120 px/s >= 100 px/s, no extra steering push was added to foot
  assert.ok(
    Number.isFinite(body.x[SR_FOOT_L]),
    'foot position should remain finite',
  );
  assert.ok(
    STICKMAN_MAX_STEER_SPEED_PX_PER_SEC === 100,
    'STICKMAN_MAX_STEER_SPEED_PX_PER_SEC should be 100',
  );
});

test('joints never clip upward through a solid ceiling block when jumping', () => {
  // A solid ceiling from y <= 100 and a floor at y >= 140
  const ceilingY = 100;
  const floorY = 140;
  const corridor = {
    isSolid: (_x: number, y: number): boolean => y <= ceilingY || y >= floorY,
  } as unknown as SolidMask;

  const body = createStickRangerBody(100, floorY - 9.6);
  advanceFrames(body, corridor, 0, 30); // settle on floor

  // Jump up into the ceiling
  requestStickRangerJump(body);
  for (let f = 0; f < 60; f++) {
    stepStickRangerBody(body, corridor, 0, SR_FRAME_MS);
    // Every single joint must strictly remain >= ceilingY (never penetrating into y <= ceilingY)
    for (let i = 0; i < SR_POINT_COUNT; i++) {
      assert.ok(
        body.y[i] >= ceilingY,
        `joint ${i} clipped upward through ceiling: y=${body.y[i]} < ceilingY=${ceilingY}`,
      );
    }
  }
});

test('foot ground check requires foot to be in 2-pixel space above surface and not inside a block', () => {
  const floorY = 140;
  const floor = flatFloor(floorY);
  const body = createStickRangerBody(100, 100);

  // 1. In mid-air (y = 100, floor = 140): feet are ~109.6, gap is ~30px > 2px -> cannot jump
  assert.equal(canFootJump(body, SR_FOOT_L, floor), false, 'airborne foot cannot jump');
  assert.equal(canFootJump(body, SR_FOOT_R, floor), false, 'airborne foot cannot jump');
  assert.equal(canStickmanJump(body, floor), false, 'airborne stickman cannot jump');

  // 2. Exactly 1 pixel above surface: foot at y = 139 on floor at 140 -> can jump
  body.x[SR_FOOT_L] = 100;
  body.y[SR_FOOT_L] = 139;
  assert.equal(canFootJump(body, SR_FOOT_L, floor), true, 'foot 1px above surface can jump');
  assert.equal(canStickmanJump(body, floor), true, 'stickman with 1 foot grounded can jump');

  // 3. Exactly 2 pixels above surface: foot at y = 138 on floor at 140 -> can jump
  body.y[SR_FOOT_L] = 138;
  assert.equal(canFootJump(body, SR_FOOT_L, floor), true, 'foot 2px above surface can jump');

  // 4. 2.5 pixels above surface: foot at y = 137.5 on floor at 140 -> cannot jump
  body.y[SR_FOOT_L] = 137.5;
  assert.equal(canFootJump(body, SR_FOOT_L, floor), false, 'foot >2px above surface cannot jump');

  // 5. Inside a block: foot at y = 140.5 inside floor at 140 -> cannot jump ("Inside a block does not count")
  body.y[SR_FOOT_L] = 140.5;
  assert.equal(canFootJump(body, SR_FOOT_L, floor), false, 'foot inside block cannot jump');

  // 6. Empty world (null solid mask) -> cannot jump
  assert.equal(canStickmanJump(body, null), false, 'null solid mask cannot jump');
});

test('stickman cannot jump up vertical walls in mid-air', () => {
  // A vertical wall on the left (x <= 50) and open air everywhere else
  const wallX = 50;
  const verticalWall = {
    isSolid: (x: number, _y: number): boolean => x <= wallX,
  } as unknown as SolidMask;

  // Spawn the stickman in mid-air right next to the vertical wall
  const body = createStickRangerBody(wallX + 4.8, 100);
  advanceFrames(body, verticalWall, -1, 10); // push left against the vertical wall

  // Verify body is touching/pressing the wall
  assert.ok(body.x[SR_HIP] <= wallX + 8, 'body should be near the wall');

  // Ground check must report FALSE because there is no floor underneath the feet
  assert.equal(canStickmanJump(body, verticalWall), false, 'stickman touching vertical wall cannot jump');

  // Requesting jumps while pressing against the wall should not produce upward launches
  const startHipY = body.y[SR_HIP];
  for (let f = 0; f < 30; f++) {
    requestStickRangerJump(body);
    stepStickRangerBody(body, verticalWall, -1, SR_FRAME_MS);
  }

  // Hip should have fallen under gravity, not climbed the wall
  assert.ok(
    body.y[SR_HIP] > startHipY,
    `stickman climbed wall: hipY was ${startHipY}, became ${body.y[SR_HIP]}`,
  );
});

test('repeated jump spam under a thin 8-pixel ceiling never tunnels limbs upward', () => {
  // Thin ceiling between y = 92 and y = 100 (8 pixels thick), floor at y = 140
  const thinCeiling = {
    isSolid: (_x: number, y: number): boolean => (y >= 92 && y <= 100) || y >= 140,
  } as unknown as SolidMask;

  const body = createStickRangerBody(100, 140 - 9.6);
  advanceFrames(body, thinCeiling, 0, 30); // settle on floor

  // Repeatedly spam jump requests every single frame for 200 frames
  for (let f = 0; f < 200; f++) {
    requestStickRangerJump(body);
    stepStickRangerBody(body, thinCeiling, 0, SR_FRAME_MS);

    // Every joint must strictly stay in the room (y >= 100), never penetrating y in [92, 100] or tunneling above 92
    for (let i = 0; i < SR_POINT_COUNT; i++) {
      assert.ok(
        body.y[i] >= 100,
        `frame ${f}: joint ${i} tunneled into or above thin ceiling: y=${body.y[i]} < 100`,
      );
    }
  }
});

