/**
 * Weapons original to StickBlade — everything in the weapon table that did not
 * come from the STICK-RPG donor.
 *
 * Kept out of `weaponData.ts` on purpose. That file's header promises it can be
 * diffed field-for-field against the donor's `WEAPON_DEFS`, and that promise is
 * load-bearing: it is how "do we have every donor weapon?" gets answered
 * without guessing. One local weapon mixed in would cost that.
 *
 * `weaponDefs.ts` merges this table with the donor's; ids must not collide, and
 * a test asserts they do not.
 *
 * ── The weave weapons ───────────────────────────────────────────────────────
 *
 * One sword and one bow for each of the six equippable dust types, so every
 * weave the player can select has a weapon that matches it. Each carries
 * `weaveDust`, the `ParticleKind` it is woven from, and an `element` chosen to
 * match — the elements come from a fixed donor list (`WeaponElement`) with no
 * "gold" or "nature" member, so Golden reads as `physical` (it is the
 * foundational, untyped dust) and Verdant as `life`.
 *
 * The two subtypes differ in what their secondary does, not just in reach:
 *
 *   • **Swords** declare `secondaryShieldWeave`. The secondary raises the
 *     existing Shield Weave (`sim/stormweave/shieldWeave.ts`) woven from the
 *     sword's own dust, rather than carrying a second shield of their own.
 *   • **Bows** have no secondary. They charge, as the donor's bows do.
 *
 * Stats are deliberately flat across the set — same reach, cooldown, and damage
 * for every sword — so the choice between them reads as elemental rather than
 * as a power ranking. Balance passes belong on top of that, not baked in here.
 */

import { ParticleKind } from '../particles/kinds';
import type { WeaponDef, WeaponElement, WeaponId } from './weaponDefs';

// ---- Shared weave-weapon stats --------------------------------------------

/** Melee reach, world units. Matches the halved Wooden Sword so the starter reads as the same class of weapon. */
const WEAVE_SWORD_RANGE = 21;
const WEAVE_SWORD_ARC = 1.1;
const WEAVE_SWORD_DAMAGE = 4;
const WEAVE_SWORD_COOLDOWN_MS = 500;
const WEAVE_SWORD_SWING_MS = 260;
const WEAVE_SWORD_KNOCK = 170;

const WEAVE_BOW_DAMAGE = 3;
const WEAVE_BOW_COOLDOWN_MS = 700;
const WEAVE_BOW_SPEED = 460;
const WEAVE_BOW_KNOCK = 120;

/** One dust type and the naming/coloring its two weapons share. */
interface WeaveWeaponTheme {
  dust: ParticleKind;
  /** Id prefix; ids are `${prefix}Blade` and `${prefix}Bow`. */
  prefix: string;
  /** Display name prefix, e.g. "Frostweave". */
  displayPrefix: string;
  element: WeaponElement;
  /** Weapon body color. */
  color: string;
  /** Arrow / highlight color. */
  accentColor: string;
  swordDescription: string;
  bowDescription: string;
}

/**
 * The six equippable dusts, in the same order as `EQUIPPABLE_KINDS`, so the
 * weapon list and the dust wheel read in the same sequence.
 */
const WEAVE_THEMES: readonly WeaveWeaponTheme[] = [
  {
    dust: ParticleKind.Golden,
    prefix: 'goldweave',
    displayPrefix: 'Goldweave',
    element: 'physical',
    color: '#ffd700',
    accentColor: '#fff3b0',
    swordDescription: 'A blade drawn from foundational golden motes. Its guard weaves the same gold into a shield.',
    bowDescription: 'Looses arrows of packed golden dust — the plainest weave, and the steadiest.',
  },
  {
    dust: ParticleKind.Ice,
    prefix: 'frostweave',
    displayPrefix: 'Frostweave',
    element: 'ice',
    color: '#88ccff',
    accentColor: '#dff2ff',
    swordDescription: 'Frost crystals held in the shape of an edge. Its guard freezes into a shield of the same rime.',
    bowDescription: 'Fires shards of frozen dust that bite deeper in the cold.',
  },
  {
    dust: ParticleKind.Nature,
    prefix: 'verdantweave',
    displayPrefix: 'Verdantweave',
    element: 'life',
    color: '#44cc44',
    accentColor: '#bdf5bd',
    swordDescription: 'Living spores bound into a growing blade. Its guard thickens into a verdant shield.',
    bowDescription: 'Shoots seed-darts of living dust that carry on growing after they land.',
  },
  {
    dust: ParticleKind.Void,
    prefix: 'voidweave',
    displayPrefix: 'Voidweave',
    element: 'void',
    color: '#220044',
    accentColor: '#a06cff',
    swordDescription: 'An absence shaped like a sword. Its guard folds the same void into a shield.',
    bowDescription: 'Looses bolts of unstable void dust that distort what they pass.',
  },
  {
    dust: ParticleKind.Light,
    prefix: 'luminantweave',
    displayPrefix: 'Luminantweave',
    element: 'light',
    color: '#fff4b0',
    accentColor: '#ffffff',
    swordDescription: 'Radiance drawn to an edge. Its guard flares into a shield of the same light.',
    bowDescription: 'Fires lances of luminant dust that carry their own illumination.',
  },
  {
    dust: ParticleKind.FireDust,
    prefix: 'emberweave',
    displayPrefix: 'Emberweave',
    element: 'fire',
    color: '#e65515',
    accentColor: '#ffb066',
    swordDescription: 'Embers held just short of scattering. Its guard banks them into a burning shield.',
    bowDescription: 'Looses ember arrows that trail heat behind them.',
  },
];

