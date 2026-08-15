import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  STICK_RPG_ENEMY_KINDS,
  STICK_RPG_ENEMY_TRAITS,
  getStickRpgEnemyTrait,
  isStickRpgEnemyKind,
  computeEnemyXpDrop,
  computeEnemyCoinDrop,
} from '../sim/clusters/stickRpgEnemyTraits';
import { createWorldState } from '../sim/world';
import { createRng } from '../sim/rng';
import { spawnEnemyClusters } from '../screens/gameEnemySpawn';
import type { RoomEnemyDef } from '../levels/roomDef';
import { ParticleKind } from '../sim/particles/kinds';
import { applyRoutedWeaveDamage } from '../sim/weaves/weaveCollisionUtils';
import { createDefaultParty, recruitMember } from '../sim/party/partyState';
import { placeEnemyAtCursor } from '../editor/editorEnemyPlacer';
import { createEditorState } from '../editor/editorState';
import type { EditorRoomData } from '../editor/editorElementTypes';
import { PALETTE_ITEMS } from '../editor/editorPaletteItems';
import { editorRoomDataToJson } from '../editor/roomJsonSerializer';
import { jsonToEditorRoomData } from '../editor/roomJson';
import { buildElementTypeName } from '../editor/editorElementLabels';
import { dehydrateRoom } from '../levels/roomSchemaV2';
import { hydrateV2Room } from '../levels/roomSchemaHydrator';

function makeTestRoom(): EditorRoomData {
  return {
    id: 'test_room',
    name: 'Test Room',
    worldNumber: 1,
    mapX: 0,
    mapY: 0,
    blockTheme: 'blackRock',
    backgroundId: 'cave',
    lightingEffect: 'DEFAULT',
    songId: '_continue',
    widthBlocks: 20,
    heightBlocks: 20,
    playerSpawnBlock: [2, 2],
    interiorWalls: [],
    enemies: [],
    transitions: [],
    saveTombs: [],
    skillTombs: [],
    dustContainers: [],
    dustContainerPieces: [],
    dustBoostJars: [],
    dustSwarms: [],
    lambdaAnchors: [],
    dustPiles: [],
    grasshopperAreas: [],
    fireflyAreas: [],
    decorations: [],
    ambientLightBlockers: [],
    lightSources: [],
    backgroundBlocks: [],
  } as unknown as EditorRoomData;
}

describe('STICK-RPG enemy traits catalog', () => {
  test('contains all canonical and stickman enemy kinds', () => {
    assert.equal(STICK_RPG_ENEMY_KINDS.length, 18);
    for (const kind of STICK_RPG_ENEMY_KINDS) {
      assert(isStickRpgEnemyKind(kind));
      const trait = getStickRpgEnemyTrait(kind);
      assert(trait !== null);
      assert.equal(trait.id, kind);
      assert(trait.hitboxWidth > 0);
      assert(trait.hitboxHeight > 0);
      assert(trait.baseHp > 0);
      assert(trait.baseAttack > 0);
      assert(trait.baseXp > 0);
    }
  });

  test('returns null for unknown enemy kinds', () => {
    assert.equal(getStickRpgEnemyTrait(null), null);
    assert.equal(getStickRpgEnemyTrait(undefined), null);
    assert.equal(getStickRpgEnemyTrait('notAnEnemy'), null);
    assert.equal(isStickRpgEnemyKind('unknownEnemy'), false);
  });

  test('scaling formulas produce positive scaled drops', () => {
    const roller = STICK_RPG_ENEMY_TRAITS.baldRoller;
    const l1Xp = computeEnemyXpDrop(roller, 1);
    const l5Xp = computeEnemyXpDrop(roller, 5);
    assert.equal(l1Xp, roller.baseXp);
    assert(l5Xp > l1Xp);

    const l1Coins = computeEnemyCoinDrop(roller, 1);
    const l5Coins = computeEnemyCoinDrop(roller, 5);
    assert.equal(l1Coins, roller.baseCoins);
    assert(l5Coins > l1Coins);
  });
});

