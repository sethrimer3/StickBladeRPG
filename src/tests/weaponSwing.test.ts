import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  canStartWeaponSwing,
  createWeaponSwingState,
  getWeaponSwingProgress,
  isAngleWithinSweptInterval,
  isWeaponSwingInWindup,
  normalizeAngleRad,
  resetWeaponSwingState,
  shortestAngleDeltaRad,
  startWeaponSwing,
  tickWeaponCooldown,
  tickWeaponSwing,
  type WeaponSwingState,
  type WeaponSwingTarget,
} from '../sim/weapons/weaponSwing';
import { WEAPONS, getWeaponCooldownTicks, getWeaponSwingDurationTicks } from '../sim/weapons/weaponDefs';
import {
  GRIP_HAND_BOTH,
  GRIP_HAND_LEFT,
  GRIP_HAND_RIGHT,
  computeSwingOrigin,
  computeWeaponGripAnchor,
  createWeaponGripAnchor,
  resolveGripHand,
} from '../sim/weapons/weaponGrip';
import { createStickRangerBody } from '../sim/clusters/stickRangerBody';
import { createRng } from '../sim/rng';

const SWORD = WEAPONS['sword'];
const GREATSWORD = WEAPONS['greatsword'];

function createTarget(x: number, y: number, overrides: Partial<WeaponSwingTarget> = {}): WeaponSwingTarget {
  return {
    positionXWorld: x,
    positionYWorld: y,
    halfWidthWorld: 4,
    halfHeightWorld: 6,
    isAliveFlag: 1,
    ...overrides,
  };
}

/** Runs a swing to completion, returning total damage and hit count. */
function runSwingToCompletion(
  state: WeaponSwingState,
  targets: readonly WeaponSwingTarget[],
  originX = 0,
  originY = 0,
  attackerAttack = 1,
  seed = 1,
): { hits: number; damage: number; ticks: number } {
  const rng = createRng(seed);
  let hits = 0;
  let damage = 0;
  let ticks = 0;
  for (let i = 0; i < 500; i++) {
    const result = tickWeaponSwing(state, SWORD, {
      originXWorld: originX,
      originYWorld: originY,
      targets,
      attackerAttack,
      rng,
    });
    ticks++;
    hits += result.hitCount;
    damage += result.totalDamage;
    if (result.isFinished) break;
  }
  return { hits, damage, ticks };
}

describe('angle helpers', () => {
  test('normalize wraps into (-pi, pi]', () => {
    assert.ok(Math.abs(normalizeAngleRad(Math.PI * 3) - Math.PI) < 1e-9);
    assert.ok(Math.abs(normalizeAngleRad(-Math.PI * 3) - Math.PI) < 1e-9);
    assert.equal(normalizeAngleRad(0), 0);
  });

  test('shortest delta takes the short way around the circle', () => {
    const delta = shortestAngleDeltaRad(Math.PI * 0.9, -Math.PI * 0.9);
    assert.ok(Math.abs(delta) < Math.PI, `expected short path, got ${delta}`);
    assert.ok(delta > 0, 'crossing pi should read as positive');
  });

  test('swept interval includes angles crossed, excludes those outside', () => {
    assert.equal(isAngleWithinSweptInterval(0.5, 0, 1), true);
    assert.equal(isAngleWithinSweptInterval(1.5, 0, 1), false);
    assert.equal(isAngleWithinSweptInterval(-0.5, 0, -1), true);
  });

  test('swept interval works across the pi wrap', () => {
    // Sweeping from just under pi to just over -pi crosses pi itself.
    assert.equal(isAngleWithinSweptInterval(Math.PI, Math.PI - 0.1, -Math.PI + 0.1), true);
  });

  test('a zero-width sweep matches only its own angle', () => {
    assert.equal(isAngleWithinSweptInterval(1, 1, 1), true);
    assert.equal(isAngleWithinSweptInterval(1.2, 1, 1), false);
  });
});

