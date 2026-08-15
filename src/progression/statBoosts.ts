/**
 * Permanent player stat boosts — the pool that boost pickup items feed.
 *
 * Six tracks (dust, ammo, mana, health, attack, defense) each accumulate two
 * independent totals:
 *
 *   - **flat**    — additive, applied before the percentage (a `+1 Dust` item)
 *   - **percent** — multiplicative, stored in whole percentage points so a
 *                   `+5% Dust` item contributes `5`, not `0.05`
 *
 * Resolution is always `floor((base + level + flat) × (1 + percent/100))`, so
 * two flat items and two percent items compose the same way no matter which
 * order they were collected in. Rounding happens once, at the end — never per
 * item — so `+5% ×3` does not lose a point to three separate floors.
 *
 * The `level` term is the portion a character earns from levelling. Health is
 * the only track wired to a real level curve today; the rest report 0 until
 * the level-up allocation system lands. See
 * `computeLevelStatBonus` for where that plugs in.
 *
 * Pure and Node-safe: no DOM, no clock, no `Math.random()`.
 */

import {
  BASE_ATTACK,
  BASE_DEFENSE,
  BASE_MAX_HEALTH,
  MAX_HEALTH_PER_LEVEL,
  type CharacterStats,
} from '../sim/stats/characterStats';

// ---- Tracks ---------------------------------------------------------------

/** The six stat tracks a permanent boost item can raise. */
export type PlayerStatTrack = 'dust' | 'ammo' | 'mana' | 'health' | 'attack' | 'defense';

/** Every track, in the order the inventory stat table displays them. */
export const ALL_PLAYER_STAT_TRACKS: readonly PlayerStatTrack[] = [
  'health',
  'attack',
  'defense',
  'dust',
  'ammo',
  'mana',
];

/** Human-readable label per track, for UI. */
export const PLAYER_STAT_TRACK_LABELS: Readonly<Record<PlayerStatTrack, string>> = {
  health: 'Health',
  attack: 'Attack',
  defense: 'Defense',
  dust: 'Dust',
  ammo: 'Ammo',
  mana: 'Mana',
};

/** Accent color per track, matching the status-bar chips. */
export const PLAYER_STAT_TRACK_COLORS: Readonly<Record<PlayerStatTrack, string>> = {
  health: '#ff6b6b',
  attack: '#ffa94d',
  defense: '#74c0fc',
  dust: '#ffd700',
  ammo: '#c0c8d0',
  mana: '#b197fc',
};

/** True when `value` names one of the six tracks. */
export function isPlayerStatTrack(value: unknown): value is PlayerStatTrack {
  return typeof value === 'string'
    && (ALL_PLAYER_STAT_TRACKS as readonly string[]).includes(value);
}

// ---- State ----------------------------------------------------------------

/** One number per track. */
export type StatTrackTotals = Record<PlayerStatTrack, number>;

/**
 * Everything permanent boost items have granted so far.
 *
 * Persisted on `PlayerProgress`. Boost pickups are consumed on contact, so
 * this record — not an inventory stack — is the authoritative record that a
 * boost was collected.
 */
export interface PlayerStatBoosts {
  /** Additive bonus per track. */
  flat: StatTrackTotals;
  /** Percentage bonus per track, in whole percentage points. */
  percent: StatTrackTotals;
}

/** Baseline value each track starts at before levels, items, or equipment. */
export const BASE_STAT_VALUES: Readonly<StatTrackTotals> = {
  health: BASE_MAX_HEALTH,
  attack: BASE_ATTACK,
  defense: BASE_DEFENSE,
  // No dust/ammo/mana pool exists yet; these are the placeholder baselines the
  // stat table reads so the boost math is visible and testable before the
  // underlying resources are built.
  dust: 4,
  ammo: 10,
  mana: 10,
};

// ---- Factories ------------------------------------------------------------

/** A zeroed number-per-track record. */
export function createEmptyStatTrackTotals(): StatTrackTotals {
  return { health: 0, attack: 0, defense: 0, dust: 0, ammo: 0, mana: 0 };
}

