/**
 * surfaceRimStyle.ts — Centralized model for the per-block Surface Rim system.
 *
 * Generalizes the previously hard-coded exposed-edge brighten/multiply
 * presentation (surfaceEdgeOverlay.ts / blockEdgeShading.ts) into a
 * configurable style any placed block can opt into. 'default' preserves the
 * existing production look exactly.
 *
 * This module owns: the runtime type, defaults, validation/normalization,
 * equality, hashing (for cache-signature folding), and the compact codes
 * used by the room-level dedup style table (see roomJsonSerializer.ts).
 */

export type SurfaceRimMode = 'default' | 'none' | 'solid' | 'gradient' | 'inverted';
export type SurfaceRimFalloff = 'hard' | 'linear' | 'smooth' | 'exponential';

/**
 * Which kind of Block Overlay a wall carries.
 *
 * An overlay is anything drawn along a block's exposed edges on top of its
 * base sprite. The original exposed-edge highlight is simply the 'brighten'
 * kind — it is not a separate system — so every kind shares this one per-wall
 * style object, its room-level dedup table, and its serialization path.
 *
 *   'brighten' — the edge highlight (`mode`/`color`/`widthPx`/`opacity`/
 *                `falloff`/`interiorDarkness` below configure it).
 *   'grass'    — procedural grass on upward-facing edges; see
 *                render/walls/proceduralGrass.ts.
 */
export type BlockOverlayKind = 'brighten' | 'grass';

export const BLOCK_OVERLAY_KINDS: readonly BlockOverlayKind[] = ['brighten', 'grass'];

/**
 * What a palette overlay item paints. 'none' is not a `BlockOverlayKind`
 * because it stores nothing at all — absence of a style already means "no
 * overlay" — so it exists only as an eraser in the editor.
 */
export type BlockOverlayPaint = BlockOverlayKind | 'none';

export interface SurfaceRimStyle {
  /**
   * Which overlay this wall draws. Defaults to 'brighten', so a style that
   * omits it behaves exactly as the pre-overlay rim styles did.
   */
  readonly kind: BlockOverlayKind;
  /** Brighten-kind presentation. Ignored by every other kind. */
  readonly mode: SurfaceRimMode;
  /** Hex color WITHOUT a leading '#', e.g. "ff7a18". */
  readonly color: string;
  readonly widthPx: number;
  readonly opacity: number;
  readonly falloff: SurfaceRimFalloff;
  /** Interior darkness in [0,1] — only meaningful in 'inverted' mode. */
  readonly interiorDarkness: number;
}

/**
 * Sentinel `wallSurfaceRimStyleIndex` value meaning the wall carries NO block
 * overlay — it renders as its bare sprite with no edge treatment at all.
 *
 * Blocks used to get the exposed-edge highlight automatically, and this
 * sentinel meant "use that default presentation". Now that the highlight is a
 * paintable overlay ('brighten'), an unpainted block gets nothing and the
 * highlight is opt-in per block. Sized for a Uint16Array since the table can
 * exceed 255 entries in a room with many distinct overlays.
 */
export const SURFACE_RIM_STYLE_INDEX_DEFAULT = 0xFFFF;

export const SURFACE_RIM_MODES: readonly SurfaceRimMode[] = ['default', 'none', 'solid', 'gradient', 'inverted'];
export const SURFACE_RIM_FALLOFFS: readonly SurfaceRimFalloff[] = ['hard', 'linear', 'smooth', 'exponential'];

export const DEFAULT_SURFACE_RIM_STYLE: SurfaceRimStyle = Object.freeze({
  kind: 'brighten',
  mode: 'default',
  color: 'ffffff',
  widthPx: 3,
  opacity: 0.3,
  falloff: 'linear',
  interiorDarkness: 0.5,
});

/**
 * The Grass overlay. It carries no per-wall knobs yet, so every grass wall
 * canonicalizes to this one frozen object and the room's dedup table never
 * grows more than a single grass entry. Its appearance comes entirely from
 * `proceduralGrass.ts`, which derives everything from world position.
 */
