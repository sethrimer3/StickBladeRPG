/** Added knockback speed (world units/s) per point of damage dealt. */
const DAMAGE_KNOCKBACK_SPEED_PER_DAMAGE_WORLD = 18.0;
/** Minimum knockback speed (world units/s) applied when damage is dealt. */
const MIN_DAMAGE_KNOCKBACK_SPEED_WORLD = 90.0;
/** Fixed upward lift added to knockback velocity (world units/s, negative = up). */
const KNOCKBACK_VERTICAL_LIFT_WORLD = 60.0;
/** Blend factor for smoothing the resulting knockback velocity. */
const KNOCKBACK_SMOOTH_BLEND = 0.7;
/** Fallback X direction when source and player are at the same X position. */
const FALLBACK_KNOCKBACK_DIR_X = 1.0;
/** Threshold for considering two X positions identical when computing knockback direction. */
const HORIZONTAL_POSITION_EPSILON_WORLD = 0.01;

import type { ChallengeModeState } from './challengeMode';
import { consumeChallengeReturn } from './challengeMode';
import { getPlayerMoteCount, normalizeMoteCount } from './playerMoteLife';
import {
  damagePlayerHitPoints,
  getPlayerMaxHitPoints,
  hasPlayerHealthPool,
  type PlayerHealthState,
} from './playerHealth';
import { computeStatDamage } from './stats/characterStats';
import type { RngState } from './rng';


const INVULNERABILITY_DURATION_TICKS = 90;
/** Ticks of hurt visual feedback after taking damage (~0.33 s at 60 fps). */
const HURT_VISUAL_DURATION_TICKS = 20;

/**
 * Applies damage to a player cluster and blends in knockback away from the
 * source position toward the player center.
 *
 * Higher damage increases knockback speed linearly.
 * Grants INVULNERABILITY_DURATION_TICKS of invulnerability after each hit
 * and starts the HURT_VISUAL_DURATION_TICKS visual feedback window.
 */
export interface PlayerDamageTarget {
  healthPoints: number;
  isAliveFlag: 0 | 1;
  positionXWorld: number;
  positionYWorld: number;
  velocityXWorld: number;
  velocityYWorld: number;
  isGroundedFlag: 0 | 1;
  invulnerabilityTicks: number;
  hurtTicks: number;
  isHighVelocityAttacking?: 0 | 1;
  /**
   * Mote capacity. Since the player's life moved to `hitPoints` this is only
   * the fallback capacity for `isHeavyHit` on targets with no life pool.
   */
  maxHealthPoints?: number;
  /**
   * The player's life pool (`sim/playerHealth.ts`). When `maxHitPoints` is
   * positive this is what damage spends and what death is read from, and motes
   * are left alone. Absent or zero — every non-player target — and damage falls
   * back to spending motes exactly as it did before the pool existed.
   */
  hitPoints?: number;
  maxHitPoints?: number;
  /**
   * Set to 1 by this pipeline when a hit costs more than
   * `HEAVY_HIT_HEALTH_FRACTION` of capacity. Consumed and cleared by whoever
   * reacts to it — for the stickman that is `tickStickRangerPlayer`, which
   * turns it into a ragdoll. A flag rather than a callback so the damage
   * pipeline keeps knowing nothing about the softbody, and so cluster state
   * stays plain data.
   */
  heavyHitFlag?: 0 | 1;
  halfWidthWorld?: number;
  halfHeightWorld?: number;
  challengeMode?: ChallengeModeState | null;
  challengeReturnGuard?: 0 | 1;
  /**
   * Resolved defense stat from the STICK-RPG character-stat port
   * (`sim/stats/characterStats.ts`), or undefined when the target has no stat
   * record. When undefined — which is every caller today — mitigation is
   * skipped entirely and damage behaves exactly as it did before the port.
   *
   * Populated by a later port phase once equipment and party members carry
   * stats. See `docs/decisions/STICK_RPG_PORT_PLAN.md`.
   */
  statsDefense?: number;
  /**
   * The Aegis Stave's intercepting ward (`sim/weapons/projectileShield.ts`),
   * present only while that staff is channelling. Absent for every other
   * damage target, in which case damage behaves exactly as before the port.
   *
   * Typed structurally rather than by importing `ProjectileShieldState` so this
   * module keeps no dependency on the weapon system.
   */
  projectileShield?: DamageAbsorbingWard | null;
  /**
   * Fraction of incoming damage removed by a staff aura covering this party
   * member (`sim/party/partyAuras.ts`). Absent or 0 for every other target, in
   * which case damage is unchanged from its pre-port behavior.
   */
  auraDamageReduction?: number;
}

