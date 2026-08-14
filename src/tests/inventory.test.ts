/**
 * Tests for the STICK-RPG inventory: the carried-item pool, the equip/unequip
 * moves that connect it to `partyState`'s equipment slots, and save round-trips.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  MAX_INVENTORY_SLOTS,
  MAX_STACK_COUNT,
  STARTER_ITEM_ID,
  addGold,
  addInventoryItem,
  createDefaultInventory,
  createEmptyInventory,
  equipFromInventory,
  getInventoryCount,
  getItemDisplayName,
  grantAllWeaponsForPlaytest,
  hasInventoryItem,
  reconcileStarterEquipment,
  removeInventoryItem,
  sanitizeInventory,
  spendGold,
  unequipToInventory,
} from '../sim/party/inventory';
import { createDefaultParty, createEmptyEquipment } from '../sim/party/partyState';
import { DEFAULT_STARTER_WEAPON_ID } from '../sim/weapons/playerWeaponState';
import {
  WEAPONS,
  WEAPON_IDS,
  getWeaponDef,
  isPlayerEquippableWeapon,
} from '../sim/weapons/weaponDefs';
import {
  createDefaultProgress,
  sanitizePlayerInventory,
  sanitizePlayerPartyState,
} from '../progression/playerProgress';

/** A one-handed weapon id, resolved from the real table so the test cannot drift. */
const ONE_HAND_ID = WEAPON_IDS.find(id => {
  const def = getWeaponDef(id);
  return def !== null && def.grip !== 'twoHand' && def.enemyOnly !== true;
}) as string;

/** A two-handed weapon id, likewise. */
const TWO_HAND_ID = WEAPON_IDS.find(id => {
  const def = getWeaponDef(id);
  return def !== null && def.grip === 'twoHand' && def.enemyOnly !== true;
}) as string;

describe('inventory — stacks', () => {
  test('the weapon table supplies both grips this suite needs', () => {
    assert.equal(typeof ONE_HAND_ID, 'string');
    assert.equal(typeof TWO_HAND_ID, 'string');
  });

  test('starts empty, because the starter weapon starts equipped', () => {
    const inventory = createDefaultInventory();
    assert.deepEqual(inventory.stacks, []);
    assert.equal(inventory.gold, 0);
  });

  test('merges repeated adds into one stack and reports the count', () => {
    const inventory = createEmptyInventory();
    assert.equal(addInventoryItem(inventory, ONE_HAND_ID, 2), 2);
    assert.equal(addInventoryItem(inventory, ONE_HAND_ID), 1);
    assert.equal(inventory.stacks.length, 1);
    assert.equal(getInventoryCount(inventory, ONE_HAND_ID), 3);
    assert.equal(hasInventoryItem(inventory, ONE_HAND_ID), true);
  });

  test('opens a second stack once the first hits the stack cap', () => {
    const inventory = createEmptyInventory();
    addInventoryItem(inventory, ONE_HAND_ID, MAX_STACK_COUNT + 5);
    assert.equal(inventory.stacks.length, 2);
    assert.equal(inventory.stacks[0].count, MAX_STACK_COUNT);
    assert.equal(inventory.stacks[1].count, 5);
  });

  test('refuses to grow past the slot cap and reports the short add', () => {
    const inventory = createEmptyInventory();
    for (let i = 0; i < MAX_INVENTORY_SLOTS; i++) {
      inventory.stacks.push({ id: ONE_HAND_ID, count: MAX_STACK_COUNT });
    }
    assert.equal(addInventoryItem(inventory, ONE_HAND_ID, 10), 0);
    assert.equal(inventory.stacks.length, MAX_INVENTORY_SLOTS);
  });

  test('ignores non-positive and non-finite counts', () => {
    const inventory = createEmptyInventory();
    assert.equal(addInventoryItem(inventory, ONE_HAND_ID, 0), 0);
    assert.equal(addInventoryItem(inventory, ONE_HAND_ID, -3), 0);
    assert.equal(addInventoryItem(inventory, ONE_HAND_ID, Number.NaN), 0);
    assert.deepEqual(inventory.stacks, []);
  });

  test('refuses ids the item table does not know', () => {
    const inventory = createEmptyInventory();
    // Accepting one would be a lie: sanitizeInventory drops it on the next load.
    assert.equal(addInventoryItem(inventory, 'weaponThatDoesNotExist'), 0);
    assert.deepEqual(inventory.stacks, []);
  });

  test('removes across stacks and drops emptied ones', () => {
    const inventory = createEmptyInventory();
    addInventoryItem(inventory, ONE_HAND_ID, MAX_STACK_COUNT + 2);
    assert.equal(removeInventoryItem(inventory, ONE_HAND_ID, 3), true);
    assert.equal(getInventoryCount(inventory, ONE_HAND_ID), MAX_STACK_COUNT - 1);
    assert.equal(inventory.stacks.length, 1);
  });

  test('refuses a removal it cannot satisfy, changing nothing', () => {
    const inventory = createEmptyInventory();
    addInventoryItem(inventory, ONE_HAND_ID, 2);
    assert.equal(removeInventoryItem(inventory, ONE_HAND_ID, 3), false);
    assert.equal(getInventoryCount(inventory, ONE_HAND_ID), 2);
  });
});

