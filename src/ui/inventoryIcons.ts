/**
 * Procedural SVG/Canvas icon generators for inventory items.
 *
 * Provides stylized vector icons for weapons, armor, shoes, and slot watermarks.
 * When actual game sprites are added later, these serve as clean fallbacks.
 */

import { getWeaponDef } from '../sim/weapons/weaponDefs';
import { getItemDef, isArmorItem, isShoeItem, isTwoHandedItem } from '../sim/items/itemCatalog';
import { getStatBoostItemDef, type StatBoostItemDef } from '../sim/items/statBoostItems';

/**
 * Returns an inline SVG string for an item's icon.
 */
export function getItemIconSvg(itemId: string, width = 36, height = 36): string {
  const item = getItemDef(itemId);
  if (!item) return getFallbackIcon(width, height);

  const color = ('color' in item && typeof item.color === 'string') ? item.color : '#ffd700';

  const boost = getStatBoostItemDef(itemId);
  if (boost) {
    return getStatBoostIconSvg(boost, width, height);
  }

  if (isArmorItem(itemId)) {
    return getArmorIconSvg(itemId, color, width, height);
  }

  if (isShoeItem(itemId)) {
    return getShoeIconSvg(itemId, color, width, height);
  }

  const weapon = getWeaponDef(itemId);
  if (!weapon) return getFallbackIcon(width, height);

  switch (weapon.kind) {
    case 'melee':
      if (weapon.name.toLowerCase().includes('dagger')) {
        return getDaggerIconSvg(color, width, height);
      }
      if (isTwoHandedItem(itemId)) {
        return getGreatswordIconSvg(color, width, height);
      }
      return getSwordIconSvg(color, width, height);

    case 'shield':
      return getShieldIconSvg(color, width, height);

    case 'bow':
      return getBowIconSvg(color, width, height);

    case 'staff':
    case 'magic':
      return getStaffIconSvg(color, width, height);

    case 'gun':
      return getGunIconSvg(color, width, height);

    case 'throw':
      return getBombIconSvg(color, width, height);

    case 'summoner':
      return getTomeIconSvg(color, width, height);

    default:
      return getSwordIconSvg(color, width, height);
  }
}

