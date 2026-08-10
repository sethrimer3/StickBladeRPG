/**
 * Glyphs — elemental modifiers socketed into weapons.
 *
 * Phase 2 of the STICK-RPG port. Ported from the donor's `GLYPHS`, `glyphById`,
 * and `resolveWeaponWithGlyph` in `js/equipment.js`.
 *
 * A glyph is a pure overlay: it never changes damage, range, or cooldown, only
 * the weapon's element and presentation. Socketing is allowed only on weapons
 * that declare `glyphSocket: true`; requesting a glyph on any other weapon
 * leaves the weapon untouched, exactly as the donor behaves.
 */

import type { WeaponDef, WeaponElement } from './weaponDefs';

/** Glyph identifiers, matching the donor's keys. */
export type GlyphId =
  | 'fire'
  | 'ice'
  | 'light'
  | 'chronometric'
  | 'void'
  | 'explosive'
  | 'necrotic'
  | 'life';

/** A socketable elemental glyph. */
export interface GlyphDef {
  id: GlyphId;
  name: string;
  description: string;
  /** Element imparted to the host weapon. */
  element: WeaponElement;
  /** Single-character ideograph shown on the weapon badge. */
  symbol: string;
  color: string;
  badgeColor: string;
  projectileColor: string;
  projectileTrailColor: string;
  ammoColor: string;
}

/** Every glyph, keyed by id. */
export const GLYPHS: Readonly<Record<GlyphId, GlyphDef>> = {
  fire: {
    id: 'fire',
    name: 'Pyre Glyph',
    description: 'Brands the weapon with roaring flame, igniting attacks and projectiles.',
    element: 'fire',
    symbol: '火',
    color: '#ff714d',
    badgeColor: 'rgba(255, 113, 77, 0.18)',
    projectileColor: '#ffb48c',
    projectileTrailColor: 'rgba(255, 140, 92, 0.55)',
    ammoColor: '#ffae73',
  },
  ice: {
    id: 'ice',
    name: 'Glacier Glyph',
    description: 'Frost etchings spread across the weapon, chilling anything they touch.',
    element: 'ice',
    symbol: '氷',
    color: '#7be1ff',
    badgeColor: 'rgba(123, 225, 255, 0.2)',
    projectileColor: '#d8f7ff',
    projectileTrailColor: 'rgba(190, 245, 255, 0.65)',
    ammoColor: '#d4f4ff',
  },
  light: {
    id: 'light',
    name: 'Radiance Glyph',
    description: 'Suffuses the weapon with searing light that cuts through shadow.',
    element: 'light',
    symbol: '光',
    color: '#ffe066',
    badgeColor: 'rgba(255, 224, 102, 0.2)',
    projectileColor: '#fff4ba',
    projectileTrailColor: 'rgba(255, 236, 170, 0.6)',
    ammoColor: '#ffe066',
  },
  chronometric: {
    id: 'chronometric',
    name: 'Chronometric Glyph',
    description: 'Threads the weapon through time, lending hits a temporal shimmer.',
    element: 'chronometric',
    symbol: '時',
    color: '#6bd1ff',
    badgeColor: 'rgba(107, 209, 255, 0.18)',
    projectileColor: '#bde8ff',
    projectileTrailColor: 'rgba(134, 224, 255, 0.55)',
    ammoColor: '#9fe0ff',
  },
  void: {
    id: 'void',
    name: 'Umbral Glyph',
    description: 'Pulls in starlight and voidflame, turning strikes into rifts of nothingness.',
    element: 'void',
    symbol: '空',
    color: '#9f7bff',
    badgeColor: 'rgba(159, 123, 255, 0.2)',
    projectileColor: '#c8b4ff',
    projectileTrailColor: 'rgba(168, 138, 255, 0.6)',
    ammoColor: '#c8b4ff',
  },
  explosive: {
    id: 'explosive',
    name: 'Nova Glyph',
    description: 'Imbues the weapon with volatile sigils that crave explosive release.',
    element: 'explosive',
    symbol: '爆',
    color: '#ffcf5a',
    badgeColor: 'rgba(255, 207, 90, 0.2)',
    projectileColor: '#ffe3a6',
    projectileTrailColor: 'rgba(255, 207, 120, 0.6)',
    ammoColor: '#ffd36b',
  },
  necrotic: {
    id: 'necrotic',
    name: 'Decay Glyph',
    description: 'Infuses strikes with clinging rot that continues to erode foes.',
    element: 'necrotic',
    symbol: '腐',
    color: '#7fe6b2',
    badgeColor: 'rgba(127, 230, 178, 0.2)',
    projectileColor: '#c1f6d9',
    projectileTrailColor: 'rgba(140, 240, 190, 0.6)',
    ammoColor: '#9ff2c8',
  },
  life: {
    id: 'life',
    name: 'Verdant Glyph',
    description: 'Channels vibrant growth that lets attacks pulse with living energy.',
    element: 'life',
    symbol: '生',
    color: '#6df29a',
    badgeColor: 'rgba(109, 242, 154, 0.2)',
    projectileColor: '#b7f9cf',
    projectileTrailColor: 'rgba(120, 244, 180, 0.55)',
    ammoColor: '#8ff5bb',
  },
};

