/**
 * doubleJumpBurstEffect.ts — One-shot cosmetic golden-pixel burst played when
 * the player double-jumps.
 *
 * Render-only: never touches WorldState. Modeled on
 * src/render/dustContainerPickupEffect.ts's bounded-pool burst pattern, but
 * with a fixed launch fan (left / right / straight down from the feet)
 * instead of a random radial spread, and a trailing "follow" phase instead
 * of homing: after the initial kick the motes ease toward where the player
 * *was* a short moment ago (an internal position-history buffer), so they
 * read as a few sparkles the player is trailing behind them rather than
 * particles chasing the player's current position.
 *
 * Lifecycle per mote: BURST_PHASE_DURATION_SEC of drag-damped ballistic
 * travel along its launch direction, then a FOLLOW phase that eases toward
 * the lagged player position, fading out and despawning at MOTE_LIFETIME_SEC.
 */

/** Bounded pool size — comfortably covers a couple of overlapping bursts. */
export const MAX_DOUBLE_JUMP_MOTES = 48;

/** Motes launched per double jump: split evenly across left / right / down. */
const MOTES_PER_LANE = 3;

/** Duration of the outward ballistic phase before the follow phase begins. */
const BURST_PHASE_DURATION_SEC = 0.22;
/** Total mote lifetime (seconds) before despawn. */
const MOTE_LIFETIME_SEC = 0.85;

const BURST_SPEED_MIN_WORLD = 70;
const BURST_SPEED_MAX_WORLD = 120;
/** Exponential drag coefficient applied during the burst phase (per second). */
const BURST_DRAG_PER_SEC = 3.0;

/** How far behind the player's live position the follow target lags (seconds). */
const FOLLOW_LAG_SEC = 0.28;
const FOLLOW_ACCEL_WORLD_PER_SEC2 = 700;
const FOLLOW_MAX_SPEED_WORLD = 220;

/** How many player-position samples to retain — covers FOLLOW_LAG_SEC at a generous margin. */
const HISTORY_CAPACITY = 128;

export class DoubleJumpBurstEffect {
  private count = 0;
  private readonly xWorld = new Float32Array(MAX_DOUBLE_JUMP_MOTES);
  private readonly yWorld = new Float32Array(MAX_DOUBLE_JUMP_MOTES);
  private readonly vxWorld = new Float32Array(MAX_DOUBLE_JUMP_MOTES);
  private readonly vyWorld = new Float32Array(MAX_DOUBLE_JUMP_MOTES);
  private readonly ageSec = new Float32Array(MAX_DOUBLE_JUMP_MOTES);
  private rngState = 1;

  // Ring buffer of recent player positions, used to compute the lagged
  // follow target. Sized generously and pruned each update — a decorative
  // effect with a handful of live motes, so plain arrays are fine.
  private readonly historyX: number[] = [];
  private readonly historyY: number[] = [];
  private readonly historyT: number[] = [];
  private historyTimeSec = 0;

  /** Deterministic PRNG for visual-only randomization (no wall-clock randomness). */
  private nextRandom(): number {
    this.rngState = (this.rngState * 1664525 + 1013904223) >>> 0;
    return (this.rngState >>> 0) / 0xFFFFFFFF;
  }

  private spawnLane(xWorld: number, yWorld: number, baseAngleRad: number, jitterRad: number): void {
    for (let n = 0; n < MOTES_PER_LANE; n++) {
      let i = this.count;
      if (i >= MAX_DOUBLE_JUMP_MOTES) {
        i = this.findOldestIndex();
      } else {
        this.count++;
      }
      const angle = baseAngleRad + (this.nextRandom() * 2 - 1) * jitterRad;
      const speed = BURST_SPEED_MIN_WORLD + this.nextRandom() * (BURST_SPEED_MAX_WORLD - BURST_SPEED_MIN_WORLD);
      this.xWorld[i] = xWorld;
      this.yWorld[i] = yWorld;
      this.vxWorld[i] = Math.cos(angle) * speed;
      this.vyWorld[i] = Math.sin(angle) * speed;
      this.ageSec[i] = 0;
    }
  }

  /**
   * Spawns the double-jump burst at the player's feet (xWorld, yWorld):
   * a fan straight left, a fan straight right, and a fan straight down.
   * World-Y convention: positive Y is downward, matching the sim.
   */
  spawnBurst(xWorld: number, yWorld: number): void {
    const jitterRad = 0.18;
    this.spawnLane(xWorld, yWorld, Math.PI, jitterRad);       // left
    this.spawnLane(xWorld, yWorld, 0, jitterRad);              // right
    this.spawnLane(xWorld, yWorld, Math.PI * 0.5, jitterRad);  // down
  }

  private findOldestIndex(): number {
    let oldestIdx = 0;
    let oldestAge = this.ageSec[0];
    for (let i = 1; i < this.count; i++) {
      if (this.ageSec[i] > oldestAge) {
        oldestAge = this.ageSec[i];
        oldestIdx = i;
      }
    }
    return oldestIdx;
  }

  private removeAt(i: number): void {
    this.count--;
    this.xWorld[i] = this.xWorld[this.count];
    this.yWorld[i] = this.yWorld[this.count];
    this.vxWorld[i] = this.vxWorld[this.count];
    this.vyWorld[i] = this.vyWorld[this.count];
    this.ageSec[i] = this.ageSec[this.count];
  }