describe('inventory — gold', () => {
  test('adds, clamps at zero, and spends', () => {
    const inventory = createEmptyInventory();
    assert.equal(addGold(inventory, 25), 25);
    assert.equal(addGold(inventory, -100), 0);
    addGold(inventory, 30);
    assert.equal(spendGold(inventory, 10), true);
    assert.equal(inventory.gold, 20);
    assert.equal(spendGold(inventory, 21), false);
    assert.equal(inventory.gold, 20);
  });
});

describe('inventory — equip moves', () => {
  test('moves an item out of the pool and into the slot', () => {
    const inventory = createEmptyInventory();
    const equipment = createEmptyEquipment();
    addInventoryItem(inventory, ONE_HAND_ID);

    assert.equal(equipFromInventory(inventory, equipment, 'mainHand', ONE_HAND_ID), true);
    assert.equal(equipment.mainHand, ONE_HAND_ID);
    assert.equal(hasInventoryItem(inventory, ONE_HAND_ID), false);
  });

  test('refuses to equip an item that is not carried', () => {
    const inventory = createEmptyInventory();
    const equipment = createEmptyEquipment();
    assert.equal(equipFromInventory(inventory, equipment, 'mainHand', ONE_HAND_ID), false);
    assert.equal(equipment.mainHand, null);
  });

  test('returns the displaced item to the pool', () => {
    const inventory = createEmptyInventory();
    const equipment = createEmptyEquipment();
    addInventoryItem(inventory, ONE_HAND_ID, 2);

    equipFromInventory(inventory, equipment, 'mainHand', ONE_HAND_ID);
    equipFromInventory(inventory, equipment, 'mainHand', ONE_HAND_ID);
    // One went in, one came back out — net one carried, one worn.
    assert.equal(getInventoryCount(inventory, ONE_HAND_ID), 1);
  });

  test('returns BOTH hands to the pool when a two-hander takes over', () => {
    const inventory = createEmptyInventory();
    const equipment = createEmptyEquipment();
    addInventoryItem(inventory, ONE_HAND_ID, 2);
    addInventoryItem(inventory, TWO_HAND_ID);

    equipFromInventory(inventory, equipment, 'mainHand', ONE_HAND_ID);
    equipFromInventory(inventory, equipment, 'offHand', ONE_HAND_ID);
    assert.equal(getInventoryCount(inventory, ONE_HAND_ID), 0);

    assert.equal(equipFromInventory(inventory, equipment, 'mainHand', TWO_HAND_ID), true);
    assert.equal(equipment.mainHand, TWO_HAND_ID);
    assert.equal(equipment.offHand, null);
    // Neither one-hander evaporated.
    assert.equal(getInventoryCount(inventory, ONE_HAND_ID), 2);
  });

  test('refuses an off-hand equip while a two-hander is held', () => {
    const inventory = createEmptyInventory();
    const equipment = createEmptyEquipment();
    addInventoryItem(inventory, ONE_HAND_ID);
    addInventoryItem(inventory, TWO_HAND_ID);

    equipFromInventory(inventory, equipment, 'mainHand', TWO_HAND_ID);
    assert.equal(equipFromInventory(inventory, equipment, 'offHand', ONE_HAND_ID), false);
    assert.equal(getInventoryCount(inventory, ONE_HAND_ID), 1);
  });

  test('unequips back into the pool, and reports null for an empty slot', () => {
    const inventory = createEmptyInventory();
    const equipment = createEmptyEquipment();
    addInventoryItem(inventory, ONE_HAND_ID);
    equipFromInventory(inventory, equipment, 'mainHand', ONE_HAND_ID);

    assert.equal(unequipToInventory(inventory, equipment, 'mainHand'), ONE_HAND_ID);
    assert.equal(equipment.mainHand, null);
    assert.equal(getInventoryCount(inventory, ONE_HAND_ID), 1);
    assert.equal(unequipToInventory(inventory, equipment, 'mainHand'), null);
  });

  test('keeps an item equipped rather than destroying it when the pool is full', () => {
    const inventory = createEmptyInventory();
    const equipment = createEmptyEquipment();
    addInventoryItem(inventory, ONE_HAND_ID);
    equipFromInventory(inventory, equipment, 'mainHand', ONE_HAND_ID);
    for (let i = 0; i < MAX_INVENTORY_SLOTS; i++) {
      inventory.stacks.push({ id: TWO_HAND_ID, count: MAX_STACK_COUNT });
    }

    assert.equal(unequipToInventory(inventory, equipment, 'mainHand'), null);
    assert.equal(equipment.mainHand, ONE_HAND_ID);
  });

  test('rolls the whole move back when a displaced item cannot return', () => {
    const inventory = createEmptyInventory();
    const equipment = createEmptyEquipment();
    // One free stack holding two two-handers: equipping one displaces the held
    // one-hander, which then has nowhere to go.
    addInventoryItem(inventory, TWO_HAND_ID, 2);
    for (let i = 0; i < MAX_INVENTORY_SLOTS - 1; i++) {
      inventory.stacks.push({ id: TWO_HAND_ID, count: MAX_STACK_COUNT });
    }
    equipment.mainHand = ONE_HAND_ID;

    assert.equal(equipFromInventory(inventory, equipment, 'mainHand', TWO_HAND_ID), false);
    assert.equal(equipment.mainHand, ONE_HAND_ID);
    assert.equal(getInventoryCount(inventory, TWO_HAND_ID), 2 + (MAX_INVENTORY_SLOTS - 1) * MAX_STACK_COUNT);
  });

  test('conserves items across an arbitrary equip/unequip sequence', () => {
    const inventory = createEmptyInventory();
    const equipment = createEmptyEquipment();
    addInventoryItem(inventory, ONE_HAND_ID, 3);
    addInventoryItem(inventory, TWO_HAND_ID, 1);

    const total = (): number =>
      getInventoryCount(inventory, ONE_HAND_ID)
      + getInventoryCount(inventory, TWO_HAND_ID)
      + [equipment.mainHand, equipment.offHand, equipment.armor]
        .filter(id => id !== null).length;

    assert.equal(total(), 4);
    equipFromInventory(inventory, equipment, 'mainHand', ONE_HAND_ID);
    equipFromInventory(inventory, equipment, 'offHand', ONE_HAND_ID);
    equipFromInventory(inventory, equipment, 'mainHand', TWO_HAND_ID);
    unequipToInventory(inventory, equipment, 'mainHand');
    equipFromInventory(inventory, equipment, 'mainHand', ONE_HAND_ID);
    assert.equal(total(), 4);
  });
});

