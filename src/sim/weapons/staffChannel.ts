/**
 * Staff channelling — the charge meter, sustained beams, and stat auras.
 *
 * Phase 2c of the STICK-RPG port. Staves are not projectile weapons: each one
 * carries a `staff` config block describing a charge reservoir that regenerates
 * over time and drains while channelled, driving one of two effects:
 *
 *   • **Beam** (`damagePerSecond` + `range`) — a hitscan ray from the wielder
 *     toward the aim, damaging the first enemy it meets and stopping on terrain
 *     when `stopOnObjects` is set.
 *   • **Aura** (`aura.attackMultiplier` / `defenseMultiplier` /
 *     `healthMultiplier`) — a stat multiplier applied while channelling, which
 *     feeds straight into the Phase 1 `StatModifiers` contract.
 *
 * Phase 2e added the two bespoke auras, so every donor staff now channels:
 * `aegisStaff`'s `projectileShield` (see `projectileShield.ts`) and
 * `gravebindStaff`'s `raiseOnDeath` (see `raiseThrallFromCorpse` in
 * `weaponSummons.ts`). Neither contributes a stat multiplier, so both report
 * `STAFF_CHANNEL_AURA` while `getStaffAuraModifiers` returns identity for them.
 * Ally targeting remains approximate — the ported auras set `includeSelf: true`
 * and only the wielder is affected.
 *
 * Deterministic and allocation-free per tick: charge is integrated from
 * `dtMs`, and beam damage rolls come from an injected `RngState`.
 */

import type { WorldState } from '../world';
import type { ClusterState } from '../clusters/state';
import type { RngState } from '../rng';
import { raycastWalls } from '../clusters/grappleShared';
import { applyRoutedWeaveDamage, segmentPointDistanceSq } from '../weaves/weaveCollisionUtils';
import { computeStatDamage, type StatModifiers } from '../stats/characterStats';
import type { WeaponDef } from './weaponDefs';

// ---- Config extraction ----------------------------------------------------

/**
 * The donor `staff` block, read defensively.
 *
 * The block travels as an opaque record in the weapon data (see
 * `WeaponVisualConfig`), so every field is read through a checked accessor
 * rather than trusted — a malformed or partial block must degrade, not throw.
 */
