/**
 * enemyDeathPixelEffect.ts — Render-only enemy death disintegration effect.
 *
 * When an enemy dies, its rendered sprite / visual representation falls apart into
 * physical pixels:
 *   1. Exactly 25% of the opaque pixels making up the enemy's rendering persist
 *      with their true rendered colors.
 *   2. The pixels explode outward gently in random directions across a 360-degree area.
 *   3. They gently arc toward the ground under gravity and interact with physical
 *      space, bouncing off floors and walls and settling.
 *   4. Each pixel disappears independently after a random lifetime of 1 to 5 seconds.
 *
 * Purely visual — never mutates WorldState, enemy simulation, or save data.
 * Allocation-free during update/render via bounded typed-array pools.
 */

import { ParticleKind } from '../sim/particles/kinds';
import { loadImg, isSpriteReady } from './imageCache';

/** Maximum concurrent enemy death pixel particles. */
export const MAX_ENEMY_DEATH_PIXELS = 1024;

/** Gravity acceleration pulling pixels downward (world units/s^2). */
export const ENEMY_DEATH_PIXEL_GRAVITY_WORLD_PER_SEC2 = 200.0;

/** Exponential air drag coefficient applied per second. */
export const ENEMY_DEATH_PIXEL_DRAG_PER_SEC = 0.5;

/** Minimum and maximum gentle outward explosion speed (world units/s). */
export const ENEMY_DEATH_PIXEL_SPEED_MIN_WORLD = 25.0;
export const ENEMY_DEATH_PIXEL_SPEED_MAX_WORLD = 80.0;

/** Fraction of perpendicular velocity retained after bouncing off a surface. */
export const ENEMY_DEATH_PIXEL_BOUNCE_DAMPING = 0.55;

/** Ground friction slowing horizontal sliding per second. */
export const ENEMY_DEATH_PIXEL_GROUND_FRICTION_PER_SEC = 4.0;

/** Minimum and maximum lifetime of a single pixel particle in milliseconds (1 to 5 seconds). */
export const ENEMY_DEATH_PIXEL_LIFETIME_MIN_MS = 1000;
export const ENEMY_DEATH_PIXEL_LIFETIME_MAX_MS = 5000;

/** Duration of the smooth alpha fade-out before expiration (ms). */
export const ENEMY_DEATH_PIXEL_FADE_OUT_MS = 300;

/** Persistence ratio: exactly 25% of the enemy's pixels persist after death. */
export const ENEMY_DEATH_PIXEL_PERSISTENCE_RATIO = 0.25;

/** World units per native sprite pixel (6 world units per 16 native pixels). */
export const WORLD_UNITS_PER_NATIVE_PIXEL = 6.0 / 16.0;

export interface EnemyPixelSample {
  readonly xWorld: number;
  readonly yWorld: number;
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface WallGeometrySource {
  readonly count?: number;
  readonly wallCount?: number;
  readonly xWorld?: ArrayLike<number>;
  readonly yWorld?: ArrayLike<number>;
  readonly wWorld?: ArrayLike<number>;
  readonly hWorld?: ArrayLike<number>;
  readonly wallXWorld?: ArrayLike<number>;
  readonly wallYWorld?: ArrayLike<number>;
  readonly wallWWorld?: ArrayLike<number>;
  readonly wallHWorld?: ArrayLike<number>;
}

/** Deterministic LCG PRNG factory for reproducible visual effects and testing. */
export function makeDeterministicRng(seed: number): () => number {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xFFFFFFFF;
  };
}

/**
 * Deterministically samples exactly 25% of the opaque pixels from `pixels`.
 * Returns a subset containing `Math.max(1, Math.round(pixels.length * 0.25))` entries.
 */
