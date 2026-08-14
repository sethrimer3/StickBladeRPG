/**
 * Tapered glowing trails for a moving point — the tip of a swung blade today,
 * any projectile that wants one tomorrow.
 *
 * Shape: `●══════──────··`. Widest and brightest at the head, narrowing and
 * fading to nothing at the tail, so it reads as a luminous ribbon rather than a
 * beam.
 *
 * ── How the glow is faked ───────────────────────────────────────────────────
 *
 * Two or three translucent strokes of the same geometry at different widths,
 * not a blur. `shadowBlur` and canvas filters cost a full-surface pass per use
 * and would be paid once per blade per frame; overlapping translucent strokes
 * cost a few extra paths and read the same at gameplay speed.
 *
 * ── Coordinates ─────────────────────────────────────────────────────────────
 *
 * Samples are stored in WORLD units and transformed at draw time with the
 * codebase's one convention, `worldValue * zoom + offsetPx`. Storing screen
 * coordinates would detach the trail from its blade the moment the camera moved
 * — the exact bug this renderer's own transform had until recently. Widths
 * scale with zoom, matching how the blade itself is drawn.
 *
 * ── Cost ────────────────────────────────────────────────────────────────────
 *
 * Every trail owns two fixed `Float32Array`s sized at construction and never
 * grows. Sampling, decay, and drawing allocate nothing, and a new sample is
 * only recorded once the head has actually travelled — a stationary blade adds
 * no geometry no matter how long it is held.
 */

import type { GraphicsQuality } from '../../ui/renderSettings';

/** How a trail looks. Every field has a default, so a caller can set only color. */
export interface TrailStyle {
  /** Stroke color. Alpha comes from the layer alphas, so pass an opaque color. */
  color: string;
  /** Width of the ribbon at the head, world units, before layer multipliers. */
  widthWorld: number;
  /** Outermost, faintest layer. */
  outerWidthMultiplier: number;
  outerAlpha: number;
  /** Middle layer. */
  innerWidthMultiplier: number;
  innerAlpha: number;
  /** Bright narrow core; skipped on low quality. */
  coreWidthMultiplier: number;
  coreAlpha: number;
  /** >1 narrows the tail faster; 1 is a straight linear taper. */
  taperExponent: number;
  /** >1 fades the tail faster. */
  opacityExponent: number;
}

/** The defaults a blade trail uses when a weapon overrides only its color. */
export const DEFAULT_TRAIL_STYLE: Readonly<TrailStyle> = Object.freeze({
  color: '#ffffff',
  widthWorld: 2.4,
  outerWidthMultiplier: 2.6,
  outerAlpha: 0.14,
  innerWidthMultiplier: 1.35,
  innerAlpha: 0.3,
  coreWidthMultiplier: 0.5,
  coreAlpha: 0.55,
  taperExponent: 1.6,
  opacityExponent: 1.5,
});

/** Samples and glow layers per quality tier. */
interface TrailQualityTier {
  maxSamples: number;
  layerCount: 1 | 2 | 3;
}

const QUALITY_TIERS: Readonly<Record<GraphicsQuality, TrailQualityTier>> = Object.freeze({
  high: { maxSamples: 8, layerCount: 3 },
  med: { maxSamples: 6, layerCount: 2 },
  low: { maxSamples: 4, layerCount: 1 },
});

/** Largest history any tier asks for — the buffer is sized once, to this. */
const MAX_TRAIL_SAMPLES = 8;

/**
 * Minimum world distance the head must travel before a new sample is kept.
 *
 * Below this the segment would be shorter than the ribbon is wide and would
 * only add overdraw. It also stops a held-still blade from filling the history
 * with identical points.
 */
const MIN_SAMPLE_DISTANCE_WORLD = 1.2;

/**
 * A jump further than this is treated as a teleport — a room change, a respawn,
 * a swing starting somewhere new — and breaks the trail instead of drawing a
 * stripe across the level.
 */
const TELEPORT_BREAK_DISTANCE_WORLD = 64;

/** Below this the segment contributes nothing visible and is skipped. */
const MIN_VISIBLE_ALPHA = 0.01;

/**
 * A short history of world positions, newest first, with the drawing to render
 * it as a tapered ribbon.
 *
 * One instance per trailing thing. `push` every frame it lives, `decay` every
 * frame it does not, `clear` when it is gone.
 */
export class BladeTrail {
  /** Newest-first ring of world positions; only the first `_count` are valid. */
  private readonly _xWorld = new Float32Array(MAX_TRAIL_SAMPLES);
  private readonly _yWorld = new Float32Array(MAX_TRAIL_SAMPLES);
  private _count = 0;

  /** True while the trail has enough history to draw. */
  get isVisible(): boolean {
    return this._count >= 2;
  }

  /** Drops all history. Call when the trailing thing dies or jumps. */
  clear(): void {
    this._count = 0;
  }

