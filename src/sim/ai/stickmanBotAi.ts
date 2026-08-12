/**
 * stickmanBotAi.ts — AI bot controller and waypoint follower for stickman figures.
 *
 * Translates target block coordinates and path waypoints into stickman softbody
 * inputs (moveDx and jump requests). Operates deterministically on `StickRangerBody`.
 */

import {
  type StickRangerBody,
  stepStickRangerBody,
  requestStickRangerJump,
  canStickmanJump,
  SR_HIP,
  SR_FOOT_L,
  SR_FOOT_R,
} from '../clusters/stickRangerBody';
import type { SolidMask } from '../pixelMaterials/pixelMaterialSolid';
import {
  findGridPath,
  PATH_BLOCK_SIZE,
  type PathWaypoint,
} from './gridPathfinding';

export interface StickmanBotState {
  targetBlockX: number | null;
  targetBlockY: number | null;
  path: PathWaypoint[];
  currentWaypointIndex: number;
  repathCooldownTicks: number;
  stuckTicks: number;
  lastPositionX: number;
  lastPositionY: number;
  isArrived: boolean;
}

export interface StickmanBotOptions {
  arrivalRadiusWorld?: number;
  repathIntervalTicks?: number;
  autoJumpAtLedges?: boolean;
}

const DEFAULT_ARRIVAL_RADIUS_WORLD = 6;
const DEFAULT_REPATH_INTERVAL_TICKS = 25;

/**
 * Creates a new bot navigation state.
 */
export function createStickmanBotState(targetBlockX: number | null = null, targetBlockY: number | null = null): StickmanBotState {
  return {
    targetBlockX,
    targetBlockY,
    path: [],
    currentWaypointIndex: 0,
    repathCooldownTicks: 0,
    stuckTicks: 0,
    lastPositionX: 0,
    lastPositionY: 0,
    isArrived: false,
  };
}

/**
 * Sets a new target block for the bot, triggering an immediate re-path on next step.
 */
export function setStickmanBotTarget(bot: StickmanBotState, targetBlockX: number | null, targetBlockY: number | null): void {
  if (bot.targetBlockX !== targetBlockX || bot.targetBlockY !== targetBlockY) {
    bot.targetBlockX = targetBlockX;
    bot.targetBlockY = targetBlockY;
    bot.path = [];
    bot.currentWaypointIndex = 0;
    bot.repathCooldownTicks = 0;
    bot.isArrived = false;
  }
}

export interface StickmanBotStepResult {
  moveDx: -1 | 0 | 1;
  wantsJump: boolean;
  isArrived: boolean;
  distanceToTargetWorld: number;
}

/**
 * Steps the bot navigation AI for one tick.
 * Updates path, resolves current waypoint, steers `body`, and returns movement result.
 */
