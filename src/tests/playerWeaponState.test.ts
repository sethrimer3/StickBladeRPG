import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  DEFAULT_STARTER_WEAPON_ID,
  createPlayerWeaponState,
  equipPlayerWeapon,
  getEquippedWeaponDef,
  resetPlayerWeaponRoomState,
  syncPlayerHandsFromEquipment,
  tickPlayerWeapon,
  tryStartPlayerWeaponAttack,
} from '../sim/weapons/playerWeaponState';
import { WEAPONS, getWeaponCooldownTicks } from '../sim/weapons/weaponDefs';
import { createWorldState, type WorldState } from '../sim/world';
import { createClusterState, type ClusterState } from '../sim/clusters/state';
import { createDefaultCharacterStats } from '../sim/stats/characterStats';
import { KB_ACTIONS, DEFAULT_KEYBOARD_BINDINGS, KEYBOARD_ACTION_META } from '../input/keybindings';
import { createInputState, collectCommands } from '../input/handler';
import { CommandKind } from '../input/commands';

const DT_MS = 1000 / 60;

function createWorldWithPlayer(): { world: WorldState; player: ClusterState } {
  const world = createWorldState(DT_MS, 99);
  const player = createClusterState(1, 0, 0, 1, 100);
  world.clusters.push(player);
  return { world, player };
}

function addEnemy(world: WorldState, x: number, y: number, health = 100): ClusterState {
  const enemy = createClusterState(1, x, y, 0, health);
  world.clusters.push(enemy);
  return enemy;
}

/** Runs the weapon tick for `ticks` frames. */
function advance(world: WorldState, player: ClusterState | null, ticks: number): void {
  for (let i = 0; i < ticks; i++) tickPlayerWeapon(world, player, world.rng);
}

describe('world wiring', () => {
  test('a fresh world starts unarmed with an empty projectile pool', () => {
    const world = createWorldState(DT_MS, 1);
    assert.equal(world.playerWeapon.equippedWeaponId, null);
    assert.equal(world.playerWeapon.projectiles.liveCount, 0);
    assert.equal(world.playerCharacterStats, null);
  });
});

describe('equipping', () => {
  test('a known weapon equips', () => {
    const state = createPlayerWeaponState();
    assert.equal(equipPlayerWeapon(state, 'sword'), true);
    assert.equal(getEquippedWeaponDef(state)?.name, 'Sword');
  });

  test('the starter weapon id names a real, runtime-implemented weapon', () => {
    const state = createPlayerWeaponState();
    assert.equal(DEFAULT_STARTER_WEAPON_ID, 'woodenSword');
    assert.equal(equipPlayerWeapon(state, DEFAULT_STARTER_WEAPON_ID), true);
    assert.equal(getEquippedWeaponDef(state)?.name, 'Wooden Sword');
    assert.equal(getEquippedWeaponDef(state)?.grip, 'twoHand');
  });

  test('an unknown weapon is refused and leaves the current weapon in place', () => {
    const state = createPlayerWeaponState();
    equipPlayerWeapon(state, 'sword');
    assert.equal(equipPlayerWeapon(state, 'notAWeapon'), false);
    assert.equal(state.equippedWeaponId, 'sword');
  });

  test('the two bespoke-aura staves are equippable since Phase 2e', () => {
    const state = createPlayerWeaponState();
    // Both were refused while their auras were unported; the ward and
    // raise-on-death runtimes make them real weapons.
    assert.equal(equipPlayerWeapon(state, 'aegisStaff'), true);
    assert.equal(equipPlayerWeapon(state, 'gravebindStaff'), true);
    assert.equal(state.equippedWeaponId, 'gravebindStaff');
  });

  test('null unequips', () => {
    const state = createPlayerWeaponState();
    equipPlayerWeapon(state, 'sword');
    assert.equal(equipPlayerWeapon(state, null), true);
    assert.equal(getEquippedWeaponDef(state), null);
  });

  test('swapping weapons cancels a swing in flight', () => {
    const { world, player } = createWorldWithPlayer();
    equipPlayerWeapon(world.playerWeapon, 'sword');
    tryStartPlayerWeaponAttack(world, player, 50, 0, world.rng);
    assert.equal(world.playerWeapon.swing.activeFlag, 1);

    equipPlayerWeapon(world.playerWeapon, 'greatsword');
    assert.equal(world.playerWeapon.swing.activeFlag, 0);
  });
});

