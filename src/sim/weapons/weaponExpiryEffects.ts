/**
 * Bespoke on-expiry effects — the donor's `projectileOnExpire` and
 * `slashWaveOnExpire` callbacks, ported as data.
 *
 * Phase 2d of the STICK-RPG port, and the last unported piece of Phase 2.
 * Twelve weapons declared a JavaScript function for what happens when their
 * projectile or slash wave dies; those functions could not travel in
 * `weaponData.ts` and were listed in `UNPORTED_BEHAVIOR_FIELDS` instead.
 *
 * Reading the donor (`js/weapons.js` lines 1715–1851 and the `trigger*`
 * helpers in `js/projectiles.js`) shows the twelve callbacks are eleven
 * distinct functions — `spawnChronoglassField` is used twice — and every one of
 * them is a thin wrapper over the same shape:
 *
 *   • damage every hostile within a radius, once,
 *   • apply a movement slow for a duration,
 *   • push bodies radially outward and/or lift them upward.
 *
 * None of them is a lingering field, despite the "pollen cloud" and "steam
 * vent" naming — the donor applies its effect exactly once at expiry and then
 * spawns decorative particles. So this port is one parameterized effect rather
 * than five systems, and the donor's five `trigger*` helpers become five sets of
 * numbers. `triggerSteamBurst` calls `triggerPressureBurst` and adds a slow;
 * `triggerPressureBurst` calls `triggerGustBurst` for its radial component. Both
 * compositions are expressed here as a single effect carrying all three fields.
 *
 * The twelfth behavior, `echoRepeater`'s `spawnEchoDiscReturn`, is not an area
 * effect at all — the disc relaunches itself back at its owner. It is flagged
 * with `returnsToOwner` and handled by `weaponProjectiles.ts`, which owns the
 * pool it must respawn into.
 *
 * Deterministic and allocation-free: damage runs through `computeStatDamage`
 * with an injected `RngState`, and durations are converted to ticks here rather
 * than read as milliseconds by simulation code.
 */

import type { WorldState } from '../world';
import type { RngState } from '../rng';
import { computeStatDamage } from '../stats/characterStats';
import { applyRoutedWeaveDamage } from '../weaves/weaveCollisionUtils';
import { millisecondsToTicks, WEAPONS, type WeaponDef } from './weaponDefs';

/**
 * Velocity change per unit of donor force.
 *
 * The donor applies these as `pelvis.addForce`, integrated against a verlet
 * body's mass; StickBlade enemies are AABBs whose velocity is set directly.
 * This factor is tuned so the donor's 1600–2400 force range lands in the same
 * 100–150 world-units/s band as `applyPlayerDamageWithKnockback`'s knockback,
 * which is the closest existing reference for "an attack shoved something".
 */
const IMPULSE_WORLD_PER_SEC_PER_FORCE = 1 / 16;

/** Donor gust bursts push mostly sideways: vertical is 40% of horizontal. */
const GUST_VERTICAL_FRACTION = 0.4;

/**
 * One ported on-expiry effect.
 *
 * Every field is optional in effect: a zero simply contributes nothing, so one
 * struct covers pollen clouds, gusts, pressure bursts, steam, chrono fields, and
 * ink splashes without branching on which donor helper produced it.
 */
export interface ExpiryEffectDef {
  /** Donor helper this came from, for traceability. */
  readonly donorSource: string;
  /** Effect radius in world units. */
  readonly radiusWorld: number;
  /** Base damage before stat scaling; 0 for a purely kinetic effect. */
  readonly damage: number;
  /** Movement multiplier applied to caught enemies; 1 (or 0 fields) means none. */
  readonly slowMultiplier: number;
  /** How long the slow lasts, in donor milliseconds. */
  readonly slowDurationMs: number;
  /** Radial outward shove, in donor force units. */
  readonly pushForce: number;
  /** Upward shove, in donor force units. */
  readonly liftForce: number;
  /** Donor effect color, for the renderer. */
  readonly color: string;
  /** True for `echoRepeater`: the projectile relaunches instead of bursting. */
  readonly returnsToOwner?: boolean;
}

/**
 * The ported effects, keyed by the donor id used in `UNPORTED_BEHAVIOR_FIELDS`.
 *
 * Radii and damages that the donor read from the projectile at runtime
 * (`projectile?.blastRadius || 110`) are resolved here to the owning weapon's
 * declared value, since that is what the projectile would have carried.
 */
