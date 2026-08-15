/**
 * Tests for the overhauled inventory equipment slots, hand division rules,
 * armor/shoes equipment, and item catalog helpers.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  EQUIPMENT_SUBSLOTS,
  canEquipInSubslot,
  computeEquipmentModifiers,
  createDefaultParty,
  createEmptyEquipment,
  equipToSubslot,
  sanitizePartyState,
} from '../sim/party/partyState';
import {
  addInventoryItem,
  createEmptyInventory,
  equipFromInventory,
  grantAllWeaponsForPlaytest,
  hasInventoryItem,
  unequipToInventory,
} from '../sim/party/inventory';
import {
  ARMOR_IDS,
  SHOE_IDS,
  getArmorDef,
  getItemCategory,
  getItemDef,
  getShoeDef,
  isArmorItem,
  isOneHandedItem,
  isShoeItem,
  isTwoHandedItem,
  isWeaponItem,
} from '../sim/items/itemCatalog';

describe('inventory slots & item catalog', () => {
  test('all four equipment subslots exist in order', () => {
    assert.deepEqual([...EQUIPMENT_SUBSLOTS], ['mainHand', 'offHand', 'armor', 'shoes']);
  });

  test('createEmptyEquipment initializes all four subslots to null', () => {
    const eq = createEmptyEquipment();
    assert.equal(eq.mainHand, null);
    assert.equal(eq.offHand, null);
    assert.equal(eq.armor, null);
    assert.equal(eq.shoes, null);
  });

  test('item categorization correctly identifies weapons, armor, and shoes', () => {
    assert.equal(getItemCategory('woodenSword'), 'weapon');
    assert.equal(getItemCategory('leatherArmor'), 'armor');
    assert.equal(getItemCategory('swiftStriders'), 'shoes');

    assert.equal(isWeaponItem('woodenSword'), true);
    assert.equal(isArmorItem('leatherArmor'), true);
    assert.equal(isShoeItem('swiftStriders'), true);

    assert.equal(getItemDef('woodenSword')?.name, 'Wooden Sword');
    assert.equal(getArmorDef('leatherArmor')?.name, 'Leather Tunic');
    assert.equal(getShoeDef('swiftStriders')?.name, 'Swift Striders');
  });

  test('two-handed vs one-handed classification', () => {
    assert.equal(isTwoHandedItem('greatsword'), true);
    assert.equal(isOneHandedItem('greatsword'), false);

    assert.equal(isTwoHandedItem('dagger'), false);
    assert.equal(isOneHandedItem('dagger'), true);
  });
});

describe('equipment slot constraints for armor and shoes', () => {
  test('armor can be equipped in the armor slot only', () => {
    const eq = createEmptyEquipment();
    assert.equal(canEquipInSubslot(eq, 'armor', 'leatherArmor'), true);
    assert.equal(canEquipInSubslot(eq, 'mainHand', 'leatherArmor'), false);
    assert.equal(canEquipInSubslot(eq, 'offHand', 'leatherArmor'), false);
    assert.equal(canEquipInSubslot(eq, 'shoes', 'leatherArmor'), false);
  });

  test('shoes can be equipped in the shoes slot only', () => {
    const eq = createEmptyEquipment();
    assert.equal(canEquipInSubslot(eq, 'shoes', 'swiftStriders'), true);
    assert.equal(canEquipInSubslot(eq, 'armor', 'swiftStriders'), false);
    assert.equal(canEquipInSubslot(eq, 'mainHand', 'swiftStriders'), false);
    assert.equal(canEquipInSubslot(eq, 'offHand', 'swiftStriders'), false);
  });

  test('weapons cannot be equipped in armor or shoes slots', () => {
    const eq = createEmptyEquipment();
    assert.equal(canEquipInSubslot(eq, 'armor', 'woodenSword'), false);
    assert.equal(canEquipInSubslot(eq, 'shoes', 'woodenSword'), false);
  });

  test('two-handed weapon claims both hand slots and clears off hand', () => {
    const eq = createEmptyEquipment();
    equipToSubslot(eq, 'offHand', 'dagger');
    assert.equal(eq.offHand, 'dagger');

    // Equipping 2H greatsword in mainHand clears offHand
    equipToSubslot(eq, 'mainHand', 'greatsword');
    assert.equal(eq.mainHand, 'greatsword');
    assert.equal(eq.offHand, null);

    // Cannot equip anything into offHand while 2H weapon is held
    assert.equal(canEquipInSubslot(eq, 'offHand', 'dagger'), false);
  });
});

describe('inventory equip and unequip transactions with armor and shoes', () => {
  test('equip and unequip armor and shoes from carried inventory', () => {
    const inventory = createEmptyInventory();
    const party = createDefaultParty();
    const leader = party.members[0];

    addInventoryItem(inventory, 'ironArmor', 1);
    addInventoryItem(inventory, 'wingedBoots', 1);

    assert.equal(hasInventoryItem(inventory, 'ironArmor'), true);
    assert.equal(hasInventoryItem(inventory, 'wingedBoots'), true);

    // Equip armor
    assert.equal(equipFromInventory(inventory, leader.equipment, 'armor', 'ironArmor'), true);
    assert.equal(leader.equipment.armor, 'ironArmor');
    assert.equal(hasInventoryItem(inventory, 'ironArmor'), false);

    // Equip shoes
    assert.equal(equipFromInventory(inventory, leader.equipment, 'shoes', 'wingedBoots'), true);
    assert.equal(leader.equipment.shoes, 'wingedBoots');
    assert.equal(hasInventoryItem(inventory, 'wingedBoots'), false);

    // Unequip back to inventory
    assert.equal(unequipToInventory(inventory, leader.equipment, 'armor'), 'ironArmor');
    assert.equal(leader.equipment.armor, null);
    assert.equal(hasInventoryItem(inventory, 'ironArmor'), true);

    assert.equal(unequipToInventory(inventory, leader.equipment, 'shoes'), 'wingedBoots');
    assert.equal(leader.equipment.shoes, null);
    assert.equal(hasInventoryItem(inventory, 'wingedBoots'), true);
  });

  test('playtest grant includes armor and shoes', () => {
    const inventory = createEmptyInventory();
    const party = createDefaultParty();
    grantAllWeaponsForPlaytest(inventory, party);

    for (const armorId of ARMOR_IDS) {
      assert.equal(hasInventoryItem(inventory, armorId), true);
    }
    for (const shoeId of SHOE_IDS) {
      assert.equal(hasInventoryItem(inventory, shoeId), true);
    }
  });
});

describe('equipment modifiers calculation', () => {
  test('composed modifiers from armor, shoes, and weapons', () => {
    const eq = createEmptyEquipment();
    eq.armor = 'ironArmor'; // defense: 1.25, health: 1.15
    eq.shoes = 'swiftStriders'; // defense: 1.05, speed: 1.25

    const mods = computeEquipmentModifiers(eq);
    assert.ok(Math.abs(mods.defenseMultiplier - 1.25 * 1.05) < 0.001);
    assert.ok(Math.abs(mods.healthMultiplier - 1.15) < 0.001);
    assert.ok(Math.abs((mods.speedMultiplier ?? 1) - 1.25) < 0.001);
  });
});

describe('save sanitization for 4-subslot equipment', () => {
  test('legacy 3-subslot save hydrates shoes as null safely', () => {
    const legacy = {
      members: [
        {
          id: 'leader',
          name: 'Leader',
          equipment: { mainHand: 'woodenSword', offHand: null, armor: 'leatherArmor' },
          isRecruited: true,
        },
      ],
      activeIndex: 0,
    };

    const sanitized = sanitizePartyState(legacy);
    assert.equal(sanitized.members[0].equipment.mainHand, 'woodenSword');
    assert.equal(sanitized.members[0].equipment.armor, 'leatherArmor');
    assert.equal(sanitized.members[0].equipment.shoes, null);
  });

  test('preserves valid shoes from disk', () => {
    const saveWithShoes = {
      members: [
        {
          id: 'leader',
          name: 'Leader',
          equipment: {
            mainHand: 'woodenSword',
            offHand: null,
            armor: 'ironArmor',
            shoes: 'leatherBoots',
          },
          isRecruited: true,
        },
      ],
      activeIndex: 0,
    };

    const sanitized = sanitizePartyState(saveWithShoes);
    assert.equal(sanitized.members[0].equipment.armor, 'ironArmor');
    assert.equal(sanitized.members[0].equipment.shoes, 'leatherBoots');
  });
});
