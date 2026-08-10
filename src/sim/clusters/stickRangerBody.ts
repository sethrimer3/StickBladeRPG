/**
 * Stick Ranger stickman — Verlet softbody player character.
 *
 * A direct transliteration of the character physics in Dan-Ball's Stick Ranger
 * (`Eg.prototype.move` / `Eg.prototype.qa` / `Eg.prototype.kb` in the original
 * source). The point of porting it faithfully rather than approximating it is
 * that Stick Ranger has *no animation system at all* — walking, jumping,
 * landing and stumbling are emergent consequences of three mechanisms, and
 * they only look right when all three are present together:
 *
 *   1. Gravity is a per-point, per-frame parameter, not a world constant.
 *      For the first `LAUNCH_FRAMES` frames after any ground contact the head
 *      and torso get *negative* gravity while the feet get 6x gravity. The
 *      distance constraints turn that vertical dipole into a lurch. That is
 *      the entire walk cycle — there is no gait, no stride phase, no foot IK.
 *
 *   2. Ground collision is *elastic*. Penetrating points reflect their normal
 *      velocity and keep half their tangential velocity. The ground gives
 *      energy back, and that returned energy is what propels the character.
 *      (An inelastic "snap to surface and zero the velocity" resolver — the
 *      usual platformer approach — makes 1. produce nothing at all.)
 *
 *   3. Impulses are expressed as bare position offsets. Verlet reads
 *      `position - previousPosition` as velocity, so nudging a point without
 *      touching its previous position *is* an impulse, and the constraint pass
 *      supplies the recovery motion for free. Steering (below) works this way.
 *
 * Constraints run in a SINGLE pass per frame with soft, deliberately
 * asymmetric weights. Iterating them to convergence would make the rig
 * effectively rigid and destroy the softbody behaviour.
 *
 * Units: Stick Ranger runs on a 512x384 field with 8px tiles; this project
 * uses 8-world-unit blocks and 1 world unit per native pixel, so the original
 * rest lengths and accelerations are used verbatim with no rescaling.
 *
 * Rate: Stick Ranger is a 30Hz game and its constants are tuned for that step
 * size, so the body is stepped on its own fixed 30Hz accumulator regardless of
 * the host tick rate, and `getStickRangerRenderAlpha` exposes the leftover
 * fraction so the renderer can interpolate to a smooth 60fps.
 */

import type { SolidMask } from '../pixelMaterials/pixelMaterialSolid';

/** Body point indices — same ordering as Stick Ranger's `this.a[player][i]`. */
export const SR_HEAD = 0;
export const SR_CHEST = 1;
export const SR_HIP = 2;
export const SR_SHOULDER_L = 3;
export const SR_SHOULDER_R = 4;
export const SR_HAND_L = 5;
export const SR_HAND_R = 6;
export const SR_KNEE_L = 7;
export const SR_KNEE_R = 8;
export const SR_FOOT_L = 9;
export const SR_FOOT_R = 10;
/** Number of simulated body points. */
export const SR_POINT_COUNT = 11;

/**
 * How much faster than Stick Ranger this body runs. **The one feel knob.**
 *
 * Implemented as a pure time scale: the body still steps a fixed number of
 * frames, each frame is still Stick Ranger's exact simulation with its exact
 * constants — the frames simply arrive `STICKMAN_TIME_SCALE` times more often.
 * Nothing about the dynamics is retuned, so the gait, the posture and the
 * landing behaviour are bit-for-bit the same motion, just played faster.
 *
 * That matters, and is why this is a time scale rather than bigger gravity and
 * bigger impulses. Multiplying the constants instead would change the shape of
 * the motion: the walk cycle's stability margin sits close to a cliff (see
 * STEER_FOOT_PUSH below), and scaling the pushes without scaling gravity in
 * exact lockstep walks straight into it.
 *
 * What the scale does and does not change:
 *   • Walk speed and fall speed scale with it.  (×S)
 *   • Airtime and every other duration shrink with it.  (÷S)
 *   • Jump apex, stride length, standing height are UNCHANGED — geometry is
 *     scale-invariant, because apex = v²/2g and both v and g move together.
 *
 * Reference points, measured on a flat floor:
 *
 *   scale   walk speed      jump airtime    jump apex
 *   1.0     16 units/sec    2.23 s          3.6 blocks   (exact Stick Ranger)
 *   2.5     40 units/sec    0.89 s          3.6 blocks   (current)
 *   4.0     64 units/sec    0.56 s          3.6 blocks   (matches this
 *                                                        project's own 0.57s
 *                                                        jump airtime)
 *
 * This project's own player runs at 105 units/sec, which no time scale reaches
 * at a sane airtime — the gait's stride length is what it is, and pushing
 * STEER_FOOT_PUSH harder to compensate hits the tumble cliff. Raising traversal
 * speed beyond ~64 needs a longer stride, not a faster clock.
 */