export const GRASS_BLOCK_OVERLAY: SurfaceRimStyle = Object.freeze({
  ...DEFAULT_SURFACE_RIM_STYLE,
  kind: 'grass',
});

const _MIN_WIDTH_PX = 1;
const _MAX_WIDTH_PX = 32;

const _HEX_COLOR_RE = /^[0-9a-fA-F]{6}$/;

function _clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

/** Normalizes a color string to lowercase 6-digit hex without '#'. Falls back to the default color if invalid. */
export function normalizeSurfaceRimColor(color: string | undefined | null): string {
  if (typeof color !== 'string') return DEFAULT_SURFACE_RIM_STYLE.color;
  const stripped = color.startsWith('#') ? color.slice(1) : color;
  return _HEX_COLOR_RE.test(stripped) ? stripped.toLowerCase() : DEFAULT_SURFACE_RIM_STYLE.color;
}

/**
 * Validates and normalizes a (possibly partial/untrusted) style object into a
 * fully-populated, canonical `SurfaceRimStyle`. Unknown/invalid fields fall
 * back to defaults rather than throwing — used both for editor input and for
 * deserializing older/foreign room JSON.
 */
export function normalizeSurfaceRimStyle(input: Partial<SurfaceRimStyle> | undefined | null): SurfaceRimStyle {
  if (!input) return DEFAULT_SURFACE_RIM_STYLE;
  // Kind is resolved first: a non-brighten overlay ignores every rim knob
  // below, and grass canonicalizes to one shared object so all grass walls
  // dedup to a single table entry.
  if (input.kind === 'grass') return GRASS_BLOCK_OVERLAY;
  const mode: SurfaceRimMode = SURFACE_RIM_MODES.includes(input.mode as SurfaceRimMode)
    ? (input.mode as SurfaceRimMode)
    : DEFAULT_SURFACE_RIM_STYLE.mode;
  if (mode === 'default') return DEFAULT_SURFACE_RIM_STYLE;
  if (mode === 'none') return { ...DEFAULT_SURFACE_RIM_STYLE, mode: 'none' };
  const falloff: SurfaceRimFalloff = SURFACE_RIM_FALLOFFS.includes(input.falloff as SurfaceRimFalloff)
    ? (input.falloff as SurfaceRimFalloff)
    : DEFAULT_SURFACE_RIM_STYLE.falloff;
  return {
    kind: 'brighten',
    mode,
    color: normalizeSurfaceRimColor(input.color),
    widthPx: Math.round(_clamp(input.widthPx ?? DEFAULT_SURFACE_RIM_STYLE.widthPx, _MIN_WIDTH_PX, _MAX_WIDTH_PX)),
    opacity: _clamp(input.opacity ?? DEFAULT_SURFACE_RIM_STYLE.opacity, 0, 1),
    falloff: mode === 'solid' ? DEFAULT_SURFACE_RIM_STYLE.falloff : falloff,
    interiorDarkness: mode === 'inverted'
      ? _clamp(input.interiorDarkness ?? DEFAULT_SURFACE_RIM_STYLE.interiorDarkness, 0, 1)
      : DEFAULT_SURFACE_RIM_STYLE.interiorDarkness,
  };
}

/** True if the style is exactly the default (production-unchanged) style. */
export function isDefaultSurfaceRimStyle(style: SurfaceRimStyle): boolean {
  return surfaceRimStylesEqual(style, DEFAULT_SURFACE_RIM_STYLE);
}

/** Custom and none modes replace the production baked/default edge treatment. */
export function surfaceRimSuppressesBakedEdge(style: SurfaceRimStyle | null | undefined): boolean {
  return style !== null && style !== undefined
    && (style.kind !== 'brighten' || style.mode !== 'default');
}