export function samplePersistingPixels(
  pixels: ReadonlyArray<EnemyPixelSample>,
  rng: () => number,
): EnemyPixelSample[] {
  if (pixels.length === 0) return [];
  const targetCount = Math.max(1, Math.round(pixels.length * ENEMY_DEATH_PIXEL_PERSISTENCE_RATIO));
  if (targetCount >= pixels.length) return pixels.slice();

  // Pick targetCount distinct indices using Fisher-Yates-like random selection without full copy
  const indices: number[] = new Array(pixels.length);
  for (let i = 0; i < pixels.length; i++) indices[i] = i;

  const picked: EnemyPixelSample[] = [];
  for (let n = 0; n < targetCount; n++) {
    const pickIdx = n + Math.floor(rng() * (pixels.length - n));
    const chosen = indices[pickIdx];
    indices[pickIdx] = indices[n];
    indices[n] = chosen;
    picked.push(pixels[chosen]);
  }
  return picked;
}

export class EnemyDeathPixelEffect {
  private count = 0;
  private readonly xWorld = new Float32Array(MAX_ENEMY_DEATH_PIXELS);
  private readonly yWorld = new Float32Array(MAX_ENEMY_DEATH_PIXELS);
  private readonly vxWorld = new Float32Array(MAX_ENEMY_DEATH_PIXELS);
  private readonly vyWorld = new Float32Array(MAX_ENEMY_DEATH_PIXELS);
  private readonly ageMs = new Float32Array(MAX_ENEMY_DEATH_PIXELS);
  private readonly lifetimeMs = new Float32Array(MAX_ENEMY_DEATH_PIXELS);
  private readonly colorR = new Uint8Array(MAX_ENEMY_DEATH_PIXELS);
  private readonly colorG = new Uint8Array(MAX_ENEMY_DEATH_PIXELS);
  private readonly colorB = new Uint8Array(MAX_ENEMY_DEATH_PIXELS);

  /**
   * Spawns pixel particles from a full list of opaque pixel samples.
   * Exactly 25% of the samples will be selected to persist, each given:
   *  - 360-degree outward explosion velocity
   *  - Gentle initial speed
   *  - Individual 1-5 second randomized lifetime
   */
  trigger(
    allOpaquePixels: ReadonlyArray<EnemyPixelSample>,
    seed: number = 1,
  ): void {
    if (allOpaquePixels.length === 0) return;
    const rng = makeDeterministicRng(seed);
    const persisting = samplePersistingPixels(allOpaquePixels, rng);

    for (let p = 0; p < persisting.length; p++) {
      const sample = persisting[p];
      let idx: number;
      if (this.count < MAX_ENEMY_DEATH_PIXELS) {
        idx = this.count++;
      } else {
        idx = this.recycleOldest();
      }

      const angleRad = rng() * Math.PI * 2;
      const speed = ENEMY_DEATH_PIXEL_SPEED_MIN_WORLD +
        rng() * (ENEMY_DEATH_PIXEL_SPEED_MAX_WORLD - ENEMY_DEATH_PIXEL_SPEED_MIN_WORLD);

      this.xWorld[idx] = sample.xWorld;
      this.yWorld[idx] = sample.yWorld;
      this.vxWorld[idx] = Math.cos(angleRad) * speed;
      this.vyWorld[idx] = Math.sin(angleRad) * speed;
      this.ageMs[idx] = 0;
      this.lifetimeMs[idx] = ENEMY_DEATH_PIXEL_LIFETIME_MIN_MS +
        rng() * (ENEMY_DEATH_PIXEL_LIFETIME_MAX_MS - ENEMY_DEATH_PIXEL_LIFETIME_MIN_MS);
      this.colorR[idx] = sample.r;
      this.colorG[idx] = sample.g;
      this.colorB[idx] = sample.b;
    }
  }

  /** Current active pixel count. */
  get particleCount(): number {
    return this.count;
  }

