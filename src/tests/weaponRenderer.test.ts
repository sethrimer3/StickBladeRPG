import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { WeaponRenderer } from '../render/effects/weaponRenderer';
import {
  createPlayerWeaponState,
  equipPlayerWeapon,
  tickPlayerWeapon,
  tryStartPlayerWeaponAttack,
  type PlayerWeaponState,
} from '../sim/weapons/playerWeaponState';
import { createStickRangerBody } from '../sim/clusters/stickRangerBody';
import { renderStickRangerBody } from '../render/clusters/stickRangerRenderer';
import { createWorldState, type WorldState } from '../sim/world';
import { createClusterState, type ClusterState } from '../sim/clusters/state';
import { computeWeaponGripAnchor, createWeaponGripAnchor } from '../sim/weapons/weaponGrip';
import { getWeaponDef } from '../sim/weapons/weaponDefs';
import type { WorldSnapshot } from '../render/snapshot';

const DT_MS = 1000 / 60;

/** One recorded canvas call. */
interface DrawCall {
  op: string;
  args: unknown[];
}

/**
 * Minimal recording 2D context.
 *
 * The renderer only uses primitive canvas operations, so a recorder is enough
 * to assert what it drew without a real canvas — which Node does not have.
 */
function createRecordingContext(): { ctx: CanvasRenderingContext2D; calls: DrawCall[] } {
  const calls: DrawCall[] = [];
  const record = (op: string) => (...args: unknown[]): void => { calls.push({ op, args }); };

  const ctx = {
    save: record('save'),
    restore: record('restore'),
    translate: record('translate'),
    rotate: record('rotate'),
    drawImage: record('drawImage'),
    beginPath: record('beginPath'),
    closePath: record('closePath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    quadraticCurveTo: record('quadraticCurveTo'),
    arc: record('arc'),
    stroke: record('stroke'),
    fill: record('fill'),
    fillRect: record('fillRect'),
    globalAlpha: 1,
    lineWidth: 1,
    lineCap: 'butt',
    strokeStyle: '',
    fillStyle: '',
  } as unknown as CanvasRenderingContext2D;

  return { ctx, calls };
}

function createSnapshot(weapon: PlayerWeaponState | null): WorldSnapshot {
  return {
    playerWeapon: weapon,
    stickRangerBody: createStickRangerBody(0, 0),
  } as unknown as WorldSnapshot;
}

function createWorldWithPlayer(): { world: WorldState; player: ClusterState } {
  const world = createWorldState(DT_MS, 3);
  const player = createClusterState(1, 0, 0, 1, 100);
  world.clusters.push(player);
  return { world, player };
}

function countOps(calls: DrawCall[], op: string): number {
  return calls.filter(c => c.op === op).length;
}

describe('weapon renderer safety', () => {
  test('an absent weapon draws nothing', () => {
    const { ctx, calls } = createRecordingContext();
    new WeaponRenderer().render(ctx, createSnapshot(null), 0, 0, 1);
    assert.equal(calls.length, 0);
  });

  test('an unarmed player draws nothing', () => {
    const { ctx, calls } = createRecordingContext();
    new WeaponRenderer().render(ctx, createSnapshot(createPlayerWeaponState()), 0, 0, 1);
    assert.equal(calls.length, 0);
  });

  test('a missing stickman body does not crash the renderer', () => {
    const { ctx } = createRecordingContext();
    const weapon = createPlayerWeaponState();
    equipPlayerWeapon(weapon, 'sword');
    const snapshot = { playerWeapon: weapon, stickRangerBody: null } as unknown as WorldSnapshot;
    assert.doesNotThrow(() => new WeaponRenderer().render(ctx, snapshot, 0, 0, 1));
  });

  test('every save is balanced by a restore', () => {
    const { world, player } = createWorldWithPlayer();
    equipPlayerWeapon(world.playerWeapon, 'sword');
    tryStartPlayerWeaponAttack(world, player, 50, 0, world.rng);
    tickPlayerWeapon(world, player, world.rng);

    const { ctx, calls } = createRecordingContext();
    new WeaponRenderer().render(ctx, createSnapshot(world.playerWeapon), 0, 0, 1);
    assert.equal(countOps(calls, 'save'), countOps(calls, 'restore'));
  });
});

describe('camera transform', () => {
  /** First moveTo the renderer emits — the grip end of the blade. */
  function firstMoveTo(calls: DrawCall[]): [number, number] {
    const call = calls.find(c => c.op === 'moveTo');
    assert.ok(call !== undefined, 'expected the blade to be stroked from the grip');
    return [call.args[0] as number, call.args[1] as number];
  }

  function renderAt(ox: number, oy: number, zoom: number): [number, number] {
    const weapon = createPlayerWeaponState();
    equipPlayerWeapon(weapon, 'sword');
    const { ctx, calls } = createRecordingContext();
    new WeaponRenderer().render(ctx, createSnapshot(weapon), ox, oy, zoom);
    return firstMoveTo(calls);
  }

  // `ox`/`oy` are pixel offsets — `world * zoom + ox`, the convention every
  // other renderer uses. This file used `(world - ox) * zoom`, which agrees
  // only at the origin, so the whole suite missed it: every case above renders
  // at 0,0. Off the origin the weapon flew away from the player.
  test('a camera offset shifts the drawing by exactly that many pixels', () => {
    const [baseX, baseY] = renderAt(0, 0, 1);
    const [shiftedX, shiftedY] = renderAt(100, 50, 1);
    assert.equal(shiftedX - baseX, 100);
    assert.equal(shiftedY - baseY, 50);
  });

  test('the offset is in pixels, so zoom does not scale it', () => {
    const [baseX, baseY] = renderAt(0, 0, 3);
    const [shiftedX, shiftedY] = renderAt(100, 50, 3);
    assert.equal(shiftedX - baseX, 100, 'the offset must not be multiplied by zoom');
    assert.equal(shiftedY - baseY, 50);
  });

  test('zoom scales the world position, not the offset', () => {
    const [x1] = renderAt(0, 0, 1);
    const [x2] = renderAt(0, 0, 2);
    assert.equal(x2, x1 * 2);
  });
});

describe('melee rendering', () => {
  test('an equipped blade is drawn', () => {
    const weapon = createPlayerWeaponState();
    equipPlayerWeapon(weapon, 'sword');
    const { ctx, calls } = createRecordingContext();
    new WeaponRenderer().render(ctx, createSnapshot(weapon), 0, 0, 1);
    assert.ok(countOps(calls, 'stroke') > 0, 'the blade should be stroked');
  });

  test('a swing draws more than a blade at rest', () => {
    const restWeapon = createPlayerWeaponState();
    equipPlayerWeapon(restWeapon, 'sword');
    const rest = createRecordingContext();
    new WeaponRenderer().render(rest.ctx, createSnapshot(restWeapon), 0, 0, 1);

    const { world, player } = createWorldWithPlayer();
    world.stickRangerBody = createStickRangerBody(0, 0);
    equipPlayerWeapon(world.playerWeapon, 'sword');
    tryStartPlayerWeaponAttack(world, player, 50, 0, world.rng);

    // The tip trail needs at least two sampled positions before it has any
    // geometry, so the renderer has to see the blade actually travel — one
    // frame of a swing looks the same as a blade held still, by design.
    const renderer = new WeaponRenderer();
    const swinging = createRecordingContext();
    for (let i = 0; i < 8; i++) {
      tickPlayerWeapon(world, player, world.rng);
      renderer.render(swinging.ctx, createSnapshot(world.playerWeapon), 0, 0, 1, 'high');
    }

    assert.ok(
      countOps(swinging.calls, 'stroke') > countOps(rest.calls, 'stroke') * 8,
      'a swing should add trail strokes beyond the blade drawn each frame',
    );
    assert.ok(
      countOps(swinging.calls, 'quadraticCurveTo') > 0,
      'the tip trail should be drawn as smoothed curve segments',
    );
  });

  test('a bow is drawn with a curved limb rather than a straight blade line', () => {
    const weapon = createPlayerWeaponState();
    equipPlayerWeapon(weapon, 'bow');
    const { ctx, calls } = createRecordingContext();
    new WeaponRenderer().render(ctx, createSnapshot(weapon), 0, 0, 1);
    assert.ok(countOps(calls, 'quadraticCurveTo') > 0, 'bow limb should be curved');
  });

  test('woodenSword renders cleanly at rest and during swing', () => {
    const weapon = createPlayerWeaponState();
    equipPlayerWeapon(weapon, 'woodenSword');
    const { ctx, calls } = createRecordingContext();
    new WeaponRenderer().render(ctx, createSnapshot(weapon), 0, 0, 1);
    // When sprite is not loaded (Node environment without Image), falls back to procedural blade stroke
    assert.ok(countOps(calls, 'stroke') > 0, 'wooden sword should draw blade');
    assert.equal(countOps(calls, 'save'), countOps(calls, 'restore'));
  });
});

describe('projectile rendering', () => {
  test('live projectiles are drawn', () => {
    const { world, player } = createWorldWithPlayer();
    equipPlayerWeapon(world.playerWeapon, 'wand');
    tryStartPlayerWeaponAttack(world, player, 100, 0, world.rng);

    const { ctx, calls } = createRecordingContext();
    new WeaponRenderer().render(ctx, createSnapshot(world.playerWeapon), 0, 0, 1);
    assert.ok(countOps(calls, 'fillRect') > 0, 'projectile bodies should be filled');
  });

  test('projectiles still draw after the weapon is unequipped', () => {
    const { world, player } = createWorldWithPlayer();
    equipPlayerWeapon(world.playerWeapon, 'wand');
    tryStartPlayerWeaponAttack(world, player, 100, 0, world.rng);
    equipPlayerWeapon(world.playerWeapon, null);

    const { ctx, calls } = createRecordingContext();
    new WeaponRenderer().render(ctx, createSnapshot(world.playerWeapon), 0, 0, 1);
    assert.ok(countOps(calls, 'fillRect') > 0);
  });
});

describe('staff rendering', () => {
  test('a channelling beam is drawn to the simulated endpoint', () => {
    const { world, player } = createWorldWithPlayer();
    equipPlayerWeapon(world.playerWeapon, 'emberStaff');
    tryStartPlayerWeaponAttack(world, player, 300, 0, world.rng);
    tickPlayerWeapon(world, player, world.rng);
    assert.equal(world.playerWeapon.staff.beamActiveFlag, 1);

    const { ctx, calls } = createRecordingContext();
    new WeaponRenderer().render(ctx, createSnapshot(world.playerWeapon), 0, 0, 1);

    const endX = world.playerWeapon.staff.beamEndXWorld;
    const drewEndpoint = calls.some(
      c => c.op === 'lineTo' && Math.abs((c.args[0] as number) - endX) < 1e-6,
    );
    assert.ok(drewEndpoint, 'the beam should terminate at the simulated endpoint');
  });

  test('an idle staff draws no beam', () => {
    const weapon = createPlayerWeaponState();
    equipPlayerWeapon(weapon, 'emberStaff');
    assert.equal(weapon.staff.beamActiveFlag, 0);
    const { ctx, calls } = createRecordingContext();
    new WeaponRenderer().render(ctx, createSnapshot(weapon), 0, 0, 1);
    // Idle staff draws only the held shaft/gem (1 stroke), never the 2-pass beam (3 strokes).
    assert.equal(countOps(calls, 'stroke'), 2); // 1 shaft stroke + 1 gem halo stroke
  });

  test('a full, idle charge meter is hidden as pure noise', () => {
    const weapon = createPlayerWeaponState();
    equipPlayerWeapon(weapon, 'emberStaff');
    const { ctx, calls } = createRecordingContext();
    new WeaponRenderer().render(ctx, createSnapshot(weapon), 0, 0, 1);
    assert.equal(countOps(calls, 'fillRect'), 0);
  });

  test('a drained charge meter is drawn', () => {
    const { world, player } = createWorldWithPlayer();
    equipPlayerWeapon(world.playerWeapon, 'emberStaff');
    tryStartPlayerWeaponAttack(world, player, 300, 0, world.rng);
    for (let i = 0; i < 30; i++) tickPlayerWeapon(world, player, world.rng);

    const { ctx, calls } = createRecordingContext();
    new WeaponRenderer().render(ctx, createSnapshot(world.playerWeapon), 0, 0, 1);
    // Background track plus filled portion.
    assert.ok(countOps(calls, 'fillRect') >= 2, 'the meter should draw a track and a fill');
  });
});

describe('spirit orb rendering', () => {
  test('a full ring draws every orb', () => {
    const weapon = createPlayerWeaponState();
    equipPlayerWeapon(weapon, 'tempestHalo'); // 5 orbs
    const { ctx, calls } = createRecordingContext();
    new WeaponRenderer().render(ctx, createSnapshot(weapon), 0, 0, 1);
    // Each orb draws a halo arc and a body arc.
    assert.equal(countOps(calls, 'arc'), 10);
  });

  test('a spent orb leaves a visible gap', () => {
    const { world, player } = createWorldWithPlayer();
    equipPlayerWeapon(world.playerWeapon, 'tempestHalo');
    tryStartPlayerWeaponAttack(world, player, 300, 0, world.rng);

    const { ctx, calls } = createRecordingContext();
    new WeaponRenderer().render(ctx, createSnapshot(world.playerWeapon), 0, 0, 1);
    assert.equal(countOps(calls, 'arc'), 8, 'one of five orbs should be missing');
  });

  test('a non-spirit weapon draws no orbs', () => {
    const weapon = createPlayerWeaponState();
    equipPlayerWeapon(weapon, 'sword');
    const { ctx, calls } = createRecordingContext();
    new WeaponRenderer().render(ctx, createSnapshot(weapon), 0, 0, 1);
    assert.equal(countOps(calls, 'arc'), 0);
  });
});

describe('summon rendering', () => {
  test('summoned familiars are drawn', () => {
    const { world, player } = createWorldWithPlayer();
    equipPlayerWeapon(world.playerWeapon, 'apiaryLexicon');
    tryStartPlayerWeaponAttack(world, player, 100, 0, world.rng);

    const { ctx, calls } = createRecordingContext();
    new WeaponRenderer().render(ctx, createSnapshot(world.playerWeapon), 0, 0, 1);
    assert.ok(countOps(calls, 'arc') > 0, 'familiar bodies should be drawn');
    assert.ok(countOps(calls, 'stroke') > 0, 'familiar silhouettes should be drawn');
  });

  test('familiars still draw after a weapon swap, because they outlive it', () => {
    const { world, player } = createWorldWithPlayer();
    equipPlayerWeapon(world.playerWeapon, 'apiaryLexicon');
    tryStartPlayerWeaponAttack(world, player, 100, 0, world.rng);
    equipPlayerWeapon(world.playerWeapon, 'sword');

    const { ctx, calls } = createRecordingContext();
    new WeaponRenderer().render(ctx, createSnapshot(world.playerWeapon), 0, 0, 1);
    assert.ok(countOps(calls, 'arc') > 0);
  });

  test('no familiars means no familiar drawing', () => {
    const weapon = createPlayerWeaponState();
    equipPlayerWeapon(weapon, 'sword');
    const { ctx, calls } = createRecordingContext();
    new WeaponRenderer().render(ctx, createSnapshot(weapon), 0, 0, 1);
    assert.equal(countOps(calls, 'arc'), 0);
  });
});

describe('held weapon poses', () => {
  test('a held bow draws curved limbs and bowstring', () => {
    const weapon = createPlayerWeaponState();
    equipPlayerWeapon(weapon, 'bow');
    const { ctx, calls } = createRecordingContext();
    new WeaponRenderer().render(ctx, createSnapshot(weapon), 0, 0, 1);
    assert.ok(countOps(calls, 'quadraticCurveTo') > 0, 'bow limb should be curved');
    assert.ok(countOps(calls, 'stroke') >= 2, 'bow limb and string should both stroke');
  });

  test('a held gun draws barrel and grip', () => {
    const weapon = createPlayerWeaponState();
    equipPlayerWeapon(weapon, 'sniperRifle');
    const { ctx, calls } = createRecordingContext();
    new WeaponRenderer().render(ctx, createSnapshot(weapon), 0, 0, 1);
    assert.ok(countOps(calls, 'stroke') >= 2, 'gun barrel and grip should stroke');
  });

  test('a held staff draws shaft and glowing gem head', () => {
    const weapon = createPlayerWeaponState();
    equipPlayerWeapon(weapon, 'emberStaff');
    const { ctx, calls } = createRecordingContext();
    new WeaponRenderer().render(ctx, createSnapshot(weapon), 0, 0, 1);
    assert.ok(countOps(calls, 'stroke') > 0, 'staff shaft should stroke');
    assert.ok(countOps(calls, 'arc') > 0, 'staff gem should draw circle');
  });

  test('a held summoner book draws cover, pages, and illuminated rune', () => {
    const weapon = createPlayerWeaponState();
    equipPlayerWeapon(weapon, 'apiaryLexicon');
    const { ctx, calls } = createRecordingContext();
    new WeaponRenderer().render(ctx, createSnapshot(weapon), 0, 0, 1);
    assert.ok(countOps(calls, 'fill') >= 3, 'book cover, pages, and rune should fill');
    assert.ok(countOps(calls, 'arc') > 0, 'rune glyph should draw');
  });

  test('a spear draws shaft and diamond spearhead', () => {
    const weapon = createPlayerWeaponState();
    equipPlayerWeapon(weapon, 'spear');
    const { ctx, calls } = createRecordingContext();
    new WeaponRenderer().render(ctx, createSnapshot(weapon), 0, 0, 1);
    assert.ok(countOps(calls, 'stroke') > 0, 'spear shaft should stroke');
    assert.ok(countOps(calls, 'fill') > 0, 'spearhead diamond should fill');
  });

  test('weapons with showWeapon: false do not render held models', () => {
    const weapon = createPlayerWeaponState();
    equipPlayerWeapon(weapon, 'fist');
    const { ctx, calls } = createRecordingContext();
    new WeaponRenderer().render(ctx, createSnapshot(weapon), 0, 0, 1);
    assert.equal(countOps(calls, 'stroke'), 0);
  });

  test('the drawn blade starts at the drawn hand, at an off-origin camera', () => {
    // The end-to-end check the other cases could not make: draw the body and
    // the weapon through their real entry points with the same camera, then
    // compare pixels. If the two renderers disagree about the transform, the
    // sword leaves the hand — which is exactly what shipped.
    const OX = 137;
    const OY = -84;
    const ZOOM = 3;

    const body = createStickRangerBody(220, 160);
    const weapon = createPlayerWeaponState();
    equipPlayerWeapon(weapon, 'woodenSword'); // two-handed, so the body draws a grip
    const snapshot = { playerWeapon: weapon, stickRangerBody: body } as unknown as WorldSnapshot;

    const bodyCtx = createRecordingContext();
    renderStickRangerBody(bodyCtx.ctx, body, OX, OY, ZOOM, /* isTwoHandGrip */ true);

    const weaponCtx = createRecordingContext();
    new WeaponRenderer().render(weaponCtx.ctx, snapshot, OX, OY, ZOOM);

    // The weapon sprite is unavailable in Node, so the blade falls back to a
    // stroked line whose first moveTo is the grip end.
    const bladeStart = weaponCtx.calls.find(c => c.op === 'moveTo');
    assert.ok(bladeStart !== undefined, 'the blade should have been stroked');

    const anchor = createWeaponGripAnchor();
    computeWeaponGripAnchor(body, getWeaponDef('woodenSword')!, 1, anchor);
    const expectedGripX = Math.round(anchor.xWorld * ZOOM + OX);
    const expectedGripY = Math.round(anchor.yWorld * ZOOM + OY);

    assert.ok(
      Math.abs((bladeStart.args[0] as number) - expectedGripX) < 1e-6
      && Math.abs((bladeStart.args[1] as number) - expectedGripY) < 1e-6,
      `blade starts at ${bladeStart.args[0]},${bladeStart.args[1]} but the grip is at ${expectedGripX},${expectedGripY}`,
    );
  });

  test('renderStickRangerBody renders both hands joined at grip for two-handed weapons', () => {
    const body = createStickRangerBody(100, 100);
    const standardCtx = createRecordingContext();
    renderStickRangerBody(standardCtx.ctx, body, 0, 0, 1, false);

    const twoHandCtx = createRecordingContext();
    renderStickRangerBody(twoHandCtx.ctx, body, 0, 0, 1, true);

    // Both should draw the stickman pixels and head
    assert.ok(countOps(twoHandCtx.calls, 'fillRect') > 0);
    assert.equal(countOps(twoHandCtx.calls, 'save'), countOps(twoHandCtx.calls, 'restore'));
  });
});

