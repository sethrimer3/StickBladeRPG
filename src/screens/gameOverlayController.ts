import type { RoomDef } from '../levels/roomDef';
import type { PlayerProgress } from '../progression/playerProgress';
import type { SkillTombRenderer } from '../render/skillTombRenderer';
import type { WorldState } from '../sim/world';
import { showDeathScreen } from '../ui/deathScreen';
import { showMapOnlyModal, showSkillTombMenu } from '../ui/skillTombMenu';
import { showInventoryPanel } from '../ui/inventoryPanel';
import { getActiveMember } from '../sim/party/partyState';
import { syncPlayerHandsFromEquipment } from '../sim/weapons/playerWeaponState';
import {
  executeGameDeathRespawn,
  type GameDeathRespawnPorts,
} from './gameDeathRespawnCoordinator';
import {
  applySkillTombActivation,
  type SkillTombActivationPorts,
} from './gameSkillTombActivation';

export interface GameOverlayControllerState {
  isPlayerDead: boolean;
  isSkillTombMenuOpen: boolean;
  isMapOnlyOpen: boolean;
  isInventoryOpen: boolean;
}

interface CreateGameOverlayControllerParams {
  uiRoot: HTMLElement;
  getWorld: () => WorldState;
  roomRegistry: ReadonlyMap<string, RoomDef>;
  progress?: PlayerProgress;
  campaignSpawnRoom: RoomDef;
  campaignSpawnBlock: readonly [number, number];
  skillTombRenderer: SkillTombRenderer;
  getCurrentRoom: () => RoomDef;
  getCurrentRoomOrigin: () => readonly [number, number];
  loadRoom: (room: RoomDef, spawnXBlock: number, spawnYBlock: number) => void;
  onResetTransitionReveal: () => void;
  onResetFrameClock: () => void;
  onExitToMainMenu: () => void;
  onSave?: () => void;
  /** Called when the player activates a save point so the checkpoint timer can be snapshotted. */
  onCheckpointReached?: () => void;
  /** Called after respawn so the timer can be restored to the checkpoint value. */
  onRespawn?: () => void;
}

export interface GameOverlayController {
  state: GameOverlayControllerState;
  showPlayerDeathScreen: () => void;
  openSkillTombMenu: () => void;
  openMapOnly: () => void;
  openInventory: () => void;
  destroy: () => void;
}