describe('inventory — starter reconciliation', () => {
  test('names the same weapon the weapon runtime defaults to', () => {
    assert.equal(STARTER_ITEM_ID, DEFAULT_STARTER_WEAPON_ID);
  });

  test('arms an empty-handed leader with the starter weapon', () => {
    const inventory = createEmptyInventory();
    const party = createDefaultParty();
    reconcileStarterEquipment(inventory, party);
    assert.equal(party.members[0].equipment.mainHand, STARTER_ITEM_ID);
  });

  test('is idempotent and never duplicates the starter weapon', () => {
    const inventory = createEmptyInventory();
    const party = createDefaultParty();
    reconcileStarterEquipment(inventory, party);
    unequipToInventory(inventory, party.members[0].equipment, 'mainHand');
    // Now it is carried rather than worn — reconciliation must not mint another.
    reconcileStarterEquipment(inventory, party);
    assert.equal(party.members[0].equipment.mainHand, null);
    assert.equal(getInventoryCount(inventory, STARTER_ITEM_ID), 1);
  });

  test('leaves an already-armed leader alone', () => {
    const inventory = createEmptyInventory();
    const party = createDefaultParty();
    addInventoryItem(inventory, TWO_HAND_ID);
    equipFromInventory(inventory, party.members[0].equipment, 'mainHand', TWO_HAND_ID);
    reconcileStarterEquipment(inventory, party);
    assert.equal(party.members[0].equipment.mainHand, TWO_HAND_ID);
  });
});

