import type { WorldState } from '../../../sim/world';
import type { RoomDef } from '../../../levels/roomDef';
import { computeOpenCeilingColumns, CELL_WORLD } from '../weather/openCeilingColumns';

/**
 * Room-level 'sunny' weather: angled god-ray beams, one per open-ceiling
 * column, shining from the ceiling gap down to that column's topmost solid
 * surface (mirrors the rain foreground's column/landing-Y computation so the
 * beams always land exactly at the ceiling opening, not through walls).
 */

const RAY_ANGLE_RAD = (12 * Math.PI) / 180;
const RAY_HALF_WIDTH_WORLD = CELL_WORLD * 0.42;

export class SunnyForegroundLayer {
  private active = false;
  private openColumnXs: number[] = [];
  private columnLandingY: number[] = [];

  initFromRoom(world: WorldState, room: RoomDef): void {
    this.active = room.weather === 'sunny';
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

  render(ctx: CanvasRenderingContext2D, offsetXPx: number, offsetYPx: number, scalePx: number, nowMs: number): void {
    if (!this.active || this.openColumnXs.length === 0) return;

    ctx.save();
    const prevComposite = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = 'screen';
    const sway = Math.sin(nowMs * 0.0002) * 4;
    const dx = Math.sin(RAY_ANGLE_RAD);

    for (let i = 0; i < this.openColumnXs.length; i++) {
      const topX = this.openColumnXs[i] + sway;
      const c = Math.max(0, Math.min(this.columnLandingY.length - 1, Math.floor(this.openColumnXs[i] / CELL_WORLD)));
      const landingY = this.columnLandingY[c];
      const bottomX = topX + dx * landingY;

      const topLeft = topX - RAY_HALF_WIDTH_WORLD;
      const topRight = topX + RAY_HALF_WIDTH_WORLD;
      const bottomLeft = bottomX - RAY_HALF_WIDTH_WORLD * 1.6;
      const bottomRight = bottomX + RAY_HALF_WIDTH_WORLD * 1.6;

      const gradient = ctx.createLinearGradient(
        topX * scalePx + offsetXPx, 0 * scalePx + offsetYPx,
        bottomX * scalePx + offsetXPx, landingY * scalePx + offsetYPx,
      );
      gradient.addColorStop(0, 'rgba(255,244,200,0.30)');
      gradient.addColorStop(0.6, 'rgba(255,236,180,0.14)');
      gradient.addColorStop(1, 'rgba(255,230,160,0)');

      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.moveTo(topLeft * scalePx + offsetXPx, 0 * scalePx + offsetYPx);
      ctx.lineTo(topRight * scalePx + offsetXPx, 0 * scalePx + offsetYPx);
      ctx.lineTo(bottomRight * scalePx + offsetXPx, landingY * scalePx + offsetYPx);
      ctx.lineTo(bottomLeft * scalePx + offsetXPx, landingY * scalePx + offsetYPx);
      ctx.closePath();
      ctx.fill();
    }

    ctx.globalCompositeOperation = prevComposite;
    ctx.restore();
  }
}
