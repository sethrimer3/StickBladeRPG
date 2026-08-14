/**
 * The player's hit points — a life pool of its own, separate from dust motes.
 *
 * Until now `healthPoints` was the mote count: the cloud orbiting the player
 * *was* their health, and because the weaves size themselves from the same
 * count (`swordWeave.ts` and friends read `availableCount`), taking a hit
 * shortened your sword. That coupling is what this module ends. Motes stay at
 * capacity and keep feeding the weaves; damage and death come here instead.
 *
 * Deliberately a small plain-data module rather than a field on `WorldState`:
 * `applyPlayerDamageWithKnockback` is called from dozens of sites with only a
 * cluster in hand, so the pool lives on the cluster alongside the other
 * player-only damage fields (`challengeMode`, `projectileShield`,
 * `statsDefense`) and follows the same structural-typing convention.
 *
 * Interim system — see `docs/decisions/STICK_RPG_PORT_PLAN.md`. Phase 3
 * equipment gives party members their own stat-derived maximums, at which point
 * `maxHitPoints` becomes derived rather than granted.
 */

/** Hit points the player starts a campaign with. */
export const PLAYER_STARTING_HIT_POINTS = 20;

/** Maximum hit points added by one Dust Container. */
export const HIT_POINTS_PER_DUST_CONTAINER = 4;

/** The life pool. Zero `maxHitPoints` means "this entity has no pool". */
export interface PlayerHealthState {
  hitPoints: number;
  maxHitPoints: number;
}

/** Clamps a hit-point value to a non-negative whole number. */
export function normalizeHitPoints(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/**
 * True when this entity carries a hit-point pool at all.
 *
 * Everything without one — enemies, and any caller predating this system —
 * keeps the pre-existing mote-as-health behavior, so no damage path changes
 * except the player's.
 */
export function hasPlayerHealthPool(target: Partial<PlayerHealthState> | null | undefined): boolean {
  return normalizeHitPoints(target?.maxHitPoints ?? 0) > 0;
}

/** Current hit points. */
export function getPlayerHitPoints(target: Pick<PlayerHealthState, 'hitPoints'>): number {
  return normalizeHitPoints(target.hitPoints);
}

/** Maximum hit points, before any temporary overheal. */
export function getPlayerMaxHitPoints(target: Pick<PlayerHealthState, 'maxHitPoints'>): number {
  return normalizeHitPoints(target.maxHitPoints);
}

/** Maximum hit points for a player holding `containerCount` Dust Containers. */
export function getPlayerMaxHitPointsForContainerCount(containerCount: number): number {
  return PLAYER_STARTING_HIT_POINTS + normalizeHitPoints(containerCount) * HIT_POINTS_PER_DUST_CONTAINER;
}

/**
 * Spends `amount` from the pool and returns what remains.
 *
 * Only subtracts — whether reaching zero is fatal is the damage pipeline's
 * decision, not this module's, because that also depends on challenge mode and
 * the invulnerability window.
 */
export function damagePlayerHitPoints(target: PlayerHealthState, amount: number): number {
  const cost = normalizeHitPoints(amount);
  target.hitPoints = Math.max(0, getPlayerHitPoints(target) - cost);
  return target.hitPoints;
}

/**
 * Restores hit points up to the maximum. Returns how many were actually
 * restored, so callers can tell a real heal from a wasted pickup.
 *
 * A player carrying temporary hit points is already above the maximum, so this
 * restores nothing for them — the same rule `grantPlayerMotes` follows.
 */
export function healPlayerHitPoints(target: PlayerHealthState, amount: number): number {
  const max = getPlayerMaxHitPoints(target);
  const before = Math.min(getPlayerHitPoints(target), max);
  target.hitPoints = Math.min(max, before + normalizeHitPoints(amount));
  return target.hitPoints - before;
}

/**
 * Adds hit points above the maximum, as `grantOverhealthMotes` does for motes.
 *
 * Temporary points are simply `hitPoints > maxHitPoints` — no second field.
 * They are spent first by damage, are not replaced by ordinary healing, and are
 * cleared by `resetPlayerHitPoints`.
 */
export function grantTemporaryHitPoints(target: PlayerHealthState, amount: number): number {
  const grant = normalizeHitPoints(amount);
  target.hitPoints = getPlayerHitPoints(target) + grant;
  return grant;
}

/**
 * Raises the maximum by `containerCount` Dust Containers and fills every newly
 * added point, mirroring `grantDustContainerMotes`.
 *
 * Containers are the game's health upgrade, so they had to keep upgrading
 * health once health stopped being motes — otherwise the pickup would still
 * lengthen your weaves but no longer make you tougher.
 */
export function grantDustContainerHitPoints(
  target: PlayerHealthState,
  containerCount = 1,
): number {
  if (!hasPlayerHealthPool(target)) return 0;
  const granted = normalizeHitPoints(containerCount) * HIT_POINTS_PER_DUST_CONTAINER;
  const before = getPlayerHitPoints(target);
  target.maxHitPoints = getPlayerMaxHitPoints(target) + granted;
  target.hitPoints = Math.min(target.maxHitPoints, before + granted);
  return granted;
}

/**
 * Sizes a freshly spawned player's pool and fills it.
 *
 * `carriedHitPoints` is the value carried out of the previous room; pass it
 * through so a room transition is not a free full heal, and omit it for a fresh
 * spawn or a respawn. Temporary points above the maximum survive a carry, for
 * the same reason overhealth motes do.
 */
export function applyPlayerHealthOnSpawn(
  target: PlayerHealthState,
  containerCount: number,
  carriedHitPoints?: number,
): void {
  target.maxHitPoints = getPlayerMaxHitPointsForContainerCount(containerCount);
  target.hitPoints = carriedHitPoints !== undefined && normalizeHitPoints(carriedHitPoints) > 0
    ? normalizeHitPoints(carriedHitPoints)
    : target.maxHitPoints;
}

/** Refills the pool and drops any temporary points — respawn, and new campaign. */
export function resetPlayerHitPoints(target: PlayerHealthState): void {
  target.hitPoints = getPlayerMaxHitPoints(target);
}
