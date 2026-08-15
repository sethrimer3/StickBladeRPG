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
/**
 * Tangential velocity retained when a point strikes solid geometry — i.e. the
 * inverse of ground friction. Stick Ranger's value, used whenever no direction
 * is held: the feet grip, and a figure that stops, stops.
 */
const SURFACE_TANGENT_RETENTION = 0.5;
/**
 * Tangential retention while a direction IS held.
 *
 * At the standing value the walk had to drag its feet across a surface that was
 * eating half their sideways speed on every contact, which reads as the feet
 * sticking. Holding a direction is the player saying "slide"; letting go says
 * "grip". Applied to the whole body rather than just the feet, since the same
 * contact resolver handles every point and a hand brushing a wall should not
 * grip differently from a foot.
 */
const SURFACE_TANGENT_RETENTION_MOVING = 0.6;

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
//   • Exactly one foot is driven at a time — the trailing one — and it keeps
//     the push until it is STICKMAN_STRIDE_LEAD_DISTANCE ahead of the planted
//     foot. That handoff rule is the walk cycle's visible shape.
//   • What used to be documented here as "a sharp stability cliff just above
//     STEER_FOOT_PUSH 0.55" was the knee spreader, not the push. Stick Ranger's
//     two-way knee spring held the legs in a permanent 5.5-unit straddle and
//     hauled them back together whenever a stride opened them, so a harder push
//     buckled the figure instead of lengthening the step. That constraint is now
//     one-way (KNEE_SPREAD_MIN) and the cliff is gone: the stride went from 2.8
//     units to 7, and the walk from 28 to 54 world units/sec.
//   • The earlier note that this gait tops out near Stick Ranger's ~16
//     units/sec, and that reaching StickBlade pace would need the whole
//     simulation rescaled, was wrong for the same reason. 54 is roughly half of
//     this project's MAX_RUN_SPEED_WORLD_PER_SEC of 105, at Stick Ranger's
//     gravity constants and with no rescaling at all.

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
 * Frames a queued jump survives while airborne, so a press slightly before
 * landing still fires on touchdown instead of being swallowed.
 */
const JUMP_BUFFER_FRAMES = 6;

/** Maximum lateral speed in pixels per second above which lateral steering force is suppressed until speed dips below 100 px/s. */
export const STICKMAN_MAX_STEER_SPEED_PX_PER_SEC = 100;
/**
 * How far, in world units, the swinging foot must get ahead of the planted one
 * (measured along the direction being held) before the other leg takes over.
 *
 * This is what makes the gait read as *walking* rather than as both legs
 * shuffling together: exactly one foot is ever driven, and it keeps being
 * driven until it has actually completed a stride.
 *
 * Was 3 while the knee spreader was still a two-way spring, because a longer
 * target was unreachable anyway — the spring hauled the knees back together and
 * the stride topped out at 2.8 units. With the spreader one-way (see
 * KNEE_SPREAD_MIN) the legs can pass each other, and 6 buys a 7-unit stride.
 */
export const STICKMAN_STRIDE_LEAD_DISTANCE = 6;
/**
 * Hard cap on how long one leg may stay the swing leg. Without it a foot that
 * cannot get ahead — jammed against a step, wedged in a corner — would be
 * driven forever while the other leg never moves.
 */
export const STICKMAN_MAX_SWING_FRAMES = 20;

/** Horizontal impulse applied to the hip while a direction is held. */
const STEER_HIP_PUSH = 0.11;
/** Horizontal impulse applied to the chest — smallest, so the torso only leans. */
const STEER_CHEST_PUSH = 0.04;
/**
 * Horizontal impulse applied to the swing foot. The legs do the walking.
 *
 * The old "sharp stability cliff just above 0.55" was not a property of the
 * push at all — it was the knee spreader (see KNEE_SPREAD_MIN). A two-way
 * spring holding the knees 6 units apart cannot be pushed through without the
 * figure buckling, so harder pushes tumbled it instead of lengthening the step.
 * With the spreader one-way, 0.65 and 0.8 are both stable; the walk is no
 * longer pushing against its own standing pose.
 *
 * 0.5 with a stride lead of 6 gives 54 units/sec and a 7-unit stride at a
 * head-to-foot height of 13.9. Harder is available and still stable — 0.6
 * reaches 63 — but costs posture (11.8 at 0.6/7), and this is the best speed
 * available while the figure still walks upright.
 */
const STEER_FOOT_PUSH = 0.5;

// ── Airborne pose bias (this project's addition) ────────────────────────────
//
// Left to itself the rig has no idea which way is up once it leaves the
// ground — the launch-gravity dipole only shapes the body while it is in
// contact, so a jump preserves whatever tangle the takeoff left behind. The
// bias below nudges the airborne figure toward the N+/Stick-Ranger jump pose:
// torso upright, both legs beneath it, the trailing leg reaching back and
// straight, the leading leg tucked up and bent.
//
// It is a BIAS, not a pose. Each rule is a fractional pull of a point toward a
// target position, applied before the constraint pass so the solver still has
// the final say. Nothing is clamped or snapped: a hard collision, a knockback
// or a ragdoll overwhelms it, which is the point.
//
// Unlike steering, the pose deliberately does NOT use mechanism 3. It carries
// `prev` along with each point and then cancels its own net translation, so it
// changes the figure's shape without adding momentum or thrust — see
// `biasPointToward` and `cancelNetTranslation` for what went wrong when it did
// both of those things.

/**
 * Fraction of the remaining error each airborne bias closes per frame.
 * Deliberately small — at 0.5 the figure snaps to a fixed pose and stops
 * reading as physics; at 0.05 the tangle from takeoff survives the whole jump.
 */
const AIR_POSE_BIAS = 0.26;
/** Bias strength for keeping the spine vertical (head/chest over the hip). */
const AIR_UPRIGHT_BIAS = 0.28;
/** Airborne frames before the pose bias reaches full strength, so takeoff is not stiff. */
const AIR_POSE_RAMP_FRAMES = 8;
/** Horizontal reach of the trailing (extended) foot behind the hip, world units. */
const AIR_TRAIL_FOOT_BEHIND = 5.0;
/** How far below the hip the trailing foot is targeted — near full leg extension (9.6 rest). */
const AIR_TRAIL_FOOT_BELOW = 8.4;
/** Horizontal reach of the leading (tucked) foot ahead of the hip. */
const AIR_LEAD_FOOT_AHEAD = 2.6;
/** How far below the hip the leading foot is targeted — tucked up, so a bent knee. */
const AIR_LEAD_FOOT_BELOW = 5.0;
/** Leading knee target, lifted and forward of the hip: the raised bent knee. */
const AIR_LEAD_KNEE_AHEAD = 4.2;
const AIR_LEAD_KNEE_BELOW = 2.2;
/** Trailing knee target, behind and low: the straight reaching leg. */
const AIR_TRAIL_KNEE_BEHIND = 2.6;
const AIR_TRAIL_KNEE_BELOW = 4.6;
/**
 * Downward hip speed at which the tucked leading leg has fully extended again.
 *
 * The N+ pose is a *rising* pose. Holding the tuck all the way down means
 * landing on a folded leg, which crumples the figure on touchdown (head-to-foot
 * height bottomed out at 4.3 of a 16.5 standing height with the tuck held). So
 * the leading leg reaches back down as the descent builds, and the figure meets
 * the ground on two legs. The fore/aft split is kept the whole way.
 */
