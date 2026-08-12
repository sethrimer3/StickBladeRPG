/**
 * gridPathfinding.ts — 2D block grid pathfinding for platformer AI & stickmen.
 *
 * Deterministic, allocation-free / bounded A* pathfinder that plans paths
 * over 8-pixel block coordinates using the room's `SolidMask`.
 *
 * Understands:
 *   • Flat walking across continuous solid floors.
 *   • Stepping / jumping up 1–2 block ledges.
 *   • Walking / dropping down off ledges (up to 6 blocks).
 *   • Jumping across 2–3 block horizontal floor gaps.
 */

import type { SolidMask } from '../pixelMaterials/pixelMaterialSolid';

/** Block dimension in world units (native pixels). */
export const PATH_BLOCK_SIZE = 8;

export type PathAction = 'walk' | 'jump' | 'drop';

export interface PathWaypoint {
  blockX: number;
  blockY: number;
  action: PathAction;
}

export interface PathfindingOptions {
  /** Maximum search nodes to explore before terminating (default 500). */
  maxNodesExplored?: number;
  /** Maximum drop distance in blocks allowed without taking damage (default 6). */
  maxDropBlocks?: number;
  /** Maximum jump height in blocks (default 3). */
  maxJumpHeightBlocks?: number;
  /** Maximum jump horizontal gap in blocks (default 3). */
  maxJumpGapBlocks?: number;
}

const DEFAULT_MAX_NODES = 500;
const DEFAULT_MAX_DROP = 6;
const DEFAULT_MAX_JUMP_HEIGHT = 2;
const DEFAULT_MAX_JUMP_GAP = 3;

/**
 * Checks whether a block coordinate is solid.
 * Queries the center pixel of the 8x8 block.
 */
export function isBlockSolid(solid: SolidMask | null, blockX: number, blockY: number): boolean {
  if (solid === null) return false;
  if (blockY < 0) return false; // Sky above room is open air
  const px = blockX * PATH_BLOCK_SIZE + 4;
  const py = blockY * PATH_BLOCK_SIZE + 4;
  if (px < 0 || px >= solid.widthPx || py >= solid.heightPx) return true;
  return solid.isSolid(px, py);
}

/**
 * Checks whether a block coordinate is a valid standing position.
 * A standing position requires:
 * 1. The foot block (bx, by) is empty (air).
 * 2. The block directly beneath (bx, by + 1) is solid ground.
 * 3. The head block (bx, by - 1) is empty (air clearance).
 */
export function isStandable(solid: SolidMask | null, blockX: number, blockY: number): boolean {
  if (solid === null) return false;
  if (blockY < 0) return false;
  const floorBelow = isBlockSolid(solid, blockX, blockY + 1);
  if (!floorBelow) return false;
  const feetAir = !isBlockSolid(solid, blockX, blockY);
  if (!feetAir) return false;
  const headAir = blockY === 0 ? true : !isBlockSolid(solid, blockX, blockY - 1);
  return headAir;
}

/**
 * Finds the nearest standable block coordinate to (targetX, targetY).
 */
export function findNearestStandableBlock(
  solid: SolidMask | null,
  targetX: number,
  targetY: number,
  searchRadius = 6,
): { blockX: number; blockY: number } | null {
  if (solid === null) return { blockX: targetX, blockY: targetY };
  if (isStandable(solid, targetX, targetY)) {
    return { blockX: targetX, blockY: targetY };
  }

  let bestDistSq = Infinity;
  let bestX = targetX;
  let bestY = targetY;
  let found = false;

  for (let dy = -searchRadius; dy <= searchRadius; dy++) {
    for (let dx = -searchRadius; dx <= searchRadius; dx++) {
      const bx = targetX + dx;
      const by = targetY + dy;
      if (isStandable(solid, bx, by)) {
        const dSq = dx * dx + dy * dy;
        if (dSq < bestDistSq) {
          bestDistSq = dSq;
          bestX = bx;
          bestY = by;
          found = true;
        }
      }
    }
  }

  return found ? { blockX: bestX, blockY: bestY } : null;
}

