/**
 * Character Preview Renderer — draws the player stickman physically standing and
 * walking in real-time within the inventory screen using actual in-game Verlet physics.
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
import { getWeaponDef } from '../sim/weapons/weaponDefs';
import { getArmorDef, getShoeDef, isTwoHandedItem } from '../sim/items/itemCatalog';
import type { EquipmentSlots } from '../sim/party/partyState';

export interface CharacterPreviewOptions {
  width?: number;
  height?: number;
  scale?: number;
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
  private _canvas: HTMLCanvasElement;
  private _ctx: CanvasRenderingContext2D;
  private _body: StickRangerBody;
  private _solidMask: SolidMask;
  private _wander: WanderState;
  private _equipment: EquipmentSlots;
  private _animFrameId: number | null = null;
  private _lastTime = performance.now();
  private _scale: number;
  private _width: number;
  private _height: number;
  private _worldWidth: number;
  private _worldHeight: number;
  private _floorY: number;
  private _startX: number;

  constructor(container: HTMLElement, equipment: EquipmentSlots, options: CharacterPreviewOptions = {}) {
    this._width = options.width ?? 180;
    this._height = options.height ?? 220;
    this._scale = options.scale ?? 3.5;
    this._equipment = equipment;

    this._worldWidth = this._width / this._scale;
    this._worldHeight = this._height / this._scale;
    this._floorY = 46.0;
    this._startX = this._worldWidth * 0.5;

    this._canvas = document.createElement('canvas');
    this._canvas.width = this._width;
    this._canvas.height = this._height;
    this._canvas.style.cssText = `
      width: ${this._width}px;
      height: ${this._height}px;
      display: block;
      border-radius: 6px;
      background: radial-gradient(circle at 50% 50%, rgba(28, 22, 16, 0.98) 0%, rgba(10, 8, 6, 1) 85%);
    `;
    container.appendChild(this._canvas);

    const ctx = this._canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get 2d context for character preview canvas');
    this._ctx = ctx;

    // Solid collision mask: solid floor below feet and outer wall boundaries
    const maskW = Math.max(1, Math.ceil(this._worldWidth));
    const maskH = Math.max(1, Math.ceil(this._worldHeight));
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
    return this._canvas;
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

    // Render frame
    this._draw();
  }

  private _draw(): void {
    const ctx = this._ctx;
    const w = this._width;
    const h = this._height;
    const scale = this._scale;

    ctx.clearRect(0, 0, w, h);

    // ── 1. Background & 5 Floor Tiles ───────────────────────────────────────
    const tileSpanUnits = 40; // 5 tiles * 8 units
    const platformLeftX = (this._startX - tileSpanUnits * 0.5) * scale;
    const platformWidthPx = tileSpanUnits * scale;
    const floorYPx = this._floorY * scale;

    ctx.save();
    // Ambient platform background glow
    const centerScreenX = this._startX * scale;
    const platGrad = ctx.createRadialGradient(
      centerScreenX,
      floorYPx - 10,
      10,
      centerScreenX,
      floorYPx - 10,
      platformWidthPx * 0.6,
    );
    platGrad.addColorStop(0, 'rgba(212, 168, 75, 0.12)');
    platGrad.addColorStop(0.7, 'rgba(212, 168, 75, 0.02)');
    platGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = platGrad;
    ctx.fillRect(0, 0, w, h);

    // 5 In-Game Stone Floor Blocks
    const tileSizePx = 8 * scale;
    for (let i = 0; i < 5; i++) {
      const tileX = platformLeftX + i * tileSizePx;
      const tileY = floorYPx;
      const tileH = h - floorYPx;

      // Stone block fill
      ctx.fillStyle = i % 2 === 0 ? 'rgba(32, 26, 18, 0.95)' : 'rgba(26, 21, 14, 0.95)';
      ctx.fillRect(tileX, tileY, tileSizePx, tileH);

      // Top beveled highlight
      ctx.fillStyle = 'rgba(212, 168, 75, 0.35)';
      ctx.fillRect(tileX, tileY, tileSizePx, 2);

      // Side beveled edge
      ctx.strokeStyle = 'rgba(10, 8, 6, 0.85)';
      ctx.lineWidth = 1;
      ctx.strokeRect(tileX, tileY, tileSizePx, tileH);
    }

    // Platform bottom trim
    ctx.strokeStyle = 'rgba(212, 168, 75, 0.3)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(platformLeftX, floorYPx);
    ctx.lineTo(platformLeftX + platformWidthPx, floorYPx);
    ctx.stroke();

    // ── 2. Dynamic Stickman Floor Shadow ────────────────────────────────────
    const currentHipX = this._body.x[SR_HIP];
    const shadowCenterXPx = currentHipX * scale;
    const shadowYPx = floorYPx + 1;

    const shadowGrad = ctx.createRadialGradient(
      shadowCenterXPx,
      shadowYPx,
      2,
      shadowCenterXPx,
      shadowYPx,
      24,
    );
    shadowGrad.addColorStop(0, 'rgba(0, 0, 0, 0.65)');
    shadowGrad.addColorStop(0.6, 'rgba(0, 0, 0, 0.3)');
    shadowGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = shadowGrad;
    ctx.beginPath();
    ctx.ellipse(shadowCenterXPx, shadowYPx, 22, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // ── 3. Stickman Softbody ────────────────────────────────────────────────
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
      ctx.lineWidth = Math.max(2, scale * 0.55);
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
      ctx.lineTo(hipXScreen + 3.5, hipYScreen - 2);
      ctx.lineTo(hipXScreen - 3.5, hipYScreen - 2);
      ctx.closePath();
      ctx.globalAlpha = 0.35;
      ctx.fill();
      ctx.globalAlpha = 0.9;
      ctx.stroke();

      // Pauldrons (shoulder pads)
      ctx.fillRect(shLX - 2.5, shLY - 2.5, 5, 3.5);
      ctx.fillRect(shRX - 2.5, shRY - 2.5, 5, 3.5);
      ctx.restore();
    }

    // ── 5. Shoes / Boots Visual Overlay ─────────────────────────────────────
    if (this._equipment.shoes) {
      const shoeDef = getShoeDef(this._equipment.shoes);
      const shoeColor = shoeDef?.color ?? '#8b5a2b';

      ctx.save();
      ctx.strokeStyle = shoeColor;
      ctx.fillStyle = shoeColor;
      ctx.lineWidth = Math.max(2, scale * 0.65);
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
      ctx.lineTo(fLX - 2.5, fLY);
      ctx.moveTo(kRX + (fRX - kRX) * 0.4, kRY + (fRY - kRY) * 0.4);
      ctx.lineTo(fRX, fRY);
      ctx.lineTo(fRX + 2.5, fRY);
      ctx.stroke();

      // Boot soles
      ctx.fillRect(fLX - 4, fLY - 1, 6, 2.5);
      ctx.fillRect(fRX - 2, fRY - 1, 6, 2.5);
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

/** Renders off-hand weapon/shield attached to the trailing hand. */
function renderOffHandWeapon(
  ctx: CanvasRenderingContext2D,
  body: StickRangerBody,
  def: import('../sim/weapons/weaponDefs').WeaponDef,
  scalePx: number,
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
    ctx.ellipse(0, 0, 7 * scalePx * 0.4, 12 * scalePx * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.5, scalePx * 0.75);
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
    const angle = isFacingLeft ? Math.PI * 0.25 : Math.PI * 0.75;
    ctx.rotate(angle);
    const reachPx = (def.range ?? 14) * scalePx * 0.65;

    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.2, scalePx * 0.75);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(reachPx, 0);
    ctx.stroke();
  }

  ctx.restore();
}
