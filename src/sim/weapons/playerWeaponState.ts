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
  createStaffChannelState,
  getStaffAuraModifiers,
  getStaffAuraRadius,
  getStaffChannelKind,
  releaseStaffChannel,
  requestStaffChannel,
  resetStaffChannelState,
  tickStaffChannel,
  STAFF_CHANNEL_NONE,
  type StaffChannelState,
} from './staffChannel';
import {
  createSpiritOrbState,
  fireSpiritOrb,
  resetSpiritOrbs,
  tickSpiritOrbs,
  type SpiritOrbState,
} from './spiritOrbs';
import {
  castWeaponSummons,
  createSummonPool,
  isSummonerWeapon,
  resetSummonPool,
  tickWeaponSummons,
  type SummonPool,
} from './weaponSummons';
import {
  createWeaponProjectilePool,
  fireRangedWeapon,
  fireWeaponSlashWaves,
  getWeaponBurstCount,
  isRangedWeaponKind,
  resetWeaponProjectilePool,
  tickWeaponProjectiles,
  type WeaponProjectilePool,
} from './weaponProjectiles';

import {
  createProjectileShieldState,
  getProjectileShieldConfig,
  resetProjectileShieldState,
  tickProjectileShield,
  type ProjectileShieldState,
} from './projectileShield';
import {
  createExpiryFlashPool,
  resetExpiryFlashPool,
  tickExpiryFlashes,
  type ExpiryFlashPool,
} from './weaponExpiryEffects';
import {
  createSoulOrbPool,
  resetSoulOrbPool,
  tickSoulOrbs,
  type SoulOrbPool,
} from './soulOrbs';

/** Ticks between the shots of a burst-fire weapon. */
const BURST_SHOT_INTERVAL_TICKS = 4;

/**
 * Weapon the player carries until a real equipment slot exists.
 *
 * Phase 3 introduces per-party-member `{mainHand, offHand, armor}` and this
 * default disappears with it. Until then it is what makes the weapon system
 * reachable in game at all.
 */
export const DEFAULT_STARTER_WEAPON_ID = 'woodenSword';

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
  /** Charge meter and beam/aura state for `kind: 'staff'` weapons. */
  staff: StaffChannelState;
  /** Orbiting familiars for `kind: 'spirit'` weapons. */
  spiritOrbs: SpiritOrbState;
  /** Summoned familiars for `kind: 'summoner'` weapons. */
  summons: SummonPool;
  /** Floating soul drops collected from defeated enemies. */
  soulOrbs: SoulOrbPool;
  /** Souls currently banked for empowered Guardian summons. */
  soulsCollected: number;
  /** The Aegis Stave's intercepting ward, up only while that staff channels. */
  projectileShield: ProjectileShieldState;
  /** Purely visual rings marking where on-expiry effects landed. */
  expiryFlashes: ExpiryFlashPool;
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
    staff: createStaffChannelState(),
    spiritOrbs: createSpiritOrbState(),
    summons: createSummonPool(),
    soulOrbs: createSoulOrbPool(),
    soulsCollected: 0,
    projectileShield: createProjectileShieldState(),
    expiryFlashes: createExpiryFlashPool(),
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
  resetStaffChannelState(state.staff);
  resetSpiritOrbs(state.spiritOrbs, getWeaponDef(state.equippedWeaponId));
  // Familiars and floating soul drops are bound to the room they were called into.
  resetSummonPool(state.summons);
  resetSoulOrbPool(state.soulOrbs);
  resetProjectileShieldState(state.projectileShield);
  resetExpiryFlashPool(state.expiryFlashes);
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
    resetStaffChannelState(state.staff);
    resetSpiritOrbs(state.spiritOrbs, null);
    resetProjectileShieldState(state.projectileShield);
    return true;
  }

  const def = getWeaponDef(weaponId);
  if (def === null || !isWeaponRuntimeImplemented(def)) return false;
  // A staff with no channelled effect at all would be a dead weapon. Since
  // Phase 2e ported the last two bespoke auras, no ported staff trips this —
  // it remains as the guard for any future unimplemented staff.
  if (def.kind === 'staff' && getStaffChannelKind(def) === STAFF_CHANNEL_NONE) return false;

  state.equippedWeaponId = weaponId;
  resetWeaponSwingState(state.swing);
  resetStaffChannelState(state.staff);
  resetProjectileShieldState(state.projectileShield);
  resetSpiritOrbs(state.spiritOrbs, def);
  state.burstShotsRemaining = 0;
  state.burstCooldownTicks = 0;
  return true;
}

/** The equipped weapon definition, or null when unarmed. */
export function getEquippedWeaponDef(state: PlayerWeaponState): WeaponDef | null {
  return getWeaponDef(state.equippedWeaponId);
}

/**
 * Resolves the player's attack stat, including any active staff aura.
 *
 * Falls back to 1 (the Phase 1 base) when the world carries no character stats,
 * so weapons work in tests, in the editor, and before a save has stats. The
 * aura is read live rather than cached so it cannot drift out of sync with the
 * staff's charge state.
 */
