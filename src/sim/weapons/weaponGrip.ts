/**
 * Weapon grip anchors on the Stick Ranger stickman rig.
 *
 * Resolves where a held weapon attaches to the body and which way it points,
 * so renderers and swing code share one definition of "the hand".
 *
 * This module only reads the rig. It deliberately does not live in
 * `stickRangerBody.ts`: that file owns the gait and constraint solver and is
 * sensitive to change, whereas grip resolution is a pure consumer of the
 * already-solved point positions.
 *
 * Phase 2 of the STICK-RPG port. See `docs/decisions/STICK_RPG_PORT_PLAN.md`.
 */

import {
  SR_HAND_L,
  SR_HAND_R,
  SR_HIP,
  SR_SHOULDER_L,
  SR_SHOULDER_R,
  getStickRangerRenderX,
  getStickRangerRenderY,
  type StickRangerBody,
} from '../clusters/stickRangerBody';
import type { WeaponDef, WeaponGrip } from './weaponDefs';

/** Which hand (or hands) hold the weapon. */
export const GRIP_HAND_RIGHT = 0;
export const GRIP_HAND_LEFT = 1;
export const GRIP_HAND_BOTH = 2;

export type GripHand =
  | typeof GRIP_HAND_RIGHT
  | typeof GRIP_HAND_LEFT
  | typeof GRIP_HAND_BOTH;

/** A resolved attachment point for a held weapon. */
export interface WeaponGripAnchor {
  /** Hold position in world units. */
  xWorld: number;
  yWorld: number;
  /**
   * Direction the weapon points, in radians, derived from shoulder → hand.
   * Falls back to the body's facing when the arm is fully collapsed.
   */
  angleRad: number;
  /** Which hand resolved this anchor. */
  hand: GripHand;
}

/**
 * Chooses the holding hand for a weapon.
 *
 * Two-handed weapons resolve to both hands (anchored at their midpoint);
 * `dual` weapons and one-handed weapons resolve to the dominant hand, which is
 * the right hand when facing right and the left when facing left, so the weapon
 * always reads as being on the leading side.
 */
export function resolveGripHand(grip: WeaponGrip | undefined, facingDirection: -1 | 1): GripHand {
  if (grip === 'twoHand') return GRIP_HAND_BOTH;
  return facingDirection === -1 ? GRIP_HAND_LEFT : GRIP_HAND_RIGHT;
}

/**
 * Resolves the grip anchor for `def` on `body`, writing into `out`.
 *
 * `alpha` is the render interpolation factor in 0..1; pass 1 for simulation
 * queries and the renderer's current alpha for drawing. Writing into a caller
 * -owned `out` keeps this allocation-free on the render path.
 */
export function computeWeaponGripAnchor(
  body: StickRangerBody,
  def: WeaponDef,
  alpha: number,
  out: WeaponGripAnchor,
): void {
  const hand = resolveGripHand(def.grip, body.facingDirection);

  const leftHandX = getStickRangerRenderX(body, SR_HAND_L, alpha);
  const leftHandY = getStickRangerRenderY(body, SR_HAND_L, alpha);
  const rightHandX = getStickRangerRenderX(body, SR_HAND_R, alpha);
  const rightHandY = getStickRangerRenderY(body, SR_HAND_R, alpha);

  let handX: number;
  let handY: number;
  let shoulderX: number;
  let shoulderY: number;

  if (hand === GRIP_HAND_BOTH) {
    handX = (leftHandX + rightHandX) * 0.5;
    handY = (leftHandY + rightHandY) * 0.5;
    shoulderX =
      (getStickRangerRenderX(body, SR_SHOULDER_L, alpha)
        + getStickRangerRenderX(body, SR_SHOULDER_R, alpha)) * 0.5;
    shoulderY =
      (getStickRangerRenderY(body, SR_SHOULDER_L, alpha)
        + getStickRangerRenderY(body, SR_SHOULDER_R, alpha)) * 0.5;
  } else if (hand === GRIP_HAND_LEFT) {
    handX = leftHandX;
    handY = leftHandY;
    shoulderX = getStickRangerRenderX(body, SR_SHOULDER_L, alpha);
    shoulderY = getStickRangerRenderY(body, SR_SHOULDER_L, alpha);
  } else {
    handX = rightHandX;
    handY = rightHandY;
    shoulderX = getStickRangerRenderX(body, SR_SHOULDER_R, alpha);
    shoulderY = getStickRangerRenderY(body, SR_SHOULDER_R, alpha);
  }

  const dx = handX - shoulderX;
  const dy = handY - shoulderY;

  out.xWorld = handX;
  out.yWorld = handY;
  out.hand = hand;
  // A collapsed arm gives no usable direction; fall back to facing so the
  // weapon never snaps to an arbitrary angle for a frame.
  out.angleRad = dx * dx + dy * dy > 1e-6
    ? Math.atan2(dy, dx)
    : (body.facingDirection === -1 ? Math.PI : 0);
}

/** Allocates a zeroed anchor, for callers that want to own one. */
export function createWeaponGripAnchor(): WeaponGripAnchor {
  return { xWorld: 0, yWorld: 0, angleRad: 0, hand: GRIP_HAND_RIGHT };
}

/**
 * Origin a swing should pivot around: the wielder's hip.
 *
 * Swings pivot at the body, not at the hand — anchoring the arc to the hand
 * would let arm swing alone carry the blade through a target the character
 * never actually reached toward.
 */
export function computeSwingOrigin(
  body: StickRangerBody,
  alpha: number,
  out: { xWorld: number; yWorld: number },
): void {
  out.xWorld = getStickRangerRenderX(body, SR_HIP, alpha);
  out.yWorld = getStickRangerRenderY(body, SR_HIP, alpha);
}
