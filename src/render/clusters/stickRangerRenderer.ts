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
  SR_POINT_COUNT,
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

interface SnappedPose {
  x: Int32Array;
  y: Int32Array;
  gripX: number;
  gripY: number;
}

const _snappedPoseCache = new WeakMap<StickRangerBody, SnappedPose>();

function getOrCreateSnappedPose(body: StickRangerBody): SnappedPose {
  let pose = _snappedPoseCache.get(body);
  if (!pose) {
    pose = {
      x: new Int32Array(SR_POINT_COUNT),
      y: new Int32Array(SR_POINT_COUNT),
      gripX: 0,
      gripY: 0,
    };
    _snappedPoseCache.set(body, pose);
  }
  return pose;
}

function snapWithHysteresis(target: number, current: number, deadband = 0.60): number {
  if (current === 0 && target !== 0) return Math.round(target);
  const diff = Math.abs(target - current);
  if (diff < deadband) return current;
  return Math.round(target);
}

/**
 * Draws a 1-pixel crisp line between integer endpoints using Bresenham's algorithm.
 */
function drawBresenhamLine(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  dxPx: number,
  dyPx: number,
): void {
  let x = x0;
  let y = y0;
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;

  while (true) {
    ctx.fillRect(x + dxPx, y + dyPx, 1, 1);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
}

/**
 * Renders the stickman softbody onto the canvas.
 *
 * Draws a 1-pixel solid black outline in the 4 cardinal directions (corners clipped)
 * behind the figure, followed by the foreground stickman body.
 *
 * All coordinates snap to integer pixels with hysteresis for a crisp, jitter-free appearance.
 * Limbs are drawn with exact 1-pixel discrete fills (no anti-aliased smearing) and the head is 5x5 pixels.
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
  const pose = getOrCreateSnappedPose(body);

  for (let i = 0; i < SR_POINT_COUNT; i++) {
    const rawX = getStickRangerRenderX(body, i, alpha) * scalePx + offsetXPx;
    const rawY = getStickRangerRenderY(body, i, alpha) * scalePx + offsetYPx;
    pose.x[i] = snapWithHysteresis(rawX, pose.x[i]);
    pose.y[i] = snapWithHysteresis(rawY, pose.y[i]);
  }

  const color = isEnemy ? ENEMY_FIGURE_COLOR : FIGURE_COLOR;
  const headSizePx = Math.max(1, Math.round(HEAD_SIZE_WORLD * scalePx));
  const outlineThicknessPx = Math.max(1, Math.round(scalePx));

  if (isTwoHandGrip) {
    const rawHandX = (getStickRangerRenderX(body, SR_HAND_L, alpha) + getStickRangerRenderX(body, SR_HAND_R, alpha)) * 0.5;
    const rawHandY = (getStickRangerRenderY(body, SR_HAND_L, alpha) + getStickRangerRenderY(body, SR_HAND_R, alpha)) * 0.5;
    const targetGripX = rawHandX * scalePx + offsetXPx;
    const targetGripY = rawHandY * scalePx + offsetYPx;
    pose.gripX = snapWithHysteresis(targetGripX, pose.gripX);
    pose.gripY = snapWithHysteresis(targetGripY, pose.gripY);
  }

  const halfHeadPx = Math.floor(headSizePx * 0.5);

  const drawPass = (passColor: string, dxPx: number, dyPx: number): void => {
    ctx.fillStyle = passColor;

    // 1. Draw limb segments using discrete 1px Bresenham rasterization (crisp pixel art)
    if (isTwoHandGrip) {
      for (let s = 0; s < NON_ARM_SEGMENTS.length; s++) {
        const [a, b] = NON_ARM_SEGMENTS[s];
        drawBresenhamLine(ctx, pose.x[a], pose.y[a], pose.x[b], pose.y[b], dxPx, dyPx);
      }
      // Both forearms meet at the two-handed weapon grip anchor
      drawBresenhamLine(ctx, pose.x[SR_SHOULDER_L], pose.y[SR_SHOULDER_L], pose.gripX, pose.gripY, dxPx, dyPx);
      drawBresenhamLine(ctx, pose.x[SR_SHOULDER_R], pose.y[SR_SHOULDER_R], pose.gripX, pose.gripY, dxPx, dyPx);
    } else {
      for (let s = 0; s < SEGMENTS.length; s++) {
        const [a, b] = SEGMENTS[s];
        drawBresenhamLine(ctx, pose.x[a], pose.y[a], pose.x[b], pose.y[b], dxPx, dyPx);
      }
    }

    // 2. Head: filled 5x5 square centred on the head point, pixel-snapped.
    ctx.fillRect(
      pose.x[SR_HEAD] - halfHeadPx + dxPx,
      pose.y[SR_HEAD] - halfHeadPx + dyPx,
      headSizePx,
      headSizePx,
    );
  };

  ctx.save();

  // 1. Draw 1-pixel solid black outline in 4 cardinal directions (clipped corners).
  for (let n = 0; n < OUTLINE_NEIGHBOR_OFFSETS.length; n++) {
    const [ox, oy] = OUTLINE_NEIGHBOR_OFFSETS[n];
    drawPass(OUTLINE_COLOR, ox * outlineThicknessPx, oy * outlineThicknessPx);
  }

  // 2. Draw foreground figure in primary color (white or enemy crimson) on top.
  drawPass(color, 0, 0);

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
  const outlineThicknessPx = Math.max(1, Math.round(scalePx));

  if (def.kind === 'melee' || def.kind === 'shield') {
    const drawBladePass = (bladeColor: string, guardColor: string, dx: number, dy: number): void => {
      // Blade
      ctx.strokeStyle = bladeColor;
      ctx.lineWidth = Math.max(1.5, scalePx * 1.2);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(dx, dy);
      ctx.lineTo(reachPx + dx, dy);
      ctx.stroke();

      // Crossguard
      ctx.strokeStyle = guardColor;
      ctx.lineWidth = Math.max(1, scalePx * 0.8);
      ctx.beginPath();
      ctx.moveTo(reachPx * 0.15 + dx, -scalePx * 2 + dy);
      ctx.lineTo(reachPx * 0.15 + dx, scalePx * 2 + dy);
      ctx.stroke();
    };

    // 1. Draw 4 cardinal black outline passes (corners clipped)
    for (let n = 0; n < OUTLINE_NEIGHBOR_OFFSETS.length; n++) {
      const [ox, oy] = OUTLINE_NEIGHBOR_OFFSETS[n];
      drawBladePass(OUTLINE_COLOR, OUTLINE_COLOR, ox * outlineThicknessPx, oy * outlineThicknessPx);
    }

    // 2. Draw foreground pass
    drawBladePass(color, '#8a6f3d', 0, 0);

    // Swing swoosh arc if active (foreground only)
    if (isSwinging) {
      ctx.strokeStyle = 'rgba(255, 100, 100, 0.4)';
      ctx.lineWidth = scalePx * 2.5;
      ctx.beginPath();
      ctx.arc(0, 0, reachPx, -0.6, 0.6);
      ctx.stroke();
    }
  } else if (def.kind === 'bow') {
    const bowRadiusPx = 7 * scalePx;

    const drawBowPass = (limbColor: string, stringColor: string, dx: number, dy: number): void => {
      ctx.strokeStyle = limbColor;
      ctx.lineWidth = Math.max(1.2, scalePx * 0.9);
      ctx.beginPath();
      ctx.arc(dx, dy, bowRadiusPx, -Math.PI * 0.35, Math.PI * 0.35);
      ctx.stroke();

      // Bowstring
      ctx.strokeStyle = stringColor;
      ctx.lineWidth = Math.max(0.8, scalePx * 0.5);
      ctx.beginPath();
      const topX = Math.cos(-Math.PI * 0.35) * bowRadiusPx + dx;
      const topY = Math.sin(-Math.PI * 0.35) * bowRadiusPx + dy;
      const botX = Math.cos(Math.PI * 0.35) * bowRadiusPx + dx;
      const botY = Math.sin(Math.PI * 0.35) * bowRadiusPx + dy;
      ctx.moveTo(topX, topY);
      ctx.lineTo(-scalePx * 1.5 + dx, dy);
      ctx.lineTo(botX, botY);
      ctx.stroke();
    };

    // 1. Draw 4 cardinal black outline passes (corners clipped)
    for (let n = 0; n < OUTLINE_NEIGHBOR_OFFSETS.length; n++) {
      const [ox, oy] = OUTLINE_NEIGHBOR_OFFSETS[n];
      drawBowPass(OUTLINE_COLOR, OUTLINE_COLOR, ox * outlineThicknessPx, oy * outlineThicknessPx);
    }

    // 2. Draw foreground pass
    drawBowPass('#8b5a2b', '#ffffff', 0, 0);
  } else if (def.kind === 'staff' || def.kind === 'magic') {
    const staffLenPx = 18 * scalePx;
    const tipX = staffLenPx * 0.8;

    const drawStaffPass = (shaftColor: string, tipColor: string, dx: number, dy: number): void => {
      ctx.strokeStyle = shaftColor;
      ctx.lineWidth = Math.max(1.2, scalePx * 0.9);
      ctx.beginPath();
      ctx.moveTo(-staffLenPx * 0.2 + dx, dy);
      ctx.lineTo(staffLenPx * 0.8 + dx, dy);
      ctx.stroke();

      // Glowing tip
      ctx.fillStyle = tipColor;
      ctx.beginPath();
      ctx.arc(tipX + dx, dy, scalePx * 2.5, 0, Math.PI * 2);
      ctx.fill();
    };

    // 1. Draw 4 cardinal black outline passes (corners clipped)
    for (let n = 0; n < OUTLINE_NEIGHBOR_OFFSETS.length; n++) {
      const [ox, oy] = OUTLINE_NEIGHBOR_OFFSETS[n];
      drawStaffPass(OUTLINE_COLOR, OUTLINE_COLOR, ox * outlineThicknessPx, oy * outlineThicknessPx);
    }

    // 2. Draw foreground pass
    drawStaffPass('#6e4720', color, 0, 0);
  }

  ctx.restore();
}
