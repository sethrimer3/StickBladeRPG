/**
 * Weapon definitions — typed schema over the ported STICK-RPG weapon table.
 *
 * Phase 2 of the STICK-RPG port (see `docs/decisions/STICK_RPG_PORT_PLAN.md`).
 * The data itself lives in `weaponData.ts`, ported verbatim from the donor's
 * `WEAPON_DEFS`; this module supplies the types, lookups, and the single
 * audited place where the donor's millisecond durations become tick counts.
 *
 * Unit rule: donor data is in milliseconds. `src/sim/` is tick-based and must
 * stay deterministic, so simulation code reads durations exclusively through
 * the `*Ticks` accessors here and never touches the raw `Ms` values.
 *
 * Runtime coverage is deliberately partial in this phase. `melee` and `shield`
 * weapons have working combat behavior (`weaponSwing.ts`); the projectile,
 * staff, summoner, and spirit kinds are ported as data only. Ask
 * `isWeaponRuntimeImplemented` rather than assuming.
 */

import { WEAPON_DATA, UNPORTED_BEHAVIOR_FIELDS } from './weaponData';

export { UNPORTED_BEHAVIOR_FIELDS };

// ---- Unions ---------------------------------------------------------------

/** Weapon archetype. Drives which runtime system, if any, handles the weapon. */
export type WeaponKind =
  | 'melee'
  | 'shield'
  | 'bow'
  | 'gun'
  | 'throw'
  | 'magic'
  | 'staff'
  | 'summoner'
  | 'spirit';

/** How the weapon occupies the wielder's hands. */
export type WeaponGrip = 'oneHand' | 'twoHand' | 'dual';

/** Damage element. Matches the glyph elements in `glyphDefs.ts` plus donor extras. */
export type WeaponElement =
  | 'physical'
  | 'fire'
  | 'ice'
  | 'light'
  | 'void'
  | 'chronometric'
  | 'necrotic'
  | 'water'
  | 'earth'
  | 'life'
  | 'explosive';

/** Donor weapon identifiers. */
export type WeaponId = string;

/**
 * Bespoke nested config blocks (`staff`, `shield`, `gunPose`, `boxingGlove`, …).
 *
 * These drive donor-specific renderers that this phase does not port. They are
 * carried through as opaque records so no data is silently lost; a later phase
 * that implements one of those renderers should replace the relevant field with
 * a precise type.
 */
export type WeaponVisualConfig = Readonly<Record<string, unknown>>;

// ---- Definition schema ----------------------------------------------------

/**
 * A single weapon.
 *
 * Field names match the donor exactly so this file can be diffed against
 * `js/weapons.js`. Everything except `name` and `kind` is optional because the
 * donor table is sparse — most weapons set only a handful of fields.
 */
export interface WeaponDef {
  // ---- Identity ----
  name: string;
  kind: WeaponKind;
  description?: string;
  grip?: WeaponGrip;
  element?: WeaponElement;
  /** Weapon is spawned only for enemies and never appears in player loadouts. */
  enemyOnly?: boolean;
  /** Donor-side experimental flag; kept for parity with the donor's filters. */
  experimental?: boolean;
  /** Weapon accepts a glyph, which overrides its element (see `glyphDefs.ts`). */
  glyphSocket?: boolean;
  /** False hides the weapon model while equipped. */
  showWeapon?: boolean;

  // ---- Core combat ----
  /** Base damage before attack-stat scaling (see `sim/stats/characterStats.ts`). */
  dmg?: number;
  /** Melee reach in world units. */
  range?: number;
  /** Melee swing arc in radians. */
  arc?: number;
  /** Knockback impulse applied on hit. */
  knock?: number;
  /** Time between attacks, MILLISECONDS. Use `getWeaponCooldownTicks`. */
  cooldown?: number;
  /** Swing animation length, MILLISECONDS. Use `getWeaponSwingDurationTicks`. */
  swingDuration?: number;
  /** Cast wind-up, MILLISECONDS. Use `getWeaponCastDurationTicks`. */
  castDuration?: number;
  /** Delay before the weapon re-sheathes, MILLISECONDS. */
  sheathDelayMs?: number;
  /** Percentage of damage dealt returned to the wielder as health. */
  lifeStealPercent?: number;

  // ---- Defensive ----
  defenseMultiplier?: number;
  healthMultiplier?: number;
  /** Marks the Templarian Wall Shield's bespoke bulwark behavior. */
  templarianWallShield?: boolean;
  /** Redirects damage taken by party members to the wielder. */
  partyDamageRedirect?: boolean;

  // ---- Thrust variant (spears/partisans) ----
  thrustArc?: number;
  thrustDamageMultiplier?: number;
  thrustDuration?: number;
  thrustKnockMultiplier?: number;
  thrustRangeMultiplier?: number;

