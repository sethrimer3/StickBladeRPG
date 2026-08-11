import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  createSoulOrbPool,
  spawnSoulOrb,
  tickSoulOrbs,
  resetSoulOrbPool,
} from '../sim/weapons/soulOrbs';
import {
  equipPlayerWeapon,
  tryStartPlayerWeaponAttack,
} from '../sim/weapons/playerWeaponState';
import { createWorldState, type WorldState } from '../sim/world';
import { createClusterState, type ClusterState } from '../sim/clusters/state';
import { getWeaponDef } from '../sim/weapons/weaponDefs';
import { applyRoutedWeaveDamage } from '../sim/weaves/weaveCollisionUtils';

const DT_MS = 1000 / 60;

function createWorldWithPlayer(): { world: WorldState; player: ClusterState } {
  const world = createWorldState(DT_MS, 3);
  const player = createClusterState(1, 0, 0, 1, 100);
  world.clusters.push(player);
  return { world, player };
}

describe('soul orb pool', () => {
  test('initializes empty and spawns soul drops', () => {
    const pool = createSoulOrbPool();
    assert.equal(pool.liveCount, 0);

    const spawned = spawnSoulOrb(pool, 100, 200, '#dfc9ff', 1);
    assert.equal(spawned, true);
    assert.equal(pool.liveCount, 1);
    assert.equal(pool.xWorld[0], 100);
    assert.equal(pool.yWorld[0], 200);
    assert.equal(pool.color[0], '#dfc9ff');
    assert.equal(pool.value[0], 1);
  });

  test('drifts toward wielder within soulRange and collects', () => {
    const pool = createSoulOrbPool();
    spawnSoulOrb(pool, 30, 0, '#dfc9ff', 1);

    const def = getWeaponDef('soulbinderPrimer');
    assert(def !== null);

    // Soul is at x=30, wielder at x=0 (dist 30 <= range 280, outside pickup radius 20)
    const gained1 = tickSoulOrbs(pool, 0, 0, def, 0);
    assert.equal(gained1, 0);
    assert.ok(pool.xWorld[0] < 30, 'soul should move closer to wielder');

    // Fast-forward movement until collected
    let totalGained = gained1;
    for (let t = 0; t < 60; t++) {
      totalGained += tickSoulOrbs(pool, 0, 0, def, totalGained);
      if (totalGained > 0) break;
    }
    assert.equal(totalGained, 1);
    assert.equal(pool.liveCount, 0);
  });

  test('respects maxSouls capacity limit', () => {
    const pool = createSoulOrbPool();
    spawnSoulOrb(pool, 5, 0, '#dfc9ff', 1);

    const def = getWeaponDef('soulbinderPrimer');
    assert(def !== null);

    // Current souls is already at maxSouls (6)
    const gained = tickSoulOrbs(pool, 0, 0, def, 6);
    assert.equal(gained, 0);
    assert.equal(pool.liveCount, 0, 'orb is consumed/dismissed at pickup');
  });

  test('resetSoulOrbPool dismisses all live soul drops', () => {
    const pool = createSoulOrbPool();
    spawnSoulOrb(pool, 10, 20);
    spawnSoulOrb(pool, 30, 40);
    assert.equal(pool.liveCount, 2);

    resetSoulOrbPool(pool);
    assert.equal(pool.liveCount, 0);
  });
});

describe('soul drops on enemy defeat and guardian empowerment', () => {
  test('enemy defeat drops soul orb when summoner weapon is equipped', () => {
    const { world } = createWorldWithPlayer();
    equipPlayerWeapon(world.playerWeapon, 'soulbinderPrimer');

    const enemy = createClusterState(2, 50, 50, 1, 10);
    enemy.isAliveFlag = 1;
    enemy.healthPoints = 10;
    world.clusters.push(enemy);

    assert.equal(world.playerWeapon.soulOrbs.liveCount, 0);

    // Deal lethal damage to enemy
    applyRoutedWeaveDamage(world, 1, 15, 50, 50);

    assert.equal(enemy.healthPoints, 0);
    assert.equal(enemy.isAliveFlag, 0);
    assert.equal(world.playerWeapon.soulOrbs.liveCount, 1);
  });

  test('spending banked souls spawns an empowered Guardian familiar', () => {
    const { world, player } = createWorldWithPlayer();
    equipPlayerWeapon(world.playerWeapon, 'soulbinderPrimer');

    // Give player 3 banked souls
    world.playerWeapon.soulsCollected = 3;

    const def = getWeaponDef('soulbinderPrimer');
    assert(def !== null);

    const didAttack = tryStartPlayerWeaponAttack(world, player, 100, 0, world.rng);
    assert.equal(didAttack, true);

    // Souls should be consumed on cast
    assert.equal(world.playerWeapon.soulsCollected, 0);

    const summons = world.playerWeapon.summons;
    assert.equal(summons.liveCount, 1);
    assert.equal(summons.isGuardian[0], 1, 'familiar should be flagged as Guardian');
    assert.ok(summons.multiHitCount[0] >= 3, 'guardian should have multi-hit charges');
    assert.ok(summons.radiusWorld[0] > (def.summonRadius ?? 12), 'guardian should be larger');
  });

  test('casting without souls spawns regular familiar', () => {
    const { world, player } = createWorldWithPlayer();
    equipPlayerWeapon(world.playerWeapon, 'soulbinderPrimer');
    world.playerWeapon.soulsCollected = 0;

    const didAttack = tryStartPlayerWeaponAttack(world, player, 100, 0, world.rng);
    assert.equal(didAttack, true);

    const summons = world.playerWeapon.summons;
    assert.equal(summons.liveCount, 1);
    assert.equal(summons.isGuardian[0], 0, 'regular familiar is not a Guardian');
    assert.equal(summons.multiHitCount[0], 1);
  });
});
