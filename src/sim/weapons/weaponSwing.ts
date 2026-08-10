/**
 * Melee swing resolution for ported STICK-RPG weapons.
 *
 * Phase 2 of the STICK-RPG port. Implements the contact-weapon half of the
 * donor's `attackMelee`: a cooldown-gated swing that sweeps an arc in front of
 * the wielder and damages each target at most once per swing.
 *
 * Design notes:
 *   • Fully tick-based. No wall clock anywhere; the donor's millisecond
 *     cooldowns are converted once via the accessors in `weaponDefs.ts`.
 *   • Deterministic. Damage mitigation rolls come from an injected `RngState`.
 *   • Swept, not sampled. The arc covers the whole angular interval traversed
 *     this tick, so a fast swing cannot tunnel past a target between ticks —
 *     the same guarantee `swordWeave.ts` provides for the Sword Weave.
 *   • Allocation-free per tick. Swing state owns its hit registry and the
 *     module keeps a single scratch result.
 *   • Engine-agnostic. Targets arrive through the `WeaponSwingTarget`
 *     structural interface, which `ClusterState` already satisfies, so this
 *     module stays pure and Node-testable. `applyWeaponSwingToClusters` in
 *     `weaponSwingClusters.ts` is the thin binding to live world state.
 */

import type { RngState } from '../rng';
import { computeStatDamage } from '../stats/characterStats';
import {
  getWeaponCooldownTicks,
  getWeaponSwingDurationTicks,
  type WeaponDef,
} from './weaponDefs';
import { MAX_HIT_REGISTRY_SLOTS } from '../weaves/weaveHitRegistryConfig';

// ---- Geometry constants ---------------------------------------------------

/**
 * Fraction of the swing spent winding up before the blade begins to travel.
 *
 * The donor staged its swing behind the wielder before cutting forward; the
 * same shape is reproduced here so timing against enemy telegraphs matches.
 */
const SWING_WINDUP_FRACTION = 0.2;

/**
 * Extra reach (world units) granted to the hit test beyond the weapon's stated
 * range, approximating the blade's thickness. Without it a target grazed by the
 * very edge of a swing reads as a miss even though the blade visibly crosses it.
 */
const SWING_EDGE_TOLERANCE_WORLD = 1.5;

// ---- Types ----------------------------------------------------------------

/**
 * Anything a swing can hit.
 *
 * Structurally satisfied by `ClusterState`, so live enemies can be passed
 * directly without adaptation.
 */
export interface WeaponSwingTarget {
  positionXWorld: number;
  positionYWorld: number;
  halfWidthWorld: number;
  halfHeightWorld: number;
  isAliveFlag: 0 | 1;
  /** Resolved defense stat; absent or 0 means no mitigation. */
  statsDefense?: number;
}

/** Per-wielder swing state. One instance per character that can attack. */
export interface WeaponSwingState {
  /** 1 while a swing is animating. */
  activeFlag: 0 | 1;
  /** Ticks elapsed in the current swing. */
  ticksElapsed: number;
  /** Total ticks the current swing runs for. */
  durationTicks: number;
  /** Ticks remaining before another swing may start. */
  cooldownRemainingTicks: number;
  /** Direction the swing was aimed at press time (radians). */
  aimAngleRad: number;
  /** Arc start angle (radians), behind the aim. */
  startAngleRad: number;
  /** Arc end angle (radians), ahead of the aim. */
  endAngleRad: number;
  /** Blade angle at the end of the previous tick — the swept interval's origin. */
  previousAngleRad: number;
  /** Blade angle at the end of the current tick. */
  currentAngleRad: number;
  /** Wielder position captured at swing start. */
  originXWorld: number;
  originYWorld: number;
  /** Effective reach for this swing (world units). */
  reachWorld: number;
  /** Per-swing hit registry, indexed by target index. */
  hitFlags: Uint8Array;
}

