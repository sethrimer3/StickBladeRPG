/**
 * The player's equipped weapon: state, per-tick driver, and attack entry point.
 *
 * Phase 2b of the STICK-RPG port. This is the module that makes the Phase 2 /
 * 2a runtimes reachable from gameplay. It owns everything weapon-related in one
 * struct so `WorldState` grows by a single field, and it deliberately knows
 * nothing about input devices — `tryStartPlayerWeaponAttack` takes a world-space
 * aim point, so keyboard, controller, and touch all share one path.
 *
 * Relationship to the Weave system: this is additive and independent. Weaves
 * own the mouse buttons; the weapon attack is its own rebindable action. The
 * two systems share no state.
 */

import type { WorldState } from '../world';
import type { ClusterState } from '../clusters/state';
import type { RngState } from '../rng';
import { computeDerivedStats, type CharacterStats } from '../stats/characterStats';
import {
  getWeaponDef,
  isWeaponRuntimeImplemented,
  type WeaponDef,
} from './weaponDefs';
import {
  canStartWeaponSwing,
  createWeaponSwingState,
  resetWeaponSwingState,
  startWeaponSwing,
  tickWeaponCooldown,
  type WeaponSwingState,
} from './weaponSwing';
import { applyWeaponSwingToClusters } from './weaponSwingClusters';
import {
  createWeaponProjectilePool,
  fireRangedWeapon,
  getWeaponBurstCount,
  isRangedWeaponKind,
  resetWeaponProjectilePool,
  tickWeaponProjectiles,
  type WeaponProjectilePool,
} from './weaponProjectiles';

/** Ticks between the shots of a burst-fire weapon. */
const BURST_SHOT_INTERVAL_TICKS = 4;

/**
 * Weapon the player carries until a real equipment slot exists.
 *
 * Phase 3 introduces per-party-member `{mainHand, offHand, armor}` and this
 * default disappears with it. Until then it is what makes the weapon system
 * reachable in game at all.
 */
export const DEFAULT_STARTER_WEAPON_ID = 'sword';

/** The player's weapon runtime. */
export interface PlayerWeaponState {
  /** Equipped weapon id, or null when unarmed. */
  equippedWeaponId: string | null;
  /** Melee/shield swing runtime. */
  swing: WeaponSwingState;
  /** Live projectiles fired by the player. */
  projectiles: WeaponProjectilePool;
  /** Shots left to fire in the current burst. */
  burstShotsRemaining: number;
  /** Ticks until the next burst shot. */
  burstCooldownTicks: number;
  /** Aim point latched at the start of a burst, so the burst stays coherent. */
  burstAimXWorld: number;
  burstAimYWorld: number;
  /** Set for one tick when an attack actually started — for SFX and animation. */
  attackStartedFlag: 0 | 1;
}

/** Allocates idle, unarmed weapon state. */
export function createPlayerWeaponState(): PlayerWeaponState {
  return {
    equippedWeaponId: null,
    swing: createWeaponSwingState(),
    projectiles: createWeaponProjectilePool(),
    burstShotsRemaining: 0,
    burstCooldownTicks: 0,
    burstAimXWorld: 0,
    burstAimYWorld: 0,
    attackStartedFlag: 0,
  };
}

/**
 * Clears transient weapon state without unequipping.
 *
 * Called on room activation and respawn: a swing in flight, live projectiles,
 * and a partly-fired burst are all room-scoped and must never survive into a
 * new room, but the equipped weapon itself is player state and persists.
 */
export function resetPlayerWeaponRoomState(state: PlayerWeaponState): void {
  resetWeaponSwingState(state.swing);
  resetWeaponProjectilePool(state.projectiles);
  state.burstShotsRemaining = 0;
  state.burstCooldownTicks = 0;
  state.attackStartedFlag = 0;
}

/**
 * Equips a weapon by id. Returns false and leaves the current weapon in place
 * when the id names no weapon, or names one whose kind has no runtime yet
 * (staff/summoner/spirit — see `isWeaponRuntimeImplemented`).
 *
 * Equipping cancels any swing in flight so a weapon swap cannot carry the
 * previous weapon's arc.
 */
export function equipPlayerWeapon(state: PlayerWeaponState, weaponId: string | null): boolean {
  if (weaponId === null) {
    state.equippedWeaponId = null;
    resetWeaponSwingState(state.swing);
    return true;
  }

  const def = getWeaponDef(weaponId);
  if (def === null || !isWeaponRuntimeImplemented(def)) return false;

  state.equippedWeaponId = weaponId;
  resetWeaponSwingState(state.swing);
  state.burstShotsRemaining = 0;
  state.burstCooldownTicks = 0;
  return true;
}

