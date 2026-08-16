/**
 * halfBlockGeometry.ts — authoritative definition for half-block walls.
 *
 * A half-block is a wall whose solid area is exactly one half of its authored
 * block extent, on the side named by its orientation:
 *
 *   left   → the left half   (x, y, w/2, h)
 *   right  → the right half  (x + w/2, y, w/2, h)
 *   top    → the top half    (x, y, w, h/2)
 *   bottom → the bottom half (x, y + h/2, w, h/2)
 *
 * Unlike stairs and ramps (see stairsGeometry.ts), a half-block's solid area
 * is still a plain axis-aligned rectangle — it is simply *narrower or shorter*
 * than the block cell it was authored in. That is the whole reason it does not
 * live in the shape-orientation slot alongside stairs/ramps: every collision,
 * grapple and pixel-material consumer can keep treating it as an ordinary
 * rectangle, and only the AABB derivation below has to know about it.
 *
 * This replaces the earlier "half-width pillar" (`isPillarHalfWidthFlag`),
 * which was a boolean that could only ever produce the left half. `left` is
 * byte-for-byte the geometry that flag used to produce.
 *
 * Multi-block extents are supported: the orientation halves the *whole*
 * authored AABB, so a 1×4 half-block with orientation `left` is a 4-tall thin
 * column — the old pillar use-case — while a 4×1 with orientation `bottom` is
 * a long low step.
 */

/** Orientation of the solid half. Stored per-wall; see `HALF_BLOCK_NONE`. */
export type HalfBlockOrientation = 0 | 1 | 2 | 3;

export const HALF_BLOCK_LEFT = 0 as const;
export const HALF_BLOCK_RIGHT = 1 as const;
export const HALF_BLOCK_TOP = 2 as const;
export const HALF_BLOCK_BOTTOM = 3 as const;

/**
 * Sentinel stored in a wall's `halfBlockOrientation` slot meaning "not a half
 * block" — the wall fills its authored extent. Mirrors the
 * `SHAPE_ORIENTATION_NONE` convention in stairsGeometry.ts.
 */
export const HALF_BLOCK_NONE = 255;

/** Stable disk/UI names, indexed by orientation. */
export const HALF_BLOCK_ORIENTATION_NAMES = ['left', 'right', 'top', 'bottom'] as const;

export type HalfBlockOrientationName = (typeof HALF_BLOCK_ORIENTATION_NAMES)[number];

/** True when `value` (from a wall's `halfBlockOrientation`) denotes a half-block. */
export function isHalfBlockOrientation(value: number): boolean {
  return value >= 0 && value <= 3;
}

/** Encodes a disk/UI name to its orientation, or `HALF_BLOCK_NONE` if unrecognized. */
export function encodeHalfBlockOrientation(name: string | undefined | null): number {
  const index = HALF_BLOCK_ORIENTATION_NAMES.indexOf(name as HalfBlockOrientationName);
  return index < 0 ? HALF_BLOCK_NONE : index;
}

/** Decodes an orientation to its disk/UI name, or `undefined` for a non-half-block. */
export function decodeHalfBlockOrientation(value: number): HalfBlockOrientationName | undefined {
  return isHalfBlockOrientation(value) ? HALF_BLOCK_ORIENTATION_NAMES[value] : undefined;
}

/**
 * Orientations in true 90°-clockwise order: a left-half slab rotated a quarter
 * turn clockwise becomes a top-half slab, then a right half, then a bottom
 * half. Used for both placement rotation steps and select-mode rotation, so
 * Q/E move a half-block the way the shape actually turns.
 */
export const HALF_BLOCK_ROTATION_ORDER: readonly HalfBlockOrientation[] = [
  HALF_BLOCK_LEFT, HALF_BLOCK_TOP, HALF_BLOCK_RIGHT, HALF_BLOCK_BOTTOM,
];

/** The orientation reached by rotating `steps` quarter-turns clockwise from left. */
export function halfBlockOrientationForRotationSteps(steps: number): HalfBlockOrientation {
  return HALF_BLOCK_ROTATION_ORDER[((steps % 4) + 4) % 4];
}

/** Advances an orientation one quarter-turn clockwise (see `HALF_BLOCK_ROTATION_ORDER`). */
export function rotateHalfBlockOrientation(value: number): HalfBlockOrientation {
  const index = HALF_BLOCK_ROTATION_ORDER.indexOf(value as HalfBlockOrientation);
  return HALF_BLOCK_ROTATION_ORDER[(Math.max(0, index) + 1) % 4];
}

/** An axis-aligned rectangle, in whatever unit the caller passed in. */
export interface HalfBlockRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * Narrows an authored wall rectangle to its solid half.
 *
 * Unit-agnostic: pass block units or world pixels, get the same unit back.
 * A non-half-block orientation (`HALF_BLOCK_NONE`, or anything out of range)
 * returns the input rectangle unchanged, so callers can apply this
 * unconditionally instead of branching.
 */
export function halfBlockRect(
  x: number, y: number, w: number, h: number, orientation: number,
): HalfBlockRect {
  switch (orientation) {
    case HALF_BLOCK_LEFT:   return { x,           y,           w: w / 2, h };
    case HALF_BLOCK_RIGHT:  return { x: x + w / 2, y,           w: w / 2, h };
    case HALF_BLOCK_TOP:    return { x,           y,           w,        h: h / 2 };
    case HALF_BLOCK_BOTTOM: return { x,           y: y + h / 2, w,        h: h / 2 };
    default:                return { x, y, w, h };
  }
}

/**
 * Converts an authored block-unit wall extent to its solid world-space AABB,
 * applying both the per-axis minimum-size clamp every wall gets and the
 * half-block narrowing.
 *
 * This is the single place the conversion lives, so every wall-loading path
 * (room load, crumble blocks, room-crossing, the offline template baker, the
 * editor's rim preview) produces byte-identical geometry. Order matters: the
 * minimum clamp applies to the FULL extent and the half is taken afterwards,
 * which is what makes a half-block exactly half of the block it sits in.
 */
export function halfBlockWorldRect(
  xBlock: number, yBlock: number, wBlock: number, hBlock: number,
  orientation: number, blockSizePx: number,
): HalfBlockRect {
  return halfBlockRect(
    xBlock * blockSizePx,
    yBlock * blockSizePx,
    Math.max(blockSizePx, wBlock * blockSizePx),
    Math.max(blockSizePx, hBlock * blockSizePx),
    orientation,
  );
}

/** True when the orientation halves the X axis (left/right) rather than the Y axis. */
export function halfBlockSplitsHorizontally(orientation: number): boolean {
  return orientation === HALF_BLOCK_LEFT || orientation === HALF_BLOCK_RIGHT;
}
