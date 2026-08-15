/**
 * Slime enemy AI.
 *
 * Green Slime: hops in a parabolic arc toward the player's position.
 * Pauses for 3.0s after touching down at 100% HP, scaling down to 0.0s at 0% HP.
 *
 * Large Dust Slime: slower hops, orbiting dust, splits into 2 small slimes on death.
 *
 * Pure deterministic logic — no Math.random(), no DOM, no wall-clock time.
 */

import { WorldState } from '../world';
import { ClusterState, createClusterState } from './state';
import { nextFloat } from '../rng';

/** Base pause between hops at 100% HP (seconds). */
export const SLIME_BASE_PAUSE_SEC = 3.0;
/** Gravity (world units/s²). */
export const SLIME_GRAVITY_WORLD_PER_SEC2 = 900;
/** Max fall speed (world units/s). */
export const SLIME_MAX_FALL_WORLD_PER_SEC = 400;
/** Max horizontal speed during hop (world units/s). */
export const SLIME_MAX_HOP_SPEED_X_WORLD = 240;

/** Ticks between hops for a large slime. */
const LARGE_SLIME_HOP_INTERVAL_TICKS = 90;
/** Horizontal speed during large slime hop (world units/s). */
const LARGE_SLIME_HOP_SPEED_X_WORLD = 90;
/** Vertical launch speed during large slime hop (world units/s, upward = negative). */
const LARGE_SLIME_HOP_SPEED_Y_WORLD = -160;
/** Orbit angular velocity (radians/tick). */
const LARGE_SLIME_ORBIT_SPEED_RAD_PER_TICK = 0.04;

/** Half-width and half-height of a small slime (world units) — 16×16 in-game px. */
export const SLIME_HALF_SIZE_WORLD = 8;
/** Half-width and half-height of a large slime (world units). */
export const LARGE_SLIME_HALF_SIZE_WORLD = 7;
/** Horizontal offset for each child small slime on split (world units). */
const SPLIT_OFFSET_X_WORLD = 10;

export interface SlimeHopVelocity {
  vx: number;
  vy: number;
}

/**
 * Computes deterministic parabolic launch velocity (vx, vy) targeting
 * (targetX, targetY) under the specified gravity.
 */
export function computeSlimeHopVelocity(
  slimeX: number,
  slimeY: number,
  targetX: number,
  targetY: number,
  gravity: number = SLIME_GRAVITY_WORLD_PER_SEC2,
): SlimeHopVelocity {
  const dx = targetX - slimeX;
  const dy = targetY - slimeY;

  const minApex = 32;
  const targetApex = dy < 0 ? -dy + 16 : minApex;
  const hApex = Math.max(24, targetApex);

  let vy = -Math.sqrt(2 * gravity * hApex);
  if (vy < -360) vy = -360;
  if (vy > -140) vy = -140;

  const actualApex = (vy * vy) / (2 * gravity);
  const hFall = Math.max(4, actualApex + dy);
  const tUp = -vy / gravity;
  const tDown = Math.sqrt((2 * hFall) / gravity);
  const totalTime = tUp + tDown;

  let vx = totalTime > 0.001 ? dx / totalTime : 0;
  if (vx > SLIME_MAX_HOP_SPEED_X_WORLD) vx = SLIME_MAX_HOP_SPEED_X_WORLD;
  if (vx < -SLIME_MAX_HOP_SPEED_X_WORLD) vx = -SLIME_MAX_HOP_SPEED_X_WORLD;
  if (Math.abs(dx) < 2) vx = 0;

  return { vx, vy };
}

/**
 * Returns the post-touchdown pause in simulation ticks scaled by health ratio.
 * At 100% HP: 3.0 seconds (e.g. 180 ticks at 60Hz).
 * At 0% HP: 0 seconds (0 ticks).
 */
export function getSlimePauseTicks(
  healthPoints: number,
  maxHealthPoints: number,
  dtSec: number,
): number {
  const maxHp = Math.max(1, maxHealthPoints);
  const hpRatio = Math.max(0, Math.min(1, healthPoints / maxHp));
  if (dtSec <= 0) return 0;
  return Math.round((SLIME_BASE_PAUSE_SEC * hpRatio) / dtSec);
}

