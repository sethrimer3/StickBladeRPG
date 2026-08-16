/**
 * Character Preview Renderer — draws the player stickman physically standing and
 * walking in real-time within the inventory screen at the game's native resolution,
 * upscaled with nearest-neighbor sampling to match the in-game pixelated look and size.
 *
 * Simulates the stickman on a solid 5-tile platform using `stepStickRangerBody` and `SolidMask`.
 * The stickman stands in place with natural standing settle physics, and randomly walks
 * left/right across the 5 tiles (up to 2 tiles from the center spawn point) every 5–15 seconds.
 */

import {
  createStickRangerBody,
  stepStickRangerBody,
  SR_CHEST,
  SR_HIP,
  SR_SHOULDER_L,
  SR_SHOULDER_R,
  SR_HAND_L,
  SR_HAND_R,
  SR_FOOT_L,
  SR_FOOT_R,
  SR_KNEE_L,
  SR_KNEE_R,
  type StickRangerBody,
} from '../sim/clusters/stickRangerBody';
import { SolidMask } from '../sim/pixelMaterials/pixelMaterialSolid';
import {
  renderStickRangerBody,
  renderStickRangerWeapon,
} from '../render/clusters/stickRangerRenderer';
import { getWeaponDef, type WeaponDef } from '../sim/weapons/weaponDefs';
import { getArmorDef, getShoeDef, isTwoHandedItem } from '../sim/items/itemCatalog';
import type { EquipmentSlots } from '../sim/party/partyState';

/** Default native virtual canvas resolution (1 world unit = 1 pixel). */
export const NATIVE_PREVIEW_WIDTH = 48;
export const NATIVE_PREVIEW_HEIGHT = 52;
export const NATIVE_FLOOR_Y = 40.0;
export const NATIVE_START_X = 24.0;

/** Native virtual height of the game viewport (matches FIXED_VIRTUAL_HEIGHT_PX). */
const GAME_VIRTUAL_HEIGHT_PX = 270;

export interface CharacterPreviewOptions {
  nativeWidth?: number;
  nativeHeight?: number;
  upscale?: number;
}

export interface WanderState {
  startX: number;
  minX: number;
  maxX: number;
  targetX: number;
  moveDirection: -1 | 0 | 1;
  nextDecisionTime: number;
  walkStartTime: number;
}

/**
 * Calculates the current in-game upscale factor based on the active display or window height.
 */
export function getInGameUpscaleFactor(): number {
  if (typeof window === 'undefined') return 4.0;
  const gameCanvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
  if (gameCanvas) {
    const rect = gameCanvas.getBoundingClientRect();
    if (rect.height > 0) {
      return Math.max(1, rect.height / GAME_VIRTUAL_HEIGHT_PX);
    }
  }
  const h = window.innerHeight > 0 ? window.innerHeight : 1080;
  return Math.max(1, h / GAME_VIRTUAL_HEIGHT_PX);
}

/**
 * Creates the initial wander state centered on `startX`.
 * Boundaries span exactly ±2 tiles (±16 world units, 5 tiles total).
 */
export function createWanderState(startX: number, now = performance.now()): WanderState {
  const minX = startX - 16;
  const maxX = startX + 16;
  const idleMs = 5000 + Math.random() * 10000;
  return {
    startX,
    minX,
    maxX,
    targetX: startX,
    moveDirection: 0,
    nextDecisionTime: now + idleMs,
    walkStartTime: 0,
  };
}

/**
 * Updates the wander AI: stands in place, and every 5–15 seconds randomly selects
 * a target tile within the 5-tile boundary to walk to.
 */