interface SearchNode {
  blockX: number;
  blockY: number;
  gCost: number;
  fCost: number;
  parentIndex: number;
  action: PathAction;
}

// Scratch structures for zero-allocation searches
const MAX_SEARCH_POOL_SIZE = 1000;
const _nodePool: SearchNode[] = [];
for (let i = 0; i < MAX_SEARCH_POOL_SIZE; i++) {
  _nodePool.push({ blockX: 0, blockY: 0, gCost: 0, fCost: 0, parentIndex: -1, action: 'walk' });
}

function keyFor(bx: number, by: number): string {
  return `${bx},${by}`;
}

/**
 * Calculates Manhattan heuristic with slight vertical penalty.
 */
function heuristic(x1: number, y1: number, x2: number, y2: number): number {
  const dx = Math.abs(x1 - x2);
  const dy = Math.abs(y1 - y2);
  return dx + dy * 1.5;
}

/**
 * Finds a path from (startBlockX, startBlockY) to (targetBlockX, targetBlockY).
 * Returns an array of waypoints or empty array if no path is found.
 */
export function findGridPath(
  solid: SolidMask | null,
  startBlockX: number,
  startBlockY: number,
  targetBlockX: number,
  targetBlockY: number,
  options?: PathfindingOptions,
): PathWaypoint[] {
  if (solid === null) {
    return [{ blockX: targetBlockX, blockY: targetBlockY, action: 'walk' }];
  }

  const maxNodes = options?.maxNodesExplored ?? DEFAULT_MAX_NODES;
  const maxDrop = options?.maxDropBlocks ?? DEFAULT_MAX_DROP;
  const maxJumpHeight = options?.maxJumpHeightBlocks ?? DEFAULT_MAX_JUMP_HEIGHT;
  const maxJumpGap = options?.maxJumpGapBlocks ?? DEFAULT_MAX_JUMP_GAP;

  // Resolve valid start and target standable blocks
  let startX = startBlockX;
  let startY = startBlockY;
  if (!isStandable(solid, startX, startY)) {
    const adjustedStart = findNearestStandableBlock(solid, startX, startY, 4);
    if (adjustedStart) {
      startX = adjustedStart.blockX;
      startY = adjustedStart.blockY;
    }
  }

  let endX = targetBlockX;
  let endY = targetBlockY;
  if (!isStandable(solid, endX, endY)) {
    const adjustedEnd = findNearestStandableBlock(solid, endX, endY, 6);
    if (adjustedEnd) {
      endX = adjustedEnd.blockX;
      endY = adjustedEnd.blockY;
    }
  }

  if (startX === endX && startY === endY) {
    return [{ blockX: endX, blockY: endY, action: 'walk' }];
  }

  const openList: number[] = []; // indices into _nodePool
  const closedSet = new Set<string>();
  const gScores = new Map<string, number>();

  let poolIndex = 0;
  function allocNode(bx: number, by: number, g: number, f: number, parent: number, action: PathAction): number {
    if (poolIndex >= MAX_SEARCH_POOL_SIZE) return -1;
    const idx = poolIndex++;
    const node = _nodePool[idx];
    node.blockX = bx;
    node.blockY = by;
    node.gCost = g;
    node.fCost = f;
    node.parentIndex = parent;
    node.action = action;
    return idx;
  }

  const startH = heuristic(startX, startY, endX, endY);
  const startIdx = allocNode(startX, startY, 0, startH, -1, 'walk');
  if (startIdx < 0) return [];
  openList.push(startIdx);
  gScores.set(keyFor(startX, startY), 0);

  let bestNodeIdx = startIdx;
  let bestDistance = startH;
  let iterations = 0;

  while (openList.length > 0 && iterations < maxNodes) {
    iterations++;

    // Find node with lowest fCost
    let bestOpenPos = 0;
    let minFCost = _nodePool[openList[0]].fCost;
    for (let i = 1; i < openList.length; i++) {
      const idx = openList[i];
      if (_nodePool[idx].fCost < minFCost) {
        minFCost = _nodePool[idx].fCost;
        bestOpenPos = i;
      }
    }

    const currentIdx = openList.splice(bestOpenPos, 1)[0];
    const current = _nodePool[currentIdx];
    const curKey = keyFor(current.blockX, current.blockY);

    // Check goal reached
    if (current.blockX === endX && current.blockY === endY) {
      bestNodeIdx = currentIdx;
      break;
    }

    closedSet.add(curKey);

    const distToGoal = heuristic(current.blockX, current.blockY, endX, endY);
    if (distToGoal < bestDistance) {
      bestDistance = distToGoal;
      bestNodeIdx = currentIdx;
    }

    const cx = current.blockX;
    const cy = current.blockY;

    // Explore neighbors
    // 1. Walk Left & Right
    const sideDirs = [-1, 1];
    for (const dir of sideDirs) {
      const nx = cx + dir;
      // Flat walk
      if (isStandable(solid, nx, cy)) {
        addNeighbor(nx, cy, current.gCost + 1.0, currentIdx, 'walk');
      }

      // Step up / Jump up (dy from 1 to maxJumpHeight)
      for (let jumpDy = 1; jumpDy <= maxJumpHeight; jumpDy++) {
        const upY = cy - jumpDy;
        // Head clearance at current column and target column
        let clearance = true;
        for (let y = cy - 1; y >= upY; y--) {
          if (isBlockSolid(solid, cx, y) || isBlockSolid(solid, nx, y)) {
            clearance = false;
            break;
          }
        }
        if (clearance && isStandable(solid, nx, upY)) {
          addNeighbor(nx, upY, current.gCost + 1.5 + jumpDy * 0.5, currentIdx, 'jump');
        }
      }

      // Drop down off ledge (dy from 1 to maxDrop)
      for (let dropDy = 1; dropDy <= maxDrop; dropDy++) {
        const downY = cy + dropDy;
        // Check column nx is air until ground at downY + 1
        let airPath = true;
        for (let y = cy; y <= downY; y++) {
          if (isBlockSolid(solid, nx, y)) {
            airPath = false;
            break;
          }
        }
        if (airPath && isStandable(solid, nx, downY)) {
          addNeighbor(nx, downY, current.gCost + 1.0 + dropDy * 0.4, currentIdx, 'drop');
          break; // Stop after first floor reached in this drop column
        }
      }

      // Jump horizontal gap (gap dx 2 to maxJumpGap)
      for (let gapDx = 2; gapDx <= maxJumpGap; gapDx++) {
        const gx = cx + dir * gapDx;
        for (let gapDy = -1; gapDy <= 1; gapDy++) {
          const gy = cy + gapDy;
          if (isStandable(solid, gx, gy)) {
            // Check arc clearance
            let arcClear = true;
            for (let step = 1; step < gapDx; step++) {
              const testX = cx + dir * step;
              if (isBlockSolid(solid, testX, cy) || isBlockSolid(solid, testX, cy - 1)) {
                arcClear = false;
                break;
              }
            }
            if (arcClear) {
              addNeighbor(gx, gy, current.gCost + 2.0 + gapDx * 0.5, currentIdx, 'jump');
            }
          }
        }
      }
    }
  }

  function addNeighbor(nx: number, ny: number, gCost: number, parentIdx: number, action: PathAction): void {
    const key = keyFor(nx, ny);
    if (closedSet.has(key)) return;

    const existingG = gScores.get(key);
    if (existingG !== undefined && gCost >= existingG) return;

    gScores.set(key, gCost);
    const fCost = gCost + heuristic(nx, ny, endX, endY);
    const nodeIdx = allocNode(nx, ny, gCost, fCost, parentIdx, action);
    if (nodeIdx >= 0) {
      openList.push(nodeIdx);
    }
  }

  // Reconstruct path from bestNodeIdx backwards to start
  const path: PathWaypoint[] = [];
  let curr = bestNodeIdx;
  while (curr !== -1) {
    const node = _nodePool[curr];
    path.push({
      blockX: node.blockX,
      blockY: node.blockY,
      action: node.action,
    });
    curr = node.parentIndex;
  }

  path.reverse();
  // If start node is at index 0, we keep waypoints (or slice start if already there)
  if (path.length > 1 && path[0].blockX === startX && path[0].blockY === startY) {
    path.shift();
  }

  return path;
}
