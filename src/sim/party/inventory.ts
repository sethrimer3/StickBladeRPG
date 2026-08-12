/**
 * The player's item inventory — what is owned but not currently worn.
 *
 * Part of the STICK-RPG port. `partyState.ts` already models the equipment
 * *slots*; this models the pool those slots draw from, and owns the one
 * invariant that keeps the two honest:
 *
 *   **An equipped item is not in the inventory.**
 *
 * Equipping moves a stack out of the pool and into a slot; unequipping moves it
 * back. Doing it any other way lets one Wooden Sword be worn by three members
 * at once, which the donor's shop/equip flow also forbids.
 *
 * Item ids are weapon ids today (`weaponDefs.ts` is the only item table that
 * exists). The armor subslot has no table yet, so armor ids round-trip as
 * opaque strings exactly as `sanitizePartyState` already treats them.
 */

import { getWeaponDef } from '../weapons/weaponDefs';
import {
  EQUIPMENT_SUBSLOTS,
  applyMainHandConstraints,
  canEquipInSubslot,
  isTwoHandedWeapon,
  type EquipmentSlots,
  type EquipmentSubslot,
  type PartyState,
} from './partyState';

/** Most copies of one item a single stack holds. */
export const MAX_STACK_COUNT = 99;

/** Most distinct stacks the inventory holds. */
export const MAX_INVENTORY_SLOTS = 60;

/**
 * The item the player starts with.
 *
 * Deliberately a literal rather than an import of
 * `playerWeaponState.DEFAULT_STARTER_WEAPON_ID`: that module pulls in
 * `WorldState`, and progression/save code must stay free of the simulation
 * graph. `src/tests/inventory.test.ts` pins the two to the same value.
 */
export const STARTER_ITEM_ID = 'woodenSword';

/** One kind of item and how many are held. */
export interface InventoryStack {
  id: string;
  count: number;
}

/** Everything the player owns but is not wearing, plus currency. */
export interface PlayerInventory {
  stacks: InventoryStack[];
  /** Coins. Enemies drop `ClusterState.coinValue` on death. */
  gold: number;
}

// ---- Factories ------------------------------------------------------------

/** An inventory holding nothing. */
export function createEmptyInventory(): PlayerInventory {
  return { stacks: [], gold: 0 };
}

/**
 * A new player's inventory.
 *
 * Empty: the starter weapon begins *equipped*, not carried, so the invariant
 * above holds from the first frame. `reconcileStarterEquipment` is what puts it
 * in the leader's hand.
 */
export function createDefaultInventory(): PlayerInventory {
  return createEmptyInventory();
}

// ---- Queries --------------------------------------------------------------

/** How many of `itemId` are carried. Zero when none are. */
export function getInventoryCount(inventory: PlayerInventory, itemId: string): number {
  let total = 0;
  for (const stack of inventory.stacks) {
    if (stack.id === itemId) total += stack.count;
  }
  return total;
}

/** True when at least one `itemId` is carried. */
export function hasInventoryItem(inventory: PlayerInventory, itemId: string): boolean {
  return getInventoryCount(inventory, itemId) > 0;
}

/** Display name for an item id, falling back to the raw id for untabled armor. */
export function getItemDisplayName(itemId: string): string {
  return getWeaponDef(itemId)?.name ?? itemId;
}

// ---- Mutation -------------------------------------------------------------

/**
 * Adds `count` copies of `itemId`, returning how many actually fit.
 *
 * Fills existing stacks before opening a new one, and refuses to grow past
 * `MAX_INVENTORY_SLOTS` so a pickup loop cannot balloon a save file. A short
 * return value means the inventory is full and the caller should keep (or drop)
 * the remainder rather than assume it landed.
 */
export function addInventoryItem(
  inventory: PlayerInventory,
  itemId: string,
  count = 1,
): number {
  if (itemId === '' || !Number.isFinite(count) || count <= 0) return 0;
  // Refused rather than accepted-then-silently-dropped: `sanitizeInventory`
  // discards ids that name no current item, so anything allowed in here must
  // also survive a save round-trip.
  if (getWeaponDef(itemId) === null) return 0;

  let remaining = Math.floor(count);
  let added = 0;

  for (const stack of inventory.stacks) {
    if (remaining <= 0) break;
    if (stack.id !== itemId || stack.count >= MAX_STACK_COUNT) continue;
    const room = MAX_STACK_COUNT - stack.count;
    const moved = Math.min(room, remaining);
    stack.count += moved;
    remaining -= moved;
    added += moved;
  }

  while (remaining > 0 && inventory.stacks.length < MAX_INVENTORY_SLOTS) {
    const moved = Math.min(MAX_STACK_COUNT, remaining);
    inventory.stacks.push({ id: itemId, count: moved });
    remaining -= moved;
    added += moved;
  }

  return added;
}

/**
 * Removes `count` copies of `itemId`. Returns false — changing nothing — when
 * that many are not carried, so callers can attempt a spend without a
 * pre-check.
 */
export function removeInventoryItem(
  inventory: PlayerInventory,
  itemId: string,
  count = 1,
): boolean {
  if (!Number.isFinite(count) || count <= 0) return false;
  const wanted = Math.floor(count);
  if (getInventoryCount(inventory, itemId) < wanted) return false;

  let remaining = wanted;
  for (let i = inventory.stacks.length - 1; i >= 0 && remaining > 0; i--) {
    const stack = inventory.stacks[i];
    if (stack.id !== itemId) continue;
    const taken = Math.min(stack.count, remaining);
    stack.count -= taken;
    remaining -= taken;
    if (stack.count <= 0) inventory.stacks.splice(i, 1);
  }
  return true;
}

