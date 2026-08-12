/**
 * Summoned familiars for `kind: 'summoner'` weapons.
 *
 * Phase 2f of the STICK-RPG port. A summoner weapon casts `summonCharges`
 * familiars at once, up to `maxActiveSummons`; each seeks the nearest enemy,
 * damages it on contact, and expires after `summonLifetime`.
 *
 * Why a dedicated pool rather than allied `ClusterState` entities: clusters
 * carry invariants this system has no business touching — room-completion
 * counting (`countsTowardRoomCompletionFlag`), enemy AI target selection, the
 * 64-slot reusable snapshot cluster pool, and the player-damage router. Adding
 * allied clusters would risk enemies targeting the player's own summons and
 * room completion miscounting. A self-contained pool matches the pattern
 * already established by `weaponProjectiles.ts` and cannot disturb any of that.
 *
 * Locomotion is data-driven, not hardcoded per form: a familiar that declares
 * `summonClimbLift` is treated as a grounded hopper (bird, spider), and one
 * that does not is a pure flier (bee). See `SUMMON_LOCOMOTION_*`.
 *
 * Deterministic and allocation-free per tick; lifetimes are tick counts.
 */

import type { WorldState } from '../world';
import type { RngState } from '../rng';
import { raycastWalls } from '../clusters/grappleShared';
import { applyRoutedWeaveDamage } from '../weaves/weaveCollisionUtils';
import { computeStatDamage } from '../stats/characterStats';
import { millisecondsToTicks, type WeaponDef } from './weaponDefs';
import type { RaiseOnDeathConfig } from './staffChannel';

// ---- Capacity -------------------------------------------------------------

/**
 * Maximum simultaneously-live summons.
 *
 * The greediest ported summoner (`apiaryLexicon`) allows 20 active bees; this
 * leaves headroom for a future second summoner without resizing.
 */
export const MAX_ACTIVE_SUMMONS = 32;

/** Gravity applied to grounded familiars (world units/s²). */
const SUMMON_GRAVITY_WORLD_PER_SEC2 = 900;

/** Ticks a familiar must wait between damaging hits, so contact is not per-tick. */
const SUMMON_HIT_COOLDOWN_TICKS = 30;

/** Fallback lifetime when a weapon declares none (~10 s). */
const DEFAULT_SUMMON_LIFETIME_TICKS = 600;

/** Fallback body radius when a weapon declares none. */
const DEFAULT_SUMMON_RADIUS_WORLD = 12;

/** Fallback travel speed when a weapon declares none. */
const DEFAULT_SUMMON_SPEED = 420;

// ---- Locomotion -----------------------------------------------------------

/** Flies freely toward its target, ignoring gravity. */
export const SUMMON_LOCOMOTION_FLIER = 0;
/** Falls under gravity and hops toward its target. */
export const SUMMON_LOCOMOTION_HOPPER = 1;

export type SummonLocomotion =
  | typeof SUMMON_LOCOMOTION_FLIER
  | typeof SUMMON_LOCOMOTION_HOPPER;

/**
 * Chooses locomotion from the weapon's own data.
 *
 * `summonClimbLift` / `summonJumpStrength` only appear on the donor's grounded
 * forms (bird, spider); the purely airborne bee declares drag and bounce
 * instead. Deriving from the data rather than switching on `summonForm` means a
 * new donor form behaves sensibly without touching this file.
 */
export function getSummonLocomotion(def: WeaponDef): SummonLocomotion {
  return typeof def.summonClimbLift === 'number' || typeof def.summonJumpStrength === 'number'
    ? SUMMON_LOCOMOTION_HOPPER
    : SUMMON_LOCOMOTION_FLIER;
}

// ---- Pool -----------------------------------------------------------------

