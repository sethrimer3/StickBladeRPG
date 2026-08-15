/**
 * Character Preview Renderer — draws the player stickman physically standing in place.
 *
 * Renders the stickman softbody, equipped main-hand and off-hand weapons,
 * armor visual overlays, and shoe visual overlays with smooth idle breathing.
 */

import {
  createStickRangerBody,
  SR_CHEST,
  SR_HIP,
  SR_SHOULDER_L,
  SR_SHOULDER_R,
  SR_HAND_L,
  SR_FOOT_L,
  SR_FOOT_R,
  SR_KNEE_L,
  SR_KNEE_R,
  type StickRangerBody,
} from '../sim/clusters/stickRangerBody';
import {
  renderStickRangerBody,
  renderStickRangerWeapon,
} from '../render/clusters/stickRangerRenderer';
import { getWeaponDef } from '../sim/weapons/weaponDefs';
import { getArmorDef, getShoeDef, isTwoHandedItem } from '../sim/items/itemCatalog';
import type { EquipmentSlots } from '../sim/party/partyState';

export interface CharacterPreviewOptions {
  width?: number;
  height?: number;
  scale?: number;
}

export class CharacterPreviewController {
  private _canvas: HTMLCanvasElement;
  private _ctx: CanvasRenderingContext2D;
  private _body: StickRangerBody;
  private _equipment: EquipmentSlots;
  private _animFrameId: number | null = null;
  private _startTime = performance.now();
  private _scale: number;
  private _width: number;
  private _height: number;

  constructor(container: HTMLElement, equipment: EquipmentSlots, options: CharacterPreviewOptions = {}) {
    this._width = options.width ?? 180;
    this._height = options.height ?? 220;
    this._scale = options.scale ?? 5.5;
    this._equipment = equipment;

    this._canvas = document.createElement('canvas');
    this._canvas.width = this._width;
    this._canvas.height = this._height;
    this._canvas.style.cssText = `
      width: ${this._width}px;
      height: ${this._height}px;
      display: block;
      border-radius: 6px;
      background: radial-gradient(circle at 50% 55%, rgba(35, 30, 20, 0.95) 0%, rgba(12, 10, 8, 0.98) 75%);
    `;
    container.appendChild(this._canvas);

    const ctx = this._canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get 2d context for character preview canvas');
    this._ctx = ctx;

    const hipX = (this._width * 0.5) / this._scale;
    const hipY = (this._height * 0.58) / this._scale;
    this._body = createStickRangerBody(hipX, hipY);

    this._startLoop();
  }

  public get canvas(): HTMLCanvasElement {
    return this._canvas;
  }

  public updateEquipment(equipment: EquipmentSlots): void {
    this._equipment = equipment;
  }

  private _startLoop(): void {
    const renderFrame = (now: number) => {
      this._draw(now);
      this._animFrameId = requestAnimationFrame(renderFrame);
    };
    this._animFrameId = requestAnimationFrame(renderFrame);
  }

