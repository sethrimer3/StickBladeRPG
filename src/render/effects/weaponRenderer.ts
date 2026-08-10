/**
 * Renders the player's equipped STICK-RPG weapon: the held blade, its swing
 * arc, and any live projectiles.
 *
 * Phase 2b of the STICK-RPG port. Deliberately plain — flat colored lines and
 * squares drawn from the weapon's own palette fields (`color`,
 * `projectileColor`, `projectileTrailColor`), matching the donor's look rather
 * than inventing new art. The donor's bespoke per-weapon renderers (staff
 * heads, gun poses, shield faces) are not ported; their config blocks travel in
 * the weapon data ready for whoever does port them.
 *
 * Reads only. No simulation state is mutated, and there are no per-frame
 * allocations: the grip anchor is a reused instance field and every draw call
 * is a direct canvas primitive.
 */

import type { WorldSnapshot } from '../snapshot';
import {
  getEquippedWeaponDef,
  type PlayerWeaponState,
} from '../../sim/weapons/playerWeaponState';
import { getWeaponSwingProgress } from '../../sim/weapons/weaponSwing';
import { MAX_WEAPON_PROJECTILES } from '../../sim/weapons/weaponProjectiles';
import {
  computeWeaponGripAnchor,
  createWeaponGripAnchor,
  type WeaponGripAnchor,
} from '../../sim/weapons/weaponGrip';
import type { WeaponDef } from '../../sim/weapons/weaponDefs';

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

export class WeaponRenderer {
  /** Reused so per-frame anchor resolution allocates nothing. */
  private readonly _anchor: WeaponGripAnchor = createWeaponGripAnchor();

  render(
    ctx: CanvasRenderingContext2D,
    snapshot: WorldSnapshot,
    ox: number,
    oy: number,
    zoom: number,
  ): void {
    const weapon = snapshot.playerWeapon;
    if (weapon === null) return;

    const def = getEquippedWeaponDef(weapon);

    // Projectiles outlive the weapon that fired them, so they draw regardless
    // of what is currently equipped.
    this._renderProjectiles(ctx, weapon, ox, oy, zoom);

    if (def === null) return;
    this._renderHeldWeapon(ctx, snapshot, weapon, def, ox, oy, zoom);
  }

  /** Draws the blade at the grip anchor, swept to the swing's current angle. */
  private _renderHeldWeapon(
    ctx: CanvasRenderingContext2D,
    snapshot: WorldSnapshot,
    weapon: PlayerWeaponState,
    def: WeaponDef,
    ox: number,
    oy: number,
    zoom: number,
  ): void {
    // Contact weapons only: a bow or gun would need its own pose, which is not
    // ported. Drawing a sword line for a rifle would read as a bug.
    if (def.kind !== 'melee' && def.kind !== 'shield') return;

    const body = snapshot.stickRangerBody;
    if (body === null) return;

    computeWeaponGripAnchor(body, def, 1, this._anchor);

    const swing = weapon.swing;
    const isSwinging = swing.activeFlag === 1;
    // At rest the blade follows the arm; mid-swing it follows the sweep, so the
    // drawn blade and the damage arc are the same geometry.
    const angleRad = isSwinging ? swing.currentAngleRad : this._anchor.angleRad;

    const reach = isSwinging && swing.reachWorld > 0
      ? swing.reachWorld
      : (def.range ?? 0);
    if (reach <= 0) return;

    const color = def.color ?? DEFAULT_BLADE_COLOR;
    const originXPx = (this._anchor.xWorld - ox) * zoom;
    const originYPx = (this._anchor.yWorld - oy) * zoom;

    ctx.save();

    if (isSwinging) {
      this._renderSwingTrail(ctx, originXPx, originYPx, angleRad, reach, zoom, color, swing.startAngleRad);
    }

    ctx.strokeStyle = color;
    ctx.lineWidth = BLADE_WIDTH_PX;
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.moveTo(originXPx, originYPx);
    ctx.lineTo(
      originXPx + Math.cos(angleRad) * reach * zoom,
      originYPx + Math.sin(angleRad) * reach * zoom,
    );
    ctx.stroke();

    ctx.restore();
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
