/**
 * Renders the player's equipped STICK-RPG weapon: the held blade and its swing
 * arc, live projectiles, channelled staff beams and their charge meter,
 * orbiting spirit orbs, and summoned familiars.
 *
 * Phases 2b and 2h of the STICK-RPG port. Deliberately plain — flat colored
 * lines, arcs, and squares drawn from each weapon's own palette fields
 * (`color`, `beamColor`, `orbColor`, `summonColor`, …), matching the donor's
 * look rather than inventing new art. The donor's bespoke per-weapon renderers
 * (staff heads, gun poses, shield faces, per-form creature art) are not ported;
 * their config blocks travel in the weapon data ready for whoever does port them.
 *
 * Every drawn position comes from simulation state rather than being
 * recomputed here, so the visuals cannot disagree with what actually damages
 * enemies — the beam endpoint in particular is whatever `staffChannel.ts`
 * resolved, wall clip and all.
 *
 * Reads only. No simulation state is mutated, and there are no per-frame
 * allocations: the grip anchor, swing origin, and orb scratch positions are
 * reused instance fields and every draw call is a direct canvas primitive.
 */

import type { WorldSnapshot } from '../snapshot';
import { loadImg, isSpriteReady } from '../imageCache';
import {
  getEquippedWeaponDef,
  type PlayerWeaponState,
} from '../../sim/weapons/playerWeaponState';
import { getWeaponSwingProgress } from '../../sim/weapons/weaponSwing';
import { MAX_WEAPON_PROJECTILES } from '../../sim/weapons/weaponProjectiles';
import {
  MAX_ACTIVE_SUMMONS,
  SUMMON_LOCOMOTION_FLIER,
} from '../../sim/weapons/weaponSummons';
import { MAX_SOUL_ORBS } from '../../sim/weapons/soulOrbs';
import { getStaffChargeFraction } from '../../sim/weapons/staffChannel';
import { getSpiritOrbPosition } from '../../sim/weapons/spiritOrbs';
import {
  computeSwingOrigin,
  computeWeaponGripAnchor,
  createWeaponGripAnchor,
  type WeaponGripAnchor,
} from '../../sim/weapons/weaponGrip';
import { getStickRangerRenderAlpha } from '../../sim/clusters/stickRangerBody';
import type { WeaponDef } from '../../sim/weapons/weaponDefs';
import { getProjectileShieldConfig } from '../../sim/weapons/projectileShield';
import {
  EXPIRY_FLASH_TICKS,
  MAX_EXPIRY_FLASHES,
} from '../../sim/weapons/weaponExpiryEffects';

/** Blade thickness in virtual pixels. */
const BLADE_WIDTH_PX = 2;
/** Half-size of a projectile square, in virtual pixels, when it has no radius. */
const PROJECTILE_FALLBACK_HALF_PX = 2;
/** Samples drawn along the swing trail behind the blade. */
const SWING_TRAIL_SAMPLES = 6;
/** How far behind the current angle the trail extends, in radians. */
const SWING_TRAIL_ARC_RAD = 0.5;
/** Fallback blade color when a weapon declares none. */
const DEFAULT_BLADE_COLOR = '#d8d8e8';
/** Body color of a corpse raised by the Gravebind Stave. */
const THRALL_BODY_COLOR = '#8b7fb5';
/** Limb color of a raised thrall — the staff's necrotic green. */
const THRALL_ACCENT_COLOR = '#88ffc4';
/** Staff charge meter geometry, in world units (scaled by zoom at draw time). */
const CHARGE_METER_WIDTH_PX = 24;
const CHARGE_METER_HEIGHT_PX = 3;
const CHARGE_METER_OFFSET_Y_PX = 28;

/**
 * Reads a string field from an opaque donor config block.
 *
 * The `staff` block travels as `Readonly<Record<string, unknown>>` (see
 * `WeaponVisualConfig`), so its fields are checked rather than trusted — a
 * partial block must degrade to the fallback, not throw mid-frame.
 */
function readString(
  config: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const value = config?.[key];
  return typeof value === 'string' ? value : undefined;
}

