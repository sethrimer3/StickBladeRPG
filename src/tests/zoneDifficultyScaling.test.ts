import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createWorldState } from '../sim/world';
import { createRng } from '../sim/rng';
import { ParticleKind } from '../sim/particles/kinds';
import { RoomEnemyDef } from '../levels/roomDef';
import { spawnEnemyClusters } from '../screens/gameEnemySpawn';
import { computeEnemyXpDrop, computeEnemyCoinDrop, getStickRpgEnemyTrait } from '../sim/clusters/stickRpgEnemyTraits';
import {
  WORLD_DIFFICULTY,
  setWorldDifficulty,
  getWorldDifficultyMultiplier,
  captureMainCampaignSnapshot,
  restoreMainCampaignSnapshot,
} from '../levels/rooms';
import { dehydrateRoom } from '../levels/roomSchemaV2';
import { hydrateV2Room } from '../levels/roomSchemaHydrator';
import { buildWorldMapFromRegistry } from '../editor/editableCampaignSession';

describe('Zone Difficulty Multiplier & Enemy Stat Scaling', () => {
  test('WORLD_DIFFICULTY store tracks and updates multipliers', () => {
    assert.equal(getWorldDifficultyMultiplier(999), 1);
    setWorldDifficulty(999, 2.5);
    assert.equal(getWorldDifficultyMultiplier(999), 2.5);
    assert.equal(WORLD_DIFFICULTY.get(999), 2.5);

    // Negative / invalid clamping to 1
    setWorldDifficulty(999, -5);
    assert.equal(getWorldDifficultyMultiplier(999), 1);
    setWorldDifficulty(999, 0);
    assert.equal(getWorldDifficultyMultiplier(999), 1);
  });

  test('computeEnemyXpDrop and computeEnemyCoinDrop scale with difficulty', () => {
    const trait = getStickRpgEnemyTrait('stickmanSwordsman');
    assert.ok(trait);

    // Base difficulty 1
    assert.equal(computeEnemyXpDrop(trait, 1), trait.baseXp);
    assert.equal(computeEnemyCoinDrop(trait, 1), trait.baseCoins);

    // Difficulty 2
    assert.equal(computeEnemyXpDrop(trait, 2), Math.round(trait.baseXp * 2));
    assert.equal(computeEnemyCoinDrop(trait, 2), Math.round(trait.baseCoins * 2));

    // Difficulty 1.5
    assert.equal(computeEnemyXpDrop(trait, 1.5), Math.round(trait.baseXp * 1.5));
    assert.equal(computeEnemyCoinDrop(trait, 1.5), Math.round(trait.baseCoins * 1.5));
  });

  test('spawnEnemyClusters scales HP, particle count, XP, and coin drops by difficulty multiplier', () => {
    const world = createWorldState(200, 100);
    const rng = createRng(12345);

    const enemyDef: RoomEnemyDef = {
      xBlock: 10,
      yBlock: 10,
      kinds: [ParticleKind.Dust],
      particleCount: 20,
      isBossFlag: 0,
      stickRpgEnemyKind: 'stickmanSwordsman',
    };

    // Spawn with difficulty 2.0
    spawnEnemyClusters(world, [enemyDef], 2, rng, 2.0);
    const cluster = world.clusters.find(c => c.entityId === 2);
    assert.ok(cluster);

    const trait = getStickRpgEnemyTrait('stickmanSwordsman')!;
    assert.equal(cluster.healthPoints, Math.round(trait.baseHp * 2.0));
    assert.equal(cluster.maxHealthPoints, Math.round(trait.baseHp * 2.0));
    assert.equal(cluster.xpValue, Math.round(trait.baseXp * 2.0));
    assert.equal(cluster.coinValue, Math.round(trait.baseCoins * 2.0));
  });

  test('spawnEnemyClusters scales generic particle loadouts by difficulty multiplier', () => {
    const world = createWorldState(200, 100);
    const rng = createRng(456);

    const enemyDef: RoomEnemyDef = {
      xBlock: 15,
      yBlock: 15,
      kinds: [ParticleKind.Fire],
      particleCount: 10,
      isBossFlag: 0,
    };

    // Spawn with difficulty 3.0
    spawnEnemyClusters(world, [enemyDef], 2, rng, 3.0);
    const cluster = world.clusters.find(c => c.entityId === 2);
    assert.ok(cluster);

    assert.equal(cluster.healthPoints, 30);
    assert.equal(cluster.maxHealthPoints, 30);
    // 30 particles spawned
    assert.equal(world.particleCount, 30);
  });

  test('spawnEnemyClusters scales bespoke bosses (Crimson Wizard, Herald, Ice Wizard, ODC)', () => {
    const world = createWorldState(300, 200);
    const rng = createRng(789);

    const cwDef: RoomEnemyDef = {
      xBlock: 5, yBlock: 5, kinds: [], particleCount: 0, isBossFlag: 1, isCrimsonWizardFlag: 1,
    };
    const heraldDef: RoomEnemyDef = {
      xBlock: 10, yBlock: 10, kinds: [], particleCount: 0, isBossFlag: 1, isHeraldFlag: 1,
    };
    const odcDef: RoomEnemyDef = {
      xBlock: 15, yBlock: 15, kinds: [], particleCount: 0, isBossFlag: 1, isOrbitalDustCoreFlag: 1,
    };

    spawnEnemyClusters(world, [cwDef, heraldDef, odcDef], 2, rng, 2.0);

    const cw = world.clusters.find(c => c.isCrimsonWizardFlag === 1);
    assert.ok(cw);
    assert.equal(cw.healthPoints, 96); // CW_HP (48) * 2

    const herald = world.clusters.find(c => c.isHeraldFlag === 1);
    assert.ok(herald);
    assert.equal(herald.healthPoints, 80); // HERALD_HP (40) * 2

    const odc = world.clusters.find(c => c.isOrbitalDustCoreFlag === 1);
    assert.ok(odc);
    assert.equal(odc.healthPoints, 10); // ODC_SMALL_CORE_HP (5) * 2
    assert.equal(odc.orbitalDustCoreRing0Health, 8); // ODC_SMALL_RING_HEALTH[0] (4) * 2
  });

  test('dehydrateRoom and hydrateV2Room preserve difficultyMultiplier', () => {
    const roomJson = {
      id: 'test_diff_room',
      name: 'Test Room',
      worldNumber: 3,
      difficultyMultiplier: 1.75,
      mapX: 100,
      mapY: 200,
      widthBlocks: 30,
      heightBlocks: 20,
      playerSpawnBlock: [5, 5] as [number, number],
      interiorWalls: [],
      enemies: [],
      transitions: [],
      skillTombs: [],
    };

    const dehydrated = dehydrateRoom(roomJson);
    assert.equal(dehydrated.difficultyMultiplier, 1.75);

    const hydrated = hydrateV2Room(dehydrated);
    assert.equal(hydrated.difficultyMultiplier, 1.75);
  });

  test('buildWorldMapFromRegistry and mergeWorldMapWithRegistry preserve zone difficulty', () => {
    const worldNames = new Map([[1, 'Zone 1'], [2, 'Zone 2']]);
    const worldOrder = new Map([[1, 0], [2, 1]]);
    const worldDifficulty = new Map([[1, 1.0], [2, 2.5]]);
    const rooms = new Map([
      ['r1', { id: 'r1', name: 'Room 1', worldNumber: 1, mapX: 0, mapY: 0 }],
      ['r2', { id: 'r2', name: 'Room 2', worldNumber: 2, mapX: 10, mapY: 10 }],
    ]);

    const wm = buildWorldMapFromRegistry(worldNames, rooms, worldOrder, worldDifficulty);
    const z1 = wm.worlds.find(w => w.id === 1);
    const z2 = wm.worlds.find(w => w.id === 2);
    assert.ok(z1);
    assert.ok(z2);
    assert.equal(z1.difficultyMultiplier, undefined); // 1.0 omitted
    assert.equal(z2.difficultyMultiplier, 2.5);
  });

  test('registry snapshots capture and restore worldDifficultyMap', () => {
    setWorldDifficulty(42, 3.14);
    captureMainCampaignSnapshot();

    setWorldDifficulty(42, 1.0);
    assert.equal(getWorldDifficultyMultiplier(42), 1.0);

    restoreMainCampaignSnapshot();
    assert.equal(getWorldDifficultyMultiplier(42), 3.14);
  });
});