describe('swing lifecycle', () => {
  test('a fresh state is idle and ready', () => {
    const state = createWeaponSwingState();
    assert.equal(state.activeFlag, 0);
    assert.equal(canStartWeaponSwing(state), true);
    assert.equal(getWeaponSwingProgress(state), 0);
  });

  test('starting a swing activates it with the weapon geometry', () => {
    const state = createWeaponSwingState();
    assert.equal(startWeaponSwing(state, SWORD, 50, 0, 0, 0, false), true);
    assert.equal(state.activeFlag, 1);
    assert.equal(state.reachWorld, SWORD.range);
    assert.equal(state.durationTicks, getWeaponSwingDurationTicks(SWORD));
    assert.ok(Math.abs(state.aimAngleRad) < 1e-9, 'aim right should be angle 0');
  });

  test('a follow-up arc spans the weapon arc, centered on the aim', () => {
    const state = createWeaponSwingState();
    // The first cut of a combo is the fixed 180° chop on a blade this length,
    // so advance past it to reach the ordinary aim-centred arc.
    startWeaponSwing(state, SWORD, 50, 0, 0, 0, false);
    state.activeFlag = 0;
    state.cooldownRemainingTicks = 0;

    startWeaponSwing(state, SWORD, 50, 0, 0, 0, false);
    assert.equal(state.isOpeningChopFlag, 0);
    const span = Math.abs(state.endAngleRad - state.startAngleRad);
    assert.ok(Math.abs(span - (SWORD.arc as number)) < 1e-9, `span ${span}`);
    assert.ok(Math.abs((state.startAngleRad + state.endAngleRad) * 0.5 - state.aimAngleRad) < 1e-9);
  });

  test('facing left mirrors the swing direction', () => {
    const right = createWeaponSwingState();
    startWeaponSwing(right, SWORD, 50, 0, 0, 0, false);
    const left = createWeaponSwingState();
    startWeaponSwing(left, SWORD, -50, 0, 0, 0, true);
    const rightSweep = right.endAngleRad - right.startAngleRad;
    const leftSweep = left.endAngleRad - left.startAngleRad;
    assert.ok(rightSweep * leftSweep < 0, 'sweeps should wind opposite ways');
  });

  test('non-contact weapons refuse to swing', () => {
    const state = createWeaponSwingState();
    assert.equal(startWeaponSwing(state, WEAPONS['bow'], 50, 0, 0, 0, false), false);
    assert.equal(state.activeFlag, 0);
  });

  test('a weapon with no range refuses to swing', () => {
    const state = createWeaponSwingState();
    const noRange = { ...SWORD, range: 0 };
    assert.equal(startWeaponSwing(state, noRange, 50, 0, 0, 0, false), false);
  });

  test('a zero-length aim vector falls back to facing', () => {
    const state = createWeaponSwingState();
    startWeaponSwing(state, SWORD, 0, 0, 0, 0, true);
    assert.ok(Math.abs(state.aimAngleRad - Math.PI) < 1e-9);
  });

  test('the swing completes after its duration and returns to idle', () => {
    const state = createWeaponSwingState();
    startWeaponSwing(state, SWORD, 50, 0, 0, 0, false);
    const { ticks } = runSwingToCompletion(state, []);
    assert.equal(ticks, getWeaponSwingDurationTicks(SWORD));
    assert.equal(state.activeFlag, 0);
  });

  test('ticking an idle state is a safe no-op', () => {
    const state = createWeaponSwingState();
    const result = tickWeaponSwing(state, SWORD, {
      originXWorld: 0, originYWorld: 0, targets: [], attackerAttack: 1, rng: createRng(1),
    });
    assert.equal(result.isFinished, true);
    assert.equal(result.hitCount, 0);
  });

  test('windup precedes blade travel', () => {
    const state = createWeaponSwingState();
    startWeaponSwing(state, GREATSWORD, 50, 0, 0, 0, false);
    tickWeaponSwing(state, GREATSWORD, {
      originXWorld: 0, originYWorld: 0, targets: [], attackerAttack: 1, rng: createRng(1),
    });
    assert.equal(isWeaponSwingInWindup(state), true);
    assert.equal(state.currentAngleRad, state.startAngleRad);
  });

  test('reset clears everything including a pending cooldown', () => {
    const state = createWeaponSwingState();
    startWeaponSwing(state, SWORD, 50, 0, 0, 0, false);
    resetWeaponSwingState(state);
    assert.equal(state.activeFlag, 0);
    assert.equal(state.cooldownRemainingTicks, 0);
    assert.equal(canStartWeaponSwing(state), true);
  });
});

