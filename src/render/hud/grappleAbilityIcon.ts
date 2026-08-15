/**
 * grappleAbilityIcon.ts — grapple ability HUD icon, drawn just below the
 * player's health/top bar.
 *
 * The icon body (hook glyph + recharge fill) is drawn on the virtual canvas
 * like the rest of the pixel-art HUD, via `drawGrappleAbilityIcon`. The
 * bound-key label in its bottom-right corner is drawn separately, on the
 * device (full-resolution) canvas after the virtual→device upscale — the
 * same convention `dustSelectionWheelRenderer.ts` uses — so the label reads
 * as crisp system-font text instead of inheriting the game's native
 * pixel-art blockiness.
 */

import type { WorldState } from '../../sim/world';
import { TOP_BAR_ORIGIN_X_PX, TOP_BAR_ORIGIN_Y_PX, TOP_BAR_HEIGHT_PX } from './playerTopBar';
import { getKeyboardBindings, displayKey } from '../../input/keybindings';

// ── Layout constants (virtual pixels) ───────────────────────────────────────

const ICON_GAP_BELOW_TOP_BAR_PX = 4;
export const GRAPPLE_ICON_X_PX = TOP_BAR_ORIGIN_X_PX;
export const GRAPPLE_ICON_Y_PX = TOP_BAR_ORIGIN_Y_PX + TOP_BAR_HEIGHT_PX + ICON_GAP_BELOW_TOP_BAR_PX;
export const GRAPPLE_ICON_SIZE_PX = 14;

/** Duration of the "recharging" diagonal-stripe animation loop, in ms. */
const RECHARGE_STRIPE_CYCLE_MS = 900;

/** Returns the current key bound to the grapple ability, for display. */
export function getGrappleAbilityKeyLabel(): string {
  return displayKey(getKeyboardBindings().grappleFire);
}

/**
 * Draws the grapple ability icon (background, hook glyph, recharge state)
 * onto the virtual canvas. Leaves canvas state as it found it.
 */
export function drawGrappleAbilityIcon(
  ctx: CanvasRenderingContext2D,
  world: WorldState,
  nowMs: number,
): void {
  const x = GRAPPLE_ICON_X_PX;
  const y = GRAPPLE_ICON_Y_PX;
  const size = GRAPPLE_ICON_SIZE_PX;
  const isCharged = world.hasGrappleChargeFlag === 1;
  const isRechargeFlashActive = world.grappleRechargeRingTicksLeft > 0;

  ctx.save();

  // ── Background + gold frame, matching the top bar's styling ─────────────
  ctx.fillStyle = 'rgba(0,0,0,0.78)';
  ctx.fillRect(x, y, size, size);
  ctx.strokeStyle = '#c89820';
  ctx.lineWidth = 1;
  ctx.strokeRect(x - 0.5, y - 0.5, size + 1, size + 1);

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, size, size);
  ctx.clip();

  if (!isCharged) {
    // ── Recharging: looping diagonal stripes signal "in progress" — the
    // grapple charge restores on ground contact rather than a fixed timer,
    // so there is no fill fraction to animate toward; the stripes just need
    // to read as "not ready yet, working on it".
    const stripeOffset = (nowMs / RECHARGE_STRIPE_CYCLE_MS) % 1;
    ctx.fillStyle = 'rgba(120,120,130,0.35)';
    ctx.fillRect(x, y, size, size);
    ctx.fillStyle = 'rgba(200,200,215,0.28)';
    const stripeSpacing = 5;
    const travel = stripeOffset * stripeSpacing;
    for (let sx = -size - travel; sx < size * 2; sx += stripeSpacing) {
      ctx.beginPath();
      ctx.moveTo(x + sx, y + size);
      ctx.lineTo(x + sx + size, y);
      ctx.lineTo(x + sx + size + 1.5, y);
      ctx.lineTo(x + sx + 1.5, y + size);
      ctx.closePath();
      ctx.fill();
    }
  } else {
    // ── Ready: solid teal fill behind the glyph.
    ctx.fillStyle = 'rgba(20,150,140,0.55)';
    ctx.fillRect(x, y, size, size);

    if (isRechargeFlashActive) {
      // ── Just became ready: brief bright pulse fading out over the same
      // window as the world-space recharge ring VFX, so both read as one
      // coherent "recharged" moment.
      const flashT = world.grappleRechargeRingTicksLeft / world.grappleRechargeRingTotalTicks;
      ctx.fillStyle = `rgba(255,235,150,${0.55 * flashT})`;
      ctx.fillRect(x, y, size, size);
    }
  }

  // ── Hook glyph: a simple J-shaped hook, readable at this size ────────────
  const glyphColor = isCharged ? '#eafff8' : 'rgba(220,220,230,0.55)';
  ctx.strokeStyle = glyphColor;
  ctx.lineWidth = 1.4;
  ctx.lineCap = 'round';
  const cx = x + size * 0.5;
  const topY = y + size * 0.22;
  const bottomY = y + size * 0.68;
  ctx.beginPath();
  ctx.moveTo(cx, topY);
  ctx.lineTo(cx, bottomY);
  ctx.arc(cx - size * 0.14, bottomY, size * 0.14, 0, Math.PI * 0.95);
  ctx.stroke();

  ctx.restore(); // clip

  ctx.restore();
}

/**
 * Draws the bound-key label in the bottom-right corner of the grapple icon,
 * directly onto the device (post-upscale) canvas so the text stays crisp
 * regardless of the virtual canvas resolution.
 *
 * @param scaleX device-canvas-width / virtual-canvas-width
 * @param scaleY device-canvas-height / virtual-canvas-height
 */
export function drawGrappleAbilityKeyLabel(
  deviceCtx: CanvasRenderingContext2D,
  scaleX: number,
  scaleY: number,
  keyLabel: string,
): void {
  const iconRightPx = (GRAPPLE_ICON_X_PX + GRAPPLE_ICON_SIZE_PX) * scaleX;
  const iconBottomPx = (GRAPPLE_ICON_Y_PX + GRAPPLE_ICON_SIZE_PX) * scaleY;

  const fontPx = Math.max(9, Math.round(6.5 * Math.min(scaleX, scaleY)));

  deviceCtx.save();
  deviceCtx.font = `bold ${fontPx}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  deviceCtx.textAlign = 'right';
  deviceCtx.textBaseline = 'alphabetic';

  const paddingPx = Math.max(1, fontPx * 0.12);
  const labelX = iconRightPx - paddingPx;
  const labelY = iconBottomPx - paddingPx;

  // Dark outline for legibility over any icon state/background.
  deviceCtx.lineWidth = Math.max(2, fontPx * 0.28);
  deviceCtx.strokeStyle = 'rgba(0,0,0,0.85)';
  deviceCtx.lineJoin = 'round';
  deviceCtx.strokeText(keyLabel, labelX, labelY);

  deviceCtx.fillStyle = '#ffffff';
  deviceCtx.fillText(keyLabel, labelX, labelY);

  deviceCtx.restore();
}