const AIR_DESCENT_EXTEND_SPEED = 1.4;
/** Cap on the forward lag compensation applied to the pose anchor, world units. */
const AIR_POSE_LAG_LIMIT = 3;

// ── Standing settle (this project's addition) ───────────────────────────────
//
// A gait that ends wherever the last stride left it looks like a figure that
// stopped mid-step, because that is what it is. With no input held the feet are
// drawn slowly back under the hip into a stance: both legs near full extension,
// a small symmetric gap, knees barely bent.
//
// Uses the same momentum- and translation-neutral machinery as the airborne
// pose (`biasPointToward` + `cancelNetTranslation`), so settling never nudges
// the figure sideways — it would otherwise creep along the floor while idle.

/**
 * Fraction of the remaining error the standing settle closes per frame.
 *
 * Much weaker than the airborne pose: this one has a full second of contact to
 * work with and should be invisible as an animation. At 0.05 the stance is
 * reached in roughly 25 frames (a third of a second at the current time scale),
 * which reads as the figure gathering itself rather than snapping to an idle.
 */
const STAND_POSE_BIAS = 0.05;

// ── Weapon carry pose ───────────────────────────────────────────────────────
//
// Left to itself the rig lets both hands hang at the hips, which is where the
// donor wanted them — Stick Ranger's figures do not hold anything. A wielded
// weapon reads as dropped from that pose, because the hand it is drawn from is
// behind the body as often as in front of it. These pull the holding hand (or
// both hands, on a two-hander) forward into a carry.
//
// A bias rather than a constraint: the arm springs and the gait still own the
// hand, this only leans on it. Walk cycles, knockback, and collisions all still
// move the arm, and the weapon moves with it.

/**
 * Shoulder-to-hand rest length. Must match the arm entries in `CONSTRAINTS` —
 * a carry target further out than the arm is simply overruled by the constraint
 * two lines later, which is what makes the bias look like it does nothing.
 */
const CARRY_ARM_LENGTH = 4.8;
/**
 * Angle below horizontal, radians, that a carrying arm wants to hold.
 *
 * The target is placed on the arm's own reach circle rather than at an absolute
 * point in front of the hip, because the shoulders sit ±4.8 either side of the
 * hip: the trailing shoulder physically cannot put its hand in front of the
 * body, so an absolute target would be dragged back every frame. Forward of its
 * own shoulder is the reachable version of the same intent, and it still puts
 * the two-handed grip — the midpoint of the hands — well in front of the hip.
 *
 * Just past 60° down reads as a relaxed carry; nearer horizontal reads as
 * presenting the weapon, which belongs to an attack rather than to standing.
 */
const CARRY_ARM_ANGLE_RAD = 1.05;
/**
 * Angular split between the two hands of a two-handed grip, radians.
 *
 * Both hands hold one haft, so they belong close together — but exactly
 * together draws both forearms as a single line. Splitting the arm angles reads
 * as two hands spaced along a grip.
 */
const CARRY_TWO_HAND_SPLIT_RAD = 0.22;
/**
 * Strength of the carry pull.
 *
 * Between the standing settle (0.05, meant to be invisible) and the airborne
 * pose: the hand should visibly favour the front without the arm feeling
 * pinned there. At 0.09 a hand crosses from behind the body to the carry in
 * roughly fifteen frames, which reads as the arm swinging forward rather than
 * teleporting.
 */
const CARRY_POSE_BIAS = 0.09;
/** Half the standing foot gap — each foot is targeted this far to its own side. */
const STAND_FOOT_SPREAD = 1.4;
/** Standing foot depth below the hip — near the 9.6 full leg extension. */
const STAND_FOOT_BELOW = 9.2;
/** Standing knee offsets: barely bent, tracking just inside the feet. */
const STAND_KNEE_SPREAD = 1.2;
const STAND_KNEE_BELOW = 4.7;
/**
 * Hip speed, world units per frame, above which the settle is suppressed.
 *
 * Without this the stance fights knockback and momentum: the player is sliding
 * with no key held, which is exactly when the legs should be trailing, not
 * tidying themselves up.
 */
const STAND_SETTLE_MAX_SPEED = 0.35;

// ── Ragdoll ─────────────────────────────────────────────────────────────────
//
// The unbiased body — pure Stick Ranger, tumbling however the collisions take
// it — is worth keeping for the moments it reads as a reaction rather than as
// a loss of animation. While `ragdollFrames` is counting down the airborne
// pose bias is skipped entirely and the figure is left to flail.

/** Ragdoll duration for a hard landing or a heavy hit, in body frames. */
export const STICKMAN_RAGDOLL_FRAMES = 45;
/**
 * Downward hip speed, in world units per frame, above which a touchdown counts
 * as a hard landing and knocks the pose bias out.
 *
 * Measured on a flat floor: an ordinary jump lands at 1.3, a 5-block drop at
 * 1.5, a 10-block drop at 1.9, and terminal velocity is about 2.8. 2.1 puts the
 * cutoff at roughly a 12-block fall — a drop the player has to go looking for.
 */
const RAGDOLL_LANDING_SPEED = 2.1;

// ── Grapple hang (this project's addition) ──────────────────────────────────
//
// While the grapple is attached the figure is *pinned by one hand and nothing
// else*. Every animation input — the walk's launch-gravity dipole, steering,
// the standing settle, the airborne jump pose — is switched off, so what is
// left is eleven points falling under plain gravity with one of them held on a
// circle around the anchor. That is the whole mechanic: the limp body is not a
// pose, it is the absence of every pose, and the swing is not scripted, it is
// the rope constraint doing what a rope does.
//
// Two departures from the rest of the body are needed to make the swing keep
// going the way the request asks:
//
//   • Damping is 1.0 rather than DAMPING. Stick Ranger's 0.99 is a per-frame
//     1 % velocity bleed, which at 75 frames/sec drains a pendulum to a stop in
//     a couple of seconds.
//   • The frame's mechanical energy is measured before and restored after the
//     constraint solve (see `restoreGrappleEnergy`). Position-based constraints
//     are not energy-preserving — every rope correction and every soft limb
//     constraint quietly removes a little — and without the restore the swing
//     still decays, just more slowly than damping alone would take it.
//
// The restore is skipped on any frame where something real changed the energy:
// a wall contact, a rope-length change from retraction, or an external impulse.

