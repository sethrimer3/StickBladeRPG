/**
 * Spirit orbs — the orbiting familiars carried by `kind: 'spirit'` weapons.
 *
 * Phase 2c of the STICK-RPG port. A spirit weapon keeps a ring of orbs circling
 * the wielder. Attacking consumes the leading orb and launches it as an ordinary
 * projectile (so every behavior already built in `weaponProjectiles.ts` —
 * bounce, blast, trails — applies unchanged); the spent orb regenerates after
 * `orbRegenMs`. With no orbs left the weapon simply cannot fire, which is what
 * paces it: the ported spirit weapons all declare `cooldown: 0`.
 *
 * Deterministic and allocation-free per tick: orbit phase advances from `dtMs`,
 * regeneration is a tick countdown, and all storage is fixed-capacity.
 */

import type { RngState } from '../rng';
import { computeStatDamage } from '../stats/characterStats';
import { millisecondsToTicks, type WeaponDef } from './weaponDefs';
import { spawnWeaponProjectile, type WeaponProjectilePool } from './weaponProjectiles';

/** Hard cap on orbs per weapon. The greediest ported spirit weapon asks for 5. */
export const MAX_SPIRIT_ORBS = 8;

/** Orbs a spirit weapon carries when it declares no `orbCount`. */
const DEFAULT_ORB_COUNT = 3;

/** Regeneration delay when a weapon declares no `orbRegenMs`. */
const DEFAULT_ORB_REGEN_MS = 1500;

/** Orbiting familiar state for the equipped spirit weapon. */
export interface SpiritOrbState {
  /** Orbs this weapon carries. */
  orbCount: number;
  /** 1 when the orb at this index is present and can be fired. */
  isPresent: Uint8Array;
  /** Ticks until a spent orb returns; 0 when present. */
  regenTicksRemaining: Int32Array;
  /** Shared orbit phase in radians. */
  orbitPhaseRad: number;
  /** Weapon id these orbs belong to, so a weapon swap rebuilds the ring. */
  weaponId: string | null;
}

/** Allocates empty orb state. */
export function createSpiritOrbState(): SpiritOrbState {
  return {
    orbCount: 0,
    isPresent: new Uint8Array(MAX_SPIRIT_ORBS),
    regenTicksRemaining: new Int32Array(MAX_SPIRIT_ORBS),
    orbitPhaseRad: 0,
    weaponId: null,
  };
}

/**
 * (Re)builds the ring for `def`, with every orb present.
 *
 * Called on equip and on room reset. Passing a non-spirit weapon or null
 * empties the ring, so a swap away from a spirit weapon cannot leave stale orbs
 * orbiting.
 */
export function resetSpiritOrbs(state: SpiritOrbState, def: WeaponDef | null): void {
  state.orbitPhaseRad = 0;
  state.isPresent.fill(0);
  state.regenTicksRemaining.fill(0);

  if (def === null || def.kind !== 'spirit') {
    state.orbCount = 0;
    state.weaponId = null;
    return;
  }

  const requested = typeof def.orbCount === 'number' && Number.isFinite(def.orbCount)
    ? Math.floor(def.orbCount)
    : DEFAULT_ORB_COUNT;
  state.orbCount = Math.max(1, Math.min(MAX_SPIRIT_ORBS, requested));
  state.weaponId = def.name;

  for (let i = 0; i < state.orbCount; i++) state.isPresent[i] = 1;
}

/** Number of orbs currently available to fire. */
export function getAvailableSpiritOrbCount(state: SpiritOrbState): number {
  let count = 0;
  for (let i = 0; i < state.orbCount; i++) {
    if (state.isPresent[i] === 1) count++;
  }
  return count;
}

/**
 * World position of orb `index`, written into `out`.
 *
 * Orbs are evenly spaced around the ring and share one phase, so a spent orb
 * leaves a visible gap rather than the ring re-spacing itself — which is what
 * makes the resource readable at a glance.
 */