/** Canonical display order, ported from the donor's `GLYPH_ORDER`. */
export const GLYPH_ORDER: readonly GlyphId[] = Object.freeze([
  'fire',
  'ice',
  'light',
  'chronometric',
  'void',
  'explosive',
  'necrotic',
  'life',
]);

/**
 * Resolves a glyph id, or null when it names no glyph.
 *
 * Accepts the donor's `'chrono'` alias for `'chronometric'` and is
 * case/whitespace tolerant, because glyph ids travel through saved item data.
 */
export function getGlyphDef(id: string | null | undefined): GlyphDef | null {
  if (typeof id !== 'string') return null;
  const key = id.trim().toLowerCase();
  if (key === '') return null;
  const normalized = key === 'chrono' ? 'chronometric' : key;
  return Object.prototype.hasOwnProperty.call(GLYPHS, normalized)
    ? GLYPHS[normalized as GlyphId]
    : null;
}

/** Sort index for `id` within `GLYPH_ORDER`; unknown glyphs sort last. */
export function getGlyphSortIndex(id: string | null | undefined): number {
  const glyph = getGlyphDef(id);
  if (glyph === null) return GLYPH_ORDER.length;
  const index = GLYPH_ORDER.indexOf(glyph.id);
  return index === -1 ? GLYPH_ORDER.length : index;
}

/** True when `def` has a socket a glyph can be placed into. */
export function weaponSupportsGlyphSocket(def: WeaponDef): boolean {
  return def.glyphSocket === true;
}

/** A weapon with a glyph's element and presentation applied. */
export interface GlyphedWeapon extends WeaponDef {
  /** Id of the applied glyph, absent when no glyph took effect. */
  glyphApplied?: GlyphId;
  glyphSymbol?: string;
  glyphColor?: string;
  glyphBadgeColor?: string;
}

/**
 * Returns `def` with `glyphId` applied, or a plain copy when the glyph does not
 * apply (unknown glyph, or a weapon without a socket).
 *
 * The input is never mutated. Nested config blocks are shallow-copied so a
 * caller that later edits the resolved weapon cannot reach back into the shared
 * definition table — the donor does the same, for the same reason.
 *
 * Ported from `resolveWeaponWithGlyph`. Note the donor's quirk, preserved here:
 * `ammoColor` is overridden only for `kind: 'gun'`.
 */
export function applyGlyphToWeapon(
  def: WeaponDef,
  glyphId: string | null | undefined,
): GlyphedWeapon {
  const weapon: GlyphedWeapon = { ...def };

  // Shallow-copy the nested blocks the donor copies, so edits to a resolved
  // weapon cannot mutate the shared definition.
  if (def.charge) weapon.charge = { ...def.charge };
  if (def.staff) weapon.staff = { ...def.staff };
  if (def.photostigma) weapon.photostigma = { ...def.photostigma };
  if (def.lightLineExperiment) weapon.lightLineExperiment = { ...def.lightLineExperiment };
  if (def.crumbling) weapon.crumbling = { ...def.crumbling };
  if (def.auric) weapon.auric = { ...def.auric };
  if (def.shield) weapon.shield = { ...def.shield };

  const glyph = getGlyphDef(glyphId);
  if (glyph === null || !weaponSupportsGlyphSocket(def)) return weapon;

  weapon.element = glyph.element;
  weapon.color = glyph.color;
  weapon.projectileColor = glyph.projectileColor;
  weapon.projectileTrailColor = glyph.projectileTrailColor;
  if (def.kind === 'gun') weapon.ammoColor = glyph.ammoColor;

  weapon.name = `${def.name} (${glyph.name})`;
  if (weapon.description === undefined) {
    weapon.description = `Attuned to the ${glyph.name}.`;
  }

  weapon.glyphApplied = glyph.id;
  weapon.glyphSymbol = glyph.symbol;
  weapon.glyphColor = glyph.color;
  weapon.glyphBadgeColor = glyph.badgeColor;

  return weapon;
}
