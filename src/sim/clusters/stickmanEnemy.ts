/**
 * stickmanEnemy.ts — Runtime simulation and combat logic for enemy stickmen.
 *
 * Each enemy stickman is driven by:
 *   1. A `StickRangerBody` softbody rig (same Verlet physics as player stickman).
 *   2. A `StickmanBotState` navigating towards tactical target blocks via A* pathfinding.
 *   3. Equipped weapon definitions (swords, bows, staves) with melee swings & ranged attacks.
 */

import type { WorldState } from '../world';
import type { ClusterState } from './state';
import {
  createStickRangerBody,
  type StickRangerBody,
  canStickmanJump,
  SR_HIP,
  SR_HEAD,
  SR_FOOT_L,
  SR_FOOT_R,
  SR_FRAME_MS,
} from './stickRangerBody';
import {
  createStickmanBotState,
  setStickmanBotTarget,
  stepStickmanBotAi,
  type StickmanBotState,
} from '../ai/stickmanBotAi';
import { PATH_BLOCK_SIZE } from '../ai/gridPathfinding';
import { getWeaponDef, getWeaponCooldownTicks, type WeaponDef } from '../weapons/weaponDefs';
import { computeWeaponGripAnchor, createWeaponGripAnchor } from '../weapons/weaponGrip';
import { spawnWeaponProjectile } from '../weapons/weaponProjectiles';
import { applyPlayerDamageWithKnockback } from '../playerDamage';
import { getLeaderCluster } from '../party/partyWorld';

export interface StickmanEnemyState {
  body: StickRangerBody;
  botAi: StickmanBotState;
  weaponDefId: string;
  weaponDef: WeaponDef;
  attackCooldownTicks: number;
  swingActiveTicks: number;
  aimAngleRad: number;
  isSwinging: boolean;
}

const _gripAnchorScratch = createWeaponGripAnchor();

/**
 * Creates and attaches a StickmanEnemyState to a cluster.
 */
export function createStickmanEnemyState(cluster: ClusterState, weaponDefId = 'sword'): StickmanEnemyState {
  const body = createStickRangerBody(cluster.positionXWorld, cluster.positionYWorld);
  const botAi = createStickmanBotState();
  const weaponDef = getWeaponDef(weaponDefId) ?? getWeaponDef('sword') ?? {
    name: 'Sword',
    kind: 'melee',
    range: 42,
    arc: 1,
    dmg: 2,
    cooldown: 550,
    knock: 160,
    color: '#dd2222',
    grip: 'oneHand',
  };

  const state: StickmanEnemyState = {
    body,
    botAi,
    weaponDefId,
    weaponDef,
    attackCooldownTicks: 0,
    swingActiveTicks: 0,
    aimAngleRad: 0,
    isSwinging: false,
  };

  cluster.isStickmanEnemyFlag = 1;
  cluster.stickmanEnemyWeaponId = weaponDefId;
  cluster.stickmanEnemyBody = body;
  cluster.stickmanEnemyIsSwinging = 0;
  cluster.stickmanEnemySwingAngleRad = 0;
  (cluster as unknown as { _stickmanEnemyState: StickmanEnemyState })._stickmanEnemyState = state;

  return state;
}

export function getStickmanEnemyState(cluster: ClusterState): StickmanEnemyState | null {
  return (cluster as unknown as { _stickmanEnemyState?: StickmanEnemyState })._stickmanEnemyState ?? null;
}

/**
 * Ticks an enemy stickman's AI, softbody physics, and weapon combat.
 */