export function getSpiritOrbPosition(
  state: SpiritOrbState,
  def: WeaponDef,
  index: number,
  centerXWorld: number,
  centerYWorld: number,
  out: { xWorld: number; yWorld: number },
): void {
  const radius = def.orbitRadius ?? 32;
  const angle = state.orbitPhaseRad + (Math.PI * 2 * index) / Math.max(1, state.orbCount);
  out.xWorld = centerXWorld + Math.cos(angle) * radius;
  out.yWorld = centerYWorld + Math.sin(angle) * radius;
}

/**
 * Advances orbit rotation and regeneration by one tick.
 *
 * Safe to call with any weapon; it no-ops unless a spirit weapon's ring is live.
 */
export function tickSpiritOrbs(
  state: SpiritOrbState,
  def: WeaponDef | null,
  dtMs: number,
): void {
  if (def === null || def.kind !== 'spirit' || state.orbCount <= 0) return;

  const orbitSpeed = def.orbitSpeed ?? 1;
  state.orbitPhaseRad += orbitSpeed * (dtMs / 1000);
  // Keep the phase bounded so it cannot lose precision over a long session.
  if (state.orbitPhaseRad > Math.PI * 2) state.orbitPhaseRad -= Math.PI * 2;

  for (let i = 0; i < state.orbCount; i++) {
    if (state.isPresent[i] === 1) continue;
    state.regenTicksRemaining[i]--;
    if (state.regenTicksRemaining[i] <= 0) {
      state.isPresent[i] = 1;
      state.regenTicksRemaining[i] = 0;
    }
  }
}

/** Result of firing a spirit weapon. */
export interface SpiritFireResult {
  /** True when an orb was consumed and launched. */
  didFire: boolean;
  /** Orbs still available after the shot. */
  remainingOrbs: number;
}

const _fireResult: SpiritFireResult = { didFire: false, remainingOrbs: 0 };

/**
 * Consumes the first available orb and launches it toward the aim point.
 *
 * Returns `didFire: false` when the ring is empty — that is the weapon's whole
 * pacing mechanism, so callers should treat it as an ordinary "not ready" and
 * not as an error.
 *
 * The orb launches from its own orbit position rather than from the wielder, so
 * the projectile visibly departs from where the orb was.
 */
export function fireSpiritOrb(
  state: SpiritOrbState,
  pool: WeaponProjectilePool,
  def: WeaponDef,
  centerXWorld: number,
  centerYWorld: number,
  aimXWorld: number,
  aimYWorld: number,
  attackerAttack: number,
  rng: RngState,
): SpiritFireResult {
  _fireResult.didFire = false;
  _fireResult.remainingOrbs = getAvailableSpiritOrbCount(state);

  if (def.kind !== 'spirit' || state.orbCount <= 0) return _fireResult;

  let slot = -1;
  for (let i = 0; i < state.orbCount; i++) {
    if (state.isPresent[i] === 1) { slot = i; break; }
  }
  if (slot === -1) return _fireResult;

  const orbPosition = { xWorld: 0, yWorld: 0 };
  getSpiritOrbPosition(state, def, slot, centerXWorld, centerYWorld, orbPosition);

  const dx = aimXWorld - orbPosition.xWorld;
  const dy = aimYWorld - orbPosition.yWorld;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist <= 1e-6) return _fireResult;

  const damage = computeStatDamage(def.dmg ?? 0, attackerAttack, 0, rng);
  const projectileSlot = spawnWeaponProjectile(pool, def, {
    xWorld: orbPosition.xWorld,
    yWorld: orbPosition.yWorld,
    dirXWorld: dx / dist,
    dirYWorld: dy / dist,
    damage,
  });
  if (projectileSlot === -1) return _fireResult;

  state.isPresent[slot] = 0;
  const regenMs = def.orbRegenMs ?? DEFAULT_ORB_REGEN_MS;
  state.regenTicksRemaining[slot] = Math.max(1, millisecondsToTicks(regenMs));

  _fireResult.didFire = true;
  _fireResult.remainingOrbs = getAvailableSpiritOrbCount(state);
  return _fireResult;
}
