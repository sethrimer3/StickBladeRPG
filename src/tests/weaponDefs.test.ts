import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  MS_PER_TICK,
  UNPORTED_BEHAVIOR_FIELDS,
  WEAPONS,
  WEAPON_IDS,
  getWeaponBaseElement,
  getWeaponCooldownTicks,
  getWeaponDef,
  getWeaponIdsOfKind,
  getWeaponProjectileTtlTicks,
  getWeaponSwingDurationTicks,
  isPlayerEquippableWeapon,
  isWeaponRuntimeImplemented,
  millisecondsToTicks,
  type WeaponGrip,
  type WeaponKind,
} from '../sim/weapons/weaponDefs';
import {
  GLYPHS,
  GLYPH_ORDER,
  applyGlyphToWeapon,
  getGlyphDef,
  getGlyphSortIndex,
  weaponSupportsGlyphSocket,
} from '../sim/weapons/glyphDefs';
import { WEAPON_DATA } from '../sim/weapons/weaponData';
import { STICKBLADE_WEAPON_DATA } from '../sim/weapons/stickbladeWeapons';

const VALID_KINDS: readonly WeaponKind[] = [
  'melee', 'shield', 'bow', 'gun', 'throw', 'magic', 'staff', 'summoner', 'spirit',
];
const VALID_GRIPS: readonly WeaponGrip[] = ['oneHand', 'twoHand', 'dual'];

describe('weapon data integrity', () => {
  test('the table is the 75 donor weapons plus StickBlade\'s 13', () => {
    // Split deliberately: `weaponData.ts` is a verbatim copy of the donor and
    // must stay diffable against it, so anything original to StickBlade lives
    // in `stickbladeWeapons.ts`. Pinning both halves is what keeps that true.
    assert.equal(Object.keys(WEAPON_DATA).length, 75, 'donor weapons');
    assert.equal(Object.keys(STICKBLADE_WEAPON_DATA).length, 13, 'Wooden Sword + 12 weave weapons');
    assert.equal(WEAPON_IDS.length, 88);
  });

  test('no StickBlade weapon shadows a donor weapon', () => {
    for (const id of Object.keys(STICKBLADE_WEAPON_DATA)) {
      assert.ok(
        !Object.prototype.hasOwnProperty.call(WEAPON_DATA, id),
        `${id} collides with a donor weapon and would silently replace it`,
      );
    }
  });

  test('ids are unique and sorted', () => {
    assert.deepEqual([...WEAPON_IDS], [...new Set(WEAPON_IDS)].sort());
  });

  test('every weapon has a name and a valid kind', () => {
    for (const id of WEAPON_IDS) {
      const def = WEAPONS[id];
      assert.ok(def.name.length > 0, `${id} has no name`);
      assert.ok(VALID_KINDS.includes(def.kind), `${id} has invalid kind ${def.kind}`);
    }
  });

  test('every declared grip is a known grip', () => {
    for (const id of WEAPON_IDS) {
      const grip = WEAPONS[id].grip;
      if (grip !== undefined) {
        assert.ok(VALID_GRIPS.includes(grip), `${id} has invalid grip ${grip}`);
      }
    }
  });

  test('numeric combat fields are finite and non-negative', () => {
    for (const id of WEAPON_IDS) {
      const def = WEAPONS[id];
      for (const field of ['dmg', 'range', 'arc', 'cooldown', 'knock'] as const) {
        const value = def[field];
        if (value === undefined) continue;
        assert.ok(Number.isFinite(value), `${id}.${field} is not finite`);
        assert.ok(value >= 0, `${id}.${field} is negative`);
      }
    }
  });

  test('landmark donor weapons ported with their exact values', () => {
    // Spot-checks against js/weapons.js so a bad regeneration is caught.
    assert.deepEqual(WEAPONS['sword'], {
      name: 'Sword', kind: 'melee', range: 42, arc: 1.0, dmg: 2,
      cooldown: 550, knock: 160, color: '#d0f', grip: 'oneHand',
    });
    assert.deepEqual(WEAPONS['woodenSword'], {
      // Deliberately half the donor's 42 — see the note in weaponData.ts.
      name: 'Wooden Sword', kind: 'melee', range: 21, arc: 1.1, dmg: 2,
      cooldown: 550, knock: 160, color: '#c89d66', grip: 'twoHand',
      spriteUrl: 'SPRITES/Weapons/WoodenSword.png',
      spriteGripRatioX: 0.5, spriteGripRatioY: 0.9,
    });
    assert.equal(WEAPONS['greatsword'].swingDuration, 320);
    assert.equal(WEAPONS['greatsword'].grip, 'twoHand');
    assert.equal(WEAPONS['templarianWallShield'].kind, 'shield');
    assert.equal(WEAPONS['templarianWallShield'].healthMultiplier, 10);
    assert.equal(WEAPONS['templarianWallShield'].partyDamageRedirect, true);
    assert.equal(WEAPONS['neonBlade'].enemyOnly, true);
    assert.equal(WEAPONS['sigilBlade'].glyphSocket, true);
  });

  test('nested donor config blocks survived the port', () => {
    assert.ok(WEAPONS['templarianWallShield'].shield, 'shield block missing');
    assert.equal(
      (WEAPONS['templarianWallShield'].shield as Record<string, unknown>)['crossColor'],
      '#d6d6d6',
    );
  });

  test('the donor kind distribution is preserved', () => {
    // Counted over the donor table alone so adding StickBlade weapons can never
    // make this pass by coincidence.
    const donorCount = (kind: WeaponKind): number =>
      Object.values(WEAPON_DATA).filter(def => def.kind === kind).length;
    assert.equal(donorCount('melee'), 24);
    assert.equal(donorCount('shield'), 1);
    assert.equal(donorCount('staff'), 9);
    assert.equal(donorCount('bow'), 6);
    assert.equal(donorCount('throw'), 5);
    assert.equal(donorCount('gun'), 7);
    assert.equal(donorCount('summoner'), 4);
    assert.equal(donorCount('spirit'), 4);
    assert.equal(donorCount('magic'), 15);
  });

  test('the weave weapons add six swords and six bows on top', () => {
    assert.equal(getWeaponIdsOfKind('melee').length, 24 + 1 + 6, 'donor + Wooden Sword + weave blades');
    assert.equal(getWeaponIdsOfKind('bow').length, 6 + 6);
  });

  test('the 12 unported donor callbacks are recorded, not silently dropped', () => {
    assert.equal(UNPORTED_BEHAVIOR_FIELDS.length, 12);
    for (const entry of UNPORTED_BEHAVIOR_FIELDS) {
      const [weaponId, field] = entry.split('.');
      assert.ok(WEAPONS[weaponId], `${entry} names a missing weapon`);
      assert.ok(
        field === 'projectileOnExpire' || field === 'slashWaveOnExpire',
        `${entry} names an unexpected field`,
      );
    }
  });
});

