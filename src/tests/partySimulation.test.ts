import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createWorldState } from '../sim/world';
import { createClusterState } from '../sim/clusters/state';
import {
  createDefaultParty,
  recruitMember,
  equipToSubslot,
} from '../sim/party/partyState';
import {
  getLeaderCluster,
  getFollowerClusters,
  getAllPartyMemberClusters,
  spawnFollowerClusters,
  computeAllFollowerIntents,
  resolvePartyDamageTarget,
} from '../sim/party/partyWorld';
import { applyClusterMovement } from '../sim/clusters/movement';
import {
  capturePlayerTransferState,
  detachPlayerFromResidentWorld,
} from '../screens/playerTransfer';
import {
  createDefaultProgress,
  sanitizePlayerPartyState,
} from '../progression/playerProgress';

describe('party cluster lookup helpers', () => {
  test('getLeaderCluster returns undefined on an empty world', () => {
    const world = createWorldState(16.666);
    assert.equal(getLeaderCluster(world), undefined);
  });

  test('getLeaderCluster returns the player cluster at clusters[0]', () => {
    const world = createWorldState(16.666);
    const player = createClusterState(1, 100, 200, 1, 50);
    world.clusters.push(player);
    assert.equal(getLeaderCluster(world), player);
  });

  test('getFollowerClusters returns all follower clusters', () => {
    const world = createWorldState(16.666);
    const leader = createClusterState(1, 100, 200, 1, 50);
    const follower1 = createClusterState(2, 80, 200, 1, 50);
    follower1.isPartyFollowerFlag = 1;
    follower1.partyMemberIndex = 1;

    const follower2 = createClusterState(3, 60, 200, 1, 50);
    follower2.isPartyFollowerFlag = 1;
    follower2.partyMemberIndex = 2;

    const enemy = createClusterState(4, 300, 200, 0, 30);

    world.clusters.push(leader, follower1, follower2, enemy);

    const followers = getFollowerClusters(world);
    assert.equal(followers.length, 2);
    assert.equal(followers[0], follower1);
    assert.equal(followers[1], follower2);

    const allMembers = getAllPartyMemberClusters(world);
    assert.equal(allMembers.length, 3);
    assert.equal(allMembers[0], leader);
    assert.equal(allMembers[1], follower1);
    assert.equal(allMembers[2], follower2);
  });
});

describe('spawnFollowerClusters', () => {
  test('spawns 0 followers when only the leader is recruited', () => {
    const world = createWorldState(16.666);
    const leader = createClusterState(1, 100, 200, 1, 50);
    world.clusters.push(leader);

    const party = createDefaultParty();
    const count = spawnFollowerClusters(world, party, 100, 200, 2);
    assert.equal(count, 0);
    assert.equal(world.clusters.length, 1);
  });

  test('spawns follower clusters for recruited party members', () => {
    const world = createWorldState(16.666);
    const leader = createClusterState(1, 100, 200, 1, 50);
    world.clusters.push(leader);

    const party = createDefaultParty();
    recruitMember(party, 1);
    recruitMember(party, 2);

    const count = spawnFollowerClusters(world, party, 100, 200, 2);
    assert.equal(count, 2);
    assert.equal(world.clusters.length, 3);

    const followers = getFollowerClusters(world);
    assert.equal(followers.length, 2);
    assert.equal(followers[0].isPlayerFlag, 1);
    assert.equal(followers[0].isPartyFollowerFlag, 1);
    assert.equal(followers[0].partyMemberIndex, 1);
    assert.equal(followers[0].countsTowardRoomCompletionFlag, 0);

    assert.equal(followers[1].isPlayerFlag, 1);
    assert.equal(followers[1].isPartyFollowerFlag, 1);
    assert.equal(followers[1].partyMemberIndex, 2);
  });
});

