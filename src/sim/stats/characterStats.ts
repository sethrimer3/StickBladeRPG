/**
 * Character stats — level, experience, attack/defense/health, and skill points.
 *
 * This is Phase 1 of the STICK-RPG port (see
 * `docs/decisions/STICK_RPG_PORT_PLAN.md`). The formulas are ported from the
 * donor prototype's `Stick` constructor and `addXp` (`js/stickman.js`),
 * `computeDamage` (`js/stickman/combat.js`), and `computeLocalSkillMultipliers`
 * (`js/equipment.js`).
 *
 * The module is pure and Node-safe: no DOM, no wall clock, and no
 * `Math.random()`. The donor's damage mitigation roll used `Math.random()`
 * directly; here it is driven by an explicit `RngState` so simulation stays
 * deterministic.
 *
 * Naming note: this "level" is the character/combat level and is distinct from
 * `PlayerProgress.level`, which is StickBlade's dust-slot level. They advance on
 * different axes and must not be conflated.
 */

import { nextFloat, type RngState } from '../rng';

// ---- Constants (ported) ---------------------------------------------------

/** Starting maximum health at level 1. Donor: `this.hp = 50; this.maxHp = 50`. */
export const BASE_MAX_HEALTH = 50;
/** Starting attack stat. Donor: `this.attackBase = 1`. */
export const BASE_ATTACK = 1;
/** Starting defense stat. Donor: `this.defenseBase = 1`. */
export const BASE_DEFENSE = 1;
/**
 * Experience required to reach level 2.
 *
 * The donor is inconsistent here: `createStickProfile` (`js/main.js`) sets
 * `nextXp: Infinity`, while the recruitment path in `js/hud.js` uses `40`. `40`
 * is the value that actually governs leveling in play, so it is the one ported.
 */
export const BASE_XP_TO_NEXT_LEVEL = 40;
/** Multiplier applied to the XP requirement on each level-up. */
export const XP_REQUIREMENT_GROWTH = 1.45;
/** Maximum health gained per level-up. */
export const MAX_HEALTH_PER_LEVEL = 12;
/**
 * Skill points granted per level-up.
 *
 * Donor value is `1` (`js/stickman/constants.js`). Two donor call sites fall
 * back to `3` when the constant reads as undefined; that fallback is a bug in
 * the donor, not an intended alternate rate, and is deliberately not ported.
 */
export const SKILL_POINTS_PER_LEVEL = 1;

/** Highest character level the XP curve is defined for. */
export const MAX_CHARACTER_LEVEL = 99;

// ---- Types ----------------------------------------------------------------

/** The three stat tracks a skill point can be spent on. */
export type SkillTrack = 'health' | 'attack' | 'defense';

/** Points the player has spent on each stat track. */
export interface SkillAllocations {
  health: number;
  attack: number;
  defense: number;
}

/** Persisted, authored-forward character stat state. */
export interface CharacterStats {
  /** Character/combat level, 1..MAX_CHARACTER_LEVEL. */
  level: number;
  /** Experience accumulated toward the next level (never negative). */
  xp: number;
  /** Experience required to advance from the current level to the next. */
  xpToNextLevel: number;
  /** Attack before skill, aura, and equipment scaling. */
  attackBase: number;
  /** Defense before skill, aura, and equipment scaling. */
  defenseBase: number;
  /** Maximum health before skill, aura, and equipment scaling. */
  maxHealthBase: number;
  /** Unspent skill points. */
  skillPoints: number;
  /** Points spent per stat track. */
  skillAllocations: SkillAllocations;
}

/**
 * Additive and multiplicative modifiers contributed by equipment and auras.
 *
 * Kept as an explicit input rather than read from equipment here so this module
 * stays free of any dependency on the (not yet ported) Phase 2 weapon defs.
 */
export interface StatModifiers {
  attackBonus?: number;
  defenseBonus?: number;
  maxHealthBonus?: number;
  attackMultiplier?: number;
  defenseMultiplier?: number;
  healthMultiplier?: number;
}

/** Fully resolved stats used by combat. */
export interface DerivedStats {
  attack: number;
  defense: number;
  maxHealth: number;
}

/** Result of a `grantExperience` call. */
export interface ExperienceGrantResult {
  /** Number of levels gained (0 if none). */
  levelsGained: number;
  /** Skill points granted by those levels. */
  skillPointsGained: number;
  /** Maximum health gained by those levels. */
  maxHealthGained: number;
}

// ---- Factories ------------------------------------------------------------

