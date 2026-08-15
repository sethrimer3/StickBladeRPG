import type { RoomDef } from '../../../levels/roomDef';

/**
 * Full-screen post-process filter for 'cloudy' and 'thunderstorm' weather.
 * Drawn last, inside the room clip, so it also dims gameplay entities —
 * not just the background.
 */
const CLOUDY_GRAY_ALPHA = 0.1;
const THUNDERSTORM_DARKEN_ALPHA = 0.2;

export function renderWeatherSceneOverlay(
  ctx: CanvasRenderingContext2D,
  room: RoomDef,
  widthPx: number,
  heightPx: number,
): void {
  if (room.weather === 'cloudy') {
    ctx.save();
    ctx.fillStyle = `rgba(140,145,150,${CLOUDY_GRAY_ALPHA})`;
    ctx.fillRect(0, 0, widthPx, heightPx);
    ctx.restore();
  } else if (room.weather === 'thunderstorm') {
    ctx.save();
    ctx.fillStyle = `rgba(10,12,20,${THUNDERSTORM_DARKEN_ALPHA})`;
    ctx.fillRect(0, 0, widthPx, heightPx);
    ctx.restore();
  }
}