/** Per-frame velocity retention while hanging: none, so the swing never decays. */
const GRAPPLE_HANG_DAMPING = 1.0;
/**
 * Bounds on the per-frame energy-restore rescale. A correction outside this
 * range means something other than solver drift moved the body (a collision the
 * contact flag missed, a teleport), and forcing the old energy back onto it
 * would be a fabricated impulse rather than a repair.
 */
const GRAPPLE_ENERGY_RESCALE_MIN = 0.5;
const GRAPPLE_ENERGY_RESCALE_MAX = 2.0;
/** Solver passes used to pull the hand back onto the rope circle each frame. */
const GRAPPLE_ROPE_PASSES = 2;

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
];

/**
 * Minimum knee separation, enforced one-way: the knees are pushed apart when
 * they are closer than this and left alone when they are further.
 *
 * Stick Ranger had this as an ordinary two-way spring at rest length 6.0, which
 * works there because its party never walks on command — the spring is what
 * props a passive figure into a standing A-frame. Here it was a stride limiter.
 * Measured while walking, the knee gap moved only between 4.1 and 6.2: the
 * spring hauled the knees back together the moment a stride opened them, so the
 * legs could never pass each other and the whole step happened below the knee.
 * That is the "fighting the walk" the standing pose was doing.
 *
 * One-way keeps the half that earns its place (legs cannot merge into one line)
 * and drops the half that fought the gait.
 *
 * Note that the spawn offsets still start the knees 6 apart rather than at this
 * minimum. Narrowing them to match measured worse — the walk hunched to 12.1
 * from 13.9 — so the body is left to settle into its own standing width (about
 * 2.2) over the first frames instead.
 */
const KNEE_SPREAD_MIN = 2.4;
/** Solver weight for the knee spreader — very loose, so legs splay rather than lock. */
const KNEE_SPREAD_WEIGHT = 0.1;

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
  /** Frames the current walk has been held; 0 while no direction is pressed. */
  walkStepCounter: number;
  /** Point index of the foot currently being driven — SR_FOOT_L or SR_FOOT_R. */
  swingFoot: number;
  /** Frames the current swing foot has been the driven one. */
  swingFrames: number;
  /**
   * Frames of ragdoll left. While > 0 the airborne pose bias is skipped and the
   * body tumbles on raw Stick Ranger physics. Set by a hard landing or by
   * `triggerStickRangerRagdoll` (heavy damage).
   */
  ragdollFrames: number;
  /**
   * 1 while that hand is holding a weapon, which pulls it forward into a carry
   * (see `applyWeaponCarryBias`). Both are set for a two-handed weapon, one for
   * a one-handed weapon, neither when unarmed.
   *
   * Set every tick by whoever owns the wielder's equipment — for the player
   * that is `sim/weapons/playerWeaponState.ts`. Plain flags rather than a grip
   * enum so this module keeps no dependency on the weapon system, which already
   * depends on it.
   */
  carryHandLeftFlag: 0 | 1;
  carryHandRightFlag: 0 | 1;
  /** 1 while the figure hangs from a grapple rope by one hand. */
  grappleHangFlag: 0 | 1;
  /** Point index of the hand holding the rope — SR_HAND_L or SR_HAND_R. */
  grappleHandIndex: number;
  /** Rope anchor, world units. Refreshed every host tick from the world state. */
  grappleAnchorXWorld: number;
  grappleAnchorYWorld: number;
  /** Current rope length, world units. */
  grappleLengthWorld: number;
  /**
   * Mechanical energy (per unit mass, per-frame units) the hang is holding on
   * to. Recomputed on attach and after any frame whose energy change was real;
   * used to undo the constraint solver's numerical bleed on every other frame.
   */
  grappleEnergy: number;
  /**
   * 1 when something legitimately changed the body's energy this frame — a
   * rope-length change or an external impulse — so the restore must re-baseline
   * instead of undoing it.
   */
  grappleEnergyDirtyFlag: 0 | 1;
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
    walkStepCounter: 0,
    swingFoot: SR_FOOT_L,
    swingFrames: 0,
    ragdollFrames: 0,
    carryHandLeftFlag: 0,
    carryHandRightFlag: 0,
    grappleHangFlag: 0,
    grappleHandIndex: SR_HAND_R,
    grappleAnchorXWorld: 0,
    grappleAnchorYWorld: 0,
    grappleLengthWorld: 0,
    grappleEnergy: 0,
    grappleEnergyDirtyFlag: 0,
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
  body.walkStepCounter = 0;
  body.swingFoot = SR_FOOT_L;
  body.swingFrames = 0;
  body.ragdollFrames = 0;
  detachStickRangerGrapple(body);
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
 * Drops the airborne pose bias for `frames` body frames, leaving the figure to
 * tumble on raw physics. Called for a heavy hit (see `stickRangerPlayer.ts`);
 * hard landings arm it from inside the step. Extends rather than shortens an
 * ongoing ragdoll, so a second hit mid-flail cannot cut the reaction short.
 */
export function triggerStickRangerRagdoll(body: StickRangerBody, frames = STICKMAN_RAGDOLL_FRAMES): void {
  if (frames > body.ragdollFrames) body.ragdollFrames = frames;
}

/** True while the figure is tumbling on raw physics with the pose bias off. */
export function isStickRangerRagdolling(body: StickRangerBody): boolean {
  return body.ragdollFrames > 0;
}

// ── Grapple hang API ────────────────────────────────────────────────────────

/**
 * Total mechanical energy per unit mass, in the body's own per-frame units.
 *
 * Verlet velocity is `current - previous`, and gravity is an acceleration in
 * units per frame squared, so kinetic and potential terms are directly
 * comparable without any rate conversion. Y grows downward, hence the sign on
 * the potential term.
 */
function computeBodyEnergy(body: StickRangerBody): number {
  let kinetic = 0;
  let potential = 0;
  for (let i = 0; i < SR_POINT_COUNT; i++) {
    const vx = body.x[i] - body.prevX[i];
    const vy = body.y[i] - body.prevY[i];
    kinetic += 0.5 * (vx * vx + vy * vy);
    potential -= GRAVITY * body.y[i];
  }
  return kinetic + potential;
}

/**
 * Rescales every point's velocity so the body's mechanical energy returns to
 * `body.grappleEnergy`, undoing what the constraint solve bled off.
 *
 * Scaling velocity means moving `prev`, never `x` — the shape the solver just
 * produced is correct and must not be disturbed; only how fast the body is
 * travelling through it is being repaired.
 */
