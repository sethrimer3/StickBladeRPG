import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DECORATIVE_OBJECT_OPTIONS,
  getDecorativeObjectOption,
  getDecorativeObjectSpriteUrl,
  isDecorativeObjectAvailable,
} from '../render/decorativeObjects/decorativeObjectCatalogue';
import { dehydrateRoom } from '../levels/roomSchemaV2';
import { hydrateV2Room } from '../levels/roomSchemaHydrator';
import { jsonToEditorRoomData } from '../editor/roomJson';
import { editorRoomDataToJson } from '../editor/roomJsonSerializer';
import { roomJsonDefToRoomDef } from '../levels/roomJsonToRoomDef';
import { applyPropertyToElement } from '../editor/editorPropertyChange';
import { PALETTE_CATEGORIES, PALETTE_CATEGORY_LABELS } from '../editor/editorPaletteItems';
import { getDiscoveredDecorativePaletteItems } from '../editor/editorDropdownData';
import { getLayerForElementType } from '../editor/editorLayers';
import { deleteSelectedElements } from '../editor/editorDeleteTool';
import { applyEdgeResize, applyRoomDimensionChange } from '../editor/editorRoomResize';
import { countEditorRoomDataCategories } from '../editor/editorRoomComplexity';
import { countRoomDefCategories } from '../levels/roomComplexity';
import type { RoomJsonDef } from '../editor/roomJsonSchema';
import { createEditorState, EditorTool } from '../editor/editorState';

test('decorativeObjectCatalogue discovers OakTree1 and provides sprite URLs', () => {
  assert.ok(DECORATIVE_OBJECT_OPTIONS.length > 0, 'Should have at least 1 decorative object');
  const oak = getDecorativeObjectOption('OakTree1');
  assert.ok(oak, 'OakTree1 should be found in catalogue');
  assert.equal(oak.label, 'OakTree1');
  assert.ok(isDecorativeObjectAvailable('OakTree1'));

  const url = getDecorativeObjectSpriteUrl('OakTree1');
  assert.ok(url && url.includes('OakTree1'), 'Sprite URL should contain OakTree1');
});

test('palette categories include decorativeObjects with label', () => {
  assert.ok(PALETTE_CATEGORIES.includes('decorativeObjects'));
  assert.equal(PALETTE_CATEGORY_LABELS.decorativeObjects, 'Decorative Objects');
  assert.equal(getLayerForElementType('decorativeObject'), 'foreground');

  const items = getDiscoveredDecorativePaletteItems();
  assert.ok(items.length > 0);
  assert.ok(items.some(i => i.decorativeObjectType === 'OakTree1'));
});

test('SavedRoomV2 round-trip preserves decorativeObjects with and without pixel offsets', () => {
  const baseJson: RoomJsonDef = {
    id: 'test_room',
    name: 'Test Room',
    worldNumber: 1,
    mapX: 0,
    mapY: 0,
    widthBlocks: 20,
    heightBlocks: 15,
    walls: [],
    interiorWalls: [],
    enemies: [],
    transitions: [],
    saveTombs: [],
    skillTombs: [],
    playerSpawnBlock: [2, 2],
    decorativeObjects: [
      { xBlock: 5, yBlock: 8, objectType: 'OakTree1' },
      { xBlock: 10, yBlock: 12, objectType: 'OakTree1', offsetXPixel: 4, offsetYPixel: -7 },
    ],
  };

  const saved = dehydrateRoom(baseJson);
  assert.ok(saved.decorativeObjects);
  assert.equal(saved.decorativeObjects.length, 2);
  assert.deepEqual(saved.decorativeObjects[0], [5, 8, 'OakTree1']);
  assert.deepEqual(saved.decorativeObjects[1], [10, 12, 'OakTree1', 4, -7]);

  const hydrated = hydrateV2Room(saved);
  assert.ok(hydrated.decorativeObjects);
  assert.equal(hydrated.decorativeObjects.length, 2);
  assert.equal(hydrated.decorativeObjects[0].xBlock, 5);
  assert.equal(hydrated.decorativeObjects[0].yBlock, 8);
  assert.equal(hydrated.decorativeObjects[0].objectType, 'OakTree1');
  assert.equal(hydrated.decorativeObjects[0].offsetXPixel, 0);
  assert.equal(hydrated.decorativeObjects[0].offsetYPixel, 0);

  assert.equal(hydrated.decorativeObjects[1].xBlock, 10);
  assert.equal(hydrated.decorativeObjects[1].yBlock, 12);
  assert.equal(hydrated.decorativeObjects[1].objectType, 'OakTree1');
  assert.equal(hydrated.decorativeObjects[1].offsetXPixel, 4);
  assert.equal(hydrated.decorativeObjects[1].offsetYPixel, -7);
});

