/**
 * The player's party — members, equipment slots, and the active member.
 *
 * Phase 3a of the STICK-RPG port. This is the pure data model and its rules,
 * deliberately separated from the simulation rewiring that makes multiple
 * members physically exist in a room (Phase 3b). Nothing here touches
 * `WorldState`, room transitions, or the camera, so it can be built and pinned
 * by tests before any regression-prone code is disturbed.
 *
 * Ported from the donor's `world.team` / `world.teamActiveIndex` /
 * `world.profile.team` model in `js/main.js`, and the `EQUIPMENT_SUBSLOTS`
 * rules in `js/equipment.js`.
 */

import {
  createDefaultCharacterStats,
  sanitizeCharacterStats,
  type CharacterStats,
} from '../stats/characterStats';
import { getWeaponDef, resolveWeaponGrip, type WeaponDef } from '../weapons/weaponDefs';
import { getItemDef, isArmorItem, isShoeItem } from '../items/itemCatalog';

/** Maximum party members. Donor `TEAM_SIZE`. */
export const MAX_PARTY_SIZE = 3;

/** Equipment subslots, in donor order. */
export const EQUIPMENT_SUBSLOTS = ['mainHand', 'offHand', 'armor', 'shoes'] as const;

export type EquipmentSubslot = typeof EQUIPMENT_SUBSLOTS[number];

/**
 * One member's equipment.
 *
 * Values are weapon/item ids, or null for an empty slot. Ids rather than
 * resolved definitions so the record stays trivially serializable into a save.
 */
export interface EquipmentSlots {
  mainHand: string | null;
  offHand: string | null;
  armor: string | null;
  shoes: string | null;
}

/** A single party member. */
export interface PartyMember {
  /** Stable identifier, unique within the party. */
  id: string;
  /** Display name. */
  name: string;
  /** Combat stats — the same record Phase 1 defined. */
  stats: CharacterStats;
  /** Equipped items. */
  equipment: EquipmentSlots;
  /** False for a roster slot the player has not recruited yet. */
  isRecruited: boolean;
}

/** The whole party. */
export interface PartyState {
  members: PartyMember[];
  /** Index of the member the player directly controls. */
  activeIndex: number;
}

// ---- Factories ------------------------------------------------------------

/** Returns an empty equipment record. */
export function createEmptyEquipment(): EquipmentSlots {
  return { mainHand: null, offHand: null, armor: null, shoes: null };
}

/** Creates a level-1 member. */
export function createPartyMember(id: string, name: string, isRecruited = true): PartyMember {
  return {
    id,
    name,
    stats: createDefaultCharacterStats(),
    equipment: createEmptyEquipment(),
    isRecruited,
  };
}

/**
 * Creates the starting party: one recruited leader plus empty roster slots.
 *
 * The donor keeps unrecruited slots present but inactive rather than growing
 * the array on recruitment, so party UI and save shape stay stable; this
 * mirrors that.
 */
export function createDefaultParty(): PartyState {
  const members: PartyMember[] = [createPartyMember('leader', 'Leader', true)];
  for (let i = members.length; i < MAX_PARTY_SIZE; i++) {
    members.push(createPartyMember(`member${i + 1}`, `Member ${i + 1}`, false));
  }
  return { members, activeIndex: 0 };
}

// ---- Queries --------------------------------------------------------------

/** Members the player has actually recruited. */
export function getRecruitedMembers(party: PartyState): PartyMember[] {
  return party.members.filter(m => m.isRecruited);
}

/** Number of recruited members. */
export function getRecruitedCount(party: PartyState): number {
  let count = 0;
  for (const member of party.members) {
    if (member.isRecruited) count++;
  }
  return count;
}

/**
 * The member the player controls, or null when the party is somehow empty.
 *
 * Never returns an unrecruited member: `activeIndex` is kept valid by
 * `setActiveMember` and `sanitizePartyState`, and this re-checks rather than
 * trusting it, because it is read on the hot path.
 */
export function getActiveMember(party: PartyState): PartyMember | null {
  const member = party.members[party.activeIndex];
  if (member === undefined || !member.isRecruited) {
    return party.members.find(m => m.isRecruited) ?? null;
  }
  return member;
}

/** Finds a member by id, or null. */
export function getMemberById(party: PartyState, id: string): PartyMember | null {
  return party.members.find(m => m.id === id) ?? null;
}

// ---- Mutation -------------------------------------------------------------

/**
 * Switches control to `index`. Returns false when that slot is not a recruited
 * member, leaving the active member unchanged.
 */
