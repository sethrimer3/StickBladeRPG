/**
 * The player's life pool, and its separation from dust motes.
 *
 * The bug these pin: health used to *be* the mote count, so every hit shortened
 * the weaves that size themselves from that same count.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createClusterState } from '../sim/clusters/state';
import { applyPlayerDamageWithKnockback, killPlayerImmediately } from '../sim/playerDamage';
import {
  PLAYER_STARTING_HIT_POINTS,
  HIT_POINTS_PER_DUST_CONTAINER,
  applyPlayerHealthOnSpawn,
  damagePlayerHitPoints,
  getPlayerMaxHitPointsForContainerCount,
  grantDustContainerHitPoints,
  grantTemporaryHitPoints,
  hasPlayerHealthPool,
  healPlayerHitPoints,
  resetPlayerHitPoints,
} from '../sim/playerHealth';

/** A player cluster with a mote capacity distinct from its life pool. */
function makePlayer(moteCapacity = 40) {
  return createClusterState(1, 0, 0, 1, moteCapacity);
}

describe('the player life pool', () => {
  test('a new player starts with 20 hit points', () => {
    const player = makePlayer();
    assert.equal(PLAYER_STARTING_HIT_POINTS, 20);
    assert.equal(player.hitPoints, 20);
    assert.equal(player.maxHitPoints, 20);
  });

  test('only the player carries a pool', () => {
    assert.equal(hasPlayerHealthPool(makePlayer()), true);
    assert.equal(hasPlayerHealthPool(createClusterState(2, 0, 0, 0, 30)), false);
  });

  test('healing clamps to the maximum and reports what it restored', () => {
    const player = makePlayer();
    damagePlayerHitPoints(player, 6);
    assert.equal(player.hitPoints, 14);
    assert.equal(healPlayerHitPoints(player, 100), 6);
    assert.equal(player.hitPoints, 20);
    assert.equal(healPlayerHitPoints(player, 5), 0, 'a full player gains nothing');
  });

  test('temporary points go above the maximum and are not replaced by healing', () => {
    const player = makePlayer();
    grantTemporaryHitPoints(player, 5);
    assert.equal(player.hitPoints, 25);
    damagePlayerHitPoints(player, 5);
    assert.equal(player.hitPoints, 20);
    assert.equal(healPlayerHitPoints(player, 10), 0, 'healing never restores temporary points');
    resetPlayerHitPoints(player);
    assert.equal(player.hitPoints, 20);
  });

  test('a Dust Container raises the maximum and fills the new points', () => {
    const player = makePlayer();
    damagePlayerHitPoints(player, 20);
    assert.equal(grantDustContainerHitPoints(player), HIT_POINTS_PER_DUST_CONTAINER);
    assert.equal(player.maxHitPoints, 24);
    assert.equal(player.hitPoints, HIT_POINTS_PER_DUST_CONTAINER, 'only the new points are filled');
    assert.equal(getPlayerMaxHitPointsForContainerCount(1), 24);
  });
});

describe('damage against the life pool', () => {
  test('a hit spends hit points and leaves the motes at capacity', () => {
    const player = makePlayer(40);
    assert.equal(applyPlayerDamageWithKnockback(player, 3, 500, 0), true);
    assert.equal(player.hitPoints, 17);
    assert.equal(player.healthPoints, 40, 'motes are untouched, so the weaves keep their length');
    assert.equal(player.isAliveFlag, 1);
  });

  test('reaching zero hit points kills', () => {
    const player = makePlayer();
    assert.equal(applyPlayerDamageWithKnockback(player, 20, 500, 0), true);
    assert.equal(player.hitPoints, 0);
    assert.equal(player.isAliveFlag, 0);
  });

  test('an immediate kill empties both pools', () => {
    const player = makePlayer(40);
    killPlayerImmediately(player);
    assert.equal(player.hitPoints, 0);
    assert.equal(player.healthPoints, 0);
    assert.equal(player.isAliveFlag, 0);
  });

  test('a target with no pool still spends motes, exactly as before', () => {
    const enemyLike = createClusterState(2, 0, 0, 0, 10);
    assert.equal(applyPlayerDamageWithKnockback(enemyLike, 3, 500, 0), true);
    assert.equal(enemyLike.healthPoints, 7);
  });
});

describe('spawning and room transitions', () => {
  test('a fresh spawn is at full health, sized by Dust Containers held', () => {
    const player = makePlayer();
    applyPlayerHealthOnSpawn(player, 2);
    assert.equal(player.maxHitPoints, 28);
    assert.equal(player.hitPoints, 28);
  });

  test('a carried value survives the transition — a door is not a free heal', () => {
    const player = makePlayer();
    applyPlayerHealthOnSpawn(player, 0, 7);
    assert.equal(player.hitPoints, 7);
    assert.equal(player.maxHitPoints, 20);
  });

  test('temporary points survive a transition too', () => {
    const player = makePlayer();
    applyPlayerHealthOnSpawn(player, 0, 26);
    assert.equal(player.hitPoints, 26);
  });
});
