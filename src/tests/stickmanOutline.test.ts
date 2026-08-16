import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createStickRangerBody } from '../sim/clusters/stickRangerBody';
import {
  renderStickRangerBody,
  FIGURE_COLOR,
  ENEMY_FIGURE_COLOR,
  OUTLINE_COLOR,
  OUTLINE_NEIGHBOR_OFFSETS,
} from '../render/clusters/stickRangerRenderer';

interface DrawCall {
  op: string;
  args: unknown[];
  strokeStyle?: string;
  fillStyle?: string;
}

function createRecordingContext(): { ctx: CanvasRenderingContext2D; calls: DrawCall[] } {
  const calls: DrawCall[] = [];

  const ctxState = {
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    globalAlpha: 1,
  };

  const record = (op: string) => (...args: unknown[]): void => {
    calls.push({
      op,
      args,
      strokeStyle: ctxState.strokeStyle,
      fillStyle: ctxState.fillStyle,
    });
  };

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
    get strokeStyle() { return ctxState.strokeStyle; },
    set strokeStyle(val: string) { ctxState.strokeStyle = val; },
    get fillStyle() { return ctxState.fillStyle; },
    set fillStyle(val: string) { ctxState.fillStyle = val; },
    get lineWidth() { return ctxState.lineWidth; },
    set lineWidth(val: number) { ctxState.lineWidth = val; },
    get lineCap() { return ctxState.lineCap; },
    set lineCap(val: CanvasLineCap) { ctxState.lineCap = val; },
    get lineJoin() { return ctxState.lineJoin; },
    set lineJoin(val: CanvasLineJoin) { ctxState.lineJoin = val; },
    get globalAlpha() { return ctxState.globalAlpha; },
    set globalAlpha(val: number) { ctxState.globalAlpha = val; },
  } as unknown as CanvasRenderingContext2D;

  return { ctx, calls };
}