describe('melee attack through the world', () => {
  test('an attack damages an enemy in range', () => {
    const { world, player } = createWorldWithPlayer();
    equipPlayerWeapon(world.playerWeapon, 'sword');
    const enemy = addEnemy(world, 20, 0);

    assert.equal(tryStartPlayerWeaponAttack(world, player, 50, 0, world.rng), true);
    advance(world, player, 60);

    assert.ok(enemy.healthPoints < 100, 'enemy should have taken damage');
  });

  test('an unarmed player cannot attack', () => {
    const { world, player } = createWorldWithPlayer();
    const enemy = addEnemy(world, 20, 0);
    assert.equal(tryStartPlayerWeaponAttack(world, player, 50, 0, world.rng), false);
    advance(world, player, 60);
    assert.equal(enemy.healthPoints, 100);
  });

  test('an attack is refused while on cooldown', () => {
    const { world, player } = createWorldWithPlayer();
    equipPlayerWeapon(world.playerWeapon, 'sword');
    assert.equal(tryStartPlayerWeaponAttack(world, player, 50, 0, world.rng), true);
    assert.equal(tryStartPlayerWeaponAttack(world, player, 50, 0, world.rng), false);
  });

  test('the attack becomes available again after the cooldown', () => {
    const { world, player } = createWorldWithPlayer();
    equipPlayerWeapon(world.playerWeapon, 'sword');
    tryStartPlayerWeaponAttack(world, player, 50, 0, world.rng);
    advance(world, player, getWeaponCooldownTicks(WEAPONS['sword']) + 2);
    assert.equal(tryStartPlayerWeaponAttack(world, player, 50, 0, world.rng), true);
  });

  test('holding the attack input every tick auto-attacks at the weapon cadence', () => {
    const { world, player } = createWorldWithPlayer();
    equipPlayerWeapon(world.playerWeapon, 'sword');
    let attacks = 0;
    for (let i = 0; i < 200; i++) {
      if (tryStartPlayerWeaponAttack(world, player, 50, 0, world.rng)) attacks++;
      tickPlayerWeapon(world, player, world.rng);
    }
    // 200 ticks at a 22-tick cooldown — the 33-tick weapon cooldown sped up by
    // MELEE_SWING_SPEED_MULTIPLIER — allows roughly nine attacks.
    assert.ok(attacks >= 8 && attacks <= 10, `expected ~9 attacks, got ${attacks}`);
  });

  test('the player is never damaged by their own swing', () => {
    const { world, player } = createWorldWithPlayer();
    equipPlayerWeapon(world.playerWeapon, 'sword');
    tryStartPlayerWeaponAttack(world, player, 50, 0, world.rng);
    advance(world, player, 60);
    assert.equal(player.healthPoints, 100);
  });

  test('character stats scale weapon damage', () => {
    const weak = createWorldWithPlayer();
    equipPlayerWeapon(weak.world.playerWeapon, 'sword');
    const weakEnemy = addEnemy(weak.world, 20, 0, 1000);
    tryStartPlayerWeaponAttack(weak.world, weak.player, 50, 0, weak.world.rng);
    advance(weak.world, weak.player, 60);

    const strong = createWorldWithPlayer();
    const stats = createDefaultCharacterStats();
    stats.attackBase = 20;
    strong.world.playerCharacterStats = stats;
    equipPlayerWeapon(strong.world.playerWeapon, 'sword');
    const strongEnemy = addEnemy(strong.world, 20, 0, 1000);
    tryStartPlayerWeaponAttack(strong.world, strong.player, 50, 0, strong.world.rng);
    advance(strong.world, strong.player, 60);

    assert.ok(
      (1000 - strongEnemy.healthPoints) > (1000 - weakEnemy.healthPoints),
      'higher attack should deal more damage',
    );
  });

  test('a dead player stops driving the swing', () => {
    const { world, player } = createWorldWithPlayer();
    equipPlayerWeapon(world.playerWeapon, 'sword');
    const enemy = addEnemy(world, 20, 0);
    tryStartPlayerWeaponAttack(world, player, 50, 0, world.rng);
    // Simulate the tick pipeline passing null once the player dies.
    advance(world, null, 60);
    assert.equal(enemy.healthPoints, 100);
  });
});