/** Returns a zeroed skill allocation record. */
export function createDefaultSkillAllocations(): SkillAllocations {
  return { health: 0, attack: 0, defense: 0 };
}

/** Returns the level-1 starting stats for a fresh character. */
export function createDefaultCharacterStats(): CharacterStats {
  return {
    level: 1,
    xp: 0,
    xpToNextLevel: BASE_XP_TO_NEXT_LEVEL,
    attackBase: BASE_ATTACK,
    defenseBase: BASE_DEFENSE,
    maxHealthBase: BASE_MAX_HEALTH,
    skillPoints: 0,
    skillAllocations: createDefaultSkillAllocations(),
  };
}

// ---- Derived stats --------------------------------------------------------

/** Coerces an arbitrary value to a finite number, falling back to `fallback`. */
function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Coerces a value to a finite non-negative number. */
function nonNegative(value: unknown, fallback: number): number {
  return Math.max(0, finiteOr(value, fallback));
}

/**
 * Converts skill allocations to stat multipliers.
 *
 * Ported from the donor's `computeLocalSkillMultipliers`: each spent point adds
 * a full multiple, so N points on a track yields a `1 + N` multiplier.
 */
export function computeSkillMultipliers(allocations: SkillAllocations): DerivedStats {
  return {
    attack: 1 + nonNegative(allocations?.attack, 0),
    defense: 1 + nonNegative(allocations?.defense, 0),
    maxHealth: 1 + nonNegative(allocations?.health, 0),
  };
}

/**
 * Resolves base stats plus skill, aura, and equipment scaling into the values
 * combat actually uses.
 *
 * Order of operations: `base × skillMultiplier × auraMultiplier + flatBonus`.
 * The donor recovered its base values by *dividing* the current stat by the
 * aura multiplier (`cacheBaseStatsFromCurrent`), which drifts whenever a
 * multiplier reaches zero. Here bases are stored explicitly and only ever
 * derived forward, so the drift cannot occur.
 */
export function computeDerivedStats(
  stats: CharacterStats,
  modifiers?: StatModifiers,
): DerivedStats {
  const skill = computeSkillMultipliers(stats.skillAllocations);

  const attackMultiplier = nonNegative(modifiers?.attackMultiplier, 1);
  const defenseMultiplier = nonNegative(modifiers?.defenseMultiplier, 1);
  const healthMultiplier = nonNegative(modifiers?.healthMultiplier, 1);

  const attack =
    nonNegative(stats.attackBase, BASE_ATTACK) * skill.attack * attackMultiplier
    + finiteOr(modifiers?.attackBonus, 0);
  const defense =
    nonNegative(stats.defenseBase, BASE_DEFENSE) * skill.defense * defenseMultiplier
    + finiteOr(modifiers?.defenseBonus, 0);
  const maxHealth =
    nonNegative(stats.maxHealthBase, BASE_MAX_HEALTH) * skill.maxHealth * healthMultiplier
    + finiteOr(modifiers?.maxHealthBonus, 0);

  return {
    attack: Math.max(0, attack),
    defense: Math.max(0, defense),
    maxHealth: Math.max(0, maxHealth),
  };
}

// ---- Damage ---------------------------------------------------------------

/**
 * Computes stat-scaled damage for a single hit.
 *
 * Ported from the donor's `computeDamage`:
 * `max(0, base × attack − random() × defense)`. Mitigation is a roll rather
 * than a flat subtraction, so a defender with high defense usually — but not
 * always — absorbs the hit. `rng` is advanced exactly once when `defense > 0`
 * and not at all otherwise, which keeps replays stable.
 */
export function computeStatDamage(
  baseDamage: number,
  attackerAttack: number,
  targetDefense: number,
  rng: RngState,
): number {
  const base = nonNegative(baseDamage, 0);
  const attack = nonNegative(attackerAttack, 0);
  const defense = nonNegative(targetDefense, 0);

  const raw = base * attack;
  if (raw <= 0) return 0;

  const mitigation = defense > 0 ? nextFloat(rng) * defense : 0;
  return Math.max(0, raw - mitigation);
}

// ---- Experience -----------------------------------------------------------

/** Returns the XP requirement for the level after `xpToNextLevel`'s level. */
function advanceXpRequirement(current: number): number {
  return Math.max(1, Math.floor(current * XP_REQUIREMENT_GROWTH));
}