/** Reads a finite number from an opaque donor config block. */
function readNumber(
  config: Readonly<Record<string, unknown>> | undefined,
  key: string,
): number | undefined {
  const value = config?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export class WeaponRenderer {
  /** Reused so per-frame anchor resolution allocates nothing. */
  private readonly _anchor: WeaponGripAnchor = createWeaponGripAnchor();
  /** Wielder pivot (the hip), resolved once per frame. */
  private readonly _origin = { xWorld: 0, yWorld: 0 };
  /** Scratch for spirit orb positions. */
  private readonly _orbPosition = { xWorld: 0, yWorld: 0 };

  render(
    ctx: CanvasRenderingContext2D,
    snapshot: WorldSnapshot,
    ox: number,
    oy: number,
    zoom: number,
  ): void {
    const weapon = snapshot.playerWeapon;
    if (weapon === null) return;

    // Projectiles, summoned familiars, and soul drops outlive the weapon
    // that produced them, so they draw regardless of what is currently equipped.
    this._renderProjectiles(ctx, weapon, ox, oy, zoom);
    this._renderSummons(ctx, weapon, ox, oy, zoom);
    this._renderSoulOrbs(ctx, weapon, ox, oy, zoom);
    this._renderExpiryFlashes(ctx, weapon, ox, oy, zoom);

    const def = getEquippedWeaponDef(weapon);
    if (def === null) return;

    const body = snapshot.stickRangerBody;
    if (body !== null) {
      computeSwingOrigin(body, 1, this._origin);
    } else {
      this._origin.xWorld = 0;
      this._origin.yWorld = 0;
    }

    this._renderProjectileShield(ctx, weapon, def, ox, oy, zoom);
    this._renderStaffBeam(ctx, weapon, def, ox, oy, zoom);
    this._renderSpiritOrbs(ctx, weapon, def, ox, oy, zoom);
    this._renderHeldWeapon(ctx, snapshot, weapon, def, ox, oy, zoom);
    // Drawn last so the meter is never occluded by the beam it describes.
    if (body !== null) this._renderStaffChargeMeter(ctx, weapon, def, ox, oy, zoom);
  }

  /**
   * Draws the Aegis ward: a filled bubble around the wielder whose opacity
   * tracks its remaining absorption, flashing on impact.
   *
   * Opacity carries the information the player needs — a nearly-spent ward is
   * nearly invisible — so the bubble doubles as its own health bar and no
   * separate meter is drawn.
   */
  private _renderProjectileShield(
    ctx: CanvasRenderingContext2D,
    weapon: PlayerWeaponState,
    def: WeaponDef,
    ox: number,
    oy: number,
    zoom: number,
  ): void {
    const shield = weapon.projectileShield;
    if (shield.isActiveFlag === 0 || shield.radiusWorld <= 0) return;

    const config = getProjectileShieldConfig(def);
    if (config === null) return;

    const xPx = (this._origin.xWorld - ox) * zoom;
    const yPx = (this._origin.yWorld - oy) * zoom;
    const radiusPx = shield.radiusWorld * zoom;
    const fill = shield.maxHitPoints > 0
      ? Math.max(0, Math.min(1, shield.hitPoints / shield.maxHitPoints))
      : 0;

    ctx.save();
    ctx.globalAlpha = 0.15 + 0.55 * fill;
    ctx.fillStyle = shield.hitFlashTicks > 0 ? config.hitColor : config.color;
    ctx.beginPath();
    ctx.arc(xPx, yPx, radiusPx, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = 0.35 + 0.65 * fill;
    ctx.strokeStyle = shield.hitFlashTicks > 0 ? config.hitColor : config.outlineColor;
    ctx.lineWidth = Math.max(1, 2 * zoom);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Draws the channelled staff beam from the wielder to wherever the simulation
   * actually terminated it — a wall, a body, or maximum range.
   *
   * The endpoint comes from `StaffChannelState`, never recomputed here, so the
   * drawn beam and the damaging beam can never disagree.
   */
  private _renderStaffBeam(
    ctx: CanvasRenderingContext2D,
    weapon: PlayerWeaponState,
    def: WeaponDef,
    ox: number,
    oy: number,
    zoom: number,
  ): void {
    const staff = weapon.staff;
    if (staff.beamActiveFlag === 0) return;

    const config = def.staff as Readonly<Record<string, unknown>> | undefined;
    const coreColor = readString(config, 'beamColor') ?? def.color ?? DEFAULT_BLADE_COLOR;
    const glowColor = readString(config, 'beamGlow') ?? coreColor;
    const width = readNumber(config, 'beamWidth') ?? 8;

    const startXPx = (this._origin.xWorld - ox) * zoom;
    const startYPx = (this._origin.yWorld - oy) * zoom;
    const endXPx = (staff.beamEndXWorld - ox) * zoom;
    const endYPx = (staff.beamEndYWorld - oy) * zoom;

    ctx.save();
    ctx.lineCap = 'round';

    // Wide translucent glow first, then a bright narrow core on top.
    ctx.strokeStyle = glowColor;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = Math.max(2, width * zoom * 0.5);
    ctx.beginPath();
    ctx.moveTo(startXPx, startYPx);
    ctx.lineTo(endXPx, endYPx);
    ctx.stroke();

    ctx.strokeStyle = coreColor;
    ctx.globalAlpha = 1;
    ctx.lineWidth = Math.max(1, width * zoom * 0.2);
    ctx.beginPath();
    ctx.moveTo(startXPx, startYPx);
    ctx.lineTo(endXPx, endYPx);
    ctx.stroke();

    ctx.restore();
  }

  /**
   * Draws the staff charge meter above the wielder.
   *
   * Hidden at full charge so it only appears when it carries information —
   * a permanently-full bar is visual noise.
   */
  private _renderStaffChargeMeter(
    ctx: CanvasRenderingContext2D,
    weapon: PlayerWeaponState,
    def: WeaponDef,
    ox: number,
    oy: number,
    zoom: number,
  ): void {
    if (def.kind !== 'staff') return;

    const fraction = getStaffChargeFraction(weapon.staff, def);
    if (fraction >= 1 && weapon.staff.isChannellingFlag === 0) return;

    const config = def.staff as Readonly<Record<string, unknown>> | undefined;
    const barColor = readString(config, 'barColor') ?? def.color ?? DEFAULT_BLADE_COLOR;

    const widthPx = CHARGE_METER_WIDTH_PX * zoom;
    const heightPx = CHARGE_METER_HEIGHT_PX * zoom;
    const xPx = (this._origin.xWorld - ox) * zoom - widthPx * 0.5;
    const yPx = (this._origin.yWorld - oy) * zoom - CHARGE_METER_OFFSET_Y_PX * zoom;

    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = '#000000';
    ctx.fillRect(xPx, yPx, widthPx, heightPx);
    ctx.globalAlpha = 1;
    ctx.fillStyle = barColor;
    ctx.fillRect(xPx, yPx, widthPx * fraction, heightPx);
    ctx.restore();
  }

  /**
   * Draws the ring of spirit orbs around the wielder.
   *
   * Only orbs that are actually present are drawn, so a spent orb leaves a
   * visible gap — that gap is the weapon's ammunition readout.
   */
  private _renderSpiritOrbs(
    ctx: CanvasRenderingContext2D,
    weapon: PlayerWeaponState,
    def: WeaponDef,
    ox: number,
    oy: number,
    zoom: number,
  ): void {
    if (def.kind !== 'spirit') return;
    const orbs = weapon.spiritOrbs;
    if (orbs.orbCount <= 0) return;

    const bodyColor = def.orbColor ?? def.color ?? DEFAULT_BLADE_COLOR;
    const haloColor = def.orbTrailColor ?? bodyColor;
    const radiusPx = Math.max(1, (def.orbRadius ?? 8) * zoom);

    ctx.save();
    for (let i = 0; i < orbs.orbCount; i++) {
      if (orbs.isPresent[i] === 0) continue;

      getSpiritOrbPosition(orbs, def, i, this._origin.xWorld, this._origin.yWorld, this._orbPosition);
      const xPx = (this._orbPosition.xWorld - ox) * zoom;
      const yPx = (this._orbPosition.yWorld - oy) * zoom;

      ctx.globalAlpha = 0.4;
      ctx.fillStyle = haloColor;
      ctx.beginPath();
      ctx.arc(xPx, yPx, radiusPx * 1.6, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = 1;
      ctx.fillStyle = bodyColor;
      ctx.beginPath();
      ctx.arc(xPx, yPx, radiusPx, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * Draws summoned familiars.
   *
   * Forms are distinguished by silhouette rather than by sprite: fliers get
   * beating wings, hoppers get legs. The donor's per-form art is not ported, so
   * this is deliberately schematic — enough to read what is on screen and who
   * it belongs to.
   */
  private _renderSummons(
    ctx: CanvasRenderingContext2D,
    weapon: PlayerWeaponState,
    ox: number,
    oy: number,
    zoom: number,
  ): void {
    const pool = weapon.summons;
    if (pool.liveCount <= 0) return;

    const def = getEquippedWeaponDef(weapon);
    const bodyColor = def?.summonColor ?? def?.color ?? DEFAULT_BLADE_COLOR;
    const accentColor = def?.summonAccentColor
      ?? def?.spiderLegColor
      ?? def?.birdLineColor
      ?? bodyColor;

    ctx.save();
    for (let i = 0; i < MAX_ACTIVE_SUMMONS; i++) {
      if (pool.isLive[i] === 0) continue;

      const isGuardian = pool.isGuardian[i] === 1;
      const xPx = (pool.xWorld[i] - ox) * zoom;
      const yPx = (pool.yWorld[i] - oy) * zoom;
      const radiusPx = Math.max(1, pool.radiusWorld[i] * zoom * 0.5);

      // Fade the last half-second of life so a familiar's expiry reads as
      // deliberate rather than as a pop-out.
      const fadeTicks = 30;
      ctx.globalAlpha = pool.lifetimeTicks[i] < fadeTicks
        ? Math.max(0.15, pool.lifetimeTicks[i] / fadeTicks)
        : 1;

      // A raised thrall is not the equipped weapon's familiar and must not
      // borrow its coloring — it reads as necrotic instead, and keeps its own
      // look after a weapon swap.
      const isThrall = pool.isThrall[i] === 1;
      const familiarColor = isThrall
        ? THRALL_BODY_COLOR
        : isGuardian ? (def?.guardianColor ?? '#f6baff') : bodyColor;

      // Guardian aura ring
      if (isGuardian) {
        ctx.strokeStyle = familiarColor;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(xPx, yPx, radiusPx * 1.35, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.fillStyle = familiarColor;
      ctx.beginPath();
      ctx.arc(xPx, yPx, radiusPx, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = isThrall ? THRALL_ACCENT_COLOR : isGuardian ? '#ffffff' : accentColor;
      ctx.lineWidth = Math.max(1, radiusPx * 0.3);
      ctx.beginPath();
      if (pool.locomotion[i] === SUMMON_LOCOMOTION_FLIER) {
        // Wings: a pair of strokes swept back from the body.
        ctx.moveTo(xPx - radiusPx * 1.8, yPx - radiusPx);
        ctx.lineTo(xPx, yPx);
        ctx.lineTo(xPx + radiusPx * 1.8, yPx - radiusPx);
      } else {
        // Legs: a pair of strokes planted below the body.
        ctx.moveTo(xPx - radiusPx * 1.4, yPx + radiusPx * 1.6);
        ctx.lineTo(xPx, yPx);
        ctx.lineTo(xPx + radiusPx * 1.4, yPx + radiusPx * 1.6);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * Draws the expanding ring an on-expiry effect leaves behind.
   *
   * The ring grows to the effect's actual radius and fades out, so what the
   * player sees is exactly the area that was damaged, slowed, or shoved — the
   * simulation owns the number, and this never invents its own.
   */
  private _renderExpiryFlashes(
    ctx: CanvasRenderingContext2D,
    weapon: PlayerWeaponState,
    ox: number,
    oy: number,
    zoom: number,
  ): void {
    const pool = weapon.expiryFlashes;
    if (pool.liveCount <= 0) return;

    ctx.save();
    for (let i = 0; i < MAX_EXPIRY_FLASHES; i++) {
      if (pool.isLive[i] === 0) continue;

      // 0 at spawn, 1 at expiry.
      const progress = 1 - pool.ticksRemaining[i] / EXPIRY_FLASH_TICKS;
      const xPx = (pool.xWorld[i] - ox) * zoom;
      const yPx = (pool.yWorld[i] - oy) * zoom;
      // Starts at 35% and opens to the full radius, so the burst reads as
      // outward motion rather than as a circle appearing.
      const radiusPx = pool.radiusWorld[i] * zoom * (0.35 + 0.65 * progress);

      ctx.globalAlpha = Math.max(0, 1 - progress) * 0.75;
      ctx.strokeStyle = pool.color[i];
      ctx.lineWidth = Math.max(1, 2.5 * zoom * (1 - progress * 0.6));
      ctx.beginPath();
      ctx.arc(xPx, yPx, radiusPx, 0, Math.PI * 2);
      ctx.stroke();

      // A soft fill early on gives the burst body; it clears well before the
      // ring does so the ring is what the eye follows outward.
      if (progress < 0.5) {
        ctx.globalAlpha = (0.5 - progress) * 0.4;
        ctx.fillStyle = pool.color[i];
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /** Draws floating soul orbs dropped by defeated enemies. */
  private _renderSoulOrbs(
    ctx: CanvasRenderingContext2D,
    weapon: PlayerWeaponState,
    ox: number,
    oy: number,
    zoom: number,
  ): void {
    const pool = weapon.soulOrbs;
    if (pool.liveCount <= 0) return;

    ctx.save();
    for (let i = 0; i < MAX_SOUL_ORBS; i++) {
      if (pool.isLive[i] === 0) continue;

      const xPx = (pool.xWorld[i] - ox) * zoom;
      const yPx = (pool.yWorld[i] - oy) * zoom;
      const radiusPx = Math.max(2, 4.5 * zoom);
      const color = pool.color[i];

      // Subtle outer glow
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(xPx, yPx, radiusPx * 1.8, 0, Math.PI * 2);
      ctx.fill();

      // Bright inner soul core
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.arc(xPx, yPx, radiusPx, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** Draws the held weapon at the grip anchor according to its kind and pose. */
  private _renderHeldWeapon(
    ctx: CanvasRenderingContext2D,
    snapshot: WorldSnapshot,
    weapon: PlayerWeaponState,
    def: WeaponDef,
    ox: number,
    oy: number,
    zoom: number,
  ): void {
    if (def.showWeapon === false) return;

    const body = snapshot.stickRangerBody;
    if (body === null) return;

    // Angle and length come from the pose the simulation resolved against the
    // tiles this tick (`tickHeldWeaponPose`) — re-deriving them here could
    // disagree with it. The grip is still resolved from the body so it can use
    // the render interpolation the pose, being tick-aligned, does not have.
    const pose = weapon.heldPose;
    computeWeaponGripAnchor(body, def, getStickRangerRenderAlpha(body), this._anchor);

    const swing = weapon.swing;
    const isSwinging = swing.activeFlag === 1;
    const angleRad = pose.angleRad;

    const originXPx = (this._anchor.xWorld - ox) * zoom;
    const originYPx = (this._anchor.yWorld - oy) * zoom;

    ctx.save();

    if (def.kind === 'melee' || def.kind === 'shield') {
      this._renderHeldMelee(ctx, weapon, def, originXPx, originYPx, angleRad, isSwinging, zoom);
    } else if (def.kind === 'bow') {
      this._renderHeldBow(ctx, def, originXPx, originYPx, angleRad, zoom);
    } else if (def.kind === 'gun') {
      this._renderHeldGun(ctx, def, originXPx, originYPx, angleRad, zoom);
    } else if (def.kind === 'staff' || def.kind === 'magic') {
      this._renderHeldStaff(ctx, def, originXPx, originYPx, angleRad, zoom);
    } else if (def.kind === 'summoner') {
      this._renderHeldBook(ctx, def, originXPx, originYPx, angleRad, zoom);
    }

    ctx.restore();
  }

  private _renderHeldMelee(
    ctx: CanvasRenderingContext2D,
    weapon: PlayerWeaponState,
    def: WeaponDef,
    originXPx: number,
    originYPx: number,
    angleRad: number,
    isSwinging: boolean,
    zoom: number,
  ): void {
    const swing = weapon.swing;
    // Already clipped to what fits: a blade wedged into a wall draws short
    // rather than through it.
    const reach = weapon.heldPose.reachWorld;
    if (reach <= 0) return;

    const color = def.color ?? DEFAULT_BLADE_COLOR;
    const isSpear = def.poseStyle === 'spear' || def.spearPose !== undefined;

    if (isSwinging) {
      this._renderSwingTrail(ctx, originXPx, originYPx, angleRad, reach, zoom, color, swing.startAngleRad);
    }

    if (def.spriteUrl) {
      const img = loadImg(def.spriteUrl);
      if (isSpriteReady(img)) {
        const gripRatioX = def.spriteGripRatioX ?? 0.5;
        const gripRatioY = def.spriteGripRatioY ?? 0.9;
        // Sized from the weapon's true length, never from the clipped one: a
        // blade pressed into a wall must lose its tip, not shrink whole.
        const drawHWorld = weapon.heldPose.requestedReachWorld / gripRatioY;
        const drawWWorld = drawHWorld * (img.naturalWidth / img.naturalHeight);
        const drawHPx = drawHWorld * zoom;
        const drawWPx = drawWWorld * zoom;

        ctx.save();
        ctx.translate(originXPx, originYPx);
        // Sprite has tip at top (pointing along -Y in unrotated space).
        // Rotate by (angleRad + Math.PI / 2) so the tip points along angleRad.
        ctx.rotate(angleRad + Math.PI / 2);
        if (weapon.heldPose.tipContactFlag === 1) {
          // Blade runs along -Y here, so keep only the span the tip reached.
          ctx.beginPath();
          ctx.rect(-drawWPx, -reach * zoom, drawWPx * 2, drawHPx + reach * zoom);
          ctx.clip();
        }
        ctx.drawImage(img, -drawWPx * gripRatioX, -drawHPx * gripRatioY, drawWPx, drawHPx);
        ctx.restore();
        return;
      }
    }

    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);
    const tipX = originXPx + cos * reach * zoom;
    const tipY = originYPx + sin * reach * zoom;

    if (isSpear) {
      // Spear shaft
      ctx.strokeStyle = color;
      ctx.lineWidth = BLADE_WIDTH_PX;
      ctx.beginPath();
      ctx.moveTo(originXPx - cos * 6 * zoom, originYPx - sin * 6 * zoom);
      ctx.lineTo(tipX, tipY);
      ctx.stroke();

      // Spearhead diamond
      const perpX = -sin;
      const perpY = cos;
      const headLen = 8 * zoom;
      const headWidth = 3 * zoom;
      ctx.fillStyle = def.highlightColor ?? color;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - cos * headLen + perpX * headWidth, tipY - sin * headLen + perpY * headWidth);
      ctx.lineTo(tipX - cos * (headLen * 1.3), tipY - sin * (headLen * 1.3));
      ctx.lineTo(tipX - cos * headLen - perpX * headWidth, tipY - sin * headLen - perpY * headWidth);
      ctx.closePath();
      ctx.fill();
    } else {
      // Standard blade
      ctx.strokeStyle = color;
      ctx.lineWidth = BLADE_WIDTH_PX;
      ctx.beginPath();
      ctx.moveTo(originXPx, originYPx);
      ctx.lineTo(tipX, tipY);
      ctx.stroke();
    }
  }

  private _renderHeldBow(
    ctx: CanvasRenderingContext2D,
    def: WeaponDef,
    originXPx: number,
    originYPx: number,
    angleRad: number,
    zoom: number,
  ): void {
    const color = def.color ?? '#c58f57';
    const span = 14 * zoom;
    const curveForward = 5 * zoom;

    const fwdX = Math.cos(angleRad);
    const fwdY = Math.sin(angleRad);
    const perpX = -fwdY;
    const perpY = fwdX;

    const topX = originXPx + fwdX * curveForward + perpX * span;
    const topY = originYPx + fwdY * curveForward + perpY * span;
    const botX = originXPx + fwdX * curveForward - perpX * span;
    const botY = originYPx + fwdY * curveForward - perpY * span;

    // Curved bow limbs
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(topX, topY);
    ctx.quadraticCurveTo(originXPx - fwdX * 2 * zoom, originYPx - fwdY * 2 * zoom, botX, botY);
    ctx.stroke();

    // Bowstring
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.65)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(topX, topY);
    ctx.lineTo(originXPx - fwdX * 3 * zoom, originYPx - fwdY * 3 * zoom);
    ctx.lineTo(botX, botY);
    ctx.stroke();
  }

  private _renderHeldGun(
    ctx: CanvasRenderingContext2D,
    def: WeaponDef,
    originXPx: number,
    originYPx: number,
    angleRad: number,
    zoom: number,
  ): void {
    const color = def.color ?? '#778899';
    const barrelLen = (readNumber(def.gunPose, 'barrelLength') ?? 16) * zoom;
    const fwdX = Math.cos(angleRad);
    const fwdY = Math.sin(angleRad);
    const perpX = -fwdY;
    const perpY = fwdX;

    // Main barrel
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(originXPx, originYPx);
    ctx.lineTo(originXPx + fwdX * barrelLen, originYPx + fwdY * barrelLen);
    ctx.stroke();

    // Handle / receiver grip
    ctx.strokeStyle = def.highlightColor ?? '#445566';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(originXPx, originYPx);
    ctx.lineTo(originXPx - perpX * 5 * zoom - fwdX * 2 * zoom, originYPx - perpY * 5 * zoom - fwdY * 2 * zoom);
    ctx.stroke();

    // Scope / sight
    if (def.scopeColor) {
      ctx.fillStyle = def.scopeColor;
      ctx.fillRect(
        originXPx + fwdX * (barrelLen * 0.4) + perpX * 3 * zoom - 2,
        originYPx + fwdY * (barrelLen * 0.4) + perpY * 3 * zoom - 2,
        4,
        4,
      );
    }
  }

  private _renderHeldStaff(
    ctx: CanvasRenderingContext2D,
    def: WeaponDef,
    originXPx: number,
    originYPx: number,
    angleRad: number,
    zoom: number,
  ): void {
    const config = def.staff as Readonly<Record<string, unknown>> | undefined;
    const shaftLen = (readNumber(config, 'shaftLength') ?? 24) * zoom * 0.5;
    const shaftColor = readString(config, 'shaftColor') ?? def.color ?? '#8b5a2b';
    const gemColor = readString(config, 'gemColor') ?? def.beamCoreColor ?? '#77ddff';

    const fwdX = Math.cos(angleRad);
    const fwdY = Math.sin(angleRad);

    const baseXPx = originXPx - fwdX * (shaftLen * 0.35);
    const baseYPx = originYPx - fwdY * (shaftLen * 0.35);
    const headXPx = originXPx + fwdX * (shaftLen * 0.65);
    const headYPx = originYPx + fwdY * (shaftLen * 0.65);

    // Shaft line
    ctx.strokeStyle = shaftColor;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(baseXPx, baseYPx);
    ctx.lineTo(headXPx, headYPx);
    ctx.stroke();

    // Glowing jewel head
    const gemRadius = 3.5 * zoom * 0.5;
    ctx.fillStyle = gemColor;
    ctx.beginPath();
    ctx.arc(headXPx, headYPx, Math.max(2, gemRadius), 0, Math.PI * 2);
    ctx.fill();

    // Subtle gem halo
    ctx.strokeStyle = gemColor;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(headXPx, headYPx, Math.max(3, gemRadius * 1.5), 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  private _renderHeldBook(
    ctx: CanvasRenderingContext2D,
    def: WeaponDef,
    originXPx: number,
    originYPx: number,
    angleRad: number,
    zoom: number,
  ): void {
    const coverColor = def.bookTrimColor ?? def.color ?? '#8a2be2';
    const pageColor = def.bookPageColor ?? '#fdf5e6';
    const runeColor = def.bookRuneColor ?? '#00ffff';

    const fwdX = Math.cos(angleRad);
    const fwdY = Math.sin(angleRad);
    const perpX = -fwdY;
    const perpY = fwdX;

    const bookW = 8 * zoom;
    const bookH = 11 * zoom;

    // Tome cover background
    ctx.fillStyle = coverColor;
    ctx.beginPath();
    ctx.moveTo(originXPx - perpX * (bookW * 0.5), originYPx - perpY * (bookW * 0.5));
    ctx.lineTo(originXPx + perpX * (bookW * 0.5), originYPx + perpY * (bookW * 0.5));
    ctx.lineTo(originXPx + perpX * (bookW * 0.5) + fwdX * bookH, originYPx + perpY * (bookW * 0.5) + fwdY * bookH);
    ctx.lineTo(originXPx - perpX * (bookW * 0.5) + fwdX * bookH, originYPx - perpY * (bookW * 0.5) + fwdY * bookH);
    ctx.closePath();
    ctx.fill();

    // Pages (slightly inset)
    ctx.fillStyle = pageColor;
    ctx.beginPath();
    ctx.moveTo(originXPx - perpX * (bookW * 0.4) + fwdX * 2 * zoom, originYPx - perpY * (bookW * 0.4) + fwdY * 2 * zoom);
    ctx.lineTo(originXPx + perpX * (bookW * 0.4) + fwdX * 2 * zoom, originYPx + perpY * (bookW * 0.4) + fwdY * 2 * zoom);
    ctx.lineTo(originXPx + perpX * (bookW * 0.4) + fwdX * (bookH - 2 * zoom), originYPx + perpY * (bookW * 0.4) + fwdY * (bookH - 2 * zoom));
    ctx.lineTo(originXPx - perpX * (bookW * 0.4) + fwdX * (bookH - 2 * zoom), originYPx - perpY * (bookW * 0.4) + fwdY * (bookH - 2 * zoom));
    ctx.closePath();
    ctx.fill();

    // Central glowing rune dot
    const runeX = originXPx + fwdX * (bookH * 0.5);
    const runeY = originYPx + fwdY * (bookH * 0.5);
    ctx.fillStyle = runeColor;
    ctx.beginPath();
    ctx.arc(runeX, runeY, 2 * zoom, 0, Math.PI * 2);
    ctx.fill();
  }

  /** Draws a short fading arc behind the blade to read the swing's direction. */
  private _renderSwingTrail(
    ctx: CanvasRenderingContext2D,
    originXPx: number,
    originYPx: number,
    angleRad: number,
    reachWorld: number,
    zoom: number,
    color: string,
    startAngleRad: number,
  ): void {
    // Trail behind the direction of travel, so it reads correctly whichever way
    // the swing winds.
    const sweepSign = angleRad >= startAngleRad ? -1 : 1;

    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    for (let i = 1; i <= SWING_TRAIL_SAMPLES; i++) {
      const t = i / SWING_TRAIL_SAMPLES;
      const sampleAngle = angleRad + sweepSign * SWING_TRAIL_ARC_RAD * t;
      ctx.globalAlpha = 0.35 * (1 - t);
      ctx.beginPath();
      ctx.moveTo(originXPx, originYPx);
      ctx.lineTo(
        originXPx + Math.cos(sampleAngle) * reachWorld * zoom,
        originYPx + Math.sin(sampleAngle) * reachWorld * zoom,
      );
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /** Draws every live projectile as a small square with a short motion trail. */
  private _renderProjectiles(
    ctx: CanvasRenderingContext2D,
    weapon: PlayerWeaponState,
    ox: number,
    oy: number,
    zoom: number,
  ): void {
    const pool = weapon.projectiles;
    if (pool.liveCount <= 0) return;

    const def = getEquippedWeaponDef(weapon);
    const bodyColor = def?.projectileColor ?? def?.color ?? DEFAULT_BLADE_COLOR;
    const trailColor = def?.projectileTrailColor ?? bodyColor;

    ctx.save();

    for (let i = 0; i < MAX_WEAPON_PROJECTILES; i++) {
      if (pool.isLive[i] === 0) continue;

      const xPx = (pool.xWorld[i] - ox) * zoom;
      const yPx = (pool.yWorld[i] - oy) * zoom;
      const halfPx = Math.max(1, (pool.radiusWorld[i] || PROJECTILE_FALLBACK_HALF_PX) * zoom);

      // Trail drawn along the reverse of this projectile's own velocity, so it
      // stays correct for bounced and homing shots rather than assuming the
      // original launch direction.
      const vx = pool.velocityXWorld[i];
      const vy = pool.velocityYWorld[i];
      const speed = Math.sqrt(vx * vx + vy * vy);
      if (speed > 1e-3) {
        const trailLengthPx = Math.min(halfPx * 6, speed * zoom * 0.02);
        ctx.strokeStyle = trailColor;
        ctx.globalAlpha = 0.45;
        ctx.lineWidth = Math.max(1, halfPx * 0.8);
        ctx.beginPath();
        ctx.moveTo(xPx, yPx);
        ctx.lineTo(xPx - (vx / speed) * trailLengthPx, yPx - (vy / speed) * trailLengthPx);
        ctx.stroke();
      }

      ctx.globalAlpha = 1;
      ctx.fillStyle = bodyColor;
      ctx.fillRect(xPx - halfPx, yPx - halfPx, halfPx * 2, halfPx * 2);
    }

    ctx.restore();
  }

  /**
   * Progress through the current swing, 0..1. Exposed for animation code that
   * wants to drive a pose from the swing rather than re-deriving the timing.
   */
  getSwingProgress(snapshot: WorldSnapshot): number {
    const weapon = snapshot.playerWeapon;
    if (weapon === null) return 0;
    return getWeaponSwingProgress(weapon.swing);
  }
}