/** Live summon storage, parallel arrays indexed by slot. */
export interface SummonPool {
  isLive: Uint8Array;
  xWorld: Float32Array;
  yWorld: Float32Array;
  velocityXWorld: Float32Array;
  velocityYWorld: Float32Array;
  /** Contact damage, stat-scaled once at summon time. */
  damage: Float32Array;
  radiusWorld: Float32Array;
  /** Ticks remaining before this familiar expires. */
  lifetimeTicks: Int32Array;
  /** Ticks until this familiar may damage again. */
  hitCooldownTicks: Int32Array;
  locomotion: Uint8Array;
  /** Steering acceleration toward the target. */
  seekForce: Float32Array;
  maxSpeed: Float32Array;
  /** Per-tick velocity retention (1 = no drag). */
  drag: Float32Array;
  /** Velocity retained when bouncing off terrain. */
  bounciness: Float32Array;
  /** Upward impulse a hopper uses to close vertical distance. */
  climbLift: Float32Array;
  /** Knockback scale applied to damaged enemies. */
  knockScale: Float32Array;
  /** Monotonic spawn sequence, used to evict the oldest at capacity. */
  spawnSequence: Int32Array;
  /** 1 when this familiar is an empowered Guardian, 0 for regular. */
  isGuardian: Uint8Array;
  /** 1 when this familiar is a raised thrall rather than a called familiar. */
  isThrall: Uint8Array;
  /** Hit charges remaining before familiar dissipates. */
  multiHitCount: Uint8Array;
  liveCount: number;
  nextSequence: number;
}

/** Allocates an empty summon pool. Call once per world. */
export function createSummonPool(): SummonPool {
  const n = MAX_ACTIVE_SUMMONS;
  return {
    isLive: new Uint8Array(n),
    xWorld: new Float32Array(n),
    yWorld: new Float32Array(n),
    velocityXWorld: new Float32Array(n),
    velocityYWorld: new Float32Array(n),
    damage: new Float32Array(n),
    radiusWorld: new Float32Array(n),
    lifetimeTicks: new Int32Array(n),
    hitCooldownTicks: new Int32Array(n),
    locomotion: new Uint8Array(n),
    seekForce: new Float32Array(n),
    maxSpeed: new Float32Array(n),
    drag: new Float32Array(n),
    bounciness: new Float32Array(n),
    climbLift: new Float32Array(n),
    knockScale: new Float32Array(n),
    spawnSequence: new Int32Array(n),
    isGuardian: new Uint8Array(n),
    isThrall: new Uint8Array(n),
    multiHitCount: new Uint8Array(n),
    liveCount: 0,
    nextSequence: 1,
  };
}

/** Dismisses every summon. Call on room teardown and respawn. */
export function resetSummonPool(pool: SummonPool): void {
  pool.isLive.fill(0);
  pool.isGuardian.fill(0);
  pool.isThrall.fill(0);
  pool.multiHitCount.fill(0);
  pool.liveCount = 0;
  pool.nextSequence = 1;
}

/** Frees a summon slot. */
function killSummon(pool: SummonPool, i: number): void {
  if (pool.isLive[i] === 0) return;
  pool.isLive[i] = 0;
  pool.liveCount--;
}

/**
 * Finds a free slot, evicting the oldest live summon when the weapon's own
 * `maxActiveSummons` cap is already met.
 *
 * Evicting rather than refusing means a cast always visibly produces new
 * familiars, matching the donor's behavior of the newest summons replacing the
 * stalest ones.
 */
function acquireSummonSlot(pool: SummonPool): number {
  for (let i = 0; i < MAX_ACTIVE_SUMMONS; i++) {
    if (pool.isLive[i] === 0) return i;
  }
  let oldest = 0;
  let oldestSequence = Number.POSITIVE_INFINITY;
  for (let i = 0; i < MAX_ACTIVE_SUMMONS; i++) {
    if (pool.spawnSequence[i] < oldestSequence) {
      oldestSequence = pool.spawnSequence[i];
      oldest = i;
    }
  }
  return oldest;
}

// ---- Summoning ------------------------------------------------------------

/** Result of casting a summoner weapon. */
export interface SummonCastResult {
  /** Familiars actually created. */
  summonedCount: number;
  /** Live familiars after the cast. */
  activeCount: number;
}

const _castResult: SummonCastResult = { summonedCount: 0, activeCount: 0 };

/** True when this weapon summons familiars. */
export function isSummonerWeapon(def: WeaponDef): boolean {
  return def.kind === 'summoner';
}

/** Familiars this weapon allows to be active at once. */
export function getMaxActiveSummons(def: WeaponDef): number {
  const declared = def.maxActiveSummons;
  const value = typeof declared === 'number' && Number.isFinite(declared) ? Math.floor(declared) : 1;
  return Math.max(1, Math.min(MAX_ACTIVE_SUMMONS, value));
}

