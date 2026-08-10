import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  MAX_WEAPON_PROJECTILES,
  createWeaponProjectilePool,
  fireRangedWeapon,
  getWeaponBurstCount,
  isRangedWeaponKind,
  resetWeaponProjectilePool,
  spawnWeaponProjectile,
  tickWeaponProjectiles,
  type WeaponProjectilePool,
} from '../sim/weapons/weaponProjectiles';
import { WEAPONS, isWeaponRuntimeImplemented, type WeaponDef } from '../sim/weapons/weaponDefs';
import { createWorldState, type WorldState } from '../sim/world';
import { createClusterState } from '../sim/clusters/state';
import { createRng } from '../sim/rng';

const DT_MS = 1000 / 60;

function createWorld(): WorldState {
  return createWorldState(DT_MS, 1234);
}

function addEnemy(world: WorldState, x: number, y: number, health = 100): ReturnType<typeof createClusterState> {
  const enemy = createClusterState(1, x, y, 0, health);
  world.clusters.push(enemy);
  return enemy;
}

/** A minimal straight-flying projectile weapon with no donor flourishes. */
const PLAIN_BOLT: WeaponDef = {
  name: 'Test Bolt',
  kind: 'magic',
  projectile: 'bolt',
  dmg: 10,
  speed: 600,
  gravity: false,
  cooldown: 500,
};

function advance(world: WorldState, pool: WeaponProjectilePool, ticks: number): { hits: number; damage: number } {
  let hits = 0;
  let damage = 0;
  for (let i = 0; i < ticks; i++) {
    const result = tickWeaponProjectiles(world, pool);
    hits += result.hitCount;
    damage += result.totalDamage;
  }
  return { hits, damage };
}

describe('projectile pool', () => {
  test('a new pool is empty', () => {
    const pool = createWeaponProjectilePool();
    assert.equal(pool.liveCount, 0);
  });

  test('spawning occupies a slot', () => {
    const pool = createWeaponProjectilePool();
    const slot = spawnWeaponProjectile(pool, PLAIN_BOLT, {
      xWorld: 0, yWorld: 0, dirXWorld: 1, dirYWorld: 0, damage: 5,
    });
    assert.notEqual(slot, -1);
    assert.equal(pool.liveCount, 1);
    assert.equal(pool.isLive[slot], 1);
  });

  test('a weapon with no speed cannot spawn a projectile', () => {
    const pool = createWeaponProjectilePool();
    const slot = spawnWeaponProjectile(pool, { ...PLAIN_BOLT, speed: 0 }, {
      xWorld: 0, yWorld: 0, dirXWorld: 1, dirYWorld: 0, damage: 5,
    });
    assert.equal(slot, -1);
    assert.equal(pool.liveCount, 0);
  });

  test('reset clears everything', () => {
    const pool = createWeaponProjectilePool();
    spawnWeaponProjectile(pool, PLAIN_BOLT, { xWorld: 0, yWorld: 0, dirXWorld: 1, dirYWorld: 0, damage: 5 });
    resetWeaponProjectilePool(pool);
    assert.equal(pool.liveCount, 0);
  });

  test('spawning past capacity evicts the oldest rather than dropping the new shot', () => {
    const pool = createWeaponProjectilePool();
    for (let i = 0; i < MAX_WEAPON_PROJECTILES; i++) {
      spawnWeaponProjectile(pool, PLAIN_BOLT, { xWorld: i, yWorld: 0, dirXWorld: 1, dirYWorld: 0, damage: 1 });
    }
    assert.equal(pool.liveCount, MAX_WEAPON_PROJECTILES);

    const slot = spawnWeaponProjectile(pool, PLAIN_BOLT, {
      xWorld: 999, yWorld: 0, dirXWorld: 1, dirYWorld: 0, damage: 1,
    });
    assert.notEqual(slot, -1);
    assert.equal(pool.liveCount, MAX_WEAPON_PROJECTILES, 'capacity should not be exceeded');
    assert.equal(pool.xWorld[slot], 999, 'the newest shot should occupy the slot');
  });
});

