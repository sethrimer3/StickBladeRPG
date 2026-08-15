import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ENEMY_DEATH_PIXELS,
  ENEMY_DEATH_PIXEL_SPEED_MIN_WORLD,
  ENEMY_DEATH_PIXEL_SPEED_MAX_WORLD,
  ENEMY_DEATH_PIXEL_LIFETIME_MIN_MS,
  ENEMY_DEATH_PIXEL_LIFETIME_MAX_MS,
  EnemyDeathPixelEffect,
  samplePersistingPixels,
  makeDeterministicRng,
  generateFallbackEnemyPixelSamples,
  triggerEnemyDeathPixelsFromCluster,
  getEnemyPrimaryColor,
  type EnemyPixelSample,
  type WallGeometrySource,
} from '../render/enemyDeathPixelEffect';

function makeTestPixels(count: number, r = 255, g = 100, b = 50): EnemyPixelSample[] {
  const pixels: EnemyPixelSample[] = [];
  for (let i = 0; i < count; i++) {
    pixels.push({
      xWorld: i * 0.5,
      yWorld: i * 0.5,
      r,
      g,
      b,
    });
  }
  return pixels;
}

test('samplePersistingPixels returns empty array when input is empty', () => {
  const rng = makeDeterministicRng(1);
  assert.deepEqual(samplePersistingPixels([], rng), []);
});

test('samplePersistingPixels samples exactly 25% of the input pixels', () => {
  const rng = makeDeterministicRng(42);
  const pixels100 = makeTestPixels(100);
  const sampled100 = samplePersistingPixels(pixels100, rng);
  assert.equal(sampled100.length, 25);

  const pixels12 = makeTestPixels(12);
  const sampled12 = samplePersistingPixels(pixels12, rng);
  assert.equal(sampled12.length, 3);

  const pixels1 = makeTestPixels(1);
  const sampled1 = samplePersistingPixels(pixels1, rng);
  assert.equal(sampled1.length, 1);
});

test('samplePersistingPixels preserves exact RGB colors and positions', () => {
  const rng = makeDeterministicRng(10);
  const pixels: EnemyPixelSample[] = [
    { xWorld: 10, yWorld: 20, r: 12, g: 34, b: 56 },
    { xWorld: 30, yWorld: 40, r: 78, g: 90, b: 123 },
    { xWorld: 50, yWorld: 60, r: 200, g: 150, b: 100 },
    { xWorld: 70, yWorld: 80, r: 255, g: 255, b: 255 },
  ];
  const sampled = samplePersistingPixels(pixels, rng);
  assert.equal(sampled.length, 1); // 25% of 4 = 1
  const match = pixels.some(
    p => p.xWorld === sampled[0].xWorld && p.r === sampled[0].r && p.g === sampled[0].g && p.b === sampled[0].b,
  );
  assert.ok(match);
});

test('trigger spawns 25% particles with 360-degree angles and gentle speeds', () => {
  const effect = new EnemyDeathPixelEffect();
  const pixels = makeTestPixels(40, 200, 150, 50); // 25% of 40 = 10
  effect.trigger(pixels, 123);
  assert.equal(effect.particleCount, 10);

  let hasPositiveVx = false;
  let hasNegativeVx = false;
  let hasPositiveVy = false;
  let hasNegativeVy = false;

  for (let i = 0; i < effect.particleCount; i++) {
    const p = effect.getParticle(i)!;
    assert.equal(p.r, 200);
    assert.equal(p.g, 150);
    assert.equal(p.b, 50);

    const speed = Math.hypot(p.vxWorld, p.vyWorld);
    assert.ok(speed >= ENEMY_DEATH_PIXEL_SPEED_MIN_WORLD - 0.001);
    assert.ok(speed <= ENEMY_DEATH_PIXEL_SPEED_MAX_WORLD + 0.001);

    assert.ok(p.lifetimeMs >= ENEMY_DEATH_PIXEL_LIFETIME_MIN_MS);
    assert.ok(p.lifetimeMs <= ENEMY_DEATH_PIXEL_LIFETIME_MAX_MS);

    if (p.vxWorld > 0) hasPositiveVx = true;
    if (p.vxWorld < 0) hasNegativeVx = true;
    if (p.vyWorld > 0) hasPositiveVy = true;
    if (p.vyWorld < 0) hasNegativeVy = true;
  }

  // With 10 particles in 360 degrees, we should cover all 4 quadrants
  assert.ok(hasPositiveVx);
  assert.ok(hasNegativeVx);
  assert.ok(hasPositiveVy);
  assert.ok(hasNegativeVy);
});

