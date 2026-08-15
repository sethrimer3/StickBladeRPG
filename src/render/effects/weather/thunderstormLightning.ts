import type { RoomDef } from '../../../levels/roomDef';

/**
 * Occasional background-only lightning flash for 'thunderstorm' weather.
 * Rendered by the background pass (before walls/entities draw over it), so
 * it never brightens the foreground/gameplay layer — only whatever's still
 * uncovered background at the time.
 */
const FLASH_MIN_DELAY_MS = 4000;
const FLASH_MAX_DELAY_MS = 12000;
const FLASH_UP_MS = 80;
const FLASH_DOWN_MS = 250;
const FLASH_PEAK_ALPHA = 0.55;

function randomDelayMs(): number {
  return FLASH_MIN_DELAY_MS + Math.random() * (FLASH_MAX_DELAY_MS - FLASH_MIN_DELAY_MS);
}

export class ThunderstormLightning {
  private active = false;
  private timeUntilNextFlashMs = 0;
  /** -1 = not currently flashing. */
  private flashElapsedMs = -1;

  initFromRoom(room: RoomDef): void {
    this.active = room.weather === 'thunderstorm';
    this.flashElapsedMs = -1;
    this.timeUntilNextFlashMs = this.active ? randomDelayMs() : 0;
  }

  update(dtMs: number): void {
    if (!this.active) return;
    if (this.flashElapsedMs >= 0) {
      this.flashElapsedMs += dtMs;
      if (this.flashElapsedMs > FLASH_UP_MS + FLASH_DOWN_MS) {
        this.flashElapsedMs = -1;
        this.timeUntilNextFlashMs = randomDelayMs();
      }
      return;
    }
    this.timeUntilNextFlashMs -= dtMs;
    if (this.timeUntilNextFlashMs <= 0) this.flashElapsedMs = 0;
  }

  private getFlashAlpha(): number {
    if (!this.active || this.flashElapsedMs < 0) return 0;
    if (this.flashElapsedMs <= FLASH_UP_MS) return this.flashElapsedMs / FLASH_UP_MS;
    const downT = (this.flashElapsedMs - FLASH_UP_MS) / FLASH_DOWN_MS;
    return Math.max(0, 1 - downT);
  }

  render(ctx: CanvasRenderingContext2D, widthPx: number, heightPx: number): void {
    const alpha = this.getFlashAlpha();
    if (alpha <= 0.002) return;
    ctx.save();
    ctx.fillStyle = `rgba(220,232,255,${(alpha * FLASH_PEAK_ALPHA).toFixed(3)})`;
    ctx.fillRect(0, 0, widthPx, heightPx);
    ctx.restore();
  }
}