describe('enemy cluster spawning from traits', () => {
  test('spawnEnemyClusters populates cluster from stickRpgEnemyKind', () => {
    const world = createWorldState(16.666);
    const rng = createRng(12345);

    const enemyDefs: RoomEnemyDef[] = [
      {
        xBlock: 10,
        yBlock: 20,
        kinds: [ParticleKind.Golden],
        particleCount: 10,
        isBossFlag: 0,
        stickRpgEnemyKind: 'baldRoller',
      },
      {
        xBlock: 30,
        yBlock: 40,
        kinds: [ParticleKind.Void],
        particleCount: 20,
        isBossFlag: 0,
        stickRpgEnemyKind: 'slimeCube',
      },
      {
        xBlock: 50,
        yBlock: 60,
        kinds: [ParticleKind.Light],
        particleCount: 50,
        isBossFlag: 1,
        stickRpgEnemyKind: 'realmGuardian',
      },
    ];

    const nextId = spawnEnemyClusters(world, enemyDefs, 2, rng);
    assert.equal(nextId, 5);
    assert.equal(world.clusters.length, 3);

    // Bald Roller
    const roller = world.clusters[0];
    assert.equal(roller.stickRpgEnemyKind, 'baldRoller');
    assert.equal(roller.healthPoints, 30);
    assert.equal(roller.isRollingEnemyFlag, 1);
    assert.equal(roller.xpValue, 15);

    // Slime Cube
    const slime = world.clusters[1];
    assert.equal(slime.stickRpgEnemyKind, 'slimeCube');
    assert.equal(slime.healthPoints, 25);
    assert.equal(slime.isSlimeFlag, 1);
    assert.equal(slime.xpValue, 12);

    // Realm Guardian (Boss)
    const boss = world.clusters[2];
    assert.equal(boss.stickRpgEnemyKind, 'realmGuardian');
    assert.equal(boss.isFlyingEyeFlag, 1);
    assert.equal(boss.xpValue, 300);
  });
});

describe('combat XP granting on defeat', () => {
  test('applyRoutedWeaveDamage awards XP to active party member on enemy defeat', () => {
    const world = createWorldState(16.666);
    const party = createDefaultParty();
    recruitMember(party, 1);
    party.activeIndex = 1;
    world.party = party;

    const rng = createRng(42);
    const enemyDefs: RoomEnemyDef[] = [
      {
        xBlock: 10,
        yBlock: 10,
        kinds: [ParticleKind.Golden],
        particleCount: 10,
        isBossFlag: 0,
        stickRpgEnemyKind: 'baldRoller',
      },
    ];

    spawnEnemyClusters(world, enemyDefs, 2, rng);
    const enemy = world.clusters[0];
    assert.equal(enemy.healthPoints, 30);
    assert.equal(enemy.isAliveFlag, 1);

    const memberStats = party.members[1].stats;
    const initialXp = memberStats.xp;

    // Apply lethal damage
    applyRoutedWeaveDamage(world, 0, 35, enemy.positionXWorld, enemy.positionYWorld);

    assert.equal(enemy.healthPoints, 0);
    assert.equal(enemy.isAliveFlag, 0);
    assert.equal(memberStats.xp, initialXp + 15);
  });
});