describe('projectile flight', () => {
  test('a projectile travels in its launch direction', () => {
    const world = createWorld();
    const pool = createWeaponProjectilePool();
    const slot = spawnWeaponProjectile(pool, PLAIN_BOLT, {
      xWorld: 0, yWorld: 0, dirXWorld: 1, dirYWorld: 0, damage: 1,
    });
    advance(world, pool, 5);
    assert.ok(pool.xWorld[slot] > 0, 'should have moved right');
    assert.ok(Math.abs(pool.yWorld[slot]) < 1e-3, 'should not have drifted vertically');
  });

  test('gravity pulls a gravity projectile downward', () => {
    const world = createWorld();
    const pool = createWeaponProjectilePool();
    const slot = spawnWeaponProjectile(pool, { ...PLAIN_BOLT, gravity: true }, {
      xWorld: 0, yWorld: 0, dirXWorld: 1, dirYWorld: 0, damage: 1,
    });
    advance(world, pool, 10);
    assert.ok(pool.yWorld[slot] > 0, 'expected downward drop');
  });

  test('a non-gravity projectile keeps its height', () => {
    const world = createWorld();
    const pool = createWeaponProjectilePool();
    const slot = spawnWeaponProjectile(pool, PLAIN_BOLT, {
      xWorld: 0, yWorld: 50, dirXWorld: 1, dirYWorld: 0, damage: 1,
    });
    advance(world, pool, 10);
    assert.ok(Math.abs(pool.yWorld[slot] - 50) < 1e-3);
  });

  test('drag slows a projectile down', () => {
    const world = createWorld();
    const pool = createWeaponProjectilePool();
    const dragged = spawnWeaponProjectile(pool, { ...PLAIN_BOLT, projectileDrag: 0.2 }, {
      xWorld: 0, yWorld: 0, dirXWorld: 1, dirYWorld: 0, damage: 1,
    });
    const free = spawnWeaponProjectile(pool, PLAIN_BOLT, {
      xWorld: 0, yWorld: 100, dirXWorld: 1, dirYWorld: 0, damage: 1,
    });
    advance(world, pool, 20);
    assert.ok(pool.xWorld[dragged] < pool.xWorld[free], 'drag should reduce travel');
  });

  test('a projectile expires when its lifetime runs out', () => {
    const world = createWorld();
    const pool = createWeaponProjectilePool();
    spawnWeaponProjectile(pool, { ...PLAIN_BOLT, ttl: 100 }, {
      xWorld: 0, yWorld: 0, dirXWorld: 1, dirYWorld: 0, damage: 1,
    });
    advance(world, pool, 300);
    assert.equal(pool.liveCount, 0);
  });

  test('ticking an empty pool is a safe no-op', () => {
    const world = createWorld();
    const pool = createWeaponProjectilePool();
    const result = tickWeaponProjectiles(world, pool);
    assert.equal(result.hitCount, 0);
    assert.equal(result.expiredCount, 0);
  });
});