/** A boost record granting nothing. */
export function createEmptyStatBoosts(): PlayerStatBoosts {
  return { flat: createEmptyStatTrackTotals(), percent: createEmptyStatTrackTotals() };
}

// ---- Mutation -------------------------------------------------------------

/** Adds `amount` to the additive bonus for `track`. */
export function addFlatStatBoost(
  boosts: PlayerStatBoosts,
  track: PlayerStatTrack,
  amount: number,
): void {
  if (!Number.isFinite(amount)) return;
  boosts.flat[track] += amount;
}

/** Adds `percentPoints` (5 means +5%) to the percentage bonus for `track`. */
export function addPercentStatBoost(
  boosts: PlayerStatBoosts,
  track: PlayerStatTrack,
  percentPoints: number,
): void {
  if (!Number.isFinite(percentPoints)) return;
  boosts.percent[track] += percentPoints;
}

// ---- Resolution -----------------------------------------------------------

/** A single track broken into the columns the inventory stat table shows. */
export interface ResolvedStatTrack {
  track: PlayerStatTrack;
  /** Baseline before anything is applied. */
  base: number;
  /** Portion earned from character levels. */
  level: number;
  /** Additive item bonus. */
  flat: number;
  /** Percentage item bonus, in whole percentage points. */
  percent: number;
  /** `floor((base + level + flat) × (1 + percent/100))`. */
  total: number;
}

/**
 * Applies the boost formula to one track.
 *
 * Exported on its own so combat code and the UI cannot drift apart on rounding
 * — both call this, neither reimplements it.
 */
export function resolveStatTotal(
  base: number,
  level: number,
  flat: number,
  percentPoints: number,
): number {
  const additive = base + level + flat;
  const scaled = additive * (1 + percentPoints / 100);
  return Math.max(0, Math.floor(scaled));
}

/**
 * Returns the portion of `track` earned from character levels.
 *
 * Health follows the real curve (`MAX_HEALTH_PER_LEVEL` per level past 1);
 * every other track returns 0 until level-up point allocation is designed.
 * Centralised here so that later work has one place to change.
 */
export function computeLevelStatBonus(
  track: PlayerStatTrack,
  stats: CharacterStats | undefined,
): number {
  if (track !== 'health') return 0;
  const level = Math.max(1, Math.floor(stats?.level ?? 1));
  return (level - 1) * MAX_HEALTH_PER_LEVEL;
}

/** Resolves one track into its display columns. */
export function resolveStatTrack(
  track: PlayerStatTrack,
  boosts: PlayerStatBoosts,
  stats?: CharacterStats,
): ResolvedStatTrack {
  const base = BASE_STAT_VALUES[track];
  const level = computeLevelStatBonus(track, stats);
  const flat = boosts.flat[track];
  const percent = boosts.percent[track];
  return { track, base, level, flat, percent, total: resolveStatTotal(base, level, flat, percent) };
}

/** Resolves every track, in display order. */
export function resolveAllStatTracks(
  boosts: PlayerStatBoosts,
  stats?: CharacterStats,
): ResolvedStatTrack[] {
  return ALL_PLAYER_STAT_TRACKS.map(track => resolveStatTrack(track, boosts, stats));
}

// ---- Persistence ----------------------------------------------------------

/** Coerces one persisted number, dropping anything non-finite or negative. */
function sanitizeAmount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * Rebuilds a boost record loaded from disk.
 *
 * Saves written before this system existed omit the field, and hand-edited
 * saves can carry junk, so the shape is reconstructed rather than trusted.
 * Returns a new record; the input is never mutated.
 */
export function sanitizeStatBoosts(value: unknown): PlayerStatBoosts {
  const boosts = createEmptyStatBoosts();
  if (value === null || typeof value !== 'object') return boosts;

  const raw = value as Partial<PlayerStatBoosts>;
  const rawFlat = (raw.flat ?? {}) as Partial<StatTrackTotals>;
  const rawPercent = (raw.percent ?? {}) as Partial<StatTrackTotals>;

  for (const track of ALL_PLAYER_STAT_TRACKS) {
    boosts.flat[track] = sanitizeAmount(rawFlat[track]);
    boosts.percent[track] = sanitizeAmount(rawPercent[track]);
  }

  return boosts;
}
