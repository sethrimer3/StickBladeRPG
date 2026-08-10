import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  BASE_MAX_HEALTH,
  BASE_XP_TO_NEXT_LEVEL,
  MAX_CHARACTER_LEVEL,
  MAX_HEALTH_PER_LEVEL,
  SKILL_POINTS_PER_LEVEL,
  XP_REQUIREMENT_GROWTH,
  allocateSkillPoint,
  computeDerivedStats,
  computeSkillMultipliers,
  computeStatDamage,
  createDefaultCharacterStats,
  grantExperience,
  respecSkillPoints,
  sanitizeCharacterStats,
} from '../sim/stats/characterStats';
import { createRng } from '../sim/rng';
import { createDefaultProgress, sanitizePlayerCharacterStats } from '../progression/playerProgress';
import { applyPlayerDamageWithKnockback, type PlayerDamageTarget } from '../sim/playerDamage';

function createDamageTarget(overrides: Partial<PlayerDamageTarget> = {}): PlayerDamageTarget {
  return {
    healthPoints: 10,
    isAliveFlag: 1,
    positionXWorld: 100,
    positionYWorld: 100,
    velocityXWorld: 0,
    velocityYWorld: 0,
    isGroundedFlag: 1,
    invulnerabilityTicks: 0,
    hurtTicks: 0,
    ...overrides,
  };
}

describe('characterStats defaults', () => {
  test('a new character starts at level 1 with the ported base stats', () => {
    const stats = createDefaultCharacterStats();
    assert.equal(stats.level, 1);
    assert.equal(stats.xp, 0);
    assert.equal(stats.xpToNextLevel, BASE_XP_TO_NEXT_LEVEL);
    assert.equal(stats.maxHealthBase, BASE_MAX_HEALTH);
    assert.equal(stats.attackBase, 1);
    assert.equal(stats.defenseBase, 1);
    assert.equal(stats.skillPoints, 0);
    assert.deepEqual(stats.skillAllocations, { health: 0, attack: 0, defense: 0 });
  });

  test('each call returns an independent record', () => {
    const a = createDefaultCharacterStats();
    const b = createDefaultCharacterStats();
    a.skillAllocations.attack = 5;
    assert.equal(b.skillAllocations.attack, 0);
  });
});

describe('derived stats', () => {
  test('skill points add a full multiple per point', () => {
    const multipliers = computeSkillMultipliers({ health: 2, attack: 1, defense: 0 });
    assert.equal(multipliers.maxHealth, 3);
    assert.equal(multipliers.attack, 2);
    assert.equal(multipliers.defense, 1);
  });

  test('unmodified stats resolve to their base values', () => {
    const derived = computeDerivedStats(createDefaultCharacterStats());
    assert.equal(derived.attack, 1);
    assert.equal(derived.defense, 1);
    assert.equal(derived.maxHealth, BASE_MAX_HEALTH);
  });

  test('multipliers apply before flat bonuses', () => {
    const stats = createDefaultCharacterStats();
    stats.attackBase = 4;
    stats.skillAllocations.attack = 1; // ×2
    const derived = computeDerivedStats(stats, { attackMultiplier: 3, attackBonus: 5 });
    // 4 × 2 × 3 + 5
    assert.equal(derived.attack, 29);
  });

  test('a zero multiplier zeroes the scaled term without corrupting the base', () => {
    const stats = createDefaultCharacterStats();
    stats.defenseBase = 10;
    assert.equal(computeDerivedStats(stats, { defenseMultiplier: 0 }).defense, 0);
    // Recomputing without the multiplier recovers the full value; the donor's
    // divide-to-recover-base approach could not do this.
    assert.equal(computeDerivedStats(stats).defense, 10);
  });

  test('derived stats never go negative', () => {
    const stats = createDefaultCharacterStats();
    const derived = computeDerivedStats(stats, { attackBonus: -100 });
    assert.equal(derived.attack, 0);
  });
});