describe('editor palette enemy placement', () => {
  test('placeEnemyAtCursor places STICK-RPG enemies with stickRpgEnemyKind', () => {
    const state = createEditorState();
    const room = makeTestRoom();
    state.roomData = room;

    const item = PALETTE_ITEMS.find(p => p.id === 'enemy_bald_roller');
    assert(item !== undefined);

    const handled = placeEnemyAtCursor(state, room, item, 5, 8);
    assert.equal(handled, true);
    assert.equal(room.enemies.length, 1);
    const enemy = room.enemies[0];
    assert.equal(enemy.stickRpgEnemyKind, 'baldRoller');
    assert.equal(enemy.xBlock, 5);
    assert.equal(enemy.yBlock, 8);
  });

  test('places all stickman enemies (swordsman, archer, mage) with proper traits and labels', () => {
    const state = createEditorState();
    const room = makeTestRoom();
    state.roomData = room;

    const swordsmanItem = PALETTE_ITEMS.find(p => p.id === 'enemy_stickman_swordsman')!;
    const archerItem = PALETTE_ITEMS.find(p => p.id === 'enemy_stickman_archer')!;
    const mageItem = PALETTE_ITEMS.find(p => p.id === 'enemy_stickman_mage')!;

    assert.ok(swordsmanItem, 'Stickman Swordsman item should exist in palette');
    assert.ok(archerItem, 'Stickman Archer item should exist in palette');
    assert.ok(mageItem, 'Stickman Mage item should exist in palette');

    assert.equal(placeEnemyAtCursor(state, room, swordsmanItem, 4, 10), true);
    assert.equal(placeEnemyAtCursor(state, room, archerItem, 8, 10), true);
    assert.equal(placeEnemyAtCursor(state, room, mageItem, 12, 10), true);

    assert.equal(room.enemies.length, 3);
    assert.equal(room.enemies[0].stickRpgEnemyKind, 'stickmanSwordsman');
    assert.equal(room.enemies[1].stickRpgEnemyKind, 'stickmanArcher');
    assert.equal(room.enemies[2].stickRpgEnemyKind, 'stickmanMage');

    // Test label resolution
    assert.equal(buildElementTypeName('enemy', room.enemies[0].uid, room), 'Stickman Swordsman');
    assert.equal(buildElementTypeName('enemy', room.enemies[1].uid, room), 'Stickman Archer');
    assert.equal(buildElementTypeName('enemy', room.enemies[2].uid, room), 'Stickman Mage');
  });

  test('stickman enemies round-trip through editor JSON and compact schema v2/v3 without losing kind', () => {
    const state = createEditorState();
    const room = makeTestRoom();
    state.roomData = room;

    placeEnemyAtCursor(state, room, PALETTE_ITEMS.find(p => p.id === 'enemy_stickman_swordsman')!, 2, 5);
    placeEnemyAtCursor(state, room, PALETTE_ITEMS.find(p => p.id === 'enemy_stickman_archer')!, 6, 5);
    placeEnemyAtCursor(state, room, PALETTE_ITEMS.find(p => p.id === 'enemy_stickman_mage')!, 10, 5);

    // 1. EditorRoomData -> RoomJsonDef
    const json = editorRoomDataToJson(room);
    assert.equal(json.enemies.length, 3);
    assert.equal(json.enemies[0].stickRpgEnemyKind, 'stickmanSwordsman');
    assert.equal(json.enemies[1].stickRpgEnemyKind, 'stickmanArcher');
    assert.equal(json.enemies[2].stickRpgEnemyKind, 'stickmanMage');

    // 2. RoomJsonDef -> EditorRoomData
    const importedRoom = jsonToEditorRoomData(json, 1).data;
    assert.equal(importedRoom.enemies.length, 3);
    assert.equal(importedRoom.enemies[0].stickRpgEnemyKind, 'stickmanSwordsman');
    assert.equal(importedRoom.enemies[1].stickRpgEnemyKind, 'stickmanArcher');
    assert.equal(importedRoom.enemies[2].stickRpgEnemyKind, 'stickmanMage');

    // 3. RoomJsonDef -> SavedRoomV2 -> RoomJsonDef (compact schema round-trip)
    const saved = dehydrateRoom(json);
    assert.ok(saved.enemies);
    assert.equal(saved.enemies.length, 3);
    assert.equal(saved.enemies[0].stickRpgEnemyKind, 'stickmanSwordsman');
    assert.equal(saved.enemies[1].stickRpgEnemyKind, 'stickmanArcher');
    assert.equal(saved.enemies[2].stickRpgEnemyKind, 'stickmanMage');

    const rehydratedJson = hydrateV2Room(saved);
    assert.equal(rehydratedJson.enemies.length, 3);
    assert.equal(rehydratedJson.enemies[0].stickRpgEnemyKind, 'stickmanSwordsman');
    assert.equal(rehydratedJson.enemies[1].stickRpgEnemyKind, 'stickmanArcher');
    assert.equal(rehydratedJson.enemies[2].stickRpgEnemyKind, 'stickmanMage');
  });
});