export function stepStickmanBotAi(
  bot: StickmanBotState,
  body: StickRangerBody,
  solid: SolidMask | null,
  dtMs: number,
  options?: StickmanBotOptions,
): StickmanBotStepResult {
  const arrivalRadius = options?.arrivalRadiusWorld ?? DEFAULT_ARRIVAL_RADIUS_WORLD;
  const repathInterval = options?.repathIntervalTicks ?? DEFAULT_REPATH_INTERVAL_TICKS;
  const autoJump = options?.autoJumpAtLedges ?? true;

  const hipX = body.x[SR_HIP];
  const hipY = body.y[SR_HIP];
  const feetY = (body.y[SR_FOOT_L] + body.y[SR_FOOT_R]) * 0.5;

  const curBlockX = Math.floor(hipX / PATH_BLOCK_SIZE);
  const curBlockY = Math.floor(feetY / PATH_BLOCK_SIZE);

  let moveDx: -1 | 0 | 1 = 0;
  let wantsJump = false;

  if (bot.targetBlockX === null || bot.targetBlockY === null) {
    bot.isArrived = true;
    stepStickRangerBody(body, solid, 0, dtMs);
    return { moveDx: 0, wantsJump: false, isArrived: true, distanceToTargetWorld: 0 };
  }

  const targetXWorld = bot.targetBlockX * PATH_BLOCK_SIZE + PATH_BLOCK_SIZE * 0.5;
  const targetYWorld = bot.targetBlockY * PATH_BLOCK_SIZE + PATH_BLOCK_SIZE * 0.5;
  const dxToTarget = targetXWorld - hipX;
  const dyToTarget = targetYWorld - feetY;
  const distToTarget = Math.sqrt(dxToTarget * dxToTarget + dyToTarget * dyToTarget);

  // Check arrival
  if (Math.abs(dxToTarget) <= arrivalRadius && Math.abs(dyToTarget) <= arrivalRadius * 1.5) {
    bot.isArrived = true;
    stepStickRangerBody(body, solid, 0, dtMs);
    return { moveDx: 0, wantsJump: false, isArrived: true, distanceToTargetWorld: distToTarget };
  }
  bot.isArrived = false;

  // Re-path check
  if (bot.repathCooldownTicks <= 0 || bot.path.length === 0) {
    bot.path = findGridPath(solid, curBlockX, curBlockY, bot.targetBlockX, bot.targetBlockY);
    bot.currentWaypointIndex = 0;
    bot.repathCooldownTicks = repathInterval;
  } else {
    bot.repathCooldownTicks--;
  }

  // Follow path waypoints
  let targetNavXWorld = targetXWorld;
  let targetNavYWorld = targetYWorld;
  let currentWaypointAction: 'walk' | 'jump' | 'drop' = 'walk';

  if (bot.path.length > 0 && bot.currentWaypointIndex < bot.path.length) {
    const wp = bot.path[bot.currentWaypointIndex];
    targetNavXWorld = wp.blockX * PATH_BLOCK_SIZE + PATH_BLOCK_SIZE * 0.5;
    targetNavYWorld = wp.blockY * PATH_BLOCK_SIZE + PATH_BLOCK_SIZE * 0.5;
    currentWaypointAction = wp.action;

    const dxToWp = targetNavXWorld - hipX;
    const dyToWp = targetNavYWorld - feetY;

    // Advance to next waypoint if close enough horizontally and vertically
    if (Math.abs(dxToWp) < 5 && Math.abs(dyToWp) < 10) {
      bot.currentWaypointIndex++;
      if (bot.currentWaypointIndex < bot.path.length) {
        const nextWp = bot.path[bot.currentWaypointIndex];
        targetNavXWorld = nextWp.blockX * PATH_BLOCK_SIZE + PATH_BLOCK_SIZE * 0.5;
        targetNavYWorld = nextWp.blockY * PATH_BLOCK_SIZE + PATH_BLOCK_SIZE * 0.5;
        currentWaypointAction = nextWp.action;
      }
    }
  }

  const navDx = targetNavXWorld - hipX;
  if (Math.abs(navDx) > 2) {
    moveDx = navDx > 0 ? 1 : -1;
  }

  // Jump triggers
  if (autoJump && moveDx !== 0) {
    // 1. Waypoint explicitly marks jump
    if (currentWaypointAction === 'jump') {
      wantsJump = true;
    }

    // 2. Waypoint or target is higher up
    if (targetNavYWorld < feetY - 6) {
      wantsJump = true;
    }

    // 3. Obstacle / low wall directly in front of feet
    if (solid !== null) {
      const lookAheadX = hipX + moveDx * 6;
      const kneeY = feetY - 6;
      if (solid.isSolid(lookAheadX, kneeY) || solid.isSolid(lookAheadX, feetY - 2)) {
        wantsJump = true;
      }

      // 4. Ledge / gap ahead: floor missing 8px in front while ground is present beneath
      const forwardFloorX = hipX + moveDx * 8;
      const forwardFloorY = feetY + 4;
      const isGrounded = canStickmanJump(body, solid);
      if (isGrounded && !solid.isSolid(forwardFloorX, forwardFloorY) && !solid.isSolid(forwardFloorX, forwardFloorY + 8)) {
        // Only jump if target is on or across the gap, not dropping down intentionally
        if (currentWaypointAction !== 'drop' && targetNavYWorld <= feetY + 8) {
          wantsJump = true;
        }
      }
    }
  }

  // Stuck detection: if trying to move but barely moved over several frames, attempt jump and repath
  const travelDist = Math.abs(hipX - bot.lastPositionX);
  if (moveDx !== 0 && travelDist < 0.2) {
    bot.stuckTicks++;
    if (bot.stuckTicks > 12) {
      wantsJump = true;
      if (bot.stuckTicks > 24) {
        bot.repathCooldownTicks = 0; // Force immediate re-path
        bot.stuckTicks = 0;
      }
    }
  } else {
    bot.stuckTicks = 0;
  }

  bot.lastPositionX = hipX;
  bot.lastPositionY = hipY;

  // Execute jump if requested and grounded
  if (wantsJump && canStickmanJump(body, solid)) {
    requestStickRangerJump(body);
  }

  // Step softbody physics
  stepStickRangerBody(body, solid, moveDx, dtMs);

  return {
    moveDx,
    wantsJump,
    isArrived: bot.isArrived,
    distanceToTargetWorld: distToTarget,
  };
}