/**
 * Casts `summonCharges` familiars around (`originX`, `originY`).
 *
 * Familiars are spread evenly around the caster so a multi-charge cast does not
 * stack every familiar on one point. The cast is clamped to the weapon's
 * `maxActiveSummons`: existing familiars are evicted oldest-first to make room.
 */
export function castWeaponSummons(
  pool: SummonPool,
  def: WeaponDef,
  originXWorld: number,
  originYWorld: number,
  attackerAttack: number,
  rng: RngState,
  soulsSpent: number = 0,
): SummonCastResult {
  _castResult.summonedCount = 0;
  _castResult.activeCount = pool.liveCount;
  if (!isSummonerWeapon(def)) return _castResult;

  const isGuardian = soulsSpent > 0;
  const charges = isGuardian ? 1 : Math.max(1, Math.floor(def.summonCharges ?? 1));
  const cap = getMaxActiveSummons(def);
  const locomotion = getSummonLocomotion(def);

  const baseRadius = isGuardian
    ? (def.guardianRadius ?? ((def.summonRadius ?? DEFAULT_SUMMON_RADIUS_WORLD) * 1.6))
    : (def.summonRadius ?? DEFAULT_SUMMON_RADIUS_WORLD);
  const radius = isGuardian ? baseRadius * (1 + soulsSpent * 0.08) : baseRadius;

  const baseDamage = isGuardian
    ? (def.guardianBaseDamage ?? def.summonDamage ?? 2)
    : (def.summonDamage ?? 0);
  const scaledBaseDmg = isGuardian ? baseDamage * (1 + soulsSpent * 0.4) : baseDamage;

  const speed = (def.summonSpeed ?? DEFAULT_SUMMON_SPEED) * (isGuardian ? (1 + soulsSpent * 0.06) : 1);

  const lifetime = millisecondsToTicks(def.summonLifetime);
  const lifetimeTicks = (lifetime > 0 ? lifetime : DEFAULT_SUMMON_LIFETIME_TICKS) * (isGuardian ? 1.5 : 1);
  const multiHits = isGuardian ? Math.max(2, Math.round(2 + soulsSpent * 0.5)) : 1;

  for (let c = 0; c < charges; c++) {
    // Enforce the weapon's own cap before taking a slot, so a 4-charge cast
    // from a 3-summon weapon settles at 3 rather than briefly exceeding it.
    while (pool.liveCount >= cap) {
      const evict = findOldestLiveSummon(pool);
      if (evict === -1) break;
      killSummon(pool, evict);
    }

    const i = acquireSummonSlot(pool);
    const wasLive = pool.isLive[i] === 1;

    // Spread the cast around the caster rather than stacking on one point.
    const angle = (Math.PI * 2 * c) / charges;
    pool.isLive[i] = 1;
    pool.isGuardian[i] = isGuardian ? 1 : 0;
    pool.isThrall[i] = 0;
    pool.multiHitCount[i] = multiHits;
    pool.xWorld[i] = originXWorld + Math.cos(angle) * radius;
    pool.yWorld[i] = originYWorld + Math.sin(angle) * radius;
    pool.velocityXWorld[i] = 0;
    pool.velocityYWorld[i] = 0;
    pool.damage[i] = computeStatDamage(scaledBaseDmg, attackerAttack, 0, rng);
    pool.radiusWorld[i] = radius;
    pool.lifetimeTicks[i] = Math.round(lifetimeTicks);
    pool.hitCooldownTicks[i] = 0;
    pool.locomotion[i] = locomotion;
    pool.seekForce[i] = def.summonSeekForce ?? speed * 4;
    pool.maxSpeed[i] = def.summonMaxSpeed ?? speed;
    // Donor drag is a per-second retention factor; convert to per-tick.
    pool.drag[i] = typeof def.summonDrag === 'number' && def.summonDrag > 0
      ? Math.pow(1 - Math.min(0.99, def.summonDrag), 1 / 60)
      : 1;
    pool.bounciness[i] = def.summonBounce ?? 0.4;
    pool.climbLift[i] = def.summonClimbLift ?? def.summonJumpStrength ?? 0;
    pool.knockScale[i] = (def.summonKnockScale ?? 1) * (isGuardian ? 1.5 : 1);
    pool.spawnSequence[i] = pool.nextSequence++;

    if (!wasLive) pool.liveCount++;
    _castResult.summonedCount++;
  }

  _castResult.activeCount = pool.liveCount;
  return _castResult;
}