  /** Advances physics simulation, gravity, ground/wall collisions, and lifetimes. */
  update(dtMs: number, walls?: WallGeometrySource | null): void {
    if (this.count === 0) return;
    const dt = dtMs / 1000.0;

    // Resolve wall array access whether from snapshot (walls.xWorld) or world (wallXWorld)
    const wallCount = walls ? (walls.count ?? walls.wallCount ?? 0) : 0;
    const wallX = walls ? (walls.xWorld ?? walls.wallXWorld) : undefined;
    const wallY = walls ? (walls.yWorld ?? walls.wallYWorld) : undefined;
    const wallW = walls ? (walls.wWorld ?? walls.wallWWorld) : undefined;
    const wallH = walls ? (walls.hWorld ?? walls.wallHWorld) : undefined;
    const hasWalls = wallCount > 0 && wallX && wallY && wallW && wallH;

    for (let i = this.count - 1; i >= 0; i--) {
      this.ageMs[i] += dtMs;
      if (this.ageMs[i] >= this.lifetimeMs[i]) {
        this.removeAt(i);
        continue;
      }

      // Gravity & air drag
      this.vyWorld[i] += ENEMY_DEATH_PIXEL_GRAVITY_WORLD_PER_SEC2 * dt;
      const dragFactor = Math.max(0, 1 - ENEMY_DEATH_PIXEL_DRAG_PER_SEC * dt);
      this.vxWorld[i] *= dragFactor;
      this.vyWorld[i] *= dragFactor;

      const prevX = this.xWorld[i];
      const prevY = this.yWorld[i];
      let nextX = prevX + this.vxWorld[i] * dt;
      let nextY = prevY + this.vyWorld[i] * dt;

      // Physical space / wall & ground collision
      if (hasWalls) {
        for (let wi = 0; wi < wallCount; wi++) {
          const wx = wallX[wi];
          const wy = wallY[wi];
          const ww = wallW[wi];
          const wh = wallH[wi];

          // ── Ground collision (top face wy, moving downward) ──
          if (this.vyWorld[i] > 0) {
            if (nextX >= wx - 0.2 && nextX <= wx + ww + 0.2 && prevY <= wy + 0.5 && nextY >= wy) {
              nextY = wy - 0.05;
              this.vyWorld[i] = -this.vyWorld[i] * ENEMY_DEATH_PIXEL_BOUNCE_DAMPING;
              this.vxWorld[i] *= Math.max(0, 1 - ENEMY_DEATH_PIXEL_GROUND_FRICTION_PER_SEC * dt);
              if (Math.abs(this.vyWorld[i]) < 6.0) {
                this.vyWorld[i] = 0;
              }
              continue;
            }
          }

          // ── Ceiling collision (bottom face wy + wh, moving upward) ──
          if (this.vyWorld[i] < 0) {
            if (nextX >= wx - 0.2 && nextX <= wx + ww + 0.2 && prevY >= wy + wh - 0.5 && nextY <= wy + wh) {
              nextY = wy + wh + 0.05;
              this.vyWorld[i] = -this.vyWorld[i] * ENEMY_DEATH_PIXEL_BOUNCE_DAMPING;
              continue;
            }
          }

          // ── Left wall collision (face wx, moving right) ──
          if (this.vxWorld[i] > 0) {
            if (nextY >= wy && nextY <= wy + wh && prevX <= wx + 0.5 && nextX >= wx) {
              nextX = wx - 0.05;
              this.vxWorld[i] = -this.vxWorld[i] * ENEMY_DEATH_PIXEL_BOUNCE_DAMPING;
              continue;
            }
          }

          // ── Right wall collision (face wx + ww, moving left) ──
          if (this.vxWorld[i] < 0) {
            if (nextY >= wy && nextY <= wy + wh && prevX >= wx + ww - 0.5 && nextX <= wx + ww) {
              nextX = wx + ww + 0.05;
              this.vxWorld[i] = -this.vxWorld[i] * ENEMY_DEATH_PIXEL_BOUNCE_DAMPING;
              continue;
            }
          }
        }
      }

      this.xWorld[i] = nextX;
      this.yWorld[i] = nextY;
    }
  }