  private _draw(now: number): void {
    const ctx = this._ctx;
    const w = this._width;
    const h = this._height;
    const scale = this._scale;

    ctx.clearRect(0, 0, w, h);

    // Subtle idle breathing motion
    const elapsedSec = (now - this._startTime) * 0.001;
    const breatheOffset = Math.sin(elapsedSec * 2.5) * 0.4;
    const hipX = (w * 0.5) / scale;
    const hipY = (h * 0.58) / scale + breatheOffset * 0.2;

    // Reposition body softly
    this._body.x[SR_HIP] = hipX;
    this._body.y[SR_HIP] = hipY;
    this._body.renderPrevX[SR_HIP] = hipX;
    this._body.renderPrevY[SR_HIP] = hipY;

    this._body.x[SR_CHEST] = hipX;
    this._body.y[SR_CHEST] = hipY - 7.0 + breatheOffset * 0.4;
    this._body.renderPrevX[SR_CHEST] = hipX;
    this._body.renderPrevY[SR_CHEST] = hipY - 7.0 + breatheOffset * 0.4;

    this._body.x[SR_SHOULDER_L] = hipX - 3.0;
    this._body.y[SR_SHOULDER_L] = hipY - 6.5 + breatheOffset * 0.3;
    this._body.renderPrevX[SR_SHOULDER_L] = hipX - 3.0;
    this._body.renderPrevY[SR_SHOULDER_L] = hipY - 6.5 + breatheOffset * 0.3;

    this._body.x[SR_SHOULDER_R] = hipX + 3.0;
    this._body.y[SR_SHOULDER_R] = hipY - 6.5 + breatheOffset * 0.3;
    this._body.renderPrevX[SR_SHOULDER_R] = hipX + 3.0;
    this._body.renderPrevY[SR_SHOULDER_R] = hipY - 6.5 + breatheOffset * 0.3;

    // ── 1. Pedestal & Shadow ────────────────────────────────────────────────
    const footYPx = (hipY + 9.6) * scale;
    const centerX = w * 0.5;

    ctx.save();
    // Ambient floor glow
    const glowGrad = ctx.createRadialGradient(centerX, footYPx + 4, 2, centerX, footYPx + 4, 45);
    glowGrad.addColorStop(0, 'rgba(212, 168, 75, 0.25)');
    glowGrad.addColorStop(0.5, 'rgba(212, 168, 75, 0.08)');
    glowGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = glowGrad;
    ctx.fillRect(centerX - 50, footYPx - 10, 100, 30);

    // Floor shadow ellipse
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.beginPath();
    ctx.ellipse(centerX, footYPx + 2, 28, 7, 0, 0, Math.PI * 2);
    ctx.fill();

    // Pedestal ring
    ctx.strokeStyle = 'rgba(212, 168, 75, 0.4)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.ellipse(centerX, footYPx + 2, 34, 9, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // ── 2. Stickman Figure ──────────────────────────────────────────────────
    const mainHandId = this._equipment.mainHand;
    const offHandId = this._equipment.offHand;
    const isTwoHand = mainHandId !== null && isTwoHandedItem(mainHandId);

    renderStickRangerBody(ctx, this._body, 0, 0, scale, isTwoHand);

    // ── 3. Armor Visual Accent ──────────────────────────────────────────────
    if (this._equipment.armor) {
      const armorDef = getArmorDef(this._equipment.armor);
      const armorColor = armorDef?.color ?? '#ffd700';

      ctx.save();
      ctx.strokeStyle = armorColor;
      ctx.fillStyle = armorColor;
      ctx.lineWidth = Math.max(2, scale * 0.6);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      const chestX = this._body.x[SR_CHEST] * scale;
      const chestY = this._body.y[SR_CHEST] * scale;
      const hipXScreen = this._body.x[SR_HIP] * scale;
      const hipYScreen = this._body.y[SR_HIP] * scale;
      const shLX = this._body.x[SR_SHOULDER_L] * scale;
      const shLY = this._body.y[SR_SHOULDER_L] * scale;
      const shRX = this._body.x[SR_SHOULDER_R] * scale;
      const shRY = this._body.y[SR_SHOULDER_R] * scale;

      // Chestplate / Cuirass
      ctx.beginPath();
      ctx.moveTo(shLX, shLY);
      ctx.lineTo(chestX, chestY + 2);
      ctx.lineTo(shRX, shRY);
      ctx.lineTo(hipXScreen + 4, hipYScreen - 2);
      ctx.lineTo(hipXScreen - 4, hipYScreen - 2);
      ctx.closePath();
      ctx.globalAlpha = 0.35;
      ctx.fill();
      ctx.globalAlpha = 0.9;
      ctx.stroke();

      // Pauldrons (shoulder pads)
      ctx.fillRect(shLX - 3, shLY - 3, 6, 4);
      ctx.fillRect(shRX - 3, shRY - 3, 6, 4);
      ctx.restore();
    }

    // ── 4. Shoes / Boots Visual Accent ──────────────────────────────────────
    if (this._equipment.shoes) {
      const shoeDef = getShoeDef(this._equipment.shoes);
      const shoeColor = shoeDef?.color ?? '#8b5a2b';

      ctx.save();
      ctx.strokeStyle = shoeColor;
      ctx.fillStyle = shoeColor;
      ctx.lineWidth = Math.max(2.5, scale * 0.7);
      ctx.lineCap = 'round';

      const fLX = this._body.x[SR_FOOT_L] * scale;
      const fLY = this._body.y[SR_FOOT_L] * scale;
      const fRX = this._body.x[SR_FOOT_R] * scale;
      const fRY = this._body.y[SR_FOOT_R] * scale;
      const kLX = this._body.x[SR_KNEE_L] * scale;
      const kLY = this._body.y[SR_KNEE_L] * scale;
      const kRX = this._body.x[SR_KNEE_R] * scale;
      const kRY = this._body.y[SR_KNEE_R] * scale;

      // Shin guards / boots
      ctx.beginPath();
      ctx.moveTo(kLX + (fLX - kLX) * 0.4, kLY + (fLY - kLY) * 0.4);
      ctx.lineTo(fLX, fLY);
      ctx.lineTo(fLX - 3, fLY);
      ctx.moveTo(kRX + (fRX - kRX) * 0.4, kRY + (fRY - kRY) * 0.4);
      ctx.lineTo(fRX, fRY);
      ctx.lineTo(fRX + 3, fRY);
      ctx.stroke();

      // Boot soles
      ctx.fillRect(fLX - 5, fLY - 1, 7, 3);
      ctx.fillRect(fRX - 2, fRY - 1, 7, 3);
      ctx.restore();
    }

    // ── 5. Equipped Weapons ─────────────────────────────────────────────────
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
        // Render secondary weapon in off-hand with inverted/mirrored grip
        renderOffHandWeapon(ctx, this._body, offDef, scale);
      }
    }
  }

  public destroy(): void {
    if (this._animFrameId !== null) {
      cancelAnimationFrame(this._animFrameId);
      this._animFrameId = null;
    }
    if (this._canvas.parentNode) {
      this._canvas.parentNode.removeChild(this._canvas);
    }
  }
}

