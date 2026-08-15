/**
 * Per-weapon resource pools — Ammo, Dust, and Mana.
 *
 * Three pools, one per weapon family, each drawn from as that family attacks:
 *
 *   - **Ammo** — `kind: 'gun'`. One unit per shot, and one per *burst* shot, so
 *     a three-round burst costs three.
 *   - **Dust** — the StickBlade weave weapons (any weapon declaring
 *     `weaveDust`). Checked before `kind`, because a weave bow is still a bow:
 *     what it spends is decided by what it is woven from, not how it is held.
 *   - **Mana** — `kind: 'magic'` and `kind: 'staff'`. Magic weapons pay a cost
 *     per cast; staves instead drain continuously while channelling, since they
 *     hold a beam open rather than firing discrete shots.
 *
 * Maximum capacity is not stored here — it comes from the stat tracks in
 * `progression/statBoosts.ts`, so a `+1 Ammo` pickup raises the magazine and a
 * `+5% Mana` pickup widens the mana pool. `syncWeaponResourceMaxes` is what
 * carries those totals in.
 *
 * All three pools regenerate passively. That is deliberate for this first pass:
 * there are no reload, ammo-pickup, or mana-potion systems yet, so a pool that
 * only ever drained would leave a gun permanently useless after its first
 * magazine. Rates are per second and differ per pool
 * (`RESOURCE_REGEN_PER_SECOND`).
 *
 * Pure and deterministic: regeneration advances off the simulation's `dtMs`,
 * never a wall clock, and fractional regen is carried in an accumulator so the
 * pool advances identically regardless of frame pacing.
 */

import type { WeaponDef } from './weaponDefs';
import {
  BASE_STAT_VALUES,
  resolveStatTrack,
  type PlayerStatBoosts,
} from '../../progression/statBoosts';
import type { CharacterStats } from '../stats/characterStats';

// ---- Kinds ----------------------------------------------------------------

/** Which pool a weapon draws from. */
export type WeaponResourceKind = 'ammo' | 'dust' | 'mana';

/** All three, in a stable order for iteration. */
export const ALL_WEAPON_RESOURCE_KINDS: readonly WeaponResourceKind[] = ['ammo', 'dust', 'mana'];

/**
 * Returns the pool `def` spends from, or null when it spends nothing.
 *
 * Melee, bows, shields, throwables, summoners, and spirit weapons are all
 * unmetered — only the three families above pay a resource.
 */
export function getWeaponResourceKind(def: WeaponDef | null): WeaponResourceKind | null {
  if (def === null) return null;
  // Woven-ness wins over grip: a weave bow spends Dust, not Ammo.
  if (typeof def.weaveDust === 'number') return 'dust';
  if (def.kind === 'gun') return 'ammo';
  if (def.kind === 'magic' || def.kind === 'staff') return 'mana';
  return null;
}

/** Default cost per attack, per pool, when a weapon declares no `resourceCost`. */
export const DEFAULT_RESOURCE_COST: Readonly<Record<WeaponResourceKind, number>> = {
  ammo: 1,
  dust: 1,
  mana: 2,
};

/**
 * Mana a staff drains per second of channelling.
 *
 * Staves are the one family that pays over time rather than per action, so this
 * is a rate, not a cost. A staff still needs one full `DEFAULT_RESOURCE_COST`
 * worth of mana on hand to *begin* channelling, so an empty pool cannot open a
 * beam that immediately dies.
 */
export const STAFF_MANA_DRAIN_PER_SECOND = 6;

/** Passive refill rate per second, per pool. */
export const RESOURCE_REGEN_PER_SECOND: Readonly<Record<WeaponResourceKind, number>> = {
  // Slowest: a gun should feel like it runs dry and has to be paced.
  ammo: 0.75,
  dust: 1.5,
  mana: 2.5,
};

/** What one attack with `def` costs from its pool. Zero when unmetered. */
export function getWeaponResourceCost(def: WeaponDef | null): number {
  const kind = getWeaponResourceKind(def);
  if (kind === null || def === null) return 0;
  const authored = def.resourceCost;
  if (typeof authored === 'number' && Number.isFinite(authored) && authored >= 0) {
    return authored;
  }
  return DEFAULT_RESOURCE_COST[kind];
}

// ---- Pools ----------------------------------------------------------------

/** One resource pool. */
export interface WeaponResourcePool {
  /** Units on hand, never above `max` or below 0. */
  current: number;
  /** Capacity, resolved from the matching stat track. */
  max: number;
  /**
   * Sub-unit regeneration carried between ticks.
   *
   * Without this a 0.75/second rate would floor to zero every tick and the pool
   * would never refill at all.
   */
  regenAccumulator: number;
}

/** All three pools. */
export type WeaponResourcePools = Record<WeaponResourceKind, WeaponResourcePool>;