  /** Renders all active bouncing death pixels on the canvas. */
  render(
    ctx: CanvasRenderingContext2D,
    offsetXPx: number,
    offsetYPx: number,
    scalePx: number,
  ): void {
    if (this.count === 0) return;
    ctx.save();
    ctx.imageSmoothingEnabled = false;

    for (let i = 0; i < this.count; i++) {
      const remainingMs = this.lifetimeMs[i] - this.ageMs[i];
      let alpha = 1.0;
      if (remainingMs < ENEMY_DEATH_PIXEL_FADE_OUT_MS) {
        alpha = Math.max(0, remainingMs / ENEMY_DEATH_PIXEL_FADE_OUT_MS);
      }
      if (alpha <= 0) continue;

      const sx = Math.round(this.xWorld[i] * scalePx + offsetXPx);
      const sy = Math.round(this.yWorld[i] * scalePx + offsetYPx);

      ctx.globalAlpha = alpha;
      ctx.fillStyle = `rgb(${this.colorR[i]},${this.colorG[i]},${this.colorB[i]})`;
      ctx.fillRect(sx, sy, 1, 1);
    }

    ctx.globalAlpha = 1.0;
    ctx.restore();
  }

  /** Clears all particles from the pool. */
  reset(): void {
    this.count = 0;
  }

  /** Reads a particle's current world state (for unit testing). */
  getParticle(index: number): {
    xWorld: number;
    yWorld: number;
    vxWorld: number;
    vyWorld: number;
    ageMs: number;
    lifetimeMs: number;
    r: number;
    g: number;
    b: number;
  } | undefined {
    if (index < 0 || index >= this.count) return undefined;
    return {
      xWorld: this.xWorld[index],
      yWorld: this.yWorld[index],
      vxWorld: this.vxWorld[index],
      vyWorld: this.vyWorld[index],
      ageMs: this.ageMs[index],
      lifetimeMs: this.lifetimeMs[index],
      r: this.colorR[index],
      g: this.colorG[index],
      b: this.colorB[index],
    };
  }

  private removeAt(i: number): void {
    this.count--;
    this.xWorld[i] = this.xWorld[this.count];
    this.yWorld[i] = this.yWorld[this.count];
    this.vxWorld[i] = this.vxWorld[this.count];
    this.vyWorld[i] = this.vyWorld[this.count];
    this.ageMs[i] = this.ageMs[this.count];
    this.lifetimeMs[i] = this.lifetimeMs[this.count];
    this.colorR[i] = this.colorR[this.count];
    this.colorG[i] = this.colorG[this.count];
    this.colorB[i] = this.colorB[this.count];
  }

  private recycleOldest(): number {
    let oldestIdx = 0;
    let oldestFrac = this.ageMs[0] / this.lifetimeMs[0];
    for (let i = 1; i < this.count; i++) {
      const frac = this.ageMs[i] / this.lifetimeMs[i];
      if (frac > oldestFrac) {
        oldestFrac = frac;
        oldestIdx = i;
      }
    }
    return oldestIdx;
  }
}

export interface ClusterLike {
  readonly positionXWorld: number;
  readonly positionYWorld: number;
  readonly halfWidthWorld: number;
  readonly halfHeightWorld: number;
  readonly isFlyingEyeFlag?: number;
  readonly flyingEyeElementKind?: number;
  readonly isRollingEnemyFlag?: number;
  readonly isRockElementalFlag?: number;
  readonly isRadiantTetherFlag?: number;
  readonly isRadiantWebFlag?: number;
  readonly isCrimsonWizardFlag?: number;
  readonly isHeraldFlag?: number;
  readonly isIceWizardFlag?: number;
  readonly isGrappleHunterFlag?: number;
  readonly isSlimeFlag?: number;
  readonly isLargeSlimeFlag?: number;
  readonly isWheelEnemyFlag?: number;
  readonly isBeetleFlag?: number;
  readonly beetleIsFlightModeFlag?: number;
  readonly isBubbleEnemyFlag?: number;
  readonly isIceBubbleFlag?: number;
  readonly isSquareStampedeFlag?: number;
  readonly isGoldenMimicFlag?: number;
  readonly isBeeSwarmFlag?: number;
  readonly isDustConstellationFlag?: number;
  readonly isOrbitalDustCoreFlag?: number;
  readonly isDustBlockMimicFlag?: number;
  readonly isDustLeechFlag?: number;
  readonly isDustEchoFlag?: number;
  readonly isGridSnakeEnemyFlag?: number;
  readonly isGridBlockEnemyFlag?: number;
  readonly isMomentumTurretFlag?: number;
  readonly isSlimeSnailFlag?: number;
  readonly isShadowEnemyFlag?: number;
  readonly isNeedleUrchinFlag?: number;
}