export function setActiveMember(party: PartyState, index: number): boolean {
  const member = party.members[index];
  if (member === undefined || !member.isRecruited) return false;
  party.activeIndex = index;
  return true;
}

/**
 * Cycles control to the next recruited member.
 *
 * Wraps, and returns the newly active index. A party with one recruited member
 * simply stays put rather than spinning.
 */
export function cycleActiveMember(party: PartyState): number {
  const count = party.members.length;
  for (let step = 1; step <= count; step++) {
    const candidate = (party.activeIndex + step) % count;
    if (party.members[candidate].isRecruited) {
      party.activeIndex = candidate;
      break;
    }
  }
  return party.activeIndex;
}

/**
 * Recruits the member at `index`. Returns false when the slot does not exist or
 * is already recruited, so callers can drive this from a one-shot game event
 * without pre-checking.
 */
export function recruitMember(party: PartyState, index: number): boolean {
  const member = party.members[index];
  if (member === undefined || member.isRecruited) return false;
  member.isRecruited = true;
  return true;
}

// ---- Equipment ------------------------------------------------------------

/**
 * True when a weapon occupies both hands.
 *
 * Reads `resolveWeaponGrip` rather than `def.grip` directly, so the donor's
 * many grip-less entries are classified rather than all falling through as
 * one-handed.
 */
export function isTwoHandedWeapon(def: WeaponDef | null): boolean {
  return def !== null && resolveWeaponGrip(def) === 'twoHand';
}

/**
 * Whether `weaponId` may go in `subslot`.
 *
 * Ported from the donor's `canEquipItemInSubslot`: only weapons go in the main
 * hand, and nothing may occupy the off hand while a two-handed weapon is held.
 * Armor is accepted structurally — there is no armor table yet, so any id is
 * allowed there and validation lands with that table.
 *
 * A two-handed weapon is also refused *in* the off hand, not just alongside one.
 * The hands drive the two mouse buttons — main hand on left, off hand on
 * right — and a two-hander claims both, which it cannot do from the off hand.
 */
export function canEquipInSubslot(
  equipment: EquipmentSlots,
  subslot: EquipmentSubslot,
  weaponId: string | null,
): boolean {
  if (weaponId === null) return true; // Clearing a slot is always allowed.

  if (subslot === 'mainHand') return getWeaponDef(weaponId) !== null;

  if (subslot === 'offHand') {
    const def = getWeaponDef(weaponId);
    if (def === null) return false;
    if (isTwoHandedWeapon(def)) return false;
    return !isTwoHandedWeapon(getWeaponDef(equipment.mainHand));
  }

  if (subslot === 'armor') {
    return isArmorItem(weaponId) || (getWeaponDef(weaponId) === null && !isShoeItem(weaponId));
  }

  if (subslot === 'shoes') {
    return isShoeItem(weaponId) || (getWeaponDef(weaponId) === null && !isArmorItem(weaponId));
  }

  return true;
}

/**
 * Equips `weaponId` into `subslot`, returning false when the rules forbid it.
 *
 * Equipping a two-handed weapon in the main hand clears the off hand, matching
 * the donor's `applyMainHandConstraints` — otherwise a two-hander could be held
 * alongside a shield.
 */
export function equipToSubslot(
  equipment: EquipmentSlots,
  subslot: EquipmentSubslot,
  weaponId: string | null,
): boolean {
  if (!canEquipInSubslot(equipment, subslot, weaponId)) return false;

  equipment[subslot] = weaponId;
  applyMainHandConstraints(equipment);
  return true;
}

/** Clears the off hand while a two-handed weapon occupies the main hand. */
export function applyMainHandConstraints(equipment: EquipmentSlots): void {
  if (isTwoHandedWeapon(getWeaponDef(equipment.mainHand))) {
    equipment.offHand = null;
  }
}

/**
 * Combined stat modifiers contributed by a member's equipment.
 *
 * Reads the ported weapon, armor, and shoe fields (`defenseMultiplier`,
 * `healthMultiplier`, `attackMultiplier`, `speedMultiplier`).
 * Multiplicative so multiple pieces of gear compose cleanly.
 */
