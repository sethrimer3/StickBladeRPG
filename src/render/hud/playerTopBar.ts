/**
 * playerTopBar.ts — player status bar drawn along the top-left of the HUD.
 *
 * Shows, left to right:
 *   • A simple life bar with numeric current/max HP
 *   • The equipped weapon slot (name, or "Unarmed")
 *
 * The dust-mote container indicators for life are temporarily disabled in
 * favour of this bar; see `MOTE_LIFE_CONTAINERS_ENABLED`.
 */

/**
 * Temporary switch: while false, `gameHudRenderer` draws this top bar instead
 * of the per-mote dust container life indicators. Flip back to true to restore
 * the container display.
 */
export const MOTE_LIFE_CONTAINERS_ENABLED = false;

// ── Layout constants (virtual pixels) ───────────────────────────────────────

export const TOP_BAR_ORIGIN_X_PX = 8;
export const TOP_BAR_ORIGIN_Y_PX = 8;
export const TOP_BAR_HEIGHT_PX = 12;

const LIFE_BAR_WIDTH_PX = 72;
const LIFE_BAR_HEIGHT_PX = 8;
const LIFE_BAR_Y_OFFSET_PX = 2;

const WEAPON_SLOT_GAP_PX = 8;
const WEAPON_SLOT_WIDTH_PX = 64;

/** Health fractions at which the fill color escalates. */
const LIFE_DANGER_FRACTION = 0.40;
const LIFE_CRITICAL_FRACTION = 0.20;

export interface PlayerTopBarState {
  /** Current HP, may exceed `maxHp` when overhealth is active. */
  currentHp: number;
  /** Maximum HP (permanent capacity). */
  maxHp: number;
  /** Equipped weapon display name, or null when unarmed. */
  weaponName: string | null;
}

/** X position where the weapon slot begins, for callers placing badges after it. */
export function getTopBarWidthPx(): number {
  return LIFE_BAR_WIDTH_PX + WEAPON_SLOT_GAP_PX + WEAPON_SLOT_WIDTH_PX;
}

function getLifeFillColor(healthFraction: number, nowMs: number): string {
  if (healthFraction < LIFE_CRITICAL_FRACTION) {
    const pulseT = (Math.sin(nowMs * 0.008) + 1) * 0.5;
    return `rgb(${Math.round(210 + 45 * pulseT)},25,25)`;
  }
  if (healthFraction < LIFE_DANGER_FRACTION) return '#e07000';
  return '#00b866';
}

/** Draws the player status top bar. Leaves canvas state as it found it. */
export function drawPlayerTopBar(
  ctx: CanvasRenderingContext2D,
  state: PlayerTopBarState,
  nowMs: number,
): void {
  const maxHp = Math.max(0, Math.floor(state.maxHp));
  const currentHp = Math.max(0, Math.floor(state.currentHp));
  const permanentHp = Math.min(currentHp, maxHp);
  const overhealthHp = currentHp - permanentHp;
  const healthFraction = maxHp > 0 ? permanentHp / maxHp : 0;

  const barX = TOP_BAR_ORIGIN_X_PX;
  const barY = TOP_BAR_ORIGIN_Y_PX + LIFE_BAR_Y_OFFSET_PX;

  ctx.save();
  ctx.textBaseline = 'middle';

  // ── Life bar ──────────────────────────────────────────────────────────────
  ctx.fillStyle = 'rgba(0,0,0,0.78)';
  ctx.fillRect(barX, barY, LIFE_BAR_WIDTH_PX, LIFE_BAR_HEIGHT_PX);

  const fillW = LIFE_BAR_WIDTH_PX * healthFraction;
  if (fillW > 0) {
    ctx.fillStyle = getLifeFillColor(healthFraction, nowMs);
    ctx.fillRect(barX, barY, fillW, LIFE_BAR_HEIGHT_PX);
    // Inner shine along the top edge.
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillRect(barX, barY, fillW, 1);
  }

  // Overhealth reads as a gold overlay filling from the left of the bar.
  if (overhealthHp > 0 && maxHp > 0) {
    const overFraction = Math.min(1, overhealthHp / maxHp);
    ctx.fillStyle = 'rgba(255,215,90,0.85)';
    ctx.fillRect(barX, barY, LIFE_BAR_WIDTH_PX * overFraction, 2);
  }

  // Gold outline, offset 0.5 px so the 1 px stroke lands on the pixel grid.
  ctx.strokeStyle = '#c89820';
  ctx.lineWidth = 1;
  ctx.strokeRect(barX - 0.5, barY - 0.5, LIFE_BAR_WIDTH_PX + 1, LIFE_BAR_HEIGHT_PX + 1);

  // Numeric readout centered on the bar.
  const hpText = `${currentHp}/${maxHp}`;
  ctx.font = 'bold 7px monospace';
  ctx.textAlign = 'center';
  const hpTextX = barX + LIFE_BAR_WIDTH_PX * 0.5;
  const hpTextY = barY + LIFE_BAR_HEIGHT_PX * 0.5;
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.fillText(hpText, hpTextX + 1, hpTextY + 1);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(hpText, hpTextX, hpTextY);

  // ── Equipped weapon slot ──────────────────────────────────────────────────
  const slotX = barX + LIFE_BAR_WIDTH_PX + WEAPON_SLOT_GAP_PX;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(slotX, barY, WEAPON_SLOT_WIDTH_PX, LIFE_BAR_HEIGHT_PX);
  ctx.strokeStyle = 'rgba(200,152,32,0.7)';
  ctx.lineWidth = 1;
  ctx.strokeRect(slotX - 0.5, barY - 0.5, WEAPON_SLOT_WIDTH_PX + 1, LIFE_BAR_HEIGHT_PX + 1);

  const weaponText = state.weaponName ?? 'Unarmed';
  ctx.font = '7px monospace';
  ctx.textAlign = 'left';
  const weaponTextX = slotX + 3;
  ctx.save();
  // Clip so a long weapon name cannot spill outside its slot.
  ctx.beginPath();
  ctx.rect(slotX, barY, WEAPON_SLOT_WIDTH_PX, LIFE_BAR_HEIGHT_PX);
  ctx.clip();
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.fillText(weaponText, weaponTextX + 1, hpTextY + 1);
  ctx.fillStyle = state.weaponName ? '#ffe9a8' : '#9a9a9a';
  ctx.fillText(weaponText, weaponTextX, hpTextY);
  ctx.restore();

  ctx.restore();
}
