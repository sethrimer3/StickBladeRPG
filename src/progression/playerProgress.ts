/**
 * Player progression state — level, dust slots, loadout, and world progress.
 *
 * Cleanly separates:
 *   - Legacy passive-technique flags retained only for save compatibility
 *   - Player dust types (Golden, Ice, Nature, Void, Light) — unlocked independently
 *   - Active weaves (e.g., Spire, Aegis) — bound to LMB/RMB
 *   - Dust containers — each grants 4 capacity; different dust types cost different amounts
 */

import { ParticleKind, isEquippableParticleKind } from '../sim/particles/kinds';
import { getSlotCost, totalSlotCost } from '../sim/particles/slotCost';
import { PlayerWeaveLoadout, createDefaultWeaveLoadout } from '../sim/weaves/playerLoadout';
import { PassiveTechniqueId } from './passiveTechniques';
import { WeaveId } from '../sim/weaves/weaveDefinition';
import { getUnlockedDustKindsInCanonicalOrder } from '../sim/weaves/dustWheelOptions';
import {
  CharacterStats,
  createDefaultCharacterStats,
  sanitizeCharacterStats,
} from '../sim/stats/characterStats';
import {
  type PartyState,
  createDefaultParty,
  sanitizePartyState,
} from '../sim/party/partyState';
import {
  type PlayerStatBoosts,
  createEmptyStatBoosts,
  sanitizeStatBoosts,
} from './statBoosts';
import {
  type PlayerInventory,
  PLAYTEST_GRANT_ALL_WEAPONS,
  createDefaultInventory,
  grantAllWeaponsForPlaytest,
  reconcileStarterEquipment,
  sanitizeInventory,
} from '../sim/party/inventory';

export { getSlotCost, totalSlotCost };

// ---- Slot table per level -----------------------------------------------

/**
 * Dust slots available at each level (index = level number).
 * Level 0 is unused; level 1 starts at 5 slots.
 */
const DUST_SLOTS_PER_LEVEL: number[] = [0, 5, 7, 10, 14, 20];

/** Maximum supported level. */
export const MAX_LEVEL = DUST_SLOTS_PER_LEVEL.length - 1;

/** Returns the number of dust slots available at the given level. */
export function getDustSlots(level: number): number {
  const clamped = Math.max(1, Math.min(level, MAX_LEVEL));
  return DUST_SLOTS_PER_LEVEL[clamped] ?? DUST_SLOTS_PER_LEVEL[MAX_LEVEL];
}

// ---- State type ----------------------------------------------------------

export type PlayerAbilityId = 'doubleJump' | 'grapple' | 'swim';

export const ALL_PLAYER_ABILITY_IDS: readonly PlayerAbilityId[] = ['doubleJump', 'grapple', 'swim'];

export function isPlayerAbilityId(value: unknown): value is PlayerAbilityId {
  return typeof value === 'string' && (value === 'doubleJump' || value === 'grapple' || value === 'swim');
}

export interface PlayerProgress {
  /**
   * Current dust-slot level (1–MAX_LEVEL).
   *
   * Distinct from `characterStats.level`, which is the character/combat level
   * from the STICK-RPG port. The two advance on different axes: this one gates
   * dust slot capacity, that one gates attack/defense/health and skill points.
   */
  level: number;
  /** Total dust slots available at this level. */
  dustSlots: number;
  /** Currently equipped particle kinds (legacy — kept for backward compat). */
  loadout: ParticleKind[];
  /** Weave-based loadout with primary/secondary weave bindings and bound dust. */
  weaveLoadout: PlayerWeaveLoadout;
  /**
   * Number of World 1 levels unlocked (1 = only L1 available, 7 = all unlocked).
   * Increases by 1 each time the player completes a level.
   */
  world1UnlockedCount: number;
  /**
   * Number of World 2 levels unlocked (0 = World 2 locked, 1 = L1 available, etc.).
   * Unlocks to 1 when the player completes World 1 boss (level 7).
   */
  world2UnlockedCount: number;
  /** Set of room IDs the player has visited (used for the world map). */
  exploredRoomIds: string[];
  /** Room ID of the last save point used (for "Return to Last Save"). */
  lastSaveRoomId: string | null;
  /** Block coordinates of the last save point used. */
  lastSaveSpawnBlock: [number, number] | null;
  /** Selected character identifier ('knight', 'demonFox', 'princess', or 'outcast'). */
  characterId: string;
  /** Dust kinds the player has learned and can equip (unless dev mode is on). */
  unlockedDustKinds: ParticleKind[];
  /** Developer override: allow equipping all dust kinds in loadout UI. */
  isDevModeDustUnlocked: boolean;
  /**
   * The single dust type every ordinary player mote currently uses, chosen via
   * the dust selection wheel. `null` means no valid selection yet (e.g. the
   * player has nothing unlocked). Always validated against
   * `unlockedDustKinds`/equippability — see `sanitizePlayerDustProgress`.
   */
  selectedDustKind: ParticleKind | null;