export const STICKMAN_TIME_SCALE = 2.5;

/**
 * Fixed simulation step, in milliseconds. Stick Ranger runs at 30fps; the time
 * scale above shortens the step rather than touching any physics constant.
 */
export const SR_FRAME_MS = 1000 / 30 / STICKMAN_TIME_SCALE;
/**
 * Never advance more than this much wall-clock time in one host tick (spiral
 * guard). Expressed in frames, so it scales with the step size and always
 * tolerates the same real-world backlog.
 */
const SR_MAX_FRAMES_PER_TICK = Math.ceil(4 * STICKMAN_TIME_SCALE);

// ── Stick Ranger constants, verbatim ────────────────────────────────────────

/** Baseline per-frame downward acceleration applied to every point. */
const GRAVITY = 0.05;
/** Per-frame velocity retention. */
const DAMPING = 0.99;
/**
 * Frames after a ground contact during which the "launch" gravity profile
 * below replaces the baseline. Ground contact resets the counter to 0, so a
 * walking character effectively never leaves this window.
 */
const LAUNCH_FRAMES = 10;
/**
 * Per-point gravity during the launch window. Negative values on the head and
 * hip lift the torso; the large positive values on the feet drive them down.
 * This array *is* the walk animation.
 */
const LAUNCH_GRAVITY = [
  -0.2,  // head      — lifts
  0.0,   // chest     — weightless
  -0.1,  // hip       — lifts slightly
  0.0,   // shoulderL
  0.0,   // shoulderR
  0.0,   // handL
  0.0,   // handR
  0.0,   // kneeL
  0.0,   // kneeR
  0.3,   // footL     — 6x baseline
  0.3,   // footR     — 6x baseline
];
/** Tangential velocity retained when a point strikes solid geometry. */
const SURFACE_TANGENT_RETENTION = 0.5;
/** Distance covered per collision substep, in world units. */
const COLLISION_SUBSTEP_DISTANCE = 4;

// ── Steering (this project's addition) ──────────────────────────────────────
//
// Stick Ranger's party has no directional input — it advances by bouncing
// rightward on its own. Arrow-key steering is layered on using mechanism 3
// above: bare position offsets, which Verlet reinterprets as impulses. No
// pose is authored; the legs swing and the torso leans purely as a
// consequence of these three numbers plus the constraints.
//
// Tuning notes, measured against a flat floor (see stickRangerBody.test.ts):
//
//   • The feet must carry most of the push. Driving the torso instead makes
//     the figure pitch forward and fold — head-to-foot height drops from its
//     16.5 standing value to ~11 at STEER_FOOT_PUSH 0.10 / HIP 0.30.
//   • There is a sharp stability cliff just above STEER_FOOT_PUSH 0.55: at
//     0.65 the gait tips into a tumble (the head passes below the feet) and
//     speed jumps from ~18 to ~66 world units/sec. Values here are set one
//     step below that edge, which is the natural top speed of this gait at
//     Stick Ranger's gravity constants.
//   • That top speed (~16 world units/sec) is deliberately Stick-Ranger-slow
//     and is about a sixth of this project's MAX_RUN_SPEED_WORLD_PER_SEC of
//     105. Making the stickman traverse rooms at StickBlade pace needs the
//     whole simulation scaled — GRAVITY and LAUNCH_GRAVITY together with
//     these — not a larger push here, which only tips it past the cliff.