function restoreGrappleEnergy(body: StickRangerBody): void {
  let kinetic = 0;
  let potential = 0;
  for (let i = 0; i < SR_POINT_COUNT; i++) {
    const vx = body.x[i] - body.prevX[i];
    const vy = body.y[i] - body.prevY[i];
    kinetic += 0.5 * (vx * vx + vy * vy);
    potential -= GRAVITY * body.y[i];
  }
  const targetKinetic = body.grappleEnergy - potential;
  // A negative target means the body is higher than its energy allows — it has
  // been dragged there by the rope or a wall, not by its own momentum. Nothing
  // to restore, and re-baselining keeps the next frame honest.
  if (targetKinetic <= 0 || kinetic <= 1e-9) {
    body.grappleEnergy = kinetic + potential;
    return;
  }
  const scale = Math.sqrt(targetKinetic / kinetic);
  if (scale < GRAPPLE_ENERGY_RESCALE_MIN || scale > GRAPPLE_ENERGY_RESCALE_MAX) {
    body.grappleEnergy = kinetic + potential;
    return;
  }
  for (let i = 0; i < SR_POINT_COUNT; i++) {
    body.prevX[i] = body.x[i] - (body.x[i] - body.prevX[i]) * scale;
    body.prevY[i] = body.y[i] - (body.y[i] - body.prevY[i]) * scale;
  }
}

/** Pulls the roped hand back onto the rope circle. A rope pulls, never pushes. */
function applyRopeConstraint(body: StickRangerBody): void {
  const i = body.grappleHandIndex;
  const dx = body.x[i] - body.grappleAnchorXWorld;
  const dy = body.y[i] - body.grappleAnchorYWorld;
  const distance = Math.sqrt(dx * dx + dy * dy);
  if (distance <= body.grappleLengthWorld || distance < 1e-6) return;
  const scale = body.grappleLengthWorld / distance;
  body.x[i] = body.grappleAnchorXWorld + dx * scale;
  body.y[i] = body.grappleAnchorYWorld + dy * scale;
}

/**
 * Grabs the rope with whichever hand is already nearer the anchor, and hands
 * the body over to the hang. Returns the rope length that was adopted, which is
 * the hand's current distance from the anchor — the caller's length is measured
 * from the hip, and starting taut from the wrong point would snap the figure.
 *
 * The energy baseline is taken here, so the swing conserves what the player
 * arrived with rather than some canonical value.
 */
export function attachStickRangerGrapple(
  body: StickRangerBody,
  anchorXWorld: number,
  anchorYWorld: number,
  minLengthWorld: number,
): number {
  const dxL = body.x[SR_HAND_L] - anchorXWorld;
  const dyL = body.y[SR_HAND_L] - anchorYWorld;
  const dxR = body.x[SR_HAND_R] - anchorXWorld;
  const dyR = body.y[SR_HAND_R] - anchorYWorld;
  const distanceL = Math.sqrt(dxL * dxL + dyL * dyL);
  const distanceR = Math.sqrt(dxR * dxR + dyR * dyR);
  const useLeft = distanceL <= distanceR;

  body.grappleHandIndex = useLeft ? SR_HAND_L : SR_HAND_R;
  body.grappleAnchorXWorld = anchorXWorld;
  body.grappleAnchorYWorld = anchorYWorld;
  body.grappleLengthWorld = Math.max(minLengthWorld, useLeft ? distanceL : distanceR);
  body.grappleHangFlag = 1;
  body.grappleEnergyDirtyFlag = 0;
  // A hang is not a landing and not a tumble: clear both so neither the pose
  // bias nor the ragdoll countdown outlives the attach.
  body.ragdollFrames = 0;
  body.walkStepCounter = 0;
  body.swingFrames = 0;
  body.grappleEnergy = computeBodyEnergy(body);
  return body.grappleLengthWorld;
}

/**
 * Refreshes the anchor and rope length from the world's grapple state. Called
 * every host tick because the anchor can move (carry blocks, rope wrapping) and
 * the length changes while the player retracts.
 *
 * A length change is real work on the system, so it marks the energy baseline
 * dirty rather than being undone by the restore.
 */
export function updateStickRangerGrapple(
  body: StickRangerBody,
  anchorXWorld: number,
  anchorYWorld: number,
  lengthWorld: number,
): void {
  if (body.grappleHangFlag === 0) return;
  if (
    anchorXWorld !== body.grappleAnchorXWorld ||
    anchorYWorld !== body.grappleAnchorYWorld ||
    lengthWorld !== body.grappleLengthWorld
  ) {
    body.grappleEnergyDirtyFlag = 1;
  }
  body.grappleAnchorXWorld = anchorXWorld;
  body.grappleAnchorYWorld = anchorYWorld;
  body.grappleLengthWorld = lengthWorld;
}

/** Lets go of the rope. The body keeps whatever velocity the swing gave it. */
export function detachStickRangerGrapple(body: StickRangerBody): void {
  const wasHanging = body.grappleHangFlag === 1;
  body.grappleHangFlag = 0;
  body.grappleEnergyDirtyFlag = 0;
  body.grappleEnergy = 0;
  // A released swing is a launch, not a landing: start the airborne pose bias's
  // clock past the launch window so the figure is not driving its feet into
  // nothing on the way out. Only when there was a swing to release — a plain
  // reset must leave the gait window where it found it.
  if (wasHanging) body.framesSinceGroundContact = LAUNCH_FRAMES;
}

/**
 * Translates the whole body so that `pointIndex` lands on (targetX, targetY),
 * carrying `prev` along so no velocity is created or destroyed.
 *
 * Used when a system outside the softbody owns the player's position for a
 * while — the grapple zip is the one that does — so the figure rides along
 * intact instead of being left behind by the cluster box.
 */
export function teleportStickRangerBody(
  body: StickRangerBody,
  pointIndex: number,
  targetX: number,
  targetY: number,
): void {
  const dx = targetX - body.x[pointIndex];
  const dy = targetY - body.y[pointIndex];
  if (dx === 0 && dy === 0) return;
  for (let i = 0; i < SR_POINT_COUNT; i++) {
    body.x[i] += dx;
    body.y[i] += dy;
    body.prevX[i] += dx;
    body.prevY[i] += dy;
    body.renderPrevX[i] += dx;
    body.renderPrevY[i] += dy;
  }
  body.grappleEnergyDirtyFlag = 1;
}

/** True while the figure is hanging from a grapple rope. */
export function isStickRangerGrappleHanging(body: StickRangerBody): boolean {
  return body.grappleHangFlag === 1;
}

/**
 * Point index of the hand on the rope, or -1 when not hanging. The rope's
 * visible end is drawn here rather than at the cluster centre, which is the
 * difference between a figure hanging by its hand and one with a rope growing
 * out of its ribs.
 */
export function getStickRangerGrappleHandIndex(body: StickRangerBody): number {
  return body.grappleHangFlag === 1 ? body.grappleHandIndex : -1;
}

/**
 * Applies a whole-body velocity impulse, in world units per second, using the
 * same mechanism as the jump: shifting `prev` rather than `x`, so no point
 * teleports and the constraints have nothing to fight.
 *
 * Used by the grapple's jump-off, which has to express itself on the softbody
 * rather than on the derived cluster box.
 */