export function updateWanderState(
  state: WanderState,
  currentHipX: number,
  now: number,
  rng: () => number = Math.random,
): void {
  if (state.moveDirection === 0) {
    if (now >= state.nextDecisionTime) {
      // Pick a target from the 5 tile centers: [-2, -1, 0, 1, 2] tiles relative to startX
      const candidateOffsets = [-16, -8, 0, 8, 16];
      const validTargets: number[] = [];
      for (const offset of candidateOffsets) {
        const candidateX = state.startX + offset;
        if (
          candidateX >= state.minX - 0.1 &&
          candidateX <= state.maxX + 0.1 &&
          Math.abs(candidateX - currentHipX) >= 4
        ) {
          validTargets.push(candidateX);
        }
      }

      if (validTargets.length > 0) {
        const target = validTargets[Math.floor(rng() * validTargets.length)];
        state.targetX = target;
        state.moveDirection = target < currentHipX ? -1 : 1;
        state.walkStartTime = now;
      } else {
        // Fallback target towards the opposite end
        const target = currentHipX < state.startX ? state.maxX : state.minX;
        state.targetX = target;
        state.moveDirection = target < currentHipX ? -1 : 1;
        state.walkStartTime = now;
      }
    }
  } else {
    // Walking towards targetX
    const distRemaining = (state.targetX - currentHipX) * state.moveDirection;
    if (distRemaining <= 0.6 || (now - state.walkStartTime) > 5000) {
      // Reached destination or timed out
      state.moveDirection = 0;
      const idleDuration = 5000 + rng() * 10000; // 5 to 15 seconds
      state.nextDecisionTime = now + idleDuration;
    }
  }
}

export class CharacterPreviewController {
  private _deviceCanvas: HTMLCanvasElement;
  private _deviceCtx: CanvasRenderingContext2D;
  private _virtualCanvas: HTMLCanvasElement;
  private _virtualCtx: CanvasRenderingContext2D;

  private _body: StickRangerBody;
  private _solidMask: SolidMask;
  private _wander: WanderState;
  private _equipment: EquipmentSlots;
  private _animFrameId: number | null = null;
  private _lastTime = performance.now();

  private _nativeWidth: number;
  private _nativeHeight: number;
  private _upscale: number;
  private _floorY: number;
  private _startX: number;

  constructor(container: HTMLElement, equipment: EquipmentSlots, options: CharacterPreviewOptions = {}) {
    this._nativeWidth = options.nativeWidth ?? NATIVE_PREVIEW_WIDTH;
    this._nativeHeight = options.nativeHeight ?? NATIVE_PREVIEW_HEIGHT;
    this._upscale = options.upscale ?? getInGameUpscaleFactor();
    this._equipment = equipment;

    this._floorY = NATIVE_FLOOR_Y;
    this._startX = this._nativeWidth * 0.5;

    // 1. Offscreen Virtual Canvas (Native Game Resolution, 1 world unit = 1 pixel)
    this._virtualCanvas = document.createElement('canvas');
    this._virtualCanvas.width = this._nativeWidth;
    this._virtualCanvas.height = this._nativeHeight;
    const vCtx = this._virtualCanvas.getContext('2d');
    if (!vCtx) throw new Error('Could not get 2d context for preview virtual canvas');
    this._virtualCtx = vCtx;
    this._virtualCtx.imageSmoothingEnabled = false;

    // 2. Onscreen Device Canvas (Upscaled with nearest-neighbor crisp pixels)
    const displayWidthPx = Math.round(this._nativeWidth * this._upscale);
    const displayHeightPx = Math.round(this._nativeHeight * this._upscale);

    this._deviceCanvas = document.createElement('canvas');
    this._deviceCanvas.width = displayWidthPx;
    this._deviceCanvas.height = displayHeightPx;
    this._deviceCanvas.style.cssText = `
      width: ${displayWidthPx}px;
      height: ${displayHeightPx}px;
      display: block;
      image-rendering: -moz-crisp-edges;
      image-rendering: -webkit-crisp-edges;
      image-rendering: pixelated;
      image-rendering: crisp-edges;
      border-radius: 4px;
    `;
    container.appendChild(this._deviceCanvas);

    const dCtx = this._deviceCanvas.getContext('2d');
    if (!dCtx) throw new Error('Could not get 2d context for preview device canvas');
    this._deviceCtx = dCtx;
    this._deviceCtx.imageSmoothingEnabled = false;

    // Solid collision mask: solid floor below feet and outer wall boundaries
    const maskW = Math.max(1, Math.ceil(this._nativeWidth));
    const maskH = Math.max(1, Math.ceil(this._nativeHeight));
    this._solidMask = new SolidMask(maskW, maskH);
    this._solidMask.markRect(0, Math.floor(this._floorY), maskW, maskH);
    this._solidMask.markRect(0, 0, 1, maskH);
    this._solidMask.markRect(maskW - 1, 0, maskW, maskH);

    // Spawn hip so feet rest on top of floorY (feet at hipY + 9.6)
    const hipY = this._floorY - 9.6;
    this._body = createStickRangerBody(this._startX, hipY);

    this._wander = createWanderState(this._startX, this._lastTime);
    this._updateCarryFlags();

    this._startLoop();
  }

