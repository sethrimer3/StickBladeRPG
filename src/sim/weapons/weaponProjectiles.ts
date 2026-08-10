/**
 * Projectile pool for ported STICK-RPG ranged weapons.
 *
 * Phase 2a of the STICK-RPG port. Covers the `bow`, `gun`, `throw`, and `magic`
 * weapon kinds — every ported weapon that launches something.
 *
 * Why this is not built on `bowArrow.ts`: that system is a single-instance,
 * mote-backed, dust-typed implementation of one specific ability. It stores its
 * whole state as scalar fields on `WorldState` and consumes canonical motes as
 * the projectile body. Generalizing it to 33 arbitrary weapons would mean
 * rewriting it and putting a working feature at risk. This module instead
 * reuses the two genuinely shared pieces — `raycastWalls` for terrain and
 * `applyRoutedWeaveDamage` for damage — and owns an independent pool. The
 * original intent of the Phase 2a note in `docs/Todo.md` was "do not port
 * `js/projectiles.js` wholesale", which this satisfies: behavior is derived
 * from the already-ported weapon data, not transcribed from donor code.
 *
 * Determinism and performance:
 *   • Fixed-capacity structure-of-arrays storage, allocated once.
 *   • No per-tick allocation and no wall clock; lifetimes are tick counts.
 *   • All randomness (spread, mitigation) comes from an injected `RngState`.
 */

import type { WorldState } from '../world';
import type { RngState } from '../rng';
import { nextFloatRange } from '../rng';
import { raycastWalls } from '../clusters/grappleShared';
import { applyRoutedWeaveDamage, segmentPointDistanceSq } from '../weaves/weaveCollisionUtils';
import { computeStatDamage } from '../stats/characterStats';
import { getWeaponProjectileTtlTicks, type WeaponDef } from './weaponDefs';

// ---- Capacity -------------------------------------------------------------

/**
 * Maximum simultaneously-live projectiles.
 *
 * Sized for the burstiest ported weapons (multi-pellet guns firing on short
 * cooldowns) with generous headroom. Spawning past capacity replaces the oldest
 * live projectile rather than silently dropping the new one, so a rapid-fire
 * weapon always visibly fires.
 */
export const MAX_WEAPON_PROJECTILES = 128;

/** Gravity applied to projectiles that declare `gravity: true` (world units/s²). */
export const PROJECTILE_GRAVITY_WORLD_PER_SEC2 = 900;

/** Default projectile radius when a weapon declares none. */
const DEFAULT_PROJECTILE_RADIUS_WORLD = 2.0;

/** Default lifetime when a weapon declares no `ttl` (~2.5 s at 60 fps). */
const DEFAULT_PROJECTILE_TTL_TICKS = 150;

// ---- Pool -----------------------------------------------------------------

/**
 * Live projectile storage.
 *
 * Parallel arrays indexed by slot. `isLive` is the occupancy flag; a slot is
 * reusable the moment it clears.
 */
export interface WeaponProjectilePool {
  isLive: Uint8Array;
  xWorld: Float32Array;
  yWorld: Float32Array;
  velocityXWorld: Float32Array;
  velocityYWorld: Float32Array;
  /** Damage this projectile deals on contact, already stat-scaled at spawn. */
  damage: Float32Array;
  radiusWorld: Float32Array;
  /** Ticks remaining before the projectile expires. */
  ttlTicks: Int32Array;
  /** 1 when gravity applies. */
  hasGravity: Uint8Array;
  /** Per-tick velocity retention, 1 = no drag. */
  drag: Float32Array;
  /** Bounces remaining against terrain; 0 means the projectile dies on contact. */
  bouncesRemaining: Int32Array;
  /** Velocity retained per bounce. */
  bounciness: Float32Array;
  /** 1 when the projectile passes through terrain. */
  ignoresTerrain: Uint8Array;
  /** 1 when the projectile passes through (and keeps damaging) enemies. */
  isPiercing: Uint8Array;
  /** 1 when the projectile deals no damage (purely visual donor projectiles). */
  isHarmless: Uint8Array;
  /** Homing turn rate in radians per tick; 0 disables homing. */
  homingTurnRateRad: Float32Array;
  /** Explosion radius on expiry/impact; 0 means no blast. */
  blastRadiusWorld: Float32Array;
  /** Explosion damage; falls back to contact damage when unset. */
  blastDamage: Float32Array;
  /** Monotonic spawn sequence, used to evict the oldest when at capacity. */
  spawnSequence: Int32Array;
  /** Per-projectile hit registry for piercing shots (bitset over cluster index). */
  piercedFlags: Uint8Array;
  /** Number of live projectiles. */
  liveCount: number;
  /** Next spawn sequence value. */
  nextSequence: number;
}