describe('computeAllFollowerIntents and simulation movement', () => {
  test('follower computes intent to move toward leader when behind', () => {
    const world = createWorldState(16.666);
    world.worldWidthWorld = 2000;
    world.worldHeightWorld = 1000;

    const leader = createClusterState(1, 300, 200, 1, 50);
    leader.isGroundedFlag = 1;

    const follower = createClusterState(2, 100, 200, 1, 50);
    follower.isPartyFollowerFlag = 1;
    follower.partyMemberIndex = 1;
    follower.isGroundedFlag = 1;

    world.clusters.push(leader, follower);

    computeAllFollowerIntents(world);
    assert.equal(follower.followerMoveDx, 1); // wants to move right toward leader
  });

  test('follower teleports if extremely far from leader', () => {
    const world = createWorldState(16.666);
    world.worldWidthWorld = 2000;
    world.worldHeightWorld = 1000;

    const leader = createClusterState(1, 1500, 200, 1, 50);
    leader.isGroundedFlag = 1;

    const follower = createClusterState(2, 100, 200, 1, 50);
    follower.isPartyFollowerFlag = 1;
    follower.partyMemberIndex = 1;
    follower.isGroundedFlag = 1;

    world.clusters.push(leader, follower);

    computeAllFollowerIntents(world);
    assert.equal(follower.followerShouldTeleport, 1);
    // Follower should be brought close to the leader
    assert(Math.abs(follower.positionXWorld - leader.positionXWorld) <= 50);
  });

  test('applyClusterMovement moves follower toward leader while preserving leader input', () => {
    const world = createWorldState(16.666);
    world.worldWidthWorld = 2000;
    world.worldHeightWorld = 1000;

    const leader = createClusterState(1, 300, 200, 1, 50);
    leader.isGroundedFlag = 1;

    const follower = createClusterState(2, 100, 200, 1, 50);
    follower.isPartyFollowerFlag = 1;
    follower.partyMemberIndex = 1;
    follower.isGroundedFlag = 1;

    world.clusters.push(leader, follower);

    // Leader has no input (standing still)
    world.playerMoveInputDxWorld = 0;

    const initialFollowerX = follower.positionXWorld;
    applyClusterMovement(world);

    // Leader should still have 0 input restored
    assert.equal(world.playerMoveInputDxWorld, 0);

    // Follower should have gained positive velocity toward leader
    assert(follower.velocityXWorld > 0);
    assert(follower.positionXWorld > initialFollowerX);
  });
});

describe('damage redirection in partyWorld', () => {
  test('resolvePartyDamageTarget returns target if no party or no redirect weapon', () => {
    const world = createWorldState(16.666);
    const leader = createClusterState(1, 100, 200, 1, 50);
    world.clusters.push(leader);
    world.party = createDefaultParty();

    const resolved = resolvePartyDamageTarget(world, leader);
    assert.equal(resolved, leader);
  });

  test('resolvePartyDamageTarget redirects to member with templarianWallShield', () => {
    const world = createWorldState(16.666);
    const leader = createClusterState(1, 100, 200, 1, 50);
    const defender = createClusterState(2, 80, 200, 1, 100);
    defender.isPartyFollowerFlag = 1;
    defender.partyMemberIndex = 1;

    world.clusters.push(leader, defender);

    const party = createDefaultParty();
    recruitMember(party, 1);
    const equipped = equipToSubslot(party.members[1].equipment, 'mainHand', 'templarianWallShield');
    assert.equal(equipped, true);
    world.party = party;

    const resolved = resolvePartyDamageTarget(world, leader);
    assert.equal(resolved, defender);
  });
});

describe('player transfer and detachment with party', () => {
  test('capturePlayerTransferState snapshots the leader cluster', () => {
    const world = createWorldState(16.666);
    const leader = createClusterState(1, 100, 200, 1, 50);
    leader.healthPoints = 42;
    leader.isFacingLeftFlag = 1;

    const follower = createClusterState(2, 80, 200, 1, 50);
    follower.isPartyFollowerFlag = 1;
    follower.partyMemberIndex = 1;

    world.clusters.push(leader, follower);

    const snapshot = capturePlayerTransferState(world);
    assert(snapshot !== null);
    assert.equal(snapshot.healthPoints, 42);
    assert.equal(snapshot.isFacingLeftFlag, 1);
    assert.equal(snapshot.ownedEntityId, 1);
  });

  test('detachPlayerFromResidentWorld removes both leader and follower clusters', () => {
    const world = createWorldState(16.666);
    const leader = createClusterState(1, 100, 200, 1, 50);
    const follower = createClusterState(2, 80, 200, 1, 50);
    follower.isPartyFollowerFlag = 1;
    follower.partyMemberIndex = 1;

    const enemy = createClusterState(3, 500, 200, 0, 30);
    world.clusters.push(leader, follower, enemy);

    detachPlayerFromResidentWorld(world);

    assert.equal(world.clusters.length, 1);
    assert.equal(world.clusters[0], enemy);
  });
});

describe('progression party sanitization', () => {
  test('sanitizePlayerPartyState backfills party and syncs characterStats with leader', () => {
    const progress = createDefaultProgress();
    delete (progress as Record<string, unknown>).party;
    progress.characterStats = {
      level: 5,
      xp: 120,
      xpToNextLevel: 300,
      attackBase: 4,
      defenseBase: 3,
      maxHealthBase: 98,
      skillPoints: 2,
      skillAllocations: { health: 1, attack: 1, defense: 0 },
    };

    sanitizePlayerPartyState(progress);

    assert(progress.party !== undefined);
    assert.equal(progress.party.members.length, 3);
    assert.equal(progress.party.members[0].stats.level, 5);
    assert.equal(progress.party.members[0].stats.attackBase, 4);
    assert.equal(progress.party.members[0].stats.skillAllocations.health, 1);
  });
});
