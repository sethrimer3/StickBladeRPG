import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createDefaultProgress,
  createOfficialNewProfileProgress,
  sanitizePlayerAbilities,
  type PlayerProgress,
} from '../progression/playerProgress';
import { hasAbility, unlockAbility } from '../progression/unlocks';

describe('Player Ability Progression & Unlocks', () => {
  test('default new progress includes doubleJump, grapple, and swim unlocked by default', () => {
    const progress = createDefaultProgress('knight');
    assert.deepEqual(progress.unlockedAbilities, ['doubleJump', 'grapple', 'swim']);
    assert.equal(hasAbility(progress, 'doubleJump'), true);
    assert.equal(hasAbility(progress, 'grapple'), true);
    assert.equal(hasAbility(progress, 'swim'), true);
  });

  test('official new profile progress includes doubleJump, grapple, and swim', () => {
    const progress = createOfficialNewProfileProgress();
    assert.deepEqual(progress.unlockedAbilities, ['doubleJump', 'grapple', 'swim']);
    assert.equal(hasAbility(progress, 'doubleJump'), true);
    assert.equal(hasAbility(progress, 'grapple'), true);
    assert.equal(hasAbility(progress, 'swim'), true);
  });

  test('unlockAbility idempotently unlocks abilities', () => {
    const progress = createDefaultProgress('knight');
    progress.unlockedAbilities = [];

    assert.equal(hasAbility(progress, 'doubleJump'), false);
    assert.equal(unlockAbility(progress, 'doubleJump'), true);
    assert.equal(hasAbility(progress, 'doubleJump'), true);

    // Duplicate unlock returns false
    assert.equal(unlockAbility(progress, 'doubleJump'), false);
    assert.deepEqual(progress.unlockedAbilities, ['doubleJump']);

    // Grapple unlock
    assert.equal(hasAbility(progress, 'grapple'), false);
    assert.equal(unlockAbility(progress, 'grapple'), true);
    assert.equal(hasAbility(progress, 'grapple'), true);
    assert.deepEqual(progress.unlockedAbilities, ['doubleJump', 'grapple']);
  });

  test('sanitizePlayerAbilities repairs missing or invalid ability entries', () => {
    const progress = createDefaultProgress('knight') as unknown as { unlockedAbilities: unknown };
    // Simulate legacy save missing unlockedAbilities field
    delete progress.unlockedAbilities;

    sanitizePlayerAbilities(progress as unknown as PlayerProgress);
    assert.ok(Array.isArray((progress as unknown as PlayerProgress).unlockedAbilities));
    assert.ok(hasAbility(progress as unknown as PlayerProgress, 'doubleJump'));
    assert.ok(hasAbility(progress as unknown as PlayerProgress, 'grapple'));
    assert.ok(hasAbility(progress as unknown as PlayerProgress, 'swim'));
  });

  test('sanitizePlayerAbilities removes duplicates and invalid items', () => {
    const progress = createDefaultProgress('knight');
    progress.unlockedAbilities = ['doubleJump', 'doubleJump', 'invalidAbility' as unknown as 'doubleJump', 'grapple', 'swim'];

    sanitizePlayerAbilities(progress);
    assert.deepEqual(progress.unlockedAbilities, ['doubleJump', 'grapple', 'swim']);
  });
});