/** Outcome of a single `tickWeaponSwing` call. */
export interface WeaponSwingTickResult {
  /** True on the tick the swing finished. */
  isFinished: boolean;
  /** Number of targets damaged this tick. */
  hitCount: number;
  /** Total damage dealt this tick. */
  totalDamage: number;
}

/** Callback invoked once per damaged target. */
export type WeaponSwingHitHandler = (
  targetIndex: number,
  damage: number,
  knockbackXWorld: number,
  knockbackYWorld: number,
) => void;

/** Inputs that vary per swing tick. */
export interface WeaponSwingTickContext {
  /** Current wielder position — the swing tracks the wielder as they move. */
  originXWorld: number;
  originYWorld: number;
  /**
   * Candidate targets. Indices must be stable for the whole swing, since the
   * hit registry is indexed by position in this list.
   *
   * May be a reusable buffer longer than the live entry count; pass
   * `targetCount` in that case so callers never have to allocate a slice.
   * `undefined` entries are skipped.
   */
  targets: readonly (WeaponSwingTarget | undefined)[];
  /** Live entries in `targets`. Defaults to `targets.length` when omitted. */
  targetCount?: number;
  /** Wielder's resolved attack stat. */
  attackerAttack: number;
  /** Deterministic RNG for defense mitigation rolls. */
  rng: RngState;
  /** Invoked for each target damaged this tick. */
  onHit?: WeaponSwingHitHandler;
}

// ---- Angle helpers --------------------------------------------------------

const TWO_PI = Math.PI * 2;

/** Wraps an angle into (-π, π]. */
export function normalizeAngleRad(angleRad: number): number {
  let a = angleRad;
  while (a > Math.PI) a -= TWO_PI;
  while (a <= -Math.PI) a += TWO_PI;
  return a;
}

/** Shortest signed delta from `fromRad` to `toRad`, in (-π, π]. */
export function shortestAngleDeltaRad(fromRad: number, toRad: number): number {
  return normalizeAngleRad(toRad - fromRad);
}

/**
 * True when `angleRad` lies within the swept interval from `fromRad` to
 * `toRad`, taking the short way around.
 *
 * This is the anti-tunneling test: it asks whether the blade crossed the target
 * at any point during the tick, not merely whether it happens to overlap the
 * target at the tick boundary.
 */
export function isAngleWithinSweptInterval(
  angleRad: number,
  fromRad: number,
  toRad: number,
): boolean {
  const sweep = shortestAngleDeltaRad(fromRad, toRad);
  if (sweep === 0) return Math.abs(shortestAngleDeltaRad(fromRad, angleRad)) < 1e-9;
  const offset = shortestAngleDeltaRad(fromRad, angleRad);
  return sweep > 0 ? offset >= 0 && offset <= sweep : offset <= 0 && offset >= sweep;
}

// ---- State ----------------------------------------------------------------

/** Creates idle swing state with a pre-allocated hit registry. */
export function createWeaponSwingState(): WeaponSwingState {
  return {
    activeFlag: 0,
    ticksElapsed: 0,
    durationTicks: 0,
    cooldownRemainingTicks: 0,
    aimAngleRad: 0,
    startAngleRad: 0,
    endAngleRad: 0,
    previousAngleRad: 0,
    currentAngleRad: 0,
    originXWorld: 0,
    originYWorld: 0,
    reachWorld: 0,
    hitFlags: new Uint8Array(MAX_HIT_REGISTRY_SLOTS),
  };
}

/** Clears all transient swing state, including any pending cooldown. */
export function resetWeaponSwingState(state: WeaponSwingState): void {
  state.activeFlag = 0;
  state.ticksElapsed = 0;
  state.durationTicks = 0;
  state.cooldownRemainingTicks = 0;
  state.aimAngleRad = 0;
  state.startAngleRad = 0;
  state.endAngleRad = 0;
  state.previousAngleRad = 0;
  state.currentAngleRad = 0;
  state.originXWorld = 0;
  state.originYWorld = 0;
  state.reachWorld = 0;
  state.hitFlags.fill(0);
}