describe('ranged attack through the world', () => {
  test('firing a bow spawns a projectile', () => {
    const { world, player } = createWorldWithPlayer();
    equipPlayerWeapon(world.playerWeapon, 'bow');
    assert.equal(tryStartPlayerWeaponAttack(world, player, 100, 0, world.rng), true);
    assert.ok(world.playerWeapon.projectiles.liveCount > 0);
  });

  test('a fired projectile damages an enemy downrange', () => {
    // Wand rather than bow: the bow declares gravity, so its arrow arcs and a
    // dead-flat shot at 80 units legitimately passes under the target.
    const { world, player } = createWorldWithPlayer();
    equipPlayerWeapon(world.playerWeapon, 'wand');
    const enemy = addEnemy(world, 80, 0);
    tryStartPlayerWeaponAttack(world, player, 100, 0, world.rng);
    advance(world, player, 40);
    assert.ok(enemy.healthPoints < 100, 'projectile should have hit');
  });

  test('a gravity weapon arcs, so a flat shot drops below a distant target', () => {
    const { world, player } = createWorldWithPlayer();
    equipPlayerWeapon(world.playerWeapon, 'bow');
    assert.equal(WEAPONS['bow'].gravity, true);
    tryStartPlayerWeaponAttack(world, player, 100, 0, world.rng);

    const pool = world.playerWeapon.projectiles;
    const slot = pool.isLive.indexOf(1);
    const startY = pool.yWorld[slot];
    advance(world, player, 20);
    assert.ok(pool.yWorld[slot] > startY, 'the arrow should have fallen');
  });

  test('a ranged weapon respects its cooldown', () => {
    const { world, player } = createWorldWithPlayer();
    equipPlayerWeapon(world.playerWeapon, 'bow');
    assert.equal(tryStartPlayerWeaponAttack(world, player, 100, 0, world.rng), true);
    assert.equal(tryStartPlayerWeaponAttack(world, player, 100, 0, world.rng), false);
  });

  test('projectiles keep flying after the weapon is unequipped', () => {
    const { world, player } = createWorldWithPlayer();
    equipPlayerWeapon(world.playerWeapon, 'wand');
    const enemy = addEnemy(world, 80, 0);
    tryStartPlayerWeaponAttack(world, player, 100, 0, world.rng);
    equipPlayerWeapon(world.playerWeapon, null);
    advance(world, player, 40);
    assert.ok(enemy.healthPoints < 100, 'in-flight projectile should still resolve');
  });
});

describe('room-scoped reset', () => {
  test('reset clears the swing, projectiles, and burst but keeps the weapon', () => {
    const { world, player } = createWorldWithPlayer();
    equipPlayerWeapon(world.playerWeapon, 'bow');
    tryStartPlayerWeaponAttack(world, player, 100, 0, world.rng);
    assert.ok(world.playerWeapon.projectiles.liveCount > 0);

    resetPlayerWeaponRoomState(world.playerWeapon);

    assert.equal(world.playerWeapon.projectiles.liveCount, 0);
    assert.equal(world.playerWeapon.swing.activeFlag, 0);
    assert.equal(world.playerWeapon.burstShotsRemaining, 0);
    assert.equal(world.playerWeapon.equippedWeaponId, 'bow', 'the weapon is player state, not room state');
  });

  test('reset clears the cooldown so a room change does not eat an attack', () => {
    const { world, player } = createWorldWithPlayer();
    equipPlayerWeapon(world.playerWeapon, 'sword');
    tryStartPlayerWeaponAttack(world, player, 50, 0, world.rng);
    resetPlayerWeaponRoomState(world.playerWeapon);
    assert.equal(tryStartPlayerWeaponAttack(world, player, 50, 0, world.rng), true);
  });
});

describe('determinism', () => {
  test('identical seeds and inputs produce identical outcomes', () => {
    function run(): number {
      const { world, player } = createWorldWithPlayer();
      equipPlayerWeapon(world.playerWeapon, 'sword');
      const enemy = addEnemy(world, 20, 0, 1000);
      for (let i = 0; i < 200; i++) {
        tryStartPlayerWeaponAttack(world, player, 50, 0, world.rng);
        tickPlayerWeapon(world, player, world.rng);
      }
      return enemy.healthPoints;
    }
    assert.equal(run(), run());
  });
});

