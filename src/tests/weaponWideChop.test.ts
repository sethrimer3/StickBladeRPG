/**
 * The wide cut: short and medium blades sweep a full 180° on EVERY swing,
 * 11→5 o'clock facing right and 1→7 o'clock facing left.
 *
 * The "every swing" part is the point. This started as an opening cut with the
 * donor's narrow `arc` on the follow-ups, which read as one big swing followed
 * by a few tiny ones. There is no second arc for these weapons any more.
 *
 * Screen convention: Y grows downward, so 12 o'clock is -π/2 and each hour is
 * π/6 clockwise from there.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  MEDIUM_BLADE_MAX_RANGE_WORLD,
  MELEE_SWING_SPEED_MULTIPLIER,
  SHORT_BLADE_MAX_RANGE_WORLD,
  createWeaponSwingState,
  getMeleeLengthClass,
  getMeleeSwingCooldownTicks,
  getMeleeSwingDurationTicks,
  getWideChopArc,
  startWeaponSwing,
  weaponHasWideChop,
  type WeaponSwingState,
} from '../sim/weapons/weaponSwing';
import {
  getWeaponCooldownTicks,
  getWeaponSwingDurationTicks,
  getWeaponDef,
  type WeaponDef,
} from '../sim/weapons/weaponDefs';

/** Angle of a clock-face hour, in the renderer's Y-down frame, wrapped to (-π, π]. */
function clock(hour: number): number {
  const raw = -Math.PI / 2 + (hour % 12) * (Math.PI / 6);
  return raw > Math.PI ? raw - Math.PI * 2 : raw;
}

const SHORT_BLADE = getWeaponDef('woodenSword') as WeaponDef;        // range 21
const MEDIUM_BLADE = getWeaponDef('sword') as WeaponDef;             // range 42
const LONG_BLADE = getWeaponDef('crumblingClaymore') as WeaponDef;   // range 80
const SPEAR = getWeaponDef('spear') as WeaponDef;                    // range 54, thrusts

/** Frees the state to swing again without waiting out the cooldown. */
function makeReady(state: WeaponSwingState): void {
  state.activeFlag = 0;
  state.cooldownRemainingTicks = 0;
}

describe('blade length classes', () => {
  test('reach decides the class', () => {
    assert.equal(getMeleeLengthClass(SHORT_BLADE), 'short');
    assert.equal(getMeleeLengthClass(MEDIUM_BLADE), 'medium');
    assert.equal(getMeleeLengthClass(LONG_BLADE), 'long');
    assert.ok(SHORT_BLADE_MAX_RANGE_WORLD < MEDIUM_BLADE_MAX_RANGE_WORLD);
  });

  test('weapons with no blade to sweep have no class', () => {
    assert.equal(getMeleeLengthClass(getWeaponDef('pyreBoxingGloves') as WeaponDef), null);
    assert.equal(getMeleeLengthClass(getWeaponDef('templarianWallShield') as WeaponDef), null);
  });

  test('short and medium blades chop; long blades and spears do not', () => {
    assert.equal(weaponHasWideChop(SHORT_BLADE), true);
    assert.equal(weaponHasWideChop(MEDIUM_BLADE), true);
    assert.equal(weaponHasWideChop(LONG_BLADE), false);
    assert.equal(weaponHasWideChop(SPEAR), false, 'a spear thrusts, it does not cut overhead');
  });

  test('every weave blade chops', () => {
    for (const id of ['goldweaveBlade', 'frostweaveBlade', 'emberweaveBlade']) {
      assert.equal(weaponHasWideChop(getWeaponDef(id) as WeaponDef), true, id);
    }
  });
});

describe('wide chop geometry', () => {
  test('facing right cuts clockwise from 11 to 5 o\'clock', () => {
    const arc = getWideChopArc(false);
    assert.ok(Math.abs(arc.startAngleRad - clock(11)) < 1e-9, `start ${arc.startAngleRad}`);
    assert.ok(Math.abs(arc.endAngleRad - clock(5)) < 1e-9, `end ${arc.endAngleRad}`);
    assert.ok(arc.endAngleRad > arc.startAngleRad, 'right-facing sweeps clockwise');
  });

  test('facing left cuts counter-clockwise from 1 to 7 o\'clock', () => {
    const arc = getWideChopArc(true);
    assert.ok(Math.abs(arc.startAngleRad - clock(1)) < 1e-9, `start ${arc.startAngleRad}`);
    // 7 o'clock reached the long way round, so the raw end is 7 minus a turn.
    assert.ok(Math.abs(arc.endAngleRad - (clock(7) - Math.PI * 2)) < 1e-9, `end ${arc.endAngleRad}`);
    assert.ok(arc.endAngleRad < arc.startAngleRad, 'left-facing sweeps counter-clockwise');
  });

  test('both facings sweep exactly half a turn', () => {
    for (const facingLeft of [false, true]) {
      const arc = getWideChopArc(facingLeft);
      assert.ok(Math.abs(Math.abs(arc.endAngleRad - arc.startAngleRad) - Math.PI) < 1e-9);
    }
  });

  test('the two facings are mirror images across the vertical', () => {
    const right = getWideChopArc(false);
    const left = getWideChopArc(true);
    // Mirroring x maps an angle θ to π − θ.
    assert.ok(Math.abs((Math.PI - right.startAngleRad) - (left.startAngleRad + Math.PI * 2)) < 1e-9);
  });
});

