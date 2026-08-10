/**
 * Binding between `weaponSwing.ts` and live world state.
 *
 * `weaponSwing.ts` is deliberately engine-agnostic so it stays pure and
 * Node-testable. This module is the one place that knows about `WorldState`,
 * `ClusterState`, and the shared weave damage router, keeping that knowledge
 * out of the swing math itself.
 *
 * Phase 2 of the STICK-RPG port. See `docs/decisions/STICK_RPG_PORT_PLAN.md`.
 */

import type { WorldState } from '../world';
import type { ClusterState } from '../clusters/state';
import type { RngState } from '../rng';
import { applyRoutedWeaveDamage } from '../weaves/weaveCollisionUtils';
import { MAX_HIT_REGISTRY_SLOTS } from '../weaves/weaveHitRegistryConfig';
import type { WeaponDef } from './weaponDefs';
import {
  tickWeaponSwing,
  type WeaponSwingState,
  type WeaponSwingTarget,
  type WeaponSwingTickResult,
} from './weaponSwing';

/**
 * Scratch target list, reused every tick so hit resolution allocates nothing.
 *
 * Holds the enemy clusters eligible for the current swing. Sized to the hit
 * registry capacity because targets beyond that index cannot be registered
 * anyway — the same documented degrade `swordWeave.ts` and `bowArrow.ts` apply.
 */
const _targetScratch: (ClusterState | undefined)[] = new Array(MAX_HIT_REGISTRY_SLOTS);

/**
 * Maps scratch slot index back to the index in `world.clusters`, so a hit
 * reported against the compacted target list can be routed to the right cluster.
 */
const _clusterIndexScratch = new Int32Array(MAX_HIT_REGISTRY_SLOTS);

/** Number of live entries in the scratch buffers. */
let _targetCount = 0;

/**
 * Fills the scratch target list with living enemy clusters.
 *
 * The player is excluded: a swing never hits its own wielder. Dead clusters are
 * skipped so a corpse cannot soak a swing that should carry through to the
 * enemy behind it.
 */
function collectEnemyTargets(world: WorldState): void {
  _targetCount = 0;
  const clusters = world.clusters;
  for (let i = 0; i < clusters.length && _targetCount < MAX_HIT_REGISTRY_SLOTS; i++) {
    const c = clusters[i];
    if (c.isPlayerFlag === 1) continue;
    if (c.isAliveFlag === 0) continue;
    _targetScratch[_targetCount] = c;
    _clusterIndexScratch[_targetCount] = i;
    _targetCount++;
  }
  for (let i = _targetCount; i < MAX_HIT_REGISTRY_SLOTS; i++) _targetScratch[i] = undefined;
}

/**
 * Advances `state` by one tick against the world's enemy clusters, applying
 * damage and knockback to everything the blade sweeps.
 *
 * Damage routes through `applyRoutedWeaveDamage` so bespoke damage handling
 * (currently the Orbital Dust Core's per-segment hits) keeps working, exactly
 * as it does for the Sword Weave.
 *
 * Note the target-list caveat: because the scratch list is rebuilt each tick,
 * a cluster that dies mid-swing shifts the indices of every cluster after it.
 * The swing's hit registry is indexed by scratch slot, so in that rare case a
 * shifted target could take a second hit from the same swing. Accepted for now
 * — it requires a death mid-swing and costs at most one extra hit. Revisit if
 * multi-target melee becomes central.
 */
export function applyWeaponSwingToClusters(
  world: WorldState,
  state: WeaponSwingState,
  def: WeaponDef,
  player: ClusterState,
  attackerAttack: number,
  rng: RngState,
): WeaponSwingTickResult {
  collectEnemyTargets(world);

  return tickWeaponSwing(state, def, {
    originXWorld: player.positionXWorld,
    originYWorld: player.positionYWorld,
    targets: _targetScratch as readonly (WeaponSwingTarget | undefined)[],
    targetCount: _targetCount,
    attackerAttack,
    rng,
    onHit: (targetIndex, damage, knockbackXWorld, knockbackYWorld) => {
      const clusterIndex = _clusterIndexScratch[targetIndex];
      const target = world.clusters[clusterIndex];
      if (target === undefined) return;

      applyRoutedWeaveDamage(
        world,
        clusterIndex,
        damage,
        target.positionXWorld,
        target.positionYWorld,
      );

      target.velocityXWorld += knockbackXWorld;
      target.velocityYWorld += knockbackYWorld;
    },
  });
}