  public get canvas(): HTMLCanvasElement {
    return this._deviceCanvas;
  }

  public get body(): StickRangerBody {
    return this._body;
  }

  public get wanderState(): WanderState {
    return this._wander;
  }

  public updateEquipment(equipment: EquipmentSlots): void {
    this._equipment = equipment;
    this._updateCarryFlags();
  }

  private _updateCarryFlags(): void {
    const mainId = this._equipment.mainHand;
    const offId = this._equipment.offHand;
    const isTwoHand = mainId !== null && isTwoHandedItem(mainId);

    let carryLeft: 0 | 1 = 0;
    let carryRight: 0 | 1 = 0;

    if (mainId !== null) {
      if (isTwoHand) {
        carryLeft = 1;
        carryRight = 1;
      } else {
        if (this._body.facingDirection < 0) {
          carryLeft = 1;
        } else {
          carryRight = 1;
        }
      }
    }

    if (offId !== null && !isTwoHand) {
      if (carryRight === 1 && carryLeft === 0) carryLeft = 1;
      else if (carryLeft === 1 && carryRight === 0) carryRight = 1;
    }

    this._body.carryHandLeftFlag = carryLeft;
    this._body.carryHandRightFlag = carryRight;
  }

  private _startLoop(): void {
    const frame = (now: number) => {
      this._updateAndDraw(now);
      this._animFrameId = requestAnimationFrame(frame);
    };
    this._animFrameId = requestAnimationFrame(frame);
  }

  private _updateAndDraw(now: number): void {
    const dtMs = Math.min(now - this._lastTime, 100);
    this._lastTime = now;

    // Advance wandering AI state machine
    const hipX = this._body.x[SR_HIP];
    updateWanderState(this._wander, hipX, now);

    // Keep carry flags aligned with current facing direction
    this._updateCarryFlags();

    // Step the authentic in-game Stick Ranger physics simulation
    stepStickRangerBody(this._body, this._solidMask, this._wander.moveDirection, dtMs);

    // 1. Render scene to offscreen virtual canvas at native 1:1 in-game resolution
    this._drawNative();

    // 2. Upscale offscreen virtual canvas to device canvas with crisp nearest-neighbor sampling
    this._upscaleToDevice();
  }