describe('weapon lookup', () => {
  test('known ids resolve', () => {
    assert.equal(getWeaponDef('sword')?.name, 'Sword');
  });

  test('unknown and non-string ids return null', () => {
    assert.equal(getWeaponDef('notAWeapon'), null);
    assert.equal(getWeaponDef(null), null);
    assert.equal(getWeaponDef(undefined), null);
  });

  test('prototype keys do not resolve as weapons', () => {
    assert.equal(getWeaponDef('constructor'), null);
    assert.equal(getWeaponDef('toString'), null);
  });

  test('enemy-only weapons are excluded from player loadouts', () => {
    assert.equal(isPlayerEquippableWeapon(WEAPONS['neonBlade']), false);
    assert.equal(isPlayerEquippableWeapon(WEAPONS['sword']), true);
  });

  test('runtime coverage is reported honestly', () => {
    // Contact kinds (Phase 2) and projectile kinds (Phase 2a).
    assert.equal(isWeaponRuntimeImplemented(WEAPONS['sword']), true);
    assert.equal(isWeaponRuntimeImplemented(WEAPONS['templarianWallShield']), true);
    assert.equal(isWeaponRuntimeImplemented(WEAPONS['bow']), true);
    assert.equal(isWeaponRuntimeImplemented(WEAPONS['wand']), true);
    // Staff and spirit kinds (Phase 2c); summoner (Phase 2f).
    assert.equal(isWeaponRuntimeImplemented(WEAPONS['emberStaff']), true);
    assert.equal(isWeaponRuntimeImplemented(WEAPONS['spiritBand']), true);
    assert.equal(isWeaponRuntimeImplemented(WEAPONS['soulbinderPrimer']), true);
    assert.equal(isWeaponRuntimeImplemented(WEAPONS['apiaryLexicon']), true);
  });

  test('every ported weapon kind now has a runtime', () => {
    for (const id of WEAPON_IDS) {
      assert.equal(
        isWeaponRuntimeImplemented(WEAPONS[id]), true,
        `${id} (kind ${WEAPONS[id].kind}) reports no runtime`,
      );
    }
  });

  test('base element defaults to physical', () => {
    assert.equal(getWeaponBaseElement(WEAPONS['sword']), 'physical');
    assert.equal(getWeaponBaseElement(WEAPONS['firebolt']), 'fire');
  });
});