// ── Pure fallback color resolver for enemy types ──────────────────────────

export function getEnemyPrimaryColor(cluster: ClusterLike): { r: number; g: number; b: number } {
  if (cluster.isFlyingEyeFlag === 1) {
    switch (cluster.flyingEyeElementKind as ParticleKind) {
      case ParticleKind.Fire: return { r: 255, g: 85, b: 34 };
      case ParticleKind.Ice:  return { r: 68, g: 204, b: 255 };
      case ParticleKind.Wind: return { r: 136, g: 255, b: 170 };
      default:                return { r: 204, g: 204, b: 255 };
    }
  }
  if (cluster.isRockElementalFlag === 1) return { r: 139, g: 105, b: 20 };
  if (cluster.isRadiantTetherFlag === 1) return { r: 255, g: 253, b: 224 };
  if (cluster.isRadiantWebFlag === 1) return { r: 170, g: 255, b: 221 };
  if (cluster.isCrimsonWizardFlag === 1) return { r: 255, g: 59, b: 36 };
  if (cluster.isHeraldFlag === 1) return { r: 162, g: 102, b: 255 };
  if (cluster.isIceWizardFlag === 1) return { r: 142, g: 238, b: 255 };
  if (cluster.isGrappleHunterFlag === 1) return { r: 170, g: 85, b: 238 };
  if (cluster.isSlimeFlag === 1) return { r: 68, g: 204, b: 68 };
  if (cluster.isLargeSlimeFlag === 1) return { r: 34, g: 136, b: 34 };
  if (cluster.isWheelEnemyFlag === 1) return { r: 204, g: 136, b: 68 };
  if (cluster.isBeetleFlag === 1) return { r: 255, g: 215, b: 0 };
  if (cluster.isBubbleEnemyFlag === 1) {
    return cluster.isIceBubbleFlag === 1 ? { r: 170, g: 221, b: 255 } : { r: 51, g: 136, b: 255 };
  }
  if (cluster.isSquareStampedeFlag === 1) return { r: 221, g: 68, b: 255 };
  if (cluster.isGoldenMimicFlag === 1) return { r: 255, g: 215, b: 0 };
  if (cluster.isBeeSwarmFlag === 1) return { r: 255, g: 204, b: 0 };
  if (cluster.isDustConstellationFlag === 1) return { r: 170, g: 221, b: 255 };
  if (cluster.isOrbitalDustCoreFlag === 1) return { r: 255, g: 170, b: 68 };
  if (cluster.isDustBlockMimicFlag === 1) return { r: 200, g: 168, b: 80 };
  if (cluster.isDustLeechFlag === 1) return { r: 154, g: 100, b: 216 };
  if (cluster.isDustEchoFlag === 1) return { r: 213, g: 182, b: 255 };
  if (cluster.isGridSnakeEnemyFlag === 1) return { r: 53, g: 214, b: 184 };
  if (cluster.isMomentumTurretFlag === 1) return { r: 255, g: 90, b: 36 };
  if (cluster.isSlimeSnailFlag === 1) return { r: 112, g: 200, b: 92 };
  if (cluster.isShadowEnemyFlag === 1) return { r: 72, g: 32, b: 100 };
  if (cluster.isNeedleUrchinFlag === 1) return { r: 170, g: 164, b: 188 };
  return { r: 255, g: 102, b: 0 }; // default orange body
}