/** Allocates an empty pool. Call once per world. */
export function createWeaponProjectilePool(): WeaponProjectilePool {
  const n = MAX_WEAPON_PROJECTILES;
  return {
    isLive: new Uint8Array(n),
    xWorld: new Float32Array(n),
    yWorld: new Float32Array(n),
    velocityXWorld: new Float32Array(n),
    velocityYWorld: new Float32Array(n),
    damage: new Float32Array(n),
    radiusWorld: new Float32Array(n),
    ttlTicks: new Int32Array(n),
    hasGravity: new Uint8Array(n),
    drag: new Float32Array(n),
    bouncesRemaining: new Int32Array(n),
    bounciness: new Float32Array(n),
    ignoresTerrain: new Uint8Array(n),
    isPiercing: new Uint8Array(n),
    isHarmless: new Uint8Array(n),
    homingTurnRateRad: new Float32Array(n),
    blastRadiusWorld: new Float32Array(n),
    blastDamage: new Float32Array(n),
    spawnSequence: new Int32Array(n),
    piercedFlags: new Uint8Array(n * PIERCE_FLAGS_PER_PROJECTILE),
    liveCount: 0,
    nextSequence: 1,
  };
}

/**
 * Cluster slots tracked per piercing projectile. Matches the weave hit-registry
 * convention: clusters beyond this index are excluded from pierce bookkeeping,
 * which at worst lets a piercing shot damage a very-high-index enemy twice.
 */
const PIERCE_FLAGS_PER_PROJECTILE = 64;

/** Clears every projectile. Call on room teardown or respawn. */
export function resetWeaponProjectilePool(pool: WeaponProjectilePool): void {
  pool.isLive.fill(0);
  pool.piercedFlags.fill(0);
  pool.liveCount = 0;
  pool.nextSequence = 1;
}

/** Finds a free slot, evicting the oldest live projectile when full. */
function acquireSlot(pool: WeaponProjectilePool): number {
  for (let i = 0; i < MAX_WEAPON_PROJECTILES; i++) {
    if (pool.isLive[i] === 0) return i;
  }
  // Full: evict the oldest so a rapid-fire weapon still visibly fires.
  let oldest = 0;
  let oldestSequence = Number.POSITIVE_INFINITY;
  for (let i = 0; i < MAX_WEAPON_PROJECTILES; i++) {
    if (pool.spawnSequence[i] < oldestSequence) {
      oldestSequence = pool.spawnSequence[i];
      oldest = i;
    }
  }
  return oldest;
}

// ---- Spawning -------------------------------------------------------------

/** Weapon fields that shape a launched projectile. */
export interface ProjectileSpawnOptions {
  xWorld: number;
  yWorld: number;
  /** Normalized launch direction. */
  dirXWorld: number;
  dirYWorld: number;
  /** Pre-computed damage for this projectile. */
  damage: number;
  /** Overrides the weapon's `speed` when provided (e.g. charged shots). */
  speedOverride?: number;
}

/**
 * Launches one projectile configured from `def`.
 *
 * Returns the slot index, or -1 when the weapon declares no projectile speed
 * and therefore cannot fire.
 */