describe('computeStatDamage', () => {
  test('scales base damage by attack and mitigates by a defense roll', () => {
    const rng = createRng(1234);
    const damage = computeStatDamage(10, 2, 4, rng);
    // 10 × 2 = 20, minus a roll in [0, 4)
    assert.ok(damage > 16 && damage <= 20, `expected (16, 20], got ${damage}`);
  });

  test('is deterministic for a given seed', () => {
    const a = computeStatDamage(10, 2, 4, createRng(99));
    const b = computeStatDamage(10, 2, 4, createRng(99));
    assert.equal(a, b);
  });

  test('does not advance the rng when defense is zero', () => {
    const rngA = createRng(7);
    computeStatDamage(10, 1, 0, rngA);
    const rngB = createRng(7);
    assert.deepEqual(rngA, rngB);
  });

  test('zero attack or zero base deals no damage', () => {
    assert.equal(computeStatDamage(10, 0, 1, createRng(1)), 0);
    assert.equal(computeStatDamage(0, 10, 1, createRng(1)), 0);
  });

  test('overwhelming defense clamps to zero rather than healing', () => {
    for (let seed = 0; seed < 25; seed++) {
      assert.ok(computeStatDamage(1, 1, 1000, createRng(seed)) >= 0);
    }
  });
});

describe('experience and leveling', () => {
  test('experience below the requirement does not level', () => {
    const stats = createDefaultCharacterStats();
    const result = grantExperience(stats, BASE_XP_TO_NEXT_LEVEL - 1);
    assert.equal(result.levelsGained, 0);
    assert.equal(stats.level, 1);
    assert.equal(stats.xp, BASE_XP_TO_NEXT_LEVEL - 1);
  });

  test('reaching the requirement levels up and applies the ported gains', () => {
    const stats = createDefaultCharacterStats();
    const result = grantExperience(stats, BASE_XP_TO_NEXT_LEVEL);

    assert.equal(result.levelsGained, 1);
    assert.equal(stats.level, 2);
    assert.equal(stats.xp, 0);
    assert.equal(stats.maxHealthBase, BASE_MAX_HEALTH + MAX_HEALTH_PER_LEVEL);
    assert.equal(stats.skillPoints, SKILL_POINTS_PER_LEVEL);
    assert.equal(
      stats.xpToNextLevel,
      Math.floor(BASE_XP_TO_NEXT_LEVEL * XP_REQUIREMENT_GROWTH),
    );
  });

  test('surplus experience carries into the next level', () => {
    const stats = createDefaultCharacterStats();
    grantExperience(stats, BASE_XP_TO_NEXT_LEVEL + 7);
    assert.equal(stats.level, 2);
    assert.equal(stats.xp, 7);
  });

  test('a single large grant can cross several levels', () => {
    const stats = createDefaultCharacterStats();
    const result = grantExperience(stats, 10_000);
    assert.ok(result.levelsGained >= 3, `expected 3+ levels, got ${result.levelsGained}`);
    assert.equal(stats.level, 1 + result.levelsGained);
    assert.equal(stats.skillPoints, result.levelsGained * SKILL_POINTS_PER_LEVEL);
    assert.equal(
      stats.maxHealthBase,
      BASE_MAX_HEALTH + result.levelsGained * MAX_HEALTH_PER_LEVEL,
    );
  });

  test('zero and negative grants are no-ops', () => {
    const stats = createDefaultCharacterStats();
    assert.equal(grantExperience(stats, 0).levelsGained, 0);
    assert.equal(grantExperience(stats, -50).levelsGained, 0);
    assert.equal(stats.xp, 0);
  });

  test('a maxed character terminates instead of spinning', () => {
    const stats = createDefaultCharacterStats();
    stats.level = MAX_CHARACTER_LEVEL;
    const result = grantExperience(stats, Number.MAX_SAFE_INTEGER);
    assert.equal(result.levelsGained, 0);
    assert.equal(stats.level, MAX_CHARACTER_LEVEL);
    assert.equal(stats.xp, 0);
  });

  test('grantExperience does not touch current health', () => {
    // Health lives on the cluster, not the stat record — the caller decides
    // whether a level-up heals.
    const stats = createDefaultCharacterStats();
    grantExperience(stats, BASE_XP_TO_NEXT_LEVEL);
    assert.equal(Object.prototype.hasOwnProperty.call(stats, 'hp'), false);
  });
});

