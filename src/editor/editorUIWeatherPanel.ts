/**
 * Editor weather panel — builds the DOM controls for the room weather
 * settings and provides a per-frame sync helper.
 *
 * Extracted from editorUILightingPanel.ts: the weather controls used to be
 * appended to the lighting palette category, which meant they were only
 * reachable (and only synced) while the lighting category was active. They
 * now live in the always-visible "Room Music/Weather" section built by
 * editorUI.ts, so this module owns their construction, change detection and
 * sync independently of the lighting panel.
 */

import type { EditorState, EditorUICallbacks, WeatherEffect } from './editorState';
import { WEATHER_OPTIONS } from './editorState';
import { PANEL_BORDER, TEXT_COLOR } from './editorStyles';
import { createMultiHandleSlider, normalizeWeatherWeightPercents } from './editorMultiHandleSlider';

/** Serializes a weatherWeights list into a stable string for change detection. */
function weatherWeightsSig(weights: readonly { weather: string; percent: number }[] | undefined): string {
  return (weights ?? []).map(w => `${w.weather}:${w.percent}`).join(',');
}

/**
 * Deterministic value signature over every field sync() reads — cheap to
 * compare with `===`, letting sync() return immediately (no DOM writes at
 * all) when nothing relevant changed, instead of unconditionally rewriting
 * every non-focused control's value every frame.
 */
export function computeWeatherValueSig(state: EditorState): string {
  const room = state.roomData;
  return [
    room?.weather ?? 'none',
    room?.randomWeather ?? false,
    weatherWeightsSig(room?.weatherWeights),
  ].join('|');
}

export interface EditorWeatherPanel {
  /** Top-level container div for all weather controls. Mounted once by
   *  editorUI.ts into the Room Music/Weather section body. */
  readonly weatherDiv: HTMLDivElement;
  /**
   * Incremental sync — safe to call every frame. Returns early when the
   * value signature is unchanged, and never overwrites a control that
   * currently has focus so an in-progress drag is not interrupted.
   */
  sync(state: EditorState): void;
  /** Resets tracked state; call from the parent panel's `destroy()`. */
  resetState(): void;
}

