import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  MAX_ACTIVE_SUMMONS,
  SUMMON_LOCOMOTION_FLIER,
  SUMMON_LOCOMOTION_HOPPER,
  castWeaponSummons,
  createSummonPool,
  getMaxActiveSummons,
  getSummonLocomotion,
  isSummonerWeapon,
  resetSummonPool,
  tickWeaponSummons,
  type SummonPool,
} from '../sim/weapons/weaponSummons';
import { WEAPONS, isWeaponRuntimeImplemented, type WeaponDef } from '../sim/weapons/weaponDefs';
import {
  createPlayerWeaponState,
  equipPlayerWeapon,
  tickPlayerWeapon,
  tryStartPlayerWeaponAttack,
} from '../sim/weapons/playerWeaponState';
import { createWorldState, type WorldState } from '../sim/world';
import { createClusterState, type ClusterState } from '../sim/clusters/state';
import { createRng } from '../sim/rng';

const DT_MS = 1000 / 60;

function createWorldWithPlayer(): { world: WorldState; player: ClusterState } {
  const world = createWorldState(DT_MS, 5);
  const player = createClusterState(1, 0, 0, 1, 100);
  world.clusters.push(player);
  return { world, player };
}

function addEnemy(world: WorldState, x: number, y: number, health = 1000): ClusterState {
  const enemy = createClusterState(1, x, y, 0, health);
  world.clusters.push(enemy);
  return enemy;
}

function advance(world: WorldState, pool: SummonPool, ticks: number): { hits: number; damage: number } {
  let hits = 0;
  let damage = 0;
  for (let i = 0; i < ticks; i++) {
    const result = tickWeaponSummons(world, pool);
    hits += result.hitCount;
    damage += result.totalDamage;
  }
  return { hits, damage };
}

describe('summoner classification', () => {
  test('all four donor summoners are recognized', () => {
    for (const id of ['apiaryLexicon', 'quillAviary', 'silkboundLexicon', 'soulbinderPrimer']) {
      assert.equal(isSummonerWeapon(WEAPONS[id]), true, `${id} should be a summoner`);
    }
  });

  test('non-summoners are not', () => {
    assert.equal(isSummonerWeapon(WEAPONS['sword']), false);
    assert.equal(isSummonerWeapon(WEAPONS['emberStaff']), false);
  });

  test('locomotion is derived from the weapon data, not the form name', () => {
    // Bees declare drag/bounce and no climb lift → free fliers.
    assert.equal(getSummonLocomotion(WEAPONS['apiaryLexicon']), SUMMON_LOCOMOTION_FLIER);
    // Birds and spiders declare climb lift → grounded hoppers.
    assert.equal(getSummonLocomotion(WEAPONS['quillAviary']), SUMMON_LOCOMOTION_HOPPER);
    assert.equal(getSummonLocomotion(WEAPONS['silkboundLexicon']), SUMMON_LOCOMOTION_HOPPER);
  });

  test('each summoner reports its own active cap', () => {
    assert.equal(getMaxActiveSummons(WEAPONS['apiaryLexicon']), 20);
    assert.equal(getMaxActiveSummons(WEAPONS['quillAviary']), 4);
    assert.equal(getMaxActiveSummons(WEAPONS['silkboundLexicon']), 3);
  });

  test('the cap is clamped to the pool capacity', () => {
    assert.equal(getMaxActiveSummons({ ...WEAPONS['apiaryLexicon'], maxActiveSummons: 9999 }), MAX_ACTIVE_SUMMONS);
  });
});