describe('skill points', () => {
  test('allocating spends a point and raises the track', () => {
    const stats = createDefaultCharacterStats();
    stats.skillPoints = 2;
    assert.equal(allocateSkillPoint(stats, 'attack'), true);
    assert.equal(stats.skillPoints, 1);
    assert.equal(stats.skillAllocations.attack, 1);
  });

  test('allocating with no points available is a no-op', () => {
    const stats = createDefaultCharacterStats();
    assert.equal(allocateSkillPoint(stats, 'defense'), false);
    assert.equal(stats.skillAllocations.defense, 0);
    assert.equal(stats.skillPoints, 0);
  });

  test('respec refunds every spent point', () => {
    const stats = createDefaultCharacterStats();
    stats.skillPoints = 3;
    allocateSkillPoint(stats, 'health');
    allocateSkillPoint(stats, 'attack');
    assert.equal(respecSkillPoints(stats), 2);
    assert.equal(stats.skillPoints, 3);
    assert.deepEqual(stats.skillAllocations, { health: 0, attack: 0, defense: 0 });
  });
});

describe('sanitizeCharacterStats', () => {
  test('non-object input yields defaults', () => {
    assert.deepEqual(sanitizeCharacterStats(null), createDefaultCharacterStats());
    assert.deepEqual(sanitizeCharacterStats(undefined), createDefaultCharacterStats());
    assert.deepEqual(sanitizeCharacterStats('nope'), createDefaultCharacterStats());
  });

  test('out-of-range values are clamped', () => {
    const repaired = sanitizeCharacterStats({
      level: -5,
      xp: -100,
      xpToNextLevel: 0,
      attackBase: -3,
      defenseBase: Number.NaN,
      maxHealthBase: 0,
      skillPoints: -2,
      skillAllocations: { health: -1, attack: 2.7, defense: Number.POSITIVE_INFINITY },
    });

    assert.equal(repaired.level, 1);
    assert.equal(repaired.xp, 0);
    assert.ok(repaired.xpToNextLevel >= 1);
    assert.equal(repaired.attackBase, 0);
    assert.equal(repaired.defenseBase, 1);
    assert.ok(repaired.maxHealthBase >= 1);
    assert.equal(repaired.skillPoints, 0);
    assert.equal(repaired.skillAllocations.health, 0);
    assert.equal(repaired.skillAllocations.attack, 2);
    assert.equal(repaired.skillAllocations.defense, 0);
  });

  test('valid records survive unchanged and the input is not mutated', () => {
    const input = {
      level: 4,
      xp: 12,
      xpToNextLevel: 122,
      attackBase: 3,
      defenseBase: 2,
      maxHealthBase: 86,
      skillPoints: 2,
      skillAllocations: { health: 1, attack: 1, defense: 0 },
    };
    const repaired = sanitizeCharacterStats(input);
    assert.deepEqual(repaired, input);
    repaired.skillAllocations.health = 99;
    assert.equal(input.skillAllocations.health, 1);
  });

  test('is idempotent', () => {
    const once = sanitizeCharacterStats({ level: 3.9, xp: 5.5 });
    assert.deepEqual(sanitizeCharacterStats(once), once);
  });

  test('a level above the cap is clamped and its xp pinned', () => {
    const repaired = sanitizeCharacterStats({ level: MAX_CHARACTER_LEVEL + 40, xp: 500 });
    assert.equal(repaired.level, MAX_CHARACTER_LEVEL);
    assert.equal(repaired.xp, 0);
  });
});

