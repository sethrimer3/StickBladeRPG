/**
 * Bridge between the Stick Ranger stickman softbody and the rest of the game.
 *
 * When `characterId === 'stickman'` the softbody replaces the player's AABB
 * physics entirely: `applyClusterMovement` skips `tickPlayerMovement` and the
 * wall-collision sweep for the player and calls `tickStickRangerPlayer`
 * instead. The body simulates itself (see stickRangerBody.ts) and this module
 * mirrors its hip back onto the cluster so every downstream system that reads
 * `cluster.positionXWorld` / `velocityXWorld` — camera, enemy AI targeting,
 * hazards, HUD — keeps working unchanged.
 *
 * The mirroring is one-way on purpose. The softbody is the simulation; the
 * cluster box is a derived view of it.
 */

import type { WorldState } from '../world';
import type { ClusterState } from './state';
import {
  createStickRangerBody,
  resetStickRangerBody,
  stepStickRangerBody,
  requestStickRangerJump,
  canStickmanJump,
  SR_HIP,
  SR_HEAD,
  SR_FOOT_L,
  SR_FOOT_R,
  SR_FRAME_MS,
} from './stickRangerBody';
import {
  createStickmanBotState,
  setStickmanBotTarget,
  stepStickmanBotAi,
} from '../ai/stickmanBotAi';

/** The characterId that selects the Stick Ranger stickman. */
export const STICKMAN_CHARACTER_ID = 'stickman';

/**
 * Distance (world units) beyond which a cluster/body mismatch is treated as an
 * external teleport (room transition, respawn, editor drag) rather than
 * ordinary drift, and the body is re-seeded at the cluster instead of
 * dragging itself across the room.
 */
const TELEPORT_RESYNC_DISTANCE = 64;

/** True while the player should be simulated as the Stick Ranger stickman. */
export function isStickRangerActive(world: WorldState): boolean {
  return world.characterId === STICKMAN_CHARACTER_ID;
}

/**
 * Advances the stickman for one host tick and mirrors it onto `cluster`.
 *
 * Allocates the body on first use, and re-seeds it whenever something outside
 * this module has moved the cluster a long way (spawn, room change, respawn).
 */
export function tickStickRangerPlayer(cluster: ClusterState, world: WorldState): void {
  let body = world.stickRangerBody;

  if (body === null) {
    body = createStickRangerBody(cluster.positionXWorld, cluster.positionYWorld);
    world.stickRangerBody = body;
  } else {
    const driftX = cluster.positionXWorld - body.x[SR_HIP];
    const driftY = cluster.positionYWorld - body.y[SR_HIP];
    if (driftX * driftX + driftY * driftY > TELEPORT_RESYNC_DISTANCE * TELEPORT_RESYNC_DISTANCE) {
      resetStickRangerBody(body, cluster.positionXWorld, cluster.positionYWorld);
    }
  }

  // ── Auto-Move / Mobile Navigation ───────────────────────────────────────
  if (world.playerAutoMoveTargetBlock !== null) {
    if (world.playerMoveInputDxWorld !== 0 || world.playerJumpTriggeredFlag === 1) {
      // Manual input cancels auto-move
      world.playerAutoMoveTargetBlock = null;
      world.playerAutoMoveBotState = null;
    } else {
      if (world.playerAutoMoveBotState === null) {
        world.playerAutoMoveBotState = createStickmanBotState(
          world.playerAutoMoveTargetBlock[0],
          world.playerAutoMoveTargetBlock[1],
        );
      } else {
        setStickmanBotTarget(
          world.playerAutoMoveBotState,
          world.playerAutoMoveTargetBlock[0],
          world.playerAutoMoveTargetBlock[1],
        );
      }

      const botRes = stepStickmanBotAi(
        world.playerAutoMoveBotState,
        body,
        world.pixelMaterialSystem.solid,
        world.dtMs,
      );

      if (botRes.isArrived) {
        world.playerAutoMoveTargetBlock = null;
      }
    }
  }

  if (world.playerAutoMoveTargetBlock === null) {
    // Latch the one-shot jump input. The body runs on its own fixed accumulator
    // (30Hz x STICKMAN_TIME_SCALE), so a host tick may advance no body frame at
    // all — queueing here rather than applying an impulse directly means the
    // press is never swallowed.
    // applyClusterMovement clears the flag after the cluster loop, so reading it
    // here sees the current tick's press.
    if (world.playerJumpTriggeredFlag === 1) {
      requestStickRangerJump(body);
    }

    stepStickRangerBody(
      body,
      world.pixelMaterialSystem.solid,
      world.playerMoveInputDxWorld,
      world.dtMs,
    );
  }

  // ── Mirror the body onto the cluster box ────────────────────────────────
  cluster.positionXWorld = body.x[SR_HIP];
  cluster.positionYWorld = body.y[SR_HIP];

  // Velocity in world-units-per-second. Downstream consumers (SFX thresholds,
  // camera lookahead, momentum trail) expect per-second units, whereas Verlet
  // works in per-frame displacement.
  //
  // Read from the hip's own Verlet velocity rather than from how far it moved
  // during this host tick: the body runs on its own clock, so a tick may
  // advance zero body frames or two. Differencing across the tick would report
  // zero on the former and double on the latter, making footstep SFX and
  // camera lookahead flicker at the beat frequency between the two rates.
  const framesPerSecond = 1000 / SR_FRAME_MS;
  cluster.velocityXWorld = (body.x[SR_HIP] - body.prevX[SR_HIP]) * framesPerSecond;
  cluster.velocityYWorld = (body.y[SR_HIP] - body.prevY[SR_HIP]) * framesPerSecond;

  cluster.isGroundedFlag = canStickmanJump(body, world.pixelMaterialSystem.solid) ? 1 : 0;
  cluster.isFacingLeftFlag = body.facingDirection < 0 ? 1 : 0;

  // Keep the hitbox wrapped around the actual drawn figure so contact damage
  // and enemy targeting line up with what the player sees.
  const halfHeight = Math.max(4, (body.y[SR_FOOT_L] + body.y[SR_FOOT_R]) * 0.5 - body.y[SR_HEAD]) * 0.5;
  cluster.halfHeightWorld = halfHeight;

  // The stickman has no wall-slide / wall-jump behaviour yet; clear the flags
  // so stale values from before the character switch cannot leak into the HUD
  // or the jump logic.
  cluster.isTouchingWallLeftFlag = 0;
  cluster.isTouchingWallRightFlag = 0;
  cluster.isWallSlidingFlag = 0;
}