export function tickStickmanEnemy(
  cluster: ClusterState,
  world: WorldState,
  _dtSec: number,
  playerXWorld: number,
  playerYWorld: number,
  isPlayerFound: boolean,
): void {
  let state = getStickmanEnemyState(cluster);
  if (state === null) {
    const weaponId = cluster.stickmanEnemyWeaponId ?? 'sword';
    state = createStickmanEnemyState(cluster, weaponId);
  }

  const hipX = state.body.x[SR_HIP];
  const hipY = state.body.y[SR_HIP];
  const curBlockX = Math.floor(hipX / PATH_BLOCK_SIZE);
  const curBlockY = Math.floor(hipY / PATH_BLOCK_SIZE);

  if (state.attackCooldownTicks > 0) {
    state.attackCooldownTicks--;
  }

  if (state.swingActiveTicks > 0) {
    state.swingActiveTicks--;
    if (state.swingActiveTicks === 0) {
      state.isSwinging = false;
    }
  }

  const def = state.weaponDef;
  const isMelee = def.kind === 'melee' || def.kind === 'shield';
  const isRanged = def.kind === 'bow' || def.kind === 'gun' || def.kind === 'staff' || def.kind === 'magic';

  if (isPlayerFound) {
    const dx = playerXWorld - hipX;
    const dy = playerYWorld - hipY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const playerBlockX = Math.floor(playerXWorld / PATH_BLOCK_SIZE);
    const playerBlockY = Math.floor(playerYWorld / PATH_BLOCK_SIZE);

    if (isMelee) {
      // ── Melee Stickman: Chase player and swing within range ───────────────
      setStickmanBotTarget(state.botAi, playerBlockX, playerBlockY);

      const reach = (def.range ?? 24) + 6;
      if (dist <= reach) {
        state.body.facingDirection = dx >= 0 ? 1 : -1;
        state.aimAngleRad = Math.atan2(dy, dx);

        if (state.attackCooldownTicks <= 0) {
          state.isSwinging = true;
          state.swingActiveTicks = 12;
          state.attackCooldownTicks = Math.max(15, getWeaponCooldownTicks(def));

          // Damage player if in melee arc
          const playerCluster = getLeaderCluster(world) ?? world.clusters[0];
          if (playerCluster && playerCluster.isAliveFlag === 1) {
            applyPlayerDamageWithKnockback(
              playerCluster,
              def.dmg ?? 12,
              hipX,
              hipY,
            );
          }
        }
      }
    } else if (isRanged) {
      // ── Ranged Stickman: Maintain distance (8–12 blocks) and fire projectiles ──
      const minDistance = 48; // 6 blocks
      const maxDistance = 96; // 12 blocks

      if (dist > maxDistance) {
        // Approach player
        setStickmanBotTarget(state.botAi, playerBlockX, playerBlockY);
      } else if (dist < minDistance) {
        // Retreat away from player
        const retreatDir = dx > 0 ? -1 : 1;
        setStickmanBotTarget(state.botAi, curBlockX + retreatDir * 5, curBlockY);
      } else {
        // Hold tactical position
        setStickmanBotTarget(state.botAi, curBlockX, curBlockY);
      }

      // Attack if line of sight is within combat range
      if (dist <= 130) {
        state.body.facingDirection = dx >= 0 ? 1 : -1;
        state.aimAngleRad = Math.atan2(dy, dx);

        if (state.attackCooldownTicks <= 0) {
          state.attackCooldownTicks = Math.max(20, getWeaponCooldownTicks(def));

          if (world.playerWeapon) {
            computeWeaponGripAnchor(state.body, def, 1, _gripAnchorScratch);
            const dirX = Math.cos(state.aimAngleRad);
            const dirY = Math.sin(state.aimAngleRad);

            spawnWeaponProjectile(world.playerWeapon.projectiles, def, {
              xWorld: _gripAnchorScratch.xWorld,
              yWorld: _gripAnchorScratch.yWorld,
              dirXWorld: dirX,
              dirYWorld: dirY,
              damage: def.dmg ?? 10,
            });
          }
        }
      }
    }
  }

  // Step softbody and navigation
  stepStickmanBotAi(state.botAi, state.body, world.pixelMaterialSystem.solid, world.dtMs);

  // ── Mirror simulated body onto cluster box ──────────────────────────────────
  cluster.positionXWorld = state.body.x[SR_HIP];
  cluster.positionYWorld = state.body.y[SR_HIP];

  const framesPerSecond = 1000 / SR_FRAME_MS;
  cluster.velocityXWorld = (state.body.x[SR_HIP] - state.body.prevX[SR_HIP]) * framesPerSecond;
  cluster.velocityYWorld = (state.body.y[SR_HIP] - state.body.prevY[SR_HIP]) * framesPerSecond;

  cluster.isGroundedFlag = canStickmanJump(state.body, world.pixelMaterialSystem.solid) ? 1 : 0;
  cluster.isFacingLeftFlag = state.body.facingDirection < 0 ? 1 : 0;

  const halfHeight = Math.max(4, (state.body.y[SR_FOOT_L] + state.body.y[SR_FOOT_R]) * 0.5 - state.body.y[SR_HEAD]) * 0.5;
  cluster.halfHeightWorld = halfHeight;

  cluster.stickmanEnemyIsSwinging = state.isSwinging ? 1 : 0;
  cluster.stickmanEnemySwingAngleRad = state.aimAngleRad;
  cluster.stickmanEnemyWeaponId = state.weaponDefId;
}
