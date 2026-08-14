/**
 * The tapered tip trail: geometry, coordinate space, taper, and quality tiers.
 *
 * The coordinate-space cases matter most. Storing screen positions instead of
 * world ones would detach the ribbon from its blade the moment the camera
 * moved — the same class of bug this renderer's own transform shipped with.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { BladeTrail, DEFAULT_TRAIL_STYLE, type TrailStyle } from '../render/effects/bladeTrail';

interface DrawCall { op: string; args: number[] }

/** Records the geometry and per-segment stroke settings the trail emits. */
function createRecordingContext(): { ctx: CanvasRenderingContext2D; calls: DrawCall[] } {
  const calls: DrawCall[] = [];
  const state = { globalAlpha: 1, lineWidth: 1 };
  const record = (op: string) => (...args: number[]): void => {
    // Snapshot the stroke settings at stroke time — they are mutated per segment.
    if (op === 'stroke') calls.push({ op, args: [state.globalAlpha, state.lineWidth] });
    else calls.push({ op, args });
  };
  const ctx = {
    save: record('save'),
    restore: record('restore'),
    beginPath: record('beginPath'),
    moveTo: record('moveTo'),
    quadraticCurveTo: record('quadraticCurveTo'),
    stroke: record('stroke'),
    set globalAlpha(v: number) { state.globalAlpha = v; },
    get globalAlpha(): number { return state.globalAlpha; },
    set lineWidth(v: number) { state.lineWidth = v; },
    get lineWidth(): number { return state.lineWidth; },
    lineCap: 'butt',
    lineJoin: 'miter',
    strokeStyle: '',
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

const STYLE: TrailStyle = { ...DEFAULT_TRAIL_STYLE, color: '#ff0000' };

/** Pushes a straight run of samples spaced far enough apart to all be kept. */
function fill(trail: BladeTrail, count: number, x0 = 0, y0 = 0, step = 5): void {
  for (let i = 0; i < count; i++) trail.push(x0 + i * step, y0);
}

describe('trail sampling', () => {
  test('a fresh trail draws nothing', () => {
    const trail = new BladeTrail();
    assert.equal(trail.isVisible, false);
    const { ctx, calls } = createRecordingContext();
    trail.render(ctx, 0, 0, 1, STYLE, 'high');
    assert.equal(calls.length, 0);
  });

  test('one sample is not yet a ribbon', () => {
    const trail = new BladeTrail();
    trail.push(10, 10);
    assert.equal(trail.isVisible, false);
  });

  test('two samples make a ribbon', () => {
    const trail = new BladeTrail();
    fill(trail, 2);
    assert.equal(trail.isVisible, true);
  });

  test('a barely-moved head adds no geometry but still tracks the blade', () => {
    const trail = new BladeTrail();
    fill(trail, 2);
    const before = createRecordingContext();
    trail.render(before.ctx, 0, 0, 1, STYLE, 'low');
    const segmentsBefore = before.calls.filter(c => c.op === 'stroke').length;

    // Twenty sub-threshold nudges: a slow blade must not fill the history.
    for (let i = 0; i < 20; i++) trail.push(5 + i * 0.01, 0);

    const after = createRecordingContext();
    trail.render(after.ctx, 0, 0, 1, STYLE, 'low');
    assert.equal(after.calls.filter(c => c.op === 'stroke').length, segmentsBefore);
  });

  test('history is capped no matter how long the swing runs', () => {
    const trail = new BladeTrail();
    fill(trail, 500);
    const { ctx, calls } = createRecordingContext();
    trail.render(ctx, 0, 0, 1, STYLE, 'high');
    // High tier keeps 8 samples, so at most 7 segments.
    assert.ok(calls.filter(c => c.op === 'stroke').length <= 7 * 3, 'segments x layers');
  });

  test('a teleport breaks the trail instead of striping the level', () => {
    const trail = new BladeTrail();
    fill(trail, 6);
    assert.equal(trail.isVisible, true);
    trail.push(9000, 9000);
    assert.equal(trail.isVisible, false, 'the jump should have cleared the history');
  });

  test('decay shortens the ribbon and eventually empties it', () => {
    const trail = new BladeTrail();
    fill(trail, 4);
    trail.decay();
    assert.equal(trail.isVisible, true);
    trail.decay();
    trail.decay();
    assert.equal(trail.isVisible, false);
    trail.decay(); // must not underflow
    assert.equal(trail.isVisible, false);
  });

  test('clear drops everything', () => {
    const trail = new BladeTrail();
    fill(trail, 6);
    trail.clear();
    assert.equal(trail.isVisible, false);
  });
});

describe('coordinate space', () => {
  /** First moveTo of a render — the head end of the ribbon. */
  function head(calls: DrawCall[]): [number, number] {
    const call = calls.find(c => c.op === 'moveTo');
    assert.ok(call !== undefined);
    return [call.args[0], call.args[1]];
  }

  function renderAt(ox: number, oy: number, zoom: number): [number, number] {
    const trail = new BladeTrail();
    fill(trail, 4, 100, 50);
    const { ctx, calls } = createRecordingContext();
    trail.render(ctx, ox, oy, zoom, STYLE, 'high');
    return head(calls);
  }

  test('a camera offset shifts the ribbon by exactly that many pixels', () => {
    const [baseX, baseY] = renderAt(0, 0, 1);
    const [shiftedX, shiftedY] = renderAt(70, -40, 1);
    assert.equal(shiftedX - baseX, 70);
    assert.equal(shiftedY - baseY, -40);
  });

  test('zoom scales the world position, not the pixel offset', () => {
    const [baseX] = renderAt(0, 0, 1);
    const [zoomedX] = renderAt(0, 0, 4);
    assert.equal(zoomedX, baseX * 4);

    const [a] = renderAt(0, 0, 4);
    const [b] = renderAt(25, 0, 4);
    assert.equal(b - a, 25, 'the offset must not be multiplied by zoom');
  });

  test('ribbon width scales with zoom, like the blade it follows', () => {
    const widthAt = (zoom: number): number => {
      const trail = new BladeTrail();
      fill(trail, 4);
      const { ctx, calls } = createRecordingContext();
      trail.render(ctx, 0, 0, zoom, STYLE, 'low');
      return calls.find(c => c.op === 'stroke')!.args[1];
    };
    assert.ok(Math.abs(widthAt(2) - widthAt(1) * 2) < 1e-9);
  });
});

describe('taper and glow', () => {
  /** Stroke calls for a single-layer render, head segment first. */
  function segments(quality: 'low' | 'med' | 'high'): DrawCall[] {
    const trail = new BladeTrail();
    fill(trail, 8);
    const { ctx, calls } = createRecordingContext();
    trail.render(ctx, 0, 0, 1, STYLE, quality);
    return calls.filter(c => c.op === 'stroke');
  }

  test('width and opacity both fall off toward the tail', () => {
    const strokes = segments('low');
    assert.ok(strokes.length >= 3);
    for (let i = 1; i < strokes.length; i++) {
      assert.ok(strokes[i].args[0] < strokes[i - 1].args[0], `alpha should fall at segment ${i}`);
      assert.ok(strokes[i].args[1] < strokes[i - 1].args[1], `width should narrow at segment ${i}`);
    }
  });

  test('the head is the brightest and widest part', () => {
    const strokes = segments('low');
    const head = strokes[0];
    const tail = strokes[strokes.length - 1];
    assert.ok(head.args[0] > tail.args[0]);
    assert.ok(head.args[1] > tail.args[1]);
  });

  test('every layer stays translucent — this is a ribbon, not a laser', () => {
    for (const stroke of segments('high')) {
      assert.ok(stroke.args[0] < 1, `alpha ${stroke.args[0]} should be translucent`);
    }
  });

  test('quality picks the layer count and sample budget', () => {
    const low = segments('low').length;
    const med = segments('med').length;
    const high = segments('high').length;
    assert.ok(low < med, `low ${low} should draw less than med ${med}`);
    assert.ok(med < high, `med ${med} should draw less than high ${high}`);
  });

  test('the ribbon is smoothed, not a chain of straight segments', () => {
    const trail = new BladeTrail();
    fill(trail, 6);
    const { ctx, calls } = createRecordingContext();
    trail.render(ctx, 0, 0, 1, STYLE, 'high');
    assert.ok(calls.some(c => c.op === 'quadraticCurveTo'));
  });

  test('save and restore stay balanced', () => {
    const trail = new BladeTrail();
    fill(trail, 6);
    const { ctx, calls } = createRecordingContext();
    trail.render(ctx, 0, 0, 1, STYLE, 'high');
    assert.equal(
      calls.filter(c => c.op === 'save').length,
      calls.filter(c => c.op === 'restore').length,
    );
  });
});