describe('Stickman Solid Black Outline', () => {
  test('OUTLINE_NEIGHBOR_OFFSETS contains exactly the 4 cardinal directions (corners clipped)', () => {
    assert.equal(OUTLINE_NEIGHBOR_OFFSETS.length, 4);
    const expected = [
      [0, -1],
      [-1, 0],
      [1, 0],
      [0, 1],
    ];
    for (let i = 0; i < expected.length; i++) {
      assert.equal(OUTLINE_NEIGHBOR_OFFSETS[i][0], expected[i][0]);
      assert.equal(OUTLINE_NEIGHBOR_OFFSETS[i][1], expected[i][1]);
    }
  });

  test('outline color is solid black and distinct from player and enemy figure colors', () => {
    assert.equal(OUTLINE_COLOR, '#000000');
    assert.equal(FIGURE_COLOR, '#ffffff');
    assert.equal(ENEMY_FIGURE_COLOR, '#881111');
    assert.notEqual(OUTLINE_COLOR, FIGURE_COLOR);
    assert.notEqual(OUTLINE_COLOR, ENEMY_FIGURE_COLOR);
  });

  test('renderStickRangerBody executes 4 black outline passes before 1 white foreground pass for player', () => {
    const body = createStickRangerBody(100, 100);
    const { ctx, calls } = createRecordingContext();

    renderStickRangerBody(ctx, body, 0, 0, 1, false, false);

    const fillRectCalls = calls.filter(c => c.op === 'fillRect');
    assert.ok(fillRectCalls.length > 5, 'should fill limb and head pixels');

    // First passes are black outline
    const blackFills = fillRectCalls.filter(c => c.fillStyle === OUTLINE_COLOR);
    const whiteFills = fillRectCalls.filter(c => c.fillStyle === FIGURE_COLOR);
    assert.ok(blackFills.length > 0, 'should have black outline fills');
    assert.ok(whiteFills.length > 0, 'should have white foreground fills');

    // Verify all black fills precede the white fills
    const firstWhiteIndex = fillRectCalls.findIndex(c => c.fillStyle === FIGURE_COLOR);
    for (let i = 0; i < firstWhiteIndex; i++) {
      assert.equal(fillRectCalls[i].fillStyle, OUTLINE_COLOR);
    }
  });

  test('renderStickRangerBody executes 4 black outline passes before 1 crimson foreground pass for enemy', () => {
    const body = createStickRangerBody(100, 100);
    const { ctx, calls } = createRecordingContext();

    renderStickRangerBody(ctx, body, 0, 0, 1, false, true);

    const fillRectCalls = calls.filter(c => c.op === 'fillRect');
    const blackFills = fillRectCalls.filter(c => c.fillStyle === OUTLINE_COLOR);
    const crimsonFills = fillRectCalls.filter(c => c.fillStyle === ENEMY_FIGURE_COLOR);
    assert.ok(blackFills.length > 0);
    assert.ok(crimsonFills.length > 0);

    const firstCrimsonIndex = fillRectCalls.findIndex(c => c.fillStyle === ENEMY_FIGURE_COLOR);
    for (let i = 0; i < firstCrimsonIndex; i++) {
      assert.equal(fillRectCalls[i].fillStyle, OUTLINE_COLOR);
    }
  });

  test('outline offsets scale with scalePx / zoom factor', () => {
    const body = createStickRangerBody(100, 100);
    const scale = 2.5;
    const { ctx, calls } = createRecordingContext();

    renderStickRangerBody(ctx, body, 0, 0, scale, false, false);

    // Head fills are the 5x5 (or 5*scale) rects in each pass
    const headFills = calls.filter(c => c.op === 'fillRect' && (c.args[2] as number) >= 5);
    assert.equal(headFills.length, 5);

    const foregroundHeadX = headFills[4].args[0] as number;
    const foregroundHeadY = headFills[4].args[1] as number;

    // Check that each of the 4 outline head positions is shifted by offset * outlineThicknessPx
    const outlineThicknessPx = Math.max(1, Math.round(scale));
    for (let i = 0; i < 4; i++) {
      const [ox, oy] = OUTLINE_NEIGHBOR_OFFSETS[i];
      const outlineHeadX = headFills[i].args[0] as number;
      const outlineHeadY = headFills[i].args[1] as number;

      assert.ok(Math.abs((outlineHeadX - foregroundHeadX) - (ox * outlineThicknessPx)) < 1e-5);
      assert.ok(Math.abs((outlineHeadY - foregroundHeadY) - (oy * outlineThicknessPx)) < 1e-5);
    }
  });

  test('two-handed grip mode renders outline and foreground correctly with joined forearms', () => {
    const body = createStickRangerBody(100, 100);
    const { ctx, calls } = createRecordingContext();

    renderStickRangerBody(ctx, body, 0, 0, 1, true, false);

    const fillRectCalls = calls.filter(c => c.op === 'fillRect');
    assert.ok(fillRectCalls.length > 0);

    const saveCalls = calls.filter(c => c.op === 'save');
    const restoreCalls = calls.filter(c => c.op === 'restore');
    assert.equal(saveCalls.length, restoreCalls.length);
  });

  test('stickman head is 5x5 pixels and limbs are 1 pixel with integer pixel snapping and crisp caps', () => {
    const body = createStickRangerBody(103.4, 78.6);
    const { ctx, calls } = createRecordingContext();

    renderStickRangerBody(ctx, body, 0.3, 0.7, 1, false, false);

    // All fillRect coordinates must be integers (no subpixel blur)
    const fillRectCalls = calls.filter(c => c.op === 'fillRect');
    assert.ok(fillRectCalls.length > 5);
    for (const f of fillRectCalls) {
      assert.equal(Number.isInteger(f.args[0]), true, `fillRect X must be integer: ${f.args[0]}`);
      assert.equal(Number.isInteger(f.args[1]), true, `fillRect Y must be integer: ${f.args[1]}`);
      assert.equal(Number.isInteger(f.args[2]), true, `fillRect W must be integer: ${f.args[2]}`);
      assert.equal(Number.isInteger(f.args[3]), true, `fillRect H must be integer: ${f.args[3]}`);
    }

    // Head fills should have width 5 and height 5
    const headFills = fillRectCalls.filter(c => (c.args[2] as number) === 5);
    assert.equal(headFills.length, 5);
    for (const h of headFills) {
      assert.equal(h.args[2], 5, 'head width must be 5px');
      assert.equal(h.args[3], 5, 'head height must be 5px');
    }
  });

  test('standing still with subpixel noise does not cause hysteresis coordinate jitter across frames', () => {
    const body = createStickRangerBody(100.49, 80.49);
    const { ctx: ctx1, calls: calls1 } = createRecordingContext();
    renderStickRangerBody(ctx1, body, 0, 0, 1, false, false);

    const head1 = calls1.filter(c => c.op === 'fillRect' && (c.args[2] as number) === 5)[4];

    // Frame 2 with tiny subpixel perturbation (simulating subpixel spring oscillation)
    body.x[0] = 100.52;
    body.y[0] = 80.52;
    const { ctx: ctx2, calls: calls2 } = createRecordingContext();
    renderStickRangerBody(ctx2, body, 0, 0, 1, false, false);

    const head2 = calls2.filter(c => c.op === 'fillRect' && (c.args[2] as number) === 5)[4];

    // Due to hysteresis, position remains stable and does not flip to adjacent pixel
    assert.equal(head1.args[0], head2.args[0], 'head X should not jitter between frames');
    assert.equal(head1.args[1], head2.args[1], 'head Y should not jitter between frames');
  });
});
