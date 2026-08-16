/**
 * Draws the Stick Ranger stickman.
 *
 * Deliberately minimal, matching the original: ten line segments between the
 * simulated body points plus a small square for the head. There are no sprites
 * and no animation frames — every pose you see is the softbody's actual state,
 * so this renderer must not smooth, clamp or stylise the point positions.
 *
 * Point positions are interpolated between the last two 30Hz body frames using
 * the body's leftover accumulator, so the figure moves smoothly at 60fps
 * without changing the simulation rate the constants are tuned for.
 */

import {
  getStickRangerRenderAlpha,
  getStickRangerRenderX,
  getStickRangerRenderY,
  SR_HEAD,
  SR_CHEST,
  SR_HIP,
  SR_SHOULDER_L,
  SR_SHOULDER_R,
  SR_HAND_L,
  SR_HAND_R,
  SR_KNEE_L,
  SR_KNEE_R,
  SR_FOOT_L,
  SR_FOOT_R,
  type StickRangerBody,
} from '../../sim/clusters/stickRangerBody';
import type { WeaponDef } from '../../sim/weapons/weaponDefs';
import { computeWeaponGripAnchor, createWeaponGripAnchor } from '../../sim/weapons/weaponGrip';
import { resolveHeldRestAngleRad } from '../../sim/weapons/weaponHeldPose';

/** Limb segments, in draw order — same set Stick Ranger strokes per frame. */
const SEGMENTS: ReadonlyArray<readonly [number, number]> = [
  [SR_CHEST, SR_HIP],           // spine
  [SR_CHEST, SR_SHOULDER_L],    // upper arms
  [SR_CHEST, SR_SHOULDER_R],
  [SR_SHOULDER_L, SR_HAND_L],   // forearms
  [SR_SHOULDER_R, SR_HAND_R],
  [SR_HIP, SR_KNEE_L],          // thighs
  [SR_HIP, SR_KNEE_R],
  [SR_KNEE_L, SR_FOOT_L],       // shins
  [SR_KNEE_R, SR_FOOT_R],
];

/** Body segments without forearm defaults, used when holding a two-handed weapon. */
const NON_ARM_SEGMENTS: ReadonlyArray<readonly [number, number]> = [
  [SR_CHEST, SR_HIP],
  [SR_CHEST, SR_SHOULDER_L],
  [SR_CHEST, SR_SHOULDER_R],
  [SR_HIP, SR_KNEE_L],
  [SR_HIP, SR_KNEE_R],
  [SR_KNEE_L, SR_FOOT_L],
  [SR_KNEE_R, SR_FOOT_R],
];

/**
 * Player figure line color. Stick Ranger draws its figures pure black, but this
 * game's dark rock makes a black stickman nearly invisible, so it is white here.
 */
export const FIGURE_COLOR = '#ffffff';
/** Enemy stickmen line color (crimson dark). */
export const ENEMY_FIGURE_COLOR = '#881111';
/** Solid black outline color. */
export const OUTLINE_COLOR = '#000000';

/**
 * 4-neighbour cardinal offsets used to draw a 1-pixel solid black outline
 * around the stickman figure with corners clipped (excluding diagonals),
 * matching the outer-silhouette outline technique from DustWeaver player sprites.
 */
export const OUTLINE_NEIGHBOR_OFFSETS: ReadonlyArray<readonly [number, number]> = [
            [0, -1],
  [-1,  0],          [1,  0],
            [0,  1],
];

/** Size of the head square in world units (native pixels). */
export const HEAD_SIZE_WORLD = 5;

/** Limb thickness in world units (native pixels). */
export const LIMB_THICKNESS_WORLD = 1;

const _weaponAnchorScratch = createWeaponGripAnchor();

