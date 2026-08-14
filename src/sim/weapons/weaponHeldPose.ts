/**
 * The pose of a weapon that is being *held* rather than swung.
 *
 * Before this module the held angle came straight out of
 * `computeWeaponGripAnchor`, which derives direction from shoulder → hand. On
 * the Stick Ranger rig the hands hang below the shoulders, so that vector
 * points almost straight down at rest: a blade drawn along it hangs off the
 * hip, through the floor, and off the bottom of the screen. It reads as the
 * weapon having been dropped, because geometrically it has been.
 *
 * A carried weapon is not aimed along the arm — the wrist decides where it
 * points. So the rest pose is defined here, relative to facing, and the arm is
 * only consulted for *where* the grip is, never for which way the blade goes.
 *
 * The second job is keeping the tip out of solid geometry. A held blade is a
 * rigid body a couple of blocks long attached to a character who can walk into
 * a corridor; without this it passes through walls. The tip is resolved by
 * rotating the blade away from the obstruction (a wielder tilts the sword up in
 * a low passage), and only clamping its drawn length when no angle is clear.
 */

import type { WorldState } from '../world';
import { raycastWalls } from '../clusters/grappleShared';
import {
  computeWeaponGripAnchor,
  createWeaponGripAnchor,
  type WeaponGripAnchor,
} from './weaponGrip';
import type { WeaponDef } from './weaponDefs';
import type { StickRangerBody } from '../clusters/stickRangerBody';

/**
 * Rest angle of a held blade, in radians above horizontal, measured in the
 * facing direction.
 *
 * Negative is upward (world Y grows downward). A shade under 30° up-and-forward
 * is the ordinary "at guard" carry: the tip clears the ground on a flat floor
 * at every ported melee reach, which matters because a tip that grazed the
 * floor would trigger the avoidance search on every walking frame.
 */
export const HELD_REST_ANGLE_RAD = -0.45;

/** Rest angle for weapons that are held level rather than at guard (bows, guns). */
export const HELD_LEVEL_ANGLE_RAD = 0;

/** Gap kept between the tip and the surface it was pushed off, world units. */
const TIP_SKIN_WORLD = 0.5;

/** Angular step of the avoidance search. Small enough to look like a tilt, not a snap. */
const TIP_AVOID_STEP_RAD = 0.12;

/**
 * Most the blade may be rotated away from its rest angle to clear geometry.
 * Beyond roughly a right angle the pose stops reading as the same carry, so
 * past this the blade is shortened instead.
 */
const TIP_AVOID_MAX_RAD = Math.PI * 0.5;

/** A held weapon's resolved position in the world. */
export interface HeldWeaponPose {
  /** Grip position, world units. */
  gripXWorld: number;
  gripYWorld: number;
  /** Direction the blade points, radians. */
  angleRad: number;
  /** Blade length actually occupied, world units — shortened when boxed in. */
  reachWorld: number;
  /**
   * Length the weapon wants to be, before any clipping. Renderers that draw a
   * whole sprite size it from this and mask it to `reachWorld`, so a blade
   * pressed into a wall is hidden rather than scaled down.
   */
  requestedReachWorld: number;
  /** Tip position implied by `angleRad` and `reachWorld`. */
  tipXWorld: number;
  tipYWorld: number;
  /** 1 while the tip is resting against solid geometry. */
  tipContactFlag: 0 | 1;
}

/** Allocates a zeroed pose, for callers that want to own one. */
export function createHeldWeaponPose(): HeldWeaponPose {
  return {
    gripXWorld: 0,
    gripYWorld: 0,
    angleRad: 0,
    reachWorld: 0,
    requestedReachWorld: 0,
    tipXWorld: 0,
    tipYWorld: 0,
    tipContactFlag: 0,
  };
}

/**
 * The angle `def` rests at when carried, in world radians for `facingDirection`.
 *
 * Kinds that are held level (bows drawn across the body, guns sighted) keep a
 * horizontal carry; everything else rests at guard.
 */
export function resolveHeldRestAngleRad(def: WeaponDef, facingDirection: -1 | 1): number {
  const kind = def.kind;
  const local = kind === 'bow' || kind === 'gun' ? HELD_LEVEL_ANGLE_RAD : HELD_REST_ANGLE_RAD;
  // Mirroring the local angle rather than adding PI keeps "up" up when facing left.
  return facingDirection === -1 ? Math.PI - local : local;
}

/**
 * Distance from `(ox, oy)` along `angleRad` before solid geometry is met,
 * capped at `maxDist`. Returns `maxDist` when the ray is clear.
 */
function clearDistance(
  world: WorldState,
  ox: number,
  oy: number,
  angleRad: number,
  maxDist: number,
): number {
  const hit = raycastWalls(world, ox, oy, Math.cos(angleRad), Math.sin(angleRad), maxDist);
  if (hit === null) return maxDist;
  return Math.max(0, hit.t - TIP_SKIN_WORLD);
}

/**
 * Resolves where a held weapon actually sits, writing into `out`.
 *
 * `preferredAngleRad` is the angle the weapon wants to be at — the rest angle
 * when carried, or the swing's current angle mid-arc. When that angle drives the
 * tip into geometry the blade is rotated away from it, trying both directions at
 * each step so a wall on the left is escaped leftward and one on the right
 * rightward. If nothing within `TIP_AVOID_MAX_RAD` is clear, the preferred angle
 * is kept and the blade is drawn only as far as it fits.
 *
 * `allowAvoidance` is false during a swing: an arc that dodged around walls
 * would no longer match the arc the damage pass swept, so a swing keeps its
 * angle and only loses length.
 */
export function computeHeldWeaponPose(
  world: WorldState,
  body: StickRangerBody,
  def: WeaponDef,
  reachWorld: number,
  preferredAngleRad: number,
  allowAvoidance: boolean,
  out: HeldWeaponPose,
): void {
  computeWeaponGripAnchor(body, def, 1, _anchor);
  const gx = _anchor.xWorld;
  const gy = _anchor.yWorld;

  out.gripXWorld = gx;
  out.gripYWorld = gy;

  const reach = Math.max(0, reachWorld);
  let angle = preferredAngleRad;
  let clear = clearDistance(world, gx, gy, angle, reach);

  if (clear < reach && allowAvoidance) {
    for (let offset = TIP_AVOID_STEP_RAD; offset <= TIP_AVOID_MAX_RAD; offset += TIP_AVOID_STEP_RAD) {
      // Upward first: raising the blade is what a wielder does in a tight space,
      // and it is the direction that clears a floor, which is the common case.
      const up = preferredAngleRad - offset;
      if (clearDistance(world, gx, gy, up, reach) >= reach) {
        angle = up;
        clear = reach;
        break;
      }
      const down = preferredAngleRad + offset;
      if (clearDistance(world, gx, gy, down, reach) >= reach) {
        angle = down;
        clear = reach;
        break;
      }
    }
  }

  out.angleRad = angle;
  out.requestedReachWorld = reach;
  out.reachWorld = Math.min(reach, clear);
  out.tipXWorld = gx + Math.cos(angle) * out.reachWorld;
  out.tipYWorld = gy + Math.sin(angle) * out.reachWorld;
  out.tipContactFlag = out.reachWorld < reach - 1e-3 ? 1 : 0;
}

const _anchor: WeaponGripAnchor = createWeaponGripAnchor();
