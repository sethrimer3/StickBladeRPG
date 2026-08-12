/**
 * Staff auras reaching the party, not just the wielder.
 *
 * Closes the gap the port carried from Phase 2c onward: every donor aura
 * declares `target: 'allies'` with `includeSelf: true`, but until now only the
 * wielder was affected, because when the auras landed there was no party for
 * them to reach. Phase 3 built one; this connects the two.
 *
 * What an ally actually gets is damage reduction. The donor's aura contributes
 * a `defenseMultiplier` to each ally's stats, and defense in this port means
 * `computeStatDamage`'s mitigation roll — but the damage pipeline
 * (`applyPlayerDamageWithKnockback`) has no `RngState` in hand, and every one of
 * its ~20 call sites would have to thread one through to give it one. So the
 * aura's multiplier is converted to a deterministic reduction fraction instead:
 *
 *     reduction = 1 - 1 / defenseMultiplier
 *
 * A ×1.6 defense aura therefore removes 37.5% of incoming damage. This is a
 * deliberate deviation: it preserves the direction and rough magnitude of the
 * donor's effect, is bounded and monotone in the multiplier, and needs no RNG,
 * which keeps every existing damage path deterministic and untouched. A member
 * outside the radius, or with no aura up, carries a reduction of exactly 0 and
 * is damaged precisely as before.
 *
 * Deliberately NOT applied to allies: `attackMultiplier`, because followers do
 * not attack — only the active member has a weapon runtime, and that path
 * already reads the aura directly in `playerWeaponState.ts`; and
 * `healthMultiplier`, because a party member's health is a mote count whose
 * maximum is owned by the progression system, and inflating it from a
 * transient aura would desynchronize that.
 */

import type { WorldState } from '../world';
import type { ClusterState } from '../clusters/state';
import {
  getStaffAuraModifiers,
  getStaffAuraRadius,
  isPointInsideActiveStaffAura,
} from '../weapons/staffChannel';
import { getEquippedWeaponDef } from '../weapons/playerWeaponState';

/**
 * Ceiling on aura damage reduction.
 *
 * No ported aura comes near this — it exists so a future donor value cannot
 * make a party member outright invulnerable, which would silently break every
 * hazard and enemy in the game.
 */
export const MAX_AURA_DAMAGE_REDUCTION = 0.75;

/** Converts a donor defense multiplier into a damage reduction fraction. */
export function auraDefenseMultiplierToReduction(defenseMultiplier: number): number {
  if (!Number.isFinite(defenseMultiplier) || defenseMultiplier <= 1) return 0;
  return Math.min(MAX_AURA_DAMAGE_REDUCTION, 1 - 1 / defenseMultiplier);
}

/**
 * Recomputes every party member's aura damage reduction for this tick.
 *
 * Called once per tick, unconditionally. When nothing is channelling it clears
 * the field on every party cluster and returns, so an aura can never linger a
 * tick past its channel — which matters, because the reduction is read by the
 * damage pipeline rather than re-derived there.
 *
 * The aura is centered on the wielder. Only the active member carries a weapon
 * runtime today, so the wielder is the party leader; when per-member weapons
 * arrive this is the one place that assumption needs revisiting.
 */
export function tickPartyAuras(world: WorldState, wielder: ClusterState | null): void {
  const weapon = world.playerWeapon;
  const def = weapon !== undefined && weapon !== null ? getEquippedWeaponDef(weapon) : null;

  let reduction = 0;
  if (def !== null && wielder !== null && getStaffAuraRadius(def) > 0) {
    const modifiers = getStaffAuraModifiers(weapon.staff, def);
    reduction = auraDefenseMultiplierToReduction(modifiers.defenseMultiplier ?? 1);
  }

  const clusters = world.clusters;
  for (let ci = 0; ci < clusters.length; ci++) {
    const c = clusters[ci];
    // Party membership, not merely `isPlayerFlag`: a non-party player cluster
    // (the editor's preview body, for instance) is not an ally.
    if (c.isPlayerFlag === 0 || c.partyMemberIndex < 0) continue;

    if (reduction <= 0 || wielder === null) {
      c.auraDamageReduction = 0;
      continue;
    }

    // `includeSelf` is true for every ported aura, and the wielder always
    // satisfies the radius test against its own position, so self-inclusion
    // needs no special case.
    const inRange = isPointInsideActiveStaffAura(
      weapon.staff, def,
      wielder.positionXWorld, wielder.positionYWorld,
      c.positionXWorld, c.positionYWorld,
    );
    c.auraDamageReduction = inRange ? reduction : 0;
  }
}