export function applySlimeAI(world: WorldState): void {
  const dtSec = world.dtMs * 0.001;

  // Find player
  let playerXWorld = 0;
  let playerYWorld = 0;
  let playerFound = false;
  for (let ci = 0; ci < world.clusters.length; ci++) {
    const c = world.clusters[ci];
    if (c.isPlayerFlag === 1 && c.isAliveFlag === 1) {
      playerXWorld = c.positionXWorld;
      playerYWorld = c.positionYWorld;
      playerFound = true;
      break;
    }
  }

  for (let ci = 0; ci < world.clusters.length; ci++) {
    const cluster = world.clusters[ci];
    if (cluster.isSlimeFlag !== 1 || cluster.isAliveFlag === 0) continue;

    const maxPauseTicks = getSlimePauseTicks(cluster.healthPoints, cluster.maxHealthPoints, dtSec);

    if (cluster.isGroundedFlag === 1) {
      // Grounded: stop horizontal sliding
      cluster.velocityXWorld = 0;

      // Damage reaction: if HP was reduced while waiting, cap remaining pause ticks
      if (cluster.slimeHopTimerTicks > maxPauseTicks) {
        cluster.slimeHopTimerTicks = maxPauseTicks;
      }

      if (cluster.slimeHopTimerTicks > 0) {
        cluster.slimeHopTimerTicks -= 1;
      }

      if (cluster.slimeHopTimerTicks <= 0 && playerFound) {
        // Launch parabolic hop towards player
        const { vx, vy } = computeSlimeHopVelocity(
          cluster.positionXWorld,
          cluster.positionYWorld,
          playerXWorld,
          playerYWorld,
          SLIME_GRAVITY_WORLD_PER_SEC2,
        );

        cluster.velocityXWorld = vx;
        cluster.velocityYWorld = vy;
        cluster.isGroundedFlag = 0;
        cluster.slimeHopTimerTicks = maxPauseTicks;

        const dx = playerXWorld - cluster.positionXWorld;
        if (vx < 0 || (vx === 0 && dx < 0)) {
          cluster.isFacingLeftFlag = 1;
        } else if (vx > 0 || (vx === 0 && dx > 0)) {
          cluster.isFacingLeftFlag = 0;
        }
      } else if (cluster.slimeHopTimerTicks <= 0) {
        cluster.slimeHopTimerTicks = maxPauseTicks;
      }
    } else {
      // Airborne: apply gravity
      cluster.velocityYWorld += SLIME_GRAVITY_WORLD_PER_SEC2 * dtSec;
      if (cluster.velocityYWorld > SLIME_MAX_FALL_WORLD_PER_SEC) {
        cluster.velocityYWorld = SLIME_MAX_FALL_WORLD_PER_SEC;
      }
      // When in air, keep pause timer primed for touchdown
      cluster.slimeHopTimerTicks = maxPauseTicks;
    }
  }
}

export function applyLargeSlimeAI(world: WorldState): void {
  const dtSec = world.dtMs * 0.001;

  // Find player
  let playerXWorld = 0;
  let playerFound = false;
  for (let ci = 0; ci < world.clusters.length; ci++) {
    const c = world.clusters[ci];
    if (c.isPlayerFlag === 1 && c.isAliveFlag === 1) {
      playerXWorld = c.positionXWorld;
      playerFound = true;
      break;
    }
  }

  for (let ci = 0; ci < world.clusters.length; ci++) {
    const cluster = world.clusters[ci];
    if (cluster.isLargeSlimeFlag !== 1 || cluster.isAliveFlag === 0) continue;

    // Apply gravity
    cluster.velocityYWorld += SLIME_GRAVITY_WORLD_PER_SEC2 * dtSec;
    if (cluster.velocityYWorld > SLIME_MAX_FALL_WORLD_PER_SEC) {
      cluster.velocityYWorld = SLIME_MAX_FALL_WORLD_PER_SEC;
    }

    // Orbit angle for dust visuals
    cluster.largeSlimeDustOrbitAngleRad += LARGE_SLIME_ORBIT_SPEED_RAD_PER_TICK;

    // Hop timer
    cluster.slimeHopTimerTicks -= 1;
    if (cluster.slimeHopTimerTicks <= 0 && cluster.isGroundedFlag === 1 && playerFound) {
      const dirX = playerXWorld > cluster.positionXWorld ? 1 : -1;
      cluster.velocityXWorld = dirX * LARGE_SLIME_HOP_SPEED_X_WORLD;
      cluster.velocityYWorld = LARGE_SLIME_HOP_SPEED_Y_WORLD;
      cluster.slimeHopTimerTicks = LARGE_SLIME_HOP_INTERVAL_TICKS;
    } else if (cluster.slimeHopTimerTicks <= 0) {
      cluster.slimeHopTimerTicks = LARGE_SLIME_HOP_INTERVAL_TICKS;
    }
  }
}

/**
 * After the main tick, check for large slimes that just died and haven't
 * split yet. Returns newly created small-slime clusters to add to the world.
 * Called from gameScreen after tick().
 */
export function processLargeSlimeSplits(world: WorldState): ClusterState[] {
  const toAdd: ClusterState[] = [];
  let nextId = 1;
  for (let ci = 0; ci < world.clusters.length; ci++) {
    nextId = Math.max(nextId, world.clusters[ci].entityId + 1);
  }

  for (let ci = 0; ci < world.clusters.length; ci++) {
    const cluster = world.clusters[ci];
    if (
      cluster.isLargeSlimeFlag !== 1 ||
      cluster.isAliveFlag !== 0 ||
      cluster.largeSlimeSplitDoneFlag !== 0
    ) continue;

    cluster.largeSlimeSplitDoneFlag = 1;

    for (let s = 0; s < 2; s++) {
      const offsetX = s === 0 ? -SPLIT_OFFSET_X_WORLD : SPLIT_OFFSET_X_WORLD;
      const child = createClusterState(
        nextId++,
        cluster.positionXWorld + offsetX,
        cluster.positionYWorld,
        0,
        8,
      );
      child.isSlimeFlag = 1;
      child.halfWidthWorld = SLIME_HALF_SIZE_WORLD;
      child.halfHeightWorld = SLIME_HALF_SIZE_WORLD;
      child.slimeHopTimerTicks = 20 + ((nextFloat(world.rng) * 20) | 0);
      child.velocityYWorld = -80;
      toAdd.push(child);
    }
  }

  return toAdd;
}

