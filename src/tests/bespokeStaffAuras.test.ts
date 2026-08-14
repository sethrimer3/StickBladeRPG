/**
 * Phase 2e of the STICK-RPG port: the Aegis Stave's intercepting ward and the
 * Gravebind Stave's raise-on-death.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  absorbWithProjectileShield,
  createProjectileShieldState,
  getProjectileShieldConfig,
  resetProjectileShieldState,
  tickProjectileShield,
} from '../sim/weapons/projectileShield';
import {
  createStaffChannelState,
  getStaffRaiseOnDeathConfig,
  isPointInsideActiveStaffAura,
  requestStaffChannel,
} from '../sim/weapons/staffChannel';
import {
  countLiveThralls,
  createSummonPool,
  MAX_ACTIVE_THRALLS,
  raiseThrallFromCorpse,
  resetSummonPool,
} from '../sim/weapons/weaponSummons';
import { getWeaponDef, WEAPONS } from '../sim/weapons/weaponDefs';
import { createRng } from '../sim/rng';
import { applyPlayerDamageWithKnockback } from '../sim/playerDamage';
import { createClusterState, type ClusterState } from '../sim/clusters/state';
import { createWorldState } from '../sim/world';
import { applyRoutedWeaveDamage } from '../sim/weaves/weaveCollisionUtils';
import {
  equipPlayerWeapon,
  tickPlayerWeapon,
  tryStartPlayerWeaponAttack,
} from '../sim/weapons/playerWeaponState';

const DT_MS = 1000 / 60;

const AEGIS = WEAPONS['aegisStaff'];
const GRAVEBIND = WEAPONS['gravebindStaff'];

describe('aegis ward configuration', () => {
  test('reads the donor projectileShield block', () => {
    const config = getProjectileShieldConfig(AEGIS);
    assert.notEqual(config, null);
    assert.equal(config?.maxHpFactor, 2);
    assert.equal(config?.regenPercent, 0.05);
    assert.equal(config?.minRadiusWorld, 44);
  });

  test('a staff without the block, and a non-staff, declare no ward', () => {
    assert.equal(getProjectileShieldConfig(GRAVEBIND), null);
    assert.equal(getProjectileShieldConfig(getWeaponDef('sword')), null);
    assert.equal(getProjectileShieldConfig(null), null);
  });
});

describe('aegis ward runtime', () => {
  test('channelling raises a ward sized from the wielder max health', () => {
    const state = createProjectileShieldState();
    tickProjectileShield(state, AEGIS, true, 20, 110, DT_MS);

    assert.equal(state.isActiveFlag, 1);
    // maxHpFactor 2 × 20 max health.
    assert.equal(state.maxHitPoints, 40);
    assert.equal(state.hitPoints, 40);
    // minRadius 44 is below the aura radius, so the aura radius wins.
    assert.equal(state.radiusWorld, 110);
  });

  test('the ward radius never falls below minRadius', () => {
    const state = createProjectileShieldState();
    tickProjectileShield(state, AEGIS, true, 20, 10, DT_MS);
    assert.equal(state.radiusWorld, 44);
  });

  test('releasing the channel drops the ward', () => {
    const state = createProjectileShieldState();
    tickProjectileShield(state, AEGIS, true, 20, 110, DT_MS);
    tickProjectileShield(state, AEGIS, false, 20, 110, DT_MS);

    assert.equal(state.isActiveFlag, 0);
    assert.equal(state.hitPoints, 0);
  });

  test('a spent ward regenerates at regenPercent of capacity per second', () => {
    const state = createProjectileShieldState();
    tickProjectileShield(state, AEGIS, true, 20, 110, DT_MS);
    state.hitPoints = 0;

    // 5% of 40 = 2 points per second; one second of ticks.
    for (let i = 0; i < 60; i++) tickProjectileShield(state, AEGIS, true, 20, 110, DT_MS);
    assert.ok(Math.abs(state.hitPoints - 2) < 0.05, `regenerated ${state.hitPoints}`);
  });

  test('absorption spends ward points and passes the remainder through', () => {
    const state = createProjectileShieldState();
    tickProjectileShield(state, AEGIS, true, 20, 110, DT_MS);
    state.hitPoints = 5;

    assert.equal(absorbWithProjectileShield(state, 3), 0);
    assert.equal(state.hitPoints, 2);
    assert.ok(state.hitFlashTicks > 0);

    // Overflow gets through; the ward stays up but empty.
    assert.equal(absorbWithProjectileShield(state, 6), 4);
    assert.equal(state.hitPoints, 0);
    assert.equal(state.isActiveFlag, 1);
  });

  test('a down ward absorbs nothing', () => {
    const state = createProjectileShieldState();
    resetProjectileShieldState(state);
    assert.equal(absorbWithProjectileShield(state, 7), 7);
  });
});

describe('ward integration with player damage', () => {
  function createTarget(): ClusterState {
    const player = createClusterState(1, 0, 0, 1, 100);
    player.hitPoints = 10;
    return player;
  }

  test('a hit the ward swallows costs no health and grants no invulnerability', () => {
    const player = createTarget();
    const ward = createProjectileShieldState();
    tickProjectileShield(ward, AEGIS, true, 20, 110, DT_MS);
    player.projectileShield = ward;

    const didDamage = applyPlayerDamageWithKnockback(player, 3, 500, 0);
    assert.equal(didDamage, false);
    assert.equal(player.hitPoints, 10);
    assert.equal(player.invulnerabilityTicks, 0);
    assert.equal(ward.hitPoints, 37);
  });

  test('damage beyond the ward reaches the player', () => {
    const player = createTarget();
    const ward = createProjectileShieldState();
    tickProjectileShield(ward, AEGIS, true, 20, 110, DT_MS);
    ward.hitPoints = 1;
    player.projectileShield = ward;

    assert.equal(applyPlayerDamageWithKnockback(player, 3, 500, 0), true);
    assert.equal(ward.hitPoints, 0);
    assert.equal(player.hitPoints, 8);
  });

  test('a target with no ward is damaged exactly as before the port', () => {
    const player = createTarget();
    assert.equal(player.projectileShield, null);
    assert.equal(applyPlayerDamageWithKnockback(player, 3, 500, 0), true);
    assert.equal(player.hitPoints, 7);
  });
});

describe('gravebind raise-on-death', () => {
  test('reads the donor raiseOnDeath block', () => {
    const config = getStaffRaiseOnDeathConfig(GRAVEBIND);
    assert.notEqual(config, null);
    assert.equal(config?.lifetimeMs, 15000);
    assert.equal(config?.scale, 0.7);
    assert.equal(getStaffRaiseOnDeathConfig(AEGIS), null);
    assert.equal(getStaffRaiseOnDeathConfig(getWeaponDef('sword')), null);
  });

  test('the aura reaches only within its radius, and only while channelling', () => {
    const channel = createStaffChannelState();
    // Not channelling yet.
    assert.equal(isPointInsideActiveStaffAura(channel, GRAVEBIND, 0, 0, 10, 0), false);

    requestStaffChannel(channel, GRAVEBIND, 100, 0);
    // Donor aura radius is 240.
    assert.equal(isPointInsideActiveStaffAura(channel, GRAVEBIND, 0, 0, 200, 0), true);
    assert.equal(isPointInsideActiveStaffAura(channel, GRAVEBIND, 0, 0, 300, 0), false);
  });

  test('raising a corpse produces a thrall scaled from its body', () => {
    const pool = createSummonPool();
    const config = getStaffRaiseOnDeathConfig(GRAVEBIND);
    assert.notEqual(config, null);

    const raised = raiseThrallFromCorpse(pool, config!, 120, 40, 20, 30, 1, createRng(7));
    assert.equal(raised, true);
    assert.equal(pool.liveCount, 1);
    assert.equal(pool.isThrall[0], 1);
    assert.equal(pool.isGuardian[0], 0);
    assert.equal(pool.xWorld[0], 120);
    // scale 0.7 applied to the corpse half-extent.
    assert.ok(Math.abs(pool.radiusWorld[0] - 14) < 1e-3);
    // 15 s of lifetime at 60 fps.
    assert.equal(pool.lifetimeTicks[0], 900);
    assert.ok(pool.damage[0] > 0);
  });

  test('thralls are capped independently of the pool', () => {
    const pool = createSummonPool();
    const config = getStaffRaiseOnDeathConfig(GRAVEBIND)!;
    const rng = createRng(11);

    for (let i = 0; i < MAX_ACTIVE_THRALLS; i++) {
      assert.equal(raiseThrallFromCorpse(pool, config, i * 10, 0, 20, 30, 1, rng), true);
    }
    assert.equal(countLiveThralls(pool), MAX_ACTIVE_THRALLS);
    assert.equal(raiseThrallFromCorpse(pool, config, 999, 0, 20, 30, 1, rng), false);

    resetSummonPool(pool);
    assert.equal(countLiveThralls(pool), 0);
  });
});

describe('bespoke auras through the equipped weapon', () => {
  test('channelling the Aegis Stave attaches a live ward to the player', () => {
    const world = createWorldState(DT_MS, 5);
    const player = createClusterState(1, 0, 0, 1, 100);
    world.clusters.push(player);

    assert.equal(equipPlayerWeapon(world.playerWeapon, 'aegisStaff'), true);
    assert.equal(tryStartPlayerWeaponAttack(world, player, 100, 0, world.rng), true);
    tickPlayerWeapon(world, player, world.rng);

    assert.equal(world.playerWeapon.projectileShield.isActiveFlag, 1);
    assert.equal(player.projectileShield, world.playerWeapon.projectileShield);
    assert.ok(world.playerWeapon.projectileShield.hitPoints > 0);
  });

  test('a Gravebind channel raises enemies felled inside its aura', () => {
    const world = createWorldState(DT_MS, 5);
    const player = createClusterState(1, 0, 0, 1, 100);
    world.clusters.push(player);
    const enemy = createClusterState(2, 100, 0, 0, 100);
    enemy.healthPoints = 5;
    enemy.maxHealthPoints = 5;
    world.clusters.push(enemy);

    assert.equal(equipPlayerWeapon(world.playerWeapon, 'gravebindStaff'), true);
    tryStartPlayerWeaponAttack(world, player, 200, 0, world.rng);

    applyRoutedWeaveDamage(world, 1, 10, enemy.positionXWorld, enemy.positionYWorld);
    assert.equal(enemy.isAliveFlag, 0);
    assert.equal(countLiveThralls(world.playerWeapon.summons), 1);
  });

  test('a corpse outside the aura raises nothing', () => {
    const world = createWorldState(DT_MS, 5);
    const player = createClusterState(1, 0, 0, 1, 100);
    world.clusters.push(player);
    // Donor aura radius is 240.
    const enemy = createClusterState(2, 900, 0, 0, 100);
    enemy.healthPoints = 5;
    enemy.maxHealthPoints = 5;
    world.clusters.push(enemy);

    equipPlayerWeapon(world.playerWeapon, 'gravebindStaff');
    tryStartPlayerWeaponAttack(world, player, 200, 0, world.rng);

    applyRoutedWeaveDamage(world, 1, 10, enemy.positionXWorld, enemy.positionYWorld);
    assert.equal(countLiveThralls(world.playerWeapon.summons), 0);
  });

  test('the ward detaches from the player when the channel stops', () => {
    const world = createWorldState(DT_MS, 5);
    const player = createClusterState(1, 0, 0, 1, 100);
    world.clusters.push(player);

    equipPlayerWeapon(world.playerWeapon, 'aegisStaff');
    tryStartPlayerWeaponAttack(world, player, 100, 0, world.rng);
    tickPlayerWeapon(world, player, world.rng);

    world.playerWeapon.staff.isChannellingFlag = 0;
    tickPlayerWeapon(world, player, world.rng);

    assert.equal(world.playerWeapon.projectileShield.isActiveFlag, 0);
    assert.equal(player.projectileShield, null);
  });
});
