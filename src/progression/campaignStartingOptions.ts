/**
 * Shared helper for applying CampaignSpawnData starting options to PlayerProgress.
 *
 * Two modes:
 *   'merge'  — official campaign path: container count is merged (never reduced)
 *              into an existing brand-new save profile.
 *   'fresh'  — packed custom-campaign path: container count is assigned exactly
 *              to a freshly created default progress object.
 *
 * Mutates `progress` in place. Does NOT mutate `spawn`.
 */

import { PlayerProgress, isPlayerAbilityId } from './playerProgress';
import { CampaignSpawnData } from '../levels/campaignSchema';
import { unlockDustType, unlockActiveWeave, unlockAbility } from './unlocks';
import { stringToParticleKind } from '../editor/roomJsonSchema';
import { WEAVE_REGISTRY } from '../sim/weaves/weaveDefinition';
import { expandLegacyWeaveId } from './weaveMigration';
import { normalizeMoteCount } from '../sim/playerMoteLife';
import { isEquippableParticleKind } from '../sim/particles/kinds';
import { getUnlockedDustKindsInCanonicalOrder } from '../sim/weaves/dustWheelOptions';
import { createDefaultCharacterStats } from '../sim/stats/characterStats';
import { getWeaponDef } from '../sim/weapons/weaponDefs';
import { applyMainHandConstraints } from '../sim/party/partyState';

export type CampaignStartingOptionsMode = 'merge' | 'fresh';

export function applyCampaignStartingOptions(
  progress: PlayerProgress,
  spawn: CampaignSpawnData,
  mode: CampaignStartingOptionsMode,
): void {
  // `startingHealth` is the wire field name (kept for backward-compat with
  // existing saved campaigns) but represents the player's starting dust
  // mote count — no upper cap, and 0 is a legal value. Legacy campaigns
  // authored under the old 1-10 "health" interpretation still load fine
  // since the field name and shape are unchanged.
  if (spawn.startingHealth !== undefined) {
    progress.startingHealth = normalizeMoteCount(spawn.startingHealth);
  }

  if (spawn.startingDustContainerCount !== undefined) {
    const normalized = Math.max(0, Math.floor(spawn.startingDustContainerCount));
    if (mode === 'merge') {
      progress.dustContainerCount = Math.max(progress.dustContainerCount, normalized);
    } else {
      progress.dustContainerCount = normalized;
    }
  }

  if (Array.isArray(spawn.startingDustTypes)) {
    for (const name of spawn.startingDustTypes) {
      const kind = stringToParticleKind(name);
      if (kind !== null && isEquippableParticleKind(kind)) unlockDustType(progress, kind);
    }
  }

  // Deterministic initial selected dust: if nothing has been chosen yet (or
  // the previous selection is no longer valid), pick the first unlocked kind
  // in canonical order — never dependent on unlock/insertion order.
  if (progress.selectedDustKind === null || !isEquippableParticleKind(progress.selectedDustKind)
      || progress.unlockedDustKinds.indexOf(progress.selectedDustKind) === -1) {
    const canonicalUnlocked = getUnlockedDustKindsInCanonicalOrder(progress);
    if (canonicalUnlocked.length > 0) progress.selectedDustKind = canonicalUnlocked[0];
  }

  if (Array.isArray(spawn.startingWeaves)) {
    for (const weaveId of spawn.startingWeaves) {
      if (!WEAVE_REGISTRY.has(weaveId)) continue;
      // Old campaigns may specify a single mutually-exclusive legacy weave
      // value (e.g. 'shield_sword'). Expand it to the full independent
      // unlock set (sword + shield) rather than granting only the combo id,
      // so Sword/Shield/Bow can be unlocked as independent subsets going
      // forward. Non-legacy ids (storm/shield/arrow) expand to themselves.
      for (const expandedId of expandLegacyWeaveId(weaveId)) {
        unlockActiveWeave(progress, expandedId);
      }
    }
  }

  if (spawn.startingStats) {
    if (!progress.characterStats) {
      progress.characterStats = createDefaultCharacterStats();
    }
    const s = spawn.startingStats;
    if (s.level !== undefined && !isNaN(s.level)) progress.characterStats.level = Math.max(1, Math.min(99, Math.floor(s.level)));
    if (s.maxHealthBase !== undefined && !isNaN(s.maxHealthBase)) progress.characterStats.maxHealthBase = Math.max(1, s.maxHealthBase);
    if (s.attackBase !== undefined && !isNaN(s.attackBase)) progress.characterStats.attackBase = Math.max(0, s.attackBase);
    if (s.defenseBase !== undefined && !isNaN(s.defenseBase)) progress.characterStats.defenseBase = Math.max(0, s.defenseBase);
    if (s.xp !== undefined && !isNaN(s.xp)) progress.characterStats.xp = Math.max(0, s.xp);
    if (s.xpToNextLevel !== undefined && !isNaN(s.xpToNextLevel)) progress.characterStats.xpToNextLevel = Math.max(1, s.xpToNextLevel);
    if (s.skillPoints !== undefined && !isNaN(s.skillPoints)) progress.characterStats.skillPoints = Math.max(0, Math.floor(s.skillPoints));

    if (progress.party?.members?.[0]) {
      progress.party.members[0].stats = { ...progress.characterStats };
    }
  }

  if (Array.isArray(spawn.startingAbilities)) {
    if (mode === 'fresh') {
      const valid = spawn.startingAbilities.filter(isPlayerAbilityId);
      progress.unlockedAbilities = Array.from(new Set(valid));
    } else {
      for (const ability of spawn.startingAbilities) {
        if (isPlayerAbilityId(ability)) {
          unlockAbility(progress, ability);
        }
      }
    }
  }

  if (typeof spawn.startingWeapon === 'string') {
    if (spawn.startingWeapon.length === 0) {
      if (progress.party?.members?.[0]) {
        progress.party.members[0].equipment.mainHand = null;
      }
    } else {
      const def = getWeaponDef(spawn.startingWeapon);
      if (def && progress.party?.members?.[0]) {
        progress.party.members[0].equipment.mainHand = spawn.startingWeapon;
        applyMainHandConstraints(progress.party.members[0].equipment);
      }
    }
  }

  // `startingPassives` may still be present in older campaign files. It is
  // intentionally ignored: Cycle was retired and replaced by Storm Weave.
}