describe('cooldown gating', () => {
  test('a second swing is refused while on cooldown', () => {
    const state = createWeaponSwingState();
    startWeaponSwing(state, SWORD, 50, 0, 0, 0, false);
    runSwingToCompletion(state, []);
    assert.equal(state.activeFlag, 0);
    assert.equal(startWeaponSwing(state, SWORD, 50, 0, 0, 0, false), false);
  });

  test('the swing becomes available again once the cooldown elapses', () => {
    const state = createWeaponSwingState();
    startWeaponSwing(state, SWORD, 50, 0, 0, 0, false);
    runSwingToCompletion(state, []);
    for (let i = 0; i < getWeaponCooldownTicks(SWORD); i++) tickWeaponCooldown(state);
    assert.equal(canStartWeaponSwing(state), true);
    assert.equal(startWeaponSwing(state, SWORD, 50, 0, 0, 0, false), true);
  });

  test('cooldown starts at the swing, not at its end', () => {
    const state = createWeaponSwingState();
    startWeaponSwing(state, SWORD, 50, 0, 0, 0, false);
    assert.equal(state.cooldownRemainingTicks, getWeaponCooldownTicks(SWORD));
  });

  test('cooldown never falls below zero', () => {
    const state = createWeaponSwingState();
    for (let i = 0; i < 10; i++) tickWeaponCooldown(state);
    assert.equal(state.cooldownRemainingTicks, 0);
  });
});