// ---- Raise on death (Phase 2e) --------------------------------------------

/**
 * Thralls allowed at once.
 *
 * The donor sets no cap on `raiseOnDeath`, but an uncapped raise in a
 * high-population room would fill the whole 32-slot pool and starve any called
 * familiars, so this port caps thralls at a quarter of the pool.
 */
export const MAX_ACTIVE_THRALLS = 8;

/**
 * Fraction of a felled enemy's max health that becomes its thrall's contact
 * damage. A tougher corpse raises a stronger thrall without needing enemy
 * attack data, which enemies do not carry.
 */
const THRALL_DAMAGE_PER_ENEMY_HEALTH = 0.2;

/** Ceiling on derived thrall damage, so a boss corpse cannot trivialize a room. */
const THRALL_MAX_BASE_DAMAGE = 12;

/**
 * Raises a defeated enemy as a temporary thrall.
 *
 * Phase 2e, porting `gravebindStaff`'s `aura.raiseOnDeath`. The thrall is a
 * familiar in this same pool — it seeks and damages the nearest enemy and
 * expires after `lifetimeMs` — which is exactly the donor's behavior and keeps
 * one simulation instead of two. It reuses the corpse's position and, scaled by
 * `scale`, its size.
 *
 * Two donor fields have no meaning here and are deliberately unused:
 * `defenseMultiplier` and `healthMultiplier` describe a thrall that can be
 * killed, and familiars in this pool take no damage — they expire on a timer.
 * See the module header for why familiars are not clusters.
 *
 * Returns true when a thrall was raised; false when the thrall cap is full.
 */
export function raiseThrallFromCorpse(
  pool: SummonPool,
  config: RaiseOnDeathConfig,
  corpseXWorld: number,
  corpseYWorld: number,
  corpseRadiusWorld: number,
  corpseMaxHealth: number,
  attackerAttack: number,
  rng: RngState,
): boolean {
  if (countLiveThralls(pool) >= MAX_ACTIVE_THRALLS) return false;

  const i = acquireSummonSlot(pool);
  const wasLive = pool.isLive[i] === 1;

  const scale = config.scale > 0 ? config.scale : 1;
  const radius = Math.max(4, corpseRadiusWorld * scale);
  const baseDamage = Math.min(
    THRALL_MAX_BASE_DAMAGE,
    Math.max(1, corpseMaxHealth * THRALL_DAMAGE_PER_ENEMY_HEALTH),
  ) * config.damageMultiplier;

  const lifetime = millisecondsToTicks(config.lifetimeMs);

  pool.isLive[i] = 1;
  pool.isGuardian[i] = 0;
  pool.isThrall[i] = 1;
  pool.multiHitCount[i] = 1;
  pool.xWorld[i] = corpseXWorld;
  pool.yWorld[i] = corpseYWorld;
  pool.velocityXWorld[i] = 0;
  pool.velocityYWorld[i] = 0;
  pool.damage[i] = computeStatDamage(baseDamage, attackerAttack, 0, rng);
  pool.radiusWorld[i] = radius;
  pool.lifetimeTicks[i] = lifetime > 0 ? lifetime : DEFAULT_SUMMON_LIFETIME_TICKS;
  pool.hitCooldownTicks[i] = 0;
  // A raised corpse walks: it keeps the grounded locomotion its body had.
  pool.locomotion[i] = SUMMON_LOCOMOTION_HOPPER;
  pool.seekForce[i] = THRALL_SEEK_FORCE;
  pool.maxSpeed[i] = THRALL_MAX_SPEED;
  pool.drag[i] = 1;
  pool.bounciness[i] = 0.2;
  pool.climbLift[i] = THRALL_CLIMB_LIFT;
  pool.knockScale[i] = 1;
  pool.spawnSequence[i] = pool.nextSequence++;

  if (!wasLive) pool.liveCount++;
  return true;
}

/** Steering acceleration a thrall uses to close on its target. */
const THRALL_SEEK_FORCE = 900;
/** Thrall top speed — slower than a called familiar; a corpse shambles. */
const THRALL_MAX_SPEED = 220;
/** Upward impulse a thrall uses to climb toward a higher target. */
const THRALL_CLIMB_LIFT = 320;

