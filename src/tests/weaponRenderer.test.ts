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
import { createWorldState, type WorldState } from '../sim/world';
import { createClusterState, type ClusterState } from '../sim/clusters/state';
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
    beginPath: record('beginPath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
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
    equipPlayerWeapon(world.playerWeapon, 'sword');
    tryStartPlayerWeaponAttack(world, player, 50, 0, world.rng);
    for (let i = 0; i < 5; i++) tickPlayerWeapon(world, player, world.rng);
    const swinging = createRecordingContext();
    new WeaponRenderer().render(swinging.ctx, createSnapshot(world.playerWeapon), 0, 0, 1);

    assert.ok(
      countOps(swinging.calls, 'stroke') > countOps(rest.calls, 'stroke'),
      'a swing should add trail strokes',
    );
  });

  test('a bow is not drawn as a blade', () => {
    const weapon = createPlayerWeaponState();
    equipPlayerWeapon(weapon, 'bow');
    const { ctx, calls } = createRecordingContext();
    new WeaponRenderer().render(ctx, createSnapshot(weapon), 0, 0, 1);
    // No pose is ported for ranged weapons; drawing a sword line would read
    // as a bug, so nothing is drawn until one exists.
    assert.equal(countOps(calls, 'stroke'), 0);
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
    const { ctx, calls } = createRecordingContext();
    new WeaponRenderer().render(ctx, createSnapshot(weapon), 0, 0, 1);
    assert.equal(countOps(calls, 'stroke'), 0);
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
    equipPlayerWeapon(weapon, 'apiaryLexicon');
    const { ctx, calls } = createRecordingContext();
    new WeaponRenderer().render(ctx, createSnapshot(weapon), 0, 0, 1);
    assert.equal(countOps(calls, 'arc'), 0);
  });
});
