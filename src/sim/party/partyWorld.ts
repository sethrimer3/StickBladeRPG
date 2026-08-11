/**
 * Party-world integration helpers for Phase 3b.
 *
 * Pure lookup functions that find party-member clusters inside a WorldState
 * without coupling to room loading, transitions, or UI. Every function is
 * safe to call when the party is not yet spawned (returns null / empty).
 */

import type { WorldState } from '../world';
import type { ClusterState } from '../clusters/state';
import { createClusterState } from '../clusters/state';
import type { PartyState } from './partyState';
import { getActiveMember, getRecruitedMembers, findDamageRedirectMemberIndex } from './partyState';
import { computeFollowIntent, type FollowIntent, DEFAULT_FOLLOW_CONFIG } from './partyFollowAi';

// ── Cluster identification ───────────────────────────────────────────────────

/**
 * Find the leader (active, directly-controlled) party cluster.
 *
 * The leader is the first cluster with `isPlayerFlag === 1` and
 * `partyMemberIndex === 0` (or, more broadly, the lowest partyMemberIndex
 * that matches `party.activeIndex`). Falls back to `clusters[0]` when no
 * party member index has been assigned yet, preserving backward compat with
 * the single-player assumption across the rest of the codebase.
 */
export function getLeaderCluster(world: WorldState): ClusterState | undefined {
  // Fast path: in the vast majority of frames clusters[0] is the leader.
  const first = world.clusters[0];
  if (first !== undefined && first.isPlayerFlag === 1 && first.partyMemberIndex <= 0) {
    return first;
  }
  for (let i = 0; i < world.clusters.length; i++) {
    const c = world.clusters[i];
    if (c.isPlayerFlag === 1 && c.isPartyFollowerFlag === 0) return c;
  }
  // Ultimate fallback: the old convention.
  return first;
}

/**
 * All follower clusters (party members that are not the leader).
 * Returns an empty array when there are no followers.
 */
export function getFollowerClusters(world: WorldState): ClusterState[] {
  const followers: ClusterState[] = [];
  for (let i = 0; i < world.clusters.length; i++) {
    const c = world.clusters[i];
    if (c.isPlayerFlag === 1 && c.isPartyFollowerFlag === 1) {
      followers.push(c);
    }
  }
  return followers;
}

/**
 * All party clusters (leader + followers) in member-index order.
 */
export function getAllPartyMemberClusters(world: WorldState): ClusterState[] {
  const members: ClusterState[] = [];
  for (let i = 0; i < world.clusters.length; i++) {
    const c = world.clusters[i];
    if (c.isPlayerFlag === 1 && c.partyMemberIndex >= 0) {
      members.push(c);
    }
  }
  members.sort((a, b) => a.partyMemberIndex - b.partyMemberIndex);
  return members;
}

// ── Follow-intent computation ────────────────────────────────────────────────

/**
 * Computes the follow intent for a single follower cluster relative to the
 * leader cluster.
 *
 * Returns null when either cluster is missing or the follower is dead.
 */
export function computeFollowerIntent(
  leader: ClusterState,
  follower: ClusterState,
  followOrder: number,
): FollowIntent | null {
  if (leader.isAliveFlag === 0 || follower.isAliveFlag === 0) return null;

  return computeFollowIntent(
    {
      positionXWorld: follower.positionXWorld,
      positionYWorld: follower.positionYWorld,
      isGroundedFlag: follower.isGroundedFlag,
    },
    {
      positionXWorld: leader.positionXWorld,
      positionYWorld: leader.positionYWorld,
      isGroundedFlag: leader.isGroundedFlag,
    },
    followOrder,
    DEFAULT_FOLLOW_CONFIG,
  );
}

// ── Spawn helpers ────────────────────────────────────────────────────────────

/** Horizontal offset per follower, in world units. */
const FOLLOWER_SPAWN_OFFSET_X_WORLD = 20;

/**
 * Creates follower ClusterState instances for recruited non-active party
 * members and pushes them into `world.clusters` right after the leader.
 *
 * Must be called AFTER the leader cluster is already at clusters[0].
 * Each follower gets `isPlayerFlag = 1`, `isPartyFollowerFlag = 1`,
 * `countsTowardRoomCompletionFlag = 0`, and a unique entity ID.
 *
 * Returns the number of followers spawned.
 */