/** Live thralls currently in the pool. */
export function countLiveThralls(pool: SummonPool): number {
  let count = 0;
  for (let i = 0; i < MAX_ACTIVE_SUMMONS; i++) {
    if (pool.isLive[i] === 1 && pool.isThrall[i] === 1) count++;
  }
  return count;
}

/** Index of the longest-lived summon, or -1 when none are live. */
function findOldestLiveSummon(pool: SummonPool): number {
  let oldest = -1;
  let oldestSequence = Number.POSITIVE_INFINITY;
  for (let i = 0; i < MAX_ACTIVE_SUMMONS; i++) {
    if (pool.isLive[i] === 0) continue;
    if (pool.spawnSequence[i] < oldestSequence) {
      oldestSequence = pool.spawnSequence[i];
      oldest = i;
    }
  }
  return oldest;
}

// ---- Simulation -----------------------------------------------------------

/** What a tick of summon simulation did. */
export interface SummonTickResult {
  hitCount: number;
  totalDamage: number;
  expiredCount: number;
}

const _tickResult: SummonTickResult = { hitCount: 0, totalDamage: 0, expiredCount: 0 };

/**
 * Advances every live familiar one tick: seek, move, collide, damage, expire.
 *
 * Returns a module-scoped result; read it before the next call.
 */
export function tickWeaponSummons(
  world: WorldState,
  pool: SummonPool,
): SummonTickResult {
  _tickResult.hitCount = 0;
  _tickResult.totalDamage = 0;
  _tickResult.expiredCount = 0;
  if (pool.liveCount <= 0) return _tickResult;

  const dtSec = world.dtMs / 1000;

  for (let i = 0; i < MAX_ACTIVE_SUMMONS; i++) {
    if (pool.isLive[i] === 0) continue;

    if (pool.hitCooldownTicks[i] > 0) pool.hitCooldownTicks[i]--;

    const targetIndex = findNearestEnemy(world, pool.xWorld[i], pool.yWorld[i]);

    if (targetIndex !== -1) {
      steerTowardTarget(world, pool, i, targetIndex, dtSec);
    } else if (pool.locomotion[i] === SUMMON_LOCOMOTION_FLIER) {
      // Nothing to chase: coast to a stop rather than drifting forever.
      pool.velocityXWorld[i] *= 0.94;
      pool.velocityYWorld[i] *= 0.94;
    }

    if (pool.locomotion[i] === SUMMON_LOCOMOTION_HOPPER) {
      pool.velocityYWorld[i] += SUMMON_GRAVITY_WORLD_PER_SEC2 * dtSec;
    }

    const drag = pool.drag[i];
    if (drag !== 1) {
      pool.velocityXWorld[i] *= drag;
      pool.velocityYWorld[i] *= drag;
    }
    clampSummonSpeed(pool, i);

    moveSummon(world, pool, i, dtSec);

    if (targetIndex !== -1 && pool.hitCooldownTicks[i] <= 0) {
      tryDamageTarget(world, pool, i, targetIndex, _tickResult);
    }

    pool.lifetimeTicks[i]--;
    if (pool.lifetimeTicks[i] <= 0) {
      killSummon(pool, i);
      _tickResult.expiredCount++;
    }
  }

  return _tickResult;
}

/** Nearest living enemy cluster index, or -1 when the room has none. */
function findNearestEnemy(world: WorldState, xWorld: number, yWorld: number): number {
  const clusters = world.clusters;
  let best = -1;
  let bestDistSq = Number.POSITIVE_INFINITY;

  for (let ci = 0; ci < clusters.length; ci++) {
    const c = clusters[ci];
    if (c.isPlayerFlag === 1 || c.isAliveFlag === 0) continue;
    const dx = c.positionXWorld - xWorld;
    const dy = c.positionYWorld - yWorld;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      best = ci;
    }
  }
  return best;
}

