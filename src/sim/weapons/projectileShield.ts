/**
 * The Aegis Stave's intercepting ward.
 *
 * Phase 2e of the STICK-RPG port. `aegisStaff` declares
 * `staff.aura.projectileShield { maxHpFactor, regenPercent, minRadius }` — a
 * bubble around the wielder that soaks incoming damage until its own hit points
 * run out, then regenerates.
 *
 * Deviation from the donor, deliberate: the donor ward intercepts *projectile
 * entities*, because in that engine every hostile attack is one. StickBlade has
 * no single hostile-projectile type — spikes, lava, contact hits, wizard bolts,
 * and poison all reach the player through `applyPlayerDamageWithKnockback` —
 * so the ward is expressed where all of those converge: as a damage pool
 * consumed before the player's motes. That keeps one implementation instead of
 * one per enemy AI, and it cannot miss a damage source.
 *
 * The ward exists only while the staff is channelling. Its capacity is derived
 * from the wielder's max health (`maxHpFactor`), so it scales with Phase 1
 * stats rather than carrying a flat number.
 *
 * Deterministic and allocation-free per tick; regeneration is integrated from
 * `dtMs` and the hit flash is a tick countdown.
 */

import { absorbWithWard, type DamageAbsorbingWard } from '../playerDamage';
import type { WeaponDef } from './weaponDefs';

/** Fallback capacity multiplier when the donor block omits `maxHpFactor`. */
const DEFAULT_MAX_HP_FACTOR = 1;

/** Fallback max health when the wielder carries no stat record. */
const DEFAULT_WIELDER_MAX_HEALTH = 10;

// ---- Config ---------------------------------------------------------------

/** The donor `aura.projectileShield` block, read defensively. */
export interface ProjectileShieldConfig {
  /** Ward capacity as a multiple of the wielder's max health. */
  maxHpFactor: number;
  /** Fraction of capacity regenerated per second while channelling. */
  regenPercent: number;
  /** Floor on the ward radius, independent of the aura radius. */
  minRadiusWorld: number;
  color: string;
  outlineColor: string;
  hitColor: string;
}

function readNumber(config: Readonly<Record<string, unknown>> | undefined, key: string): number | undefined {
  const value = config?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readString(config: Readonly<Record<string, unknown>> | undefined, key: string): string | undefined {
  const value = config?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readObject(
  config: Readonly<Record<string, unknown>> | undefined,
  key: string,
): Readonly<Record<string, unknown>> | undefined {
  const value = config?.[key];
  return typeof value === 'object' && value !== null
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

/**
 * Reads a weapon's ward configuration, or null when it declares none.
 *
 * Every field is read through a checked accessor rather than trusted: the
 * `staff` block travels as an opaque record in the weapon data, so a malformed
 * or partial block must degrade to defaults, not throw.
 */
export function getProjectileShieldConfig(def: WeaponDef | null): ProjectileShieldConfig | null {
  if (def === null || def.kind !== 'staff') return null;
  const shield = readObject(readObject(def.staff, 'aura'), 'projectileShield');
  if (shield === undefined) return null;

  return {
    maxHpFactor: readNumber(shield, 'maxHpFactor') ?? DEFAULT_MAX_HP_FACTOR,
    regenPercent: readNumber(shield, 'regenPercent') ?? 0,
    minRadiusWorld: readNumber(shield, 'minRadius') ?? 0,
    color: readString(shield, 'color') ?? 'rgba(160, 220, 255, 0.35)',
    outlineColor: readString(shield, 'outlineColor') ?? 'rgba(70, 130, 190, 0.82)',
    hitColor: readString(shield, 'hitColor') ?? 'rgba(220, 245, 255, 0.9)',
  };
}

// ---- State ----------------------------------------------------------------

/**
 * Live ward state.
 *
 * Structurally satisfies `PlayerDamageTarget.projectileShield`, so the damage
 * pipeline consumes it without importing this module.
 */
export interface ProjectileShieldState extends DamageAbsorbingWard {
  /** Remaining absorption, 0..maxHitPoints. */
  hitPoints: number;
  maxHitPoints: number;
  /** Ward radius in world units. */
  radiusWorld: number;
  /** 1 while the ward is up and able to absorb. */
  isActiveFlag: 0 | 1;
  /** Ticks remaining on the impact flash — read by the renderer. */
  hitFlashTicks: number;
}

/** Allocates a down, empty ward. */
export function createProjectileShieldState(): ProjectileShieldState {
  return {
    hitPoints: 0,
    maxHitPoints: 0,
    radiusWorld: 0,
    isActiveFlag: 0,
    hitFlashTicks: 0,
  };
}

/** Drops the ward. Called on room change, respawn, and weapon swap. */
export function resetProjectileShieldState(state: ProjectileShieldState): void {
  state.hitPoints = 0;
  state.maxHitPoints = 0;
  state.isActiveFlag = 0;
  state.hitFlashTicks = 0;
}

// ---- Per-tick -------------------------------------------------------------

/**
 * Advances the ward one tick.
 *
 * Raising the ward fills it to capacity once; while it stays up it regenerates
 * at `regenPercent` of capacity per second. Dropping the channel takes the ward
 * down and discards its remaining points, so a ward cannot be banked between
 * channels — the donor's ward is likewise tied to the aura being active.
 *
 * `wielderMaxHealth` sets capacity, so a levelled wielder wards more.
 */
export function tickProjectileShield(
  state: ProjectileShieldState,
  def: WeaponDef | null,
  isChannelling: boolean,
  wielderMaxHealth: number,
  auraRadiusWorld: number,
  dtMs: number,
): void {
  if (state.hitFlashTicks > 0) state.hitFlashTicks--;

  const config = getProjectileShieldConfig(def);
  if (config === null || !isChannelling) {
    if (state.isActiveFlag === 1) resetProjectileShieldState(state);
    return;
  }

  const maxHealth = Number.isFinite(wielderMaxHealth) && wielderMaxHealth > 0
    ? wielderMaxHealth
    : DEFAULT_WIELDER_MAX_HEALTH;
  const capacity = Math.max(1, maxHealth * config.maxHpFactor);

  state.maxHitPoints = capacity;
  state.radiusWorld = Math.max(config.minRadiusWorld, auraRadiusWorld);

  if (state.isActiveFlag === 0) {
    // Raising the ward fills it, so a re-channel after a broken ward is a real
    // recovery rather than resuming at zero.
    state.isActiveFlag = 1;
    state.hitPoints = capacity;
    return;
  }

  if (config.regenPercent > 0 && state.hitPoints < capacity) {
    state.hitPoints = Math.min(
      capacity,
      state.hitPoints + capacity * config.regenPercent * (dtMs / 1000),
    );
  }
}

// ---- Absorption -----------------------------------------------------------

/**
 * Spends ward points against an incoming hit and returns the damage that gets
 * through.
 *
 * A ward reduced to zero stays up but empty: it refills through regeneration
 * while the channel continues, matching the donor's `regenPercent` behavior.
 */
export function absorbWithProjectileShield(
  state: ProjectileShieldState,
  damagePoints: number,
): number {
  return absorbWithWard(state, damagePoints);
}