describe('projectile damage', () => {
  test('a projectile damages an enemy in its path', () => {
    const world = createWorld();
    const pool = createWeaponProjectilePool();
    const enemy = addEnemy(world, 60, 0);
    spawnWeaponProjectile(pool, PLAIN_BOLT, {
      xWorld: 0, yWorld: 0, dirXWorld: 1, dirYWorld: 0, damage: 25,
    });
    const { hits } = advance(world, pool, 30);
    assert.equal(hits, 1);
    assert.equal(enemy.healthPoints, 75);
  });

  test('a non-piercing projectile is consumed by its first hit', () => {
    const world = createWorld();
    const pool = createWeaponProjectilePool();
    addEnemy(world, 40, 0);
    const second = addEnemy(world, 80, 0);
    spawnWeaponProjectile(pool, PLAIN_BOLT, {
      xWorld: 0, yWorld: 0, dirXWorld: 1, dirYWorld: 0, damage: 10,
    });
    advance(world, pool, 40);
    assert.equal(second.healthPoints, 100, 'second enemy should be untouched');
    assert.equal(pool.liveCount, 0);
  });

  test('a piercing projectile damages every enemy along its path', () => {
    const world = createWorld();
    const pool = createWeaponProjectilePool();
    const first = addEnemy(world, 40, 0);
    const second = addEnemy(world, 80, 0);
    spawnWeaponProjectile(pool, { ...PLAIN_BOLT, projectileIgnoreStickCollision: true }, {
      xWorld: 0, yWorld: 0, dirXWorld: 1, dirYWorld: 0, damage: 10,
    });
    advance(world, pool, 40);
    assert.equal(first.healthPoints, 90);
    assert.equal(second.healthPoints, 90);
  });

  test('a piercing projectile does not damage the same enemy twice', () => {
    const world = createWorld();
    const pool = createWeaponProjectilePool();
    const enemy = addEnemy(world, 40, 0);
    spawnWeaponProjectile(pool, { ...PLAIN_BOLT, projectileIgnoreStickCollision: true, speed: 60 }, {
      xWorld: 0, yWorld: 0, dirXWorld: 1, dirYWorld: 0, damage: 10,
    });
    advance(world, pool, 120);
    assert.equal(enemy.healthPoints, 90);
  });

  test('a harmless projectile deals no damage', () => {
    const world = createWorld();
    const pool = createWeaponProjectilePool();
    const enemy = addEnemy(world, 60, 0);
    spawnWeaponProjectile(pool, { ...PLAIN_BOLT, projectileHarmless: true }, {
      xWorld: 0, yWorld: 0, dirXWorld: 1, dirYWorld: 0, damage: 25,
    });
    advance(world, pool, 30);
    assert.equal(enemy.healthPoints, 100);
  });

  test('the player is never hit by their own projectile', () => {
    const world = createWorld();
    const pool = createWeaponProjectilePool();
    const player = createClusterState(1, 60, 0, 1, 100);
    world.clusters.push(player);
    spawnWeaponProjectile(pool, PLAIN_BOLT, {
      xWorld: 0, yWorld: 0, dirXWorld: 1, dirYWorld: 0, damage: 25,
    });
    advance(world, pool, 30);
    assert.equal(player.healthPoints, 100);
  });

  test('a dead enemy is skipped', () => {
    const world = createWorld();
    const pool = createWeaponProjectilePool();
    const enemy = addEnemy(world, 60, 0);
    enemy.isAliveFlag = 0;
    spawnWeaponProjectile(pool, PLAIN_BOLT, {
      xWorld: 0, yWorld: 0, dirXWorld: 1, dirYWorld: 0, damage: 25,
    });
    const { hits } = advance(world, pool, 30);
    assert.equal(hits, 0);
  });

  test('a fast projectile cannot tunnel past an enemy', () => {
    const world = createWorld();
    const pool = createWeaponProjectilePool();
    const enemy = addEnemy(world, 500, 0);
    // 60000 units/s travels ~1000 units per tick — far past the enemy in one step.
    spawnWeaponProjectile(pool, { ...PLAIN_BOLT, speed: 60000 }, {
      xWorld: 0, yWorld: 0, dirXWorld: 1, dirYWorld: 0, damage: 25,
    });
    advance(world, pool, 3);
    assert.equal(enemy.healthPoints, 75, 'swept collision should have caught it');
  });
});

describe('blast damage', () => {
  test('an expiring blast projectile damages everything in radius', () => {
    const world = createWorld();
    const pool = createWeaponProjectilePool();
    const near = addEnemy(world, 30, 0);
    const far = addEnemy(world, 400, 0);
    spawnWeaponProjectile(pool, { ...PLAIN_BOLT, speed: 1, ttl: 100, blastRadius: 100, blastDamage: 40 }, {
      xWorld: 0, yWorld: 0, dirXWorld: 1, dirYWorld: 0, damage: 0,
    });
    advance(world, pool, 30);
    assert.equal(near.healthPoints, 60);
    assert.equal(far.healthPoints, 100);
  });

  test('blast damage falls back to contact damage when unspecified', () => {
    const world = createWorld();
    const pool = createWeaponProjectilePool();
    const enemy = addEnemy(world, 30, 0);
    spawnWeaponProjectile(pool, { ...PLAIN_BOLT, speed: 1, ttl: 100, blastRadius: 100 }, {
      xWorld: 0, yWorld: 0, dirXWorld: 1, dirYWorld: 0, damage: 15,
    });
    advance(world, pool, 30);
    assert.equal(enemy.healthPoints, 85);
  });

  test('a projectile with no blast radius does not explode', () => {
    const world = createWorld();
    const pool = createWeaponProjectilePool();
    const enemy = addEnemy(world, 30, 0);
    spawnWeaponProjectile(pool, { ...PLAIN_BOLT, speed: 1, ttl: 100 }, {
      xWorld: 0, yWorld: -200, dirXWorld: 0, dirYWorld: -1, damage: 15,
    });
    advance(world, pool, 30);
    assert.equal(enemy.healthPoints, 100);
  });
});

