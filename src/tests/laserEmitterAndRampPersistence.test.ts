import test from 'node:test';
import assert from 'node:assert/strict';

import type { RoomJsonDef } from '../editor/roomJson';
import { roomJsonDefToRoomDef } from '../levels/roomJsonToRoomDef';
import { createWorldState } from '../sim/world';
import { createReusableSnapshot, refreshSnapshotWorldArrayRefs } from '../render/snapshot';
import { buildWallLayout, wallTileKey } from '../render/walls/blockWallLayoutCache';
import { loadRoomHazards } from '../screens/gameRoomHazards';
import { BLOCK_SIZE_MEDIUM } from '../levels/roomDef';
import { encodeSmoothRampOrientationIndex } from '../levels/stairsGeometry';

function makeBaseRoomJson(overrides: Partial<RoomJsonDef> = {}): RoomJsonDef {
  return {
    id: 'test_laser_ramp_room',
    name: 'Test Laser & Ramp Room',
    worldNumber: 1,
    widthBlocks: 20,
    heightBlocks: 20,
    playerSpawnBlock: [2, 2],
    interiorWalls: [],
    enemies: [],
    transitions: [],
    skillTombs: [],
    ...overrides,
  };
}

test('roomJsonDefToRoomDef preserves smoothRampOrientation, stairsOrientation, and surfaceRim on interior walls', () => {
  const json = makeBaseRoomJson({
    rimStyles: [
      ['s', '00ff00', 4, 0.8],
    ],
    interiorWalls: [
      {
        xBlock: 5,
        yBlock: 6,
        wBlock: 2,
        hBlock: 2,
        smoothRampOrientation: 1,
      },
      {
        xBlock: 8,
        yBlock: 6,
        wBlock: 2,
        hBlock: 2,
        stairsOrientation: 2,
      },
      {
        xBlock: 12,
        yBlock: 6,
        wBlock: 2,
        hBlock: 2,
        r: 0,
      },
    ],
  });

  const roomDef = roomJsonDefToRoomDef(json);
  // Interior walls start after boundary walls (4 boundary walls: top, bottom, left, right)
  const interior = roomDef.walls.filter(w => w.xBlock === 5 || w.xBlock === 8 || w.xBlock === 12);
  assert.equal(interior.length, 3);

  const rampWall = interior.find(w => w.xBlock === 5);
  assert.ok(rampWall);
  assert.equal(rampWall!.smoothRampOrientation, 1);

  const stairsWall = interior.find(w => w.xBlock === 8);
  assert.ok(stairsWall);
  assert.equal(stairsWall!.stairsOrientation, 2);

  const rimWall = interior.find(w => w.xBlock === 12);
  assert.ok(rimWall);
  assert.ok(rimWall!.surfaceRim);
  assert.equal(rimWall!.surfaceRim!.mode, 'solid');
  assert.equal(rimWall!.surfaceRim!.color, '00ff00');
});

test('roomJsonDefToRoomDef preserves bouncePads, crumbleBlocks, kineticBlocks, and ropes', () => {
  const json = makeBaseRoomJson({
    bouncePads: [
      { xBlock: 4, yBlock: 10, wBlock: 2, hBlock: 1, rampOrientation: 0, speedFactorIndex: 1 },
    ],
    crumbleBlocks: [
      { xBlock: 8, yBlock: 10, wBlock: 1, hBlock: 1, smoothRampOrientation: 2, variant: 'cracked' },
    ],
    kineticBlocks: [
      { xBlock: 12, yBlock: 10, wBlock: 2, hBlock: 2 },
    ],
    ropes: [
      { aax: 3, aay: 3, abx: 7, aby: 7, segs: 6, fixed: true, destr: 'indestructible', thick: 1 },
    ],
    dustContainerPieces: [
      { xBlock: 1, yBlock: 1 },
    ],
  });

  const roomDef = roomJsonDefToRoomDef(json);
  assert.equal(roomDef.bouncePads?.length, 1);
  assert.equal(roomDef.bouncePads![0].rampOrientation, 0);
  assert.equal(roomDef.bouncePads![0].speedFactorIndex, 1);

  assert.equal(roomDef.crumbleBlocks?.length, 1);
  assert.equal(roomDef.crumbleBlocks![0].smoothRampOrientation, 2);
  assert.equal(roomDef.crumbleBlocks![0].variant, 'cracked');

  assert.equal(roomDef.kineticBlocks?.length, 1);
  assert.equal(roomDef.ropes?.length, 1);
  assert.equal(roomDef.ropes![0].segmentCount, 6);
  assert.equal(roomDef.dustContainerPieces?.length, 1);
});