describe('PlayerProgress integration', () => {
  test('new progress carries level-1 character stats', () => {
    const progress = createDefaultProgress();
    assert.deepEqual(progress.characterStats, createDefaultCharacterStats());
  });

  test('character level is independent of the dust-slot level', () => {
    const progress = createDefaultProgress();
    progress.level = 4; // dust-slot level
    sanitizePlayerCharacterStats(progress);
    assert.equal(progress.characterStats?.level, 1);
  });

  test('a save missing characterStats is backfilled', () => {
    const progress = createDefaultProgress();
    delete progress.characterStats;
    sanitizePlayerCharacterStats(progress);
    assert.deepEqual(progress.characterStats, createDefaultCharacterStats());
  });

  test('a save with corrupt characterStats is repaired', () => {
    const progress = createDefaultProgress();
    (progress as { characterStats: unknown }).characterStats = { level: 'seven' };
    sanitizePlayerCharacterStats(progress);
    assert.equal(progress.characterStats?.level, 1);
  });
});

describe('playerDamage stat integration', () => {
  test('damage is unchanged when no stats are present (pre-port behavior)', () => {
    const player = createDamageTarget();
    const applied = applyPlayerDamageWithKnockback(player, 3, 50, 100);
    assert.equal(applied, true);
    assert.equal(player.healthPoints, 7);
  });

  test('statsDefense alone does not change damage without an rng', () => {
    const player = createDamageTarget({ statsDefense: 100 });
    applyPlayerDamageWithKnockback(player, 3, 50, 100);
    assert.equal(player.healthPoints, 7);
  });

  test('an rng alone does not change damage without statsDefense', () => {
    const player = createDamageTarget();
    applyPlayerDamageWithKnockback(player, 3, 50, 100, { statsRng: createRng(5) });
    assert.equal(player.healthPoints, 7);
  });

  test('defense mitigates damage when both are supplied', () => {
    const player = createDamageTarget({ healthPoints: 40, statsDefense: 4 });
    applyPlayerDamageWithKnockback(player, 10, 50, 100, { statsRng: createRng(2024) });
    const dealt = 40 - player.healthPoints;
    // 10 × 1 attack, minus a roll in [0, 4), rounded up.
    assert.ok(dealt >= 7 && dealt <= 10, `expected 7..10 damage, got ${dealt}`);
  });

  test('a fully absorbed hit deals nothing and grants no invulnerability', () => {
    const player = createDamageTarget({ statsDefense: 100_000 });
    const applied = applyPlayerDamageWithKnockback(player, 1, 50, 100, {
      statsRng: createRng(11),
    });
    assert.equal(applied, false);
    assert.equal(player.healthPoints, 10);
    assert.equal(player.invulnerabilityTicks, 0);
    assert.equal(player.hurtTicks, 0);
  });

  test('attacker attack scales the incoming hit', () => {
    const player = createDamageTarget({ healthPoints: 60, statsDefense: 1 });
    applyPlayerDamageWithKnockback(player, 5, 50, 100, {
      statsRng: createRng(77),
      attackerAttack: 4,
    });
    const dealt = 60 - player.healthPoints;
    // 5 × 4 = 20, minus a roll in [0, 1).
    assert.ok(dealt >= 19 && dealt <= 20, `expected 19..20 damage, got ${dealt}`);
  });

  test('stat-scaled damage is deterministic for a given seed', () => {
    const first = createDamageTarget({ healthPoints: 40, statsDefense: 6 });
    applyPlayerDamageWithKnockback(first, 12, 50, 100, { statsRng: createRng(451) });
    const second = createDamageTarget({ healthPoints: 40, statsDefense: 6 });
    applyPlayerDamageWithKnockback(second, 12, 50, 100, { statsRng: createRng(451) });
    assert.equal(first.healthPoints, second.healthPoints);
  });
});
