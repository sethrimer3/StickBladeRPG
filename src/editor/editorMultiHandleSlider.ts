/**
 * Multi-handle segmented percentage slider — plain DOM, no external deps.
 *
 * Renders N colored segments spanning 0-100% with N-1 draggable boundary
 * handles between them. Used by the "Random Weather" multi-select in
 * editorUILightingPanel.ts to let the designer split 100% across 2+ weather
 * patterns. Every segment stays >=1%, all segments always sum to exactly
 * 100 (whole numbers only).
 */

import { PANEL_BORDER, TEXT_COLOR, ACCENT_GOLD } from './editorStyles';

export interface MultiHandleSliderSegment {
  readonly label: string;
  readonly percent: number;
}

export interface MultiHandleSlider {
  readonly el: HTMLDivElement;
  /** Replace the displayed segments (label + percent). Ignored mid-drag. */
  setSegments(segments: readonly MultiHandleSliderSegment[]): void;
}

const SEGMENT_COLORS = [ACCENT_GOLD, '#6fa8dc', '#8fce8f', '#e06666', '#c27ba0'];

/** Rounds a list of raw floating percents to whole numbers that sum to 100,
 *  giving any leftover remainder to the last entry, with every entry >=1. */
export function normalizeWeatherWeightPercents(rawPercents: readonly number[]): number[] {
  const n = rawPercents.length;
  if (n === 0) return [];
  if (n === 1) return [100];
  const floored = rawPercents.map(p => Math.max(1, Math.floor(p)));
  let sum = floored.reduce((a, b) => a + b, 0);
  // Shrink from the largest entries first if flooring overshot 100 (rare —
  // only possible when several inputs round up past their fair share).
  while (sum > 100) {
    let maxIdx = 0;
    for (let i = 1; i < n; i++) if (floored[i] > floored[maxIdx]) maxIdx = i;
    if (floored[maxIdx] <= 1) break;
    floored[maxIdx]--;
    sum--;
  }
  floored[n - 1] += 100 - sum;
  if (floored[n - 1] < 1) {
    // Extremely unlikely (only if n is large and every other slot is pinned
    // at 1) — steal back from the largest other segment to keep >=1 everywhere.
    let maxIdx = n - 1;
    for (let i = 0; i < n - 1; i++) if (floored[i] > floored[maxIdx]) maxIdx = i;
    const deficit = 1 - floored[n - 1];
    floored[maxIdx] -= deficit;
    floored[n - 1] = 1;
  }
  return floored;
}

export function createMultiHandleSlider(
  onChange: (percents: number[]) => void,
): MultiHandleSlider {
  let segments: readonly MultiHandleSliderSegment[] = [];
  let boundaries: number[] = []; // length segments.length - 1, cumulative percents
  let dragging = false;

  const el = document.createElement('div');
  el.style.cssText = 'margin-top: 4px; margin-bottom: 4px;';

  const track = document.createElement('div');
  track.style.cssText = `
    position: relative; height: 22px; width: 100%; border-radius: 3px;
    border: 1px solid ${PANEL_BORDER}; overflow: visible; background: rgba(0,0,0,0.4);
  `;
  el.appendChild(track);

  const legend = document.createElement('div');
  legend.style.cssText = 'display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px;';
  el.appendChild(legend);

  function boundariesFromPercents(percents: readonly number[]): number[] {
    const b: number[] = [];
    let acc = 0;
    for (let i = 0; i < percents.length - 1; i++) {
      acc += percents[i];
      b.push(acc);
    }
    return b;
  }

  function percentsFromBoundaries(b: readonly number[]): number[] {
    const out: number[] = [];
    let prev = 0;
    for (const boundary of b) {
      out.push(boundary - prev);
      prev = boundary;
    }
    out.push(100 - prev);
    return out;
  }

  function render(): void {
    track.innerHTML = '';
    legend.innerHTML = '';
    const percents = percentsFromBoundaries(boundaries);
    let startPct = 0;
    for (let i = 0; i < segments.length; i++) {
      const color = SEGMENT_COLORS[i % SEGMENT_COLORS.length];
      const bar = document.createElement('div');
      bar.style.cssText = `
        position: absolute; top: 0; bottom: 0; left: ${startPct}%; width: ${percents[i]}%;
        background: ${color}; opacity: 0.55; box-sizing: border-box;
        border-right: ${i < segments.length - 1 ? `1px solid ${PANEL_BORDER}` : 'none'};
      `;
      track.appendChild(bar);

      const label = document.createElement('div');
      label.style.cssText = `display: flex; align-items: center; gap: 4px; font-size: 10px; color: ${TEXT_COLOR};`;
      const swatch = document.createElement('span');
      swatch.style.cssText = `width: 8px; height: 8px; border-radius: 1px; background: ${color}; display: inline-block;`;
      label.appendChild(swatch);
      const text = document.createElement('span');
      text.textContent = `${segments[i].label}: ${percents[i]}%`;
      label.appendChild(text);
      legend.appendChild(label);

      startPct += percents[i];
    }

    boundaries.forEach((boundaryPct, handleIndex) => {
      const handle = document.createElement('div');
      handle.style.cssText = `
        position: absolute; top: -2px; bottom: -2px; left: ${boundaryPct}%;
        width: 6px; margin-left: -3px; background: ${TEXT_COLOR}; cursor: ew-resize;
        border-radius: 2px; box-shadow: 0 0 2px rgba(0,0,0,0.8);
      `;
      const bubble = document.createElement('div');
      bubble.style.cssText = `
        position: absolute; top: -18px; left: 50%; transform: translateX(-50%);
        font-size: 10px; font-family: monospace; color: ${TEXT_COLOR};
        background: rgba(0,0,0,0.75); padding: 1px 4px; border-radius: 2px;
        white-space: nowrap; pointer-events: none;
      `;
      bubble.textContent = String(boundaryPct);
      handle.appendChild(bubble);
      track.appendChild(handle);

      handle.addEventListener('mousedown', (downEvt) => {
        downEvt.preventDefault();
        downEvt.stopPropagation();
        dragging = true;
        const trackRect = track.getBoundingClientRect();
        const lowerLimit = (handleIndex === 0 ? 0 : boundaries[handleIndex - 1]) + 1;
        const upperLimit = (handleIndex === boundaries.length - 1 ? 100 : boundaries[handleIndex + 1]) - 1;

        function onMouseMove(moveEvt: MouseEvent): void {
          const fraction = (moveEvt.clientX - trackRect.left) / trackRect.width;
          const raw = Math.round(fraction * 100);
          const clamped = Math.max(lowerLimit, Math.min(upperLimit, raw));
          if (clamped === boundaries[handleIndex]) return;
          boundaries[handleIndex] = clamped;
          render();
          onChange(percentsFromBoundaries(boundaries));
        }
        function onMouseUp(): void {
          dragging = false;
          document.removeEventListener('mousemove', onMouseMove);
          document.removeEventListener('mouseup', onMouseUp);
        }
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      });
    });
  }

  function setSegments(newSegments: readonly MultiHandleSliderSegment[]): void {
    if (dragging) return;
    segments = newSegments;
    const percents = normalizeWeatherWeightPercents(newSegments.map(s => s.percent));
    boundaries = boundariesFromPercents(percents);
    if (segments.length < 2) {
      track.style.display = 'none';
      legend.innerHTML = '';
      return;
    }
    track.style.display = '';
    render();
  }

  return { el, setSegments };
}