describe('casting', () => {
  test('a cast creates the weapon charge count', () => {
    const pool = createSummonPool();
    const def = WEAPONS['silkboundLexicon'];
    const result = castWeaponSummons(pool, def, 0, 0, 1, createRng(1));
    // silkboundLexicon: 4 charges but a cap of 3.
    assert.equal(pool.liveCount, 3);
    assert.ok(result.summonedCount > 0);
  });

  test('casting never exceeds the weapon cap', () => {
    const pool = createSummonPool();
    const def = WEAPONS['quillAviary'];
    for (let i = 0; i < 10; i++) castWeaponSummons(pool, def, 0, 0, 1, createRng(i));
    assert.equal(pool.liveCount, getMaxActiveSummons(def));
  });

  test('a non-summoner casts nothing', () => {
    const pool = createSummonPool();
    const result = castWeaponSummons(pool, WEAPONS['sword'], 0, 0, 1, createRng(1));
    assert.equal(result.summonedCount, 0);
    assert.equal(pool.liveCount, 0);
  });

  test('familiars are spread around the caster rather than stacked', () => {
    const pool = createSummonPool();
    castWeaponSummons(pool, WEAPONS['apiaryLexicon'], 100, 100, 1, createRng(1));
    const positions = new Set<string>();
    for (let i = 0; i < MAX_ACTIVE_SUMMONS; i++) {
      if (pool.isLive[i] === 1) positions.add(`${Math.round(pool.xWorld[i])},${Math.round(pool.yWorld[i])}`);
    }
    assert.ok(positions.size > 1, 'familiars should not share one point');
  });

  test('reset dismisses everything', () => {
    const pool = createSummonPool();
    castWeaponSummons(pool, WEAPONS['apiaryLexicon'], 0, 0, 1, createRng(1));
    resetSummonPool(pool);
    assert.equal(pool.liveCount, 0);
  });
});

describe('familiar behavior', () => {
  test('a flier seeks the nearest enemy', () => {
    const { world } = createWorldWithPlayer();
    addEnemy(world, 400, 0);
    const pool = createSummonPool();
    castWeaponSummons(pool, WEAPONS['apiaryLexicon'], 0, 0, 1, createRng(1));

    const slot = pool.isLive.indexOf(1);
    const startX = pool.xWorld[slot];
    advance(world, pool, 20);
    assert.ok(pool.xWorld[slot] > startX, 'familiar should have moved toward the enemy');
  });

  test('a hopper falls under gravity', () => {
    const { world } = createWorldWithPlayer();
    const pool = createSummonPool();
    castWeaponSummons(pool, WEAPONS['quillAviary'], 0, 0, 1, createRng(1));

    const slot = pool.isLive.indexOf(1);
    const startY = pool.yWorld[slot];
    advance(world, pool, 20);
    assert.ok(pool.yWorld[slot] > startY, 'a grounded familiar should fall');
  });

  test('a flier does not fall', () => {
    const { world } = createWorldWithPlayer();
    const pool = createSummonPool();
    castWeaponSummons(pool, WEAPONS['apiaryLexicon'], 0, 0, 1, createRng(1));

    const slot = pool.isLive.indexOf(1);
    const startY = pool.yWorld[slot];
    advance(world, pool, 20);
    assert.ok(Math.abs(pool.yWorld[slot] - startY) < 1, 'a flier should hold its height');
  });

  test('a familiar damages an enemy it reaches', () => {
    const { world } = createWorldWithPlayer();
    const enemy = addEnemy(world, 120, 0);
    const pool = createSummonPool();
    castWeaponSummons(pool, WEAPONS['apiaryLexicon'], 0, 0, 1, createRng(1));

    const { hits } = advance(world, pool, 120);
    assert.ok(hits > 0, 'familiar should have connected');
    assert.ok(enemy.healthPoints < 1000);
  });

  test('a familiar does not damage every tick it is touching', () => {
    const { world } = createWorldWithPlayer();
    addEnemy(world, 20, 0);
    const pool = createSummonPool();
    castWeaponSummons(pool, WEAPONS['apiaryLexicon'], 0, 0, 1, createRng(1));

    const { hits } = advance(world, pool, 60);
    // A 30-tick hit cooldown allows at most a few hits per familiar in 60 ticks.
    assert.ok(hits > 0 && hits <= 8, `expected a paced hit count, got ${hits}`);
  });

  test('the player is never damaged by their own familiars', () => {
    const { world, player } = createWorldWithPlayer();
    const pool = createSummonPool();
    castWeaponSummons(pool, WEAPONS['apiaryLexicon'], 0, 0, 1, createRng(1));
    advance(world, pool, 120);
    assert.equal(player.healthPoints, 100);
  });

  test('familiars expire after their lifetime', () => {
    const { world } = createWorldWithPlayer();
    const pool = createSummonPool();
    // 200 ms lifetime → about 12 ticks.
    const shortLived: WeaponDef = { ...WEAPONS['apiaryLexicon'], summonLifetime: 200 };
    castWeaponSummons(pool, shortLived, 0, 0, 1, createRng(1));
    assert.ok(pool.liveCount > 0);

    advance(world, pool, 30);
    assert.equal(pool.liveCount, 0);
  });

  test('familiars idle harmlessly when the room has no enemies', () => {
    const { world } = createWorldWithPlayer();
    const pool = createSummonPool();
    castWeaponSummons(pool, WEAPONS['apiaryLexicon'], 0, 0, 1, createRng(1));
    const { hits } = advance(world, pool, 60);
    assert.equal(hits, 0);
    assert.ok(pool.liveCount > 0, 'they should still be alive, just idle');
  });

  test('a dead enemy is no longer chased or damaged', () => {
    const { world } = createWorldWithPlayer();
    const enemy = addEnemy(world, 120, 0);
    enemy.isAliveFlag = 0;
    const pool = createSummonPool();
    castWeaponSummons(pool, WEAPONS['apiaryLexicon'], 0, 0, 1, createRng(1));
    const { hits } = advance(world, pool, 60);
    assert.equal(hits, 0);
  });

  test('ticking an empty pool is a safe no-op', () => {
    const { world } = createWorldWithPlayer();
    const pool = createSummonPool();
    const result = tickWeaponSummons(world, pool);
    assert.equal(result.hitCount, 0);
    assert.equal(result.expiredCount, 0);
  });

  test('simulation is deterministic for a given seed', () => {
    function run(): number {
      const { world } = createWorldWithPlayer();
      const enemy = addEnemy(world, 120, 0);
      const pool = createSummonPool();
      castWeaponSummons(pool, WEAPONS['apiaryLexicon'], 0, 0, 1, createRng(808));
      advance(world, pool, 120);
      return enemy.healthPoints;
    }
    assert.equal(run(), run());
  });
});

