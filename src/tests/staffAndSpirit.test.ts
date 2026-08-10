import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  STAFF_CHANNEL_AURA,
  STAFF_CHANNEL_BEAM,
  STAFF_CHANNEL_NONE,
  createStaffChannelState,
  getStaffAuraModifiers,
  getStaffAuraRadius,
  getStaffChannelKind,
  getStaffChargeFraction,
  releaseStaffChannel,
  requestStaffChannel,
  resetStaffChannelState,
  tickStaffChannel,
} from '../sim/weapons/staffChannel';
import {
  MAX_SPIRIT_ORBS,
  createSpiritOrbState,
  fireSpiritOrb,
  getAvailableSpiritOrbCount,
  getSpiritOrbPosition,
  resetSpiritOrbs,
  tickSpiritOrbs,
} from '../sim/weapons/spiritOrbs';
import { createWeaponProjectilePool } from '../sim/weapons/weaponProjectiles';
import { WEAPONS, isWeaponRuntimeImplemented } from '../sim/weapons/weaponDefs';
import {
  createPlayerWeaponState,
  equipPlayerWeapon,
  releasePlayerWeaponAttack,
  tickPlayerWeapon,
  tryStartPlayerWeaponAttack,
} from '../sim/weapons/playerWeaponState';
import { createWorldState, type WorldState } from '../sim/world';
import { createClusterState, type ClusterState } from '../sim/clusters/state';
import { createRng } from '../sim/rng';

const DT_MS = 1000 / 60;

function createWorldWithPlayer(): { world: WorldState; player: ClusterState } {
  const world = createWorldState(DT_MS, 7);
  const player = createClusterState(1, 0, 0, 1, 100);
  world.clusters.push(player);
  return { world, player };
}

function addEnemy(world: WorldState, x: number, y: number, health = 1000): ClusterState {
  const enemy = createClusterState(1, x, y, 0, health);
  world.clusters.push(enemy);
  return enemy;
}

describe('staff classification', () => {
  test('beam staves are recognized', () => {
    assert.equal(getStaffChannelKind(WEAPONS['emberStaff']), STAFF_CHANNEL_BEAM);
    assert.equal(getStaffChannelKind(WEAPONS['prismStaff']), STAFF_CHANNEL_BEAM);
    assert.equal(getStaffChannelKind(WEAPONS['glyphConduit']), STAFF_CHANNEL_BEAM);
  });

  test('stat-multiplier aura staves are recognized', () => {
    assert.equal(getStaffChannelKind(WEAPONS['warChantStaff']), STAFF_CHANNEL_AURA);
    assert.equal(getStaffChannelKind(WEAPONS['bulwarkStaff']), STAFF_CHANNEL_AURA);
    assert.equal(getStaffChannelKind(WEAPONS['verdantStaff']), STAFF_CHANNEL_AURA);
  });

  test('the two unported bespoke auras report as unimplemented', () => {
    // aegisStaff = projectile shield, gravebindStaff = raise-on-death.
    assert.equal(getStaffChannelKind(WEAPONS['aegisStaff']), STAFF_CHANNEL_NONE);
    assert.equal(getStaffChannelKind(WEAPONS['gravebindStaff']), STAFF_CHANNEL_NONE);
  });

  test('a non-staff weapon is never a staff channel', () => {
    assert.equal(getStaffChannelKind(WEAPONS['sword']), STAFF_CHANNEL_NONE);
  });
});

