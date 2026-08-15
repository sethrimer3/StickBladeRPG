/**
 * playerStatusBars.ts — the player's health bar and the resource bar beneath it.
 *
 * One module draws both placements so they cannot drift apart:
 *
 *   - **Overhead** — a small pair floating above the stickman, shown while the
 *     player is damaged (or the resource pool is not full).
 *   - **Top-left HUD** — the same pair at a larger size, drawn by
 *     `playerTopBar.ts`.
 *
 * The lower bar shows whichever pool the *equipped weapon* draws from — Mana
 * for magic weapons and staves, Ammo for guns, Dust for weave weapons (see
 * `sim/weapons/weaponResources.ts`). An unmetered weapon has no second bar.
 *
 * Ammo and Dust switch representation at 13: a maximum of 12 or fewer draws as
 * discrete squares, each separated and individually outlined, so the player can
 * count remaining shots at a glance. 13 or more would make those squares
 * unreadably thin, so it falls back to a solid proportional fill. Health and
 * Mana are always solid — they are continuous quantities with no unit to count.
 *
 * Every bar carries a thin black outline for legibility against arbitrary world
 * backgrounds.
 */

import type { WeaponResourceKind, WeaponResourcePool } from '../../sim/weapons/weaponResources';

// ---- Layout ---------------------------------------------------------------

/** Largest maximum that still draws as countable squares. */
export const SEGMENTED_BAR_MAX_UNITS = 12;

/** Gap between squares in a segmented bar, in virtual pixels. */
const SEGMENT_GAP_PX = 1;

/** Overhead bar geometry, in world-scaled virtual pixels. */
export const OVERHEAD_BAR_WIDTH_PX = 24;
export const OVERHEAD_BAR_HEIGHT_PX = 3;
/** Vertical gap between the health bar and the resource bar below it. */
export const OVERHEAD_BAR_GAP_PX = 2;
/** How far above the stickman's head the pair floats. */
export const OVERHEAD_BAR_RISE_PX = 5;

// ---- Color ramps ----------------------------------------------------------

type ColorStop = readonly [fraction: number, rgb: readonly [number, number, number]];

/**
 * Health: green → yellow → orange → red as the bar empties.
 *
 * Stops are the fractions the design calls out; anything between them is
 * linearly interpolated, so the bar shifts continuously rather than snapping
 * between four flat colors.
 */
const HEALTH_RAMP: readonly ColorStop[] = [
  [1.00, [ 34, 197,  94]], // green
  [0.50, [250, 204,  21]], // yellow
  [0.25, [249, 115,  22]], // orange
  [0.10, [220,  38,  38]], // red
  [0.00, [153,  27,  27]], // deep red
];

/** Mana: deep purple at full, through blue at half, to pale light blue empty. */
const MANA_RAMP: readonly ColorStop[] = [
  [1.00, [ 88,  28, 135]], // deep purple
  [0.50, [ 37,  99, 235]], // blue
  [0.00, [186, 230, 253]], // pale light blue
];

/** Ammo and Dust have no specified gradient; each reads as one flat color. */
const AMMO_COLOR = 'rgb(214,222,230)';
const DUST_COLOR = 'rgb(255,215,0)';

/**
 * Samples a ramp at `fraction`.
 *
 * Ramps are declared high-to-low, so this walks down until it finds the pair
 * bracketing the requested fraction and mixes between them.
 */
export function sampleColorRamp(ramp: readonly ColorStop[], fraction: number): string {
  const f = Math.max(0, Math.min(1, fraction));

  for (let i = 0; i < ramp.length - 1; i++) {
    const [highF, highRgb] = ramp[i];
    const [lowF, lowRgb] = ramp[i + 1];
    if (f > highF) continue;
    if (f < lowF) continue;

    const span = highF - lowF;
    // Two stops at the same fraction would divide by zero; take the lower.
    const t = span > 0 ? (f - lowF) / span : 0;
    const r = Math.round(lowRgb[0] + (highRgb[0] - lowRgb[0]) * t);
    const g = Math.round(lowRgb[1] + (highRgb[1] - lowRgb[1]) * t);
    const b = Math.round(lowRgb[2] + (highRgb[2] - lowRgb[2]) * t);
    return `rgb(${r},${g},${b})`;
  }

  const [, endRgb] = ramp[ramp.length - 1];
  return `rgb(${endRgb[0]},${endRgb[1]},${endRgb[2]})`;
}

/** Health fill color at the given fraction. */
export function getHealthBarColor(fraction: number): string {
  return sampleColorRamp(HEALTH_RAMP, fraction);
}

/** Mana fill color at the given fraction. */
export function getManaBarColor(fraction: number): string {
  return sampleColorRamp(MANA_RAMP, fraction);
}

/** Fill color for a resource pool of the given kind at the given fraction. */
export function getResourceBarColor(kind: WeaponResourceKind, fraction: number): string {
  if (kind === 'mana') return getManaBarColor(fraction);
  return kind === 'ammo' ? AMMO_COLOR : DUST_COLOR;
}

/**
 * True when a pool of this kind and capacity draws as countable squares.
 *
 * Mana is always solid regardless of size; only Ammo and Dust are counted in
 * discrete units.
 */
export function isSegmentedResource(kind: WeaponResourceKind, max: number): boolean {
  if (kind === 'mana') return false;
  return max > 0 && max <= SEGMENTED_BAR_MAX_UNITS;
}

// ---- Primitives -----------------------------------------------------------