  private _drawNative(): void {
    const ctx = this._virtualCtx;
    const w = this._nativeWidth;
    const h = this._nativeHeight;
    const scale = 1.0; // In-game native scale

    ctx.clearRect(0, 0, w, h);

    // ── 1. Native Background & 5 Stone Floor Blocks ─────────────────────────
    const tileSpanUnits = 40; // 5 tiles * 8 units
    const platformLeftX = Math.round(this._startX - tileSpanUnits * 0.5);
    const floorY = Math.round(this._floorY);

    // Dark chamber background fill with subtle center lighting
    ctx.fillStyle = '#16120e';
    ctx.fillRect(0, 0, w, h);

    const grad = ctx.createRadialGradient(
      this._startX,
      floorY - 6,
      2,
      this._startX,
      floorY - 6,
      24,
    );
    grad.addColorStop(0, 'rgba(212, 168, 75, 0.16)');
    grad.addColorStop(0.7, 'rgba(212, 168, 75, 0.04)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // 5 In-Game Stone Floor Blocks (8×8 pixels each)
    const tileSize = 8;
    for (let i = 0; i < 5; i++) {
      const tileX = platformLeftX + i * tileSize;
      const tileH = h - floorY;

      // Stone block body
      ctx.fillStyle = i % 2 === 0 ? '#261f16' : '#1e1811';
      ctx.fillRect(tileX, floorY, tileSize, tileH);

      // Top beveled highlight (1 pixel thick)
      ctx.fillStyle = '#6b5428';
      ctx.fillRect(tileX, floorY, tileSize, 1);

      // Seam outline
      ctx.strokeStyle = '#0d0a08';
      ctx.lineWidth = 1;
      ctx.strokeRect(tileX + 0.5, floorY + 0.5, tileSize - 1, tileH - 1);
    }

    // Platform bottom trim
    ctx.fillStyle = 'rgba(212, 168, 75, 0.4)';
    ctx.fillRect(platformLeftX, floorY, tileSpanUnits, 1);

    // ── 2. Native Dynamic Floor Shadow ──────────────────────────────────────
    const currentHipX = this._body.x[SR_HIP];
    const shadowX = Math.round(currentHipX);
    const shadowY = floorY + 1;

    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
    ctx.beginPath();
    ctx.ellipse(shadowX, shadowY, 6, 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // ── 3. Stickman Softbody (Native 1:1 In-Game Render) ─────────────────────
    const mainHandId = this._equipment.mainHand;
    const offHandId = this._equipment.offHand;
    const isTwoHand = mainHandId !== null && isTwoHandedItem(mainHandId);

    renderStickRangerBody(ctx, this._body, 0, 0, scale, isTwoHand);

    // ── 4. Armor Visual Overlay ─────────────────────────────────────────────
    if (this._equipment.armor) {
      const armorDef = getArmorDef(this._equipment.armor);
      const armorColor = armorDef?.color ?? '#ffd700';

      ctx.save();
      ctx.strokeStyle = armorColor;
      ctx.fillStyle = armorColor;
      ctx.lineWidth = 1;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      const chestX = Math.round(this._body.x[SR_CHEST]);
      const chestY = Math.round(this._body.y[SR_CHEST]);
      const hipX = Math.round(this._body.x[SR_HIP]);
      const hipY = Math.round(this._body.y[SR_HIP]);
      const shLX = Math.round(this._body.x[SR_SHOULDER_L]);
      const shLY = Math.round(this._body.y[SR_SHOULDER_L]);
      const shRX = Math.round(this._body.x[SR_SHOULDER_R]);
      const shRY = Math.round(this._body.y[SR_SHOULDER_R]);

      // Chestplate / Cuirass
      ctx.beginPath();
      ctx.moveTo(shLX, shLY);
      ctx.lineTo(chestX, chestY + 1);
      ctx.lineTo(shRX, shRY);
      ctx.lineTo(hipX + 1, hipY - 1);
      ctx.lineTo(hipX - 1, hipY - 1);
      ctx.closePath();
      ctx.globalAlpha = 0.45;
      ctx.fill();
      ctx.globalAlpha = 0.95;
      ctx.stroke();

      // Pauldrons (shoulder pads)
      ctx.fillRect(shLX - 1, shLY - 1, 2, 2);
      ctx.fillRect(shRX - 1, shRY - 1, 2, 2);
      ctx.restore();
    }

    // ── 5. Shoes / Boots Visual Overlay ─────────────────────────────────────
    if (this._equipment.shoes) {
      const shoeDef = getShoeDef(this._equipment.shoes);
      const shoeColor = shoeDef?.color ?? '#8b5a2b';

      ctx.save();
      ctx.strokeStyle = shoeColor;
      ctx.fillStyle = shoeColor;
      ctx.lineWidth = 1;
      ctx.lineCap = 'round';

      const fLX = Math.round(this._body.x[SR_FOOT_L]);
      const fLY = Math.round(this._body.y[SR_FOOT_L]);
      const fRX = Math.round(this._body.x[SR_FOOT_R]);
      const fRY = Math.round(this._body.y[SR_FOOT_R]);
      const kLX = Math.round(this._body.x[SR_KNEE_L]);
      const kLY = Math.round(this._body.y[SR_KNEE_L]);
      const kRX = Math.round(this._body.x[SR_KNEE_R]);
      const kRY = Math.round(this._body.y[SR_KNEE_R]);

      // Shin guards / boots
      ctx.beginPath();
      ctx.moveTo(kLX + Math.round((fLX - kLX) * 0.5), kLY + Math.round((fLY - kLY) * 0.5));
      ctx.lineTo(fLX, fLY);
      ctx.moveTo(kRX + Math.round((fRX - kRX) * 0.5), kRY + Math.round((fRY - kRY) * 0.5));
      ctx.lineTo(fRX, fRY);
      ctx.stroke();

      // Boot soles
      ctx.fillRect(fLX - 1, fLY, 3, 1);
      ctx.fillRect(fRX - 1, fRY, 3, 1);
      ctx.restore();
    }

    // ── 6. Equipped Weapons ─────────────────────────────────────────────────
    if (mainHandId) {
      const mainDef = getWeaponDef(mainHandId);
      if (mainDef) {
        renderStickRangerWeapon(
          ctx,
          this._body,
          mainDef,
          false,
          0,
          0,
          0,
          scale,
        );
      }
    }

    if (offHandId && !isTwoHand) {
      const offDef = getWeaponDef(offHandId);
      if (offDef) {
        renderOffHandWeapon(ctx, this._body, offDef, scale);
      }
    }
  }

  private _upscaleToDevice(): void {
    const dCtx = this._deviceCtx;
    dCtx.imageSmoothingEnabled = false;
    dCtx.clearRect(0, 0, this._deviceCanvas.width, this._deviceCanvas.height);
    dCtx.drawImage(
      this._virtualCanvas,
      0,
      0,
      this._deviceCanvas.width,
      this._deviceCanvas.height,
    );
  }

  public destroy(): void {
    if (this._animFrameId !== null) {
      cancelAnimationFrame(this._animFrameId);
      this._animFrameId = null;
    }
    if (this._deviceCanvas.parentNode) {
      this._deviceCanvas.parentNode.removeChild(this._deviceCanvas);
    }
  }
}

/** Renders off-hand weapon/shield attached to the trailing hand. */
function renderOffHandWeapon(
  ctx: CanvasRenderingContext2D,
  body: StickRangerBody,
  def: WeaponDef,
  scalePx = 1.0,
): void {
  const isFacingLeft = body.facingDirection < 0;
  const offHandIndex = isFacingLeft ? SR_HAND_R : SR_HAND_L;
  const handX = body.x[offHandIndex] * scalePx;
  const handY = body.y[offHandIndex] * scalePx;
  const color = def.color ?? '#e0e0e0';

  ctx.save();
  ctx.translate(handX, handY);

  if (def.kind === 'shield') {
    // Shield held on forearm
    ctx.rotate(isFacingLeft ? -0.2 : 0.2);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    ctx.ellipse(0, 0, 3 * scalePx, 5 * scalePx, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, scalePx);
    ctx.stroke();

    ctx.strokeStyle = '#ffd700';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -3 * scalePx);
    ctx.lineTo(0, 3 * scalePx);
    ctx.moveTo(-2 * scalePx, 0);
    ctx.lineTo(2 * scalePx, 0);
    ctx.stroke();
  } else {
    // Dagger or light one-handed secondary blade pointed downward
    const angle = isFacingLeft ? Math.PI * 0.25 : Math.PI * 0.75;
    ctx.rotate(angle);
    const reachPx = Math.max(4, Math.round((def.range ?? 14) * scalePx * 0.6));

    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, scalePx);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(reachPx, 0);
    ctx.stroke();
  }

  ctx.restore();
}
