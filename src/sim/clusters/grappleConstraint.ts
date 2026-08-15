/**
 * grappleConstraint.ts — Per-tick grapple rope constraint and swing physics.
 *
 * Extracted from grapple.ts so that the fire/init/FX logic (grapple.ts) and
 * the per-tick constraint physics live in separate, focused modules.
 *
 * Exported: applyGrappleClusterConstraint
 *
 * Called from tick.ts at step 0.25 (after applyClusterMovement) to enforce
 * the rope length and apply pendulum physics.  See grapple.ts for the full
 * developer notes on the physics model.
 */

import { WorldState } from '../world';
import { PLAYER_JUMP_SPEED_WORLD, VAR_JUMP_TIME_TICKS } from './movement';
import { moveClusterByDelta } from './movementCollision';
import { releaseGrapple } from './grappleShared';
import { tickGrappleWrapping } from './grappleWrapping';
import { tickGrappleZip } from './grappleZip';
import {
  canMoveGrappleCarryBlockToward,
  pullGrappleCarryBlockToward,
} from '../grappleCarryBlocks';
import { isStickRangerActive } from './stickRangerPlayer';
import {
  applyStickRangerImpulse,
  detachStickRangerGrapple,
  teleportStickRangerBody,
  SR_HIP,
} from './stickRangerBody';

// ============================================================================
// Tuning constants — used only by applyGrappleClusterConstraint
// ============================================================================

const GRAPPLE_CARRY_TENSION_SLACK_WORLD = 1.0;
const GRAPPLE_CARRY_TENSION_PULL_SPEED_WORLD_PER_SEC = 36.0;

/**
 * Upward velocity impulse (world units/second) added to the player when they
 * press jump to release the grapple.  This is a "jump off the rope" that adds
 * upward momentum to whatever swing velocity the player has.
 * Applied by *subtracting* from velocityYWorld — negative Y is upward.
 */
const GRAPPLE_JUMP_OFF_SPEED_WORLD = PLAYER_JUMP_SPEED_WORLD;

// ============================================================================
// Constraint function
// ============================================================================

/**
 * Step 0.25 — Enforces the rope constraint and applies swing physics.
 *
 * Called after applyClusterMovement (which applies gravity and floor collision)
 * so the constraint acts on the fully-updated cluster position and velocity.
 *
 * Controls:
 *   • Jump (W/Space/Up) → release grapple + upward velocity impulse.
 *   • Down (S/ArrowDown) held → retract (shorten) the rope.
 *     Shortening conserves angular momentum so the player swings faster.
 *     RMB while attached → activate zip: player rockets toward the anchor,
 *     momentum stops on arrival, then a 0.15 s zip-jump window opens.
 *     Jump in window = high-velocity zip-jump biased by held input direction.
 *     Miss window = grapple releases quietly, no automatic impulse.
 *
 * Pipeline per tick:
 *   1. Consume playerJumpTriggeredFlag and playerDownTriggeredFlag.
 *   2. Delegate zip activation + state machine to tickGrappleZip.
 *   3. If zip active → skip normal swing.
 *   4. Jump pressed (normal swing) → release with upward impulse.
 *   5. While down held (retraction):
 *      a. Decompose velocity into radial + tangential components.
 *      b. Shorten the rope.
 *      c. Scale tangential velocity by (oldLength / newLength) to conserve
 *         angular momentum.
 *      d. Recompose velocity from radial + boosted tangential.
 *   6. Enforce rope length: if player distance > ropeLength, snap position
 *      onto the rope circle and remove the outward radial velocity component.
 *   7. Post-constraint wall collision check to prevent ground clipping.
 *   8. Preserve tangential velocity indefinitely unless another gameplay
 *      force, collision, or rope retraction changes it.
 */
