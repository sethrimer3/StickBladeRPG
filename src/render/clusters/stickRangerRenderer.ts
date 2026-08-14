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

/**
 * Player figure line color. Stick Ranger draws its figures pure black, but this
 * game's dark rock makes a black stickman nearly invisible, so it is white here.
 */
const FIGURE_COLOR = '#ffffff';
/** Enemy stickmen line color (crimson dark). */
const ENEMY_FIGURE_COLOR = '#881111';

/** Size of the head square in world units (native pixels). Matches Stick Ranger. */
const HEAD_SIZE_WORLD = 4.8;

const _weaponAnchorScratch = createWeaponGripAnchor();

/**
 * Renders the stickman softbody onto the canvas.
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
  const toScreenX = (i: number): number => getStickRangerRenderX(body, i, alpha) * scalePx + offsetXPx;
  const toScreenY = (i: number): number => getStickRangerRenderY(body, i, alpha) * scalePx + offsetYPx;

  const color = isEnemy ? ENEMY_FIGURE_COLOR : FIGURE_COLOR;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, scalePx);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.beginPath();
  if (isTwoHandGrip) {
    const handX = (getStickRangerRenderX(body, SR_HAND_L, alpha) + getStickRangerRenderX(body, SR_HAND_R, alpha)) * 0.5;
    const handY = (getStickRangerRenderY(body, SR_HAND_L, alpha) + getStickRangerRenderY(body, SR_HAND_R, alpha)) * 0.5;
    const toGripX = handX * scalePx + offsetXPx;
    const toGripY = handY * scalePx + offsetYPx;

    // Body segments without forearm defaults
    const nonArmSegments: ReadonlyArray<readonly [number, number]> = [
      [SR_CHEST, SR_HIP],
      [SR_CHEST, SR_SHOULDER_L],
      [SR_CHEST, SR_SHOULDER_R],
      [SR_HIP, SR_KNEE_L],
      [SR_HIP, SR_KNEE_R],
      [SR_KNEE_L, SR_FOOT_L],
      [SR_KNEE_R, SR_FOOT_R],
    ];
    for (let s = 0; s < nonArmSegments.length; s++) {
      const [a, b] = nonArmSegments[s];
      ctx.moveTo(toScreenX(a), toScreenY(a));
      ctx.lineTo(toScreenX(b), toScreenY(b));
    }
    // Both forearms meet at the two-handed weapon grip anchor
    ctx.moveTo(toScreenX(SR_SHOULDER_L), toScreenY(SR_SHOULDER_L));
    ctx.lineTo(toGripX, toGripY);
    ctx.moveTo(toScreenX(SR_SHOULDER_R), toScreenY(SR_SHOULDER_R));
    ctx.lineTo(toGripX, toGripY);
  } else {
    for (let s = 0; s < SEGMENTS.length; s++) {
      const [a, b] = SEGMENTS[s];
      ctx.moveTo(toScreenX(a), toScreenY(a));
      ctx.lineTo(toScreenX(b), toScreenY(b));
    }
  }
  ctx.stroke();

  // Head: filled square centred on the head point.
  const headSizePx = HEAD_SIZE_WORLD * scalePx;
  ctx.fillStyle = color;
  ctx.fillRect(
    toScreenX(SR_HEAD) - headSizePx * 0.5,
    toScreenY(SR_HEAD) - headSizePx * 0.5,
    headSizePx,
    headSizePx,
  );

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

  const originXPx = _weaponAnchorScratch.xWorld * scalePx + offsetXPx;
  const originYPx = _weaponAnchorScratch.yWorld * scalePx + offsetYPx;
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