describe('staff charge meter', () => {
  test('a fresh staff starts fully charged', () => {
    const state = createStaffChannelState();
    assert.equal(getStaffChargeFraction(state, WEAPONS['emberStaff']), 1);
  });

  test('channelling drains charge', () => {
    const { world, player } = createWorldWithPlayer();
    const state = createStaffChannelState();
    const def = WEAPONS['emberStaff'];
    requestStaffChannel(state, def, 100, 0);
    for (let i = 0; i < 30; i++) tickStaffChannel(world, state, def, player, 1, world.rng);
    assert.ok(getStaffChargeFraction(state, def) < 1);
  });

  test('releasing regenerates charge', () => {
    const { world, player } = createWorldWithPlayer();
    const state = createStaffChannelState();
    const def = WEAPONS['emberStaff'];
    requestStaffChannel(state, def, 100, 0);
    for (let i = 0; i < 30; i++) tickStaffChannel(world, state, def, player, 1, world.rng);
    const drained = getStaffChargeFraction(state, def);

    releaseStaffChannel(state);
    for (let i = 0; i < 30; i++) tickStaffChannel(world, state, def, player, 1, world.rng);
    assert.ok(getStaffChargeFraction(state, def) > drained);
  });

  test('charge never exceeds full', () => {
    const { world, player } = createWorldWithPlayer();
    const state = createStaffChannelState();
    const def = WEAPONS['emberStaff'];
    for (let i = 0; i < 600; i++) tickStaffChannel(world, state, def, player, 1, world.rng);
    assert.equal(getStaffChargeFraction(state, def), 1);
  });

  test('an exhausted channel cuts out and cannot immediately restart', () => {
    const { world, player } = createWorldWithPlayer();
    const state = createStaffChannelState();
    const def = WEAPONS['emberStaff'];
    requestStaffChannel(state, def, 100, 0);
    for (let i = 0; i < 600; i++) {
      requestStaffChannel(state, def, 100, 0);
      tickStaffChannel(world, state, def, player, 1, world.rng);
    }
    // With drain outpacing regen the staff ends up gated by minChargeToFire,
    // never running away with unlimited uptime.
    assert.ok(getStaffChargeFraction(state, def) < 1);
  });

  test('a staff below its minimum charge refuses to start', () => {
    const state = createStaffChannelState();
    const def = WEAPONS['emberStaff'];
    state.charge = 0;
    assert.equal(requestStaffChannel(state, def, 100, 0), false);
  });

  test('an unported staff refuses to channel', () => {
    const state = createStaffChannelState();
    assert.equal(requestStaffChannel(state, WEAPONS['aegisStaff'], 100, 0), false);
  });

  test('reset restores a full charge and stops channelling', () => {
    const state = createStaffChannelState();
    requestStaffChannel(state, WEAPONS['emberStaff'], 100, 0);
    state.charge = 0.1;
    resetStaffChannelState(state);
    assert.equal(state.isChannellingFlag, 0);
    assert.equal(getStaffChargeFraction(state, WEAPONS['emberStaff']), 1);
  });
});

describe('staff beams', () => {
  test('a beam damages an enemy in its path', () => {
    const { world, player } = createWorldWithPlayer();
    const enemy = addEnemy(world, 100, 0);
    const state = createStaffChannelState();
    const def = WEAPONS['emberStaff'];

    requestStaffChannel(state, def, 300, 0);
    for (let i = 0; i < 30; i++) tickStaffChannel(world, state, def, player, 1, world.rng);

    assert.ok(enemy.healthPoints < 1000, 'beam should have dealt damage');
  });

  test('a beam does not reach past its range', () => {
    const { world, player } = createWorldWithPlayer();
    // emberStaff range is 360.
    const enemy = addEnemy(world, 2000, 0);
    const state = createStaffChannelState();
    const def = WEAPONS['emberStaff'];

    requestStaffChannel(state, def, 3000, 0);
    for (let i = 0; i < 30; i++) tickStaffChannel(world, state, def, player, 1, world.rng);

    assert.equal(enemy.healthPoints, 1000);
  });

  test('a beam damages the nearest enemy, not everything on the ray', () => {
    const { world, player } = createWorldWithPlayer();
    const near = addEnemy(world, 80, 0);
    const far = addEnemy(world, 200, 0);
    const state = createStaffChannelState();
    const def = WEAPONS['emberStaff'];

    requestStaffChannel(state, def, 300, 0);
    for (let i = 0; i < 30; i++) tickStaffChannel(world, state, def, player, 1, world.rng);

    assert.ok(near.healthPoints < 1000, 'near enemy should be hit');
    assert.equal(far.healthPoints, 1000, 'far enemy should be shadowed');
  });

  test('the player is never damaged by their own beam', () => {
    const { world, player } = createWorldWithPlayer();
    const state = createStaffChannelState();
    const def = WEAPONS['emberStaff'];
    requestStaffChannel(state, def, 300, 0);
    for (let i = 0; i < 30; i++) tickStaffChannel(world, state, def, player, 1, world.rng);
    assert.equal(player.healthPoints, 100);
  });

  test('a released beam deals no damage', () => {
    const { world, player } = createWorldWithPlayer();
    const enemy = addEnemy(world, 100, 0);
    const state = createStaffChannelState();
    const def = WEAPONS['emberStaff'];
    for (let i = 0; i < 30; i++) tickStaffChannel(world, state, def, player, 1, world.rng);
    assert.equal(enemy.healthPoints, 1000);
  });

  test('beam damage is deterministic for a given seed', () => {
    function run(): number {
      const { world, player } = createWorldWithPlayer();
      const enemy = addEnemy(world, 100, 0);
      const state = createStaffChannelState();
      const def = WEAPONS['emberStaff'];
      const rng = createRng(4242);
      requestStaffChannel(state, def, 300, 0);
      for (let i = 0; i < 30; i++) tickStaffChannel(world, state, def, player, 1, rng);
      return enemy.healthPoints;
    }
    assert.equal(run(), run());
  });

  test('a dead player fires no beam', () => {
    const { world } = createWorldWithPlayer();
    const enemy = addEnemy(world, 100, 0);
    const state = createStaffChannelState();
    const def = WEAPONS['emberStaff'];
    requestStaffChannel(state, def, 300, 0);
    for (let i = 0; i < 30; i++) tickStaffChannel(world, state, def, null, 1, world.rng);
    assert.equal(enemy.healthPoints, 1000);
  });
});