function resolveAttackStat(
  stats: CharacterStats | null | undefined,
  weapon?: PlayerWeaponState,
): number {
  const auraDef = weapon ? getEquippedWeaponDef(weapon) : null;
  const modifiers = weapon ? getStaffAuraModifiers(weapon.staff, auraDef) : undefined;
  if (!stats) return modifiers?.attackMultiplier ?? 1;
  return computeDerivedStats(stats, modifiers).attack;
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

  const attack = resolveAttackStat(world.playerCharacterStats, state);

  // Staves channel for as long as the input is held rather than firing shots,
  // so this is a request, not a one-shot trigger.
  if (def.kind === 'staff') {
    return requestStaffChannel(state.staff, def, aimXWorld, aimYWorld);
  }

  // Summoner weapons cast a group of familiars on a cooldown. The swing state
  // serves purely as that cooldown timer; no arc is animated.
  if (isSummonerWeapon(def)) {
    if (!canStartWeaponSwing(state.swing)) return false;

    const soulsSpent = state.soulsCollected;
    const cast = castWeaponSummons(
      state.summons, def,
      player.positionXWorld, player.positionYWorld,
      attack, rng,
      soulsSpent,
    );
    if (cast.summonedCount === 0) return false;

    if (soulsSpent > 0) {
      state.soulsCollected = 0;
    }

    state.swing.cooldownRemainingTicks = Math.max(1, getRangedCooldownTicks(def));
    state.attackStartedFlag = 1;
    return true;
  }

  // Spirit weapons are paced by their orb ring, not by a cooldown — every
  // ported one declares `cooldown: 0`.
  if (def.kind === 'spirit') {
    const fired = fireSpiritOrb(
      state.spiritOrbs, state.projectiles, def,
      player.positionXWorld, player.positionYWorld,
      aimXWorld, aimYWorld,
      attack, rng,
    );
    if (fired.didFire) state.attackStartedFlag = 1;
    return fired.didFire;
  }

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
  if (started) {
    state.attackStartedFlag = 1;
    // Weapons that throw slash waves launch them with the swing, not on hit —
    // the donor fans them out from the wielder as the arc begins.
    fireWeaponSlashWaves(
      state.projectiles, def,
      player.positionXWorld, player.positionYWorld,
      aimXWorld, aimYWorld,
      attack, rng,
    );
  }
  return started;
}

/**
 * Signals that the attack input was released.
 *
 * Only staves care: they channel for as long as the input is held, so without
 * this a staff would keep draining after the key came up. Harmless to call
 * every frame the input is not held.
 */
export function releasePlayerWeaponAttack(world: WorldState): void {
  releaseStaffChannel(world.playerWeapon.staff);
}

/**
 * Advances the Aegis ward and keeps the player cluster's reference to it in
 * sync.
 *
 * The reference is what makes the ward reachable from the damage pipeline
 * (`sim/playerDamage.ts` reads `PlayerDamageTarget.projectileShield`), so it is
 * attached only while the ward is genuinely up and cleared the moment it drops.
 * Attaching a live object rather than copying its numbers means absorption can
 * never be applied to a stale snapshot.
 */
function tickPlayerProjectileShield(
  world: WorldState,
  state: PlayerWeaponState,
  def: WeaponDef | null,
  player: ClusterState | null,
): void {
  const shield = state.projectileShield;
  const hasWard = getProjectileShieldConfig(def) !== null;

  const stats = world.playerCharacterStats;
  const maxHealth = stats
    ? computeDerivedStats(stats).maxHealth
    : (player?.maxHealthPoints ?? 0);

  tickProjectileShield(
    shield,
    def,
    hasWard && state.staff.isChannellingFlag === 1 && state.staff.charge > 0,
    maxHealth,
    getStaffAuraRadius(def),
    world.dtMs,
  );

  if (player !== null) {
    player.projectileShield = shield.isActiveFlag === 1 ? shield : null;
  }
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
    const attack = resolveAttackStat(world.playerCharacterStats, state);
    applyWeaponSwingToClusters(world, state.swing, def, player, attack, rng);
  }

  // Staves drain/regenerate every tick regardless of what is equipped, so a
  // swapped-away staff refills instead of freezing at its last charge.
  if (def !== null && def.kind === 'staff') {
    tickStaffChannel(world, state.staff, def, player, resolveAttackStat(world.playerCharacterStats, state), rng);
  } else if (state.staff.isChannellingFlag === 1) {
    releaseStaffChannel(state.staff);
  }

  tickPlayerProjectileShield(world, state, def, player);

  tickSpiritOrbs(state.spiritOrbs, def, world.dtMs);
  tickExpiryFlashes(state.expiryFlashes);

  // Floating soul drops drift toward the wielder and get collected.
  if (state.soulOrbs.liveCount > 0 && player !== null) {
    const gained = tickSoulOrbs(
      state.soulOrbs,
      player.positionXWorld,
      player.positionYWorld,
      def,
      state.soulsCollected,
    );
    state.soulsCollected += gained;
  }

  // Familiars outlive the weapon that called them, so this runs regardless of
  // what is currently equipped — a swap does not dismiss an active swarm.
  if (state.summons.liveCount > 0) {
    tickWeaponSummons(world, state.summons);
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
