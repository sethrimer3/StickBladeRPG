import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  syncCampaignSpawnBlockFromSession,
  placeCampaignSpawn,
  CampaignSpawnContext,
} from '../editor/editorCampaignSpawn';
import { createEditorState } from '../editor/editorState';
import type { EditorRoomData } from '../editor/editorElementTypes';
import type { EditableCampaignSession } from '../editor/editableCampaignSession';
import { CampaignSpawnData, SavedCampaignV1 } from '../levels/campaignSchema';

describe('Campaign Spawn Editor Starting Options', () => {
  function makeMockSession(campaignSpawn?: CampaignSpawnData): EditableCampaignSession {
    const campaign: SavedCampaignV1 = {
      v: 1,
      kind: 'StickBladeCampaign',
      campaign: {
        id: 'camp1',
        title: 'Camp',
        creator: 'test',
        description: '',
        initialRoomId: 'room1',
        initialRoomImagePath: null,
        campaignSpawn,
      },
      worldMap: { worlds: [], rooms: [] },
      rooms: [
        { v: 2, id: 'room1', name: 'Room 1', world: 0, size: [10, 10], spawn: [1, 1], solids: {} } as unknown as SavedCampaignV1['rooms'][number],
      ],
      editor: { createdWithBuild: '1', lastEditedIso: new Date().toISOString() },
    };
    return {
      campaign,
      filePath: 'c:/test.sbcampaign.json',
      isDirty: false,
      validationWarnings: [],
    } as unknown as EditableCampaignSession;
  }

  function makeMockRoom(id: string): EditorRoomData {
    return {
      id,
      name: id,
      worldNumber: 0,
      mapX: 0,
      mapY: 0,
      blockTheme: 'blackRock',
      backgroundId: 'cave',
      lightingEffect: 'DEFAULT',
      songId: '_continue',
      widthBlocks: 10,
      heightBlocks: 10,
      playerSpawnBlock: [1, 1],
      interiorWalls: [],
      enemies: [],
      transitions: [],
      saveTombs: [],
      skillTombs: [],
      dustContainers: [],
      dustContainerPieces: [],
      dustBoostJars: [],
      dustSwarms: [],
      lambdaAnchors: [],
      dustPiles: [],
      grasshopperAreas: [],
      fireflyAreas: [],
      decorations: [],
      ambientLightBlockers: [],
      lightSources: [],
      backgroundBlocks: [],
    } as unknown as EditorRoomData;
  }

  test('syncCampaignSpawnBlockFromSession correctly hydrates startingStats, startingAbilities, and startingWeapon', () => {
    const state = createEditorState();
    state.roomData = makeMockRoom('room1');
    const session = makeMockSession({
      roomId: 'room1',
      xBlock: 4,
      yBlock: 6,
      startingStats: { level: 3, maxHealthBase: 80, attackBase: 5, defenseBase: 2, xp: 10, xpToNextLevel: 100, skillPoints: 1 },
      startingAbilities: ['doubleJump', 'grapple'],
      startingWeapon: 'longBow',
    });

    const ctx: CampaignSpawnContext = {
      state,
      campaignSession: session,
      uiRoot: {} as HTMLElement,
    };
    syncCampaignSpawnBlockFromSession(ctx);

    assert.deepEqual(state.campaignSpawnBlock, [4, 6]);
    assert.ok(state.campaignSpawnStartingOptions);
    assert.deepEqual(state.campaignSpawnStartingOptions.startingStats, {
      level: 3,
      maxHealthBase: 80,
      attackBase: 5,
      defenseBase: 2,
      xp: 10,
      xpToNextLevel: 100,
      skillPoints: 1,
    });
    assert.deepEqual(state.campaignSpawnStartingOptions.startingAbilities, ['doubleJump', 'grapple']);
    assert.equal(state.campaignSpawnStartingOptions.startingWeapon, 'longBow');
  });

  test('placeCampaignSpawn preserves startingStats, startingAbilities, and startingWeapon', () => {
    const state = createEditorState();
    state.roomData = makeMockRoom('room1');
    const session = makeMockSession({
      roomId: 'room1',
      xBlock: 4,
      yBlock: 6,
      startingStats: { level: 4, maxHealthBase: 90 },
      startingAbilities: ['swim'],
      startingWeapon: 'woodenSword',
    });

    const ctx: CampaignSpawnContext = {
      state,
      campaignSession: session,
      uiRoot: {} as HTMLElement,
    };
    placeCampaignSpawn(ctx, 7, 8);

    assert.deepEqual(state.campaignSpawnBlock, [7, 8]);
    assert.deepEqual(session.campaign.campaign.campaignSpawn, {
      roomId: 'room1',
      xBlock: 7,
      yBlock: 8,
      startingStats: { level: 4, maxHealthBase: 90 },
      startingAbilities: ['swim'],
      startingWeapon: 'woodenSword',
      startingHealth: undefined,
      startingDustContainerCount: undefined,
      startingDustTypes: undefined,
      startingWeaves: undefined,
      startingPassives: undefined,
    });
  });
});
