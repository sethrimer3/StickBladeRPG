/**
 * Level definition types for StickBlade.
 *
 * Positions and sizes are expressed as fractions of the screen dimensions
 * (0–1) so layouts scale to any resolution.  The game screen converts them
 * to world units at load time.
 */

import { ParticleKind } from '../sim/particles/kinds';

/** Defines a single enemy cluster within a level. */
export interface EnemyDef {
  /** Horizontal position as a fraction of the world width (0 = left, 1 = right). */
  xFraction: number;
  /** Vertical position as a fraction of the world height (0 = top, 1 = bottom). */
  yFraction: number;
  /** Particle kinds composing this enemy. */
  kinds: ParticleKind[];
  /** Total number of particles this enemy starts with. */
  particleCount: number;
  /** When 1, this enemy is a boss — larger, tougher, with more particles. */
  isBossFlag: 0 | 1;
}

/** Defines an axis-aligned wall rectangle in a level. */
export interface WallDef {
  /** Left edge as a fraction of world width. */
  xFraction: number;
  /** Top edge as a fraction of world height. */
  yFraction: number;
  /** Width as a fraction of world width. */
  wFraction: number;
  /** Height as a fraction of world height. */
  hFraction: number;
}

/** Defines a door rectangle and its destination semantics for a level. */
export interface DoorDef {
  xFraction: number;
  yFraction: number;
  wFraction: number;
  hFraction: number;
  /** "next" moves forward in campaign flow, "menu" returns to main menu. */
  target: 'next' | 'menu';
}

/** Visual theme used for background tinting and atmospheric effects. */
export type LevelTheme = 'physical' | 'water' | 'ice' | 'boss' | 'fire' | 'lava' | 'stone' | 'metal';

/** Map node positioning and topology metadata ported from STICK-RPG. */
export interface LevelMapNodeDef {
  x: number;
  y: number;
  branch?: string;
  branchStep?: number;
  stageCode?: string;
  order?: string;
  label?: string;
  boss?: boolean;
  optional?: boolean;
  standalone?: boolean;
  requiresStages?: readonly string[] | string[];
  parent?: string;
  color?: string;
  description?: string;
}

/** Boss stage encounter details. */
export interface LevelBossDef {
  name: string;
  kind: string;
  hp: number;
  weapon?: string;
  attack: number;
  defense: number;
  description?: string;
  element?: string;
  isBoss?: boolean;
}

/** Full definition for a single game level. */
export interface LevelDef {
  id?: string;
  worldNumber: number;
  levelNumber: number;
  /** Display name shown on the world map and during gameplay. */
  name: string;
  theme: LevelTheme;
  description?: string;
  enemies: EnemyDef[];
  walls: WallDef[];
  /** Player spawn door for the level. */
  entryDoor: DoorDef;
  /** Exit door used to move to next screen / main menu. */
  exitDoor: DoorDef;
  mapNode?: LevelMapNodeDef;
  stageCount?: number;
  boss?: LevelBossDef;
  difficultyMultiplier?: number;
  unlockRequires?: readonly string[] | string[];
}

import { getWorldDifficultyMultiplier } from './rooms';

/**
 * Computes level/zone difficulty scaling multiplier.
 */
export function computeLevelDifficultyMultiplier(def: Partial<LevelDef>): number {
  if (!def) return 1;
  if (typeof def.difficultyMultiplier === 'number' && Number.isFinite(def.difficultyMultiplier) && def.difficultyMultiplier > 0) {
    return def.difficultyMultiplier;
  }
  const id = def.id ?? '';
  const name = def.name ?? '';

  if (id === 'canopySentinelTrial' || /canopy\s+sentinel\s+trial/i.test(name)) {
    return 10;
  }
  if (/chrono(?:glass|graph)\s+expanse/i.test(name)) {
    return 50;
  }

  const map = def.mapNode;
  if (map) {
    if (map.branch) {
      const match = /^world(\d+)$/.exec(map.branch);
      if (match) {
        const worldNum = parseInt(match[1], 10);
        return getWorldDifficultyMultiplier(worldNum);
      }
    }
    if (map.stageCode) {
      const match = /^(\d+)-(\d+)$/.exec(map.stageCode);
      if (match) {
        const w = parseInt(match[1], 10);
        return getWorldDifficultyMultiplier(w);
      }
    }
  }

  if (Number.isFinite(def.worldNumber)) {
    return getWorldDifficultyMultiplier(def.worldNumber!);
  }

  return 1;
}