function createPool(kind: WeaponResourceKind): WeaponResourcePool {
  const base = BASE_STAT_VALUES[kind];
  return { current: base, max: base, regenAccumulator: 0 };
}

/** Allocates pools initialized to baseline capacity. Capacity updates via syncWeaponResourceMaxes. */
export function createWeaponResourcePools(): WeaponResourcePools {
  return {
    ammo: createPool('ammo'),
    dust: createPool('dust'),
    mana: createPool('mana'),
  };
}

/**
 * Updates capacity from the player's stat tracks, clamping current down to fit.
 *
 * Pools are created at baseline capacity, so in practice this only ever
 * adjusts an already-established pool: growing one raises the ceiling without
 * topping it up, so a `+5% Ammo` pickup is not a free reload, and shrinking one
 * clamps the current value down to fit. The zero-capacity branch remains as a
 * guard for a pool that somehow arrives empty — it fills rather than leaving
 * the player unable to fire until regeneration catches up.
 */
export function syncWeaponResourceMaxes(
  pools: WeaponResourcePools,
  boosts: PlayerStatBoosts | null | undefined,
  stats?: CharacterStats | null,
): void {
  if (!boosts) return;
  for (const kind of ALL_WEAPON_RESOURCE_KINDS) {
    const pool = pools[kind];
    const wasUninitialized = pool.max <= 0;
    pool.max = resolveStatTrack(kind, boosts, stats ?? undefined).total;
    pool.current = wasUninitialized ? pool.max : Math.min(pool.current, pool.max);
  }
}

/** Refills every pool. Used on room activation and respawn. */
export function refillWeaponResources(pools: WeaponResourcePools): void {
  for (const kind of ALL_WEAPON_RESOURCE_KINDS) {
    pools[kind].current = pools[kind].max;
    pools[kind].regenAccumulator = 0;
  }
}

// ---- Spending -------------------------------------------------------------

/**
 * True when the pool backing `def` can cover one attack.
 *
 * Unmetered weapons always return true, so callers can gate every attack on
 * this without special-casing melee.
 */
export function canAffordWeaponAttack(
  pools: WeaponResourcePools,
  def: WeaponDef | null,
): boolean {
  const kind = getWeaponResourceKind(def);
  if (kind === null) return true;
  return pools[kind].current >= getWeaponResourceCost(def);
}

/**
 * Deducts one attack's cost, returning false and changing nothing when the pool
 * is short.
 *
 * Callers should treat a false return as "the attack did not happen" — this is
 * the single gate that keeps a dry weapon from firing.
 */
export function spendWeaponResource(
  pools: WeaponResourcePools,
  def: WeaponDef | null,
): boolean {
  const kind = getWeaponResourceKind(def);
  if (kind === null) return true;
  const cost = getWeaponResourceCost(def);
  const pool = pools[kind];
  if (pool.current < cost) return false;
  pool.current -= cost;
  return true;
}

/**
 * Drains a channelling staff's mana for `dtMs` of held beam.
 *
 * Returns false once the pool cannot pay for the elapsed slice, which is the
 * caller's signal to release the channel. Partial payment is taken before
 * reporting empty, so the beam runs right up to the last unit rather than
 * cutting out with mana to spare.
 */
export function drainChannelledMana(
  pools: WeaponResourcePools,
  dtMs: number,
): boolean {
  if (!Number.isFinite(dtMs) || dtMs <= 0) return true;
  const pool = pools.mana;
  const cost = STAFF_MANA_DRAIN_PER_SECOND * (dtMs / 1000);
  if (pool.current <= 0) return false;
  pool.current = Math.max(0, pool.current - cost);
  return pool.current > 0;
}

// ---- Regeneration ---------------------------------------------------------

/**
 * Advances passive regeneration by `dtMs`.
 *
 * `skipKind` suppresses one pool for this tick — passed while a staff is
 * actively channelling so mana does not regenerate into the same drain that is
 * emptying it, which would otherwise let a staff channel forever at a net rate
 * the design never intended.
 */
export function tickWeaponResourceRegen(
  pools: WeaponResourcePools,
  dtMs: number,
  skipKind: WeaponResourceKind | null = null,
): void {
  if (!Number.isFinite(dtMs) || dtMs <= 0) return;
  const seconds = dtMs / 1000;

  for (const kind of ALL_WEAPON_RESOURCE_KINDS) {
    if (kind === skipKind) continue;
    const pool = pools[kind];
    if (pool.max <= 0 || pool.current >= pool.max) {
      pool.regenAccumulator = 0;
      continue;
    }

    pool.regenAccumulator += RESOURCE_REGEN_PER_SECOND[kind] * seconds;
    const whole = Math.floor(pool.regenAccumulator);
    if (whole > 0) {
      pool.regenAccumulator -= whole;
      pool.current = Math.min(pool.max, pool.current + whole);
    }
  }
}