export function applyGrappleClusterConstraint(world: WorldState): void {
  if (world.isGrappleActiveFlag === 0) return;

  const player = world.clusters[0];
  if (player === undefined || player.isAliveFlag === 0) {
    releaseGrapple(world);
    return;
  }

  const dtSec = world.dtMs / 1000.0;
  if (world.grappleCarryBlockIndex >= 0) {
    const bi = world.grappleCarryBlockIndex;
    if (bi >= world.grappleCarryBlockCount) {
      releaseGrapple(world);
      return;
    }
    world.grappleAnchorXWorld = world.grappleCarryBlockXWorld[bi];
    world.grappleAnchorYWorld = world.grappleCarryBlockYWorld[bi];
  }

  // ── Jump input ────────────────────────────────────────────────────────────
  // movement.ts preserves playerJumpTriggeredFlag when grapple is active so we
  // can detect the rising edge of a jump press here.
  const jumpJustPressed = world.playerJumpTriggeredFlag === 1;
  world.playerJumpTriggeredFlag = 0; // consume — grapple owns the flag while active

  // ── Ordinary ("quiet") release request ────────────────────────────────────
  // Set by gameCommandProcessor.ts on Hold-mode mouse/gamepad-button-up or a
  // Toggle-mode second click. That command processing happens once per
  // rendered frame, outside the deterministic fixed tick, so it only queues
  // the request here rather than releasing immediately. Consuming (and
  // clearing) it now means it is applied at most once and jump-off — handled
  // immediately below — always takes priority when both land on the same
  // tick, per the intended jump-off-over-quiet-release ordering.
  const quietReleaseRequested = world.isGrappleQuietReleaseRequestedFlag === 1;
  world.isGrappleQuietReleaseRequestedFlag = 0;

  // Consume the down triggered flag so it does not accumulate during grapple.
  // (Retraction uses playerCrouchHeldFlag; playerDownTriggeredFlag was only
  //  needed by the old double-tap zip detection which has been replaced by RMB.)
  world.playerDownTriggeredFlag = 0;

  // The stickman is a softbody, not an AABB: the cluster box is a derived view
  // of it (see stickRangerPlayer.ts), so anything this function writes to the
  // cluster is overwritten by the body's own mirror on the next tick. Its rope
  // physics therefore lives in the body — this function keeps only the parts
  // that are about the grapple *state*: input, retraction and release.
  const isStickman = isStickRangerActive(world) && world.stickRangerBody !== null;

  if (tickGrappleZip(world, player, jumpJustPressed, dtSec)) {
    // The zip owns the player's position outright, so the softbody is carried
    // to wherever it put the cluster rather than left behind by it.
    if (isStickman && world.stickRangerBody !== null) {
      detachStickRangerGrapple(world.stickRangerBody);
      teleportStickRangerBody(world.stickRangerBody, SR_HIP, player.positionXWorld, player.positionYWorld);
    }
    // Zip owns jump handling internally (zip-jump window). If a quiet release
    // was also requested this tick and zip did not already end the grapple
    // (e.g. via the miss-window release), honor it now so mouse-up during a
    // zip still reliably detaches, matching pre-existing behavior.
    if (quietReleaseRequested && world.isGrappleActiveFlag === 1) {
      releaseGrapple(world);
    }
    return;
  }

  // Jump-off already handles its own release below and must win over a
  // same-tick quiet release; quietReleaseRequested is otherwise honored at
  // the end of this function, after this tick's swing physics (retraction +
  // rope-length constraint) has finished updating the player's true velocity.

  // ════════════════════════════════════════════════════════════════════════════
  // Normal grapple — pendulum swing
  // ════════════════════════════════════════════════════════════════════════════

  // ── Phase 2: Geometric wrapping tick ─────────────────────────────────────
  // Must run before the constraint so wrap points are current this tick.
  if (world.isGrappleWrappingEnabled === 1) {
    tickGrappleWrapping(world, player);
  }

  // ── Jump input: release grapple + upward impulse ──────────────────────────
  // Any jump press immediately releases the grapple and gives the player an
  // upward velocity boost so they can "jump off" the rope.
  if (jumpJustPressed) {
    if (isStickman && world.stickRangerBody !== null) {
      // The softbody carries its own momentum, so the jump-off is an impulse on
      // every point rather than an edit of the derived cluster velocity.
      applyStickRangerImpulse(world.stickRangerBody, 0, -GRAPPLE_JUMP_OFF_SPEED_WORLD);
      detachStickRangerGrapple(world.stickRangerBody);
    }
    player.velocityYWorld -= GRAPPLE_JUMP_OFF_SPEED_WORLD;
    player.varJumpTimerTicks = VAR_JUMP_TIME_TICKS;
    player.varJumpSpeedWorld = player.velocityYWorld;
    releaseGrapple(world, false, true);
    return;
  }

  // ── Stickman: rope physics belongs to the softbody ────────────────────────
  // Everything below this point moves the cluster box, which for the stickman
  // is a mirror of the softbody and would simply be overwritten. The body pins
  // its roped hand and swings itself (see stepGrappleHangFrame); the only rope
  // state left to own here is the length, which retraction changes.
  if (isStickman && world.stickRangerBody !== null) {
    const body = world.stickRangerBody;

    // Rope retraction (hold down / S) is disabled — rope length is fixed at
    // fire time, so there is nothing to ramp here.
    world.grappleRetractHeldTicks = 0;

    if (quietReleaseRequested) {
      detachStickRangerGrapple(body);
      releaseGrapple(world);
    }
    return;
  }

  // ── Compute radial direction from anchor to player ────────────────────────
  // Phase 2: When wrapping is enabled and wrap points exist, the active swing
  // anchor is the newest wrap point rather than the main grapple anchor.
  const ax = (world.isGrappleWrappingEnabled === 1 && world.grappleWrapPointCount > 0)
    ? world.grappleWrapPointXWorld[world.grappleWrapPointCount - 1]
    : world.grappleAnchorXWorld;
  const ay = (world.isGrappleWrappingEnabled === 1 && world.grappleWrapPointCount > 0)
    ? world.grappleWrapPointYWorld[world.grappleWrapPointCount - 1]
    : world.grappleAnchorYWorld;
  const dx = player.positionXWorld - ax;
  const dy = player.positionYWorld - ay;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (dist < 1.0) {
    // Degenerate — player at anchor point. No swing physics to run this tick,
    // but a pending quiet release must still be honored with current velocity.
    if (quietReleaseRequested) releaseGrapple(world);
    return;
  }

  const invDist = 1.0 / dist;
  // Unit vector pointing from anchor toward player (outward / radial direction)
  const nx = dx * invDist;
  const ny = dy * invDist;

  // Rope retraction (hold down / S) is disabled — the player cannot change
  // the rope length after firing; it stays fixed until release or break.
  world.grappleRetractHeldTicks = 0;

  // ── Enforce rope length constraint ────────────────────────────────────────
  // If the player has drifted beyond the current rope length (due to gravity,
  // movement, or the rope shortening around them), move their position back
  // onto the rope circle using the collision-safe helper so the correction
  // cannot push them through a wall.  The outward radial velocity component
  // is removed afterward to prevent the rope from being stretched further.
  // The tangential (swing) component is fully preserved — this is what makes
  // the pendulum feel physical rather than scripted.
  const ropeLength = world.grappleLengthWorld;

  if (world.grappleCarryBlockIndex >= 0) {
    const bi = world.grappleCarryBlockIndex;
    const towardPlayerX = nx;
    const towardPlayerY = ny;
    if (
      dist > ropeLength + GRAPPLE_CARRY_TENSION_SLACK_WORLD &&
      canMoveGrappleCarryBlockToward(world, bi, towardPlayerX, towardPlayerY)
    ) {
      const stretchWorld = dist - ropeLength;
      const stretchFactor = Math.min(1, stretchWorld / 24);
      pullGrappleCarryBlockToward(
        world,
        bi,
        towardPlayerX,
        towardPlayerY,
        GRAPPLE_CARRY_TENSION_PULL_SPEED_WORLD_PER_SEC * stretchFactor,
      );
      world.grappleLengthWorld = Math.max(world.grappleLengthWorld, dist - GRAPPLE_CARRY_TENSION_SLACK_WORLD);
      if (quietReleaseRequested) releaseGrapple(world);
      return;
    }
  }

  if (dist > ropeLength) {
    // Target position: player centre on the rope circle.
    const targetX = ax + nx * ropeLength;
    const targetY = ay + ny * ropeLength;
    const deltaX  = targetX - player.positionXWorld;
    const deltaY  = targetY - player.positionYWorld;

    // Move toward the target safely.  moveClusterByDelta uses the same
    // axis-separated sub-stepped sweep as normal movement, so the snap cannot
    // carry the player through solid geometry.  If a wall obstructs the path
    // the player stops at the wall face rather than being clipped inside it.
    // If a bounce pad is contacted, moveClusterByDelta applies the reflected
    // real velocity (based on the swing momentum, not the snap delta), and we
    // release the grapple so the player travels with the bounce trajectory.
    const snapResult = moveClusterByDelta(player, world, deltaX, deltaY, false, dtSec);
    if (snapResult.bounced) {
      // Reflected swing velocity is already on the player cluster (applied by
      // moveClusterByDelta).  Release the grapple so normal movement takes over.
      releaseGrapple(world, false);
      return;
    }

    // Remove outward velocity component (rope can only pull — never push).
    // Use the pre-snap nx/ny direction; the position change is a small
    // correction so the angular error is negligible.
    const velDotN = player.velocityXWorld * nx + player.velocityYWorld * ny;
    if (velDotN > 0) {
      player.velocityXWorld -= velDotN * nx;
      player.velocityYWorld -= velDotN * ny;
    }
  }

  // Movement V2 intentionally applies no passive swing damping. Tangential
  // velocity persists until another gameplay force, collision, or retraction
  // changes it.

  // ── Honor a pending quiet release, now that this tick's retraction and
  // rope-length constraint have both finished updating the player's genuine
  // swing velocity. This is the sole authoritative point for an ordinary
  // release: it preserves full physical velocity (horizontal + vertical) and
  // explicitly excludes any position-only correction — the outward-velocity
  // removal above stays because it is real rope tension, not a fabricated
  // snap-derived velocity.
  if (quietReleaseRequested && world.isGrappleActiveFlag === 1) {
    releaseGrapple(world);
  }
}
