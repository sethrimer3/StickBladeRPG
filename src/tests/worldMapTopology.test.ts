import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  WORLD_MAP_NODES,
  WORLD_TREE_HUB_NODE,
  computeWorldMapLinks,
  isWorldMapNodeUnlocked,
  findWorldMapNode,
} from '../levels/worldMapTopology';
import {
  computeLevelDifficultyMultiplier,
  LevelDef,
} from '../levels/levelDef';
import { createLevelFromWorldMapNode } from '../ui/worldMap';

describe('world map topology data', () => {
  test('contains central World Tree hub and all 40 mainline stages', () => {
    assert.equal(WORLD_MAP_NODES.length, 40);
    assert.equal(WORLD_TREE_HUB_NODE.id, 'worldTree');
    assert.equal(WORLD_TREE_HUB_NODE.x, 0.5);
    assert.equal(WORLD_TREE_HUB_NODE.y, 0.5);

    // Verify 8 worlds with 5 stages each
    for (let w = 1; w <= 8; w++) {
      const worldStages = WORLD_MAP_NODES.filter(n => n.worldNumber === w);
      assert.equal(worldStages.length, 5);

      // Verify stage numbers 1..5 in order
      for (let s = 1; s <= 5; s++) {
        const stage = worldStages.find(n => n.stageNumber === s);
        assert(stage !== undefined, `World ${w} stage ${s} missing`);
        assert.equal(stage.stageCode, `${w}-${s}`);
        assert(stage.x >= 0 && stage.x <= 1);
        assert(stage.y >= 0 && stage.y <= 1);

        if (s === 5) {
          assert.equal(stage.isBoss, true);
          assert(stage.bossName !== undefined && stage.bossName.length > 0);
          assert((stage.bossHp ?? 0) > 0);
        }
      }
    }
  });

  test('findWorldMapNode finds nodes by id or stage code', () => {
    const hub = findWorldMapNode('worldTree');
    assert.equal(hub?.id, 'worldTree');

    const hubByCode = findWorldMapNode('HUB');
    assert.equal(hubByCode?.id, 'worldTree');

    const stage11 = findWorldMapNode('world1Stage1');
    assert.equal(stage11?.stageCode, '1-1');

    const stage45 = findWorldMapNode('4-5');
    assert.equal(stage45?.id, 'world4Stage5');
    assert.equal(stage45?.isBoss, true);
  });

  test('computeWorldMapLinks creates links from hub and across branches', () => {
    const links = computeWorldMapLinks();
    assert(links.length >= 40);

    // Check all 8 branch step 1 links connect to worldTree
    for (let w = 1; w <= 8; w++) {
      const branchRoot = links.find(l => l.fromId === 'worldTree' && l.toId === `world${w}Stage1`);
      assert(branchRoot !== undefined, `Missing root link for world ${w}`);
    }

    // Check linear step-to-step links
    const link12 = links.find(l => l.fromId === 'world1Stage1' && l.toId === 'world1Stage2');
    assert(link12 !== undefined);
  });
});

describe('difficulty multiplier calculations', () => {
  test('matches canonical donor scaling rules', () => {
    // Stage 1-1 -> (1-1)*5 + 1 = 1
    assert.equal(computeLevelDifficultyMultiplier({ worldNumber: 1, levelNumber: 1 }), 1);

    // Stage 1-5 -> (1-1)*5 + 5 = 5
    assert.equal(computeLevelDifficultyMultiplier({ worldNumber: 1, levelNumber: 5 }), 5);

    // Stage 5-1 -> (5-1)*5 + 1 = 21
    assert.equal(computeLevelDifficultyMultiplier({ worldNumber: 5, levelNumber: 1 }), 21);

    // Stage 8-5 -> (8-1)*5 + 5 = 40
    assert.equal(computeLevelDifficultyMultiplier({ worldNumber: 8, levelNumber: 5 }), 40);

    // Special trials
    assert.equal(computeLevelDifficultyMultiplier({ id: 'canopySentinelTrial' }), 10);
    assert.equal(computeLevelDifficultyMultiplier({ name: 'Chronoglass Expanse' }), 50);

    // Map node overrides
    const node53 = findWorldMapNode('5-3');
    assert.equal(computeLevelDifficultyMultiplier({ mapNode: node53 }), 23);
  });
});

describe('world map unlock progression', () => {
  test('initial unlock state unlocks hub and all 8 branch start stages', () => {
    const completed = new Set<string>();

    assert.equal(isWorldMapNodeUnlocked(WORLD_TREE_HUB_NODE, completed), true);

    for (let w = 1; w <= 8; w++) {
      const s1 = findWorldMapNode(`world${w}Stage1`)!;
      const s2 = findWorldMapNode(`world${w}Stage2`)!;
      assert.equal(isWorldMapNodeUnlocked(s1, completed), true);
      assert.equal(isWorldMapNodeUnlocked(s2, completed), false);
    }
  });

  test('beating stage 1 unlocks stage 2 along the branch', () => {
    const completed = new Set<string>(['world1Stage1']);

    const s1 = findWorldMapNode('world1Stage1')!;
    const s2 = findWorldMapNode('world1Stage2')!;
    const s3 = findWorldMapNode('world1Stage3')!;

    assert.equal(isWorldMapNodeUnlocked(s1, completed), true);
    assert.equal(isWorldMapNodeUnlocked(s2, completed), true);
    assert.equal(isWorldMapNodeUnlocked(s3, completed), false);
  });
});

describe('level instantiation from map nodes', () => {
  test('createLevelFromWorldMapNode produces complete LevelDef', () => {
    const node = findWorldMapNode('3-5')!;
    const level: LevelDef = createLevelFromWorldMapNode(node);

    assert.equal(level.id, 'world3Stage5');
    assert.equal(level.worldNumber, 3);
    assert.equal(level.levelNumber, 5);
    assert.equal(level.theme, 'boss');
    assert.equal(level.enemies.length >= 1, true);
    assert.equal(level.enemies[0].isBossFlag, 1);
    assert.equal(level.boss?.name, 'Ignis Archon');
    assert.equal(level.difficultyMultiplier, 15);
    assert.equal(level.walls.length >= 4, true);
    assert.equal(level.entryDoor.target, 'next');
    assert.equal(level.exitDoor.target, 'menu');
  });
});
