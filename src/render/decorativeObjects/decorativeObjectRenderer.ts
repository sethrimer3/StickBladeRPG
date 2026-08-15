/**
 * decorativeObjectRenderer.ts — In-game rendering for placed decorative objects.
 *
 * Renders sprites discovered from ASSETS/SPRITES/DecorativeObjects/ with 1:1
 * native virtual pixel scaling (1 sprite pixel = 1 world unit) and ±8px X/Y offset shifts.
 */

import { BLOCK_SIZE_SMALL } from '../../levels/roomDef';
import type { RoomDecorativeObjectDef } from '../../levels/roomDef';
import { loadImg, isSpriteReady } from '../imageCache';
import { getDecorativeObjectSpriteUrl } from './decorativeObjectCatalogue';

export function renderDecorativeObjects(
  ctx: CanvasRenderingContext2D,
  decorativeObjects: readonly RoomDecorativeObjectDef[] | undefined,
  cameraOffsetX: number,
  cameraOffsetY: number,
  zoom: number,
  viewportWidth: number,
  viewportHeight: number,
): void {
  if (!decorativeObjects || decorativeObjects.length === 0) return;

  for (const obj of decorativeObjects) {
    const spriteUrl = getDecorativeObjectSpriteUrl(obj.objectType);
    if (!spriteUrl) continue;
    const img = loadImg(spriteUrl);
    if (!isSpriteReady(img) || img.naturalWidth === 0 || img.naturalHeight === 0) continue;

    const worldX = obj.xBlock * BLOCK_SIZE_SMALL + (obj.offsetXPixel ?? 0);
    const worldY = obj.yBlock * BLOCK_SIZE_SMALL + (obj.offsetYPixel ?? 0);

    const screenX = worldX * zoom + cameraOffsetX;
    const screenY = worldY * zoom + cameraOffsetY;
    const screenW = img.naturalWidth * zoom;
    const screenH = img.naturalHeight * zoom;

    // Viewport culling
    if (
      screenX + screenW < 0 ||
      screenY + screenH < 0 ||
      screenX > viewportWidth ||
      screenY > viewportHeight
    ) {
      continue;
    }

    ctx.drawImage(
      img,
      Math.round(screenX),
      Math.round(screenY),
      Math.round(screenW),
      Math.round(screenH),
    );
  }
}