export function createEditorWeatherPanel(
  getCallbacks: () => EditorUICallbacks | null,
): EditorWeatherPanel {
  let _lastSyncSig = '';

  const weatherDiv = document.createElement('div');
  weatherDiv.style.cssText = 'margin-bottom: 4px;';

  // ── Weather dropdown ───────────────────────────────────────────────────────
  const weatherLabel = document.createElement('div');
  weatherLabel.textContent = 'Weather';
  weatherLabel.style.cssText = `font-size: 11px; color: rgba(241,231,203,0.7); margin-top: 10px; margin-bottom: 4px; border-top: 1px solid ${PANEL_BORDER}; padding-top: 6px;`;
  weatherDiv.appendChild(weatherLabel);
  const weatherSelect = document.createElement('select');
  weatherSelect.style.cssText = `
    width: 100%; background: rgba(0,0,0,0.6); border: 1px solid ${PANEL_BORDER};
    color: ${TEXT_COLOR}; padding: 4px 6px; font-size: 11px; font-family: monospace;
    border-radius: 2px;
  `;
  for (const opt of WEATHER_OPTIONS) {
    const o = document.createElement('option');
    o.value = opt.id;
    o.textContent = opt.label;
    weatherSelect.appendChild(o);
  }
  weatherSelect.addEventListener('change', () => {
    getCallbacks()?.onWeatherChange(weatherSelect.value as WeatherEffect);
  });
  weatherSelect.addEventListener('click', (e) => e.stopPropagation());
  weatherDiv.appendChild(weatherSelect);

  // ── Random Weather checkbox + multi-select + split slider ─────────────────
  const randomWeatherRow = document.createElement('label');
  randomWeatherRow.style.cssText = 'display: flex; align-items: center; gap: 6px; font-size: 11px; color: rgba(241,231,203,0.7); cursor: pointer; margin-top: 6px;';
  const randomWeatherCheckbox = document.createElement('input');
  randomWeatherCheckbox.type = 'checkbox';
  randomWeatherRow.appendChild(randomWeatherCheckbox);
  const randomWeatherText = document.createElement('span');
  randomWeatherText.textContent = 'Random Weather';
  randomWeatherRow.appendChild(randomWeatherText);
  randomWeatherRow.addEventListener('click', (e) => e.stopPropagation());
  weatherDiv.appendChild(randomWeatherRow);

  const weatherMultiSelectDiv = document.createElement('div');
  weatherMultiSelectDiv.style.cssText = 'display: none; margin-top: 4px; flex-direction: column; gap: 2px;';
  const weatherCheckboxes = new Map<WeatherEffect, HTMLInputElement>();
  for (const opt of WEATHER_OPTIONS) {
    const row = document.createElement('label');
    row.style.cssText = 'display: flex; align-items: center; gap: 6px; font-size: 11px; color: rgba(241,231,203,0.7); cursor: pointer;';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    row.appendChild(cb);
    const span = document.createElement('span');
    span.textContent = opt.label;
    row.appendChild(span);
    row.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => emitWeatherWeightsChange());
    weatherCheckboxes.set(opt.id, cb);
    weatherMultiSelectDiv.appendChild(row);
  }
  weatherDiv.appendChild(weatherMultiSelectDiv);

  const weatherSlider = createMultiHandleSlider((percents) => {
    const selected = WEATHER_OPTIONS.filter(opt => weatherCheckboxes.get(opt.id)?.checked);
    getCallbacks()?.onWeatherWeightsChange(selected.map((opt, i) => ({ weather: opt.id, percent: percents[i] })));
  });
  weatherMultiSelectDiv.appendChild(weatherSlider.el);

  randomWeatherCheckbox.addEventListener('change', () => {
    getCallbacks()?.onRandomWeatherToggle(randomWeatherCheckbox.checked);
  });

  /** Reads current checkbox selection, rebalances percents (preserving
   *  proportions of weathers that stay selected, splitting the rest evenly
   *  among newly-added ones), and reports the result. */
  function emitWeatherWeightsChange(): void {
    const room = getCallbacks() ? _lastRoomDataForWeights : null;
    const prevWeights = room?.weatherWeights ?? [];
    const selected = WEATHER_OPTIONS.filter(opt => weatherCheckboxes.get(opt.id)?.checked);
    const rawPercents = selected.map(opt => {
      const prev = prevWeights.find(w => w.weather === opt.id);
      return prev ? prev.percent : 100 / selected.length;
    });
    const percents = normalizeWeatherWeightPercents(rawPercents);
    getCallbacks()?.onWeatherWeightsChange(selected.map((opt, i) => ({ weather: opt.id, percent: percents[i] })));
  }
  // Room data snapshot used only by emitWeatherWeightsChange() above to read
  // prior percents when the checkbox selection changes (avoids threading
  // `state` through every checkbox's change handler).
  let _lastRoomDataForWeights: { weatherWeights?: { weather: WeatherEffect; percent: number }[] } | null = null;

  function sync(state: EditorState): void {
    const sig = computeWeatherValueSig(state);
    if (sig === _lastSyncSig) return;
    _lastSyncSig = sig;

    const room = state.roomData;
    _lastRoomDataForWeights = room;
    if (document.activeElement !== weatherSelect) {
      weatherSelect.value = room?.weather ?? 'none';
    }
    const randomWeather = room?.randomWeather ?? false;
    if (document.activeElement !== randomWeatherCheckbox) {
      randomWeatherCheckbox.checked = randomWeather;
    }
    weatherSelect.style.display = randomWeather ? 'none' : '';
    weatherMultiSelectDiv.style.display = randomWeather ? 'flex' : 'none';
    if (!randomWeather) return;
    const weights = room?.weatherWeights ?? [];
    const selectedIds = new Set(weights.map(w => w.weather));
    for (const [id, cb] of weatherCheckboxes) {
      if (document.activeElement !== cb) cb.checked = selectedIds.has(id);
    }
    if (weights.length >= 2) {
      weatherSlider.setSegments(weights.map(w => ({
        label: WEATHER_OPTIONS.find(opt => opt.id === w.weather)?.label ?? w.weather,
        percent: w.percent,
      })));
    } else {
      weatherSlider.setSegments([]);
    }
  }

  function resetState(): void {
    _lastSyncSig = '';
    _lastRoomDataForWeights = null;
  }

  return { weatherDiv, sync, resetState };
}