test('editorRoomData <-> RoomJsonDef round-trip and RoomDef conversion', () => {
  const json: RoomJsonDef = {
    id: 'room_1',
    name: 'Room 1',
    worldNumber: 1,
    mapX: 0,
    mapY: 0,
    widthBlocks: 30,
    heightBlocks: 20,
    walls: [],
    interiorWalls: [],
    enemies: [],
    transitions: [],
    saveTombs: [],
    skillTombs: [],
    playerSpawnBlock: [1, 1],
    decorativeObjects: [
      { xBlock: 3, yBlock: 4, objectType: 'OakTree1', offsetXPixel: 2, offsetYPixel: -3 },
    ],
  };

  const { data: editorData } = jsonToEditorRoomData(json, 1);
  assert.ok(editorData.decorativeObjects);
  assert.equal(editorData.decorativeObjects.length, 1);
  assert.equal(editorData.decorativeObjects[0].xBlock, 3);
  assert.equal(editorData.decorativeObjects[0].yBlock, 4);
  assert.equal(editorData.decorativeObjects[0].objectType, 'OakTree1');
  assert.equal(editorData.decorativeObjects[0].offsetXPixel, 2);
  assert.equal(editorData.decorativeObjects[0].offsetYPixel, -3);

  const exportedJson = editorRoomDataToJson(editorData);
  assert.ok(exportedJson.decorativeObjects);
  assert.equal(exportedJson.decorativeObjects.length, 1);
  assert.deepEqual(exportedJson.decorativeObjects[0], {
    xBlock: 3,
    yBlock: 4,
    objectType: 'OakTree1',
    offsetXPixel: 2,
    offsetYPixel: -3,
  });

  const roomDef = roomJsonDefToRoomDef(exportedJson);
  assert.ok(roomDef.decorativeObjects);
  assert.equal(roomDef.decorativeObjects.length, 1);
  assert.equal(roomDef.decorativeObjects[0].objectType, 'OakTree1');
  assert.equal(roomDef.decorativeObjects[0].offsetXPixel, 2);
  assert.equal(roomDef.decorativeObjects[0].offsetYPixel, -3);
});

test('applyPropertyToElement clamps offsetXPixel and offsetYPixel to [-8, 8]', () => {
  const json: RoomJsonDef = {
    id: 'test',
    name: 'Test',
    worldNumber: 1,
    mapX: 0,
    mapY: 0,
    widthBlocks: 20,
    heightBlocks: 15,
    walls: [],
    interiorWalls: [],
    enemies: [],
    transitions: [],
    saveTombs: [],
    skillTombs: [],
    playerSpawnBlock: [2, 2],
    decorativeObjects: [
      { xBlock: 5, yBlock: 5, objectType: 'OakTree1', offsetXPixel: 0, offsetYPixel: 0 },
    ],
  };

  const { data: roomData } = jsonToEditorRoomData(json, 100);
  const state = createEditorState();
  state.roomData = roomData;
  state.selectedElements = [{ type: 'decorativeObject', uid: roomData.decorativeObjects![0].uid }];

  // Test offset clamping to +8
  applyPropertyToElement(roomData, state.selectedElements[0], 'decorativeObject.offsetXPixel', 15);
  assert.equal(roomData.decorativeObjects![0].offsetXPixel, 8);

  // Test offset clamping to -8
  applyPropertyToElement(roomData, state.selectedElements[0], 'decorativeObject.offsetXPixel', -20);
  assert.equal(roomData.decorativeObjects![0].offsetXPixel, -8);

  // Test valid shift
  applyPropertyToElement(roomData, state.selectedElements[0], 'decorativeObject.offsetYPixel', 3);
  assert.equal(roomData.decorativeObjects![0].offsetYPixel, 3);
});