describe('every swing is the wide cut', () => {
  test('the first swing chops and ignores the aim', () => {
    const state = createWeaponSwingState();
    // Aim straight up; the cut must still run 11 → 5 because facing sets it.
    startWeaponSwing(state, SHORT_BLADE, 0, -50, 0, 0, false);
    assert.equal(state.isWideChopFlag, 1);
    assert.ok(Math.abs(state.startAngleRad - clock(11)) < 1e-9);
    assert.ok(Math.abs(state.endAngleRad - clock(5)) < 1e-9);
  });

  test('the tenth swing is identical to the first — no narrow follow-up', () => {
    const state = createWeaponSwingState();
    for (let i = 0; i < 10; i++) {
      makeReady(state);
      startWeaponSwing(state, SHORT_BLADE, 50, 0, 0, 0, false);
      assert.equal(state.isWideChopFlag, 1, `swing ${i + 1} should still chop`);
      const span = Math.abs(state.endAngleRad - state.startAngleRad);
      assert.ok(Math.abs(span - Math.PI) < 1e-9, `swing ${i + 1} span ${span}`);
    }
  });

  test('the declared arc no longer narrows a chopping weapon', () => {
    // `sword` declares arc 1.0 rad. That value must not reach the swing.
    assert.ok((MEDIUM_BLADE.arc as number) < Math.PI * 0.5);
    const state = createWeaponSwingState();
    startWeaponSwing(state, MEDIUM_BLADE, 50, 0, 0, 0, false);
    const span = Math.abs(state.endAngleRad - state.startAngleRad);
    assert.ok(Math.abs(span - Math.PI) < 1e-9, `span ${span} should be a half turn`);
  });

  test('a long weapon keeps its declared arc, on every swing', () => {
    const state = createWeaponSwingState();
    for (let i = 0; i < 3; i++) {
      makeReady(state);
      startWeaponSwing(state, LONG_BLADE, 50, 0, 0, 0, false);
      assert.equal(state.isWideChopFlag, 0);
      const span = Math.abs(state.endAngleRad - state.startAngleRad);
      assert.ok(Math.abs(span - (LONG_BLADE.arc as number)) < 1e-9);
    }
  });

  test('facing left chops the mirrored way', () => {
    const state = createWeaponSwingState();
    startWeaponSwing(state, SHORT_BLADE, -50, 0, 0, 0, true);
    assert.equal(state.isWideChopFlag, 1);
    assert.ok(Math.abs(state.startAngleRad - clock(1)) < 1e-9);
    assert.ok(state.endAngleRad < state.startAngleRad);
  });
});

describe('swing speed', () => {
  test('the multiplier speeds the swing up by half again', () => {
    assert.equal(MELEE_SWING_SPEED_MULTIPLIER, 1.5);
  });

  test('both the animation and the cooldown shorten, so no dead time appears', () => {
    for (const def of [SHORT_BLADE, MEDIUM_BLADE, LONG_BLADE]) {
      const baseDuration = getWeaponSwingDurationTicks(def);
      const baseCooldown = getWeaponCooldownTicks(def);
      assert.equal(getMeleeSwingDurationTicks(def), Math.max(1, Math.round(baseDuration / 1.5)));
      assert.equal(getMeleeSwingCooldownTicks(def), Math.round(baseCooldown / 1.5));
    }
  });

  test('a swing actually runs for the shortened duration', () => {
    const state = createWeaponSwingState();
    startWeaponSwing(state, SHORT_BLADE, 50, 0, 0, 0, false);
    assert.equal(state.durationTicks, getMeleeSwingDurationTicks(SHORT_BLADE));
    assert.ok(
      state.durationTicks < getWeaponSwingDurationTicks(SHORT_BLADE),
      'the swing should be shorter than the weapon data alone says',
    );
  });

  test('a swing never has to wait past its own animation', () => {
    const state = createWeaponSwingState();
    startWeaponSwing(state, SHORT_BLADE, 50, 0, 0, 0, false);
    assert.ok(state.cooldownRemainingTicks >= state.durationTicks);
  });
});
