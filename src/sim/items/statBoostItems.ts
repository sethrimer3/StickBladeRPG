/**
 * Permanent stat boost items — the pickup family that replaced the Dust
 * Container.
 *
 * Twelve items: one flat and one percentage variant for each of the six stat
 * tracks in `progression/statBoosts.ts`. They are *consumed on pickup* rather
 * than carried, so unlike weapons and armor they never live in an inventory
 * stack — collecting one folds its grant into `PlayerProgress.statBoosts` and
 * the world pickup disappears for good.
 *
 * The Dust Container's old `+4 mote capacity` grant is now expressed as the
 * `dustFlat` item, which is why an authored container with no explicit
 * `boostItemId` still reads as a dust upgrade (see `DEFAULT_BOOST_ITEM_ID`).
 *
 * This module is pure data plus lookups: no simulation or DOM imports, so the
 * editor, the UI, and the progression code can all read it.
 */

import type { PlayerStatTrack } from '../../progression/statBoosts';
import {
  ALL_PLAYER_STAT_TRACKS,
  PLAYER_STAT_TRACK_COLORS,
  PLAYER_STAT_TRACK_LABELS,
} from '../../progression/statBoosts';

/** Whether an item adds a flat amount or a percentage of the base. */
export type StatBoostMode = 'flat' | 'percent';

/** A permanent, consumed-on-pickup stat upgrade. */
export interface StatBoostItemDef {
  kind: 'statBoost';
  name: string;
  description: string;
  /** Which of the six stat tracks this raises. */
  track: PlayerStatTrack;
  /** Additive or multiplicative. */
  mode: StatBoostMode;
  /**
   * How much. For `flat` this is the raw amount added; for `percent` it is
   * whole percentage points (5 means +5%), matching `PlayerStatBoosts.percent`.
   */
  amount: number;
  color: string;
}

/** Flat items grant this much; percent items grant this many points. */
const FLAT_BOOST_AMOUNT = 1;
const PERCENT_BOOST_AMOUNT = 5;

/** Item id for a track's flat variant, e.g. `dustFlat`. */
export function getFlatBoostItemId(track: PlayerStatTrack): string {
  return `${track}Flat`;
}

/** Item id for a track's percentage variant, e.g. `dustPercent`. */
export function getPercentBoostItemId(track: PlayerStatTrack): string {
  return `${track}Percent`;
}

function buildBoostDefs(): Record<string, StatBoostItemDef> {
  const defs: Record<string, StatBoostItemDef> = {};
  for (const track of ALL_PLAYER_STAT_TRACKS) {
    const label = PLAYER_STAT_TRACK_LABELS[track];
    const color = PLAYER_STAT_TRACK_COLORS[track];

    defs[getFlatBoostItemId(track)] = {
      kind: 'statBoost',
      name: `${label} Shard`,
      description: `Permanently raises your base ${label.toLowerCase()} by ${FLAT_BOOST_AMOUNT}.`,
      track,
      mode: 'flat',
      amount: FLAT_BOOST_AMOUNT,
      color,
    };

    defs[getPercentBoostItemId(track)] = {
      kind: 'statBoost',
      name: `${label} Prism`,
      description: `Permanently raises your ${label.toLowerCase()} by ${PERCENT_BOOST_AMOUNT}%, rounded down.`,
      track,
      mode: 'percent',
      amount: PERCENT_BOOST_AMOUNT,
      color,
    };
  }
  return defs;
}

/** Every boost item, keyed by id. */
export const STAT_BOOST_ITEM_DEFS: Readonly<Record<string, StatBoostItemDef>> = buildBoostDefs();

/** Every boost item id, flat and percent variants interleaved per track. */
export const STAT_BOOST_ITEM_IDS: readonly string[] = Object.keys(STAT_BOOST_ITEM_DEFS);

/**
 * What an authored Dust Container grants when it names no boost item.
 *
 * Existing rooms and saved campaigns predate `boostItemId`, so they must keep
 * granting a dust upgrade rather than silently becoming inert.
 */
export const DEFAULT_BOOST_ITEM_ID: string = getFlatBoostItemId('dust');

/** Looks up a boost item, or null when the id names something else. */
export function getStatBoostItemDef(id: string): StatBoostItemDef | null {
  return STAT_BOOST_ITEM_DEFS[id] ?? null;
}

/** True when `id` names a permanent stat boost item. */
export function isStatBoostItem(id: string): boolean {
  return getStatBoostItemDef(id) !== null;
}

/**
 * Resolves an authored `boostItemId` to a real boost item.
 *
 * Falls back to `DEFAULT_BOOST_ITEM_ID` for an absent or unrecognised id, so a
 * room referencing an item that was later renamed still grants *something*
 * instead of failing silently on pickup.
 */
export function resolveBoostItemId(id: string | undefined | null): string {
  return id !== undefined && id !== null && isStatBoostItem(id) ? id : DEFAULT_BOOST_ITEM_ID;
}