/** Watermark / silhouette icons for empty equipment slots. */
export function getSlotWatermarkSvg(type: 'handLeft' | 'handRight' | 'handBoth' | 'armor' | 'shoes', size = 32): string {
  const dim = '#555';
  switch (type) {
    case 'handLeft':
      return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${dim}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14.5 17.5L3 6V3h3l11.5 11.5"/>
        <path d="M13 19l6-6"/>
        <path d="M16 16l4 4"/>
        <path d="M19 21l2-2"/>
      </svg>`;
    case 'handRight':
      return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${dim}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      </svg>`;
    case 'handBoth':
      return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${dim}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14.5 17.5L3 6V3h3l11.5 11.5"/>
        <path d="M13 19l6-6"/>
        <path d="M6 18l-3 3"/>
        <path d="M18 6l3-3"/>
      </svg>`;
    case 'armor':
      return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${dim}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 4l4-2h8l4 2v6c0 5.5-3.5 9.5-8 12-4.5-2.5-8-6.5-8-12V4z"/>
        <path d="M9 4v4h6V4"/>
      </svg>`;
    case 'shoes':
      return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${dim}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 16v-6a2 2 0 0 1 2-2h3l2 5h5a3 3 0 0 1 3 3v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>
        <path d="M4 20h16"/>
      </svg>`;
  }
}

/**
 * Icon for a permanent stat boost item.
 *
 * The *silhouette* says which stat track the item raises; the badge in the
 * bottom-right corner says how it raises it — `+` for a flat item, `%` for a
 * percentage one. Both are drawn inside the same 32×32 viewBox as every other
 * item icon, with the track glyph inset to the top-left 26×26 so the badge
 * never overlaps it at the small sizes the inventory grid uses.
 */
export function getStatBoostIconSvg(boost: StatBoostItemDef, w: number, h: number): string {
  const { color } = boost;
  const glyph = getStatTrackGlyphSvg(boost.track, color);
  const badge = getBoostModeBadgeSvg(boost.mode, color);
  return `<svg width="${w}" height="${h}" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    ${glyph}
    ${badge}
  </svg>`;
}

/** Track silhouette, drawn within the top-left 26×26 of the 32×32 viewBox. */
function getStatTrackGlyphSvg(track: StatBoostItemDef['track'], color: string): string {
  const fill = `fill="${color}" fill-opacity="0.28" stroke="${color}" stroke-width="2" stroke-linejoin="round"`;
  switch (track) {
    case 'health':
      // Heart
      return `<path d="M13 23C7 19 3 15.5 3 11.5A5 5 0 0 1 13 9A5 5 0 0 1 23 11.5C23 15.5 19 19 13 23Z" ${fill}/>`;
    case 'attack':
      // Upward blade
      return `<path d="M13 2L18 12V21H8V12L13 2Z" ${fill}/>
        <path d="M8 21h10" stroke="${color}" stroke-width="2" stroke-linecap="round"/>`;
    case 'defense':
      // Shield
      return `<path d="M13 2L3 6V13C3 18.5 7.5 22 13 24C18.5 22 23 18.5 23 13V6L13 2Z" ${fill}/>`;
    case 'dust':
      // Four-point mote
      return `<path d="M13 2L16 10L24 13L16 16L13 24L10 16L2 13L10 10L13 2Z" ${fill}/>`;
    case 'ammo':
      // Bullet / cartridge
      return `<path d="M13 2L18 9V20H8V9L13 2Z" ${fill}/>
        <path d="M8 14h10" stroke="${color}" stroke-width="1.5"/>
        <path d="M6 20h14v3H6z" ${fill}/>`;
    case 'mana':
      // Droplet
      return `<path d="M13 2C13 2 4 11 4 16A9 9 0 0 0 22 16C22 11 13 2 13 2Z" ${fill}/>`;
  }
}

/**
 * Bottom-right corner badge: `+` for additive boosts, `%` for percentage ones.
 *
 * Drawn as vector paths rather than a `<text>` element so it renders
 * identically regardless of which fonts the host page has loaded — these SVGs
 * are injected as raw markup into the inventory DOM, where font availability
 * is not something this module controls.
 */
function getBoostModeBadgeSvg(mode: StatBoostItemDef['mode'], color: string): string {
  const disc = `<circle cx="24" cy="24" r="7.5" fill="#0d0a08" stroke="${color}" stroke-width="1.5"/>`;
  if (mode === 'flat') {
    return `${disc}
      <path d="M24 20v8M20 24h8" stroke="${color}" stroke-width="2.2" stroke-linecap="round"/>`;
  }
  return `${disc}
    <path d="M21 27l6-6" stroke="${color}" stroke-width="2" stroke-linecap="round"/>
    <circle cx="21.2" cy="21.2" r="1.9" stroke="${color}" stroke-width="1.6"/>
    <circle cx="26.8" cy="26.8" r="1.9" stroke="${color}" stroke-width="1.6"/>`;
}

function getSwordIconSvg(color: string, w: number, h: number): string {
  return `<svg width="${w}" height="${h}" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M25 7L12 20M25 7L23 5L20 8L22 10M25 7L27 9L24 12L22 10" stroke="${color}" stroke-width="2" stroke-linecap="round"/>
    <path d="M12 20L9 17L7 19L10 22M12 20L15 23L13 25L10 22" stroke="#8a6f3d" stroke-width="2" stroke-linecap="round"/>
    <path d="M10 22L6 26" stroke="#c0a060" stroke-width="2.5" stroke-linecap="round"/>
    <circle cx="5" cy="27" r="1.5" fill="#ffd700"/>
  </svg>`;
}

function getGreatswordIconSvg(color: string, w: number, h: number): string {
  return `<svg width="${w}" height="${h}" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M27 5L13 19M27 5L23 3L18 8L22 12M27 5L29 7L24 12L22 12" fill="${color}" fill-opacity="0.3" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M11 17L15 21M9 21L13 25" stroke="#d4af37" stroke-width="2.5" stroke-linecap="round"/>
    <path d="M11 21L5 27" stroke="#8a6f3d" stroke-width="3" stroke-linecap="round"/>
    <circle cx="4" cy="28" r="2" fill="${color}"/>
  </svg>`;
}

function getDaggerIconSvg(color: string, w: number, h: number): string {
  return `<svg width="${w}" height="${h}" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M22 10L14 18M22 10L20 8L18 10L20 12M22 10L24 12L22 14L20 12" stroke="${color}" stroke-width="1.8" stroke-linecap="round"/>
    <path d="M14 18L12 16M14 18L16 20" stroke="#ffd700" stroke-width="2" stroke-linecap="round"/>
    <path d="M13 19L9 23" stroke="#8a6f3d" stroke-width="2" stroke-linecap="round"/>
  </svg>`;
}

function getShieldIconSvg(color: string, w: number, h: number): string {
  return `<svg width="${w}" height="${h}" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M16 4L6 8V16C6 22 10.5 26.5 16 28C21.5 26.5 26 22 26 16V8L16 4Z" fill="${color}" fill-opacity="0.2" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
    <path d="M16 8V24M10 14H22" stroke="${color}" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`;
}

function getBowIconSvg(color: string, w: number, h: number): string {
  return `<svg width="${w}" height="${h}" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M8 8C14 14 14 18 8 24" stroke="#8b5a2b" stroke-width="2.5" stroke-linecap="round"/>
    <path d="M8 8L24 16L8 24" stroke="#e0e0e0" stroke-width="1" stroke-linecap="round"/>
    <path d="M7 16H23M23 16L19 13M23 16L19 19" stroke="${color}" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`;
}

function getStaffIconSvg(color: string, w: number, h: number): string {
  return `<svg width="${w}" height="${h}" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M23 9L7 25" stroke="#8b5a2b" stroke-width="2.5" stroke-linecap="round"/>
    <circle cx="23" cy="9" r="4.5" fill="${color}" fill-opacity="0.4" stroke="${color}" stroke-width="1.8"/>
    <circle cx="23" cy="9" r="2" fill="#ffffff"/>
  </svg>`;
}

function getGunIconSvg(color: string, w: number, h: number): string {
  return `<svg width="${w}" height="${h}" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M6 14H22V19H17V24H12V19H6V14Z" fill="${color}" fill-opacity="0.25" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
    <path d="M22 16H26" stroke="#ffaa44" stroke-width="2" stroke-linecap="round"/>
  </svg>`;
}

function getBombIconSvg(color: string, w: number, h: number): string {
  return `<svg width="${w}" height="${h}" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="15" cy="18" r="8" fill="#333" stroke="${color}" stroke-width="2"/>
    <path d="M19 12L23 8" stroke="#888" stroke-width="2" stroke-linecap="round"/>
    <path d="M24 7L26 5M22 6L25 9" stroke="#ff4422" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`;
}

function getTomeIconSvg(color: string, w: number, h: number): string {
  return `<svg width="${w}" height="${h}" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M7 6H21C23 6 25 8 25 10V26C25 24 23 22 21 22H7V6Z" fill="${color}" fill-opacity="0.2" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
    <path d="M7 6H21C23 6 25 8 25 10V26C25 24 23 22 21 22H7C5 22 4 23 4 25V8C4 7 5 6 7 6Z" stroke="${color}" stroke-width="1.5"/>
    <circle cx="16" cy="14" r="3" fill="${color}"/>
  </svg>`;
}

function getArmorIconSvg(_id: string, color: string, w: number, h: number): string {
  return `<svg width="${w}" height="${h}" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M6 7L11 4H21L26 7V15C26 22 20 27 16 29C12 27 6 22 6 15V7Z" fill="${color}" fill-opacity="0.25" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
    <path d="M12 4V9C12 11 14 13 16 13C18 13 20 11 20 9V4" stroke="${color}" stroke-width="1.5"/>
    <path d="M6 13H11M21 13H26" stroke="${color}" stroke-width="1.5"/>
  </svg>`;
}

function getShoeIconSvg(_id: string, color: string, w: number, h: number): string {
  return `<svg width="${w}" height="${h}" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M6 21V13C6 11.5 7.5 10 9 10H13L15 17H21C23.5 17 26 19.5 26 22V24H6V21Z" fill="${color}" fill-opacity="0.25" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
    <path d="M6 25H26" stroke="${color}" stroke-width="2" stroke-linecap="round"/>
  </svg>`;
}

function getFallbackIcon(w: number, h: number): string {
  return `<svg width="${w}" height="${h}" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="6" y="6" width="20" height="20" rx="3" stroke="#888" stroke-width="1.5" stroke-dasharray="3 3"/>
    <circle cx="16" cy="16" r="4" fill="#666"/>
  </svg>`;
}