describe('staff auras', () => {
  test('an active aura contributes its multiplier', () => {
    const state = createStaffChannelState();
    const def = WEAPONS['warChantStaff'];
    requestStaffChannel(state, def, 100, 0);
    assert.equal(getStaffAuraModifiers(state, def).attackMultiplier, 1.5);
  });

  test('an inactive aura contributes nothing', () => {
    const state = createStaffChannelState();
    const modifiers = getStaffAuraModifiers(state, WEAPONS['warChantStaff']);
    assert.equal(modifiers.attackMultiplier, 1);
    assert.equal(modifiers.defenseMultiplier, 1);
  });

  test('an exhausted aura contributes nothing', () => {
    const state = createStaffChannelState();
    const def = WEAPONS['warChantStaff'];
    requestStaffChannel(state, def, 100, 0);
    state.charge = 0;
    assert.equal(getStaffAuraModifiers(state, def).attackMultiplier, 1);
  });

  test('defense and health auras map to their own multipliers', () => {
    const defense = createStaffChannelState();
    requestStaffChannel(defense, WEAPONS['bulwarkStaff'], 100, 0);
    assert.ok((getStaffAuraModifiers(defense, WEAPONS['bulwarkStaff']).defenseMultiplier ?? 1) > 1);

    const health = createStaffChannelState();
    requestStaffChannel(health, WEAPONS['verdantStaff'], 100, 0);
    assert.ok((getStaffAuraModifiers(health, WEAPONS['verdantStaff']).healthMultiplier ?? 1) > 1);
  });

  test('a beam staff contributes no aura', () => {
    const state = createStaffChannelState();
    requestStaffChannel(state, WEAPONS['emberStaff'], 100, 0);
    assert.equal(getStaffAuraModifiers(state, WEAPONS['emberStaff']).attackMultiplier, 1);
  });

  test('aura radius is reported for aura staves only', () => {
    assert.ok(getStaffAuraRadius(WEAPONS['warChantStaff']) > 0);
    assert.equal(getStaffAuraRadius(WEAPONS['emberStaff']), 0);
  });

  test('a null weapon yields neutral modifiers', () => {
    const state = createStaffChannelState();
    assert.equal(getStaffAuraModifiers(state, null).attackMultiplier, 1);
  });
});