/** The subset of a ward this pipeline touches. */
export interface DamageAbsorbingWard {
  /** Remaining absorption; spent before the player's motes. */
  hitPoints: number;
  /** 1 while the ward is up. */
  isActiveFlag: 0 | 1;
  /** Set when the ward absorbs, for the renderer's impact flash. */
  hitFlashTicks: number;
}

export interface PlayerDamageOptions {
  challengeState?: ChallengeModeState;
  clearTransientMovement?: () => void;
  bypassMomentumInvulnerability?: boolean;
  /**
   * When true, skip the generic post-hit `invulnerabilityTicks > 0` gate.
   * Used exclusively by the Poison Field exposure controller (see
   * sim/poisonField/poisonExposureState.ts): poison damage is scheduled on
   * its own independent 3.0s cadence (or fires exactly once on a
   * Verdant-switch-away transition) and must not be silently swallowed just
   * because an unrelated contact hazard (spike/lava/enemy) granted the
   * player a brief 1.5s invulnerability window moments earlier. The hit
   * still SETS invulnerabilityTicks afterward as normal, so it continues to
   * protect the player from an immediate unrelated follow-up hit — this only
   * bypasses the check on the way IN for poison's own scheduled ticks.
   */
  bypassContactInvulnerability?: boolean;
  /**
   * Deterministic RNG used for the character-stat defense mitigation roll.
   *
   * Stat scaling is applied only when this is supplied AND the target carries a
   * positive `statsDefense`; otherwise the raw damage is used unchanged. Both
   * conditions are unmet for every current caller, so existing damage paths are
   * bit-identical to their pre-port behavior.
   */
  statsRng?: RngState;
  /**
   * Attacker's resolved attack stat, used with `statsRng`. Defaults to 1, which
   * makes stat scaling pure mitigation when the attacker has no stat record.
   */
  attackerAttack?: number;
}

/**
 * Applies character-stat scaling to an incoming damage amount.
 *
 * Returns `damagePoints` unchanged unless the target has a positive
 * `statsDefense` and the caller supplied a `statsRng`, which keeps every
 * pre-port damage path untouched. See `sim/stats/characterStats.ts`.
 */
function applyStatScaling(
  player: PlayerDamageTarget,
  damagePoints: number,
  options?: PlayerDamageOptions,
): number {
  const rng = options?.statsRng;
  const defense = player.statsDefense;
  if (rng === undefined) return damagePoints;
  if (typeof defense !== 'number' || !Number.isFinite(defense) || defense <= 0) return damagePoints;

  const attack = options?.attackerAttack ?? 1;
  return computeStatDamage(damagePoints, attack, defense, rng);
}

/**
 * Removes the share of a hit a covering staff aura absorbs.
 *
 * Deliberately not a roll: unlike `applyStatScaling`, this needs no `RngState`,
 * so it works from every existing call site without threading one through. See
 * `sim/party/partyAuras.ts` for why the donor's multiplier becomes a fraction.
 */
function applyAuraReduction(player: PlayerDamageTarget, damagePoints: number): number {
  const reduction = player.auraDamageReduction;
  if (typeof reduction !== 'number' || !Number.isFinite(reduction) || reduction <= 0) {
    return damagePoints;
  }
  return damagePoints * (1 - Math.min(1, reduction));
}

/** Ticks a ward renders its impact flash after absorbing a hit. */
export const WARD_HIT_FLASH_TICKS = 12;

/**
 * Spends ward points against an incoming hit and returns what gets through.
 *
 * Lives here rather than in the weapon module so the damage pipeline keeps no
 * dependency on the weapon system; `sim/weapons/projectileShield.ts` re-uses it.
 */
export function absorbWithWard(ward: DamageAbsorbingWard | null | undefined, damagePoints: number): number {
  if (!ward || ward.isActiveFlag === 0 || ward.hitPoints <= 0) return damagePoints;
  if (!Number.isFinite(damagePoints) || damagePoints <= 0) return damagePoints;

  const absorbed = Math.min(ward.hitPoints, damagePoints);
  ward.hitPoints -= absorbed;
  ward.hitFlashTicks = WARD_HIT_FLASH_TICKS;
  return damagePoints - absorbed;
}

/**
 * Share of the target's capacity a single hit must cost to count as heavy.
 * Heavy hits are what ragdoll the stickman; anything lighter is just a hit.
 */
export const HEAVY_HIT_HEALTH_FRACTION = 0.2;

/** True when `damageToApply` exceeds `HEAVY_HIT_HEALTH_FRACTION` of capacity. */
function isHeavyHit(player: PlayerDamageTarget, damageToApply: number): boolean {
  // Measured against whichever pool the hit actually came out of, so the
  // ragdoll threshold tracks the damage rather than an unrelated mote count.
  const capacity = hasPlayerHealthPool(player)
    ? getPlayerMaxHitPoints(player as PlayerHealthState)
    : normalizeMoteCount(player.maxHealthPoints ?? 0);
  if (capacity <= 0) return false;
  return damageToApply > capacity * HEAVY_HIT_HEALTH_FRACTION;
}

