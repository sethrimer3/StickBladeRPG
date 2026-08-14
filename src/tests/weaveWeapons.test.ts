/**
 * The weave weapons: one sword and one bow per equippable dust type, and the
 * swords' Shield Weave secondary.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  STICKBLADE_WEAPON_DATA,
  WEAVE_WEAPON_IDS,
  WEAVE_WEAPON_DUSTS,
} from '../sim/weapons/stickbladeWeapons';
import {
  WEAPONS,
  getWeaponDef,
  isPlayerEquippableWeapon,
  isWeaponRuntimeImplemented,
} from '../sim/weapons/weaponDefs';
import { EQUIPPABLE_KINDS, ParticleKind } from '../sim/particles/kinds';
import { getDustDefinition } from '../sim/weaves/dustDefinition';
import { createInputState, collectCommands } from '../input/handler';
import { CommandKind } from '../input/commands';
import {
  createPlayerWeaponState,
  equipPlayerWeapon,
  getEquippedWeaponDef,
} from '../sim/weapons/playerWeaponState';

describe('weave weapon coverage', () => {
  test('every equippable dust type has exactly one sword and one bow', () => {
    assert.deepEqual([...WEAVE_WEAPON_DUSTS], [...EQUIPPABLE_KINDS]);
    assert.equal(WEAVE_WEAPON_IDS.length, EQUIPPABLE_KINDS.length * 2);

    for (const dust of EQUIPPABLE_KINDS) {
      const forDust = WEAVE_WEAPON_IDS
        .map(id => getWeaponDef(id))
        .filter(def => def?.weaveDust === dust);
      assert.equal(forDust.length, 2, `${getDustDefinition(dust).displayName} should have two weapons`);
      assert.deepEqual(
        forDust.map(def => def?.kind).sort(),
        ['bow', 'melee'],
        `${getDustDefinition(dust).displayName} should have one bow and one sword`,
      );
    }
  });

  test('every weave weapon is equippable and has a working runtime', () => {
    for (const id of WEAVE_WEAPON_IDS) {
      const def = getWeaponDef(id);
      assert.ok(def !== null, `${id} should resolve`);
      assert.ok(isPlayerEquippableWeapon(def), `${id} should not be enemy-only`);
      assert.ok(isWeaponRuntimeImplemented(def), `${id} should have a runtime`);
      assert.ok(equipPlayerWeapon(createPlayerWeaponState(), id), `${id} should equip`);
    }
  });

  test('each weapon\'s element matches the dust it is woven from', () => {
    const expected = new Map<ParticleKind, string>([
      [ParticleKind.Golden, 'physical'],
      [ParticleKind.Ice, 'ice'],
      [ParticleKind.Nature, 'life'],
      [ParticleKind.Void, 'void'],
      [ParticleKind.Light, 'light'],
      [ParticleKind.FireDust, 'fire'],
    ]);
    for (const id of WEAVE_WEAPON_IDS) {
      const def = getWeaponDef(id)!;
      assert.equal(def.element, expected.get(def.weaveDust as ParticleKind), `${id} element`);
    }
  });

  test('swords carry the shield secondary and bows do not', () => {
    for (const id of WEAVE_WEAPON_IDS) {
      const def = getWeaponDef(id)!;
      if (def.kind === 'melee') {
        assert.equal(def.secondaryShieldWeave, true, `${id} should raise a shield`);
      } else {
        assert.notEqual(def.secondaryShieldWeave, true, `${id} is a bow and should have no shield`);
      }
    }
  });

  test('no donor weapon claims a weave dust or a shield secondary', () => {
    for (const [id, def] of Object.entries(WEAPONS)) {
      if (Object.prototype.hasOwnProperty.call(STICKBLADE_WEAPON_DATA, id)) continue;
      assert.equal(def.weaveDust, undefined, `${id} is a donor weapon`);
      assert.equal(def.secondaryShieldWeave, undefined, `${id} is a donor weapon`);
    }
  });

  test('the swords read as one class — no hidden power ranking between elements', () => {
    const swords = WEAVE_WEAPON_IDS
      .map(id => getWeaponDef(id)!)
      .filter(def => def.kind === 'melee');
    const first = swords[0];
    for (const def of swords) {
      assert.equal(def.dmg, first.dmg);
      assert.equal(def.range, first.range);
      assert.equal(def.cooldown, first.cooldown);
    }
  });
});

describe('the sword secondary raises the Shield Weave', () => {
  test('the right mouse button asks for the shield', () => {
    const input = createInputState();
    input.isWeaponSecondaryHeldFlag = true;
    const held = collectCommands(input);
    assert.ok(held.some(c => c.kind === CommandKind.ShieldWeaveHold));

    input.isWeaponSecondaryHeldFlag = false;
    const released = collectCommands(input);
    assert.ok(released.some(c => c.kind === CommandKind.ShieldWeaveEnd));
  });

  test('the request is a plain hold — the weapon gate lives in the processor', () => {
    // `collectCommands` cannot see what is equipped, so it always asks; whether
    // the shield actually goes up is decided against `secondaryShieldWeave`
    // where the world is in scope.
    const weapon = createPlayerWeaponState();
    equipPlayerWeapon(weapon, 'frostweaveBlade');
    assert.equal(getEquippedWeaponDef(weapon)?.secondaryShieldWeave, true);

    equipPlayerWeapon(weapon, 'frostweaveBow');
    assert.notEqual(getEquippedWeaponDef(weapon)?.secondaryShieldWeave, true);

    equipPlayerWeapon(weapon, 'woodenSword');
    assert.notEqual(getEquippedWeaponDef(weapon)?.secondaryShieldWeave, true);
  });
});