// ── Jump ────────────────────────────────────────────────────────────────────
//
// Stick Ranger's party never jumps on command, so there is no original to port
// here — but the same mechanism does the work. A jump is one whole-body upward
// position offset, exactly like the scatter impulse Stick Ranger applies on
// death (`this.a[a][b].y += M(-1,-3)` across all 11 points). Verlet reads it as
// velocity on the next frame, and because every point gets the same offset the
// constraints have nothing to fight, so the figure launches intact instead of
// being stretched apart by a torso-only push.

/** Upward offset applied to every point on the frame a jump fires. */
const JUMP_IMPULSE = 1.85;
/**
 * Fraction of velocity each point keeps on the frame it lands after a real
 * fall. A DEPARTURE from Stick Ranger, which has no such rule.
 *
 * It is needed because Stick Ranger characters only ever fall a tile or two,
 * whereas this game's rooms let the stickman fall far enough that the torso's
 * downward momentum folds it onto the stopped feet: an unabsorbed landing
 * crushed head-to-foot height from 16.5 to 6.2 and took ~30 frames to stand
 * back up, i.e. a visible stumble after every jump.
 *
 * Applied only to points still moving downward, so it bleeds off impact
 * without touching the horizontal motion that carries a running jump.
 */
const LANDING_ABSORB = 0.15;
/** Airborne frames required before a touchdown counts as a real landing. */
const LANDING_ABSORB_MIN_AIR_FRAMES = 8;
/**
 * Frames after leaving the ground during which a jump is still allowed
 * (coyote time). `framesSinceGroundContact` already tracks this for the gait.
 */
const JUMP_COYOTE_FRAMES = 4;
/**
 * Frames a queued jump survives while airborne, so a press slightly before
 * landing still fires on touchdown instead of being swallowed.
 */
const JUMP_BUFFER_FRAMES = 6;

/** Horizontal impulse applied to the hip while a direction is held. */
const STEER_HIP_PUSH = 0.10;
/** Horizontal impulse applied to the chest — smallest, so the torso only leans. */
const STEER_CHEST_PUSH = 0.04;
/** Horizontal impulse applied to each foot. The legs do the walking. */
const STEER_FOOT_PUSH = 0.50;

/** Rest lengths and solver weights, from Stick Ranger's `Eg.prototype.qa`. */
const CONSTRAINTS: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [SR_HEAD, SR_CHEST, 3.6, 0.5, 0.5],
  [SR_CHEST, SR_HIP, 3.6, 0.5, 0.5],
  // Direct spine constraint: keeps the head and hip from collapsing onto each other.
  [SR_HEAD, SR_HIP, 7.2, 0.4, 0.4],
  [SR_CHEST, SR_SHOULDER_L, 4.8, 0.5, 0.5],
  [SR_CHEST, SR_SHOULDER_R, 4.8, 0.5, 0.5],
  [SR_SHOULDER_L, SR_HAND_L, 4.8, 0.5, 0.5],
  [SR_SHOULDER_R, SR_HAND_R, 4.8, 0.5, 0.5],
  [SR_HIP, SR_KNEE_L, 4.8, 0.5, 0.5],
  [SR_HIP, SR_KNEE_R, 4.8, 0.5, 0.5],
  [SR_KNEE_L, SR_FOOT_L, 4.8, 0.5, 0.5],
  [SR_KNEE_R, SR_FOOT_R, 4.8, 0.5, 0.5],
  // Knee spreader: very loose (0.1) so the legs splay rather than lock.
  [SR_KNEE_L, SR_KNEE_R, 6.0, 0.1, 0.1],
];

/**
 * Spawn offsets from the hip, chosen so the body starts in its constrained
 * rest shape and the first frame does not snap.
 */
const SPAWN_OFFSET_X = [0, 0, 0, -4.8, 4.8, -4.8, 4.8, -3, 3, -3, 3];
const SPAWN_OFFSET_Y = [-7.2, -3.6, 0, -3.6, -3.6, 1.2, 1.2, 4.8, 4.8, 9.6, 9.6];