/** Thin black outline drawn 0.5px off-grid so a 1px stroke lands on pixels. */
function strokeOutline(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  ctx.strokeStyle = 'rgba(0,0,0,0.9)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x - 0.5, y - 0.5, w + 1, h + 1);
}

/**
 * Draws a solid proportional bar: dark bed, colored fill, black outline.
 *
 * The outline is stroked last so the fill cannot bleed over it.
 */
export function drawSolidBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  fraction: number,
  fillColor: string,
): void {
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(x, y, w, h);

  const fillW = w * Math.max(0, Math.min(1, fraction));
  if (fillW > 0) {
    ctx.fillStyle = fillColor;
    ctx.fillRect(x, y, fillW, h);
    // Shine along the top edge, matching the existing HUD bars.
    if (h >= 3) {
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.fillRect(x, y, fillW, 1);
    }
  }

  strokeOutline(ctx, x, y, w, h);
}

/**
 * Draws a bar of `max` separated squares, `current` of them filled.
 *
 * Each square gets its own black outline, so the units read as distinct
 * pips rather than one divided bar. Square width is derived from the space
 * left after the gaps, and is floored at 1px so a 12-unit bar in a narrow
 * overhead slot still renders something countable.
 */
export function drawSegmentedBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  current: number,
  max: number,
  fillColor: string,
): void {
  const count = Math.max(1, Math.floor(max));
  const totalGap = SEGMENT_GAP_PX * (count - 1);
  const segmentW = Math.max(1, (w - totalGap) / count);
  const filled = Math.max(0, Math.min(count, Math.floor(current)));

  for (let i = 0; i < count; i++) {
    const segX = x + i * (segmentW + SEGMENT_GAP_PX);
    ctx.fillStyle = i < filled ? fillColor : 'rgba(0,0,0,0.65)';
    ctx.fillRect(segX, y, segmentW, h);
    strokeOutline(ctx, segX, y, segmentW, h);
  }
}

/**
 * Draws a resource pool, choosing the segmented or solid representation.
 *
 * This is the one place the 13-unit threshold is applied, so the overhead bar
 * and the top-left HUD bar can never disagree about which form to use.
 */
export function drawResourceBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  kind: WeaponResourceKind,
  pool: WeaponResourcePool,
): void {
  const max = Math.max(0, Math.floor(pool.max));
  if (max <= 0) return;

  const current = Math.max(0, Math.min(pool.current, max));
  const fraction = current / max;
  const color = getResourceBarColor(kind, fraction);

  if (isSegmentedResource(kind, max)) {
    drawSegmentedBar(ctx, x, y, w, h, current, max, color);
    return;
  }
  drawSolidBar(ctx, x, y, w, h, fraction, color);
}

// ---- Overhead pair --------------------------------------------------------

/** What the overhead bars need to know, resolved by the caller. */
export interface PlayerOverheadBarState {
  /** Player center in world units. */
  positionXWorld: number;
  positionYWorld: number;
  halfHeightWorld: number;
  healthPoints: number;
  maxHealthPoints: number;
  /** Pool the equipped weapon draws from, or null when it is unmetered. */
  resourceKind: WeaponResourceKind | null;
  resourcePool: WeaponResourcePool | null;
}

/**
 * True when the overhead pair should be on screen at all.
 *
 * Shown while the player is damaged, as specified — and also while the resource
 * pool is short, because a full-health player firing a gun still needs to see
 * the magazine draining.
 */
export function shouldShowOverheadBars(state: PlayerOverheadBarState): boolean {
  if (state.maxHealthPoints > 0 && state.healthPoints < state.maxHealthPoints) return true;
  const pool = state.resourcePool;
  if (state.resourceKind !== null && pool !== null && pool.max > 0 && pool.current < pool.max) {
    return true;
  }
  return false;
}

/**
 * Draws the health bar and resource bar above the stickman.
 *
 * `ox`/`oy`/`zoom` are the camera transform, matching the convention the rest
 * of the HUD renderer uses. Leaves canvas state as it found it.
 */
export function drawPlayerOverheadBars(
  ctx: CanvasRenderingContext2D,
  state: PlayerOverheadBarState,
  ox: number,
  oy: number,
  zoom: number,
): void {
  if (!shouldShowOverheadBars(state)) return;

  const w = OVERHEAD_BAR_WIDTH_PX;
  const h = OVERHEAD_BAR_HEIGHT_PX;
  const barX = state.positionXWorld * zoom + ox - w / 2;
  const healthY = (state.positionYWorld - state.halfHeightWorld - OVERHEAD_BAR_RISE_PX) * zoom + oy;

  ctx.save();
  // The caller's cluster loop leaves `globalAlpha` at whatever the previous
  // entity's fade set it to; the player's bars do not fade, so reset it.
  ctx.globalAlpha = 1;

  const maxHp = Math.max(0, state.maxHealthPoints);
  const healthFraction = maxHp > 0 ? Math.max(0, Math.min(1, state.healthPoints / maxHp)) : 0;
  drawSolidBar(ctx, barX, healthY, w, h, healthFraction, getHealthBarColor(healthFraction));

  if (state.resourceKind !== null && state.resourcePool !== null) {
    drawResourceBar(
      ctx,
      barX,
      healthY + h + OVERHEAD_BAR_GAP_PX,
      w,
      h,
      state.resourceKind,
      state.resourcePool,
    );
  }

  ctx.restore();
}