/**
 * Adds experience and applies any resulting level-ups in place.
 *
 * Ported from the donor's `addXp`. Each level-up raises `maxHealthBase` by
 * `MAX_HEALTH_PER_LEVEL`, grants `SKILL_POINTS_PER_LEVEL`, and scales the next
 * requirement by `XP_REQUIREMENT_GROWTH`. Unlike the donor, this does not touch
 * current health — the caller decides whether a level-up heals, because health
 * lives on the cluster, not on the stat record.
 *
 * At `MAX_CHARACTER_LEVEL` further experience is discarded and `xp` is pinned
 * to 0, so the donor's `while` loop cannot spin on a saturated requirement.
 */
export function grantExperience(stats: CharacterStats, amount: number): ExperienceGrantResult {
  const gain = nonNegative(amount, 0);
  const result: ExperienceGrantResult = {
    levelsGained: 0,
    skillPointsGained: 0,
    maxHealthGained: 0,
  };
  if (gain <= 0) return result;

  if (stats.level >= MAX_CHARACTER_LEVEL) {
    stats.xp = 0;
    return result;
  }

  stats.xp += gain;

  while (stats.xp >= stats.xpToNextLevel && stats.level < MAX_CHARACTER_LEVEL) {
    stats.xp -= stats.xpToNextLevel;
    stats.level += 1;
    stats.maxHealthBase += MAX_HEALTH_PER_LEVEL;
    stats.skillPoints += SKILL_POINTS_PER_LEVEL;
    stats.xpToNextLevel = advanceXpRequirement(stats.xpToNextLevel);

    result.levelsGained += 1;
    result.skillPointsGained += SKILL_POINTS_PER_LEVEL;
    result.maxHealthGained += MAX_HEALTH_PER_LEVEL;
  }

  if (stats.level >= MAX_CHARACTER_LEVEL) stats.xp = 0;

  return result;
}

// ---- Skill points ---------------------------------------------------------

/**
 * Spends one skill point on `track`. Returns true if a point was spent.
 *
 * No-ops when the player has no unspent points, so callers can drive this
 * straight from a UI click without pre-checking.
 */
export function allocateSkillPoint(stats: CharacterStats, track: SkillTrack): boolean {
  if (stats.skillPoints <= 0) return false;
  stats.skillPoints -= 1;
  stats.skillAllocations[track] += 1;
  return true;
}

/**
 * Refunds every spent skill point back into the unspent pool.
 * Returns the number of points refunded.
 */
export function respecSkillPoints(stats: CharacterStats): number {
  const spent =
    nonNegative(stats.skillAllocations.health, 0)
    + nonNegative(stats.skillAllocations.attack, 0)
    + nonNegative(stats.skillAllocations.defense, 0);
  stats.skillAllocations = createDefaultSkillAllocations();
  stats.skillPoints += spent;
  return spent;
}

// ---- Persistence ----------------------------------------------------------

/**
 * Repairs a stat record loaded from disk.
 *
 * Saves predate this module, arrive from older builds, or can be hand-edited,
 * so every field is clamped to a legal value rather than trusted. Returns a new
 * record; the input is never mutated.
 */
export function sanitizeCharacterStats(value: unknown): CharacterStats {
  const defaults = createDefaultCharacterStats();
  if (value === null || typeof value !== 'object') return defaults;

  const raw = value as Partial<CharacterStats>;
  const rawAllocations = (raw.skillAllocations ?? {}) as Partial<SkillAllocations>;

  const level = Math.min(
    MAX_CHARACTER_LEVEL,
    Math.max(1, Math.floor(finiteOr(raw.level, defaults.level))),
  );

  const stats: CharacterStats = {
    level,
    xp: Math.floor(nonNegative(raw.xp, 0)),
    xpToNextLevel: Math.max(1, Math.floor(finiteOr(raw.xpToNextLevel, defaults.xpToNextLevel))),
    attackBase: nonNegative(raw.attackBase, defaults.attackBase),
    defenseBase: nonNegative(raw.defenseBase, defaults.defenseBase),
    maxHealthBase: Math.max(1, finiteOr(raw.maxHealthBase, defaults.maxHealthBase)),
    skillPoints: Math.floor(nonNegative(raw.skillPoints, 0)),
    skillAllocations: {
      health: Math.floor(nonNegative(rawAllocations.health, 0)),
      attack: Math.floor(nonNegative(rawAllocations.attack, 0)),
      defense: Math.floor(nonNegative(rawAllocations.defense, 0)),
    },
  };

  // A maxed character has nothing left to spend XP on; pin it so the save does
  // not carry a requirement it can never meet.
  if (stats.level >= MAX_CHARACTER_LEVEL) stats.xp = 0;

  return stats;
}
