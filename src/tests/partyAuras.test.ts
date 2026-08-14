/**
 * Staff auras reaching recruited party members, and the visual flashes left by
 * on-expiry effects — the two gaps the STICK-RPG port left open after Phase 2d.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  auraDefenseMultiplierToReduction,
  MAX_AURA_DAMAGE_REDUCTION,
  tickPartyAuras,
} from '../sim/party/partyAuras';
import { applyPlayerDamageWithKnockback } from '../sim/playerDamage';
import { createClusterState, type ClusterState } from '../sim/clusters/state';
import { createWorldState, type WorldState } from '../sim/world';
import {
  equipPlayerWeapon,
  tryStartPlayerWeaponAttack,
} from '../sim/weapons/playerWeaponState';
import {
  applyExpiryEffect,
  createExpiryFlashPool,
  EXPIRY_EFFECTS,
  EXPIRY_FLASH_TICKS,
  MAX_EXPIRY_FLASHES,
  resetExpiryFlashPool,
  spawnExpiryFlash,
  tickExpiryFlashes,
} from '../sim/weapons/weaponExpiryEffects';

const DT_MS = 1000 / 60;

/** A world with a leader and one follower, both party members. */
function createPartyWorld(followerXWorld: number): {
  world: WorldState;
  leader: ClusterState;
  follower: ClusterState;
} {
  const world = createWorldState(DT_MS, 12);
  const leader = createClusterState(1, 0, 0, 1, 100);
  leader.partyMemberIndex = 0;
  const follower = createClusterState(2, followerXWorld, 0, 1, 100);
  follower.partyMemberIndex = 1;
  follower.isPartyFollowerFlag = 1;
  world.clusters.push(leader, follower);
  return { world, leader, follower };
}

describe('aura defense conversion', () => {
  test('a multiplier at or below 1 grants no reduction', () => {
    assert.equal(auraDefenseMultiplierToReduction(1), 0);
    assert.equal(auraDefenseMultiplierToReduction(0.5), 0);
    assert.equal(auraDefenseMultiplierToReduction(Number.NaN), 0);
  });

  test('reduction rises with the multiplier and is capped', () => {
    // ×2 removes half the damage.
    assert.equal(auraDefenseMultiplierToReduction(2), 0.5);
    assert.ok(auraDefenseMultiplierToReduction(4) > auraDefenseMultiplierToReduction(2));
    assert.equal(auraDefenseMultiplierToReduction(1000), MAX_AURA_DAMAGE_REDUCTION);
  });
});

describe('auras reaching the party', () => {
  test('a channelled defense aura covers a follower inside its radius', () => {
    const { world, leader, follower } = createPartyWorld(60);

    assert.equal(equipPlayerWeapon(world.playerWeapon, 'bulwarkStaff'), true);
    assert.equal(tryStartPlayerWeaponAttack(world, leader, 100, 0, world.rng), true);
    tickPartyAuras(world, leader);

    assert.ok(follower.auraDamageReduction > 0, 'the follower was not covered');
    assert.ok(leader.auraDamageReduction > 0, 'the wielder was not covered');
  });

  test('a follower outside the radius is not covered', () => {
    const { world, leader, follower } = createPartyWorld(5000);

    equipPlayerWeapon(world.playerWeapon, 'bulwarkStaff');
    tryStartPlayerWeaponAttack(world, leader, 100, 0, world.rng);
    tickPartyAuras(world, leader);

    assert.ok(leader.auraDamageReduction > 0);
    assert.equal(follower.auraDamageReduction, 0);
  });

  test('coverage ends the tick the channel does', () => {
    const { world, leader, follower } = createPartyWorld(60);

    equipPlayerWeapon(world.playerWeapon, 'bulwarkStaff');
    tryStartPlayerWeaponAttack(world, leader, 100, 0, world.rng);
    tickPartyAuras(world, leader);
    assert.ok(follower.auraDamageReduction > 0);

    world.playerWeapon.staff.isChannellingFlag = 0;
    tickPartyAuras(world, leader);
    assert.equal(follower.auraDamageReduction, 0);
    assert.equal(leader.auraDamageReduction, 0);
  });

  test('a staff with no defense aura covers nobody', () => {
    const { world, leader, follower } = createPartyWorld(60);

    // emberStaff is a beam, not an aura.
    equipPlayerWeapon(world.playerWeapon, 'emberStaff');
    tryStartPlayerWeaponAttack(world, leader, 100, 0, world.rng);
    tickPartyAuras(world, leader);

    assert.equal(leader.auraDamageReduction, 0);
    assert.equal(follower.auraDamageReduction, 0);
  });

  test('a non-party player cluster is not treated as an ally', () => {
    const { world, leader } = createPartyWorld(60);
    const stray = createClusterState(3, 20, 0, 1, 100);
    stray.partyMemberIndex = -1;
    world.clusters.push(stray);

    equipPlayerWeapon(world.playerWeapon, 'bulwarkStaff');
    tryStartPlayerWeaponAttack(world, leader, 100, 0, world.rng);
    tickPartyAuras(world, leader);

    assert.equal(stray.auraDamageReduction, 0);
  });

  test('with no wielder, nothing is covered', () => {
    const { world, leader, follower } = createPartyWorld(60);
    equipPlayerWeapon(world.playerWeapon, 'bulwarkStaff');
    tryStartPlayerWeaponAttack(world, leader, 100, 0, world.rng);
    tickPartyAuras(world, null);
    assert.equal(follower.auraDamageReduction, 0);
  });
});

