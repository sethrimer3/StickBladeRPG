/**
 * Editor side of the Block Overlay system: the palette tab, painting onto
 * existing blocks, and persistence of the painted overlay.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

(globalThis as unknown as { localStorage: Storage }).localStorage = {
  _data: new Map<string, string>(),
  getItem(k: string) { return this._data.has(k) ? this._data.get(k)! : null; },
  setItem(k: string, v: string) { this._data.set(k, v); },
  removeItem(k: string) { this._data.delete(k); },
} as unknown as Storage;

import {
  PALETTE_ITEMS, PALETTE_CATEGORIES, PALETTE_CATEGORY_LABELS,
} from '../editor/editorPaletteItems';
import { createEditorState, EditorTool } from '../editor/editorState';
import { placeAtCursor } from '../editor/editorPlaceTool';
import { editorRoomDataToJson } from '../editor/roomJsonSerializer';
import { jsonToEditorRoomData } from '../editor/roomJson';
import { dehydrateRoom } from '../levels/roomSchemaV2';
import { hydrateV2Room } from '../levels/roomSchemaHydrator';
import type { EditorRoomData } from '../editor/editorElementTypes';
import { HALF_BLOCK_NONE } from '../levels/halfBlockGeometry';

function makeRoom(): EditorRoomData {
  return {
    id: 'r', name: 'R', worldNumber: 1, mapX: 0, mapY: 0,
    blockTheme: 'blackRock', backgroundId: 'cave', lightingEffect: 'DEFAULT',
    songId: '_continue', widthBlocks: 20, heightBlocks: 20, playerSpawnBlock: [18, 18],
    interiorWalls: [{
      uid: 1, xBlock: 5, yBlock: 5, wBlock: 2, hBlock: 2,
      isPlatformFlag: 0, platformEdge: 0, halfBlockOrientation: HALF_BLOCK_NONE,
    }],
    enemies: [], transitions: [], saveTombs: [], skillTombs: [], dustContainers: [],
    dustContainerPieces: [], dustBoostJars: [], dustSwarms: [], lambdaAnchors: [],
    dustPiles: [], grasshopperAreas: [], fireflyAreas: [], decorations: [],
    ambientLightBlockers: [], lightSources: [], crumbleBlocks: [], spikes: [],
  } as unknown as EditorRoomData;
}

function paint(itemId: string, bx: number, by: number, room: EditorRoomData) {
  const state = createEditorState();
  state.activeTool = EditorTool.Place;
  state.roomData = room;
  state.selectedPaletteItem = PALETTE_ITEMS.find(i => i.id === itemId)!;
  state.cursorBlockX = bx;
  state.cursorBlockY = by;
  state.brushMode = 'single';
  return placeAtCursor(state);
}

// ── Palette ──────────────────────────────────────────────────────────────────

test('a Block Overlays palette tab exists and is labelled', () => {
  assert.ok(PALETTE_CATEGORIES.includes('blockOverlays'));
  assert.equal(PALETTE_CATEGORY_LABELS.blockOverlays, 'Block Overlays');
});

test('the tab offers Brighten, Grass and None, and every overlay item declares its kind', () => {
  const items = PALETTE_ITEMS.filter(i => i.category === 'blockOverlays');
  assert.deepEqual(items.map(i => i.label).sort(), ['Brighten', 'Grass', 'None']);
  assert.ok(items.every(i => i.blockOverlayKind !== undefined),
    'an overlay item without a kind would place geometry instead of painting');
});

test('overlay items place no geometry — they are not block-placing items', () => {
  const items = PALETTE_ITEMS.filter(i => i.category === 'blockOverlays');
  for (const item of items) {
    assert.equal(item.isPlatformItem, undefined);
    assert.equal(item.isStairsItem, undefined);
    assert.equal(item.isHalfBlockItem, undefined);
  }
});

// ── Painting ─────────────────────────────────────────────────────────────────

test('painting Grass onto a block sets the grass overlay on that wall', () => {
  const room = makeRoom();
  assert.equal(paint('overlay_grass', 5, 5, room), true, 'painting must report a change');
  assert.equal(room.interiorWalls[0].surfaceRim?.kind, 'grass');
});

test('painting Grass places no new geometry', () => {
  const room = makeRoom();
  paint('overlay_grass', 5, 5, room);
  assert.equal(room.interiorWalls.length, 1, 'painting must never add a wall');
});

test('painting Brighten stores an explicit overlay — the highlight is opt-in now', () => {
  const room = makeRoom();
  assert.equal(room.interiorWalls[0].surfaceRim, undefined, 'a fresh block starts bare');

  assert.equal(paint('overlay_brighten', 5, 5, room), true);
  assert.equal(room.interiorWalls[0].surfaceRim?.kind, 'brighten',
    'Brighten must be stored, not inferred — unpainted blocks render no edge');
});

test('painting None erases whatever overlay was there', () => {
  const room = makeRoom();
  paint('overlay_grass', 5, 5, room);
  assert.equal(room.interiorWalls[0].surfaceRim?.kind, 'grass');

  assert.equal(paint('overlay_none', 5, 5, room), true);
  assert.equal(room.interiorWalls[0].surfaceRim, undefined);
});

test('an unpainted block has no overlay, so it renders no edge treatment', () => {
  const room = makeRoom();
  assert.equal(room.interiorWalls[0].surfaceRim, undefined);
});

test('repainting the same overlay reports no change, so no undo entry is recorded', () => {
  const room = makeRoom();
  assert.equal(paint('overlay_grass', 5, 5, room), true);
  assert.equal(paint('overlay_grass', 5, 5, room), false, 'a no-op stroke must report false');
});

test('painting empty space changes nothing', () => {
  const room = makeRoom();
  assert.equal(paint('overlay_grass', 15, 15, room), false);
  assert.equal(room.interiorWalls[0].surfaceRim, undefined);
});

test('painting any cell of a multi-block wall paints the whole wall', () => {
  const room = makeRoom(); // the wall spans blocks (5,5)-(6,6)
  assert.equal(paint('overlay_grass', 6, 6, room), true);
  assert.equal(room.interiorWalls[0].surfaceRim?.kind, 'grass');
});

// ── Persistence ──────────────────────────────────────────────────────────────

test('a painted grass overlay survives the editor -> JSON -> editor round trip', () => {
  const room = makeRoom();
  paint('overlay_grass', 5, 5, room);

  const json = editorRoomDataToJson(room);
  const back = jsonToEditorRoomData(json, 1).data;
  assert.equal(back.interiorWalls[0].surfaceRim?.kind, 'grass');
});

test('a painted grass overlay survives the compact V2 round trip', () => {
  const room = makeRoom();
  paint('overlay_grass', 5, 5, room);

  const rehydrated = hydrateV2Room(dehydrateRoom(editorRoomDataToJson(room)));
  const table = rehydrated.rimStyles ?? [];
  assert.ok(table.length > 0, 'the overlay must be interned into the room style table');
  const wall = rehydrated.interiorWalls.find(w => w.r !== undefined);
  assert.ok(wall, 'the painted wall must reference a style table entry');
});

test('many grass blocks intern to a single style-table entry', () => {
  const room = makeRoom();
  room.interiorWalls.push(
    { uid: 2, xBlock: 9, yBlock: 5, wBlock: 1, hBlock: 1, isPlatformFlag: 0, platformEdge: 0, halfBlockOrientation: HALF_BLOCK_NONE } as never,
    { uid: 3, xBlock: 11, yBlock: 5, wBlock: 1, hBlock: 1, isPlatformFlag: 0, platformEdge: 0, halfBlockOrientation: HALF_BLOCK_NONE } as never,
  );
  paint('overlay_grass', 5, 5, room);
  paint('overlay_grass', 9, 5, room);
  paint('overlay_grass', 11, 5, room);

  const json = editorRoomDataToJson(room);
  assert.equal(json.rimStyles?.length, 1, 'grass must dedup to one entry regardless of block count');
});