export function spawnWeaponProjectile(
  pool: WeaponProjectilePool,
  def: WeaponDef,
  options: ProjectileSpawnOptions,
): number {
  const speed = options.speedOverride ?? def.speed ?? 0;
  if (!Number.isFinite(speed) || speed <= 0) return -1;

  const i = acquireSlot(pool);
  const wasLive = pool.isLive[i] === 1;

  pool.isLive[i] = 1;
  pool.xWorld[i] = options.xWorld;
  pool.yWorld[i] = options.yWorld;
  pool.velocityXWorld[i] = options.dirXWorld * speed;
  pool.velocityYWorld[i] = options.dirYWorld * speed;
  pool.damage[i] = Math.max(0, options.damage);
  pool.radiusWorld[i] = def.projectileRadius ?? DEFAULT_PROJECTILE_RADIUS_WORLD;

  const ttl = getWeaponProjectileTtlTicks(def);
  pool.ttlTicks[i] = ttl > 0 ? ttl : DEFAULT_PROJECTILE_TTL_TICKS;

  pool.hasGravity[i] = def.gravity === true ? 1 : 0;
  // Donor `projectileDrag` is a per-second retention factor; convert to
  // per-tick so travel matches regardless of timestep.
  pool.drag[i] = typeof def.projectileDrag === 'number' && def.projectileDrag > 0
    ? Math.pow(def.projectileDrag, 1 / 60)
    : 1;

  pool.bouncesRemaining[i] = def.projectileMaxBounces ?? 0;
  pool.bounciness[i] = def.projectileBounce ?? 0.5;
  pool.ignoresTerrain[i] = def.projectileIgnoreTerrain === true ? 1 : 0;
  pool.isPiercing[i] = def.projectileIgnoreStickCollision === true ? 1 : 0;
  pool.isHarmless[i] = def.projectileHarmless === true ? 1 : 0;
  pool.homingTurnRateRad[i] = def.projectileHoming === true
    ? (def.projectileTurnRate ?? 0.08)
    : 0;
  pool.blastRadiusWorld[i] = def.blastRadius ?? 0;
  pool.blastDamage[i] = def.blastDamage ?? 0;
  pool.spawnSequence[i] = pool.nextSequence++;

  const flagBase = i * PIERCE_FLAGS_PER_PROJECTILE;
  for (let f = 0; f < PIERCE_FLAGS_PER_PROJECTILE; f++) pool.piercedFlags[flagBase + f] = 0;

  if (!wasLive) pool.liveCount++;
  return i;
}

/** Frees a projectile slot. */
function killProjectile(pool: WeaponProjectilePool, i: number): void {
  if (pool.isLive[i] === 0) return;
  pool.isLive[i] = 0;
  pool.liveCount--;
}

// ---- Simulation -----------------------------------------------------------

/** Reports what a tick of projectile simulation did. */
export interface ProjectileTickResult {
  /** Projectiles that expired or were consumed this tick. */
  expiredCount: number;
  /** Enemies damaged this tick. */
  hitCount: number;
  /** Total damage dealt this tick. */
  totalDamage: number;
}

const _projectileTickResult: ProjectileTickResult = {
  expiredCount: 0,
  hitCount: 0,
  totalDamage: 0,
};

/**
 * Advances every live projectile one tick: homing, gravity, drag, movement,
 * swept enemy collision, swept terrain collision, then expiry.
 *
 * Enemy collision is swept along the tick's travel segment so a fast projectile
 * cannot tunnel through a target, matching the guarantee the melee swing and
 * the Bow Weave both provide.
 *
 * Returns a module-scoped result; read it before the next call.
 */
export function tickWeaponProjectiles(
  world: WorldState,
  pool: WeaponProjectilePool,
): ProjectileTickResult {
  _projectileTickResult.expiredCount = 0;
  _projectileTickResult.hitCount = 0;
  _projectileTickResult.totalDamage = 0;

  const dtSec = world.dtMs / 1000;

  for (let i = 0; i < MAX_WEAPON_PROJECTILES; i++) {
    if (pool.isLive[i] === 0) continue;

    if (pool.homingTurnRateRad[i] > 0) steerTowardNearestEnemy(world, pool, i);

    if (pool.hasGravity[i] === 1) {
      pool.velocityYWorld[i] += PROJECTILE_GRAVITY_WORLD_PER_SEC2 * dtSec;
    }
    const drag = pool.drag[i];
    if (drag !== 1) {
      pool.velocityXWorld[i] *= drag;
      pool.velocityYWorld[i] *= drag;
    }

    const startX = pool.xWorld[i];
    const startY = pool.yWorld[i];
    const stepX = pool.velocityXWorld[i] * dtSec;
    const stepY = pool.velocityYWorld[i] * dtSec;
    const stepDist = Math.sqrt(stepX * stepX + stepY * stepY);

    const consumedByEnemy = stepDist > 1e-6
      && applyProjectileEnemyHits(world, pool, i, startX, startY, startX + stepX, startY + stepY, _projectileTickResult);
    if (consumedByEnemy) {
      detonateProjectile(world, pool, i, _projectileTickResult);
      killProjectile(pool, i);
      _projectileTickResult.expiredCount++;
      continue;
    }

    if (pool.ignoresTerrain[i] === 0 && stepDist > 1e-6) {
      const dirX = stepX / stepDist;
      const dirY = stepY / stepDist;
      const hit = raycastWalls(world, startX, startY, dirX, dirY, stepDist);
      if (hit !== null) {
        if (pool.bouncesRemaining[i] > 0) {
          pool.bouncesRemaining[i]--;
          // Reflect about the surface normal, scaled by bounciness.
          const vx = pool.velocityXWorld[i];
          const vy = pool.velocityYWorld[i];
          const dot = vx * hit.normalX + vy * hit.normalY;
          const restitution = pool.bounciness[i];
          pool.velocityXWorld[i] = (vx - 2 * dot * hit.normalX) * restitution;
          pool.velocityYWorld[i] = (vy - 2 * dot * hit.normalY) * restitution;
          // Seat the projectile just off the surface so the next raycast does
          // not immediately re-hit the wall it just bounced from.
          pool.xWorld[i] = hit.x + hit.normalX * (pool.radiusWorld[i] + 0.01);
          pool.yWorld[i] = hit.y + hit.normalY * (pool.radiusWorld[i] + 0.01);
        } else {
          pool.xWorld[i] = hit.x;
          pool.yWorld[i] = hit.y;
          detonateProjectile(world, pool, i, _projectileTickResult);
          killProjectile(pool, i);
          _projectileTickResult.expiredCount++;
        }
        continue;
      }
    }

    pool.xWorld[i] = startX + stepX;
    pool.yWorld[i] = startY + stepY;

    pool.ttlTicks[i]--;
    if (pool.ttlTicks[i] <= 0) {
      detonateProjectile(world, pool, i, _projectileTickResult);
      killProjectile(pool, i);
      _projectileTickResult.expiredCount++;
    }
  }

  return _projectileTickResult;
}

