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

/** Head marker size in world units (Stick Ranger draws a 5x5 pixel block). */
const HEAD_SIZE_WORLD = 5;

/** Figure colour. White, so the stickman reads against this game's dark rock. */
const FIGURE_COLOR = '#ffffff';

/**
 * Strokes the stickman into `ctx`.
 *
 * @param offsetXPx  Camera X offset, screen pixels.
 * @param offsetYPx  Camera Y offset, screen pixels.
 * @param scalePx    Screen pixels per world unit.
 */
export function renderStickRangerBody(
  ctx: CanvasRenderingContext2D,
  body: StickRangerBody,
  offsetXPx: number,
  offsetYPx: number,
  scalePx: number,
  isTwoHandGrip = false,
): void {
  const alpha = getStickRangerRenderAlpha(body);
  const toScreenX = (i: number): number => getStickRangerRenderX(body, i, alpha) * scalePx + offsetXPx;
  const toScreenY = (i: number): number => getStickRangerRenderY(body, i, alpha) * scalePx + offsetYPx;

  ctx.save();
  ctx.strokeStyle = FIGURE_COLOR;
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
  ctx.fillStyle = FIGURE_COLOR;
  ctx.fillRect(
    toScreenX(SR_HEAD) - headSizePx * 0.5,
    toScreenY(SR_HEAD) - headSizePx * 0.5,
    headSizePx,
    headSizePx,
  );

  ctx.restore();
}