export function applyStickRangerImpulse(
  body: StickRangerBody,
  velocityXWorldPerSec: number,
  velocityYWorldPerSec: number,
): void {
  const perFrameX = velocityXWorldPerSec * SR_FRAME_MS / 1000;
  const perFrameY = velocityYWorldPerSec * SR_FRAME_MS / 1000;
  for (let i = 0; i < SR_POINT_COUNT; i++) {
    body.prevX[i] -= perFrameX;
    body.prevY[i] -= perFrameY;
  }
  body.grappleEnergyDirtyFlag = 1;
}

/**
 * Nudges `index` a fraction of the way toward (targetX, targetY), carrying
 * `prev` along with it so the move adds no velocity.
 *
 * This is the one place that deliberately does NOT use mechanism 3. A bare
 * offset here would be read as an impulse, and a pose held for a whole jump is
 * dozens of them in the same direction: the figure accumulated real momentum
 * from its own animation, landed leaning, and slowly toppled (head-to-foot
 * height decayed to 3.2 over the second after touchdown). Moving position and
 * previous together reshapes the pose while leaving the trajectory alone —
 * which is what "a bias, not a force" has to mean for a Verlet rig.
 */
function biasPointToward(
  body: StickRangerBody,
  index: number,
  targetX: number,
  targetY: number,
  strength: number,
  applied: { x: number; y: number },
): void {
  const dx = (targetX - body.x[index]) * strength;
  const dy = (targetY - body.y[index]) * strength;
  body.x[index] += dx;
  body.y[index] += dy;
  body.prevX[index] += dx;
  body.prevY[index] += dy;
  applied.x += dx;
  applied.y += dy;
}

/**
 * Cancels the net translation a set of pose offsets would impart, by shifting
 * every point back by the average of what was applied.
 *
 * An animation is supposed to be internal — a change of shape, not a shove.
 * Without this the pose is a slow thruster: shaping the legs forward each frame
 * makes the constraints answer by pushing the torso the other way, and a bot
 * jumping repeatedly across a flat floor walked *backwards* 8 units instead of
 * forwards. Removing the mean leaves the body's centre exactly where the
 * trajectory put it, and only the shape changes.
 */
function cancelNetTranslation(body: StickRangerBody, applied: { x: number; y: number }): void {
  const dx = applied.x / SR_POINT_COUNT;
  const dy = applied.y / SR_POINT_COUNT;
  for (let i = 0; i < SR_POINT_COUNT; i++) {
    body.x[i] -= dx;
    body.y[i] -= dy;
    body.prevX[i] -= dx;
    body.prevY[i] -= dy;
  }
}

/**
 * Biases the airborne figure toward the running-jump pose: upright torso, legs
 * beneath the hip, trailing leg extended back, leading leg raised and bent.
 *
 * `poseDirection` is the direction the pose faces — the held input while there
 * is one, otherwise the last facing, so letting go mid-jump does not flip the
 * legs. Everything here is relative to the hip, so the bias follows the body
 * wherever the jump carries it and never fights the trajectory.
 */
function applyAirbornePoseBias(body: StickRangerBody, poseDirection: number, ramp: number): void {
  const hipY = body.y[SR_HIP];
  const applied = { x: 0, y: 0 };
  const strength = AIR_POSE_BIAS * ramp;

  // Anchor the pose slightly ahead of the hip, by exactly the amount a
  // first-order pull lags a moving target (v(1-s)/s for pull strength s).
  // Without it the whole pose trails the running hip — at 30 units/sec the lag
  // was 1.5 units, enough to leave the "leading" foot level with the hip
  // instead of in front of it. Capped so the ramp-in frames, where `strength`
  // is small, cannot throw the anchor across the room.
  const hipVelX = body.x[SR_HIP] - body.prevX[SR_HIP];
  const lag = hipVelX * (1 - strength) / Math.max(strength, 0.02);
  const hipX = body.x[SR_HIP] + Math.max(-AIR_POSE_LAG_LIMIT, Math.min(AIR_POSE_LAG_LIMIT, lag));

  // Upright: pull the spine toward vertical above the hip. Only the horizontal
  // component is biased — the vertical spacing is the constraints' business, and
  // pulling on it too would fight gravity and float the figure.
  const uprightStrength = AIR_UPRIGHT_BIAS * ramp;
  biasPointToward(body, SR_HEAD, hipX, body.y[SR_HEAD], uprightStrength, applied);
  biasPointToward(body, SR_CHEST, hipX, body.y[SR_CHEST], uprightStrength, applied);

  // Legs: the trailing leg is the one behind the direction of travel.
  const leftIsTrailing = (body.x[SR_FOOT_L] - body.x[SR_FOOT_R]) * poseDirection < 0;
  const trailKnee = leftIsTrailing ? SR_KNEE_L : SR_KNEE_R;
  const trailFoot = leftIsTrailing ? SR_FOOT_L : SR_FOOT_R;
  const leadKnee = leftIsTrailing ? SR_KNEE_R : SR_KNEE_L;
  const leadFoot = leftIsTrailing ? SR_FOOT_R : SR_FOOT_L;

  // The leading leg's tuck unfolds again as the descent builds, so the figure
  // meets the ground on two legs rather than on a folded one.
  const descent = body.y[SR_HIP] - body.prevY[SR_HIP];
  const extend = Math.min(1, Math.max(0, descent / AIR_DESCENT_EXTEND_SPEED));
  const leadKneeBelow = AIR_LEAD_KNEE_BELOW + (AIR_TRAIL_KNEE_BELOW - AIR_LEAD_KNEE_BELOW) * extend;
  const leadFootBelow = AIR_LEAD_FOOT_BELOW + (AIR_TRAIL_FOOT_BELOW - AIR_LEAD_FOOT_BELOW) * extend;

  // Horizontal targets are re-centred on their own mean before use. Written
  // straight, the pose asks for more reach behind the hip than in front of it,
  // and since the hip is not itself pinned the constraints answer by sliding
  // the whole leg pair backwards — the fore/aft split collapsed to 0.2 units
  // and the leading foot ended up *behind* the hip. Removing the mean asks only
  // for the split, and leaves where the legs sit as a whole to the physics.
  const trailKneeX = -poseDirection * AIR_TRAIL_KNEE_BEHIND;
  const trailFootX = -poseDirection * AIR_TRAIL_FOOT_BEHIND;
  const leadKneeX = poseDirection * AIR_LEAD_KNEE_AHEAD;
  const leadFootX = poseDirection * AIR_LEAD_FOOT_AHEAD;
  const centre = (trailKneeX + trailFootX + leadKneeX + leadFootX) * 0.25;

  // Trailing leg: reaching back and nearly straight (foot far below the hip).
  biasPointToward(body, trailKnee, hipX + trailKneeX - centre, hipY + AIR_TRAIL_KNEE_BELOW, strength, applied);
  biasPointToward(body, trailFoot, hipX + trailFootX - centre, hipY + AIR_TRAIL_FOOT_BELOW, strength, applied);

  // Leading leg: knee up and forward, foot hanging below it — a folded knee.
  biasPointToward(body, leadKnee, hipX + leadKneeX - centre, hipY + leadKneeBelow, strength, applied);
  biasPointToward(body, leadFoot, hipX + leadFootX - centre, hipY + leadFootBelow, strength, applied);

  cancelNetTranslation(body, applied);
}