/** The equipped weapon definition, or null when unarmed. */
export function getEquippedWeaponDef(state: PlayerWeaponState): WeaponDef | null {
  return getWeaponDef(state.equippedWeaponId);
}

/**
 * Resolves the player's attack stat.
 *
 * Falls back to 1 (the Phase 1 base) when the world carries no character stats,
 * so weapons work in tests, in the editor, and before a save has stats.
 */
function resolveAttackStat(stats: CharacterStats | null | undefined): number {
  if (!stats) return 1;
  return computeDerivedStats(stats).attack;
}

/**
 * Attempts to start an attack aimed at a world point.
 *
 * Returns true when an attack actually began. Safe to call every tick while the
 * attack input is held: a weapon still on cooldown simply returns false.
 *
 * Melee and shield weapons start a swing; ranged weapons fire immediately (and
 * latch a burst when the weapon declares `burstCount`).
 */
export function tryStartPlayerWeaponAttack(
  world: WorldState,
  player: ClusterState,
  aimXWorld: number,
  aimYWorld: number,
  rng: RngState,
): boolean {
  const state = world.playerWeapon;
  const def = getEquippedWeaponDef(state);
  if (def === null) return false;

  const attack = resolveAttackStat(world.playerCharacterStats);

  if (isRangedWeaponKind(def)) {
    if (!canStartWeaponSwing(state.swing)) return false;

    const fired = fireRangedWeapon(
      state.projectiles, def,
      player.positionXWorld, player.positionYWorld,
      aimXWorld, aimYWorld,
      attack, rng,
    );
    if (fired.projectileCount === 0) return false;

    // Ranged weapons reuse the swing state purely as the cooldown timer; they
    // never animate an arc.
    state.swing.cooldownRemainingTicks = Math.max(1, getRangedCooldownTicks(def));

    const burst = getWeaponBurstCount(def);
    if (burst > 1) {
      state.burstShotsRemaining = burst - 1;
      state.burstCooldownTicks = BURST_SHOT_INTERVAL_TICKS;
      state.burstAimXWorld = aimXWorld;
      state.burstAimYWorld = aimYWorld;
    }
    state.attackStartedFlag = 1;
    return true;
  }

  const started = startWeaponSwing(
    state.swing, def,
    aimXWorld, aimYWorld,
    player.positionXWorld, player.positionYWorld,
    player.isFacingLeftFlag === 1,
  );
  if (started) state.attackStartedFlag = 1;
  return started;
}

/** Cooldown in ticks for a ranged weapon, floored at 1 so it cannot fire every tick. */
function getRangedCooldownTicks(def: WeaponDef): number {
  const ms = def.cooldown ?? 0;
  if (!Number.isFinite(ms) || ms <= 0) return 1;
  return Math.max(1, Math.round(ms / (1000 / 60)));
}

/**
 * Advances the player's weapon by one tick: cooldown, active swing, pending
 * burst shots, and live projectiles.
 *
 * Called unconditionally from the tick pipeline. Everything inside is cheap and
 * short-circuits when the player is unarmed and nothing is in flight, so the
 * cost when the system is unused is a handful of comparisons.
 */
export function tickPlayerWeapon(
  world: WorldState,
  player: ClusterState | null,
  rng: RngState,
): void {
  const state = world.playerWeapon;
  state.attackStartedFlag = 0;

  tickWeaponCooldown(state.swing);

  const def = getEquippedWeaponDef(state);

  if (def !== null && player !== null && state.swing.activeFlag === 1) {
    const attack = resolveAttackStat(world.playerCharacterStats);
    applyWeaponSwingToClusters(world, state.swing, def, player, attack, rng);
  }

  if (state.burstShotsRemaining > 0 && def !== null && player !== null) {
    state.burstCooldownTicks--;
    if (state.burstCooldownTicks <= 0) {
      state.burstShotsRemaining--;
      state.burstCooldownTicks = BURST_SHOT_INTERVAL_TICKS;
      fireRangedWeapon(
        state.projectiles, def,
        player.positionXWorld, player.positionYWorld,
        state.burstAimXWorld, state.burstAimYWorld,
        resolveAttackStat(world.playerCharacterStats), rng,
      );
    }
  }

  // Projectiles keep flying after a weapon swap or unequip, so this runs
  // regardless of what is currently held.
  if (state.projectiles.liveCount > 0) {
    tickWeaponProjectiles(world, state.projectiles);
  }
}