  // ---- Progression system fields (added for early-game rework) ----

  /**
   * Deprecated passive-technique IDs retained only so older saves can be read
   * without a destructive migration. New progression code never grants them.
   */
  unlockedPassiveTechniques: PassiveTechniqueId[];
  /** Active weave IDs the player has unlocked and can equip. */
  unlockedActiveWeaves: WeaveId[];
  /** Unlockable movement and mobility abilities (e.g. 'doubleJump', 'swim'). */
  unlockedAbilities: PlayerAbilityId[];
  /** Number of dust containers the player owns. Total capacity = dustContainerCount × 4. */
  dustContainerCount: number;
  /** Dust container pieces collected; 4 pieces forge 1 container. */
  dustContainerPieces: number;
  /** WeaveIds of passive weaves the player has manually disabled. */
  disabledPassiveWeaves: string[];
  /**
   * Whether the early auto-assignment step has been completed.
   * When Golden Dust + 2 containers are first unlocked, they are auto-configured.
   * This flag prevents re-triggering the auto-assignment on subsequent loads.
   */
  hasCompletedEarlyAutoAssignment: boolean;
  /**
   * Keys of dust swarms the player has permanently collected, in the format
   * `${roomId}:dustswarm:${index}`. Persisted so swarms do not reappear after
   * save/load or game restart.
   */
  collectedDustSwarmKeys: string[];
  /**
   * Keys of dust containers and dust container shards the player has
   * permanently collected, in the formats
   * `${roomId}:container:${index}` and `${roomId}:containerShard:${index}`.
   * Persisted so containers/shards cannot be re-collected after room reload,
   * save/load, or game restart.
   */
  collectedDustContainerKeys: string[];
  /**
   * Keys of skill-tomb books (Sword/Shield/Bow Weave Skill Books, etc.) the
   * player has permanently collected, in the format
   * `${roomId}:${xBlock}:${yBlock}`. Persisted so a collected book stays
   * consumed (does not reappear or re-grant its weave) after save/load or
   * game restart. Collecting the weave itself is idempotent via
   * `unlockedActiveWeaves`; this set only governs the visible/consumed
   * state of the book.
   */
  collectedSkillTombKeys: string[];
  /** Permanently opened gates keyed by campaign, room, and stable gate UID. */
  permanentlyOpenGateKeys: string[];
  /**
   * Optional starting dust-mote count for the campaign. This configured value also
   * defines the campaign's baseline mote capacity (with PLAYER_INITIAL_HEALTH / 10 as
   * the default fallback when undefined). Respawns after death restore the player to
   * full maximum capacity derived from this baseline plus any owned dust containers.
   * Note: The wire field name `startingHealth` is preserved for save compatibility.
   */
  startingHealth?: number;

  /**
   * Character/combat stats ported from STICK-RPG (level, XP, attack, defense,
   * max health, skill points). Optional on the wire so saves written before
   * this field existed still load; `loadSaveSlot` backfills and sanitizes it.
   * See `src/sim/stats/characterStats.ts` and
   * `docs/decisions/STICK_RPG_PORT_PLAN.md`.
   */
  characterStats?: CharacterStats;

  /**
   * Party roster, equipment, and active member index ported from STICK-RPG.
   * Optional on the wire so saves written before this field existed still load;
   * `loadSaveSlot` backfills and sanitizes it via `sanitizePartyState`.
   * See `src/sim/party/partyState.ts`.
   */
  party?: PartyState;

  /**
   * Carried items and coins ported from STICK-RPG — the pool the equipment
   * slots in `party` draw from. Optional on the wire so saves written before
   * this field existed still load; `loadSaveSlot` backfills and sanitizes it
   * via `sanitizePlayerInventory`. See `src/sim/party/inventory.ts`.
   */
  inventory?: PlayerInventory;

  /**
   * Permanent stat boosts collected from boost pickup items (Ammo / Dust /
   * Mana / Health / Attack / Defense, flat and percentage). Optional on the
   * wire so saves written before this field existed still load;
   * `sanitizePlayerStatBoosts` backfills and repairs it.
   */
  statBoosts?: PlayerStatBoosts;