describe('input binding', () => {
  test('weaponAttack is a registered rebindable action with a default key', () => {
    assert.ok(KB_ACTIONS.includes('weaponAttack'));
    assert.equal(DEFAULT_KEYBOARD_BINDINGS.weaponAttack, 'q');
    assert.equal(KEYBOARD_ACTION_META.weaponAttack.label, 'Weapon Attack');
  });

  test('grapple keeps a binding of its own now that the left mouse button swings', () => {
    // The left mouse button used to fire the grapple. It swings the weapon
    // instead, so without this action the grapple would be unreachable on
    // keyboard and mouse — the capability was meant to be kept, not removed.
    assert.ok(KB_ACTIONS.includes('grappleFire'));
    assert.equal(DEFAULT_KEYBOARD_BINDINGS.grappleFire, 'e');
    assert.equal(KEYBOARD_ACTION_META.grappleFire.label, 'Grapple');
  });

  test('a left-button press and release swings the weapon and weaves nothing', () => {
    // The button used to fire the grapple on press and burst the primary Weave
    // on release. Both were taken off it; only the weapon swing is left.
    const input = createInputState();
    input.isMouseDownFlag = 1;
    input.isWeaponAttackHeldFlag = true;

    const pressed = collectCommands(input);
    assert.ok(!pressed.some(c => c.kind === CommandKind.GrappleFire));
    assert.ok(!pressed.some(c => c.kind === CommandKind.WeaveActivatePrimary));
    assert.ok(!pressed.some(c => c.kind === CommandKind.WeaveHoldPrimary));

    input.isMouseDownFlag = 0;
    input.isWeaponAttackHeldFlag = false;
    const released = collectCommands(input);
    assert.ok(!released.some(c => c.kind === CommandKind.WeaveActivatePrimary));
    assert.ok(!released.some(c => c.kind === CommandKind.GrappleRelease));
  });

  test('the default attack key does not collide with another action', () => {
    const bindings = Object.values(DEFAULT_KEYBOARD_BINDINGS);
    const unique = new Set(bindings);
    assert.equal(bindings.length, unique.size, 'default keybindings must be unique');
  });
});

describe('two hands', () => {
  test('a fresh world has an idle, independent off-hand runtime', () => {
    const world = createWorldState(DT_MS, 1);
    assert.equal(world.playerOffHandWeapon.equippedWeaponId, null);
    assert.notEqual(world.playerOffHandWeapon, world.playerWeapon);
  });

  test('the sync fills both hands from the equipment slots', () => {
    const { world } = createWorldWithPlayer();
    syncPlayerHandsFromEquipment(world, 'sword', 'dagger');
    assert.equal(world.playerWeapon.equippedWeaponId, 'sword');
    assert.equal(world.playerOffHandWeapon.equippedWeaponId, 'dagger');
  });

  test('a two-handed main hand empties the off hand, even if a save asked otherwise', () => {
    const { world } = createWorldWithPlayer();
    syncPlayerHandsFromEquipment(world, 'greatsword', 'dagger');
    assert.equal(world.playerWeapon.equippedWeaponId, 'greatsword');
    assert.equal(world.playerOffHandWeapon.equippedWeaponId, null);
  });

  test('a two-handed weapon is never held in the off hand', () => {
    const { world } = createWorldWithPlayer();
    syncPlayerHandsFromEquipment(world, 'sword', 'greatsword');
    assert.equal(world.playerOffHandWeapon.equippedWeaponId, null);
  });

  test('an empty main hand falls back to the starter weapon', () => {
    const { world } = createWorldWithPlayer();
    syncPlayerHandsFromEquipment(world, null, null);
    assert.equal(world.playerWeapon.equippedWeaponId, DEFAULT_STARTER_WEAPON_ID);
  });

  test('each hand keeps its own cooldown, so one does not block the other', () => {
    const { world, player } = createWorldWithPlayer();
    syncPlayerHandsFromEquipment(world, 'sword', 'dagger');

    assert.equal(tryStartPlayerWeaponAttack(world, player, 40, 0, world.rng), true);
    // The main hand is now on cooldown; the off hand must be untouched by that.
    assert.equal(tryStartPlayerWeaponAttack(world, player, 40, 0, world.rng), false);
    assert.equal(
      tryStartPlayerWeaponAttack(world, player, 40, 0, world.rng, world.playerOffHandWeapon),
      true,
    );
  });

  test('the off hand ticks independently of the main hand', () => {
    const { world, player } = createWorldWithPlayer();
    syncPlayerHandsFromEquipment(world, 'sword', 'dagger');
    tryStartPlayerWeaponAttack(world, player, 40, 0, world.rng, world.playerOffHandWeapon);

    const before = world.playerOffHandWeapon.swing.cooldownRemainingTicks;
    assert.ok(before > 0);
    tickPlayerWeapon(world, player, world.rng, world.playerOffHandWeapon);
    assert.equal(world.playerOffHandWeapon.swing.cooldownRemainingTicks, before - 1);
    // Ticking one hand must not advance the other's cooldown.
    tickPlayerWeapon(world, player, world.rng);
    assert.equal(world.playerOffHandWeapon.swing.cooldownRemainingTicks, before - 1);
  });
});
