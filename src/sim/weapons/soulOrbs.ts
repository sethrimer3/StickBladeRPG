/**
 * Soul drops and collection for `kind: 'summoner'` weapons.
 *
 * Phase 2g of the STICK-RPG port. When an enemy is defeated, summoner weapons
 * drop floating soul motes (`soulColor`). If the wielder is within `soulRange`,
 * souls drift toward the wielder and are collected up to `maxSouls`.
 * Collected souls empower the next summon into a potent Guardian familiar.
 *
 * Deterministic and allocation-free per tick; lifetimes are tick counts.
 */

import type { WeaponDef } from './weaponDefs';

/** Maximum simultaneous soul drop orbs in flight. */
export const MAX_SOUL_ORBS = 32;

/** Ticks before an uncollected soul orb naturally dissipates (~10 seconds). */
export const SOUL_ORB_LIFETIME_TICKS = 600;

/** Default soul collection range in world units if unspecified. */
export const DEFAULT_SOUL_RANGE_WORLD = 280;

/** Default maximum souls a wielder can store. */
export const DEFAULT_MAX_SOULS = 6;

/** Storage pool for live soul orbs. */
export interface SoulOrbPool {
  isLive: Uint8Array;
  xWorld: Float32Array;
  yWorld: Float32Array;
  velocityXWorld: Float32Array;
  velocityYWorld: Float32Array;
  lifetimeTicks: Int32Array;
  color: string[];
  value: Int32Array;
  liveCount: number;
}

/** Allocates an empty soul orb pool. */
export function createSoulOrbPool(): SoulOrbPool {
  const n = MAX_SOUL_ORBS;
  const colors: string[] = [];
  for (let i = 0; i < n; i++) colors.push('#dfc9ff');
  return {
    isLive: new Uint8Array(n),
    xWorld: new Float32Array(n),
    yWorld: new Float32Array(n),
    velocityXWorld: new Float32Array(n),
    velocityYWorld: new Float32Array(n),
    lifetimeTicks: new Int32Array(n),
    color: colors,
    value: new Int32Array(n),
    liveCount: 0,
  };
}

/** Resets all active soul orbs in the pool. */
export function resetSoulOrbPool(pool: SoulOrbPool): void {
  pool.isLive.fill(0);
  pool.liveCount = 0;
}

/**
 * Spawns a soul orb dropped at an enemy's defeat location.
 */
export function spawnSoulOrb(
  pool: SoulOrbPool,
  xWorld: number,
  yWorld: number,
  color: string = '#dfc9ff',
  value: number = 1,
): boolean {
  for (let i = 0; i < MAX_SOUL_ORBS; i++) {
    if (pool.isLive[i] === 0) {
      pool.isLive[i] = 1;
      pool.xWorld[i] = xWorld;
      pool.yWorld[i] = yWorld;
      pool.velocityXWorld[i] = (Math.random() - 0.5) * 40;
      pool.velocityYWorld[i] = -60 - Math.random() * 40;
      pool.lifetimeTicks[i] = SOUL_ORB_LIFETIME_TICKS;
      pool.color[i] = color;
      pool.value[i] = value;
      pool.liveCount++;
      return true;
    }
  }
  return false;
}

/**
 * Advances soul orbs for one tick: drifts orbs toward the wielder when in range,
 * and collects them if within pickup distance.
 *
 * Returns the number of souls newly collected this tick.
 */
export function tickSoulOrbs(
  pool: SoulOrbPool,
  wielderX: number,
  wielderY: number,
  def: WeaponDef | null,
  currentSouls: number,
): number {
  if (pool.liveCount <= 0 || def === null) return 0;

  const soulRange = def.soulRange ?? DEFAULT_SOUL_RANGE_WORLD;
  const maxSouls = def.maxSouls ?? DEFAULT_MAX_SOULS;
  const soulRangeSq = soulRange * soulRange;
  const pickupRadiusSq = 20 * 20;

  let soulsGained = 0;
  const dt = 1 / 60;
  const seekSpeed = 340;

  for (let i = 0; i < MAX_SOUL_ORBS; i++) {
    if (pool.isLive[i] === 0) continue;

    pool.lifetimeTicks[i]--;
    if (pool.lifetimeTicks[i] <= 0) {
      pool.isLive[i] = 0;
      pool.liveCount--;
      continue;
    }

    const dx = wielderX - pool.xWorld[i];
    const dy = wielderY - pool.yWorld[i];
    const distSq = dx * dx + dy * dy;

    // Check collection
    if (distSq <= pickupRadiusSq) {
      if (currentSouls + soulsGained < maxSouls) {
        soulsGained += pool.value[i];
      }
      pool.isLive[i] = 0;
      pool.liveCount--;
      continue;
    }

    // Seek wielder if within detection range
    if (distSq <= soulRangeSq && distSq > 1e-4) {
      const dist = Math.sqrt(distSq);
      const inv = 1 / dist;
      pool.xWorld[i] += dx * inv * seekSpeed * dt;
      pool.yWorld[i] += dy * inv * seekSpeed * dt;
    } else {
      // Natural float / upward drift
      pool.xWorld[i] += pool.velocityXWorld[i] * dt;
      pool.yWorld[i] += pool.velocityYWorld[i] * dt;
      pool.velocityXWorld[i] *= 0.95;
      pool.velocityYWorld[i] *= 0.95;
    }
  }

  return soulsGained;
}
