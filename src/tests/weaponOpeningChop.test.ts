/**
 * The opening cut: short and medium blades start a combo with a fixed 180°
 * overhead arc, 11→5 o'clock facing right and 1→7 o'clock facing left.
 *
 * Screen convention: Y grows downward, so 12 o'clock is -π/2 and each hour is
 * π/6 clockwise from there.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  COMBO_RESET_IDLE_TICKS,
  MEDIUM_BLADE_MAX_RANGE_WORLD,
  SHORT_BLADE_MAX_RANGE_WORLD,
  createWeaponSwingState,
  getMeleeLengthClass,
  getOpeningChopArc,
  startWeaponSwing,
  tickWeaponCooldown,
  weaponHasOpeningChop,
} from '../sim/weapons/weaponSwing';
import { getWeaponDef, type WeaponDef } from '../sim/weapons/weaponDefs';

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
function makeReady(state: ReturnType<typeof createWeaponSwingState>): void {
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
    assert.equal(weaponHasOpeningChop(SHORT_BLADE), true);
    assert.equal(weaponHasOpeningChop(MEDIUM_BLADE), true);
    assert.equal(weaponHasOpeningChop(LONG_BLADE), false);
    assert.equal(weaponHasOpeningChop(SPEAR), false, 'a spear thrusts, it does not cut overhead');
  });

  test('every weave blade opens with the chop', () => {
    for (const id of ['goldweaveBlade', 'frostweaveBlade', 'emberweaveBlade']) {
      assert.equal(weaponHasOpeningChop(getWeaponDef(id) as WeaponDef), true, id);
    }
  });
});

describe('opening chop geometry', () => {
  test('facing right cuts clockwise from 11 to 5 o\'clock', () => {
    const arc = getOpeningChopArc(false);
    assert.ok(Math.abs(arc.startAngleRad - clock(11)) < 1e-9, `start ${arc.startAngleRad}`);
    assert.ok(Math.abs(arc.endAngleRad - clock(5)) < 1e-9, `end ${arc.endAngleRad}`);
    assert.ok(arc.endAngleRad > arc.startAngleRad, 'right-facing sweeps clockwise');
  });

  test('facing left cuts counter-clockwise from 1 to 7 o\'clock', () => {
    const arc = getOpeningChopArc(true);
    assert.ok(Math.abs(arc.startAngleRad - clock(1)) < 1e-9, `start ${arc.startAngleRad}`);
    // 7 o'clock reached the long way round, so the raw end is 7 - 12 hours.
    assert.ok(Math.abs(arc.endAngleRad - (clock(7) - Math.PI * 2)) < 1e-9, `end ${arc.endAngleRad}`);
    assert.ok(arc.endAngleRad < arc.startAngleRad, 'left-facing sweeps counter-clockwise');
  });

  test('both facings sweep exactly half a turn', () => {
    for (const facingLeft of [false, true]) {
      const arc = getOpeningChopArc(facingLeft);
      assert.ok(Math.abs(Math.abs(arc.endAngleRad - arc.startAngleRad) - Math.PI) < 1e-9);
    }
  });

  test('the two facings are mirror images across the vertical', () => {
    const right = getOpeningChopArc(false);
    const left = getOpeningChopArc(true);
    // Mirroring x maps an angle θ to π − θ.
    assert.ok(Math.abs((Math.PI - right.startAngleRad) - (left.startAngleRad + Math.PI * 2)) < 1e-9);
  });
});

describe('the chop opens a combo', () => {
  test('the first swing chops and ignores the aim', () => {
    const state = createWeaponSwingState();
    // Aim straight up; the chop must still run 11 → 5 because it is set by facing.
    startWeaponSwing(state, SHORT_BLADE, 0, -50, 0, 0, false);
    assert.equal(state.isOpeningChopFlag, 1);
    assert.ok(Math.abs(state.startAngleRad - clock(11)) < 1e-9);
    assert.ok(Math.abs(state.endAngleRad - clock(5)) < 1e-9);
  });

  test('the second swing returns to the weapon\'s own arc', () => {
    const state = createWeaponSwingState();
    startWeaponSwing(state, SHORT_BLADE, 50, 0, 0, 0, false);
    makeReady(state);
    startWeaponSwing(state, SHORT_BLADE, 50, 0, 0, 0, false);

    assert.equal(state.isOpeningChopFlag, 0);
    const span = Math.abs(state.endAngleRad - state.startAngleRad);
    assert.ok(Math.abs(span - (SHORT_BLADE.arc as number)) < 1e-9, `span ${span}`);
  });

  test('standing idle long enough returns the combo to its opening cut', () => {
    const state = createWeaponSwingState();
    startWeaponSwing(state, SHORT_BLADE, 50, 0, 0, 0, false);
    makeReady(state);
    assert.equal(state.comboIndex, 1);

    for (let i = 0; i < COMBO_RESET_IDLE_TICKS; i++) tickWeaponCooldown(state);
    assert.equal(state.comboIndex, 0, 'the combo should have lapsed');

    startWeaponSwing(state, SHORT_BLADE, 50, 0, 0, 0, false);
    assert.equal(state.isOpeningChopFlag, 1);
  });

  test('a cooldown does not burn the combo window', () => {
    const state = createWeaponSwingState();
    startWeaponSwing(state, SHORT_BLADE, 50, 0, 0, 0, false);
    state.activeFlag = 0;
    state.cooldownRemainingTicks = COMBO_RESET_IDLE_TICKS * 2;

    for (let i = 0; i < COMBO_RESET_IDLE_TICKS * 2; i++) tickWeaponCooldown(state);
    assert.equal(state.comboIndex, 1, 'waiting out a slow weapon must not reset the combo');
  });

  test('a long weapon never chops, on any swing', () => {
    const state = createWeaponSwingState();
    startWeaponSwing(state, LONG_BLADE, 50, 0, 0, 0, false);
    assert.equal(state.isOpeningChopFlag, 0);
    const span = Math.abs(state.endAngleRad - state.startAngleRad);
    assert.ok(Math.abs(span - (LONG_BLADE.arc as number)) < 1e-9);
  });

  test('facing left at combo start chops the mirrored way', () => {
    const state = createWeaponSwingState();
    startWeaponSwing(state, SHORT_BLADE, -50, 0, 0, 0, true);
    assert.equal(state.isOpeningChopFlag, 1);
    assert.ok(Math.abs(state.startAngleRad - clock(1)) < 1e-9);
    assert.ok(state.endAngleRad < state.startAngleRad);
  });
});