describe('hit resolution', () => {
  test('a target inside the arc is hit', () => {
    const state = createWeaponSwingState();
    startWeaponSwing(state, SWORD, 50, 0, 0, 0, false);
    const { hits, damage } = runSwingToCompletion(state, [createTarget(20, 0)]);
    assert.equal(hits, 1);
    assert.ok(damage > 0);
  });

  test('a target beyond reach is missed', () => {
    const state = createWeaponSwingState();
    startWeaponSwing(state, SWORD, 50, 0, 0, 0, false);
    const { hits } = runSwingToCompletion(state, [createTarget(500, 0)]);
    assert.equal(hits, 0);
  });

  test('a target behind the swing is missed', () => {
    const state = createWeaponSwingState();
    startWeaponSwing(state, SWORD, 50, 0, 0, 0, false);
    const { hits } = runSwingToCompletion(state, [createTarget(-20, 0)]);
    assert.equal(hits, 0);
  });

  test('a dead target is skipped', () => {
    const state = createWeaponSwingState();
    startWeaponSwing(state, SWORD, 50, 0, 0, 0, false);
    const { hits } = runSwingToCompletion(state, [createTarget(20, 0, { isAliveFlag: 0 })]);
    assert.equal(hits, 0);
  });

  test('each target is hit at most once per swing', () => {
    const state = createWeaponSwingState();
    startWeaponSwing(state, SWORD, 50, 0, 0, 0, false);
    const { hits } = runSwingToCompletion(state, [createTarget(20, 0)]);
    assert.equal(hits, 1);
  });

  test('multiple targets in the arc are all hit', () => {
    const state = createWeaponSwingState();
    startWeaponSwing(state, SWORD, 50, 0, 0, 0, false);
    const { hits } = runSwingToCompletion(state, [
      createTarget(20, 0),
      createTarget(25, 5),
      createTarget(18, -4),
    ]);
    assert.equal(hits, 3);
  });

  test('a new swing can hit a target the previous swing already hit', () => {
    const state = createWeaponSwingState();
    const targets = [createTarget(20, 0)];
    startWeaponSwing(state, SWORD, 50, 0, 0, 0, false);
    assert.equal(runSwingToCompletion(state, targets).hits, 1);
    for (let i = 0; i < getWeaponCooldownTicks(SWORD); i++) tickWeaponCooldown(state);
    startWeaponSwing(state, SWORD, 50, 0, 0, 0, false);
    assert.equal(runSwingToCompletion(state, targets).hits, 1);
  });

  test('a target larger than the gap is easier to clip', () => {
    // Placed just past the nominal reach; only its half-size brings it in.
    const justPast = (SWORD.range as number) + 3;
    const small = createWeaponSwingState();
    startWeaponSwing(small, SWORD, 50, 0, 0, 0, false);
    const smallHits = runSwingToCompletion(
      small, [createTarget(justPast, 0, { halfWidthWorld: 0.1, halfHeightWorld: 0.1 })],
    ).hits;

    const large = createWeaponSwingState();
    startWeaponSwing(large, SWORD, 50, 0, 0, 0, false);
    const largeHits = runSwingToCompletion(
      large, [createTarget(justPast, 0, { halfWidthWorld: 20, halfHeightWorld: 20 })],
    ).hits;

    assert.equal(smallHits, 0);
    assert.equal(largeHits, 1);
  });

  test('a target exactly on the wielder is hit rather than producing a bad bearing', () => {
    const state = createWeaponSwingState();
    startWeaponSwing(state, SWORD, 50, 0, 0, 0, false);
    const { hits } = runSwingToCompletion(state, [createTarget(0, 0)]);
    assert.equal(hits, 1);
  });

  test('defense mitigates swing damage', () => {
    const undefended = createWeaponSwingState();
    startWeaponSwing(undefended, SWORD, 50, 0, 0, 0, false);
    const plain = runSwingToCompletion(undefended, [createTarget(20, 0)], 0, 0, 5, 42).damage;

    const defended = createWeaponSwingState();
    startWeaponSwing(defended, SWORD, 50, 0, 0, 0, false);
    const mitigated = runSwingToCompletion(
      defended, [createTarget(20, 0, { statsDefense: 5 })], 0, 0, 5, 42,
    ).damage;

    assert.ok(mitigated < plain, `expected mitigation: ${mitigated} vs ${plain}`);
  });

  test('overwhelming defense absorbs the hit entirely', () => {
    const state = createWeaponSwingState();
    startWeaponSwing(state, SWORD, 50, 0, 0, 0, false);
    const { damage } = runSwingToCompletion(
      state, [createTarget(20, 0, { statsDefense: 10_000 })],
    );
    assert.equal(damage, 0);
  });

  test('higher attack deals more damage', () => {
    const weak = createWeaponSwingState();
    startWeaponSwing(weak, SWORD, 50, 0, 0, 0, false);
    const weakDamage = runSwingToCompletion(weak, [createTarget(20, 0)], 0, 0, 1, 7).damage;

    const strong = createWeaponSwingState();
    startWeaponSwing(strong, SWORD, 50, 0, 0, 0, false);
    const strongDamage = runSwingToCompletion(strong, [createTarget(20, 0)], 0, 0, 10, 7).damage;

    assert.ok(strongDamage > weakDamage);
  });

  test('the same seed produces identical damage', () => {
    const a = createWeaponSwingState();
    startWeaponSwing(a, SWORD, 50, 0, 0, 0, false);
    const first = runSwingToCompletion(a, [createTarget(20, 0, { statsDefense: 3 })], 0, 0, 4, 99).damage;

    const b = createWeaponSwingState();
    startWeaponSwing(b, SWORD, 50, 0, 0, 0, false);
    const second = runSwingToCompletion(b, [createTarget(20, 0, { statsDefense: 3 })], 0, 0, 4, 99).damage;

    assert.equal(first, second);
  });

  test('knockback is reported away from the wielder', () => {
    const state = createWeaponSwingState();
    startWeaponSwing(state, SWORD, 50, 0, 0, 0, false);
    const rng = createRng(3);
    let knockX = 0;
    for (let i = 0; i < 100; i++) {
      const result = tickWeaponSwing(state, SWORD, {
        originXWorld: 0,
        originYWorld: 0,
        targets: [createTarget(20, 0)],
        attackerAttack: 1,
        rng,
        onHit: (_i, _d, kx) => { knockX = kx; },
      });
      if (result.isFinished) break;
    }
    assert.ok(knockX > 0, `expected rightward knockback, got ${knockX}`);
  });

  test('targets beyond the hit registry capacity are excluded, not crashed on', () => {
    const state = createWeaponSwingState();
    startWeaponSwing(state, SWORD, 50, 0, 0, 0, false);
    const many: WeaponSwingTarget[] = [];
    for (let i = 0; i < 200; i++) many.push(createTarget(20, 0));
    const { hits } = runSwingToCompletion(state, many);
    assert.ok(hits > 0 && hits <= 64, `expected a capped hit count, got ${hits}`);
  });

  test('undefined slots in a reusable target buffer are skipped', () => {
    const state = createWeaponSwingState();
    startWeaponSwing(state, SWORD, 50, 0, 0, 0, false);
    const buffer: (WeaponSwingTarget | undefined)[] = [createTarget(20, 0), undefined, undefined];
    const rng = createRng(1);
    let hits = 0;
    for (let i = 0; i < 100; i++) {
      const result = tickWeaponSwing(state, SWORD, {
        originXWorld: 0, originYWorld: 0, targets: buffer, targetCount: 3, attackerAttack: 1, rng,
      });
      hits += result.hitCount;
      if (result.isFinished) break;
    }
    assert.equal(hits, 1);
  });
});