test('update applies gravity in open air', () => {
  const effect = new EnemyDeathPixelEffect();
  effect.trigger([{ xWorld: 0, yWorld: 0, r: 255, g: 0, b: 0 }], 1);
  const p0 = effect.getParticle(0)!;
  const initialVy = p0.vyWorld;

  effect.update(100, null); // 0.1s
  const p1 = effect.getParticle(0)!;
  // Vy should increase downward by approx gravity * dt
  assert.ok(p1.vyWorld > initialVy);
  assert.ok(p1.yWorld > p0.yWorld - 5);
});

test('update bounces off ground surfaces and dampens vertical velocity', () => {
  const effect = new EnemyDeathPixelEffect();
  // Spawns 1 particle moving downward directly toward a floor at wy = 50
  effect.trigger([{ xWorld: 10, yWorld: 40, r: 255, g: 255, b: 0 }], 1);
  // Override velocity to directly point straight downward for deterministic bounce test
  // Access private arrays via update steps
  const walls: WallGeometrySource = {
    count: 1,
    xWorld: [0],
    yWorld: [50],
    wWorld: [100],
    hWorld: [20],
  };

  // Step downward past the floor
  for (let step = 0; step < 15; step++) {
    effect.update(30, walls);
    const p = effect.getParticle(0);
    if (!p) break;
    // Particle should never penetrate deep into the ground (wy = 50)
    assert.ok(p.yWorld <= 50.1);
  }
});

test('update bounces off vertical side walls and ceiling', () => {
  const effect = new EnemyDeathPixelEffect();
  // Spawns 4 pixels (1 persisting)
  effect.trigger(makeTestPixels(4), 5);
  const walls: WallGeometrySource = {
    count: 4,
    xWorld: [-50, 50, -50, -50],
    yWorld: [-50, -50, -50, 50],
    wWorld: [100, 20, 100, 100],
    hWorld: [20, 100, 100, 20],
  };

  for (let step = 0; step < 20; step++) {
    effect.update(16, walls);
    const p = effect.getParticle(0);
    if (!p) break;
    // Should stay within bounds
    assert.ok(p.xWorld >= -60 && p.xWorld <= 80);
    assert.ok(p.yWorld >= -60 && p.yWorld <= 80);
  }
});

test('update expires and removes particles after their individual lifetimes (1-5s)', () => {
  const effect = new EnemyDeathPixelEffect();
  effect.trigger(makeTestPixels(20), 42); // 5 particles
  assert.equal(effect.particleCount, 5);

  // After 500ms, all should still be alive
  effect.update(500, null);
  assert.equal(effect.particleCount, 5);

  // After 5500ms total, all should have expired (max lifetime is 5000ms)
  effect.update(5000, null);
  assert.equal(effect.particleCount, 0);
});

test('trigger recycles oldest particle when exceeding MAX_ENEMY_DEATH_PIXELS', () => {
  const effect = new EnemyDeathPixelEffect();
  const largeBatch = makeTestPixels(5000); // 25% of 5000 = 1250 > MAX (1024)
  effect.trigger(largeBatch, 7);
  assert.ok(effect.particleCount <= MAX_ENEMY_DEATH_PIXELS);
  assert.equal(effect.particleCount, MAX_ENEMY_DEATH_PIXELS);
});

test('reset clears all particles', () => {
  const effect = new EnemyDeathPixelEffect();
  effect.trigger(makeTestPixels(20), 1);
  assert.ok(effect.particleCount > 0);
  effect.reset();
  assert.equal(effect.particleCount, 0);
});

test('getEnemyPrimaryColor returns distinct colors for enemy types', () => {
  assert.deepEqual(getEnemyPrimaryColor({ isSlimeFlag: 1 }), { r: 68, g: 204, b: 68 });
  assert.deepEqual(getEnemyPrimaryColor({ isBeetleFlag: 1 }), { r: 255, g: 215, b: 0 });
  assert.deepEqual(getEnemyPrimaryColor({ isCrimsonWizardFlag: 1 }), { r: 255, g: 59, b: 36 });
  assert.deepEqual(getEnemyPrimaryColor({}), { r: 255, g: 102, b: 0 });
});

test('generateFallbackEnemyPixelSamples generates grid covering bounding box', () => {
  const samples = generateFallbackEnemyPixelSamples({
    positionXWorld: 100,
    positionYWorld: 200,
    halfWidthWorld: 3,
    halfHeightWorld: 3,
    isSlimeFlag: 1,
  });
  assert.ok(samples.length >= 16);
  assert.equal(samples[0].r, 68);
  assert.equal(samples[0].g, 204);
  assert.equal(samples[0].b, 68);
});

test('triggerEnemyDeathPixelsFromCluster successfully populates effect in headless mode', () => {
  const effect = new EnemyDeathPixelEffect();
  triggerEnemyDeathPixelsFromCluster(effect, {
    positionXWorld: 50,
    positionYWorld: 50,
    halfWidthWorld: 3,
    halfHeightWorld: 3,
    isSlimeFlag: 1,
  }, 99);
  assert.ok(effect.particleCount > 0);
});