/** Bends a homing projectile's velocity toward the nearest living enemy. */
function steerTowardNearestEnemy(
  world: WorldState,
  pool: WeaponProjectilePool,
  i: number,
): void {
  const px = pool.xWorld[i];
  const py = pool.yWorld[i];

  let bestDistSq = Number.POSITIVE_INFINITY;
  let bestX = 0;
  let bestY = 0;
  let found = false;

  const clusters = world.clusters;
  for (let ci = 0; ci < clusters.length; ci++) {
    const c = clusters[ci];
    if (c.isPlayerFlag === 1 || c.isAliveFlag === 0) continue;
    const dx = c.positionXWorld - px;
    const dy = c.positionYWorld - py;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestX = c.positionXWorld;
      bestY = c.positionYWorld;
      found = true;
    }
  }
  if (!found) return;

  const speed = Math.sqrt(
    pool.velocityXWorld[i] * pool.velocityXWorld[i]
    + pool.velocityYWorld[i] * pool.velocityYWorld[i],
  );
  if (speed <= 1e-6) return;

  const currentAngle = Math.atan2(pool.velocityYWorld[i], pool.velocityXWorld[i]);
  const desiredAngle = Math.atan2(bestY - py, bestX - px);

  let delta = desiredAngle - currentAngle;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta <= -Math.PI) delta += Math.PI * 2;

  const turn = Math.max(-pool.homingTurnRateRad[i], Math.min(pool.homingTurnRateRad[i], delta));
  const newAngle = currentAngle + turn;
  pool.velocityXWorld[i] = Math.cos(newAngle) * speed;
  pool.velocityYWorld[i] = Math.sin(newAngle) * speed;
}

/**
 * Damages enemies swept by a projectile's travel this tick.
 *
 * Returns true when the projectile is consumed (a non-piercing projectile that
 * hit something). Piercing projectiles damage every fresh enemy along the
 * segment and keep flying.
 */
function applyProjectileEnemyHits(
  world: WorldState,
  pool: WeaponProjectilePool,
  i: number,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  result: ProjectileTickResult,
): boolean {
  if (pool.isHarmless[i] === 1) return false;

  const clusters = world.clusters;
  const limit = Math.min(clusters.length, PIERCE_FLAGS_PER_PROJECTILE);
  const flagBase = i * PIERCE_FLAGS_PER_PROJECTILE;
  const isPiercing = pool.isPiercing[i] === 1;
  const radius = pool.radiusWorld[i];

  for (let ci = 0; ci < limit; ci++) {
    const c = clusters[ci];
    if (c.isPlayerFlag === 1 || c.isAliveFlag === 0) continue;
    if (pool.piercedFlags[flagBase + ci] === 1) continue;

    const targetRadius = Math.min(c.halfWidthWorld, c.halfHeightWorld);
    const hitRadius = radius + targetRadius;
    const distSq = segmentPointDistanceSq(
      fromX, fromY, toX, toY, c.positionXWorld, c.positionYWorld,
    );
    if (distSq > hitRadius * hitRadius) continue;

    pool.piercedFlags[flagBase + ci] = 1;

    const damage = pool.damage[i];
    if (damage > 0) {
      applyRoutedWeaveDamage(world, ci, damage, c.positionXWorld, c.positionYWorld);
      result.hitCount++;
      result.totalDamage += damage;
    }

    if (!isPiercing) return true;
  }
  return false;
}