/** Advances the cooldown timer by one tick. Safe to call every tick. */
export function tickWeaponCooldown(state: WeaponSwingState): void {
  if (state.cooldownRemainingTicks > 0) state.cooldownRemainingTicks--;
}

/** True when a new swing may begin: nothing in flight and no cooldown pending. */
export function canStartWeaponSwing(state: WeaponSwingState): boolean {
  return state.activeFlag === 0 && state.cooldownRemainingTicks <= 0;
}

// ---- Swing lifecycle ------------------------------------------------------

/**
 * Begins a swing aimed at (`aimXWorld`, `aimYWorld`).
 *
 * Returns false without touching state when the weapon cannot swing — a
 * non-contact weapon, a weapon with no reach, or a wielder still on cooldown —
 * so callers can drive this straight from an input event.
 *
 * The arc is centered on the aim direction and spans the weapon's `arc`, half
 * behind and half ahead, so the blade passes through the aim direction at the
 * midpoint of the sweep. Swing direction follows facing so the wind-up always
 * stages behind the wielder.
 */
export function startWeaponSwing(
  state: WeaponSwingState,
  def: WeaponDef,
  aimXWorld: number,
  aimYWorld: number,
  originXWorld: number,
  originYWorld: number,
  isFacingLeft: boolean,
): boolean {
  if (def.kind !== 'melee' && def.kind !== 'shield') return false;
  if (!canStartWeaponSwing(state)) return false;

  const range = typeof def.range === 'number' && Number.isFinite(def.range) ? def.range : 0;
  if (range <= 0) return false;

  const dx = aimXWorld - originXWorld;
  const dy = aimYWorld - originYWorld;
  const aimAngleRad = dx * dx + dy * dy > 1e-9
    ? Math.atan2(dy, dx)
    : (isFacingLeft ? Math.PI : 0);

  const arc = typeof def.arc === 'number' && Number.isFinite(def.arc) ? Math.abs(def.arc) : 0;
  const swingSign = isFacingLeft ? -1 : 1;
  const halfArc = (arc * 0.5) * swingSign;

  state.activeFlag = 1;
  state.ticksElapsed = 0;
  state.durationTicks = Math.max(1, getWeaponSwingDurationTicks(def));
  state.aimAngleRad = aimAngleRad;
  state.startAngleRad = aimAngleRad - halfArc;
  state.endAngleRad = aimAngleRad + halfArc;
  state.previousAngleRad = state.startAngleRad;
  state.currentAngleRad = state.startAngleRad;
  state.originXWorld = originXWorld;
  state.originYWorld = originYWorld;
  state.reachWorld = range;
  state.hitFlags.fill(0);

  // The cooldown starts at the swing, not at its end, matching the donor's
  // `weaponCooldownUntil = now + cooldown` at attack time.
  state.cooldownRemainingTicks = Math.max(state.durationTicks, getWeaponCooldownTicks(def));

  return true;
}

const _tickResult: WeaponSwingTickResult = { isFinished: false, hitCount: 0, totalDamage: 0 };

/**
 * Advances an active swing by one tick and applies damage to newly-swept targets.
 *
 * Returns a module-scoped result object — read it before the next call rather
 * than retaining it. Returns a finished result immediately when no swing is
 * active, so it is safe to call unconditionally each tick.
 */