  /**
   * Records the head's current world position.
   *
   * Ignored when the head has barely moved, so slow motion does not fill the
   * history with near-duplicates. Breaks the trail outright on a teleport.
   */
  push(xWorld: number, yWorld: number): void {
    if (this._count > 0) {
      const dx = xWorld - this._xWorld[0];
      const dy = yWorld - this._yWorld[0];
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq > TELEPORT_BREAK_DISTANCE_WORLD * TELEPORT_BREAK_DISTANCE_WORLD) {
        this._count = 0;
      } else if (distanceSq < MIN_SAMPLE_DISTANCE_WORLD * MIN_SAMPLE_DISTANCE_WORLD) {
        // Keep the head glued to the blade even when no sample is added, so the
        // ribbon never lags behind the tip it belongs to.
        this._xWorld[0] = xWorld;
        this._yWorld[0] = yWorld;
        return;
      }
    }

    // Shift newest-first. At 8 entries this is cheaper than the bookkeeping a
    // head index would need in the draw loop.
    for (let i = Math.min(this._count, MAX_TRAIL_SAMPLES - 1); i > 0; i--) {
      this._xWorld[i] = this._xWorld[i - 1];
      this._yWorld[i] = this._yWorld[i - 1];
    }
    this._xWorld[0] = xWorld;
    this._yWorld[0] = yWorld;
    if (this._count < MAX_TRAIL_SAMPLES) this._count++;
  }

  /**
   * Retires the oldest sample.
   *
   * Called on frames where nothing is pushing, which lets a finished swing's
   * ribbon shorten away over a few frames instead of vanishing — the fade-out
   * costs one decrement rather than a lingering-effect system.
   */
  decay(): void {
    if (this._count > 0) this._count--;
  }

  /**
   * Draws the ribbon.
   *
   * `ox`/`oy` are camera pixel offsets and `zoom` pixels per world unit — the
   * same triple every other renderer takes, applied as `world * zoom + offset`.
   */
  render(
    ctx: CanvasRenderingContext2D,
    ox: number,
    oy: number,
    zoom: number,
    style: TrailStyle,
    quality: GraphicsQuality,
  ): void {
    if (this._count < 2) return;

    const tier = QUALITY_TIERS[quality] ?? QUALITY_TIERS.med;
    const sampleCount = Math.min(this._count, tier.maxSamples);
    if (sampleCount < 2) return;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = style.color;

    // Outermost first so the brighter, narrower layers land on top of it.
    this._strokeLayer(ctx, ox, oy, zoom, style, sampleCount,
      style.outerWidthMultiplier, style.outerAlpha);
    if (tier.layerCount >= 2) {
      this._strokeLayer(ctx, ox, oy, zoom, style, sampleCount,
        style.innerWidthMultiplier, style.innerAlpha);
    }
    if (tier.layerCount >= 3) {
      this._strokeLayer(ctx, ox, oy, zoom, style, sampleCount,
        style.coreWidthMultiplier, style.coreAlpha);
    }

    ctx.restore();
  }

  /**
   * Strokes one glow layer.
   *
   * Canvas cannot vary a stroke's width along a path, so the ribbon is a run of
   * short segments each stroked at its own width and alpha. Each segment is a
   * quadratic curve from the midpoint before it to the midpoint after it,
   * bending around the sample between them — the standard midpoint smoothing,
   * which costs one curve per segment and removes the polyline's corners.
   */
  private _strokeLayer(
    ctx: CanvasRenderingContext2D,
    ox: number,
    oy: number,
    zoom: number,
    style: TrailStyle,
    sampleCount: number,
    widthMultiplier: number,
    layerAlpha: number,
  ): void {
    const headWidthPx = style.widthWorld * widthMultiplier * zoom;
    const lastIndex = sampleCount - 1;

    for (let i = 0; i < lastIndex; i++) {
      // 0 at the head, 1 at the tail.
      const t = i / lastIndex;
      const alpha = layerAlpha * Math.pow(1 - t, style.opacityExponent);
      if (alpha < MIN_VISIBLE_ALPHA) continue;

      const widthPx = headWidthPx * Math.pow(1 - t, style.taperExponent);
      if (widthPx < 0.25) continue;

      const ax = this._xWorld[i] * zoom + ox;
      const ay = this._yWorld[i] * zoom + oy;
      const bx = this._xWorld[i + 1] * zoom + ox;
      const by = this._yWorld[i + 1] * zoom + oy;

      // Start at the midpoint behind the head, or at the head itself for the
      // first segment so the ribbon actually touches the blade tip.
      let startX = ax;
      let startY = ay;
      if (i > 0) {
        startX = (this._xWorld[i - 1] + this._xWorld[i]) * 0.5 * zoom + ox;
        startY = (this._yWorld[i - 1] + this._yWorld[i]) * 0.5 * zoom + oy;
      }
      // End at the midpoint ahead, or at the final sample for the last segment.
      const endX = i + 1 < lastIndex ? (ax + bx) * 0.5 : bx;
      const endY = i + 1 < lastIndex ? (ay + by) * 0.5 : by;

      ctx.globalAlpha = alpha;
      ctx.lineWidth = widthPx;
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.quadraticCurveTo(ax, ay, endX, endY);
      ctx.stroke();
    }
  }
}