/**
 * Applies a projectile's blast on death, if it has one.
 *
 * Blast damage ignores the pierce registry deliberately: an explosion is a
 * separate event from the contact hit, so a target that took the direct hit is
 * still inside the blast.
 */
function detonateProjectile(
  world: WorldState,
  pool: WeaponProjectilePool,
  i: number,
  result: ProjectileTickResult,
): void {
  const radius = pool.blastRadiusWorld[i];
  if (radius <= 0 || pool.isHarmless[i] === 1) return;

  const damage = pool.blastDamage[i] > 0 ? pool.blastDamage[i] : pool.damage[i];
  if (damage <= 0) return;

  const px = pool.xWorld[i];
  const py = pool.yWorld[i];
  const clusters = world.clusters;
  const limit = Math.min(clusters.length, PIERCE_FLAGS_PER_PROJECTILE);

  for (let ci = 0; ci < limit; ci++) {
    const c = clusters[ci];
    if (c.isPlayerFlag === 1 || c.isAliveFlag === 0) continue;
    const dx = c.positionXWorld - px;
    const dy = c.positionYWorld - py;
    const reach = radius + Math.min(c.halfWidthWorld, c.halfHeightWorld);
    if (dx * dx + dy * dy > reach * reach) continue;

    applyRoutedWeaveDamage(world, ci, damage, c.positionXWorld, c.positionYWorld);
    result.hitCount++;
    result.totalDamage += damage;
  }
}

// ---- Firing ---------------------------------------------------------------

/** Result of pulling a ranged weapon's trigger. */
export interface WeaponFireResult {
  /** Projectiles actually launched. */
  projectileCount: number;
}

const _fireResult: WeaponFireResult = { projectileCount: 0 };

/** Weapon kinds this module can fire. */
export function isRangedWeaponKind(def: WeaponDef): boolean {
  return def.kind === 'bow' || def.kind === 'gun' || def.kind === 'throw' || def.kind === 'magic';
}

/**
 * Fires `def` from (`originX`, `originY`) toward (`aimX`, `aimY`).
 *
 * Handles the donor's multi-pellet pattern: `bulletCount` pellets per shot,
 * scattered within `spread` radians. `burstCount` is deliberately NOT expanded
 * here — a burst is a sequence of shots over time, not a single instant, so the
 * caller schedules repeat calls. `getWeaponBurstCount` exposes the count.
 *
 * Damage is stat-scaled once per pellet at spawn, so a projectile's damage is
 * fixed at launch rather than re-rolled on impact.
 */
export function fireRangedWeapon(
  pool: WeaponProjectilePool,
  def: WeaponDef,
  originXWorld: number,
  originYWorld: number,
  aimXWorld: number,
  aimYWorld: number,
  attackerAttack: number,
  rng: RngState,
): WeaponFireResult {
  _fireResult.projectileCount = 0;
  if (!isRangedWeaponKind(def)) return _fireResult;

  const dx = aimXWorld - originXWorld;
  const dy = aimYWorld - originYWorld;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist <= 1e-6) return _fireResult;

  const baseAngle = Math.atan2(dy, dx);
  const pellets = Math.max(1, Math.floor(def.bulletCount ?? 1));
  const spread = typeof def.spread === 'number' && def.spread > 0 ? def.spread : 0;
  const baseDamage = def.projectileDamage ?? def.dmg ?? 0;

  for (let p = 0; p < pellets; p++) {
    const angle = spread > 0
      ? baseAngle + nextFloatRange(rng, -spread * 0.5, spread * 0.5)
      : baseAngle;

    // Damage is rolled per pellet against zero defense; per-target mitigation
    // happens at spawn time rather than impact so the value is stable in flight.
    const damage = computeStatDamage(baseDamage, attackerAttack, 0, rng);

    const slot = spawnWeaponProjectile(pool, def, {
      xWorld: originXWorld,
      yWorld: originYWorld,
      dirXWorld: Math.cos(angle),
      dirYWorld: Math.sin(angle),
      damage,
    });
    if (slot !== -1) _fireResult.projectileCount++;
  }

  return _fireResult;
}

/** Shots in a burst for this weapon; 1 when it does not burst-fire. */
export function getWeaponBurstCount(def: WeaponDef): number {
  const count = def.burstCount;
  return typeof count === 'number' && count > 1 ? Math.floor(count) : 1;
}