/** Verlet particle set plus the bookkeeping the gait schedule needs. */
export interface StickRangerBody {
  /** Current point positions, world units. */
  readonly x: Float32Array;
  readonly y: Float32Array;
  /** Previous-frame positions; `current - previous` is the Verlet velocity. */
  readonly prevX: Float32Array;
  readonly prevY: Float32Array;
  /** Positions at the start of the last completed frame, for render interpolation. */
  readonly renderPrevX: Float32Array;
  readonly renderPrevY: Float32Array;
  /**
   * Frames elapsed since the last ground contact. Reset to 0 on contact; while
   * below LAUNCH_FRAMES the launch gravity profile is used.
   */
  framesSinceGroundContact: number;
  /** 1 when any point touched solid geometry during the last frame. */
  groundContactFlag: 0 | 1;
  /** Leftover host time not yet consumed by a fixed body frame, milliseconds. */
  accumulatorMs: number;
  /**
   * Frames a pending jump request has left before it expires. Set by
   * `requestStickRangerJump`; a jump can be asked for on a host tick that
   * advances no body frame, so the request is latched here rather than acted
   * on immediately.
   */
  jumpBufferFrames: number;
  /** 1 for the single frame a jump actually fires — for SFX and effects. */
  jumpFiredFlag: 0 | 1;
  /** Facing, for renderers that need it: -1 left, 1 right. */
  facingDirection: -1 | 1;
}

/** Allocates a body with its hip at (hipX, hipY), in its rest pose. */
export function createStickRangerBody(hipX: number, hipY: number): StickRangerBody {
  const body: StickRangerBody = {
    x: new Float32Array(SR_POINT_COUNT),
    y: new Float32Array(SR_POINT_COUNT),
    prevX: new Float32Array(SR_POINT_COUNT),
    prevY: new Float32Array(SR_POINT_COUNT),
    renderPrevX: new Float32Array(SR_POINT_COUNT),
    renderPrevY: new Float32Array(SR_POINT_COUNT),
    framesSinceGroundContact: 0,
    groundContactFlag: 0,
    accumulatorMs: 0,
    jumpBufferFrames: 0,
    jumpFiredFlag: 0,
    facingDirection: 1,
  };
  resetStickRangerBody(body, hipX, hipY);
  return body;
}

/**
 * Teleports the body to a new hip position in its rest pose, clearing all
 * velocity. Used on spawn, room transition and respawn.
 */
export function resetStickRangerBody(body: StickRangerBody, hipX: number, hipY: number): void {
  for (let i = 0; i < SR_POINT_COUNT; i++) {
    const px = hipX + SPAWN_OFFSET_X[i];
    const py = hipY + SPAWN_OFFSET_Y[i];
    body.x[i] = px;
    body.y[i] = py;
    body.prevX[i] = px;
    body.prevY[i] = py;
    body.renderPrevX[i] = px;
    body.renderPrevY[i] = py;
  }
  body.framesSinceGroundContact = 0;
  body.groundContactFlag = 0;
  body.accumulatorMs = 0;
  body.jumpBufferFrames = 0;
  body.jumpFiredFlag = 0;
}

/**
 * Queues a jump. Fires on the next body frame where the figure is on (or has
 * just left) the ground, and expires after `JUMP_BUFFER_FRAMES` otherwise.
 * Safe to call every host tick the key is held — a queued jump is not
 * re-armed until it has fired or lapsed.
 */
export function requestStickRangerJump(body: StickRangerBody): void {
  body.jumpBufferFrames = JUMP_BUFFER_FRAMES;
}

/**
 * Verlet integration for one point — Stick Ranger's `X(a, b, c, d)`.
 * Gravity and damping are arguments, not constants, because varying them
 * per point per frame is how the character animates.
 */
function integratePoint(body: StickRangerBody, i: number, gravity: number, damping: number): void {
  let vx = body.x[i] - body.prevX[i];
  let vy = body.y[i] - body.prevY[i];
  body.prevX[i] = body.x[i];
  body.prevY[i] = body.y[i];
  vy += gravity;
  vx *= damping;
  vy *= damping;
  body.x[i] += vx;
  body.y[i] += vy;
}

/**
 * Position-based distance constraint — Stick Ranger's `$(a, b, c, d, e)`.
 * `weightA`/`weightB` are independent, so a constraint can be made one-way
 * (weight 0 on the end that must not be pulled) or deliberately mushy.
 */
