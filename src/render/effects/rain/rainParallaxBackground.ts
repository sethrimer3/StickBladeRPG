import type { RoomDef } from '../../../levels/roomDef';

/**
 * 4-layer parallax rain backdrop: diagonal streaks tiled across a fixed
 * virtual grid, each layer scrolling at its own depth/speed. Purely
 * ambient — no collision with tiles — and loops indefinitely regardless
 * of camera position since streak positions are derived from a hashed
 * cell index rather than absolute world coordinates.
 */

interface RainLayerConfig {
  cellWorld: number;
  scrollFactor: number;
  fallSpeedPxPerSec: number;
  streakLengthPx: number;
  alpha: number;
  color: string;
  streaksPerCell: number;
}

const LAYERS: readonly RainLayerConfig[] = [
  { cellWorld: 48, scrollFactor: 0.05, fallSpeedPxPerSec: 70,  streakLengthPx: 6,  alpha: 0.12, color: '200, 215, 235', streaksPerCell: 1 },
  { cellWorld: 40, scrollFactor: 0.15, fallSpeedPxPerSec: 110, streakLengthPx: 9,  alpha: 0.20, color: '205, 220, 240', streaksPerCell: 1 },
  { cellWorld: 32, scrollFactor: 0.30, fallSpeedPxPerSec: 160, streakLengthPx: 12, alpha: 0.30, color: '210, 225, 245', streaksPerCell: 2 },
  { cellWorld: 24, scrollFactor: 0.50, fallSpeedPxPerSec: 230, streakLengthPx: 16, alpha: 0.42, color: '220, 232, 250', streaksPerCell: 2 },
];

function hash01(a: number, b: number): number {
  const h = Math.sin(a * 127.1 + b * 311.7) * 43758.5453123;
  return h - Math.floor(h);
}

export class RainParallaxBackground {
  private active = false;

  initFromRoom(room: RoomDef): void {
    this.active = room.weather === 'rain';
  }

  render(
    ctx: CanvasRenderingContext2D,
    relCameraOffsetXPx: number,
    relCameraOffsetYPx: number,
    virtualWidthPx: number,
    virtualHeightPx: number,
    nowMs: number,
  ): void {
    if (!this.active) return;

    ctx.save();
    for (const layer of LAYERS) {
      const cell = layer.cellWorld;
      const scrollX = relCameraOffsetXPx * layer.scrollFactor;
      const scrollY = relCameraOffsetYPx * layer.scrollFactor + nowMs * 0.001 * layer.fallSpeedPxPerSec;

      const startCol = Math.floor(-scrollX / cell) - 1;
      const endCol = Math.floor((virtualWidthPx - scrollX) / cell) + 1;
      const startRow = Math.floor(-scrollY / cell) - 1;
      const endRow = Math.floor((virtualHeightPx - scrollY) / cell) + 1;

      ctx.strokeStyle = `rgba(${layer.color}, ${layer.alpha})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let row = startRow; row <= endRow; row++) {
        for (let col = startCol; col <= endCol; col++) {
          for (let s = 0; s < layer.streaksPerCell; s++) {
            const jx = hash01(col * 3.1 + s * 7.7, row * 5.3);
            const jy = hash01(row * 9.1 + s * 2.3, col * 4.7);
            const baseX = col * cell + jx * cell + scrollX;
            const baseY = row * cell + jy * cell + scrollY;
            ctx.moveTo(baseX, baseY);
            ctx.lineTo(baseX - layer.streakLengthPx * 0.25, baseY + layer.streakLengthPx);
          }
        }
      }
      ctx.stroke();
    }
    ctx.restore();
  }
}