export const EXPIRY_EFFECTS: Readonly<Record<string, ExpiryEffectDef>> = Object.freeze({
  // ---- triggerPollenCloud: damage + slow, no impulse -----------------------
  petalSaber: Object.freeze({
    donorSource: 'spawnPetalSaberAftershock',
    radiusWorld: 110, damage: 2, slowMultiplier: 0.58, slowDurationMs: 2200,
    pushForce: 0, liftForce: 0, color: '#c8ffae',
  }),
  seedVolley: Object.freeze({
    donorSource: 'spawnSeedVolleyPollen',
    radiusWorld: 120, damage: 2, slowMultiplier: 0.55, slowDurationMs: 2600,
    pushForce: 0, liftForce: 0, color: '#d8ffb8',
  }),
  spiritBloom: Object.freeze({
    donorSource: 'spawnSpiritBloomCloud',
    // Donor reads `projectile.blastRadius || 110`; spiritBloom declares 110.
    radiusWorld: 110, damage: 2, slowMultiplier: 0.58, slowDurationMs: 2200,
    pushForce: 0, liftForce: 0, color: 'rgba(208, 255, 210, 0.6)',
  }),

  // ---- triggerGustBurst: impulse only, no damage ---------------------------
  windSpindle: Object.freeze({
    donorSource: 'spawnWindSpindleBurst',
    // Donor reads `projectile.pushRadius || 150`; windSpindle declares 140.
    radiusWorld: 140, damage: 0, slowMultiplier: 1, slowDurationMs: 0,
    pushForce: 1800, liftForce: 0, color: 'rgba(170, 242, 255, 0.7)',
  }),

  // ---- triggerPressureBurst: damage + lift, plus its own inner gust --------
  // The donor's helper ends by calling triggerGustBurst at 0.8× radius and
  // 0.6× force, so both components are folded into one effect here.
  pressureLance: Object.freeze({
    donorSource: 'spawnPressureLanceBurst',
    radiusWorld: 130, damage: 2, slowMultiplier: 1, slowDurationMs: 0,
    pushForce: 2200 * 0.6, liftForce: 2200, color: '#8de4ff',
  }),
  tempestHalo: Object.freeze({
    donorSource: 'spawnTempestHaloBurst',
    radiusWorld: 120, damage: 2, slowMultiplier: 1, slowDurationMs: 0,
    pushForce: 2400 * 0.6, liftForce: 2400, color: 'rgba(190, 238, 255, 0.72)',
  }),

  // ---- triggerSteamBurst: a pressure burst that also slows -----------------
  ventMine: Object.freeze({
    donorSource: 'spawnVentMineBurst',
    // Donor reads `projectile.blastRadius || 150`; ventMine declares 140.
    radiusWorld: 140, damage: 2, slowMultiplier: 0.65, slowDurationMs: 2000,
    pushForce: 2000 * 0.6, liftForce: 2000, color: 'rgba(180, 242, 255, 0.75)',
  }),
  anchorFlail: Object.freeze({
    donorSource: 'spawnAnchorFlailFoam',
    radiusWorld: 110, damage: 2, slowMultiplier: 0.75, slowDurationMs: 1600,
    pushForce: 2000 * 0.6, liftForce: 2000, color: 'rgba(190, 244, 255, 0.6)',
  }),

  // ---- triggerChronoField: damage + a heavy slow ---------------------------
  chronoglassStaff: Object.freeze({
    donorSource: 'spawnChronoglassField',
    radiusWorld: 140, damage: 2, slowMultiplier: 0.5, slowDurationMs: 2800,
    pushForce: 0, liftForce: 0, color: '#ffe1a4',
  }),
  mirageGlaive: Object.freeze({
    // The same donor helper, reached through mirageGlaive's slash waves.
    donorSource: 'spawnChronoglassField',
    radiusWorld: 140, damage: 2, slowMultiplier: 0.5, slowDurationMs: 2800,
    pushForce: 0, liftForce: 0, color: '#ffe1a4',
  }),

  // ---- triggerInkSplash: damage + slow -------------------------------------
  toonBrush: Object.freeze({
    donorSource: 'spawnInkSlashSplash',
    radiusWorld: 130, damage: 2, slowMultiplier: 0.6, slowDurationMs: 2200,
    pushForce: 0, liftForce: 0, color: '#ffd9a8',
  }),

  // ---- The odd one out: the disc flies home --------------------------------
  echoRepeater: Object.freeze({
    donorSource: 'spawnEchoDiscReturn',
    radiusWorld: 0, damage: 0, slowMultiplier: 1, slowDurationMs: 0,
    pushForce: 0, liftForce: 0, color: '#ffd98f',
    returnsToOwner: true,
  }),
});

/**
 * Stable effect order, so a projectile can carry a small integer index instead
 * of a string. Index 0 means "no effect" — see `getExpiryEffectIndex`.
 */
export const EXPIRY_EFFECT_IDS: readonly string[] = Object.freeze(
  Object.keys(EXPIRY_EFFECTS),
);

/** Index used by projectiles that expire with no bespoke effect. */
export const EXPIRY_EFFECT_NONE = -1;

/**
 * Effect index per weapon definition, built once.
 *
 * `WeaponDef` carries no id — the id is the key it sits under in `WEAPONS` — so
 * this maps the definition objects themselves. Effects are keyed by weapon
 * rather than by projectile name because the donor attaches the callback to the
 * weapon, and two weapons sharing a projectile type (`chronoglassShard`) need
 * not share an expiry behavior.
 */