/**
 * Draws the feet and knees slowly back under the hip into a standing stance.
 *
 * Whichever foot is currently on the left keeps the left side, so a figure that
 * stopped mid-stride uncrosses by the shortest route instead of swapping its
 * legs over. Vertical targets pull the legs toward full extension, which is
 * what makes the figure rise back to its standing height after a walk.
 */
function applyStandingPoseBias(body: StickRangerBody): void {
  const hipX = body.x[SR_HIP];
  const hipY = body.y[SR_HIP];
  const applied = { x: 0, y: 0 };

  const leftFootIsLeft = body.x[SR_FOOT_L] <= body.x[SR_FOOT_R];
  const leftFoot = leftFootIsLeft ? SR_FOOT_L : SR_FOOT_R;
  const rightFoot = leftFootIsLeft ? SR_FOOT_R : SR_FOOT_L;
  const leftKnee = leftFootIsLeft ? SR_KNEE_L : SR_KNEE_R;
  const rightKnee = leftFootIsLeft ? SR_KNEE_R : SR_KNEE_L;

  biasPointToward(body, leftFoot, hipX - STAND_FOOT_SPREAD, hipY + STAND_FOOT_BELOW, STAND_POSE_BIAS, applied);
  biasPointToward(body, rightFoot, hipX + STAND_FOOT_SPREAD, hipY + STAND_FOOT_BELOW, STAND_POSE_BIAS, applied);
  biasPointToward(body, leftKnee, hipX - STAND_KNEE_SPREAD, hipY + STAND_KNEE_BELOW, STAND_POSE_BIAS, applied);
  biasPointToward(body, rightKnee, hipX + STAND_KNEE_SPREAD, hipY + STAND_KNEE_BELOW, STAND_POSE_BIAS, applied);

  cancelNetTranslation(body, applied);
}

/**
 * Leans the weapon-holding hand (or both, on a two-hander) toward a carry
 * position in front of the hip, on the side the figure faces.
 *
 * Skips the hand currently gripping a grapple rope: that hand is already
 * committed to the anchor, and pulling it forward would either drag the figure
 * or make the rope visibly leave the fist.
 *
 * Like every other pose bias here, the net translation is cancelled afterwards
 * so leaning on the arms cannot push the body across the room.
 */
function applyWeaponCarryBias(body: StickRangerBody): void {
  const holdsLeft = body.carryHandLeftFlag === 1;
  const holdsRight = body.carryHandRightFlag === 1;
  if (!holdsLeft && !holdsRight) return;

  const hipX = body.x[SR_HIP];
  const hipY = body.y[SR_HIP];
  const forward = body.facingDirection < 0 ? -1 : 1;
  const carryY = hipY + CARRY_HAND_BELOW;
  const applied = { x: 0, y: 0 };

  // On a two-hander the hands share one haft, so they split fore and aft of a
  // single carry point instead of each taking their own.
  const isTwoHanded = holdsLeft && holdsRight;
  const nearReach = CARRY_HAND_FORWARD * (isTwoHanded ? 1 - CARRY_TWO_HAND_SPLIT : 1);
  const farReach = CARRY_HAND_FORWARD * (isTwoHanded ? 1 + CARRY_TWO_HAND_SPLIT : 1);
  // The trailing hand is the one on the far side of the body from the facing.
  const leftReach = forward < 0 ? farReach : nearReach;
  const rightReach = forward < 0 ? nearReach : farReach;

  if (holdsLeft && !(body.grappleHangFlag === 1 && body.grappleHandIndex === SR_HAND_L)) {
    biasPointToward(body, SR_HAND_L, hipX + forward * leftReach, carryY, CARRY_POSE_BIAS, applied);
  }
  if (holdsRight && !(body.grappleHangFlag === 1 && body.grappleHandIndex === SR_HAND_R)) {
    biasPointToward(body, SR_HAND_R, hipX + forward * rightReach, carryY, CARRY_POSE_BIAS, applied);
  }

  cancelNetTranslation(body, applied);
}

/**
 * Checks whether a specific foot of the stickman is in a valid grounded
 * position for jumping:
 *   1. The foot itself must NOT be inside a solid block ("Inside a block does not count").
 *   2. The foot must be within a rectangle space 2 in-game pixels above a valid solid surface.
 */