describe('grip anchors', () => {
  test('one-handed weapons use the leading hand', () => {
    assert.equal(resolveGripHand('oneHand', 1), GRIP_HAND_RIGHT);
    assert.equal(resolveGripHand('oneHand', -1), GRIP_HAND_LEFT);
  });

  test('two-handed weapons use both hands', () => {
    assert.equal(resolveGripHand('twoHand', 1), GRIP_HAND_BOTH);
    assert.equal(resolveGripHand('twoHand', -1), GRIP_HAND_BOTH);
  });

  test('an unspecified grip is treated as one-handed', () => {
    assert.equal(resolveGripHand(undefined, 1), GRIP_HAND_RIGHT);
  });

  test('the anchor resolves to a finite point on the body', () => {
    const body = createStickRangerBody(100, 200);
    const anchor = createWeaponGripAnchor();
    computeWeaponGripAnchor(body, SWORD, 1, anchor);
    assert.ok(Number.isFinite(anchor.xWorld) && Number.isFinite(anchor.yWorld));
    assert.ok(Number.isFinite(anchor.angleRad));
    assert.ok(Math.abs(anchor.xWorld - 100) < 100, 'anchor should be near the body');
  });

  test('a two-handed anchor sits between the two hands', () => {
    const body = createStickRangerBody(100, 200);
    const both = createWeaponGripAnchor();
    computeWeaponGripAnchor(body, GREATSWORD, 1, both);
    assert.equal(both.hand, GRIP_HAND_BOTH);

    const one = createWeaponGripAnchor();
    computeWeaponGripAnchor(body, SWORD, 1, one);
    assert.equal(one.hand, GRIP_HAND_RIGHT);
  });

  test('the swing origin is the hip', () => {
    const body = createStickRangerBody(100, 200);
    const origin = { xWorld: 0, yWorld: 0 };
    computeSwingOrigin(body, 1, origin);
    assert.ok(Math.abs(origin.xWorld - 100) < 1e-3);
    assert.ok(Math.abs(origin.yWorld - 200) < 1e-3);
  });

  test('computing an anchor allocates nothing into the body', () => {
    const body = createStickRangerBody(0, 0);
    const before = JSON.stringify(Array.from(body.x));
    const anchor = createWeaponGripAnchor();
    computeWeaponGripAnchor(body, SWORD, 1, anchor);
    assert.equal(JSON.stringify(Array.from(body.x)), before);
  });
});