/** Resolves an enemy sprite image if one exists for the cluster type. */
export function getEnemySpriteForCluster(cluster: ClusterLike): HTMLImageElement | null {
  if (cluster.isRollingEnemyFlag === 1) {
    return loadImg('SPRITES/ENEMIES/goldenBlock/goldenBlock.png');
  }
  if (cluster.isSlimeFlag === 1 || cluster.isLargeSlimeFlag === 1) {
    return loadImg('SPRITES/ENEMIES/GreenSlime/GreenSlime.png');
  }
  if (cluster.isRockElementalFlag === 1) {
    return loadImg('SPRITES/ENEMIES/earthElemental/earthElemental_head_activated.png');
  }
  if (cluster.isBeetleFlag === 1) {
    return cluster.beetleIsFlightModeFlag === 1
      ? loadImg('SPRITES/ENEMIES/goldenBeetle/goldenBeetle_flying.png')
      : loadImg('SPRITES/ENEMIES/goldenBeetle/goldenBeetle_walking.png');
  }
  if (cluster.isRadiantTetherFlag === 1) {
    return loadImg('SPRITES/ENEMIES/radiantTeather/radiantTether_flying.png');
  }
  return null;
}

/**
 * Pure fallback generator that creates a grid of pixel samples covering the
 * enemy's bounding box using the enemy's primary rendered color.
 * Used in headless environments or when canvas extraction is not possible.
 */
export function generateFallbackEnemyPixelSamples(cluster: ClusterLike): EnemyPixelSample[] {
  const color = getEnemyPrimaryColor(cluster);
  const samples: EnemyPixelSample[] = [];
  const step = WORLD_UNITS_PER_NATIVE_PIXEL;
  const hw = Math.max(step, cluster.halfWidthWorld);
  const hh = Math.max(step, cluster.halfHeightWorld);

  for (let y = -hh + step * 0.5; y <= hh - step * 0.5; y += step) {
    for (let x = -hw + step * 0.5; x <= hw - step * 0.5; x += step) {
      samples.push({
        xWorld: cluster.positionXWorld + x,
        yWorld: cluster.positionYWorld + y,
        r: color.r,
        g: color.g,
        b: color.b,
      });
    }
  }
  return samples;
}

/**
 * DOM-facing helper: captures the enemy's visual from a sprite or offscreen
 * canvas and triggers the death pixel explosion. Silently falls back to
 * procedural bounding-box pixel sampling in headless/Node test environments.
 */
export function triggerEnemyDeathPixelsFromCluster(
  effect: EnemyDeathPixelEffect,
  cluster: ClusterLike,
  seed: number = 1,
  customSprite?: HTMLImageElement | null,
): void {
  let sampledPixels: EnemyPixelSample[] = [];
  const sprite = customSprite ?? getEnemySpriteForCluster(cluster);

  if (typeof document !== 'undefined' && sprite && isSpriteReady(sprite) && sprite.naturalWidth > 0 && sprite.naturalHeight > 0) {
    try {
      const wPx = sprite.naturalWidth;
      const hPx = sprite.naturalHeight;
      const canvas = document.createElement('canvas');
      canvas.width = wPx;
      canvas.height = hPx;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(sprite, 0, 0);
        const data = ctx.getImageData(0, 0, wPx, hPx).data;
        const worldPerPxX = (cluster.halfWidthWorld * 2) / wPx;
        const worldPerPxY = (cluster.halfHeightWorld * 2) / hPx;

        for (let py = 0; py < hPx; py++) {
          for (let px = 0; px < wPx; px++) {
            const idx = (py * wPx + px) * 4;
            if (data[idx + 3] > 20) {
              sampledPixels.push({
                xWorld: cluster.positionXWorld - cluster.halfWidthWorld + (px + 0.5) * worldPerPxX,
                yWorld: cluster.positionYWorld - cluster.halfHeightWorld + (py + 0.5) * worldPerPxY,
                r: data[idx],
                g: data[idx + 1],
                b: data[idx + 2],
              });
            }
          }
        }
      }
    } catch {
      // Non-fatal canvas error
    }
  }

  if (sampledPixels.length === 0) {
    sampledPixels = generateFallbackEnemyPixelSamples(cluster);
  }

  effect.trigger(sampledPixels, seed);
}