/** Renders off-hand weapon/shield attached to the left hand. */
function renderOffHandWeapon(
  ctx: CanvasRenderingContext2D,
  body: StickRangerBody,
  def: import('../sim/weapons/weaponDefs').WeaponDef,
  scalePx: number,
): void {
  const handX = body.x[SR_HAND_L] * scalePx;
  const handY = body.y[SR_HAND_L] * scalePx;
  const color = def.color ?? '#e0e0e0';

  ctx.save();
  ctx.translate(handX, handY);

  if (def.kind === 'shield') {
    // Shield held on forearm
    ctx.rotate(0.2);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.3;
    ctx.beginPath();
    ctx.ellipse(0, 0, 7 * scalePx * 0.4, 12 * scalePx * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.5, scalePx * 0.8);
    ctx.stroke();

    ctx.strokeStyle = '#ffd700';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -6 * scalePx * 0.4);
    ctx.lineTo(0, 6 * scalePx * 0.4);
    ctx.moveTo(-4 * scalePx * 0.4, 0);
    ctx.lineTo(4 * scalePx * 0.4, 0);
    ctx.stroke();
  } else {
    // Dagger or light one-handed secondary blade pointed downward
    ctx.rotate(Math.PI * 0.75);
    const reachPx = (def.range ?? 14) * scalePx * 0.7;

    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.2, scalePx * 0.8);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(reachPx, 0);
    ctx.stroke();
  }

  ctx.restore();
}