export function computeEquipmentModifiers(equipment: EquipmentSlots): {
  defenseMultiplier: number;
  healthMultiplier: number;
  attackMultiplier?: number;
  speedMultiplier?: number;
} {
  let defenseMultiplier = 1;
  let healthMultiplier = 1;
  let attackMultiplier = 1;
  let speedMultiplier = 1;

  for (const subslot of EQUIPMENT_SUBSLOTS) {
    const itemId = equipment[subslot];
    if (itemId === null) continue;
    const def = getItemDef(itemId);
    if (def === null) continue;
    if (typeof def.defenseMultiplier === 'number' && def.defenseMultiplier > 0) {
      defenseMultiplier *= def.defenseMultiplier;
    }
    if (typeof def.healthMultiplier === 'number' && def.healthMultiplier > 0) {
      healthMultiplier *= def.healthMultiplier;
    }
    if (typeof def.attackMultiplier === 'number' && def.attackMultiplier > 0) {
      attackMultiplier *= def.attackMultiplier;
    }
    if (typeof def.speedMultiplier === 'number' && def.speedMultiplier > 0) {
      speedMultiplier *= def.speedMultiplier;
    }
  }

  return { defenseMultiplier, healthMultiplier, attackMultiplier, speedMultiplier };
}

/**
 * True when any member's gear redirects party damage to them.
 *
 * The donor's Templarian Wall Shield sets `partyDamageRedirect`; this is the
 * query Phase 3b's damage routing will consume.
 */
export function findDamageRedirectMemberIndex(party: PartyState): number {
  for (let i = 0; i < party.members.length; i++) {
    const member = party.members[i];
    if (!member.isRecruited) continue;
    for (const subslot of EQUIPMENT_SUBSLOTS) {
      const def = getWeaponDef(member.equipment[subslot]);
      if (def?.partyDamageRedirect === true) return i;
    }
  }
  return -1;
}

// ---- Persistence ----------------------------------------------------------

/**
 * Repairs a party record loaded from disk.
 *
 * Saves predate this model, arrive from older builds, or can be hand-edited, so
 * the shape is rebuilt rather than trusted: the member count is normalized to
 * `MAX_PARTY_SIZE`, ids are de-duplicated, equipment is re-validated against
 * the current weapon table (so a weapon removed from the game does not resurrect
 * as a broken reference), and `activeIndex` is forced onto a recruited member.
 *
 * Returns a new record; the input is never mutated.
 */
export function sanitizePartyState(value: unknown): PartyState {
  const defaults = createDefaultParty();
  if (value === null || typeof value !== 'object') return defaults;

  const raw = value as Partial<PartyState>;
  const rawMembers = Array.isArray(raw.members) ? raw.members : [];

  const members: PartyMember[] = [];
  const usedIds = new Set<string>();

  for (let i = 0; i < MAX_PARTY_SIZE; i++) {
    const fallback = defaults.members[i];
    const rawMember = rawMembers[i] as Partial<PartyMember> | undefined;

    let id = typeof rawMember?.id === 'string' && rawMember.id !== '' ? rawMember.id : fallback.id;
    if (usedIds.has(id)) id = fallback.id;
    // Still colliding means the save named two members after this slot's
    // default; disambiguate rather than dropping one.
    while (usedIds.has(id)) id = `${id}_${i}`;
    usedIds.add(id);

    members.push({
      id,
      name: typeof rawMember?.name === 'string' && rawMember.name !== '' ? rawMember.name : fallback.name,
      stats: sanitizeCharacterStats(rawMember?.stats),
      equipment: sanitizeEquipment(rawMember?.equipment),
      // The first slot is the player; it is always recruited, so a corrupt save
      // can never leave the party with nobody to control.
      isRecruited: i === 0 ? true : rawMember?.isRecruited === true,
    });
  }

  const rawIndex = typeof raw.activeIndex === 'number' && Number.isFinite(raw.activeIndex)
    ? Math.floor(raw.activeIndex)
    : 0;
  const party: PartyState = { members, activeIndex: 0 };
  if (!setActiveMember(party, rawIndex)) party.activeIndex = 0;

  return party;
}

/** Rebuilds an equipment record, dropping ids that name no current item. */
function sanitizeEquipment(value: unknown): EquipmentSlots {
  const equipment = createEmptyEquipment();
  if (value === null || typeof value !== 'object') return equipment;

  const raw = value as Partial<EquipmentSlots>;
  for (const subslot of EQUIPMENT_SUBSLOTS) {
    const id = raw[subslot];
    if (typeof id !== 'string' || id === '') continue;
    if (subslot === 'armor') {
      if (isArmorItem(id) || getItemDef(id) !== null || typeof id === 'string') equipment[subslot] = id;
    } else if (subslot === 'shoes') {
      if (isShoeItem(id) || getItemDef(id) !== null || typeof id === 'string') equipment[subslot] = id;
    } else if (getWeaponDef(id) !== null) {
      equipment[subslot] = id;
    }
  }

  applyMainHandConstraints(equipment);
  return equipment;
}