describe('integration through the player weapon', () => {
  test('summoner weapons are now equippable', () => {
    const state = createPlayerWeaponState();
    for (const id of ['apiaryLexicon', 'quillAviary', 'silkboundLexicon', 'soulbinderPrimer']) {
      assert.equal(equipPlayerWeapon(state, id), true, `${id} should equip`);
    }
  });

  test('every donor weapon kind now reports a runtime', () => {
    assert.equal(isWeaponRuntimeImplemented(WEAPONS['apiaryLexicon']), true);
    assert.equal(isWeaponRuntimeImplemented(WEAPONS['soulbinderPrimer']), true);
  });

  test('attacking with a summoner calls familiars', () => {
    const { world, player } = createWorldWithPlayer();
    equipPlayerWeapon(world.playerWeapon, 'apiaryLexicon');
    assert.equal(tryStartPlayerWeaponAttack(world, player, 100, 0, world.rng), true);
    assert.ok(world.playerWeapon.summons.liveCount > 0);
  });

  test('a summoner respects its cooldown', () => {
    const { world, player } = createWorldWithPlayer();
    equipPlayerWeapon(world.playerWeapon, 'apiaryLexicon');
    assert.equal(tryStartPlayerWeaponAttack(world, player, 100, 0, world.rng), true);
    assert.equal(tryStartPlayerWeaponAttack(world, player, 100, 0, world.rng), false);
  });

  test('summoned familiars damage enemies through the tick pipeline', () => {
    const { world, player } = createWorldWithPlayer();
    equipPlayerWeapon(world.playerWeapon, 'apiaryLexicon');
    const enemy = addEnemy(world, 120, 0);

    tryStartPlayerWeaponAttack(world, player, 100, 0, world.rng);
    for (let i = 0; i < 120; i++) tickPlayerWeapon(world, player, world.rng);

    assert.ok(enemy.healthPoints < 1000, 'familiars should have damaged the enemy');
  });

  test('familiars survive a weapon swap', () => {
    const { world, player } = createWorldWithPlayer();
    equipPlayerWeapon(world.playerWeapon, 'apiaryLexicon');
    tryStartPlayerWeaponAttack(world, player, 100, 0, world.rng);
    const before = world.playerWeapon.summons.liveCount;

    equipPlayerWeapon(world.playerWeapon, 'sword');
    tickPlayerWeapon(world, player, world.rng);

    assert.equal(world.playerWeapon.summons.liveCount, before);
  });
});