  /** Returns the player position sampled FOLLOW_LAG_SEC in the past (interpolated). */
  private getLaggedPlayerPosition(): { x: number; y: number } | null {
    const n = this.historyT.length;
    if (n === 0) return null;
    const targetT = this.historyTimeSec - FOLLOW_LAG_SEC;
    if (targetT <= this.historyT[0]) return { x: this.historyX[0], y: this.historyY[0] };
    if (targetT >= this.historyT[n - 1]) return { x: this.historyX[n - 1], y: this.historyY[n - 1] };
    // Linear scan from the end — history is short, and the target is usually recent.
    for (let i = n - 1; i > 0; i--) {
      if (this.historyT[i - 1] <= targetT && targetT <= this.historyT[i]) {
        const span = this.historyT[i] - this.historyT[i - 1];
        const t = span > 1e-6 ? (targetT - this.historyT[i - 1]) / span : 0;
        return {
          x: this.historyX[i - 1] + (this.historyX[i] - this.historyX[i - 1]) * t,
          y: this.historyY[i - 1] + (this.historyY[i] - this.historyY[i - 1]) * t,
        };
      }
    }
    return { x: this.historyX[0], y: this.historyY[0] };
  }

  /**
   * Advances the pool by dtSec. playerXWorld/playerYWorld should be the
   * player's current *rendered* center — recorded into the history buffer
   * each call so the follow phase can target a lagged sample of it.
   */
  update(dtSec: number, playerXWorld: number, playerYWorld: number): void {
    this.historyTimeSec += dtSec;
    this.historyX.push(playerXWorld);
    this.historyY.push(playerYWorld);
    this.historyT.push(this.historyTimeSec);
    if (this.historyT.length > HISTORY_CAPACITY) {
      this.historyX.shift();
      this.historyY.shift();
      this.historyT.shift();
    }
    // Drop history older than the lag window needs (plus margin) so the
    // buffer doesn't grow unbounded while no double jump is in flight.
    while (this.historyT.length > 2 && this.historyT[1] < this.historyTimeSec - FOLLOW_LAG_SEC - 0.5) {
      this.historyX.shift();
      this.historyY.shift();
      this.historyT.shift();
    }

    if (this.count === 0) return;
    const lagged = this.getLaggedPlayerPosition();

    for (let i = this.count - 1; i >= 0; i--) {
      this.ageSec[i] += dtSec;
      if (this.ageSec[i] >= MOTE_LIFETIME_SEC) {
        this.removeAt(i);
        continue;
      }

      if (this.ageSec[i] < BURST_PHASE_DURATION_SEC) {
        // Outward ballistic phase: integrate with exponential drag.
        const dragFactor = Math.max(0, 1 - BURST_DRAG_PER_SEC * dtSec);
        this.vxWorld[i] *= dragFactor;
        this.vyWorld[i] *= dragFactor;
        this.xWorld[i] += this.vxWorld[i] * dtSec;
        this.yWorld[i] += this.vyWorld[i] * dtSec;
      } else if (lagged !== null) {
        // Follow phase: gentle acceleration toward the lagged player position,
        // so the sparkles read as trailing just behind the player's motion.
        const dx = lagged.x - this.xWorld[i];
        const dy = lagged.y - this.yWorld[i];
        const dist = Math.hypot(dx, dy);
        if (dist > 1e-3) {
          const invDist = 1 / dist;
          this.vxWorld[i] += dx * invDist * FOLLOW_ACCEL_WORLD_PER_SEC2 * dtSec;
          this.vyWorld[i] += dy * invDist * FOLLOW_ACCEL_WORLD_PER_SEC2 * dtSec;
          const speed = Math.hypot(this.vxWorld[i], this.vyWorld[i]);
          if (speed > FOLLOW_MAX_SPEED_WORLD) {
            const scale = FOLLOW_MAX_SPEED_WORLD / speed;
            this.vxWorld[i] *= scale;
            this.vyWorld[i] *= scale;
          }
        }
        this.xWorld[i] += this.vxWorld[i] * dtSec;
        this.yWorld[i] += this.vyWorld[i] * dtSec;
      }
    }
  }

  render(
    ctx: CanvasRenderingContext2D,
    offsetXPx: number,
    offsetYPx: number,
    scalePx: number,
  ): void {
    if (this.count === 0) return;
    ctx.save();
    for (let i = 0; i < this.count; i++) {
      const lifeFraction = this.ageSec[i] / MOTE_LIFETIME_SEC;
      // Fade in quickly, hold, then fade out over the final third of life.
      const alpha = lifeFraction < 0.08
        ? lifeFraction / 0.08
        : Math.min(1, (1 - lifeFraction) / 0.35);
      const x = Math.round(this.xWorld[i] * scalePx + offsetXPx);
      const y = Math.round(this.yWorld[i] * scalePx + offsetYPx);

      // Twinkle: alternate a warm-gold body with a brighter highlight pixel
      // on a short cycle so the burst reads as sparkling rather than flat.
      const twinkleOn = Math.sin(this.ageSec[i] * 22 + i * 1.7) > 0.15;

      ctx.globalAlpha = alpha;
      ctx.fillStyle = twinkleOn ? '#fff3b0' : '#ffd700';
      ctx.fillRect(x, y, 1, 1);
      if (twinkleOn) {
        ctx.globalAlpha = alpha * 0.6;
        ctx.fillStyle = '#fff9d8';
        ctx.fillRect(x, y - 1, 1, 1);
        ctx.fillRect(x - 1, y, 1, 1);
        ctx.fillRect(x + 1, y, 1, 1);
        ctx.fillRect(x, y + 1, 1, 1);
      }
    }
    ctx.restore();
  }

  /** Removes every live mote and clears state — call on room load/activation, respawn, new run, and teardown. */
  reset(): void {
    this.count = 0;
    this.historyX.length = 0;
    this.historyY.length = 0;
    this.historyT.length = 0;
    this.historyTimeSec = 0;
  }

  /** Current live mote count — exposed for tests. */
  get moteCount(): number {
    return this.count;
  }
}