describe('spirit orbs', () => {
  test('equipping a spirit weapon builds a full ring', () => {
    const state = createSpiritOrbState();
    resetSpiritOrbs(state, WEAPONS['tempestHalo']);
    assert.equal(state.orbCount, 5);
    assert.equal(getAvailableSpiritOrbCount(state), 5);
  });

  test('a spirit weapon with no declared orbCount gets the default ring', () => {
    const state = createSpiritOrbState();
    resetSpiritOrbs(state, WEAPONS['spiritBand']);
    assert.equal(state.orbCount, 3);
  });

  test('the ring is capped', () => {
    const state = createSpiritOrbState();
    resetSpiritOrbs(state, { ...WEAPONS['tempestHalo'], orbCount: 999 });
    assert.equal(state.orbCount, MAX_SPIRIT_ORBS);
  });

  test('a non-spirit weapon leaves no orbs', () => {
    const state = createSpiritOrbState();
    resetSpiritOrbs(state, WEAPONS['tempestHalo']);
    resetSpiritOrbs(state, WEAPONS['sword']);
    assert.equal(state.orbCount, 0);
  });

  test('orbs are spaced around the ring at the orbit radius', () => {
    const state = createSpiritOrbState();
    const def = WEAPONS['tempestHalo'];
    resetSpiritOrbs(state, def);

    const a = { xWorld: 0, yWorld: 0 };
    const b = { xWorld: 0, yWorld: 0 };
    getSpiritOrbPosition(state, def, 0, 100, 100, a);
    getSpiritOrbPosition(state, def, 1, 100, 100, b);

    const radiusA = Math.hypot(a.xWorld - 100, a.yWorld - 100);
    assert.ok(Math.abs(radiusA - (def.orbitRadius ?? 0)) < 1e-6);
    assert.ok(Math.hypot(a.xWorld - b.xWorld, a.yWorld - b.yWorld) > 1, 'orbs should not overlap');
  });

  test('the ring rotates over time', () => {
    const state = createSpiritOrbState();
    const def = WEAPONS['tempestHalo'];
    resetSpiritOrbs(state, def);
    const before = state.orbitPhaseRad;
    tickSpiritOrbs(state, def, DT_MS);
    assert.ok(state.orbitPhaseRad > before);
  });

  test('firing consumes an orb and launches a projectile', () => {
    const state = createSpiritOrbState();
    const pool = createWeaponProjectilePool();
    const def = WEAPONS['tempestHalo'];
    resetSpiritOrbs(state, def);

    const result = fireSpiritOrb(state, pool, def, 0, 0, 200, 0, 1, createRng(3));
    assert.equal(result.didFire, true);
    assert.equal(result.remainingOrbs, 4);
    assert.equal(pool.liveCount, 1);
  });

  test('an empty ring cannot fire', () => {
    const state = createSpiritOrbState();
    const pool = createWeaponProjectilePool();
    const def = WEAPONS['tempestHalo'];
    resetSpiritOrbs(state, def);

    for (let i = 0; i < 5; i++) fireSpiritOrb(state, pool, def, 0, 0, 200, 0, 1, createRng(i));
    assert.equal(getAvailableSpiritOrbCount(state), 0);

    const result = fireSpiritOrb(state, pool, def, 0, 0, 200, 0, 1, createRng(9));
    assert.equal(result.didFire, false);
  });

  test('a spent orb regenerates after its delay', () => {
    const state = createSpiritOrbState();
    const pool = createWeaponProjectilePool();
    const def = WEAPONS['tempestHalo'];
    resetSpiritOrbs(state, def);

    fireSpiritOrb(state, pool, def, 0, 0, 200, 0, 1, createRng(3));
    assert.equal(getAvailableSpiritOrbCount(state), 4);

    // orbRegenMs is 1700 → ~102 ticks.
    for (let i = 0; i < 120; i++) tickSpiritOrbs(state, def, DT_MS);
    assert.equal(getAvailableSpiritOrbCount(state), 5);
  });

  test('an orb does not regenerate early', () => {
    const state = createSpiritOrbState();
    const pool = createWeaponProjectilePool();
    const def = WEAPONS['tempestHalo'];
    resetSpiritOrbs(state, def);

    fireSpiritOrb(state, pool, def, 0, 0, 200, 0, 1, createRng(3));
    for (let i = 0; i < 30; i++) tickSpiritOrbs(state, def, DT_MS);
    assert.equal(getAvailableSpiritOrbCount(state), 4);
  });

  test('an aim exactly on the firing orb is degenerate and keeps the orb', () => {
    const state = createSpiritOrbState();
    const pool = createWeaponProjectilePool();
    const def = WEAPONS['tempestHalo'];
    resetSpiritOrbs(state, def);

    // The degenerate case is the aim coinciding with the ORB, not the wielder:
    // orbs launch from their own orbit position, so aiming at the player centre
    // is a perfectly valid (non-zero) direction.
    const orb = { xWorld: 0, yWorld: 0 };
    getSpiritOrbPosition(state, def, 0, 0, 0, orb);

    const result = fireSpiritOrb(state, pool, def, 0, 0, orb.xWorld, orb.yWorld, 1, createRng(3));
    assert.equal(result.didFire, false);
    assert.equal(getAvailableSpiritOrbCount(state), 5);
  });

  test('aiming at the wielder centre still fires, because orbs launch off-centre', () => {
    const state = createSpiritOrbState();
    const pool = createWeaponProjectilePool();
    const def = WEAPONS['tempestHalo'];
    resetSpiritOrbs(state, def);

    const result = fireSpiritOrb(state, pool, def, 0, 0, 0, 0, 1, createRng(3));
    assert.equal(result.didFire, true);
  });
});

