import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorldState } from '../sim/world';
import { createClusterState } from '../sim/clusters/state';
import {
  createStickmanEnemyState,
  tickStickmanEnemy,
  getStickmanEnemyState,
} from '../sim/clusters/stickmanEnemy';
import { SR_HIP } from '../sim/clusters/stickRangerBody';

test('melee stickman enemy pursues player and attacks within melee range', () => {
  const world = createWorldState(16.666);
  const player = createClusterState(1, 100, 140, 1, 100);
  world.clusters.push(player);

  const enemy = createClusterState(2, 115, 140, 0, 50);
  world.clusters.push(enemy);
  const enemyState = createStickmanEnemyState(enemy, 'sword');

  assert.equal(enemyState.weaponDef.kind, 'melee');
  assert.equal(enemy.isStickmanEnemyFlag, 1);

  const initialPlayerHp = player.hitPoints;

  // Tick enemy within melee reach of player (15px away)
  for (let t = 0; t < 20; t++) {
    tickStickmanEnemy(enemy, world, 1 / 60, player.positionXWorld, player.positionYWorld, true);
  }

  assert.ok(player.hitPoints < initialPlayerHp, 'player should have taken damage from stickman melee attack');
  assert.ok(enemyState.attackCooldownTicks > 0, 'enemy attack cooldown should be triggered');
});

test('ranged stickman enemy keeps tactical spacing and spawns projectile towards player', () => {
  const world = createWorldState(16.666);
  const player = createClusterState(1, 200, 140, 1, 100);
  world.clusters.push(player);

  const enemy = createClusterState(2, 120, 140, 0, 40);
  world.clusters.push(enemy);
  const enemyState = createStickmanEnemyState(enemy, 'bow');

  assert.equal(enemyState.weaponDef.kind, 'bow');

  // Tick enemy at medium distance (80px away)
  for (let t = 0; t < 10; t++) {
    tickStickmanEnemy(enemy, world, 1 / 60, player.positionXWorld, player.positionYWorld, true);
  }

  // Check projectile pool
  assert.ok(world.playerWeapon !== null);
  let liveProjectiles = 0;
  for (let i = 0; i < world.playerWeapon.projectiles.isLive.length; i++) {
    if (world.playerWeapon.projectiles.isLive[i] === 1) {
      liveProjectiles++;
    }
  }
  assert.ok(liveProjectiles > 0, 'ranged enemy stickman should have fired an arrow projectile');
});

test('stickman softbody coordinates mirror to cluster box position', () => {
  const world = createWorldState(16.666);
  const enemy = createClusterState(2, 80, 140, 0, 40);
  world.clusters.push(enemy);
  const state = createStickmanEnemyState(enemy, 'sword');

  tickStickmanEnemy(enemy, world, 1 / 60, 150, 140, true);

  assert.equal(enemy.positionXWorld, state.body.x[SR_HIP]);
  assert.equal(enemy.positionYWorld, state.body.y[SR_HIP]);
  assert.equal(enemy.stickmanEnemyWeaponId, 'sword');
  assert.ok(getStickmanEnemyState(enemy) !== null);
});