const EFFECT_INDEX_BY_DEF = new Map<WeaponDef, number>();
for (let i = 0; i < EXPIRY_EFFECT_IDS.length; i++) {
  const def = WEAPONS[EXPIRY_EFFECT_IDS[i]];
  if (def !== undefined) EFFECT_INDEX_BY_DEF.set(def, i);
}

/** The effect index for a weapon, or `EXPIRY_EFFECT_NONE`. */
export function getExpiryEffectIndex(def: WeaponDef | null): number {
  if (def === null) return EXPIRY_EFFECT_NONE;
  return EFFECT_INDEX_BY_DEF.get(def) ?? EXPIRY_EFFECT_NONE;
}

/** The effect at an index, or null when the index names none. */
export function getExpiryEffectByIndex(index: number): ExpiryEffectDef | null {
  if (index < 0 || index >= EXPIRY_EFFECT_IDS.length) return null;
  return EXPIRY_EFFECTS[EXPIRY_EFFECT_IDS[index]] ?? null;
}

/** Slow duration in ticks, converted at the single audited ms→tick boundary. */
export function getExpiryEffectSlowTicks(effect: ExpiryEffectDef): number {
  return millisecondsToTicks(effect.slowDurationMs);
}

/** What one expiry effect did. */
export interface ExpiryEffectResult {
  /** Enemies damaged. */
  hitCount: number;
  totalDamage: number;
  /** Enemies slowed or shoved, damaged or not. */
  affectedCount: number;
}

const _result: ExpiryEffectResult = { hitCount: 0, totalDamage: 0, affectedCount: 0 };

/**
 * Applies one expiry effect at a world point.
 *
 * Damage, slow, and impulse are applied in a single pass over the clusters,
 * once — the donor's helpers are likewise one-shot. Impulse falls off linearly
 * to zero at the radius edge (`1 - dist/radius`), exactly as the donor does;
 * damage and slow do not fall off, also as the donor does.
 *
 * Returns a module-scoped result; read it before the next call.
 */
export function applyExpiryEffect(
  world: WorldState,
  effect: ExpiryEffectDef,
  xWorld: number,
  yWorld: number,
  attackerAttack: number,
  rng: RngState,
): ExpiryEffectResult {
  _result.hitCount = 0;
  _result.totalDamage = 0;
  _result.affectedCount = 0;

  const radius = effect.radiusWorld;
  if (radius <= 0) return _result;

  const slowTicks = getExpiryEffectSlowTicks(effect);
  const appliesSlow = slowTicks > 0 && effect.slowMultiplier > 0 && effect.slowMultiplier < 1;
  const clusters = world.clusters;

  for (let ci = 0; ci < clusters.length; ci++) {
    const c = clusters[ci];
    if (c.isPlayerFlag === 1 || c.isAliveFlag === 0) continue;

    const dx = c.positionXWorld - xWorld;
    const dy = c.positionYWorld - yWorld;
    const reach = radius + Math.min(c.halfWidthWorld, c.halfHeightWorld);
    const distSq = dx * dx + dy * dy;
    if (distSq > reach * reach) continue;

    _result.affectedCount++;
    const dist = Math.sqrt(distSq);
    const falloff = Math.max(0, Math.min(1, 1 - dist / radius));

    if (effect.pushForce > 0 && dist > 1e-6) {
      const impulse = effect.pushForce * falloff * IMPULSE_WORLD_PER_SEC_PER_FORCE;
      c.velocityXWorld += (dx / dist) * impulse;
      c.velocityYWorld += (dy / dist) * impulse * GUST_VERTICAL_FRACTION;
    }
    if (effect.liftForce > 0) {
      c.velocityYWorld -= effect.liftForce * falloff * IMPULSE_WORLD_PER_SEC_PER_FORCE;
    }

    if (appliesSlow) {
      // A stronger slow always wins, and an equal one refreshes: being caught
      // by a second cloud must never make an enemy faster than the first left
      // it.
      if (c.slowTicks <= 0 || effect.slowMultiplier <= c.slowMultiplier) {
        c.slowMultiplier = effect.slowMultiplier;
      }
      c.slowTicks = Math.max(c.slowTicks, slowTicks);
    }

    // Damage last: it can kill the cluster, and the shove should still read on
    // the frame it dies.
    if (effect.damage > 0) {
      const damage = computeStatDamage(effect.damage, attackerAttack, 0, rng);
      if (damage > 0) {
        applyRoutedWeaveDamage(world, ci, damage, c.positionXWorld, c.positionYWorld);
        _result.hitCount++;
        _result.totalDamage += damage;
      }
    }
  }

  return _result;
}

/** Advances a cluster's slow timer. Called once per tick per enemy. */
export function tickClusterSlow(cluster: { slowTicks: number; slowMultiplier: number }): void {
  if (cluster.slowTicks <= 0) return;
  cluster.slowTicks--;
  if (cluster.slowTicks <= 0) cluster.slowMultiplier = 1;
}