  // ---- Projectile ----
  /** Projectile archetype id (`arrow`, `bolt`, `ember`, …). */
  projectile?: string;
  speed?: number;
  gravity?: boolean;
  spin?: boolean;
  spread?: number;
  bulletCount?: number;
  burstCount?: number;
  /** Projectile lifetime, MILLISECONDS. */
  ttl?: number;
  reloadMs?: number;
  fastReloadMs?: number;
  blastRadius?: number;
  blastDamage?: number;
  igniteRadius?: number;
  projectileBounce?: number;
  projectileColor?: string;
  projectileDamage?: number;
  projectileDrag?: number;
  projectileFadeRate?: number;
  projectileHaloSpin?: number;
  projectileHarmless?: boolean;
  projectileHoming?: boolean;
  projectileIgnoreStickCollision?: boolean;
  projectileIgnoreTerrain?: boolean;
  projectileLength?: number;
  projectileLiftForce?: number;
  projectileLiftRadius?: number;
  projectileLockTarget?: boolean;
  projectileMaxBounces?: number;
  projectileMaxSpeed?: number;
  projectilePushForce?: number;
  projectilePushRadius?: number;
  projectileRadius?: number;
  projectileReturnSpeed?: number;
  projectileSeekForce?: number;
  projectileTargetRadius?: number;
  projectileTipColor?: string;
  projectileTrailAlpha?: number;
  projectileTrailColor?: string;
  projectileTurnRate?: number;
  projectileSandPayload?: WeaponVisualConfig;
  projectileSingularity?: WeaponVisualConfig;

  // ---- Slash waves ----
  slashSparkCount?: number;
  slashWaveColor?: string;
  slashWaveCount?: number;
  slashWaveDamage?: number;
  slashWaveFade?: number;
  slashWaveProjectile?: string;
  slashWaveSpeed?: number;
  slashWaveSpread?: number;
  /** Slash wave lifetime, MILLISECONDS. */
  slashWaveTtl?: number;

  // ---- Status effects ----
  /** Slow duration, MILLISECONDS. */
  slowDuration?: number;
  slowMultiplier?: number;
  pullRadius?: number;
  pullStrength?: number;

  // ---- Summons ----
  maxActiveSummons?: number;
  summonAccentColor?: string;
  summonAimAssistRadius?: number;
  summonBounce?: number;
  summonCharges?: number;
  summonClimbLift?: number;
  summonColor?: string;
  summonDamage?: number;
  summonDrag?: number;
  summonForm?: string;
  summonHitBurstScale?: number;
  summonJumpStrength?: number;
  summonKnockScale?: number;
  /** Summon lifetime, MILLISECONDS. */
  summonLifetime?: number;
  summonMaxSpeed?: number;
  summonRadius?: number;
  summonSeekForce?: number;
  summonSpeed?: number;
  summonTurnRate?: number;
  spiderEyeColor?: string;
  spiderLaunchLift?: number;
  spiderLaunchSpeed?: number;
  spiderLegColor?: string;
  spiderMarchForce?: number;
  spiderMarchHopForce?: number;
  spiderMarchLift?: number;

  // ---- Orbiting spirits / halos ----
  orbCount?: number;
  orbColor?: string;
  orbRadius?: number;
  /** Orb regeneration interval, MILLISECONDS. */
  orbRegenMs?: number;
  orbTrailColor?: string;
  orbitRadius?: number;
  orbitSpeed?: number;
  driftAmplitude?: number;
  driftFrequency?: number;
  /** Empower recharge, MILLISECONDS. */
  empowerCooldown?: number;

  // ---- Souls / guardians ----
  maxSouls?: number;
  soulColor?: string;
  soulRange?: number;
  guardianBaseDamage?: number;
  guardianColor?: string;
  guardianRadius?: number;

  // ---- Enemy-specific presentation ----
  enemyStyle?: string;
  /** Flop-stab animation length, MILLISECONDS. */
  flopDuration?: number;
  yankLift?: number;
  yankVelocity?: number;

  // ---- Void flame trim ----
  tipVoidFlame?: boolean;
  voidFlameGravity?: number;
  voidFlameIntensity?: number;
  voidFlameOffset?: number;
  voidFlameParticleCount?: number;
  voidFlameSpeed?: number;
  voidFlameSpeedVariance?: number;
  voidFlameSpread?: number;

  // ---- Presentation ----
  color?: string;
  highlightColor?: string;
  ammoColor?: string;
  poseStyle?: string;
  lightEmitterRadius?: number;
  beamCoreColor?: string;
  beamEdgeColor?: string;
  beamGlowColor?: string;
  birdAccentColor?: string;
  birdLineColor?: string;
  bookPageColor?: string;
  bookRuneColor?: string;
  bookTrimColor?: string;
  scopeColor?: string;

  // ---- Opaque donor config blocks (renderers not ported this phase) ----
  auric?: WeaponVisualConfig;
  boxingGlove?: WeaponVisualConfig;
  charge?: WeaponVisualConfig;
  crumbling?: WeaponVisualConfig;
  gunPose?: WeaponVisualConfig;
  lightLineExperiment?: WeaponVisualConfig;
  photostigma?: WeaponVisualConfig;
  shield?: WeaponVisualConfig;
  spearPose?: WeaponVisualConfig;
  staff?: WeaponVisualConfig;
  timeBlade?: WeaponVisualConfig;
}