function constrain(
  body: StickRangerBody,
  ia: number,
  ib: number,
  restLength: number,
  weightA: number,
  weightB: number,
): void {
  let dx = body.x[ia] - body.x[ib];
  let dy = body.y[ia] - body.y[ib];
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length === 0) return;
  dx /= length;
  dy /= length;
  const error = restLength - length;
  body.x[ia] += dx * error * weightA;
  body.y[ia] += dy * error * weightA;
  body.x[ib] -= dx * error * weightB;
  body.y[ib] -= dy * error * weightB;
}

/**
 * Swept, axis-separated, *elastic* collision for one point — Stick Ranger's
 * `Eg.prototype.kb`.
 *
 * `integratePoint` has already advanced the position; this recomputes that
 * displacement, rewinds the point, and re-walks it in substeps so it cannot
 * tunnel. On contact the normal component is reflected and the tangential
 * component keeps `SURFACE_TANGENT_RETENTION` of its magnitude. Because
 * `prev` stays at the pre-move position, the reflection is picked up as real
 * velocity on the next frame — that is what makes the character bounce along
 * rather than stick.
 *
 * Returns true if the point struck geometry.
 */
function collidePoint(body: StickRangerBody, i: number, solid: SolidMask | null): boolean {
  let dx = body.x[i] - body.prevX[i];
  let dy = body.y[i] - body.prevY[i];
  // Rewind: prev holds the pre-integration position, and this pass owns the move.
  body.x[i] = body.prevX[i];
  body.y[i] = body.prevY[i];

  const distance = Math.sqrt(dx * dx + dy * dy);
  const substeps = Math.floor(distance / COLLISION_SUBSTEP_DISTANCE) + 1;
  dx /= substeps;
  dy /= substeps;

  let hit = false;
  for (let s = 0; s < substeps; s++) {
    // Y axis first, then X, each resolved against the other's current value.
    const nextY = body.y[i] + dy;
    if (isSolidAt(solid, body.x[i], nextY)) {
      dx *= SURFACE_TANGENT_RETENTION;
      dy = -dy;
      hit = true;
    } else {
      body.y[i] = nextY;
    }

    const nextX = body.x[i] + dx;
    if (isSolidAt(solid, nextX, body.y[i])) {
      dy *= SURFACE_TANGENT_RETENTION;
      dx = -dx;
      hit = true;
    } else {
      body.x[i] = nextX;
    }
  }
  return hit;
}

/**
 * Point-vs-world solidity test. `SolidMask` reports out-of-bounds as solid, so
 * room edges act as walls exactly the way Stick Ranger's clamped tile lookup
 * did. With no mask loaded the body falls freely, which is the correct
 * behaviour for an empty preview world.
 */
function isSolidAt(solid: SolidMask | null, x: number, y: number): boolean {
  if (solid === null) return false;
  return solid.isSolid(Math.floor(x), Math.floor(y));
}

/**
 * Advances the body by exactly one fixed 30Hz frame.
 *
 * `moveDirection` is -1, 0 or 1 from the left/right keys.
 */