export function createGameOverlayController(
  params: CreateGameOverlayControllerParams,
): GameOverlayController {
  const {
    uiRoot,
    getWorld,
    roomRegistry,
    progress,
    campaignSpawnRoom,
    campaignSpawnBlock,
    skillTombRenderer,
    getCurrentRoom,
    getCurrentRoomOrigin,
    loadRoom,
    onResetTransitionReveal,
    onResetFrameClock,
    onExitToMainMenu,
    onSave,
    onCheckpointReached,
    onRespawn,
  } = params;

  const state: GameOverlayControllerState = {
    isPlayerDead: false,
    isSkillTombMenuOpen: false,
    isMapOnlyOpen: false,
    isInventoryOpen: false,
  };

  let deathScreenCleanup: (() => void) | null = null;
  let skillTombMenuCleanup: (() => void) | null = null;
  let mapOnlyCleanup: (() => void) | null = null;
  let inventoryCleanup: (() => void) | null = null;

  const skillTombActivationPorts: SkillTombActivationPorts = {
    getCurrentRoomOrigin,
    getCurrentRoomId: () => getCurrentRoom().id,
    getNearbyTombIndex: (localXWorld, localYWorld) => (
      skillTombRenderer.getNearbyTombIndex(localXWorld, localYWorld)
    ),
    getTombPosition: (index) => skillTombRenderer.getTombPosition(index),
    onCheckpointReached,
    onSave,
  };

  const deathRespawnPorts: GameDeathRespawnPorts = {
    getRoomById: (roomId) => roomRegistry.get(roomId),
    loadRoom,
    resetTransitionReveal: onResetTransitionReveal,
    resetFrameClock: onResetFrameClock,
    onRespawn,
  };

  function closeMapOnlyIfOpen(): void {
    if (mapOnlyCleanup === null) return;
    mapOnlyCleanup();
    mapOnlyCleanup = null;
    state.isMapOnlyOpen = false;
  }

  function showPlayerDeathScreen(): void {
    if (state.isPlayerDead) return;
    state.isPlayerDead = true;
    deathScreenCleanup = showDeathScreen(uiRoot, {
      onReturnToLastSave: () => {
        state.isPlayerDead = false;
        deathScreenCleanup = null;
        executeGameDeathRespawn(progress, campaignSpawnRoom, campaignSpawnBlock, deathRespawnPorts);
      },
      onReturnToMainMenu: () => {
        state.isPlayerDead = false;
        deathScreenCleanup = null;
        onExitToMainMenu();
      },
    });
  }

  function openSkillTombMenu(): void {
    if (state.isSkillTombMenuOpen || progress === undefined) return;
    closeMapOnlyIfOpen();
    state.isSkillTombMenuOpen = true;

    const world = getWorld();
    const activation = applySkillTombActivation(world, progress, skillTombActivationPorts);

    skillTombMenuCleanup = showSkillTombMenu(
      uiRoot,
      progress,
      getCurrentRoom().id,
      activation.playerXWorld,
      activation.playerYWorld,
      activation.playerHealthPoints,
      activation.playerMaxHealthPoints,
      {
        onClose: (updatedLoadout, updatedWeaveLoadout) => {
          state.isSkillTombMenuOpen = false;
          skillTombMenuCleanup = null;
          progress.loadout = updatedLoadout;
          progress.weaveLoadout = updatedWeaveLoadout;
          onResetFrameClock();
          if (onSave) onSave();
        },
        onTeleport: (roomId, xBlock, yBlock) => {
          state.isSkillTombMenuOpen = false;
          skillTombMenuCleanup = null;
          const targetRoom = roomRegistry.get(roomId);
          if (!targetRoom) return;
          // Update last save point to the teleport destination
          progress.lastSaveRoomId = roomId;
          progress.lastSaveSpawnBlock = [xBlock, yBlock];
          loadRoom(targetRoom, xBlock, yBlock);
          onResetTransitionReveal();
          onResetFrameClock();
          if (onSave) onSave();
        },
      },
    );
  }

  function openMapOnly(): void {
    if (state.isMapOnlyOpen || state.isSkillTombMenuOpen || progress === undefined) return;
    const world = getWorld();
    const player = world.clusters[0];
    if (player === undefined) return;
    state.isMapOnlyOpen = true;
    mapOnlyCleanup = showMapOnlyModal(
      uiRoot,
      progress,
      getCurrentRoom().id,
      player.positionXWorld,
      player.positionYWorld,
      {
        onClose: () => {
          state.isMapOnlyOpen = false;
          mapOnlyCleanup = null;
          onResetFrameClock();
        },
      },
    );
  }

  /**
   * Opens the inventory screen.
   *
   * Refused while another overlay owns the screen, and while the player is
   * dead — the death screen is modal and its respawn rebuilds the world the
   * inventory would be editing against.
   */
  function openInventory(): void {
    if (state.isInventoryOpen || state.isPlayerDead) return;
    if (state.isSkillTombMenuOpen || state.isMapOnlyOpen) return;
    if (progress === undefined) return;

    const world = getWorld();
    const inventory = progress.inventory;
    const party = progress.party;
    // Both are backfilled by `sanitizePlayerInventory` / `sanitizePlayerPartyState`
    // on load and on every room activation, so this only trips if the screen is
    // somehow reached before a room has been loaded.
    if (inventory === undefined || party === undefined) return;

    const player = world.clusters[0];
    state.isInventoryOpen = true;

    inventoryCleanup = showInventoryPanel(
      uiRoot,
      {
        inventory,
        party,
        healthPoints: player?.healthPoints,
        maxHealthPoints: player?.maxHealthPoints,
        unlockedAbilities: progress.unlockedAbilities,
      },
      {
        // Equipment edits are applied to the live records immediately, so the
        // held weapon has to follow them within the same frozen frame rather
        // than waiting for the next room load to re-read the slot.
        onEquipmentChanged: () => {
          const live = getWorld();
          const activeMember = getActiveMember(party);
          live.party = party;
          if (activeMember) live.playerCharacterStats = activeMember.stats;
          syncPlayerHandsFromEquipment(
            live,
            activeMember?.equipment.mainHand ?? null,
            activeMember?.equipment.offHand ?? null,
          );
        },
        onClose: () => {
          state.isInventoryOpen = false;
          inventoryCleanup = null;
          onResetFrameClock();
          if (onSave) onSave();
        },
      },
    );
  }

  function destroy(): void {
    if (deathScreenCleanup !== null) {
      deathScreenCleanup();
      deathScreenCleanup = null;
    }
    if (skillTombMenuCleanup !== null) {
      skillTombMenuCleanup();
      skillTombMenuCleanup = null;
    }
    if (mapOnlyCleanup !== null) {
      mapOnlyCleanup();
      mapOnlyCleanup = null;
    }
    if (inventoryCleanup !== null) {
      inventoryCleanup();
      inventoryCleanup = null;
    }
    state.isPlayerDead = false;
    state.isSkillTombMenuOpen = false;
    state.isMapOnlyOpen = false;
    state.isInventoryOpen = false;
  }

  return {
    state,
    showPlayerDeathScreen,
    openSkillTombMenu,
    openMapOnly,
    openInventory,
    destroy,
  };
}