export function canFootJump(body: StickRangerBody, footIndex: number, solid: SolidMask | null): boolean {
  if (solid === null) return false;

  const fx = body.x[footIndex];
  const fy = body.y[footIndex];

  // 1. Inside a block does not count
  if (isSolidAt(solid, fx, fy)) {
    return false;
  }

  // 2. Check 2 in-game pixels above tiles/valid surfaces
  // Sample the foot's horizontal footprint [fx - 1, fx + 1] and vertical space [1, 2] px below fy
  const minX = Math.floor(fx - 1);
  const maxX = Math.floor(fx + 1);

  for (let x = minX; x <= maxX; x++) {
    // The column at the foot's level must be open air (not a vertical wall)
    if (!isSolidAt(solid, x, fy)) {
      if (isSolidAt(solid, x, fy + 1) || isSolidAt(solid, x, fy + 2)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Returns true if at least one of the stickman's feet is in a rectangle space
 * 2 in-game pixels above tiles/valid surfaces, and not inside a block.
 */
export function canStickmanJump(body: StickRangerBody, solid: SolidMask | null): boolean {
  return canFootJump(body, SR_FOOT_L, solid) || canFootJump(body, SR_FOOT_R, solid);
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
 * Resolves an overlap if a point starts inside solid geometry by finding the
 * nearest open pixel in a small radius, never defaulting to an upward push.
 */
function resolveOverlap(solid: SolidMask, x: number, y: number): { x: number; y: number } {
  for (let r = 1; r <= 4; r++) {
    // Check cardinal directions first: down, up, left, right
    if (!isSolidAt(solid, x, y + r)) return { x, y: y + r };
    if (!isSolidAt(solid, x, y - r)) return { x, y: y - r };
    if (!isSolidAt(solid, x + r, y)) return { x: x + r, y };
    if (!isSolidAt(solid, x - r, y)) return { x: x - r, y };
    // Check diagonals
    if (!isSolidAt(solid, x + r, y + r)) return { x: x + r, y: y + r };
    if (!isSolidAt(solid, x - r, y + r)) return { x: x - r, y: y + r };
    if (!isSolidAt(solid, x + r, y - r)) return { x: x + r, y: y - r };
    if (!isSolidAt(solid, x - r, y - r)) return { x: x - r, y: y - r };
  }
  return { x, y };
}

/**
 * Swept, axis-separated, elastic collision for one point using continuous 1-pixel substeps.
 *
 * Traverses delta displacement 1 pixel at a time along Y, then X. If solid
 * geometry is encountered, movement halts immediately at the solid boundary,
 * bounces elastically with SURFACE_TANGENT_RETENTION, and prevents any overlap
 * or tunneling into blocks upward, downward, or laterally.
 */
function collidePoint(body: StickRangerBody, i: number, solid: SolidMask | null, tangentRetention: number): boolean {
  if (solid === null) return false;

  let dx = body.x[i] - body.prevX[i];
  let dy = body.y[i] - body.prevY[i];

  // Rewind: prev holds the pre-integration position, and this pass owns the move.
  body.x[i] = body.prevX[i];
  body.y[i] = body.prevY[i];

  // Overlap recovery if start position is inside solid geometry
  if (isSolidAt(solid, body.x[i], body.y[i])) {
    const pushed = resolveOverlap(solid, body.x[i], body.y[i]);
    body.x[i] = pushed.x;
    body.y[i] = pushed.y;
    body.prevX[i] = pushed.x;
    body.prevY[i] = pushed.y;
  }

  const distance = Math.sqrt(dx * dx + dy * dy);
  // 1-pixel integer-resolution substeps (Maddy Thorson precision)
  const substeps = Math.max(1, Math.ceil(distance));
  dx /= substeps;
  dy /= substeps;

  let hit = false;
  for (let s = 0; s < substeps; s++) {
    // Y axis first (1-pixel sweep), then X
    const nextY = body.y[i] + dy;
    if (isSolidAt(solid, body.x[i], nextY)) {
      dx *= tangentRetention;
      dy = -dy;
      hit = true;
    } else {
      body.y[i] = nextY;
    }

    const nextX = body.x[i] + dx;
    if (isSolidAt(solid, nextX, body.y[i])) {
      dy *= tangentRetention;
      dx = -dx;
      hit = true;
    } else {
      body.x[i] = nextX;
    }
  }

  // Final overlap safeguard: if currently inside solid geometry, push out immediately
  if (isSolidAt(solid, body.x[i], body.y[i])) {
    hit = true;
    const pushed = resolveOverlap(solid, body.x[i], body.y[i]);
    body.x[i] = pushed.x;
    body.y[i] = pushed.y;
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
 * Advances a hanging body by one frame: gravity, the limb constraints, the rope
 * pin on the roped hand, collision, and the energy restore.
 *
 * There is deliberately nothing else here. No gait, no steering, no pose bias —
 * the figure is limp, and everything it does while hanging is a consequence of
 * one point being held on a circle while the other ten fall.
 */
function stepGrappleHangFrame(body: StickRangerBody, solid: SolidMask | null): void {
  const wasEnergyDirty = body.grappleEnergyDirtyFlag === 1;
  body.grappleEnergyDirtyFlag = 0;

  // Plain gravity for every point, and no damping — see GRAPPLE_HANG_DAMPING.
  for (let i = 0; i < SR_POINT_COUNT; i++) {
    integratePoint(body, i, GRAVITY, GRAPPLE_HANG_DAMPING);
  }

  // Rope first in each pass so the limbs settle around where the hand ends up,
  // then once more afterwards so the rope has the last word over the soft limb
  // weights and the arm cannot be stretched off the circle.
  for (let pass = 0; pass < GRAPPLE_ROPE_PASSES; pass++) {
    applyRopeConstraint(body);
    for (let c = 0; c < CONSTRAINTS.length; c++) {
      const [ia, ib, rest, wa, wb] = CONSTRAINTS[c];
      constrain(body, ia, ib, rest, wa, wb);
    }
    const kneeGap = Math.hypot(body.x[SR_KNEE_L] - body.x[SR_KNEE_R], body.y[SR_KNEE_L] - body.y[SR_KNEE_R]);
    if (kneeGap < KNEE_SPREAD_MIN) {
      constrain(body, SR_KNEE_L, SR_KNEE_R, KNEE_SPREAD_MIN, KNEE_SPREAD_WEIGHT, KNEE_SPREAD_WEIGHT);
    }
  }
  applyRopeConstraint(body);

  let contact = false;
  for (let i = 0; i < SR_POINT_COUNT; i++) {
    if (collidePoint(body, i, solid, SURFACE_TANGENT_RETENTION)) contact = true;
  }
  body.groundContactFlag = contact ? 1 : 0;
  if (contact) body.framesSinceGroundContact = 0;

  // Scraping a wall and reeling the rope in are both real energy changes, so
  // those frames re-baseline instead of being undone. Every other frame's loss
  // is the solver's, and the swing is supposed to keep it.
  if (contact || wasEnergyDirty) {
    body.grappleEnergy = computeBodyEnergy(body);
  } else {
    restoreGrappleEnergy(body);
  }
}

/**
 * Advances the body by exactly one fixed 30Hz frame.
 *
 * `moveDirection` is -1, 0 or 1 from the left/right keys.
 */
function stepBodyFrame(body: StickRangerBody, solid: SolidMask | null, moveDirection: number): void {
  body.framesSinceGroundContact += 1;
  body.jumpFiredFlag = 0;

  // Hanging from the rope replaces the frame entirely — see stepGrappleHangFrame.
  if (body.grappleHangFlag === 1) {
    stepGrappleHangFrame(body, solid);
    return;
  }

  // ── 0. Jump ─────────────────────────────────────────────────────────────
  // Fires before integration so the impulse is part of this frame's motion.
  // Applied to every point equally by adjusting prevY (velocity impulse in Verlet)
  // so points do not teleport into solid ceilings before integration and collision.
  // Requires at least one foot in a 2px rectangle space above a solid surface,
  // and not inside a block ("Inside a block does not count").
  if (body.jumpBufferFrames > 0) {
    body.jumpBufferFrames -= 1;
    if (canStickmanJump(body, solid)) {
      for (let i = 0; i < SR_POINT_COUNT; i++) {
        body.prevY[i] += JUMP_IMPULSE;
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
  //
  // Gait mechanism:
  // 1. Applies lateral movement force to ONE foot at a time — the swing foot —
  //    and keeps driving that same foot until it has pulled
  //    STICKMAN_STRIDE_LEAD_DISTANCE ahead of the planted foot along the held
  //    direction, at which point the other leg takes over. That completed-stride
  //    handoff (rather than a fixed frame interval) is what reads as walking:
  //    each leg visibly swings through, plants, and waits its turn.
  // 2. Checks lateral speed in pixels per second before applying force; forces
  //    are not applied once speed reaches or exceeds STICKMAN_MAX_STEER_SPEED_PX_PER_SEC
  //    (100 px/s) until speed dips back below 100 px/s.
  if (moveDirection !== 0 && inLaunchWindow) {
    const turned = body.facingDirection !== (moveDirection < 0 ? -1 : 1);
    body.facingDirection = moveDirection < 0 ? -1 : 1;

    // Starting a walk, or reversing into one, begins the stride on the trailing
    // foot — the one already behind — so the first step goes somewhere.
    if (body.walkStepCounter === 0 || turned) {
      const leftLead = (body.x[SR_FOOT_L] - body.x[SR_FOOT_R]) * moveDirection;
      body.swingFoot = leftLead < 0 ? SR_FOOT_L : SR_FOOT_R;
      body.swingFrames = 0;
    }
    body.walkStepCounter += 1;
    body.swingFrames += 1;

    const framesPerSecond = 1000 / SR_FRAME_MS;

    // Torso/hip lean applied when hip lateral speed in movement direction is below 100 px/s
    const hipSpeedPxSec = (body.x[SR_HIP] - body.prevX[SR_HIP]) * moveDirection * framesPerSecond;
    if (hipSpeedPxSec < STICKMAN_MAX_STEER_SPEED_PX_PER_SEC) {
      body.x[SR_HIP] += moveDirection * STEER_HIP_PUSH;
      body.x[SR_CHEST] += moveDirection * STEER_CHEST_PUSH;
    }

    // Exactly one foot is driven per frame: the current swing foot.
    const activeFoot = body.swingFoot;
    const plantedFoot = activeFoot === SR_FOOT_L ? SR_FOOT_R : SR_FOOT_L;

    // Foot lateral movement force applied ONLY when foot speed in movement direction dips below 100 px/s
    const footSpeedPxSec = (body.x[activeFoot] - body.prevX[activeFoot]) * moveDirection * framesPerSecond;
    if (footSpeedPxSec < STICKMAN_MAX_STEER_SPEED_PX_PER_SEC) {
      body.x[activeFoot] += moveDirection * STEER_FOOT_PUSH;
    }

    // Hand the stride to the other leg once this one is far enough in front —
    // or once it has clearly failed to get there (blocked foot).
    const strideLead = (body.x[activeFoot] - body.x[plantedFoot]) * moveDirection;
    if (strideLead >= STICKMAN_STRIDE_LEAD_DISTANCE || body.swingFrames >= STICKMAN_MAX_SWING_FRAMES) {
      body.swingFoot = plantedFoot;
      body.swingFrames = 0;
    }
  } else {
    body.walkStepCounter = 0;
    body.swingFrames = 0;
  }

  // ── 2a. Standing settle ─────────────────────────────────────────────────
  // With no input and both feet down, the figure gathers itself into a stance
  // instead of keeping whatever splay the last stride left. Deliberately weak
  // (see STAND_POSE_BIAS): this should read as settling, not as snapping to an
  // idle pose. Suppressed while ragdolling, while still sliding, and in the air.
  const isSettling =
    moveDirection === 0 &&
    body.ragdollFrames === 0 &&
    inLaunchWindow &&
    Math.abs(body.x[SR_HIP] - body.prevX[SR_HIP]) < STAND_SETTLE_MAX_SPEED;
  if (isSettling) {
    applyStandingPoseBias(body);
  }

  // ── 2b. Airborne pose bias ──────────────────────────────────────────────
  // Only once the figure is genuinely off the ground (past the launch window,
  // which a walking body never leaves), and only while not ragdolling. Ramped
  // in over the first frames so takeoff itself stays loose.
  // Read before the countdown below consumes it, so 2c sees the same frame's
  // ragdoll state rather than the next one's.
  const isRagdolling = body.ragdollFrames > 0;
  if (body.ragdollFrames > 0) {
    body.ragdollFrames -= 1;
  } else if (!inLaunchWindow) {
    const airFrames = body.framesSinceGroundContact - LAUNCH_FRAMES;
    const ramp = Math.min(1, (airFrames + 1) / AIR_POSE_RAMP_FRAMES);
    const poseDirection = moveDirection !== 0 ? (moveDirection < 0 ? -1 : 1) : body.facingDirection;
    applyAirbornePoseBias(body, poseDirection, ramp);
  }

  // ── 2c. Weapon carry bias ───────────────────────────────────────────────
  // Runs in the air and on the ground alike — a weapon does not stop being
  // held mid-jump — but not while ragdolling, where the whole point is that the
  // figure has lost control of its limbs.
  if (!isRagdolling) {
    applyWeaponCarryBias(body);
  }

  // ── 3. Constraints — TWO passes, soft weights ───────────────────────────
  for (let pass = 0; pass < 2; pass++) {
    for (let c = 0; c < CONSTRAINTS.length; c++) {
      const [ia, ib, rest, wa, wb] = CONSTRAINTS[c];
      constrain(body, ia, ib, rest, wa, wb);
    }
    // The knees are only ever pushed apart, never pulled together (see
    // KNEE_SPREAD_MIN) — an open stride is exactly what this must not undo.
    const kneeGap = Math.hypot(body.x[SR_KNEE_L] - body.x[SR_KNEE_R], body.y[SR_KNEE_L] - body.y[SR_KNEE_R]);
    if (kneeGap < KNEE_SPREAD_MIN) {
      constrain(body, SR_KNEE_L, SR_KNEE_R, KNEE_SPREAD_MIN, KNEE_SPREAD_WEIGHT, KNEE_SPREAD_WEIGHT);
    }
  }

  // ── 4. Elastic collision ────────────────────────────────────────────────
  // Friction is the inverse of tangential retention: holding a direction makes
  // the surface slippery so the stride is not fighting the floor, releasing it
  // restores Stick Ranger's grip so the figure actually stops.
  const tangentRetention =
    moveDirection !== 0 ? SURFACE_TANGENT_RETENTION_MOVING : SURFACE_TANGENT_RETENTION;
  // Impact speed has to be read before the collision pass reflects it.
  const impactSpeed = body.y[SR_HIP] - body.prevY[SR_HIP];
  let contact = false;
  for (let i = 0; i < SR_POINT_COUNT; i++) {
    if (collidePoint(body, i, solid, tangentRetention)) contact = true;
  }

  // ── 5. Ground contact resets the gait window ────────────────────────────
  const wasAirborne = body.framesSinceGroundContact;
  body.groundContactFlag = contact ? 1 : 0;
  if (contact) {
    // Absorb a real landing (see LANDING_ABSORB). Verlet velocity is
    // `current - previous`, so moving `previous` toward `current` scales the
    // velocity down without moving the point itself.
    // A genuinely hard landing hands the figure back to raw physics for a
    // moment — the tumble is the reaction, and the pose bias would hide it.
    if (wasAirborne >= LANDING_ABSORB_MIN_AIR_FRAMES && impactSpeed >= RAGDOLL_LANDING_SPEED) {
      triggerStickRangerRagdoll(body);
    }
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