export function surfaceRimStylesEqual(a: SurfaceRimStyle, b: SurfaceRimStyle): boolean {
  const ca = normalizeSurfaceRimStyle(a);
  const cb = normalizeSurfaceRimStyle(b);
  if (ca === cb) return true;
  if (ca.kind !== cb.kind) return false;
  if (ca.kind !== 'brighten') return true; // non-brighten kinds carry no knobs yet
  if (ca.mode !== cb.mode) return false;
  if (ca.mode === 'none') return true;
  if (ca.color !== cb.color || ca.widthPx !== cb.widthPx || ca.opacity !== cb.opacity) return false;
  if (ca.mode !== 'solid' && ca.falloff !== cb.falloff) return false;
  if (ca.mode === 'inverted' && ca.interiorDarkness !== cb.interiorDarkness) return false;
  return true;
}

/**
 * Cheap 32-bit content hash of a style, suitable for folding into the
 * `blockWallLayoutCache.ts` layout signature so a rim edit invalidates the
 * layout cache without needing to stringify the whole style.
 */
export function hashSurfaceRimStyle(style: SurfaceRimStyle): number {
  const canonical = normalizeSurfaceRimStyle(style);
  let h = 0;
  const mix = (n: number): void => {
    h = Math.imul(h, 1664525) + 1013904223 | 0;
    h ^= n | 0;
  };
  mix(BLOCK_OVERLAY_KINDS.indexOf(canonical.kind));
  if (canonical.kind !== 'brighten') return h >>> 0;
  mix(SURFACE_RIM_MODES.indexOf(canonical.mode));
  if (canonical.mode === 'default' || canonical.mode === 'none') return h >>> 0;
  mix(parseInt(canonical.color, 16) | 0);
  mix(canonical.widthPx);
  mix(Math.round(canonical.opacity * 1000));
  if (canonical.mode !== 'solid') mix(SURFACE_RIM_FALLOFFS.indexOf(canonical.falloff));
  if (canonical.mode === 'inverted') mix(Math.round(canonical.interiorDarkness * 1000));
  return h >>> 0;
}

// ── Compact serialization codes (see roomJsonSerializer.ts) ────────────────────

const _MODE_CODE: Record<Exclude<SurfaceRimMode, 'default'>, string> = {
  none: 'n',
  solid: 's',
  gradient: 'g',
  inverted: 'i',
};
const _CODE_MODE: Record<string, Exclude<SurfaceRimMode, 'default'>> = {
  n: 'none',
  s: 'solid',
  g: 'gradient',
  i: 'inverted',
};

const _FALLOFF_CODE: Record<SurfaceRimFalloff, number> = { hard: 0, linear: 1, smooth: 2, exponential: 3 };
const _CODE_FALLOFF: readonly SurfaceRimFalloff[] = ['hard', 'linear', 'smooth', 'exponential'];

/**
 * Compact tuple form used in the room-level `rimStyles` dedup table.
 * 'default' styles are never interned (omitted entirely — see serializer).
 * 'none' encodes as just `["n"]`. Others encode mode-specific trailing fields,
 * omitting any that equal the default so common cases stay short.
 */
export type CompactSurfaceRimStyle =
  | readonly [kind: 'B']
  | readonly [kind: 'G']
  | readonly [mode: 'n']
  | readonly [mode: 's', color?: string, widthPx?: number, opacity?: number]
  | readonly [mode: 'g', color?: string, widthPx?: number, opacity?: number, falloff?: number]
  | readonly [mode: 'i', color?: string, widthPx?: number, opacity?: number, falloff?: number, interiorDarkness?: number];