/**
 * Renders the stickman softbody onto the canvas.
 *
 * Draws a 1-pixel solid black outline in the 4 cardinal directions (corners clipped)
 * behind the figure, followed by the foreground stickman body.
 *
 * All coordinates snap to integer pixels for a crisp, non-blurry appearance.
 * Limbs are 1 pixel wide and the head is 5x5 pixels.
 *
 * @param ctx        Canvas 2D context.
 * @param body       The simulated softbody.
 * @param offsetXPx  Camera X offset, screen pixels.
 * @param offsetYPx  Camera Y offset, screen pixels.
 * @param scalePx    Screen pixels per world unit.
 * @param isTwoHandGrip True when holding a two-handed weapon.
 * @param isEnemy    True if this is an enemy stickman.
 */
export function renderStickRangerBody(
  ctx: CanvasRenderingContext2D,
  body: StickRangerBody,
  offsetXPx: number,
  offsetYPx: number,
  scalePx: number,
  isTwoHandGrip = false,
  isEnemy = false,
): void {
  const alpha = getStickRangerRenderAlpha(body);
  const toScreenX = (i: number): number => Math.round(getStickRangerRenderX(body, i, alpha) * scalePx + offsetXPx);
  const toScreenY = (i: number): number => Math.round(getStickRangerRenderY(body, i, alpha) * scalePx + offsetYPx);

  const color = isEnemy ? ENEMY_FIGURE_COLOR : FIGURE_COLOR;
  const headSizePx = Math.max(1, Math.round(HEAD_SIZE_WORLD * scalePx));
  const outlineThicknessPx = scalePx;

  let toGripX = 0;
  let toGripY = 0;
  if (isTwoHandGrip) {
    const handX = (getStickRangerRenderX(body, SR_HAND_L, alpha) + getStickRangerRenderX(body, SR_HAND_R, alpha)) * 0.5;
    const handY = (getStickRangerRenderY(body, SR_HAND_L, alpha) + getStickRangerRenderY(body, SR_HAND_R, alpha)) * 0.5;
    toGripX = Math.round(handX * scalePx + offsetXPx);
    toGripY = Math.round(handY * scalePx + offsetYPx);
  }

  const halfHeadPx = Math.floor(headSizePx * 0.5);

  const drawFigurePass = (passColor: string, dxPx: number, dyPx: number): void => {
    ctx.strokeStyle = passColor;
    ctx.fillStyle = passColor;

    ctx.beginPath();
    if (isTwoHandGrip) {
      for (let s = 0; s < NON_ARM_SEGMENTS.length; s++) {
        const [a, b] = NON_ARM_SEGMENTS[s];
        ctx.moveTo(toScreenX(a) + dxPx, toScreenY(a) + dyPx);
        ctx.lineTo(toScreenX(b) + dxPx, toScreenY(b) + dyPx);
      }
      // Both forearms meet at the two-handed weapon grip anchor
      ctx.moveTo(toScreenX(SR_SHOULDER_L) + dxPx, toScreenY(SR_SHOULDER_L) + dyPx);
      ctx.lineTo(toGripX + dxPx, toGripY + dyPx);
      ctx.moveTo(toScreenX(SR_SHOULDER_R) + dxPx, toScreenY(SR_SHOULDER_R) + dyPx);
      ctx.lineTo(toGripX + dxPx, toGripY + dyPx);
    } else {
      for (let s = 0; s < SEGMENTS.length; s++) {
        const [a, b] = SEGMENTS[s];
        ctx.moveTo(toScreenX(a) + dxPx, toScreenY(a) + dyPx);
        ctx.lineTo(toScreenX(b) + dxPx, toScreenY(b) + dyPx);
      }
    }
    ctx.stroke();

    // Head: filled 5x5 square centred on the head point, pixel-snapped.
    ctx.fillRect(
      toScreenX(SR_HEAD) - halfHeadPx + dxPx,
      toScreenY(SR_HEAD) - halfHeadPx + dyPx,
      headSizePx,
      headSizePx,
    );
  };

  ctx.save();
  ctx.lineWidth = Math.max(1, Math.round(LIMB_THICKNESS_WORLD * scalePx));
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';

  // 1. Draw 1-pixel solid black outline in 4 cardinal directions (clipped corners).
  for (let n = 0; n < OUTLINE_NEIGHBOR_OFFSETS.length; n++) {
    const [ox, oy] = OUTLINE_NEIGHBOR_OFFSETS[n];
    drawFigurePass(OUTLINE_COLOR, ox * outlineThicknessPx, oy * outlineThicknessPx);
  }

  // 2. Draw foreground figure in primary color (white or enemy crimson) on top.
  drawFigurePass(color, 0, 0);

  ctx.restore();
}

