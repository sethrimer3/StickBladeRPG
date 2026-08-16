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

    const strokeCalls = calls.filter(c => c.op === 'stroke');
    assert.equal(strokeCalls.length, 5, 'should stroke 4 outline passes + 1 foreground pass');

    // First 4 passes are black outline
    for (let i = 0; i < 4; i++) {
      assert.equal(strokeCalls[i].strokeStyle, OUTLINE_COLOR);
    }
    // Final pass is white figure
    assert.equal(strokeCalls[4].strokeStyle, FIGURE_COLOR);

    const fillRectCalls = calls.filter(c => c.op === 'fillRect');
    assert.equal(fillRectCalls.length, 5, 'should fill head square 4 outline passes + 1 foreground pass');

    for (let i = 0; i < 4; i++) {
      assert.equal(fillRectCalls[i].fillStyle, OUTLINE_COLOR);
    }
    assert.equal(fillRectCalls[4].fillStyle, FIGURE_COLOR);
  });

  test('renderStickRangerBody executes 4 black outline passes before 1 crimson foreground pass for enemy', () => {
    const body = createStickRangerBody(100, 100);
    const { ctx, calls } = createRecordingContext();

    renderStickRangerBody(ctx, body, 0, 0, 1, false, true);

    const strokeCalls = calls.filter(c => c.op === 'stroke');
    assert.equal(strokeCalls.length, 5);

    for (let i = 0; i < 4; i++) {
      assert.equal(strokeCalls[i].strokeStyle, OUTLINE_COLOR);
    }
    assert.equal(strokeCalls[4].strokeStyle, ENEMY_FIGURE_COLOR);

    const fillRectCalls = calls.filter(c => c.op === 'fillRect');
    assert.equal(fillRectCalls.length, 5);
    assert.equal(fillRectCalls[4].fillStyle, ENEMY_FIGURE_COLOR);
  });

  test('outline offsets scale with scalePx / zoom factor', () => {
    const body = createStickRangerBody(100, 100);
    const scale = 2.5;
    const { ctx, calls } = createRecordingContext();

    renderStickRangerBody(ctx, body, 0, 0, scale, false, false);

    const headFills = calls.filter(c => c.op === 'fillRect');
    assert.equal(headFills.length, 5);

    const foregroundHeadX = headFills[4].args[0] as number;
    const foregroundHeadY = headFills[4].args[1] as number;

    // Check that each of the 4 outline head positions is shifted by offset * scalePx
    for (let i = 0; i < 4; i++) {
      const [ox, oy] = OUTLINE_NEIGHBOR_OFFSETS[i];
      const outlineHeadX = headFills[i].args[0] as number;
      const outlineHeadY = headFills[i].args[1] as number;

      assert.ok(Math.abs((outlineHeadX - foregroundHeadX) - (ox * scale)) < 1e-5);
      assert.ok(Math.abs((outlineHeadY - foregroundHeadY) - (oy * scale)) < 1e-5);
    }
  });

  test('two-handed grip mode renders outline and foreground correctly with joined forearms', () => {
    const body = createStickRangerBody(100, 100);
    const { ctx, calls } = createRecordingContext();

    renderStickRangerBody(ctx, body, 0, 0, 1, true, false);

    const strokeCalls = calls.filter(c => c.op === 'stroke');
    assert.equal(strokeCalls.length, 5);
    assert.equal(strokeCalls[4].strokeStyle, FIGURE_COLOR);

    const saveCalls = calls.filter(c => c.op === 'save');
    const restoreCalls = calls.filter(c => c.op === 'restore');
    assert.equal(saveCalls.length, restoreCalls.length);
  });
});