describe('inventory — playtest weapon grant', () => {
  test('hands out every player-equippable weapon and no enemy-only one', () => {
    const inventory = createEmptyInventory();
    const party = createDefaultParty();
    grantAllWeaponsForPlaytest(inventory, party);

    for (const id of WEAPON_IDS) {
      const expected = isPlayerEquippableWeapon(WEAPONS[id]) ? 1 : 0;
      assert.equal(getInventoryCount(inventory, id), expected, id);
    }
  });

  test('never duplicates a weapon that is carried or worn', () => {
    const inventory = createEmptyInventory();
    const party = createDefaultParty();
    grantAllWeaponsForPlaytest(inventory, party);
    // Wear one, then re-run as a fresh load would.
    assert.ok(equipFromInventory(inventory, party.members[0].equipment, 'mainHand', TWO_HAND_ID));
    grantAllWeaponsForPlaytest(inventory, party);

    assert.equal(getInventoryCount(inventory, TWO_HAND_ID), 0);
    assert.equal(getInventoryCount(inventory, ONE_HAND_ID), 1);
  });

  test('the grant fits inside the slot cap', () => {
    const inventory = createEmptyInventory();
    grantAllWeaponsForPlaytest(inventory, createDefaultParty());
    assert.ok(inventory.stacks.length <= MAX_INVENTORY_SLOTS);
  });
});

describe('inventory — persistence', () => {
  test('rebuilds a default from junk', () => {
    assert.deepEqual(sanitizeInventory(null), { stacks: [], gold: 0 });
    assert.deepEqual(sanitizeInventory('nope'), { stacks: [], gold: 0 });
    assert.deepEqual(sanitizeInventory({ stacks: 'nope', gold: -4 }), { stacks: [], gold: 0 });
  });

  test('drops ids that name no current item', () => {
    const loaded = sanitizeInventory({
      stacks: [{ id: 'weaponDeletedInAPatch', count: 4 }, { id: ONE_HAND_ID, count: 2 }],
      gold: 7,
    });
    assert.equal(loaded.stacks.length, 1);
    assert.equal(getInventoryCount(loaded, ONE_HAND_ID), 2);
    assert.equal(loaded.gold, 7);
  });

  test('clamps counts and merges duplicate ids on load', () => {
    const loaded = sanitizeInventory({
      stacks: [
        { id: ONE_HAND_ID, count: 1 },
        { id: ONE_HAND_ID, count: 2 },
        { id: ONE_HAND_ID, count: -5 },
        { id: ONE_HAND_ID, count: Number.POSITIVE_INFINITY },
      ],
      gold: 3.9,
    });
    assert.equal(getInventoryCount(loaded, ONE_HAND_ID), 3);
    assert.equal(loaded.stacks.length, 1);
    assert.equal(loaded.gold, 3);
  });

  test('round-trips through JSON', () => {
    const inventory = createEmptyInventory();
    addInventoryItem(inventory, ONE_HAND_ID, 5);
    addGold(inventory, 42);
    assert.deepEqual(sanitizeInventory(JSON.parse(JSON.stringify(inventory))), inventory);
  });

  test('backfills a pre-inventory save and arms its leader', () => {
    const progress = createDefaultProgress();
    delete progress.inventory;
    if (progress.party) progress.party.members[0].equipment.mainHand = null;

    sanitizePlayerPartyState(progress);
    sanitizePlayerInventory(progress);

    assert.notEqual(progress.inventory, undefined);
    assert.equal(progress.party?.members[0].equipment.mainHand, STARTER_ITEM_ID);
  });
});

describe('inventory — display', () => {
  test('names known weapons and passes untabled ids through', () => {
    assert.equal(getItemDisplayName(ONE_HAND_ID), getWeaponDef(ONE_HAND_ID)?.name);
    assert.equal(getItemDisplayName('someFutureArmor'), 'someFutureArmor');
  });
});
