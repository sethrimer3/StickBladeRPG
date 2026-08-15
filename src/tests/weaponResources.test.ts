/**
 * Tests for the Ammo / Dust / Mana weapon resource pools.
 *
 * Covers which family draws from which pool, the spend gate, staff channel
 * drain, passive regeneration, and how pool capacity tracks the stat boosts in
 * `progression/statBoosts.ts`.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  DEFAULT_RESOURCE_COST,
  RESOURCE_REGEN_PER_SECOND,
  STAFF_MANA_DRAIN_PER_SECOND,
  canAffordWeaponAttack,
  createWeaponResourcePools,
  drainChannelledMana,
  getWeaponResourceCost,
  getWeaponResourceKind,
  refillWeaponResources,
  spendWeaponResource,
  syncWeaponResourceMaxes,
  tickWeaponResourceRegen,
} from '../sim/weapons/weaponResources';
import type { WeaponDef } from '../sim/weapons/weaponDefs';
import {
  addFlatStatBoost,
  addPercentStatBoost,
  createEmptyStatBoosts,
  BASE_STAT_VALUES,
} from '../progression/statBoosts';

function weapon(overrides: Partial<WeaponDef>): WeaponDef {
  return { name: 'Test', kind: 'melee', ...overrides } as WeaponDef;
}

describe('weapon resource families', () => {
  test('guns draw from ammo, magic from mana, staves from mana', () => {
    assert.equal(getWeaponResourceKind(weapon({ kind: 'gun' })), 'ammo');
    assert.equal(getWeaponResourceKind(weapon({ kind: 'magic' })), 'mana');
    assert.equal(getWeaponResourceKind(weapon({ kind: 'staff' })), 'mana');
  });

  test('weave weapons draw dust regardless of how they are held', () => {
    // A weave bow is still a bow, but what it spends follows what it is woven
    // from — this is the precedence rule the module documents.
    assert.equal(getWeaponResourceKind(weapon({ kind: 'bow', weaveDust: 0 })), 'dust');
    assert.equal(getWeaponResourceKind(weapon({ kind: 'melee', weaveDust: 3 })), 'dust');
  });

  test('ordinary melee, bows, and shields are unmetered', () => {
    assert.equal(getWeaponResourceKind(weapon({ kind: 'melee' })), null);
    assert.equal(getWeaponResourceKind(weapon({ kind: 'bow' })), null);
    assert.equal(getWeaponResourceKind(weapon({ kind: 'shield' })), null);
    assert.equal(getWeaponResourceKind(null), null);
  });

  test('cost falls back to the family default and honors an authored override', () => {
    assert.equal(getWeaponResourceCost(weapon({ kind: 'gun' })), DEFAULT_RESOURCE_COST.ammo);
    assert.equal(getWeaponResourceCost(weapon({ kind: 'gun', resourceCost: 4 })), 4);
    // Unmetered weapons cost nothing even if they somehow declare a cost.
    assert.equal(getWeaponResourceCost(weapon({ kind: 'melee', resourceCost: 9 })), 0);
  });
});

describe('spending', () => {
  test('an unmetered weapon always affords and spends nothing', () => {
    const pools = createWeaponResourcePools();
    const before = pools.ammo.current;
    assert.equal(canAffordWeaponAttack(pools, weapon({ kind: 'melee' })), true);
    assert.equal(spendWeaponResource(pools, weapon({ kind: 'melee' })), true);
    assert.equal(pools.ammo.current, before);
  });

  test('a gun deducts one ammo per shot and is refused when dry', () => {
    const pools = createWeaponResourcePools();
    const gun = weapon({ kind: 'gun' });
    pools.ammo.current = 2;

    assert.equal(spendWeaponResource(pools, gun), true);
    assert.equal(pools.ammo.current, 1);
    assert.equal(spendWeaponResource(pools, gun), true);
    assert.equal(pools.ammo.current, 0);

    assert.equal(canAffordWeaponAttack(pools, gun), false);
    assert.equal(spendWeaponResource(pools, gun), false);
    // A refused spend changes nothing rather than going negative.
    assert.equal(pools.ammo.current, 0);
  });

  test('a partial pool cannot pay a cost larger than it holds', () => {
    const pools = createWeaponResourcePools();
    const heavy = weapon({ kind: 'magic', resourceCost: 5 });
    pools.mana.current = 4;
    assert.equal(spendWeaponResource(pools, heavy), false);
    assert.equal(pools.mana.current, 4);
  });

  test('dust weapons spend from dust, leaving ammo and mana untouched', () => {
    const pools = createWeaponResourcePools();
    const weaveSword = weapon({ kind: 'melee', weaveDust: 1 });
    const ammoBefore = pools.ammo.current;
    const manaBefore = pools.mana.current;

    assert.equal(spendWeaponResource(pools, weaveSword), true);
    assert.equal(pools.dust.current, BASE_STAT_VALUES.dust - DEFAULT_RESOURCE_COST.dust);
    assert.equal(pools.ammo.current, ammoBefore);
    assert.equal(pools.mana.current, manaBefore);
  });
});

describe('staff channel drain', () => {
  test('drains mana proportionally to elapsed time', () => {
    const pools = createWeaponResourcePools();
    pools.mana.max = 100;
    pools.mana.current = 100;

    assert.equal(drainChannelledMana(pools, 1000), true);
    assert.equal(pools.mana.current, 100 - STAFF_MANA_DRAIN_PER_SECOND);
  });

  test('reports empty once the pool runs out, and never goes negative', () => {
    const pools = createWeaponResourcePools();
    pools.mana.current = 1;

    // One full second costs more than the single unit on hand.
    assert.equal(drainChannelledMana(pools, 1000), false);
    assert.equal(pools.mana.current, 0);
    // Already empty: still reports empty rather than paying from nothing.
    assert.equal(drainChannelledMana(pools, 1000), false);
    assert.equal(pools.mana.current, 0);
  });

  test('a zero or negative slice is free', () => {
    const pools = createWeaponResourcePools();
    const before = pools.mana.current;
    assert.equal(drainChannelledMana(pools, 0), true);
    assert.equal(pools.mana.current, before);
  });
});

describe('passive regeneration', () => {
  test('sub-unit rates accumulate across ticks instead of flooring away', () => {
    const pools = createWeaponResourcePools();
    pools.ammo.max = 10;
    pools.ammo.current = 0;

    // A single 16ms tick regenerates far less than one whole unit.
    tickWeaponResourceRegen(pools, 16);
    assert.equal(pools.ammo.current, 0);
    assert.ok(pools.ammo.regenAccumulator > 0);

    // Enough elapsed time for exactly one unit at the ammo rate.
    tickWeaponResourceRegen(pools, 1000 / RESOURCE_REGEN_PER_SECOND.ammo);
    assert.equal(pools.ammo.current, 1);
  });

  test('regeneration stops at max and clears the accumulator', () => {
    const pools = createWeaponResourcePools();
    pools.dust.max = 4;
    pools.dust.current = 4;

    tickWeaponResourceRegen(pools, 10_000);
    assert.equal(pools.dust.current, 4);
    assert.equal(pools.dust.regenAccumulator, 0);
  });

  test('the skipped pool does not regenerate', () => {
    const pools = createWeaponResourcePools();
    pools.mana.max = 100;
    pools.mana.current = 0;
    pools.ammo.max = 100;
    pools.ammo.current = 0;

    tickWeaponResourceRegen(pools, 5000, 'mana');
    assert.equal(pools.mana.current, 0);
    assert.ok(pools.ammo.current > 0);
  });
});

describe('capacity from stat boosts', () => {
  test('a flat ammo boost raises the magazine without refilling it', () => {
    const pools = createWeaponResourcePools();
    const boosts = createEmptyStatBoosts();
    syncWeaponResourceMaxes(pools, boosts);

    const baseMax = pools.ammo.max;
    pools.ammo.current = 1;

    addFlatStatBoost(boosts, 'ammo', 3);
    syncWeaponResourceMaxes(pools, boosts);

    assert.equal(pools.ammo.max, baseMax + 3);
    // Raising the ceiling must not act as a free reload.
    assert.equal(pools.ammo.current, 1);
  });

  test('a percentage mana boost rounds down', () => {
    const pools = createWeaponResourcePools();
    const boosts = createEmptyStatBoosts();
    addPercentStatBoost(boosts, 'mana', 5);
    syncWeaponResourceMaxes(pools, boosts);

    // floor(10 × 1.05) = 10
    assert.equal(pools.mana.max, Math.floor(BASE_STAT_VALUES.mana * 1.05));
  });

  test('shrinking capacity clamps the current value down', () => {
    const pools = createWeaponResourcePools();
    const boosts = createEmptyStatBoosts();
    addFlatStatBoost(boosts, 'dust', 10);
    syncWeaponResourceMaxes(pools, boosts);
    refillWeaponResources(pools);
    assert.equal(pools.dust.current, pools.dust.max);

    const shrunk = createEmptyStatBoosts();
    syncWeaponResourceMaxes(pools, shrunk);
    assert.equal(pools.dust.current, pools.dust.max);
    assert.equal(pools.dust.max, BASE_STAT_VALUES.dust);
  });

  test('a null boost record leaves pools alone', () => {
    const pools = createWeaponResourcePools();
    const before = pools.ammo.max;
    syncWeaponResourceMaxes(pools, null);
    assert.equal(pools.ammo.max, before);
  });
});