  /**
   * Completed world map stage IDs (e.g. 'world1Stage1', 'world1Stage2') ported
   * from STICK-RPG. Optional for backwards compatibility with legacy saves.
   */
  completedStageIds?: string[];
}

// ---- Factory / helpers ---------------------------------------------------

/**
 * Creates the default starting PlayerProgress for a brand new profile.
 *
 * The player starts as a blank slate:
 *   - 0 dust containers (0 total capacity)
 *   - No unlocked dust types
 *   - No unlocked active weaves
 *   - No legacy passive-technique flags
 *   - No active weave assignments (LMB/RMB both empty)
 *   - No loadout choices
 *
 * The early progression sequence will unlock things step by step.
 */
export function createDefaultProgress(): PlayerProgress {
  return createProgressWithCharacter('knight');
}

/**
 * Creates progress for a brand-new official-campaign save. The official
 * campaign auto-selects Outcast and skips the character-select screen
 * (see game.ts), so the very first persisted record must already say
 * 'outcast' — otherwise a save that closes before its next checkpoint
 * write is stuck showing the stale Knight sprite on reload.
 */
export function createOfficialNewProfileProgress(): PlayerProgress {
  return createProgressWithCharacter('outcast');
}

function createProgressWithCharacter(characterId: string): PlayerProgress {
  const level = 1;
  const weaveLoadout = createDefaultWeaveLoadout();
  return {
    level,
    dustSlots: getDustSlots(level),
    loadout: [],
    weaveLoadout,
    world1UnlockedCount: 1,
    world2UnlockedCount: 0,
    exploredRoomIds: [],
    lastSaveRoomId: null,
    lastSaveSpawnBlock: null,
    characterId,
    unlockedDustKinds: [],
    isDevModeDustUnlocked: false,
    selectedDustKind: null,
    // Legacy compatibility field; new progression never adds entries.
    unlockedPassiveTechniques: [],
    unlockedActiveWeaves: [],
    unlockedAbilities: ['doubleJump', 'grapple', 'swim'],
    dustContainerCount: 0,
    dustContainerPieces: 0,
    disabledPassiveWeaves: [],
    hasCompletedEarlyAutoAssignment: false,
    collectedDustSwarmKeys: [],
    collectedDustContainerKeys: [],
    collectedSkillTombKeys: [],
    permanentlyOpenGateKeys: [],
    characterStats: createDefaultCharacterStats(),
    party: createDefaultParty(),
    inventory: createDefaultInventory(),
    statBoosts: createEmptyStatBoosts(),
    completedStageIds: [],
  };
}

/**
 * Ensures `progress.characterStats` is present and internally consistent.
 *
 * Saves written before the STICK-RPG stat port omit the field entirely, and
 * hand-edited saves can carry out-of-range values, so this both backfills and
 * repairs. Idempotent.
 */
export function sanitizePlayerCharacterStats(progress: PlayerProgress): void {
  progress.characterStats = sanitizeCharacterStats(progress.characterStats);
}

/**
 * Ensures `progress.party` is present and internally consistent.
 *
 * Saves written before the STICK-RPG party port omit the field entirely, so this
 * backfills a default party and reconciles member stats. Idempotent.
 */
export function sanitizePlayerPartyState(progress: PlayerProgress): void {
  progress.party = sanitizePartyState(progress.party);
  // If characterStats exists, ensure party leader's stats stay synchronized.
  if (progress.characterStats && progress.party.members[0]) {
    progress.party.members[0].stats = progress.characterStats;
  }
}

/**
 * Ensures `progress.inventory` is present, internally consistent, and agrees
 * with the party's equipment slots.
 *
 * Must run *after* `sanitizePlayerPartyState`, because the starter-weapon
 * reconciliation reads the leader's main hand. Idempotent.
 */
export function sanitizePlayerInventory(progress: PlayerProgress): void {
  progress.inventory = sanitizeInventory(progress.inventory);
  if (progress.party) {
    reconcileStarterEquipment(progress.inventory, progress.party);
    // Playtest build: everything is unlocked from the start. See the flag's doc
    // comment for how to turn this back off.
    if (PLAYTEST_GRANT_ALL_WEAPONS) {
      grantAllWeaponsForPlaytest(progress.inventory, progress.party);
    }
  }
}

/**
 * Ensures `progress.statBoosts` is present and internally consistent.
 *
 * Saves written before boost pickups existed omit the field entirely, so this
 * both backfills and repairs. Idempotent.
 */
export function sanitizePlayerStatBoosts(progress: PlayerProgress): void {
  progress.statBoosts = sanitizeStatBoosts(progress.statBoosts);
}