describe('aura reduction in the damage pipeline', () => {
  function createTarget(): ClusterState {
    const target = createClusterState(1, 0, 0, 1, 100);
    target.hitPoints = 20;
    return target;
  }

  test('a covered member takes less damage', () => {
    const covered = createTarget();
    covered.auraDamageReduction = 0.5;
    assert.equal(applyPlayerDamageWithKnockback(covered, 4, 500, 0), true);

    const bare = createTarget();
    assert.equal(applyPlayerDamageWithKnockback(bare, 4, 500, 0), true);

    assert.ok(
      covered.hitPoints > bare.hitPoints,
      `covered ${covered.hitPoints} vs bare ${bare.hitPoints}`,
    );
  });

  test('a target with no reduction is damaged exactly as before', () => {
    const target = createTarget();
    assert.equal(target.auraDamageReduction, 0);
    applyPlayerDamageWithKnockback(target, 3, 500, 0);
    assert.equal(target.hitPoints, 17);
  });
});

describe('expiry effect flashes', () => {
  test('an effect records a flash at the point it landed', () => {
    const world = createWorldState(DT_MS, 3);
    const enemy = createClusterState(2, 40, 0, 0, 100);
    world.clusters.push(enemy);

    applyExpiryEffect(world, EXPIRY_EFFECTS['seedVolley'], 25, 10, 1, world.rng);

    const pool = world.playerWeapon.expiryFlashes;
    assert.equal(pool.liveCount, 1);
    assert.equal(pool.xWorld[0], 25);
    assert.equal(pool.yWorld[0], 10);
    assert.equal(pool.radiusWorld[0], EXPIRY_EFFECTS['seedVolley'].radiusWorld);
    assert.equal(pool.color[0], EXPIRY_EFFECTS['seedVolley'].color);
  });

  test('flashes age out and free their slots', () => {
    const pool = createExpiryFlashPool();
    spawnExpiryFlash(pool, 0, 0, 100, '#fff');
    assert.equal(pool.liveCount, 1);

    for (let t = 0; t < EXPIRY_FLASH_TICKS; t++) tickExpiryFlashes(pool);
    assert.equal(pool.liveCount, 0);
  });

  test('more flashes than slots overwrite oldest-first and never overflow', () => {
    const pool = createExpiryFlashPool();
    for (let i = 0; i < MAX_EXPIRY_FLASHES * 3; i++) {
      spawnExpiryFlash(pool, i, 0, 50, '#fff');
    }
    assert.equal(pool.liveCount, MAX_EXPIRY_FLASHES);

    resetExpiryFlashPool(pool);
    assert.equal(pool.liveCount, 0);
  });
});