test('refreshSnapshotWorldArrayRefs re-points all wall array buffers including isInvisibleFlag and rampOrientationIndex', () => {
  const world = createWorldState(20, 20);
  const snapshot = createReusableSnapshot(world);

  // Set up world 2 with new wall data
  const world2 = createWorldState(20, 20);
  world2.wallCount = 2;
  world2.wallXWorld[0] = 100;
  world2.wallYWorld[0] = 100;
  world2.wallWWorld[0] = 32;
  world2.wallHWorld[0] = 32;
  world2.wallIsInvisibleFlag[0] = 1;
  world2.wallRampOrientationIndex[0] = encodeSmoothRampOrientationIndex(1);

  refreshSnapshotWorldArrayRefs(snapshot, world2);

  assert.equal(snapshot.walls.isInvisibleFlag, world2.wallIsInvisibleFlag);
  assert.equal(snapshot.walls.rampOrientationIndex, world2.wallRampOrientationIndex);
  assert.equal(snapshot.walls.themeIndex, world2.wallThemeIndex);
  assert.equal(snapshot.walls.halfBlockOrientation, world2.wallHalfBlockOrientation);
  assert.equal(snapshot.walls.surfaceRimStyleIndex, world2.wallSurfaceRimStyleIndex);
  assert.equal(snapshot.walls.surfaceRimStyleTable, world2.wallSurfaceRimStyleTable);
});

test('laser invisible beam collision wall is not rendered as solid blocks in buildWallLayout', () => {
  const json = makeBaseRoomJson({
    lasers: [
      { xBlock: 5, yBlock: 5, direction: 'right' },
    ],
    interiorWalls: [
      // Wall for laser to hit at x=10
      { xBlock: 10, yBlock: 0, wBlock: 1, hBlock: 20 },
    ],
  });

  const roomDef = roomJsonDefToRoomDef(json);
  const world = createWorldState(20, 20);

  // Add boundary and interior walls into world
  for (const w of roomDef.walls) {
    const wi = world.wallCount++;
    world.wallXWorld[wi] = w.xBlock * BLOCK_SIZE_MEDIUM;
    world.wallYWorld[wi] = w.yBlock * BLOCK_SIZE_MEDIUM;
    world.wallWWorld[wi] = w.wBlock * BLOCK_SIZE_MEDIUM;
    world.wallHWorld[wi] = w.hBlock * BLOCK_SIZE_MEDIUM;
    world.wallIsInvisibleFlag[wi] = 0;
    world.wallRampOrientationIndex[wi] = 255;
  }

  loadRoomHazards(world, roomDef);

  // Verify a laser wall was added with isInvisibleFlag = 1
  assert.equal(world.laserCount, 1);
  const laserWallIdx = world.wallCount - 1;
  assert.equal(world.wallIsInvisibleFlag[laserWallIdx], 1);

  const snapshot = createReusableSnapshot(world);
  const layout = buildWallLayout(snapshot.walls, BLOCK_SIZE_MEDIUM, 20, 20, 'test_sig');

  // The laser beam spans cells between xBlock=5 and xBlock=10 at yBlock=5.
  // Verify that NONE of the laser beam cells (e.g., cell (6, 5), (7, 5), (8, 5), (9, 5)) are in occupied set
  assert.equal(layout.occupied.has(wallTileKey(6, 5)), false, 'cell (6, 5) must not be an occupied solid wall tile');
  assert.equal(layout.occupied.has(wallTileKey(7, 5)), false, 'cell (7, 5) must not be an occupied solid wall tile');
  assert.equal(layout.occupied.has(wallTileKey(8, 5)), false, 'cell (8, 5) must not be an occupied solid wall tile');
  assert.equal(layout.occupied.has(wallTileKey(9, 5)), false, 'cell (9, 5) must not be an occupied solid wall tile');
});

test('smooth ramp is preserved in snapshot and correctly categorized as a shaped wall in buildWallLayout', () => {
  const json = makeBaseRoomJson({
    interiorWalls: [
      { xBlock: 4, yBlock: 4, wBlock: 1, hBlock: 1, smoothRampOrientation: 1 },
    ],
  });

  const roomDef = roomJsonDefToRoomDef(json);
  const world = createWorldState(20, 20);

  let rampWallIndex = -1;
  for (const w of roomDef.walls) {
    const wi = world.wallCount++;
    world.wallXWorld[wi] = w.xBlock * BLOCK_SIZE_MEDIUM;
    world.wallYWorld[wi] = w.yBlock * BLOCK_SIZE_MEDIUM;
    world.wallWWorld[wi] = w.wBlock * BLOCK_SIZE_MEDIUM;
    world.wallHWorld[wi] = w.hBlock * BLOCK_SIZE_MEDIUM;
    world.wallIsInvisibleFlag[wi] = 0;
    world.wallRampOrientationIndex[wi] = w.smoothRampOrientation !== undefined
      ? encodeSmoothRampOrientationIndex(w.smoothRampOrientation)
      : 255;
    if (w.smoothRampOrientation !== undefined) {
      rampWallIndex = wi;
    }
  }

  const snapshot = createReusableSnapshot(world);
  const layout = buildWallLayout(snapshot.walls, BLOCK_SIZE_MEDIUM, 20, 20, 'test_sig_ramp');

  // The ramp at (4, 4) should be recorded in shapedWalls, not occupied as a standard block
  assert.equal(layout.occupied.has(wallTileKey(4, 4)), false, 'smooth ramp must not be marked in standard occupied grid');
  assert.ok(layout.shapedWalls.length >= 1, 'shapedWalls must contain the smooth ramp');
  assert.ok(layout.shapedWalls.some(sw => sw.wallIndex === rampWallIndex), 'shapedWalls must reference the ramp wall index');
  assert.equal(snapshot.walls.rampOrientationIndex[rampWallIndex], encodeSmoothRampOrientationIndex(1));
});

