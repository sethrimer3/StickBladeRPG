/**
 * Save tomb in-game renderer.
 *
 * Draws the saveTomb.png sprite, tracks player proximity, and draws the "F"
 * key prompt when the player is close.
 *
 * The tomb's ambience is fireflies, not dust: each save tomb spawns a firefly
 * swarm in `screens/gameRoomHazards.ts` that roams a wide area around the tomb
 * and gathers in towards it as the player approaches.  Those fireflies are
 * simulated in `sim/hazards.ts` and drawn with every other firefly in
 * `render/hazards.ts`, so nothing tomb-specific is drawn here.
 */

import { BLOCK_SIZE_MEDIUM } from '../levels/roomDef';

const BASE = import.meta.env.BASE_URL;

/** Max number of save tombs supported per room. */
const MAX_TOMBS = 8;

/** Distance in world units within which the tomb activates. */
export const SKILL_TOMB_INTERACT_RADIUS_WORLD = 3 * BLOCK_SIZE_MEDIUM;

/** Save tomb sprite width in world units (2 medium blocks wide). */
const TOMB_SPRITE_WIDTH_WORLD = 2 * BLOCK_SIZE_MEDIUM;
/** Save tomb sprite height in world units (3 medium blocks tall). */
const TOMB_SPRITE_HEIGHT_WORLD = 3 * BLOCK_SIZE_MEDIUM;

/** How fast the activation factor eases between 0 and 1 (factor units/second). */
const ACTIVATION_TRANSITION_PER_SEC = 2.0;

interface TombState {
  xWorld: number;
  yWorld: number;
  /** Is the player currently nearby? */
  isPlayerNearbyFlag: boolean;
  /** Transition factor 0..1 (1 = player fully arrived, 0 = player away). */
  activationFactor: number;
}

export class SkillTombRenderer {
  private readonly tombSprite: HTMLImageElement;
  private readonly tombStates: TombState[] = [];
  private isSpriteLoaded = false;

  constructor() {
    this.tombSprite = new Image();
    this.tombSprite.src = `${BASE}SPRITES/OBJECTS&TRIGGERS/INTERACTABLES&COLLECTABLES/saveTomb.png`;
    this.tombSprite.onload = () => { this.isSpriteLoaded = true; };
  }

  /** Initialise tomb states for a new room. */
  init(tombs: readonly { xBlock: number; yBlock: number }[]): void {
    this.tombStates.length = 0;

    const count = Math.min(tombs.length, MAX_TOMBS);
    for (let i = 0; i < count; i++) {
      this.tombStates.push({
        xWorld: (tombs[i].xBlock + 0.5) * BLOCK_SIZE_MEDIUM,
        yWorld: (tombs[i].yBlock + 0.5) * BLOCK_SIZE_MEDIUM,
        isPlayerNearbyFlag: false,
        activationFactor: 0,
      });
    }
  }

  /** Update player-proximity state each frame. */
  update(
    playerXWorld: number,
    playerYWorld: number,
    dtSec: number,
  ): void {
    for (let t = 0; t < this.tombStates.length; t++) {
      const tomb = this.tombStates[t];
      const dx = playerXWorld - tomb.xWorld;
      const dy = playerYWorld - tomb.yWorld;
      const isNearby =
        dx * dx + dy * dy < SKILL_TOMB_INTERACT_RADIUS_WORLD * SKILL_TOMB_INTERACT_RADIUS_WORLD;
      tomb.isPlayerNearbyFlag = isNearby;

      const targetFactor = isNearby ? 1.0 : 0.0;
      const step = ACTIVATION_TRANSITION_PER_SEC * dtSec;
      tomb.activationFactor = tomb.activationFactor < targetFactor
        ? Math.min(targetFactor, tomb.activationFactor + step)
        : Math.max(targetFactor, tomb.activationFactor - step);
    }
  }

  /** Returns the index of the tomb the player can interact with, or -1. */
  getNearbyTombIndex(playerXWorld: number, playerYWorld: number): number {
    for (let t = 0; t < this.tombStates.length; t++) {
      const tomb = this.tombStates[t];
      const dx = playerXWorld - tomb.xWorld;
      const dy = playerYWorld - tomb.yWorld;
      const distSq = dx * dx + dy * dy;
      if (distSq < SKILL_TOMB_INTERACT_RADIUS_WORLD * SKILL_TOMB_INTERACT_RADIUS_WORLD) {
        return t;
      }
    }
    return -1;
  }

  /** Get the position of a tomb by index. */
  getTombPosition(index: number): { xWorld: number; yWorld: number } | null {
    const tomb = this.tombStates[index];
    if (!tomb) return null;
    return { xWorld: tomb.xWorld, yWorld: tomb.yWorld };
  }

  /** Render all tombs and their interact prompts. */
  render(
    ctx: CanvasRenderingContext2D,
    offsetXPx: number,
    offsetYPx: number,
    zoom: number,
    vpW = 480,
    vpH = 270,
  ): void {
    for (let t = 0; t < this.tombStates.length; t++) {
      const tomb = this.tombStates[t];

      const screenX = tomb.xWorld * zoom + offsetXPx;
      const screenY = tomb.yWorld * zoom + offsetYPx;

      // Cull tombs well outside the viewport.
      const halfW = TOMB_SPRITE_WIDTH_WORLD * zoom * 0.5;
      const halfH = TOMB_SPRITE_HEIGHT_WORLD * zoom * 0.5;
      const margin = BLOCK_SIZE_MEDIUM * zoom * 2;
      if (screenX + halfW + margin < 0 || screenX - halfW - margin > vpW) continue;
      if (screenY + halfH + margin < 0 || screenY - halfH - margin > vpH) continue;

      // Draw sprite (saveTomb.png)
      const spriteW = TOMB_SPRITE_WIDTH_WORLD * zoom;
      const spriteH = TOMB_SPRITE_HEIGHT_WORLD * zoom;
      if (this.isSpriteLoaded) {
        ctx.drawImage(
          this.tombSprite,
          screenX - spriteW / 2,
          screenY - spriteH / 2,
          spriteW,
          spriteH,
        );
      }

      // Draw interact prompt ("F" key indicator)
      if (tomb.isPlayerNearbyFlag) {
        const alpha = 0.6 + 0.4 * tomb.activationFactor;
        const labelY = screenY - BLOCK_SIZE_MEDIUM * zoom * 2.0;
        const labelSize = Math.max(6, Math.round(11 * zoom));
        ctx.save();
        ctx.font = `bold ${labelSize}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        // Background pill
        const metrics = ctx.measureText('F');
        const padX = labelSize * 0.45;
        const padY = labelSize * 0.25;
        const boxW = metrics.width + padX * 2;
        const boxH = labelSize + padY * 2;
        ctx.fillStyle = `rgba(20,14,6,${alpha * 0.7})`;
        ctx.beginPath();
        ctx.roundRect(screenX - boxW / 2, labelY - boxH / 2, boxW, boxH, boxH / 2);
        ctx.fill();
        ctx.strokeStyle = `rgba(212,168,75,${alpha})`;
        ctx.lineWidth = Math.max(1, zoom * 0.5);
        ctx.stroke();
        // Letter
        ctx.fillStyle = `rgba(212,168,75,${alpha})`;
        ctx.fillText('F', screenX, labelY);
        ctx.restore();
      }
    }
  }
}
