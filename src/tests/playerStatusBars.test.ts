/**
 * Tests for the player health / resource bars.
 *
 * Covers the two color ramps at their specified stops, the 13-unit segmented
 * vs solid threshold, and when the overhead pair is visible.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  SEGMENTED_BAR_MAX_UNITS,
  getHealthBarColor,
  getManaBarColor,
  getResourceBarColor,
  isSegmentedResource,
  shouldShowOverheadBars,
  type PlayerOverheadBarState,
} from '../render/hud/playerStatusBars';

/** Parses `rgb(r,g,b)` into a numeric triple. */
function rgb(color: string): [number, number, number] {
  const match = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(color);
  assert.ok(match, `expected an rgb() color, got ${color}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

describe('health color ramp', () => {
  test('full health is green', () => {
    const [r, g, b] = rgb(getHealthBarColor(1));
    assert.ok(g > 150, `expected a green-dominant color, got ${r},${g},${b}`);
    assert.ok(g > r && g > b);
  });

  test('half health is yellow — red and green both high, blue low', () => {
    const [r, g, b] = rgb(getHealthBarColor(0.5));
    assert.ok(r > 200 && g > 180, `expected yellow, got ${r},${g},${b}`);
    assert.ok(b < 100);
  });

  test('a quarter health is orange — red clearly above green', () => {
    const [r, g, b] = rgb(getHealthBarColor(0.25));
    assert.ok(r > 200, `expected a red-dominant orange, got ${r},${g},${b}`);
    assert.ok(r > g && g > b);
  });

  test('a tenth health is red', () => {
    const [r, g, b] = rgb(getHealthBarColor(0.10));
    assert.ok(r > 180 && g < 80 && b < 80, `expected red, got ${r},${g},${b}`);
  });

  test('the ramp shifts monotonically toward red as health drains', () => {
    // Measured as red *relative to* green, not raw red: yellow and orange have
    // near-identical red channels and differ by how much green is left, so a
    // raw-red check would read the ramp as flat between them.
    let previousRedness = -Infinity;
    for (const fraction of [1, 0.75, 0.5, 0.25, 0.1]) {
      const [r, g] = rgb(getHealthBarColor(fraction));
      const redness = r - g;
      assert.ok(redness >= previousRedness, `redness fell at fraction ${fraction}`);
      previousRedness = redness;
    }
  });

  test('out-of-range fractions clamp instead of extrapolating', () => {
    assert.equal(getHealthBarColor(2), getHealthBarColor(1));
    assert.equal(getHealthBarColor(-1), getHealthBarColor(0));
  });
});

describe('mana color ramp', () => {
  test('full mana is deep purple — blue above red, both dark', () => {
    const [r, g, b] = rgb(getManaBarColor(1));
    assert.ok(b > r && r > g, `expected purple, got ${r},${g},${b}`);
    assert.ok(b < 200, 'deep purple should not be a bright blue');
  });

  test('half mana is blue', () => {
    const [r, g, b] = rgb(getManaBarColor(0.5));
    assert.ok(b > 180, `expected blue, got ${r},${g},${b}`);
    assert.ok(b > r && b > g);
  });

  test('empty mana is pale light blue — every channel high', () => {
    const [r, g, b] = rgb(getManaBarColor(0));
    assert.ok(r > 150 && g > 200 && b > 200, `expected pale blue, got ${r},${g},${b}`);
  });

  test('the ramp lightens as mana drains', () => {
    // Perceived lightness must increase from deep purple to pale blue.
    const sum = (f: number) => rgb(getManaBarColor(f)).reduce((a, c) => a + c, 0);
    assert.ok(sum(1) < sum(0.5));
    assert.ok(sum(0.5) < sum(0));
  });
});

describe('segmented vs solid', () => {
  test('ammo and dust segment at 12 or fewer', () => {
    assert.equal(isSegmentedResource('ammo', 1), true);
    assert.equal(isSegmentedResource('ammo', SEGMENTED_BAR_MAX_UNITS), true);
    assert.equal(isSegmentedResource('dust', SEGMENTED_BAR_MAX_UNITS), true);
  });

  test('ammo and dust go solid at 13 or more', () => {
    assert.equal(isSegmentedResource('ammo', SEGMENTED_BAR_MAX_UNITS + 1), false);
    assert.equal(isSegmentedResource('dust', 40), false);
  });

  test('mana is always solid, however small the pool', () => {
    assert.equal(isSegmentedResource('mana', 1), false);
    assert.equal(isSegmentedResource('mana', 5), false);
    assert.equal(isSegmentedResource('mana', 100), false);
  });

  test('a zero-capacity pool is not segmented', () => {
    assert.equal(isSegmentedResource('ammo', 0), false);
  });

  test('ammo and dust are flat colors, mana follows its ramp', () => {
    assert.equal(getResourceBarColor('ammo', 1), getResourceBarColor('ammo', 0));
    assert.equal(getResourceBarColor('dust', 1), getResourceBarColor('dust', 0));
    assert.notEqual(getResourceBarColor('mana', 1), getResourceBarColor('mana', 0));
  });
});

describe('overhead bar visibility', () => {
  function state(overrides: Partial<PlayerOverheadBarState> = {}): PlayerOverheadBarState {
    return {
      positionXWorld: 0,
      positionYWorld: 0,
      halfHeightWorld: 4,
      healthPoints: 50,
      maxHealthPoints: 50,
      resourceKind: null,
      resourcePool: null,
      ...overrides,
    };
  }

  test('hidden at full health with no metered weapon', () => {
    assert.equal(shouldShowOverheadBars(state()), false);
  });

  test('shown once damaged', () => {
    assert.equal(shouldShowOverheadBars(state({ healthPoints: 49 })), true);
  });

  test('shown at full health when the resource pool is short', () => {
    // A full-health player firing a gun still needs to see the magazine.
    assert.equal(shouldShowOverheadBars(state({
      resourceKind: 'ammo',
      resourcePool: { current: 3, max: 10, regenAccumulator: 0 },
    })), true);
  });

  test('hidden at full health with a full resource pool', () => {
    assert.equal(shouldShowOverheadBars(state({
      resourceKind: 'ammo',
      resourcePool: { current: 10, max: 10, regenAccumulator: 0 },
    })), false);
  });
});
