import type { WorldState } from '../../../sim/world';
import type { RoomDef } from '../../../levels/roomDef';
import { computeOpenCeilingColumns, CELL_WORLD } from '../weather/openCeilingColumns';

/**
 * Foreground rain: droplets fall through open-ceiling columns and splash
 * into a short burst of pixel particles on hitting the topmost solid
 * surface below (a wall top or the floor).
 *
 * Column "openness" and the landing surface are both derived from the same
 * per-column topmost-wall-Y lookup built once per room load: a column is
 * open when its topmost surface isn't near the room's top edge (i.e. no
 * wall seals the ceiling there), and that same Y is where a drop in that
 * column lands.
 */

const SPAWN_ABOVE_ROOM_WORLD = 24;
const FALL_SPEED_WORLD_PER_SEC = 260;
const MAX_DROPS = 40;
const SPAWN_INTERVAL_MS = 60;
/** Thunderstorm mode spawns denser, faster rain than plain 'rain'. */
const THUNDERSTORM_MAX_DROPS = 110;
const THUNDERSTORM_SPAWN_INTERVAL_MS = 22;
const MAX_SPLASH_PARTICLES = 160;
const SPLASH_PARTICLE_LIFE_MS = 260;
const SPLASH_PARTICLES_PER_SPLASH = 5;

interface RainDrop {
  x: number;
  y: number;
  landingY: number;
}

interface SplashParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  lifeMs: number;
}

export class RainForegroundLayer {
  private active = false;
  private dense = false;
  private openColumnXs: number[] = [];
  private columnLandingY: number[] = [];
  private spawnTimerMs = 0;
  private readonly drops: RainDrop[] = [];
  private readonly splashes: SplashParticle[] = [];
  private rngState = 1;

  initFromRoom(world: WorldState, room: RoomDef): void {
    this.active = room.weather === 'rain' || room.weather === 'thunderstorm';
    this.dense = room.weather === 'thunderstorm';
    this.drops.length = 0;
    this.splashes.length = 0;
    this.spawnTimerMs = 0;

    if (!this.active) {
      this.openColumnXs = [];
      this.columnLandingY = [];
      return;
    }

    const walls: { xWorld: number; yWorld: number; wWorld: number }[] = [];
    for (let wi = 0; wi < world.wallCount; wi++) {
      walls.push({ xWorld: world.wallXWorld[wi], yWorld: world.wallYWorld[wi], wWorld: world.wallWWorld[wi] });
    }
    const { columnLandingY, openColumnXs } = computeOpenCeilingColumns(
      world.worldWidthWorld, world.worldHeightWorld, walls,
    );
    this.columnLandingY = columnLandingY;
    this.openColumnXs = openColumnXs;
  }

  private nextRandom(): number {
    // Simple deterministic LCG — no need for cryptographic quality here.
    this.rngState = (this.rngState * 1103515245 + 12345) & 0x7fffffff;
    return this.rngState / 0x7fffffff;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for API symmetry with other per-tick effect layers.
  update(_world: WorldState, dtMs: number): void {
    if (!this.active || this.openColumnXs.length === 0) {
      this.updateSplashesOnly(dtMs);
      return;
    }

    const dt = dtMs / 1000.0;
    const spawnIntervalMs = this.dense ? THUNDERSTORM_SPAWN_INTERVAL_MS : SPAWN_INTERVAL_MS;
    const maxDrops = this.dense ? THUNDERSTORM_MAX_DROPS : MAX_DROPS;

    this.spawnTimerMs += dtMs;
    while (this.spawnTimerMs >= spawnIntervalMs) {
      this.spawnTimerMs -= spawnIntervalMs;
      if (this.drops.length < maxDrops) {
        const columnIndex = Math.floor(this.nextRandom() * this.openColumnXs.length);
        const x = this.openColumnXs[columnIndex] + (this.nextRandom() - 0.5) * CELL_WORLD * 0.6;
        const c = Math.max(0, Math.min(this.columnLandingY.length - 1, Math.floor(x / CELL_WORLD)));
        this.drops.push({
          x,
          y: -SPAWN_ABOVE_ROOM_WORLD,
          landingY: this.columnLandingY[c],
        });
      }
    }

    for (let i = this.drops.length - 1; i >= 0; i--) {
      const drop = this.drops[i];
      drop.y += FALL_SPEED_WORLD_PER_SEC * dt;
      if (drop.y >= drop.landingY) {
        this.spawnSplash(drop.x, drop.landingY);
        this.drops.splice(i, 1);
      }
    }

    this.updateSplashesOnly(dtMs);
  }

  private updateSplashesOnly(dtMs: number): void {
    const dt = dtMs / 1000.0;
    for (let i = this.splashes.length - 1; i >= 0; i--) {
      const p = this.splashes[i];
      p.lifeMs -= dtMs;
      if (p.lifeMs <= 0) {
        this.splashes.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 420.0 * dt;
    }
  }

  private spawnSplash(x: number, y: number): void {
    for (let i = 0; i < SPLASH_PARTICLES_PER_SPLASH; i++) {
      if (this.splashes.length >= MAX_SPLASH_PARTICLES) break;
      const angle = (this.nextRandom() - 0.5) * Math.PI * 0.8 - Math.PI * 0.5;
      const speed = 40 + this.nextRandom() * 60;
      this.splashes.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        lifeMs: SPLASH_PARTICLE_LIFE_MS,
      });
    }
  }

  render(ctx: CanvasRenderingContext2D, offsetXPx: number, offsetYPx: number, scalePx: number): void {
    if (!this.active) return;
    if (this.drops.length === 0 && this.splashes.length === 0) return;

    ctx.save();

    ctx.strokeStyle = 'rgba(190, 210, 255, 0.55)';
    ctx.lineWidth = Math.max(1, scalePx);
    ctx.beginPath();
    for (let i = 0; i < this.drops.length; i++) {
      const d = this.drops[i];
      const x0 = d.x * scalePx + offsetXPx;
      const y0 = d.y * scalePx + offsetYPx;
      ctx.moveTo(x0, y0);
      ctx.lineTo(x0 - 1.5 * scalePx, y0 - 6 * scalePx);
    }
    ctx.stroke();

    ctx.fillStyle = 'rgba(200, 220, 255, 0.85)';
    for (let i = 0; i < this.splashes.length; i++) {
      const p = this.splashes[i];
      const alpha = Math.max(0, p.lifeMs / SPLASH_PARTICLE_LIFE_MS);
      ctx.globalAlpha = alpha;
      const px = p.x * scalePx + offsetXPx;
      const py = p.y * scalePx + offsetYPx;
      const size = Math.max(1, scalePx);
      ctx.fillRect(px, py, size, size);
    }
    ctx.globalAlpha = 1;

    ctx.restore();
  }
}