/** Accelerates a familiar toward its target, per its locomotion. */
function steerTowardTarget(
  world: WorldState,
  pool: SummonPool,
  i: number,
  targetIndex: number,
  dtSec: number,
): void {
  const target = world.clusters[targetIndex];
  const dx = target.positionXWorld - pool.xWorld[i];
  const dy = target.positionYWorld - pool.yWorld[i];
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist <= 1e-6) return;

  const seek = pool.seekForce[i] * dtSec;

  if (pool.locomotion[i] === SUMMON_LOCOMOTION_FLIER) {
    pool.velocityXWorld[i] += (dx / dist) * seek;
    pool.velocityYWorld[i] += (dy / dist) * seek;
    return;
  }

  // Hoppers steer horizontally and use their climb lift to close vertical
  // distance, but only from the ground — otherwise they would fly.
  pool.velocityXWorld[i] += (dx / dist) * seek;
  const isNearGround = isSummonOnGround(world, pool, i);
  if (isNearGround && dy < -pool.radiusWorld[i]) {
    pool.velocityYWorld[i] = -pool.climbLift[i];
  }
}

/** True when solid geometry sits just below the familiar. */
function isSummonOnGround(world: WorldState, pool: SummonPool, i: number): boolean {
  const probe = pool.radiusWorld[i] + 2;
  return raycastWalls(world, pool.xWorld[i], pool.yWorld[i], 0, 1, probe) !== null;
}

/** Clamps a familiar to its maximum speed. */
function clampSummonSpeed(pool: SummonPool, i: number): void {
  const max = pool.maxSpeed[i];
  if (max <= 0) return;
  const vx = pool.velocityXWorld[i];
  const vy = pool.velocityYWorld[i];
  const speed = Math.sqrt(vx * vx + vy * vy);
  if (speed <= max || speed <= 1e-6) return;
  const scale = max / speed;
  pool.velocityXWorld[i] = vx * scale;
  pool.velocityYWorld[i] = vy * scale;
}

/** Moves a familiar, bouncing it off terrain rather than tunnelling through. */
function moveSummon(world: WorldState, pool: SummonPool, i: number, dtSec: number): void {
  const stepX = pool.velocityXWorld[i] * dtSec;
  const stepY = pool.velocityYWorld[i] * dtSec;
  const stepDist = Math.sqrt(stepX * stepX + stepY * stepY);
  if (stepDist <= 1e-6) return;

  const hit = raycastWalls(
    world, pool.xWorld[i], pool.yWorld[i], stepX / stepDist, stepY / stepDist, stepDist,
  );
  if (hit === null) {
    pool.xWorld[i] += stepX;
    pool.yWorld[i] += stepY;
    return;
  }

  const vx = pool.velocityXWorld[i];
  const vy = pool.velocityYWorld[i];
  const dot = vx * hit.normalX + vy * hit.normalY;
  const restitution = pool.bounciness[i];
  pool.velocityXWorld[i] = (vx - 2 * dot * hit.normalX) * restitution;
  pool.velocityYWorld[i] = (vy - 2 * dot * hit.normalY) * restitution;
  // Seat just off the surface so the next raycast does not re-hit it.
  pool.xWorld[i] = hit.x + hit.normalX * 0.5;
  pool.yWorld[i] = hit.y + hit.normalY * 0.5;
}

/** Damages the target when the familiar is touching it. */
function tryDamageTarget(
  world: WorldState,
  pool: SummonPool,
  i: number,
  targetIndex: number,
  result: SummonTickResult,
): void {
  const target = world.clusters[targetIndex];
  if (target.isAliveFlag === 0) return;

  const dx = target.positionXWorld - pool.xWorld[i];
  const dy = target.positionYWorld - pool.yWorld[i];
  const reach = pool.radiusWorld[i] + Math.min(target.halfWidthWorld, target.halfHeightWorld);
  if (dx * dx + dy * dy > reach * reach) return;

  const damage = pool.damage[i];
  if (damage <= 0) return;

  applyRoutedWeaveDamage(world, targetIndex, damage, target.positionXWorld, target.positionYWorld);
  pool.hitCooldownTicks[i] = SUMMON_HIT_COOLDOWN_TICKS;
  result.hitCount++;
  result.totalDamage += damage;

  // Knock the familiar back off its target so it visibly re-approaches rather
  // than sitting inside the enemy between hits.
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist > 1e-6) {
    const knock = 120 * pool.knockScale[i];
    pool.velocityXWorld[i] = -(dx / dist) * knock;
    pool.velocityYWorld[i] = -(dy / dist) * knock;
  }

  if (pool.multiHitCount[i] > 1) {
    pool.multiHitCount[i]--;
  }
}