export function applyPlayerDamageWithKnockback(
  player: PlayerDamageTarget,
  damagePoints: number,
  sourceXWorld: number,
  _sourceYWorld: number,
  options?: PlayerDamageOptions,
): boolean {
  if (player.isAliveFlag === 0) return false;
  if (player.invulnerabilityTicks > 0 && options?.bypassContactInvulnerability !== true) return false;
  if (player.isHighVelocityAttacking === 1 && options?.bypassMomentumInvulnerability !== true) return false; // momentum combat invulnerability
  if (player.challengeReturnGuard === 1) return false;

  const scaledDamage = applyStatScaling(player, damagePoints, options);
  // A protective aura thins the hit before the ward catches what is left: the
  // aura is armor on the body, the ward is a bubble around it.
  const afterAura = applyAuraReduction(player, scaledDamage);
  // The ward is spent before motes. A hit it swallows entirely is not a hit:
  // no motes lost, no invulnerability window, no hurt flash — the same shape as
  // a hit fully absorbed by defense below.
  const afterWard = absorbWithWard(player.projectileShield, afterAura);
  const damageToApply = normalizeMoteCount(Math.ceil(afterWard));
  // A hit fully absorbed by defense deals nothing and is not treated as a hit,
  // so it grants no invulnerability window and triggers no hurt feedback.
  if (damageToApply <= 0) return false;

  const challenge = options?.challengeState ?? player.challengeMode ?? undefined;
  if (challenge?.isActive) {
    const anchorXWorld = challenge.anchorXWorld;
    const anchorYWorld = challenge.anchorYWorld;
    if (!consumeChallengeReturn(challenge)) return false;
    player.positionXWorld = anchorXWorld;
    player.positionYWorld = anchorYWorld;
    player.velocityXWorld = 0;
    player.velocityYWorld = 0;
    player.isGroundedFlag = 0;
    player.challengeReturnGuard = 1;
    options?.clearTransientMovement?.();
    return true;
  }

  if (hasPlayerHealthPool(player)) {
    // The life pool is spent; motes are left at capacity so the weaves keep
    // their full length no matter how hurt the player is.
    if (damagePlayerHitPoints(player as PlayerHealthState, damageToApply) === 0) {
      player.isAliveFlag = 0;
    }
  } else {
    // Legacy motes-as-life, for every target with no pool. Reaching zero motes
    // is survivable; a subsequent otherwise-valid damage event at zero is fatal.
    if (getPlayerMoteCount(player) === 0) {
      player.healthPoints = 0;
      player.isAliveFlag = 0;
      return true;
    }
    player.healthPoints = Math.max(0, getPlayerMoteCount(player) - damageToApply);
  }

  // Horizontal knockback direction based solely on whether the source is to
  // the left or right of the player — prevents diagonal sources from pushing
  // the player into the floor.
  const dx = player.positionXWorld - sourceXWorld;
  const dirX = Math.abs(dx) > HORIZONTAL_POSITION_EPSILON_WORLD ? (dx > 0 ? 1.0 : -1.0) : FALLBACK_KNOCKBACK_DIR_X;

  const knockbackSpeedWorld = MIN_DAMAGE_KNOCKBACK_SPEED_WORLD + damageToApply * DAMAGE_KNOCKBACK_SPEED_PER_DAMAGE_WORLD;
  const targetVelocityXWorld = dirX * knockbackSpeedWorld;
  // Always add upward lift regardless of vertical source offset so damage feels
  // impactful from any angle.
  const targetVelocityYWorld = -KNOCKBACK_VERTICAL_LIFT_WORLD;

  player.velocityXWorld = player.velocityXWorld * (1.0 - KNOCKBACK_SMOOTH_BLEND) + targetVelocityXWorld * KNOCKBACK_SMOOTH_BLEND;
  player.velocityYWorld = player.velocityYWorld * (1.0 - KNOCKBACK_SMOOTH_BLEND) + targetVelocityYWorld * KNOCKBACK_SMOOTH_BLEND;
  player.isGroundedFlag = 0;

  player.invulnerabilityTicks = INVULNERABILITY_DURATION_TICKS;
  player.hurtTicks = HURT_VISUAL_DURATION_TICKS;
  if (isHeavyHit(player, damageToApply)) player.heavyHitFlag = 1;
  return true;
}

export function killPlayerImmediately(player: PlayerDamageTarget): void {
  if (player.isAliveFlag === 0) return;
  // Both pools: motes so nothing keeps drawing a life cloud around a corpse,
  // and hit points because that is what death is now read from.
  player.healthPoints = 0;
  if (hasPlayerHealthPool(player)) player.hitPoints = 0;
  player.isAliveFlag = 0;
}