function stepBodyFrame(body: StickRangerBody, solid: SolidMask | null, moveDirection: number): void {
  body.framesSinceGroundContact += 1;
  body.jumpFiredFlag = 0;

  // ── 0. Jump ─────────────────────────────────────────────────────────────
  // Fires before integration so the impulse is part of this frame's motion.
  // Applied to every point equally: the constraints then have nothing to
  // resolve and the figure leaves the ground in its current pose.
  if (body.jumpBufferFrames > 0) {
    body.jumpBufferFrames -= 1;
    if (body.framesSinceGroundContact <= JUMP_COYOTE_FRAMES) {
      for (let i = 0; i < SR_POINT_COUNT; i++) {
        body.y[i] -= JUMP_IMPULSE;
      }
      body.jumpBufferFrames = 0;
      body.jumpFiredFlag = 1;
      // Push the gait counter past the launch window so the feet stop being
      // driven down into the ground mid-takeoff, which otherwise cancels
      // most of the impulse on the very next frame.
      body.framesSinceGroundContact = LAUNCH_FRAMES;
    }
  }

  // ── 1. Integrate, with the gait's per-point gravity profile ──────────────
  const inLaunchWindow = body.framesSinceGroundContact < LAUNCH_FRAMES;
  for (let i = 0; i < SR_POINT_COUNT; i++) {
    integratePoint(body, i, inLaunchWindow ? LAUNCH_GRAVITY[i] : GRAVITY, DAMPING);
  }

  // ── 2. Steering impulses ────────────────────────────────────────────────
  // Bare position offsets: `prev` is deliberately left alone so Verlet reads
  // these as velocity on the next frame. Applied only during the launch
  // window, so the character can push off the ground but cannot free-fly.
  if (moveDirection !== 0 && inLaunchWindow) {
    body.x[SR_HIP] += moveDirection * STEER_HIP_PUSH;
    body.x[SR_CHEST] += moveDirection * STEER_CHEST_PUSH;
    body.x[SR_FOOT_L] += moveDirection * STEER_FOOT_PUSH;
    body.x[SR_FOOT_R] += moveDirection * STEER_FOOT_PUSH;
    body.facingDirection = moveDirection < 0 ? -1 : 1;
  }

  // ── 3. Constraints — TWO passes, soft weights ───────────────────────────
  for (let pass = 0; pass < 2; pass++) {
    for (let c = 0; c < CONSTRAINTS.length; c++) {
      const [ia, ib, rest, wa, wb] = CONSTRAINTS[c];
      constrain(body, ia, ib, rest, wa, wb);
    }
  }

  // ── 4. Elastic collision ────────────────────────────────────────────────
  let contact = false;
  for (let i = 0; i < SR_POINT_COUNT; i++) {
    if (collidePoint(body, i, solid)) contact = true;
  }

  // ── 5. Ground contact resets the gait window ────────────────────────────
  const wasAirborne = body.framesSinceGroundContact;
  body.groundContactFlag = contact ? 1 : 0;
  if (contact) {
    // Absorb a real landing (see LANDING_ABSORB). Verlet velocity is
    // `current - previous`, so moving `previous` toward `current` scales the
    // velocity down without moving the point itself.
    if (wasAirborne >= LANDING_ABSORB_MIN_AIR_FRAMES) {
      for (let i = 0; i < SR_POINT_COUNT; i++) {
        const vy = body.y[i] - body.prevY[i];
        if (vy > 0) body.prevY[i] = body.y[i] - vy * LANDING_ABSORB;
      }
    }
    body.framesSinceGroundContact = 0;
  }
}

/**
 * Host-tick entry point. Consumes `dtMs` into whole 30Hz body frames and
 * leaves the remainder in the accumulator for render interpolation.
 */
export function stepStickRangerBody(
  body: StickRangerBody,
  solid: SolidMask | null,
  moveDirection: number,
  dtMs: number,
): void {
  body.accumulatorMs += dtMs;
  let frames = 0;
  while (body.accumulatorMs >= SR_FRAME_MS && frames < SR_MAX_FRAMES_PER_TICK) {
    // Snapshot before the frame so the renderer can interpolate across it.
    body.renderPrevX.set(body.x);
    body.renderPrevY.set(body.y);
    stepBodyFrame(body, solid, moveDirection);
    body.accumulatorMs -= SR_FRAME_MS;
    frames += 1;
  }
  if (body.accumulatorMs >= SR_FRAME_MS) {
    // Fell too far behind (tab restore, breakpoint) — drop the backlog rather
    // than spiralling; the body simply resumes from where it is.
    body.accumulatorMs = 0;
  }
}

/** Interpolation factor in [0,1] between `renderPrev*` and the current pose. */
export function getStickRangerRenderAlpha(body: StickRangerBody): number {
  const alpha = body.accumulatorMs / SR_FRAME_MS;
  return alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
}

/** Interpolated render X for point `i`. */
export function getStickRangerRenderX(body: StickRangerBody, i: number, alpha: number): number {
  return body.renderPrevX[i] + (body.x[i] - body.renderPrevX[i]) * alpha;
}

/** Interpolated render Y for point `i`. */
export function getStickRangerRenderY(body: StickRangerBody, i: number, alpha: number): number {
  return body.renderPrevY[i] + (body.y[i] - body.renderPrevY[i]) * alpha;
}
