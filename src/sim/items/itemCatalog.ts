/**
 * Catalog of equippable items — weapons, armor, and shoes.
 *
 * Expands upon `weaponDefs.ts` by adding definitions for armor and shoe
 * equipment slots, along with a unified item lookup for inventory UI and
 * party equipment logic.
 */

import {
  getWeaponDef,
  resolveWeaponGrip,
  type WeaponDef,
} from '../weapons/weaponDefs';

export interface BaseItemDef {
  name: string;
  description?: string;
  defenseMultiplier?: number;
  healthMultiplier?: number;
  attackMultiplier?: number;
  speedMultiplier?: number;
  color?: string;
}

export interface ArmorDef extends BaseItemDef {
  kind: 'armor';
}

export interface ShoeDef extends BaseItemDef {
  kind: 'shoes';
}

export type ItemDef = (WeaponDef & BaseItemDef) | ArmorDef | ShoeDef;

export const ARMOR_DEFS: Readonly<Record<string, ArmorDef>> = {
  leatherArmor: {
    name: 'Leather Tunic',
    kind: 'armor',
    description: 'Supple leather offering light protection and ease of movement.',
    defenseMultiplier: 1.10,
    healthMultiplier: 1.05,
    color: '#8b5a2b',
  },
  ironArmor: {
    name: 'Iron Plate',
    kind: 'armor',
    description: 'Forged iron cuirass offering sturdy defense against physical blows.',
    defenseMultiplier: 1.25,
    healthMultiplier: 1.15,
    color: '#b0b8c0',
  },
  shadowCloak: {
    name: 'Shadow Cloak',
    kind: 'armor',
    description: 'Dark woven cloak that shrouds the wearer in umbral silence.',
    defenseMultiplier: 1.15,
    speedMultiplier: 1.10,
    color: '#4a3560',
  },
  crimsonRobe: {
    name: 'Crimson Robe',
    kind: 'armor',
    description: 'Blood-dyed robe infused with latent arcane warmth.',
    defenseMultiplier: 1.15,
    attackMultiplier: 1.10,
    color: '#9c2424',
  },
  aegisPlate: {
    name: 'Aegis Plate',
    kind: 'armor',
    description: 'Blessed golden plate armor forged for heroic wardens.',
    defenseMultiplier: 1.35,
    healthMultiplier: 1.25,
    color: '#ffd700',
  },
  weaveTunic: {
    name: 'Stormweave Tunic',
    kind: 'armor',
    description: 'Garment woven with storm motes that hum with protective energy.',
    defenseMultiplier: 1.20,
    healthMultiplier: 1.20,
    color: '#4090ff',
  },
};

export const ARMOR_IDS = Object.keys(ARMOR_DEFS);

export const SHOE_DEFS: Readonly<Record<string, ShoeDef>> = {
  leatherBoots: {
    name: 'Leather Boots',
    kind: 'shoes',
    description: 'Standard field boots made of durable hide.',
    defenseMultiplier: 1.05,
    speedMultiplier: 1.08,
    color: '#8b5a2b',
  },
  swiftStriders: {
    name: 'Swift Striders',
    kind: 'shoes',
    description: 'Lightweight running shoes that enhance ground speed.',
    defenseMultiplier: 1.05,
    speedMultiplier: 1.25,
    color: '#38bdf8',
  },
  ironSabatons: {
    name: 'Iron Sabatons',
    kind: 'shoes',
    description: 'Heavy metal boots built for stability and protection.',
    defenseMultiplier: 1.15,
    healthMultiplier: 1.10,
    color: '#b0b8c0',
  },
  shadowTreads: {
    name: 'Shadow Treads',
    kind: 'shoes',
    description: 'Silken soles that step without sound across any stone.',
    defenseMultiplier: 1.08,
    speedMultiplier: 1.15,
    color: '#4a3560',
  },
  wingedBoots: {
    name: 'Winged Boots',
    kind: 'shoes',
    description: 'Feathered boots granting spring to every step.',
    defenseMultiplier: 1.05,
    speedMultiplier: 1.20,
    color: '#facc15',
  },
  magmaGreaves: {
    name: 'Magma Greaves',
    kind: 'shoes',
    description: 'Heat-tempered greaves forged in subterranean vents.',
    defenseMultiplier: 1.20,
    speedMultiplier: 1.05,
    color: '#ea580c',
  },
};

export const SHOE_IDS = Object.keys(SHOE_DEFS);

/** Look up an armor definition by ID. */
export function getArmorDef(id: string): ArmorDef | null {
  return ARMOR_DEFS[id] ?? null;
}

/** Look up a shoe definition by ID. */
export function getShoeDef(id: string): ShoeDef | null {
  return SHOE_DEFS[id] ?? null;
}

/**
 * Unified item lookup: looks for weapons first, then armor, then shoes.
 */
export function getItemDef(id: string): ItemDef | null {
  if (id === '') return null;
  const weapon = getWeaponDef(id);
  if (weapon !== null) return weapon as ItemDef;
  const armor = getArmorDef(id);
  if (armor !== null) return armor;
  const shoe = getShoeDef(id);
  if (shoe !== null) return shoe;
  return null;
}

/** True when the id corresponds to any valid weapon. */
export function isWeaponItem(id: string): boolean {
  return getWeaponDef(id) !== null;
}

/** True when the id corresponds to any valid armor item. */
export function isArmorItem(id: string): boolean {
  return getArmorDef(id) !== null;
}

/** True when the id corresponds to any valid shoe item. */
export function isShoeItem(id: string): boolean {
  return getShoeDef(id) !== null;
}

/**
 * True when the item is a two-handed weapon (occupies both hands).
 */
export function isTwoHandedItem(id: string): boolean {
  const def = getWeaponDef(id);
  return def !== null && resolveWeaponGrip(def) === 'twoHand';
}

/**
 * True when the item is a one-handed weapon, shield, or consumable.
 */
export function isOneHandedItem(id: string): boolean {
  const def = getWeaponDef(id);
  return def !== null && resolveWeaponGrip(def) !== 'twoHand';
}

/** Item category for filtering in the inventory screen. */
export function getItemCategory(id: string): 'weapon' | 'armor' | 'shoes' | 'other' {
  if (isWeaponItem(id)) return 'weapon';
  if (isArmorItem(id)) return 'armor';
  if (isShoeItem(id)) return 'shoes';
  return 'other';
}