export function encodeSurfaceRimStyle(style: SurfaceRimStyle): CompactSurfaceRimStyle {
  const canonical = normalizeSurfaceRimStyle(style);
  // An explicitly painted Brighten in its standard presentation. Uppercase,
  // like the other kind-level codes, so it never collides with the lowercase
  // brighten-mode codes below.
  if (canonical.kind === 'brighten' && canonical.mode === 'default') return ['B'];
  // Non-brighten overlays encode as a single uppercase kind code, kept
  // distinct from the lowercase brighten-mode codes so the two namespaces can
  // never collide as more overlay kinds are added.
  if (canonical.kind === 'grass') return ['G'];
  if (canonical.mode === 'none') return ['n'];
  // 'default' was handled by the ['B'] early return above; narrowing it away
  // here keeps the mode-code lookups below total.
  const mode = canonical.mode as Exclude<SurfaceRimMode, 'default'>;
  const values: Array<string | number | undefined> = [
    _MODE_CODE[mode], canonical.color, canonical.widthPx,
    Math.round(canonical.opacity * 1000) / 1000,
  ];
  if (canonical.mode !== 'solid') values.push(_FALLOFF_CODE[canonical.falloff]);
  if (canonical.mode === 'inverted') values.push(Math.round(canonical.interiorDarkness * 1000) / 1000);
  const defaults: Array<string | number> = [
    _MODE_CODE[mode], DEFAULT_SURFACE_RIM_STYLE.color,
    DEFAULT_SURFACE_RIM_STYLE.widthPx, DEFAULT_SURFACE_RIM_STYLE.opacity,
  ];
  if (canonical.mode !== 'solid') defaults.push(_FALLOFF_CODE[DEFAULT_SURFACE_RIM_STYLE.falloff]);
  if (canonical.mode === 'inverted') defaults.push(DEFAULT_SURFACE_RIM_STYLE.interiorDarkness);
  while (values.length > 1 && values[values.length - 1] === defaults[values.length - 1]) values.pop();
  return values as unknown as CompactSurfaceRimStyle;
}

export function decodeSurfaceRimStyle(entry: unknown): SurfaceRimStyle {
  if (!Array.isArray(entry) || entry.length === 0) return DEFAULT_SURFACE_RIM_STYLE;
  if (entry[0] === 'G') return GRASS_BLOCK_OVERLAY;
  if (entry[0] === 'B') return DEFAULT_SURFACE_RIM_STYLE;
  const [codeRaw, colorRaw, widthRaw, opacityRaw, falloffRaw, interiorRaw] = entry;
  const mode = _CODE_MODE[codeRaw as string];
  if (mode === undefined) return DEFAULT_SURFACE_RIM_STYLE;
  if (mode === 'none') return normalizeSurfaceRimStyle({ mode: 'none' });
  const falloff = typeof falloffRaw === 'number' ? _CODE_FALLOFF[falloffRaw] : undefined;
  return normalizeSurfaceRimStyle({
    mode,
    color: typeof colorRaw === 'string' ? colorRaw : undefined,
    widthPx: typeof widthRaw === 'number' ? widthRaw : undefined,
    opacity: typeof opacityRaw === 'number' ? opacityRaw : undefined,
    falloff,
    interiorDarkness: typeof interiorRaw === 'number' ? interiorRaw : undefined,
  });
}

void _MODE_CODE; // retained for documentation/symmetry with _CODE_MODE

// ── Runtime interning helper ────────────────────────────────────────────────

/**
 * Interns `style` into `table` (appending a new entry only if an equal style
 * isn't already present) and returns its index, or
 * `SURFACE_RIM_STYLE_INDEX_DEFAULT` for an absent/default style. Shared by
 * every wall-loading path that populates `WorldState.wallSurfaceRimStyleIndex`
 * / `wallSurfaceRimStyleTable` (mirrors the per-wall `themeIndex` convention).
 */
export function internSurfaceRimStyle(table: SurfaceRimStyle[], style: SurfaceRimStyle | undefined): number {
  // Absence — not "equals the standard brighten look" — is what means "no
  // overlay". A wall explicitly painted Brighten must intern a real entry, or
  // it would be indistinguishable from an unpainted one and render bare.
  if (style === undefined) return SURFACE_RIM_STYLE_INDEX_DEFAULT;
  const normalized = normalizeSurfaceRimStyle(style);
  for (let i = 0; i < table.length; i++) {
    if (surfaceRimStylesEqual(table[i], normalized)) return i;
  }
  table.push(normalized);
  return table.length - 1;
}