/**
 * Migrates player-owned dust state without changing internal/environmental particles.
 * Numeric kind 0 already maps to Golden, so legacy numeric saves need no count conversion.
 */
export function sanitizePlayerDustProgress(progress: PlayerProgress): void {
  const sanitize = (value: unknown): ParticleKind[] => {
    if (!Array.isArray(value)) return [];
    const result: ParticleKind[] = [];
    for (const kind of value) {
      if (isEquippableParticleKind(kind) && !result.includes(kind)) result.push(kind);
    }
    return result;
  };

  progress.unlockedDustKinds = sanitize(progress.unlockedDustKinds);
  progress.loadout = sanitize(progress.loadout);
  const primary = progress.weaveLoadout?.primary;
  const secondary = progress.weaveLoadout?.secondary;
  if (primary) primary.boundDust = sanitize(primary.boundDust);
  if (secondary) secondary.boundDust = sanitize(secondary.boundDust);

  // Reconcile the selected dust kind against the (now-sanitized) unlocked set.
  // Falls back to the first unlocked kind in canonical order; never unlocks a
  // kind just because it was selected in old/malformed data.
  const isSelectedValid = progress.isDevModeDustUnlocked === true
    ? isEquippableParticleKind(progress.selectedDustKind)
    : progress.selectedDustKind !== null
      && isEquippableParticleKind(progress.selectedDustKind)
      && progress.unlockedDustKinds.includes(progress.selectedDustKind);
  if (!isSelectedValid) {
    const canonicalUnlocked = getUnlockedDustKindsInCanonicalOrder(progress);
    progress.selectedDustKind = canonicalUnlocked.length > 0 ? canonicalUnlocked[0] : null;
  }
}

/** The dust kit the official campaign granted new players before Fire Dust existed. */
const PRE_FIRE_STARTER_DUST_KIT: readonly ParticleKind[] = [
  ParticleKind.Golden,
  ParticleKind.Ice,
  ParticleKind.Nature,
  ParticleKind.Void,
  ParticleKind.Light,
];

/**
 * Backfills Fire Dust for existing saves that already hold the rest of the
 * pre-Fire starter kit. `applyCampaignStartingOptions` (campaignStartingOptions.ts)
 * only (re-)applies `startingDustTypes` to saves that have never explored a
 * room, so a save created before Fire Dust was added to that list would
 * otherwise never receive it even after the campaign is updated. Idempotent —
 * no-ops once Fire Dust is unlocked, and never removes anything.
 */
export function migrateStarterFireDustUnlock(progress: PlayerProgress): void {
  if (progress.unlockedDustKinds.includes(ParticleKind.FireDust)) return;
  const hasFullPreFireStarterKit = PRE_FIRE_STARTER_DUST_KIT.every(
    kind => progress.unlockedDustKinds.includes(kind),
  );
  if (hasFullPreFireStarterKit) {
    progress.unlockedDustKinds.push(ParticleKind.FireDust);
  }
}

/**
 * Ensures `progress.unlockedAbilities` is present and valid.
 * For development, defaults to granting active abilities (['doubleJump', 'swim']).
 */
export function sanitizePlayerAbilities(progress: PlayerProgress): void {
  if (!Array.isArray(progress.unlockedAbilities)) {
    progress.unlockedAbilities = ['doubleJump', 'grapple', 'swim'];
    return;
  }
  const sanitized: PlayerAbilityId[] = [];
  for (const item of progress.unlockedAbilities) {
    if (isPlayerAbilityId(item) && !sanitized.includes(item)) {
      sanitized.push(item);
    }
  }
  progress.unlockedAbilities = sanitized;
}

/**
 * Returns true if `kinds` fits within the player's current dust slot budget.
 */
export function loadoutFits(
  kinds: ReadonlyArray<ParticleKind>,
  dustSlots: number,
): boolean {
  return totalSlotCost(kinds) <= dustSlots;
}

/**
 * Adds `kind` to the loadout if it fits within the slot budget.
 * Returns a new array (does not mutate the input).
 */
export function addToLoadout(
  loadout: ParticleKind[],
  kind: ParticleKind,
  dustSlots: number,
): ParticleKind[] {
  const next = [...loadout, kind];
  return loadoutFits(next, dustSlots) ? next : loadout;
}

/**
 * Removes one occurrence of `kind` from the loadout.
 * Returns a new array (does not mutate the input).
 */
export function removeFromLoadout(
  loadout: ParticleKind[],
  kind: ParticleKind,
): ParticleKind[] {
  const idx = loadout.indexOf(kind);
  if (idx === -1) return loadout;
  const next = loadout.slice();
  next.splice(idx, 1);
  return next;
}