/** Adds coins (or subtracts, with a negative amount), clamped at zero. */
export function addGold(inventory: PlayerInventory, amount: number): number {
  if (!Number.isFinite(amount)) return inventory.gold;
  inventory.gold = Math.max(0, Math.floor(inventory.gold + amount));
  return inventory.gold;
}

/** Spends `amount` coins, returning false and changing nothing if short. */
export function spendGold(inventory: PlayerInventory, amount: number): boolean {
  if (!Number.isFinite(amount) || amount < 0) return false;
  const cost = Math.floor(amount);
  if (inventory.gold < cost) return false;
  inventory.gold -= cost;
  return true;
}

// ---- Equip / unequip ------------------------------------------------------

/**
 * Moves `itemId` from the inventory into `subslot`, returning whatever it
 * displaced to the inventory.
 *
 * Returns false — touching nothing — when the item is not carried or the slot
 * rules refuse it. Note the two-handed case displaces *two* slots: equipping a
 * two-hander in the main hand clears the off hand
 * (`applyMainHandConstraints`), and both displaced items come back to the pool
 * here rather than evaporating.
 */
export function equipFromInventory(
  inventory: PlayerInventory,
  equipment: EquipmentSlots,
  subslot: EquipmentSubslot,
  itemId: string,
): boolean {
  if (!hasInventoryItem(inventory, itemId)) return false;
  if (!canEquipInSubslot(equipment, subslot, itemId)) return false;

  const displaced: string[] = [];
  const previous = equipment[subslot];
  if (previous !== null) displaced.push(previous);
  // A two-hander about to occupy the main hand evicts the off hand as well.
  if (subslot === 'mainHand'
    && isTwoHandedWeapon(getWeaponDef(itemId))
    && equipment.offHand !== null) {
    displaced.push(equipment.offHand);
  }

  // Snapshot first: if a displaced item cannot come back (a full inventory),
  // the whole move is rolled back rather than half-applied with an item lost.
  const snapshot = inventory.stacks.map(stack => ({ ...stack }));
  removeInventoryItem(inventory, itemId, 1);
  for (const id of displaced) {
    if (addInventoryItem(inventory, id, 1) < 1) {
      inventory.stacks = snapshot;
      return false;
    }
  }

  equipment[subslot] = itemId;
  applyMainHandConstraints(equipment);
  return true;
}

/**
 * Empties `subslot` back into the inventory. Returns the id removed, or null
 * when the slot was already empty.
 *
 * Refuses — leaving the item equipped — when the inventory will not take it
 * back (it is full, or the id names nothing the item table knows, which an
 * armor slot can still hold). Better worn than destroyed.
 */
export function unequipToInventory(
  inventory: PlayerInventory,
  equipment: EquipmentSlots,
  subslot: EquipmentSubslot,
): string | null {
  const itemId = equipment[subslot];
  if (itemId === null) return null;
  if (addInventoryItem(inventory, itemId, 1) < 1) return null;
  equipment[subslot] = null;
  return itemId;
}

/**
 * Gives a brand-new (or pre-inventory) save its starter weapon.
 *
 * Runs when the leader's main hand is empty and the starter weapon is nowhere
 * to be found — equipped by any member or carried. Without this the leader
 * would swing a weapon that `gameLoadRoomPhases` supplies implicitly but that
 * the inventory screen cannot see, which reads as a bug.
 *
 * Idempotent, so it is safe on every load.
 */
export function reconcileStarterEquipment(
  inventory: PlayerInventory,
  party: PartyState,
): void {
  const leader = party.members[0];
  if (leader === undefined || leader.equipment.mainHand !== null) return;
  if (hasInventoryItem(inventory, STARTER_ITEM_ID)) return;
  for (const member of party.members) {
    for (const subslot of EQUIPMENT_SUBSLOTS) {
      if (member.equipment[subslot] === STARTER_ITEM_ID) return;
    }
  }
  leader.equipment.mainHand = STARTER_ITEM_ID;
  applyMainHandConstraints(leader.equipment);
}

// ---- Persistence ----------------------------------------------------------

/**
 * Rebuilds an inventory record loaded from disk.
 *
 * Like `sanitizePartyState`, the shape is reconstructed rather than trusted:
 * counts are clamped, unknown ids are dropped (a weapon deleted from the game
 * must not resurrect as a broken reference), duplicate ids are merged, and the
 * slot cap is enforced. Returns a new record; the input is never mutated.
 */
export function sanitizeInventory(value: unknown): PlayerInventory {
  const inventory = createEmptyInventory();
  if (value === null || typeof value !== 'object') return inventory;

  const raw = value as Partial<PlayerInventory>;
  inventory.gold = Number.isFinite(raw.gold) ? Math.max(0, Math.floor(raw.gold as number)) : 0;

  if (!Array.isArray(raw.stacks)) return inventory;

  for (const entry of raw.stacks) {
    if (entry === null || typeof entry !== 'object') continue;
    const stack = entry as Partial<InventoryStack>;
    if (typeof stack.id !== 'string' || stack.id === '') continue;
    // Only real, player-usable items survive a load.
    if (getWeaponDef(stack.id) === null) continue;
    if (!Number.isFinite(stack.count)) continue;
    const count = Math.floor(stack.count as number);
    if (count <= 0) continue;
    // Routed through addInventoryItem so merging, stack caps, and the slot cap
    // all apply to loaded data exactly as they do to a pickup.
    addInventoryItem(inventory, stack.id, count);
  }

  return inventory;
}