describe('homing', () => {
  test('a homing projectile curves toward an off-axis enemy', () => {
    const world = createWorld();
    const pool = createWeaponProjectilePool();
    addEnemy(world, 200, 200);

    const homing = spawnWeaponProjectile(
      pool, { ...PLAIN_BOLT, projectileHoming: true, projectileTurnRate: 0.3 },
      { xWorld: 0, yWorld: 0, dirXWorld: 1, dirYWorld: 0, damage: 1 },
    );
    advance(world, pool, 5);
    assert.ok(pool.velocityYWorld[homing] > 0, 'expected the shot to bend downward toward the target');
  });

  test('a homing projectile with no target flies straight', () => {
    const world = createWorld();
    const pool = createWeaponProjectilePool();
    const slot = spawnWeaponProjectile(
      pool, { ...PLAIN_BOLT, projectileHoming: true, projectileTurnRate: 0.3 },
      { xWorld: 0, yWorld: 0, dirXWorld: 1, dirYWorld: 0, damage: 1 },
    );
    advance(world, pool, 5);
    assert.ok(Math.abs(pool.velocityYWorld[slot]) < 1e-3);
  });
});

describe('firing ranged weapons', () => {
  test('ranged kinds are recognized and contact kinds are not', () => {
    assert.equal(isRangedWeaponKind(WEAPONS['bow']), true);
    assert.equal(isRangedWeaponKind(WEAPONS['wand']), true);
    assert.equal(isRangedWeaponKind(WEAPONS['dagger']), true);
    assert.equal(isRangedWeaponKind(WEAPONS['sword']), false);
  });

  test('firing a bow launches a projectile', () => {
    const pool = createWeaponProjectilePool();
    const result = fireRangedWeapon(pool, WEAPONS['bow'], 0, 0, 100, 0, 1, createRng(1));
    assert.equal(result.projectileCount, 1);
    assert.equal(pool.liveCount, 1);
  });

  test('firing a melee weapon launches nothing', () => {
    const pool = createWeaponProjectilePool();
    const result = fireRangedWeapon(pool, WEAPONS['sword'], 0, 0, 100, 0, 1, createRng(1));
    assert.equal(result.projectileCount, 0);
  });

  test('a zero-length aim vector fires nothing', () => {
    const pool = createWeaponProjectilePool();
    const result = fireRangedWeapon(pool, WEAPONS['bow'], 0, 0, 0, 0, 1, createRng(1));
    assert.equal(result.projectileCount, 0);
  });

  test('a multi-pellet weapon launches every pellet', () => {
    const pool = createWeaponProjectilePool();
    const shotgun: WeaponDef = { ...PLAIN_BOLT, kind: 'gun', bulletCount: 5, spread: 0.4 };
    const result = fireRangedWeapon(pool, shotgun, 0, 0, 100, 0, 1, createRng(7));
    assert.equal(result.projectileCount, 5);
    assert.equal(pool.liveCount, 5);
  });

  test('spread scatters pellets rather than stacking them', () => {
    const pool = createWeaponProjectilePool();
    const shotgun: WeaponDef = { ...PLAIN_BOLT, kind: 'gun', bulletCount: 5, spread: 0.6 };
    fireRangedWeapon(pool, shotgun, 0, 0, 100, 0, 1, createRng(7));
    const angles = new Set<number>();
    for (let i = 0; i < MAX_WEAPON_PROJECTILES; i++) {
      if (pool.isLive[i] === 1) angles.add(Math.round(Math.atan2(pool.velocityYWorld[i], pool.velocityXWorld[i]) * 1000));
    }
    assert.ok(angles.size > 1, 'pellets should not share one angle');
  });

  test('a weapon with no spread fires perfectly straight', () => {
    const pool = createWeaponProjectilePool();
    const rifle: WeaponDef = { ...PLAIN_BOLT, kind: 'gun', bulletCount: 3 };
    fireRangedWeapon(pool, rifle, 0, 0, 100, 0, 1, createRng(7));
    for (let i = 0; i < MAX_WEAPON_PROJECTILES; i++) {
      if (pool.isLive[i] === 1) assert.ok(Math.abs(pool.velocityYWorld[i]) < 1e-3);
    }
  });

  test('firing is deterministic for a given seed', () => {
    const shotgun: WeaponDef = { ...PLAIN_BOLT, kind: 'gun', bulletCount: 4, spread: 0.5 };
    const a = createWeaponProjectilePool();
    fireRangedWeapon(a, shotgun, 0, 0, 100, 0, 2, createRng(2024));
    const b = createWeaponProjectilePool();
    fireRangedWeapon(b, shotgun, 0, 0, 100, 0, 2, createRng(2024));
    assert.deepEqual(Array.from(a.velocityXWorld), Array.from(b.velocityXWorld));
    assert.deepEqual(Array.from(a.velocityYWorld), Array.from(b.velocityYWorld));
  });

  test('higher attack produces harder-hitting projectiles', () => {
    const weak = createWeaponProjectilePool();
    fireRangedWeapon(weak, WEAPONS['bow'], 0, 0, 100, 0, 1, createRng(5));
    const strong = createWeaponProjectilePool();
    fireRangedWeapon(strong, WEAPONS['bow'], 0, 0, 100, 0, 10, createRng(5));
    assert.ok(strong.damage[0] > weak.damage[0]);
  });

  test('burst count is exposed for the caller to schedule', () => {
    assert.equal(getWeaponBurstCount(PLAIN_BOLT), 1);
    assert.equal(getWeaponBurstCount({ ...PLAIN_BOLT, burstCount: 3 }), 3);
  });

  test('every ported ranged weapon with a launch speed can actually fire', () => {
    const rng = createRng(11);
    let ranged = 0;
    let fired = 0;
    const silent: string[] = [];
    for (const id of Object.keys(WEAPONS)) {
      const def = WEAPONS[id];
      if (!isRangedWeaponKind(def)) continue;
      ranged++;
      const pool = createWeaponProjectilePool();
      const result = fireRangedWeapon(pool, def, 0, 0, 100, 0, 1, rng);
      if (result.projectileCount > 0) fired++; else silent.push(id);
    }
    assert.equal(ranged, 33, `expected 33 ranged weapons, found ${ranged}`);
    // mirageEdge declares speed: 0 in the donor — it is a stationary beam
    // rather than a travelling projectile, so refusing to launch is correct.
    // Pinned here so a future data change makes the exception visible.
    assert.deepEqual(silent, ['mirageEdge'], `unexpected non-firing weapons: ${silent.join(', ')}`);
    assert.equal(fired, 32);
  });

  test('the one non-firing ranged weapon is non-firing because of its data', () => {
    assert.equal(WEAPONS['mirageEdge'].speed, 0);
  });
});

describe('runtime coverage reporting', () => {
  test('ranged kinds now report as implemented', () => {
    assert.equal(isWeaponRuntimeImplemented(WEAPONS['bow']), true);
    assert.equal(isWeaponRuntimeImplemented(WEAPONS['wand']), true);
    assert.equal(isWeaponRuntimeImplemented(WEAPONS['sniperRifle']), true);
  });

  test('non-projectile kinds also report a runtime now', () => {
    // Staff and spirit gained runtimes in Phase 2c, summoner in Phase 2f.
    assert.equal(isWeaponRuntimeImplemented(WEAPONS['apiaryLexicon']), true);
    assert.equal(isWeaponRuntimeImplemented(WEAPONS['emberStaff']), true);
  });
});
