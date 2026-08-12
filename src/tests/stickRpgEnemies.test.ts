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
});