export function spawnFollowerClusters(
  world: WorldState,
  party: PartyState,
  leaderSpawnX: number,
  leaderSpawnY: number,
  nextEntityId: number,
): number {
  const activeMember = getActiveMember(party);
  if (activeMember === null) return 0;

  const recruited = getRecruitedMembers(party);
  let spawned = 0;
  let followOrder = 0;

  for (const member of recruited) {
    if (member.id === activeMember.id) continue; // Skip the leader.
    followOrder++;

    // Stagger followers behind the leader with alternating sides.
    const side = followOrder % 2 === 0 ? 1 : -1;
    const offsetX = side * FOLLOWER_SPAWN_OFFSET_X_WORLD * Math.ceil(followOrder / 2);

    const followerCluster = createClusterState(
      nextEntityId + spawned,
      leaderSpawnX + offsetX,
      leaderSpawnY,
      1, // isPlayerFlag — so they use player movement physics
      member.stats.maxHealthBase,
    );
    followerCluster.isPartyFollowerFlag = 1;
    followerCluster.partyMemberIndex = party.members.indexOf(member);
    followerCluster.healthPoints = member.stats.maxHealthBase;
    followerCluster.countsTowardRoomCompletionFlag = 0;

    // Insert right after the leader (which is at index 0).
    world.clusters.splice(1 + spawned, 0, followerCluster);
    spawned++;
  }

  return spawned;
}

/**
 * Applies follow-intent movement inputs for all follower clusters.
 *
 * Called from applyClusterMovement BEFORE the per-cluster movement loop.
 * Sets per-follower input fields that tickPlayerMovement will read.
 *
 * Design: rather than modifying the global world.playerMoveInputDxWorld
 * (which would be fragile and ordering-dependent), each follower stores
 * its own intent in followerMoveDx / followerJumpTriggered fields on the
 * cluster, and movement.ts reads those instead of the global for followers.
 */
export function computeAllFollowerIntents(world: WorldState): void {
  const leader = getLeaderCluster(world);
  if (leader === undefined) return;

  let followOrder = 0;
  for (let ci = 0; ci < world.clusters.length; ci++) {
    const cluster = world.clusters[ci];
    if (cluster.isPlayerFlag !== 1 || cluster.isPartyFollowerFlag !== 1) continue;
    followOrder++;

    const intent = computeFollowerIntent(leader, cluster, followOrder);
    if (intent === null) {
      cluster.followerMoveDx = 0;
      cluster.followerJumpTriggered = 0;
      cluster.followerShouldTeleport = 0;
      continue;
    }

    if (intent.shouldTeleport) {
      // Teleport the follower to the leader's position (with a small offset).
      const side = cluster.positionXWorld < leader.positionXWorld ? -1 : 1;
      cluster.positionXWorld = leader.positionXWorld + side * FOLLOWER_SPAWN_OFFSET_X_WORLD;
      cluster.positionYWorld = leader.positionYWorld;
      cluster.velocityXWorld = 0;
      cluster.velocityYWorld = 0;
      cluster.followerMoveDx = 0;
      cluster.followerJumpTriggered = 0;
      cluster.followerShouldTeleport = 1;
    } else {
      cluster.followerMoveDx = intent.moveDx;
      cluster.followerJumpTriggered = intent.wantsJump ? 1 : 0;
      cluster.followerShouldTeleport = 0;
    }
  }
}

/**
 * Resolves the actual cluster that should take damage when a party member is hit.
 * If another recruited member has armor/gear with `partyDamageRedirect`, damage
 * redirects to that defender cluster if they are alive.
 */
export function resolvePartyDamageTarget(
  world: WorldState,
  targetCluster: ClusterState,
): ClusterState {
  if (world.party === null || targetCluster.isPlayerFlag !== 1) return targetCluster;
  const redirectIdx = findDamageRedirectMemberIndex(world.party);
  if (redirectIdx < 0 || targetCluster.partyMemberIndex === redirectIdx) return targetCluster;

  for (let i = 0; i < world.clusters.length; i++) {
    const c = world.clusters[i];
    if (c.isPlayerFlag === 1 && c.partyMemberIndex === redirectIdx && c.isAliveFlag === 1) {
      return c;
    }
  }
  return targetCluster;
}