function readNumber(config: Readonly<Record<string, unknown>> | undefined, key: string): number | undefined {
  const value = config?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readBoolean(config: Readonly<Record<string, unknown>> | undefined, key: string): boolean {
  return config?.[key] === true;
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
 * Reads a target's defense stat.
 *
 * `ClusterState` does not declare `statsDefense` — enemy stats arrive with a
 * later phase — so this reads it structurally and treats its absence as no
 * mitigation, matching how `weaponSwing.ts` types its targets.
 */
function getTargetDefense(target: ClusterState): number {
  const defense = (target as ClusterState & { statsDefense?: number }).statsDefense;
  return typeof defense === 'number' && Number.isFinite(defense) ? defense : 0;
}

/** What a staff does while channelled. */
export const STAFF_CHANNEL_NONE = 0;
export const STAFF_CHANNEL_BEAM = 1;
export const STAFF_CHANNEL_AURA = 2;

export type StaffChannelKind =
  | typeof STAFF_CHANNEL_NONE
  | typeof STAFF_CHANNEL_BEAM
  | typeof STAFF_CHANNEL_AURA;

/**
 * Classifies a staff by what this port can actually do with it.
 *
 * Returns `STAFF_CHANNEL_NONE` for a staff whose only effect is one of the
 * unported bespoke auras, so callers never present it as functional.
 */
export function getStaffChannelKind(def: WeaponDef): StaffChannelKind {
  if (def.kind !== 'staff') return STAFF_CHANNEL_NONE;
  const staff = def.staff;
  if (staff === undefined) return STAFF_CHANNEL_NONE;

  if (readNumber(staff, 'damagePerSecond') !== undefined) return STAFF_CHANNEL_BEAM;

  const aura = readObject(staff, 'aura');
  if (aura !== undefined) {
    const hasPortedEffect =
      readNumber(aura, 'attackMultiplier') !== undefined
      || readNumber(aura, 'defenseMultiplier') !== undefined
      || readNumber(aura, 'healthMultiplier') !== undefined
      // Phase 2e: the two bespoke auras. Neither contributes a stat multiplier —
      // the ward is a damage pool and raise-on-death is an event hook — but both
      // are real channelled effects, so the staves are functional.
      || readObject(aura, 'projectileShield') !== undefined
      || readObject(aura, 'raiseOnDeath') !== undefined;
    if (hasPortedEffect) return STAFF_CHANNEL_AURA;
  }

  return STAFF_CHANNEL_NONE;
}

/** Default charge reservoir size when the donor block omits `maxCharge`. */
const DEFAULT_MAX_CHARGE = 1;

// ---- State ----------------------------------------------------------------

/** Channelling state for the equipped staff. */
export interface StaffChannelState {
  /** Current charge, 0..maxCharge. */
  charge: number;
  /** 1 while the staff is actively channelling. */
  isChannellingFlag: 0 | 1;
  /** World-space aim point for the current channel. */
  aimXWorld: number;
  aimYWorld: number;
  /** Endpoint the beam actually reached last tick — for the renderer. */
  beamEndXWorld: number;
  beamEndYWorld: number;
  /** 1 when a beam was drawn last tick. */
  beamActiveFlag: 0 | 1;
}

/** Allocates idle staff state with a full charge. */
export function createStaffChannelState(): StaffChannelState {
  return {
    charge: DEFAULT_MAX_CHARGE,
    isChannellingFlag: 0,
    aimXWorld: 0,
    aimYWorld: 0,
    beamEndXWorld: 0,
    beamEndYWorld: 0,
    beamActiveFlag: 0,
  };
}

/** Restores a full charge and stops channelling. Used on room change and respawn. */
export function resetStaffChannelState(state: StaffChannelState): void {
  state.charge = DEFAULT_MAX_CHARGE;
  state.isChannellingFlag = 0;
  state.beamActiveFlag = 0;
}

/** Charge as a 0..1 fraction, for the HUD meter. */
export function getStaffChargeFraction(state: StaffChannelState, def: WeaponDef): number {
  const max = readNumber(def.staff, 'maxCharge') ?? DEFAULT_MAX_CHARGE;
  if (max <= 0) return 0;
  return Math.max(0, Math.min(1, state.charge / max));
}

/**
 * Requests channelling toward an aim point.
 *
 * Returns false when the staff cannot start: not a staff, no ported effect, or
 * charge below the donor's `minChargeToFire` threshold. Safe to call every tick
 * while the attack input is held.
 */
export function requestStaffChannel(
  state: StaffChannelState,
  def: WeaponDef,
  aimXWorld: number,
  aimYWorld: number,
): boolean {
  if (getStaffChannelKind(def) === STAFF_CHANNEL_NONE) return false;

  const minCharge = readNumber(def.staff, 'minChargeToFire') ?? 0;
  // The threshold gates STARTING a channel; an already-running channel is
  // allowed to drain below it and is cut off when charge actually hits zero.
  if (state.isChannellingFlag === 0 && state.charge < minCharge) return false;

  state.isChannellingFlag = 1;
  state.aimXWorld = aimXWorld;
  state.aimYWorld = aimYWorld;
  return true;
}

/** Stops channelling. Called when the attack input is released. */
export function releaseStaffChannel(state: StaffChannelState): void {
  state.isChannellingFlag = 0;
  state.beamActiveFlag = 0;
}

// ---- Per-tick -------------------------------------------------------------

/** Outcome of one channelling tick. */
export interface StaffChannelTickResult {
  /** Enemies damaged this tick. */
  hitCount: number;
  /** Total damage dealt this tick. */
  totalDamage: number;
  /** True while the staff is channelling and has charge left. */
  isActive: boolean;
}

const _tickResult: StaffChannelTickResult = { hitCount: 0, totalDamage: 0, isActive: false };

/**
 * Advances the staff by one tick: drains or regenerates charge, then applies
 * the beam if one is channelling.
 *
 * Aura staves apply nothing here — an aura is a stat modifier, read through
 * `getStaffAuraModifiers` wherever stats are resolved, so it cannot drift out
 * of sync with the charge state.
 *
 * Returns a module-scoped result; read it before the next call.
 */
export function tickStaffChannel(
  world: WorldState,
  state: StaffChannelState,
  def: WeaponDef,
  player: ClusterState | null,
  attackerAttack: number,
  rng: RngState,
): StaffChannelTickResult {
  _tickResult.hitCount = 0;
  _tickResult.totalDamage = 0;
  _tickResult.isActive = false;
  state.beamActiveFlag = 0;

  const kind = getStaffChannelKind(def);
  if (kind === STAFF_CHANNEL_NONE) {
    state.isChannellingFlag = 0;
    return _tickResult;
  }

  const staff = def.staff;
  const maxCharge = readNumber(staff, 'maxCharge') ?? DEFAULT_MAX_CHARGE;
  const dtSec = world.dtMs / 1000;

  if (state.isChannellingFlag === 1 && player !== null) {
    const drain = readNumber(staff, 'drainPerSecond') ?? 0;
    state.charge -= drain * dtSec;
    if (state.charge <= 0) {
      // Out of charge: the channel cuts out and the reservoir starts refilling
      // next tick, exactly as the donor's meter behaves.
      state.charge = 0;
      state.isChannellingFlag = 0;
    } else {
      _tickResult.isActive = true;
      if (kind === STAFF_CHANNEL_BEAM) {
        applyStaffBeam(world, state, def, player, attackerAttack, rng, _tickResult);
      }
    }
  } else {
    const regen = readNumber(staff, 'regenPerSecond') ?? 0;
    state.charge = Math.min(maxCharge, state.charge + regen * dtSec);
  }

  return _tickResult;
}

/**
 * Fires the beam for one tick.
 *
 * The beam is a ray from the player toward the aim, clipped to terrain when the
 * donor sets `stopOnObjects`, damaging the nearest enemy along it. Damage is
 * `damagePerSecond` scaled by the tick length, so the rate is independent of
 * timestep.
 */
function applyStaffBeam(
  world: WorldState,
  state: StaffChannelState,
  def: WeaponDef,
  player: ClusterState,
  attackerAttack: number,
  rng: RngState,
  result: StaffChannelTickResult,
): void {
  const staff = def.staff;
  const range = readNumber(staff, 'range') ?? 0;
  const damagePerSecond = readNumber(staff, 'damagePerSecond') ?? 0;
  if (range <= 0 || damagePerSecond <= 0) return;

  const originX = player.positionXWorld;
  const originY = player.positionYWorld;
  const dx = state.aimXWorld - originX;
  const dy = state.aimYWorld - originY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist <= 1e-6) return;

  const dirX = dx / dist;
  const dirY = dy / dist;

  let reach = range;
  if (readBoolean(staff, 'stopOnObjects')) {
    const hit = raycastWalls(world, originX, originY, dirX, dirY, range);
    if (hit !== null) reach = hit.t;
  }

  const endX = originX + dirX * reach;
  const endY = originY + dirY * reach;
  state.beamEndXWorld = endX;
  state.beamEndYWorld = endY;
  state.beamActiveFlag = 1;

  // Damage the NEAREST enemy on the ray rather than everything along it: the
  // donor's beams stop at the first body they meet.
  const beamRadius = readNumber(staff, 'beamRadius') ?? 8;
  const clusters = world.clusters;
  let nearestIndex = -1;
  let nearestDistSq = Number.POSITIVE_INFINITY;

  for (let ci = 0; ci < clusters.length; ci++) {
    const c = clusters[ci];
    if (c.isPlayerFlag === 1 || c.isAliveFlag === 0) continue;

    const hitRadius = beamRadius + Math.min(c.halfWidthWorld, c.halfHeightWorld);
    const distToBeamSq = segmentPointDistanceSq(
      originX, originY, endX, endY, c.positionXWorld, c.positionYWorld,
    );
    if (distToBeamSq > hitRadius * hitRadius) continue;

    const ex = c.positionXWorld - originX;
    const ey = c.positionYWorld - originY;
    const alongSq = ex * ex + ey * ey;
    if (alongSq < nearestDistSq) {
      nearestDistSq = alongSq;
      nearestIndex = ci;
    }
  }
  if (nearestIndex === -1) return;

  const target = clusters[nearestIndex];
  const damage = computeStatDamage(
    damagePerSecond * (world.dtMs / 1000),
    attackerAttack,
    getTargetDefense(target),
    rng,
  );
  if (damage <= 0) return;

  applyRoutedWeaveDamage(world, nearestIndex, damage, target.positionXWorld, target.positionYWorld);
  result.hitCount++;
  result.totalDamage += damage;

  // The beam visually terminates at the body it struck.
  state.beamEndXWorld = target.positionXWorld;
  state.beamEndYWorld = target.positionYWorld;
}

// ---- Auras ----------------------------------------------------------------

const _auraModifiers: StatModifiers = {};

/**
 * Stat multipliers contributed by an actively-channelling aura staff.
 *
 * Returns an empty modifier set when nothing applies, so callers can pass the
 * result straight to `computeDerivedStats` unconditionally. The returned object
 * is module-scoped — read it before the next call.
 *
 * Only the wielder is affected today: every ported aura sets `includeSelf`, and
 * ally targeting has no meaning until the Phase 3 party exists.
 */
export function getStaffAuraModifiers(
  state: StaffChannelState,
  def: WeaponDef | null,
): StatModifiers {
  _auraModifiers.attackMultiplier = 1;
  _auraModifiers.defenseMultiplier = 1;
  _auraModifiers.healthMultiplier = 1;

  if (def === null) return _auraModifiers;
  if (state.isChannellingFlag === 0 || state.charge <= 0) return _auraModifiers;
  if (getStaffChannelKind(def) !== STAFF_CHANNEL_AURA) return _auraModifiers;

  const aura = readObject(def.staff, 'aura');
  if (aura === undefined) return _auraModifiers;

  _auraModifiers.attackMultiplier = readNumber(aura, 'attackMultiplier') ?? 1;
  _auraModifiers.defenseMultiplier = readNumber(aura, 'defenseMultiplier') ?? 1;
  _auraModifiers.healthMultiplier = readNumber(aura, 'healthMultiplier') ?? 1;
  return _auraModifiers;
}

/**
 * The donor `aura.raiseOnDeath` block: what a felled enemy becomes.
 *
 * Phase 2e. Read defensively like every other `staff` sub-block, and returned
 * as plain numbers so the summon pool needs no knowledge of the donor schema.
 */
export interface RaiseOnDeathConfig {
  lifetimeMs: number;
  damageMultiplier: number;
  defenseMultiplier: number;
  healthMultiplier: number;
  /** Thrall size relative to the enemy it was raised from. */
  scale: number;
}

/** Raise-on-death configuration for a staff, or null when it declares none. */
export function getStaffRaiseOnDeathConfig(def: WeaponDef | null): RaiseOnDeathConfig | null {
  if (def === null || def.kind !== 'staff') return null;
  const raise = readObject(readObject(def.staff, 'aura'), 'raiseOnDeath');
  if (raise === undefined) return null;

  return {
    lifetimeMs: readNumber(raise, 'lifetimeMs') ?? 0,
    damageMultiplier: readNumber(raise, 'damageMultiplier') ?? 1,
    defenseMultiplier: readNumber(raise, 'defenseMultiplier') ?? 1,
    healthMultiplier: readNumber(raise, 'healthMultiplier') ?? 1,
    scale: readNumber(raise, 'scale') ?? 1,
  };
}

/**
 * True when the staff's aura is currently reaching a world point.
 *
 * The ward and raise-on-death both need this: an aura only acts while it is
 * actually channelled, and only within its own radius.
 */
export function isPointInsideActiveStaffAura(
  state: StaffChannelState,
  def: WeaponDef | null,
  originXWorld: number,
  originYWorld: number,
  pointXWorld: number,
  pointYWorld: number,
): boolean {
  if (def === null) return false;
  if (state.isChannellingFlag === 0 || state.charge <= 0) return false;

  const radius = readNumber(readObject(def.staff, 'aura'), 'radius') ?? 0;
  if (radius <= 0) return false;

  const dx = pointXWorld - originXWorld;
  const dy = pointYWorld - originYWorld;
  return dx * dx + dy * dy <= radius * radius;
}

/** Aura radius in world units, or 0 when the staff has no ported aura. */
export function getStaffAuraRadius(def: WeaponDef | null): number {
  if (def === null || getStaffChannelKind(def) !== STAFF_CHANNEL_AURA) return 0;
  return readNumber(readObject(def.staff, 'aura'), 'radius') ?? 0;
}