export function tickWeaponSwing(
  state: WeaponSwingState,
  def: WeaponDef,
  context: WeaponSwingTickContext,
): WeaponSwingTickResult {
  _tickResult.isFinished = true;
  _tickResult.hitCount = 0;
  _tickResult.totalDamage = 0;
  if (state.activeFlag === 0) return _tickResult;

  state.ticksElapsed++;
  state.originXWorld = context.originXWorld;
  state.originYWorld = context.originYWorld;

  const t = Math.min(1, state.ticksElapsed / state.durationTicks);
  const sweepT = t <= SWING_WINDUP_FRACTION
    ? 0
    : (t - SWING_WINDUP_FRACTION) / (1 - SWING_WINDUP_FRACTION);

  state.previousAngleRad = state.currentAngleRad;
  state.currentAngleRad =
    state.startAngleRad + (state.endAngleRad - state.startAngleRad) * sweepT;

  applySwingHits(state, def, context, _tickResult);

  const isFinished = state.ticksElapsed >= state.durationTicks;
  if (isFinished) {
    state.activeFlag = 0;
    state.ticksElapsed = 0;
  }
  _tickResult.isFinished = isFinished;
  return _tickResult;
}

/**
 * Damages every target swept by the blade this tick.
 *
 * A target is hit when it is within reach and its bearing from the wielder
 * falls inside the angular interval the blade traversed this tick. Each target
 * is registered so it cannot be hit twice by the same swing.
 */
function applySwingHits(
  state: WeaponSwingState,
  def: WeaponDef,
  context: WeaponSwingTickContext,
  result: WeaponSwingTickResult,
): void {
  const targets = context.targets;
  const declaredCount = context.targetCount ?? targets.length;
  const liveCount = Math.max(0, Math.min(declaredCount, targets.length));
  const limit = Math.min(liveCount, MAX_HIT_REGISTRY_SLOTS);
  const baseDamage = typeof def.dmg === 'number' && Number.isFinite(def.dmg) ? def.dmg : 0;
  const knock = typeof def.knock === 'number' && Number.isFinite(def.knock) ? def.knock : 0;

  for (let i = 0; i < limit; i++) {
    if (state.hitFlags[i] === 1) continue;
    const target = targets[i];
    if (target === undefined || target.isAliveFlag === 0) continue;

    const dx = target.positionXWorld - state.originXWorld;
    const dy = target.positionYWorld - state.originYWorld;

    // Larger targets are correspondingly easier to clip, matching the way
    // swordWeave.ts folds the enemy half-size into its hit radius.
    const targetRadius = Math.min(target.halfWidthWorld, target.halfHeightWorld);
    const reach = state.reachWorld + targetRadius + SWING_EDGE_TOLERANCE_WORLD;
    const distSq = dx * dx + dy * dy;
    if (distSq > reach * reach) continue;

    // A target directly on top of the wielder has no meaningful bearing; treat
    // it as hit rather than letting atan2 noise decide.
    const bearingRad = distSq > 1e-9 ? Math.atan2(dy, dx) : state.currentAngleRad;
    if (
      distSq > 1e-9
      && !isAngleWithinSweptInterval(bearingRad, state.previousAngleRad, state.currentAngleRad)
    ) {
      continue;
    }

    state.hitFlags[i] = 1;

    const damage = computeStatDamage(
      baseDamage,
      context.attackerAttack,
      target.statsDefense ?? 0,
      context.rng,
    );
    if (damage <= 0) continue;

    const dist = Math.sqrt(distSq);
    const dirX = dist > 1e-9 ? dx / dist : Math.cos(state.currentAngleRad);
    const dirY = dist > 1e-9 ? dy / dist : Math.sin(state.currentAngleRad);

    result.hitCount++;
    result.totalDamage += damage;
    context.onHit?.(i, damage, dirX * knock, dirY * knock);
  }
}

// ---- Introspection --------------------------------------------------------

/**
 * Progress through the current swing in 0..1, or 0 when idle.
 * Intended for renderers and animation, not for hit logic.
 */
export function getWeaponSwingProgress(state: WeaponSwingState): number {
  if (state.activeFlag === 0 || state.durationTicks <= 0) return 0;
  return Math.min(1, state.ticksElapsed / state.durationTicks);
}

/** True when the swing is still winding up and the blade has not begun to travel. */
export function isWeaponSwingInWindup(state: WeaponSwingState): boolean {
  return state.activeFlag === 1 && getWeaponSwingProgress(state) <= SWING_WINDUP_FRACTION;
}
