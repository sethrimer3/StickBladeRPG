/**
 * Phase 2d of the STICK-RPG port: the bespoke on-expiry effects, slash waves,
 * and the echo disc's return leg.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  applyExpiryEffect,
  EXPIRY_EFFECTS,
  EXPIRY_EFFECT_IDS,
  EXPIRY_EFFECT_NONE,
  getExpiryEffectByIndex,
  getExpiryEffectIndex,
  getExpiryEffectSlowTicks,
  getExpiryEffectWeaponId,
  tickClusterSlow,
} from '../sim/weapons/weaponExpiryEffects';
import { UNPORTED_BEHAVIOR_FIELDS } from '../sim/weapons/weaponData';
import { getWeaponDef, WEAPONS } from '../sim/weapons/weaponDefs';
import {
  createWeaponProjectilePool,
  fireRangedWeapon,
  fireWeaponSlashWaves,
  tickWeaponProjectiles,
  MAX_WEAPON_PROJECTILES,
} from '../sim/weapons/weaponProjectiles';
import { createClusterState, type ClusterState } from '../sim/clusters/state';
import { createWorldState, type WorldState } from '../sim/world';

const DT_MS = 1000 / 60;

function createWorldWithEnemy(enemyX: number, enemyY: number): {
  world: WorldState;
  player: ClusterState;
  enemy: ClusterState;
} {
  const world = createWorldState(DT_MS, 9);
  const player = createClusterState(1, 0, 0, 1, 100);
  const enemy = createClusterState(2, enemyX, enemyY, 0, 100);
  enemy.healthPoints = 50;
  enemy.maxHealthPoints = 50;
  world.clusters.push(player, enemy);
  return { world, player, enemy };
}

describe('expiry effect catalog', () => {
  test('every weapon named in UNPORTED_BEHAVIOR_FIELDS now has an effect', () => {
    for (const field of UNPORTED_BEHAVIOR_FIELDS) {
      const weaponId = field.split('.')[0];
      assert.ok(
        EXPIRY_EFFECTS[weaponId] !== undefined,
        `${weaponId} has no ported on-expiry effect`,
      );
    }
  });

  test('every effect names a real weapon and round-trips through its index', () => {
    for (const id of EXPIRY_EFFECT_IDS) {
      const def = WEAPONS[id];
      assert.notEqual(def, undefined, `${id} is not a weapon`);
      const index = getExpiryEffectIndex(def);
      assert.notEqual(index, EXPIRY_EFFECT_NONE);
      assert.equal(getExpiryEffectWeaponId(index), id);
      assert.equal(getExpiryEffectByIndex(index), EXPIRY_EFFECTS[id]);
    }
  });

  test('a weapon with no bespoke expiry reports none', () => {
    assert.equal(getExpiryEffectIndex(getWeaponDef('sword')), EXPIRY_EFFECT_NONE);
    assert.equal(getExpiryEffectIndex(null), EXPIRY_EFFECT_NONE);
    assert.equal(getExpiryEffectByIndex(EXPIRY_EFFECT_NONE), null);
  });

  test('slow durations convert from donor milliseconds to ticks', () => {
    // seedVolley's pollen lasts 2600 ms.
    assert.equal(getExpiryEffectSlowTicks(EXPIRY_EFFECTS['seedVolley']), 156);
    // A purely kinetic effect declares no slow.
    assert.equal(getExpiryEffectSlowTicks(EXPIRY_EFFECTS['windSpindle']), 0);
  });
});

describe('applying an expiry effect', () => {
  test('a pollen cloud damages and slows enemies in radius', () => {
    const { world, enemy } = createWorldWithEnemy(60, 0);
    const before = enemy.healthPoints;

    const result = applyExpiryEffect(
      world, EXPIRY_EFFECTS['seedVolley'], 0, 0, 1, world.rng,
    );

    assert.equal(result.affectedCount, 1);
    assert.ok(enemy.healthPoints < before);
    assert.equal(enemy.slowMultiplier, 0.55);
    assert.ok(enemy.slowTicks > 0);
  });

  test('enemies beyond the radius are untouched', () => {
    const { world, enemy } = createWorldWithEnemy(2000, 0);
    const before = enemy.healthPoints;

    const result = applyExpiryEffect(
      world, EXPIRY_EFFECTS['seedVolley'], 0, 0, 1, world.rng,
    );

    assert.equal(result.affectedCount, 0);
    assert.equal(enemy.healthPoints, before);
    assert.equal(enemy.slowTicks, 0);
  });

  test('the player is never caught by their own effect', () => {
    const { world, player } = createWorldWithEnemy(60, 0);
    player.healthPoints = 10;
    applyExpiryEffect(world, EXPIRY_EFFECTS['seedVolley'], 0, 0, 1, world.rng);
    assert.equal(player.healthPoints, 10);
    assert.equal(player.slowTicks, 0);
  });

  test('a gust burst shoves without damaging', () => {
    const { world, enemy } = createWorldWithEnemy(60, 0);
    const before = enemy.healthPoints;

    applyExpiryEffect(world, EXPIRY_EFFECTS['windSpindle'], 0, 0, 1, world.rng);

    assert.equal(enemy.healthPoints, before);
    // Pushed away from the burst, which sat to its left.
    assert.ok(enemy.velocityXWorld > 0, `velocity was ${enemy.velocityXWorld}`);
    assert.equal(enemy.slowTicks, 0);
  });

  test('a pressure burst lifts its targets upward', () => {
    const { world, enemy } = createWorldWithEnemy(20, 0);
    applyExpiryEffect(world, EXPIRY_EFFECTS['pressureLance'], 0, 0, 1, world.rng);
    assert.ok(enemy.velocityYWorld < 0, `velocity was ${enemy.velocityYWorld}`);
  });

  test('impulse falls off with distance', () => {
    const near = createWorldWithEnemy(10, 0);
    applyExpiryEffect(near.world, EXPIRY_EFFECTS['windSpindle'], 0, 0, 1, near.world.rng);

    const far = createWorldWithEnemy(120, 0);
    applyExpiryEffect(far.world, EXPIRY_EFFECTS['windSpindle'], 0, 0, 1, far.world.rng);

    assert.ok(near.enemy.velocityXWorld > far.enemy.velocityXWorld);
  });

  test('a weaker slow never overwrites a stronger one, but refreshes it', () => {
    const { world, enemy } = createWorldWithEnemy(30, 0);

    // Chrono field: 0.5, the strongest ported slow.
    applyExpiryEffect(world, EXPIRY_EFFECTS['chronoglassStaff'], 0, 0, 1, world.rng);
    assert.equal(enemy.slowMultiplier, 0.5);
    const ticksAfterChrono = enemy.slowTicks;

    // Anchor flail foam: 0.75, weaker.
    applyExpiryEffect(world, EXPIRY_EFFECTS['anchorFlail'], 0, 0, 1, world.rng);
    assert.equal(enemy.slowMultiplier, 0.5);
    assert.equal(enemy.slowTicks, ticksAfterChrono);
  });

  test('a slow expires and restores full speed', () => {
    const cluster = { slowTicks: 2, slowMultiplier: 0.5 };
    tickClusterSlow(cluster);
    assert.equal(cluster.slowMultiplier, 0.5);
    tickClusterSlow(cluster);
    assert.equal(cluster.slowTicks, 0);
    assert.equal(cluster.slowMultiplier, 1);
  });
});

describe('projectiles carrying an expiry effect', () => {
  test('a seed pod blooms where it dies, slowing what is nearby', () => {
    const { world, enemy } = createWorldWithEnemy(220, 0);
    const pool = createWeaponProjectilePool();

    fireRangedWeapon(pool, WEAPONS['seedVolley'], 200, 0, 300, 0, 1, world.rng);
    assert.ok(pool.liveCount > 0);

    for (let t = 0; t < 400 && pool.liveCount > 0; t++) {
      tickWeaponProjectiles(world, pool);
    }

    assert.equal(pool.liveCount, 0);
    assert.ok(enemy.slowTicks > 0, 'the pollen cloud never reached the enemy');
    assert.equal(enemy.slowMultiplier, EXPIRY_EFFECTS['seedVolley'].slowMultiplier);
  });

  test('an ordinary projectile leaves no slow behind', () => {
    const { world, enemy } = createWorldWithEnemy(300, 0);
    const pool = createWeaponProjectilePool();

    fireRangedWeapon(pool, WEAPONS['dagger'], 260, 0, 260, -400, 1, world.rng);
    for (let t = 0; t < 400 && pool.liveCount > 0; t++) {
      tickWeaponProjectiles(world, pool);
    }

    assert.equal(enemy.slowTicks, 0);
  });
});

describe('slash waves', () => {
  test('a slash-wave weapon fans out its declared count', () => {
    const world = createWorldState(DT_MS, 4);
    const pool = createWeaponProjectilePool();

    const launched = fireWeaponSlashWaves(
      pool, WEAPONS['toonBrush'], 0, 0, 100, 0, 1, world.rng,
    );

    assert.equal(launched, WEAPONS['toonBrush'].slashWaveCount);
    assert.equal(pool.liveCount, launched);
  });

  test('waves carry their weapon\'s expiry effect and ignore terrain', () => {
    const world = createWorldState(DT_MS, 4);
    const pool = createWeaponProjectilePool();

    fireWeaponSlashWaves(pool, WEAPONS['mirageGlaive'], 0, 0, 100, 0, 1, world.rng);

    let checked = 0;
    for (let i = 0; i < MAX_WEAPON_PROJECTILES; i++) {
      if (pool.isLive[i] === 0) continue;
      checked++;
      assert.equal(pool.ignoresTerrain[i], 1);
      assert.equal(pool.isPiercing[i], 1);
      assert.equal(
        getExpiryEffectByIndex(pool.expiryEffect[i]),
        EXPIRY_EFFECTS['mirageGlaive'],
      );
    }
    assert.ok(checked > 0);
  });

  test('a weapon with no slash waves launches none', () => {
    const world = createWorldState(DT_MS, 4);
    const pool = createWeaponProjectilePool();
    assert.equal(fireWeaponSlashWaves(pool, WEAPONS['sword'], 0, 0, 100, 0, 1, world.rng), 0);
    assert.equal(pool.liveCount, 0);
  });
});

describe('echo disc return', () => {
  test('an expiring disc turns back toward the player instead of dying', () => {
    const world = createWorldState(DT_MS, 6);
    const player = createClusterState(1, 0, 0, 1, 100);
    world.clusters.push(player);
    const pool = createWeaponProjectilePool();

    fireRangedWeapon(pool, WEAPONS['echoRepeater'], 0, 0, 100, 0, 1, world.rng);
    assert.equal(pool.liveCount, 1);

    // Run until the outbound leg expires and the disc turns around.
    let turned = false;
    for (let t = 0; t < 600 && pool.liveCount > 0; t++) {
      tickWeaponProjectiles(world, pool);
      if (pool.liveCount > 0 && pool.isReturning[0] === 1) {
        turned = true;
        break;
      }
    }

    assert.ok(turned, 'the disc never turned back');
    assert.equal(pool.liveCount, 1);
    // Heading back toward the player, who is to its left.
    assert.ok(pool.velocityXWorld[0] < 0, `velocity was ${pool.velocityXWorld[0]}`);
  });

  test('a returning disc expires for good on its second death', () => {
    const world = createWorldState(DT_MS, 6);
    const player = createClusterState(1, 0, 0, 1, 100);
    world.clusters.push(player);
    const pool = createWeaponProjectilePool();

    fireRangedWeapon(pool, WEAPONS['echoRepeater'], 0, 0, 100, 0, 1, world.rng);
    for (let t = 0; t < 2000 && pool.liveCount > 0; t++) {
      tickWeaponProjectiles(world, pool);
    }

    assert.equal(pool.liveCount, 0);
  });
});