test('deleteSelectedElements deletes decorativeObject', () => {
  const json: RoomJsonDef = {
    id: 'test',
    name: 'Test',
    worldNumber: 1,
    mapX: 0,
    mapY: 0,
    widthBlocks: 20,
    heightBlocks: 15,
    walls: [],
    interiorWalls: [],
    enemies: [],
    transitions: [],
    saveTombs: [],
    skillTombs: [],
    playerSpawnBlock: [2, 2],
    decorativeObjects: [
      { xBlock: 5, yBlock: 5, objectType: 'OakTree1' },
      { xBlock: 8, yBlock: 8, objectType: 'OakTree1' },
    ],
  };

  const { data: roomData } = jsonToEditorRoomData(json, 201);
  const state = createEditorState();
  state.roomData = roomData;
  state.selectedElements = [{ type: 'decorativeObject', uid: roomData.decorativeObjects![0].uid }];
  state.activeTool = EditorTool.Delete;

  const deleted = deleteSelectedElements(state);
  assert.equal(deleted, true);
  assert.equal(roomData.decorativeObjects!.length, 1);
  assert.equal(roomData.decorativeObjects![0].uid, 202);
});

test('applyEdgeResize and applyRoomDimensionChange shift and clamp decorativeObjects', () => {
  const json: RoomJsonDef = {
    id: 'test',
    name: 'Test',
    worldNumber: 1,
    mapX: 0,
    mapY: 0,
    widthBlocks: 20,
    heightBlocks: 15,
    walls: [],
    interiorWalls: [],
    enemies: [],
    transitions: [],
    saveTombs: [],
    skillTombs: [],
    playerSpawnBlock: [2, 2],
    decorativeObjects: [
      { xBlock: 18, yBlock: 5, objectType: 'OakTree1' },
    ],
  };

  const { data: roomData } = jsonToEditorRoomData(json, 301);
  const history = { undoStack: [], redoStack: [] };

  // Add 1 block to the left edge (shifts elements right by 1)
  applyEdgeResize(roomData, history, 'left', 1);
  assert.equal(roomData.decorativeObjects![0].xBlock, 19);
  assert.equal(roomData.widthBlocks, 21);

  // Shrink room width from 21 to 10: decorative object at x=19 should clamp to maxX=9
  applyRoomDimensionChange(roomData, 'widthBlocks', 10);
  assert.equal(roomData.widthBlocks, 10);
  assert.equal(roomData.decorativeObjects![0].xBlock, 9);
});

test('room complexity counts include decorativeObjects', () => {
  const json: RoomJsonDef = {
    id: 'test',
    name: 'Test',
    worldNumber: 1,
    mapX: 0,
    mapY: 0,
    widthBlocks: 20,
    heightBlocks: 15,
    walls: [],
    interiorWalls: [],
    enemies: [],
    transitions: [],
    saveTombs: [],
    skillTombs: [],
    playerSpawnBlock: [2, 2],
    decorativeObjects: [
      { xBlock: 5, yBlock: 5, objectType: 'OakTree1' },
      { xBlock: 6, yBlock: 6, objectType: 'OakTree1' },
    ],
  };

  const { data: editorData } = jsonToEditorRoomData(json, 1);
  const edCounts = countEditorRoomDataCategories(editorData);
  assert.equal(edCounts.objects, 2);

  const exportedJson = editorRoomDataToJson(editorData);
  const roomDef = roomJsonDefToRoomDef(exportedJson);
  const defCounts = countRoomDefCategories(roomDef);
  assert.equal(defCounts.objects, 2);
});
