/**
 * Follow behavior for the party members the player is not controlling.
 *
 * Phase 3a of the STICK-RPG port. Pure and Node-safe: it consumes plain
 * positions and returns a movement *intent*, never touching physics, clusters,
 * or `WorldState`. Phase 3b feeds that intent into the same movement code the
 * player uses, so followers move by the game's own rules rather than by a
 * parallel implementation that could drift out of agreement with it.
 *
 * Ported from the follow branch of the donor's `Stick.ai` (`js/stickman.js`),
 * with the donor's `performance.now()` timing replaced by tick counts.
 */

/** Movement intent for one follower this tick. */
export interface FollowIntent {
  /** Horizontal input: -1 (left), 0 (hold), 1 (right). */
  moveDx: -1 | 0 | 1;
  /** True when the follower should jump this tick. */
  wantsJump: boolean;
  /**
   * True when the follower is hopelessly separated and should be teleported to
   * the leader rather than pathing. Without this a follower stuck behind
   * geometry is lost for the rest of the room — the donor has the same escape
   * hatch, and it is the only thing keeping a partyless-looking party from
   * being a permanent state.
   */
  shouldTeleport: boolean;
}

/** Tunables governing how followers trail the leader. */
export interface FollowConfig {
  /**
   * Horizontal spacing each follower keeps from the leader, in world units.
   * Multiplied by follow order so members fan out rather than stacking.
   */
  spacingWorld: number;
  /** Horizontal slack inside which a follower stops walking, in world units. */
  deadZoneWorld: number;
  /** Height above the follower at which it tries to jump, in world units. */
  jumpTriggerHeightWorld: number;
  /** Separation beyond which the follower teleports to the leader. */
  teleportDistanceWorld: number;
}

/** Defaults tuned to the donor's spacing relative to its stickman size. */
export const DEFAULT_FOLLOW_CONFIG: FollowConfig = {
  spacingWorld: 24,
  deadZoneWorld: 6,
  jumpTriggerHeightWorld: 20,
  teleportDistanceWorld: 400,
};

/** The minimum position information a follower needs about itself and its leader. */
export interface FollowActor {
  positionXWorld: number;
  positionYWorld: number;
  isGroundedFlag: 0 | 1;
}

const _intent: FollowIntent = { moveDx: 0, wantsJump: false, shouldTeleport: false };

/**
 * Computes one follower's intent for this tick.
 *
 * `followOrder` is 1 for the first follower, 2 for the second, and so on; it
 * scales the target spacing so members form a trail instead of piling onto the
 * same point.
 *
 * Returns a module-scoped object — read it before the next call.
 */
export function computeFollowIntent(
  follower: FollowActor,
  leader: FollowActor,
  followOrder: number,
  config: FollowConfig = DEFAULT_FOLLOW_CONFIG,
): FollowIntent {
  _intent.moveDx = 0;
  _intent.wantsJump = false;
  _intent.shouldTeleport = false;

  const dx = leader.positionXWorld - follower.positionXWorld;
  const dy = leader.positionYWorld - follower.positionYWorld;
  const distSq = dx * dx + dy * dy;

  if (distSq > config.teleportDistanceWorld * config.teleportDistanceWorld) {
    _intent.shouldTeleport = true;
    return _intent;
  }

  // Trail behind the leader on the side the follower is already on, so members
  // do not cross through each other to reach a fixed slot.
  const side = dx >= 0 ? -1 : 1;
  const targetXWorld = leader.positionXWorld + side * config.spacingWorld * Math.max(1, followOrder);
  const toTarget = targetXWorld - follower.positionXWorld;

  if (Math.abs(toTarget) > config.deadZoneWorld) {
    _intent.moveDx = toTarget > 0 ? 1 : -1;
  }

  // Jump only from the ground, and only when the leader is meaningfully above:
  // a follower that jumps at every small height difference reads as panicked.
  const leaderIsAbove = dy < -config.jumpTriggerHeightWorld;
  if (leaderIsAbove && follower.isGroundedFlag === 1) {
    _intent.wantsJump = true;
  }

  return _intent;
}

/**
 * Whether a follower is close enough to the leader to count as "with the party".
 *
 * Phase 3b uses this to decide whether a room transition may carry a member
 * along, rather than dragging a member who is stuck across the room.
 */
export function isFollowerWithParty(
  follower: FollowActor,
  leader: FollowActor,
  config: FollowConfig = DEFAULT_FOLLOW_CONFIG,
): boolean {
  const dx = leader.positionXWorld - follower.positionXWorld;
  const dy = leader.positionYWorld - follower.positionYWorld;
  const limit = config.teleportDistanceWorld;
  return dx * dx + dy * dy <= limit * limit;
}