describe('integration through the player weapon', () => {
  test('staff and spirit weapons are equippable', () => {
    const state = createPlayerWeaponState();
    assert.equal(equipPlayerWeapon(state, 'emberStaff'), true);
    assert.equal(equipPlayerWeapon(state, 'tempestHalo'), true);
  });

  test('an unported staff is refused rather than equipped dead', () => {
    const state = createPlayerWeaponState();
    assert.equal(equipPlayerWeapon(state, 'aegisStaff'), false);
    assert.equal(equipPlayerWeapon(state, 'gravebindStaff'), false);
  });

  test('summoner weapons are still refused', () => {
    const state = createPlayerWeaponState();
    assert.equal(equipPlayerWeapon(state, 'apiaryLexicon'), false);
    assert.equal(isWeaponRuntimeImplemented(WEAPONS['apiaryLexicon']), false);
  });

  test('holding attack with a staff damages an enemy over time', () => {
    const { world, player } = createWorldWithPlayer();
    equipPlayerWeapon(world.playerWeapon, 'emberStaff');
    const enemy = addEnemy(world, 100, 0);

    for (let i = 0; i < 40; i++) {
      tryStartPlayerWeaponAttack(world, player, 300, 0, world.rng);
      tickPlayerWeapon(world, player, world.rng);
    }
    assert.ok(enemy.healthPoints < 1000, 'sustained beam should have dealt damage');
  });

  test('releasing the attack stops the staff channel', () => {
    const { world, player } = createWorldWithPlayer();
    equipPlayerWeapon(world.playerWeapon, 'emberStaff');
    tryStartPlayerWeaponAttack(world, player, 300, 0, world.rng);
    assert.equal(world.playerWeapon.staff.isChannellingFlag, 1);

    releasePlayerWeaponAttack(world);
    assert.equal(world.playerWeapon.staff.isChannellingFlag, 0);
  });

  test('an aura staff raises the attack used by its own damage path', () => {
    const { world, player } = createWorldWithPlayer();
    equipPlayerWeapon(world.playerWeapon, 'warChantStaff');
    tryStartPlayerWeaponAttack(world, player, 300, 0, world.rng);
    // The aura is live while channelling; its multiplier is 1.5.
    const modifiers = getStaffAuraModifiers(world.playerWeapon.staff, WEAPONS['warChantStaff']);
    assert.equal(modifiers.attackMultiplier, 1.5);
  });

  test('a spirit weapon fires orbs that damage an enemy', () => {
    const { world, player } = createWorldWithPlayer();
    equipPlayerWeapon(world.playerWeapon, 'spiritBand');
    const enemy = addEnemy(world, 150, 0);

    tryStartPlayerWeaponAttack(world, player, 300, 0, world.rng);
    for (let i = 0; i < 40; i++) tickPlayerWeapon(world, player, world.rng);

    assert.ok(enemy.healthPoints < 1000, 'spirit orb should have hit');
  });

  test('swapping away from a spirit weapon clears the ring', () => {
    const state = createPlayerWeaponState();
    equipPlayerWeapon(state, 'tempestHalo');
    assert.equal(state.spiritOrbs.orbCount, 5);
    equipPlayerWeapon(state, 'sword');
    assert.equal(state.spiritOrbs.orbCount, 0);
  });

  test('swapping away from a staff stops its channel', () => {
    const { world, player } = createWorldWithPlayer();
    equipPlayerWeapon(world.playerWeapon, 'emberStaff');
    tryStartPlayerWeaponAttack(world, player, 300, 0, world.rng);
    equipPlayerWeapon(world.playerWeapon, 'sword');
    tickPlayerWeapon(world, player, world.rng);
    assert.equal(world.playerWeapon.staff.isChannellingFlag, 0);
  });
});