// ---- Tick conversion ------------------------------------------------------

/**
 * Simulation tick length in milliseconds. Matches the fixed timestep in
 * `sim/tick.ts` (16.666 ms). Declared locally so this module stays free of
 * simulation imports and remains trivially Node-testable.
 */
export const MS_PER_TICK = 1000 / 60;

/**
 * Converts a donor millisecond duration to whole simulation ticks.
 *
 * Rounds to nearest and floors at 1 tick for any positive input, so a very
 * short donor duration becomes a real (if brief) window rather than vanishing
 * into a zero-tick no-op. Non-finite or non-positive input yields 0.
 */
export function millisecondsToTicks(milliseconds: number | undefined): number {
  if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds)) return 0;
  if (milliseconds <= 0) return 0;
  return Math.max(1, Math.round(milliseconds / MS_PER_TICK));
}

/** Attack cooldown in ticks. Returns 0 when the weapon declares no cooldown. */
export function getWeaponCooldownTicks(def: WeaponDef): number {
  return millisecondsToTicks(def.cooldown);
}

/**
 * Swing animation length in ticks.
 *
 * Donor weapons that omit `swingDuration` animate for their full cooldown, so
 * that is the fallback here.
 */
export function getWeaponSwingDurationTicks(def: WeaponDef): number {
  const explicit = millisecondsToTicks(def.swingDuration);
  return explicit > 0 ? explicit : getWeaponCooldownTicks(def);
}

/** Cast wind-up in ticks. */
export function getWeaponCastDurationTicks(def: WeaponDef): number {
  return millisecondsToTicks(def.castDuration);
}

/** Projectile lifetime in ticks. */
export function getWeaponProjectileTtlTicks(def: WeaponDef): number {
  return millisecondsToTicks(def.ttl);
}

/** Thrust animation length in ticks. */
export function getWeaponThrustDurationTicks(def: WeaponDef): number {
  return millisecondsToTicks(def.thrustDuration);
}

// ---- Lookup ---------------------------------------------------------------

/** Every weapon, keyed by id. */
export const WEAPONS: Readonly<Record<WeaponId, WeaponDef>> = WEAPON_DATA;

/** All weapon ids, in stable alphabetical order. */
export const WEAPON_IDS: readonly WeaponId[] = Object.freeze(Object.keys(WEAPON_DATA).sort());

/** Returns the weapon with `id`, or null when no such weapon exists. */
export function getWeaponDef(id: string | null | undefined): WeaponDef | null {
  if (typeof id !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(WEAPON_DATA, id) ? WEAPON_DATA[id] : null;
}

/** Returns every weapon of `kind`, in stable id order. */
export function getWeaponIdsOfKind(kind: WeaponKind): WeaponId[] {
  return WEAPON_IDS.filter(id => WEAPON_DATA[id].kind === kind);
}

/** True when the weapon can appear in a player loadout (i.e. is not enemy-only). */
export function isPlayerEquippableWeapon(def: WeaponDef): boolean {
  return def.enemyOnly !== true;
}

/**
 * Weapon kinds whose combat behavior actually runs.
 *
 * Phase 2 implemented contact weapons (`weaponSwing.ts`); Phase 2a added the
 * projectile kinds (`weaponProjectiles.ts`); Phase 2c added channelled staves
 * (`staffChannel.ts`) and orbiting spirit familiars (`spiritOrbs.ts`).
 * `summoner` remains data-only — persistent allied entities with their own AI
 * are their own system. See the follow-up item in `docs/Todo.md`.
 *
 * Note this reports the KIND's coverage, not every donor flourish:
 *   • Twelve weapons declare on-expiry callbacks that spawn bespoke secondary
 *     effects (pollen clouds, steam vents, gust shockwaves), still unported and
 *     listed in `UNPORTED_BEHAVIOR_FIELDS`.
 *   • Two staff auras are unported — `aegisStaff`'s projectile shield and
 *     `gravebindStaff`'s raise-on-death. `getStaffChannelKind` reports
 *     `STAFF_CHANNEL_NONE` for those, and `equipPlayerWeapon` refuses them, so
 *     neither can be equipped as a dead weapon.
 */
const RUNTIME_IMPLEMENTED_KINDS: ReadonlySet<WeaponKind> = new Set<WeaponKind>([
  'melee',
  'shield',
  'bow',
  'gun',
  'throw',
  'magic',
  'staff',
  'spirit',
]);

/** True when this weapon's kind has working combat behavior in the current build. */
export function isWeaponRuntimeImplemented(def: WeaponDef): boolean {
  return RUNTIME_IMPLEMENTED_KINDS.has(def.kind);
}

/** Effective element for a weapon with no glyph socketed. */
export function getWeaponBaseElement(def: WeaponDef): WeaponElement {
  return def.element ?? 'physical';
}