/** Builds the sword half of a theme. */
function makeWeaveSword(theme: WeaveWeaponTheme): WeaponDef {
  return {
    name: `${theme.displayPrefix} Blade`,
    description: theme.swordDescription,
    kind: 'melee',
    grip: 'oneHand',
    element: theme.element,
    weaveDust: theme.dust,
    secondaryShieldWeave: true,
    dmg: WEAVE_SWORD_DAMAGE,
    range: WEAVE_SWORD_RANGE,
    arc: WEAVE_SWORD_ARC,
    knock: WEAVE_SWORD_KNOCK,
    cooldown: WEAVE_SWORD_COOLDOWN_MS,
    swingDuration: WEAVE_SWORD_SWING_MS,
    color: theme.color,
    highlightColor: theme.accentColor,
  };
}

/** Builds the bow half of a theme. */
function makeWeaveBow(theme: WeaveWeaponTheme): WeaponDef {
  return {
    name: `${theme.displayPrefix} Bow`,
    description: theme.bowDescription,
    kind: 'bow',
    grip: 'twoHand',
    element: theme.element,
    weaveDust: theme.dust,
    projectile: 'arrow',
    dmg: WEAVE_BOW_DAMAGE,
    speed: WEAVE_BOW_SPEED,
    gravity: true,
    knock: WEAVE_BOW_KNOCK,
    cooldown: WEAVE_BOW_COOLDOWN_MS,
    color: theme.color,
    projectileColor: theme.accentColor,
    charge: {
      minMs: 200,
      maxMs: 900,
      minSpeed: WEAVE_BOW_SPEED,
      maxSpeed: 880,
      minDamage: WEAVE_BOW_DAMAGE,
      maxDamage: WEAVE_BOW_DAMAGE * 2,
      minKnock: WEAVE_BOW_KNOCK,
      maxKnock: WEAVE_BOW_KNOCK * 2,
      ttlBonus: 600,
      barColor: theme.color,
    },
  };
}

/** The Wooden Sword and the twelve weave weapons, keyed by id. */
export const STICKBLADE_WEAPON_DATA: Readonly<Record<WeaponId, WeaponDef>> = Object.freeze({
  /**
   * The starter weapon. Not a donor weapon — the donor's nearest equivalent is
   * `sword`, whose 42 reach drew a blade nearly three times the stickman's
   * height; this is that at half length, with a sprite.
   */
  woodenSword: {
    name: 'Wooden Sword',
    kind: 'melee',
    range: 21,
    arc: 1.1,
    dmg: 2,
    cooldown: 550,
    knock: 160,
    color: '#c89d66',
    grip: 'twoHand',
    spriteUrl: 'SPRITES/Weapons/WoodenSword.png',
    spriteGripRatioX: 0.5,
    spriteGripRatioY: 0.9,
  },
  ...Object.fromEntries(
    WEAVE_THEMES.flatMap(theme => [
      [`${theme.prefix}Blade`, makeWeaveSword(theme)],
      [`${theme.prefix}Bow`, makeWeaveBow(theme)],
    ]),
  ),
});

/** Ids of the weave weapons, swords and bows, in dust order. */
export const WEAVE_WEAPON_IDS: readonly WeaponId[] = Object.freeze(
  WEAVE_THEMES.flatMap(theme => [`${theme.prefix}Blade`, `${theme.prefix}Bow`]),
);

/** The dust each weave weapon is woven from, for tests and UI grouping. */
export const WEAVE_WEAPON_DUSTS: readonly ParticleKind[] = Object.freeze(
  WEAVE_THEMES.map(theme => theme.dust),
);