/**
 * Renders a stickman's equipped weapon (blade, bow, staff) attached to their grip anchor.
 */
export function renderStickRangerWeapon(
  ctx: CanvasRenderingContext2D,
  body: StickRangerBody,
  def: WeaponDef,
  isSwinging: boolean,
  swingAngleRad: number,
  offsetXPx: number,
  offsetYPx: number,
  scalePx: number,
): void {
  computeWeaponGripAnchor(body, def, 1, _weaponAnchorScratch);

  const originXPx = Math.round(_weaponAnchorScratch.xWorld * scalePx + offsetXPx);
  const originYPx = Math.round(_weaponAnchorScratch.yWorld * scalePx + offsetYPx);
  // At rest the blade follows the carry pose, not the arm: shoulder → hand
  // points almost straight down on this rig, which reads as a dropped weapon.
  const angleRad = isSwinging
    ? swingAngleRad
    : resolveHeldRestAngleRad(def, body.facingDirection);

  ctx.save();
  ctx.translate(originXPx, originYPx);
  ctx.rotate(angleRad);

  const reachPx = (def.range ?? 20) * scalePx;
  const color = def.color ?? '#e0e0e0';

  if (def.kind === 'melee' || def.kind === 'shield') {
    // ── Sword Blade ────────────────────────────────────────────────────────
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.5, scalePx * 1.2);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(reachPx, 0);
    ctx.stroke();

    // Crossguard
    ctx.strokeStyle = '#8a6f3d';
    ctx.lineWidth = Math.max(1, scalePx * 0.8);
    ctx.beginPath();
    ctx.moveTo(reachPx * 0.15, -scalePx * 2);
    ctx.lineTo(reachPx * 0.15, scalePx * 2);
    ctx.stroke();

    // Swing swoosh arc if active
    if (isSwinging) {
      ctx.strokeStyle = 'rgba(255, 100, 100, 0.4)';
      ctx.lineWidth = scalePx * 2.5;
      ctx.beginPath();
      ctx.arc(0, 0, reachPx, -0.6, 0.6);
      ctx.stroke();
    }
  } else if (def.kind === 'bow') {
    // ── Bow Arc & String ───────────────────────────────────────────────────
    const bowRadiusPx = 7 * scalePx;
    ctx.strokeStyle = '#8b5a2b';
    ctx.lineWidth = Math.max(1.2, scalePx * 0.9);
    ctx.beginPath();
    ctx.arc(0, 0, bowRadiusPx, -Math.PI * 0.35, Math.PI * 0.35);
    ctx.stroke();

    // Bowstring
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(0.8, scalePx * 0.5);
    ctx.beginPath();
    const topX = Math.cos(-Math.PI * 0.35) * bowRadiusPx;
    const topY = Math.sin(-Math.PI * 0.35) * bowRadiusPx;
    const botX = Math.cos(Math.PI * 0.35) * bowRadiusPx;
    const botY = Math.sin(Math.PI * 0.35) * bowRadiusPx;
    ctx.moveTo(topX, topY);
    ctx.lineTo(-scalePx * 1.5, 0);
    ctx.lineTo(botX, botY);
    ctx.stroke();
  } else if (def.kind === 'staff' || def.kind === 'magic') {
    // ── Staff Shaft & Magic Orb ───────────────────────────────────────────
    const staffLenPx = 18 * scalePx;
    ctx.strokeStyle = '#6e4720';
    ctx.lineWidth = Math.max(1.2, scalePx * 0.9);
    ctx.beginPath();
    ctx.moveTo(-staffLenPx * 0.2, 0);
    ctx.lineTo(staffLenPx * 0.8, 0);
    ctx.stroke();

    // Glowing tip
    const tipX = staffLenPx * 0.8;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(tipX, 0, scalePx * 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}