describe('millisecond to tick conversion', () => {
  test('converts at the simulation timestep', () => {
    assert.equal(millisecondsToTicks(1000), 60);
    assert.equal(millisecondsToTicks(MS_PER_TICK), 1);
  });

  test('non-positive and non-finite input yields zero', () => {
    assert.equal(millisecondsToTicks(0), 0);
    assert.equal(millisecondsToTicks(-100), 0);
    assert.equal(millisecondsToTicks(Number.NaN), 0);
    assert.equal(millisecondsToTicks(undefined), 0);
  });

  test('a very short duration still yields a real tick, never zero', () => {
    assert.equal(millisecondsToTicks(1), 1);
  });

  test('the sword cooldown converts to its expected tick count', () => {
    // 550 ms / 16.666 ms ≈ 33 ticks
    assert.equal(getWeaponCooldownTicks(WEAPONS['sword']), 33);
  });

  test('swing duration falls back to cooldown when unspecified', () => {
    const sword = WEAPONS['sword'];
    assert.equal(sword.swingDuration, undefined);
    assert.equal(getWeaponSwingDurationTicks(sword), getWeaponCooldownTicks(sword));
    // Greatsword declares one explicitly, so it does not fall back.
    assert.equal(getWeaponSwingDurationTicks(WEAPONS['greatsword']), millisecondsToTicks(320));
  });

  test('projectile ttl converts', () => {
    assert.equal(getWeaponProjectileTtlTicks(WEAPONS['bomb']), millisecondsToTicks(2600));
  });

  test('every weapon cooldown converts to a finite non-negative tick count', () => {
    for (const id of WEAPON_IDS) {
      const ticks = getWeaponCooldownTicks(WEAPONS[id]);
      assert.ok(Number.isInteger(ticks) && ticks >= 0, `${id} produced ${ticks}`);
    }
  });
});

describe('glyphs', () => {
  test('all eight donor glyphs are present in canonical order', () => {
    assert.equal(GLYPH_ORDER.length, 8);
    for (const id of GLYPH_ORDER) assert.ok(GLYPHS[id], `${id} missing`);
  });

  test('lookup is case and whitespace tolerant', () => {
    assert.equal(getGlyphDef('  FIRE ')?.id, 'fire');
  });

  test('the donor chrono alias resolves to chronometric', () => {
    assert.equal(getGlyphDef('chrono')?.id, 'chronometric');
  });

  test('unknown glyphs return null and sort last', () => {
    assert.equal(getGlyphDef('sparkle'), null);
    assert.equal(getGlyphDef(''), null);
    assert.equal(getGlyphSortIndex('sparkle'), GLYPH_ORDER.length);
    assert.equal(getGlyphSortIndex('fire'), 0);
  });

  test('prototype keys do not resolve as glyphs', () => {
    assert.equal(getGlyphDef('constructor'), null);
  });
});

describe('glyph application', () => {
  test('a socketed weapon takes the glyph element and presentation', () => {
    const result = applyGlyphToWeapon(WEAPONS['sigilBlade'], 'fire');
    assert.equal(result.element, 'fire');
    assert.equal(result.color, GLYPHS.fire.color);
    assert.equal(result.glyphApplied, 'fire');
    assert.equal(result.glyphSymbol, '火');
    assert.equal(result.name, 'Sigil Blade (Pyre Glyph)');
  });

  test('a weapon without a socket is unchanged', () => {
    assert.equal(weaponSupportsGlyphSocket(WEAPONS['sword']), false);
    const result = applyGlyphToWeapon(WEAPONS['sword'], 'fire');
    assert.equal(result.glyphApplied, undefined);
    assert.equal(result.element, WEAPONS['sword'].element);
    assert.equal(result.name, 'Sword');
  });

  test('an unknown glyph leaves a socketed weapon unchanged', () => {
    const result = applyGlyphToWeapon(WEAPONS['sigilBlade'], 'sparkle');
    assert.equal(result.glyphApplied, undefined);
    assert.equal(result.name, 'Sigil Blade');
  });

  test('glyphs never alter damage, range, or cooldown', () => {
    const base = WEAPONS['sigilBlade'];
    const result = applyGlyphToWeapon(base, 'void');
    assert.equal(result.dmg, base.dmg);
    assert.equal(result.range, base.range);
    assert.equal(result.cooldown, base.cooldown);
    assert.equal(result.knock, base.knock);
  });

  test('the source definition is never mutated', () => {
    const before = JSON.stringify(WEAPONS['sigilBlade']);
    applyGlyphToWeapon(WEAPONS['sigilBlade'], 'ice');
    assert.equal(JSON.stringify(WEAPONS['sigilBlade']), before);
  });

  test('nested config blocks are copied, not shared with the definition table', () => {
    const shield = WEAPONS['templarianWallShield'];
    const result = applyGlyphToWeapon(shield, 'fire');
    assert.notEqual(result.shield, shield.shield);
    assert.deepEqual(result.shield, shield.shield);
  });

  test('ammoColor is overridden for guns only, matching the donor', () => {
    const gunId = getWeaponIdsOfKind('gun').find(id => WEAPONS[id].glyphSocket === true);
    assert.ok(gunId, 'expected at least one glyph-socketed gun');
    const gun = applyGlyphToWeapon(WEAPONS[gunId], 'fire');
    assert.equal(gun.ammoColor, GLYPHS.fire.ammoColor);

    const blade = applyGlyphToWeapon(WEAPONS['sigilBlade'], 'fire');
    assert.equal(blade.ammoColor, WEAPONS['sigilBlade'].ammoColor);
  });

  test('every glyph applies cleanly to a socketed weapon', () => {
    for (const id of GLYPH_ORDER) {
      const result = applyGlyphToWeapon(WEAPONS['sigilBlade'], id);
      assert.equal(result.glyphApplied, id);
      assert.equal(result.element, GLYPHS[id].element);
    }
  });
});
