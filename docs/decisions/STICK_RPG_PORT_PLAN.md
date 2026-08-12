# STICK-RPG Port Plan

Status: all five phases implemented. Phase 1 in BUILD 613; Phase 2 in BUILD 614–620 and
625–628 (2e, the two bespoke staff auras, in BUILD 627; 2d, the twelve on-expiry
callbacks plus the slash-wave runtime they needed, in BUILD 628); Phase 3 in BUILD
621–622; Phase 4 in BUILD 623; Phase 5 in BUILD 624.

Both recorded gaps were closed in BUILD 629: staff auras now reach recruited party members
inside their radius (`src/sim/party/partyAuras.ts`, as a deterministic damage reduction —
see that module for why the donor's mitigation roll could not be used directly), and
on-expiry effects now draw an expanding ring sized to the effect's own radius
(`ExpiryFlashPool`, a visual-only pool kept out of the simulation particle system).

Remaining known limitation: the wielder is assumed to be the party leader, because only
the active member carries a weapon runtime. Per-member weapons would change that, and
`partyAuras.ts` is the single place the assumption lives.

Purpose: define how StickBlade absorbs the weapons, party system, enemies, world map, and
stats from the STICK-RPG prototype without importing that prototype's engine.

## Source of truth

The donor project lives outside this repository at:

```
<GitHub root>/StickRanger/GameToClone/STICK-RPG
```

It is vanilla JavaScript on shared globals with no build step. Scripts are loaded in order
from `index.html`; there are no modules. Relevant donor files:

| System | Donor files |
|---|---|
| Weapons | `js/weapons.js` (`WEAPON_DEFS`), `js/projectiles.js`, `js/abilities.js`, `js/stickman/sword.js`, `js/stickman/weapon_rig.js`, `js/stickman/weapon_state.js` |
| Party / equipment | `js/equipment.js` (`TEAM_SIZE`, `EQUIPMENT_SUBSLOTS`, `GLYPHS`), `world.team` / `world.teamActiveIndex` / `world.profile.team` in `js/main.js`, skill + shop panels in `js/hud.js` |
| Enemies | `js/enemies.js` (`ENEMY_TRAITS`), `Stick.spawnEnemy` and `ENEMY_BEHAVIORS` in `js/stickman.js`, placements in `js/levels.js` |
| World map | `js/levels.js`: `LEVEL_DEFS`, `WORLD_MAP_NODE_OVERRIDES`, `WORLD_STAGE_COUNT`, `WORLD_BOSS_STAGE_CONFIGS`, `computeLevelDifficultyMultiplier` |
| Stats | `Stick` constructor and `addXp` in `js/stickman.js`, `computeDamage` in `js/stickman/combat.js`, `createStickProfile` in `js/main.js`, `computeLocalSkillMultipliers` in `js/equipment.js` |

## Governing principle

**Port data and rules; do not port the engine.**

StickBlade already supersedes the donor's physics, render loop, and DOM HUD. The donor's
verlet stickman has in fact already been ported — see `src/sim/clusters/stickRangerBody.ts`
and `src/sim/clusters/stickRangerPlayer.ts`. What remains to port is gameplay *content and
rules*, expressed as typed definition modules in the style of `src/levels/gateDefs.ts` and
`src/sim/weaves/weaveDefinition.ts`.

Three conversions apply to every phase that touches `src/sim/`:

1. **Wall-clock to ticks.** Donor cooldowns are `performance.now()` timestamps
   (`weaponCooldownUntil`, `necrotic.nextTick`, `chronoFrozenUntil`, `expires`). Simulation
   code here must stay deterministic — every one becomes a tick countdown.
2. **`Math.random()` to `src/sim/rng.ts`.** The donor's damage mitigation roll
   (`Math.random() * defense`) is the most important case; it must route through `RngState`.
3. **Globals to typed modules.** Each donor table becomes a `*Defs.ts` module with an
   exported `Def` interface and a frozen record.

## Phases

Recommended order is `1 → 2 → 4 → 5 → 3`. Phase 3 is the only phase that touches
regression-prone code (room transitions, resident rooms); Phases 2, 4, and 5 are additive.
Swap to `1 → 2 → 3` if the party system matters more than content volume.

### Phase 1 — Stats foundation (prerequisite for all others)

New `src/sim/stats/characterStats.ts`, pure and Node-safe:

- `CharacterStats`: `level`, `xp`, `xpToNextLevel`, `attackBase`, `defenseBase`,
  `maxHealthBase`, `skillPoints`, `skillAllocations { health, attack, defense }`.
- `DerivedStats`: `attack`, `defense`, `maxHealth`, computed as
  `base × (1 + allocation) × auraMultiplier + equipmentBonus`, mirroring the donor's
  `computeLocalSkillMultipliers` and `_applyAuraStatScaling`.
- `grantExperience` reproduces the donor's `addXp`: on level-up, `maxHealthBase += 12`,
  `xpToNextLevel = floor(xpToNextLevel × 1.45)`, `skillPoints += SKILL_POINTS_PER_LEVEL`.
- `computeStatDamage` reproduces `computeDamage`:
  `max(0, base × attack − rng × defense)`, with the roll taken from `RngState`.

Integration: `characterStats` is persisted on `PlayerProgress` (name chosen deliberately —
`PlayerProgress.level` already exists and means *dust-slot* level, which is a different
axis and must not be conflated). `PlayerDamageTarget` gains an optional `statsDefense`;
when absent, `applyPlayerDamageWithKnockback` behaves exactly as before, so nothing
regresses until a later phase populates it.

### Phase 2 — Weapons and equipment

- `src/sim/weapons/weaponDefs.ts` — port `WEAPON_DEFS` as data, typed by
  `kind: 'melee' | 'ranged' | 'shield'` and `grip: 'oneHand' | 'twoHand'`, cooldowns in ticks.
- `src/sim/weapons/glyphDefs.ts` — port `GLYPHS` (fire, ice, light, chronometric, void) as an
  element-modifier layer applied to any weapon with `glyphSocket: true`.
- `src/sim/weapons/weaponSwing.ts` — melee arc resolution against the existing cluster
  spatial index.
- Ranged weapons extend `src/sim/weaves/bowArrow.ts` rather than porting `js/projectiles.js`
  wholesale; StickBlade already has projectile plumbing through to the snapshot.
- Rendering attaches to the stickman rig. `stickRangerBody.ts` already exposes `SR_HIP`,
  `SR_HEAD`, `SR_FOOT_L`, `SR_FOOT_R`; hand anchors need adding. The donor's
  `_rebuildSwordConstraints` / sheath logic is the reference for held-weapon constraints.

### Phase 3 — Party system (largest architectural change)

StickBlade assumes exactly one player cluster: camera follow, `src/screens/playerTransfer.ts`,
`src/sim/playerDamage.ts`, room transitions, and the snapshot all encode that assumption.

- `src/sim/party/partyState.ts` — `members[]` (max 3, per the donor's `TEAM_SIZE`),
  `activeIndex`, per-member equipment `{ mainHand, offHand, armor }`.
- Generalize player-cluster lookups in `src/sim/world.ts` and `src/sim/tick.ts` from one
  cluster to an array with a designated active member; inactive members run a follow AI
  ported from the donor's `Stick.ai` follow branch.
- Transitions must carry all three members: extend `playerTransfer.ts`. Do **not** change
  transition trigger geometry — `AGENTS.md` flags that area as regression-prone.
- UI: new `src/ui/partyPanel.ts` and `src/ui/skillPanel.ts` modeled on the existing
  `src/ui/weaveLoadout.ts` and `src/ui/skillTombLoadout.ts`, not on the donor's canvas HUD.

### Phase 4 — Enemies

- `src/sim/clusters/stickRpgEnemyTraits.ts` — port `ENEMY_TRAITS` (locomotion `roller` /
  `hopper` / `flier`, hitbox and move-force overrides).
- StickBlade already has roughly twenty AI modules under `src/sim/clusters/`. Map each donor
  enemy onto an existing AI where behavior matches; write new modules only for genuinely new
  locomotion.
- Author placements through the existing `RoomEnemyDef` (`src/levels/roomDef.ts`) and
  `src/screens/gameEnemySpawn.ts` path, and add palette entries in
  `src/editor/editorDropdownData.ts` so the editor can place them.
- Add XP and coin drops on death, feeding Phase 1.

### Phase 5 — World map

- Extend `LevelDef` (`src/levels/levelDef.ts`) with `mapNode { x, y, branch, stageCode }`,
  `stageCount`, `boss`, `difficultyMultiplier` (port `computeLevelDifficultyMultiplier`), and
  unlock edges.
- Replace the flat grid in `src/ui/worldMap.ts` with the donor's node-graph model, porting the
  eight-world × five-stage topology from `WORLD_MAP_NODE_OVERRIDES` and
  `WORLD_BOSS_STAGE_CONFIGS` as data.
- **Do not port `RAW_LEVEL_DATA`'s ASCII layouts.** Those encode the donor's tile format;
  StickBlade rooms come from `roomSchemaV2` and the editor. A world-map node points at a
  StickBlade room or campaign ID.

## Known risks

- `js/main.js` and `js/levels.js` are about 1 MB combined and interleave level data, hazards,
  shops, and the save format. Phases 4 and 5 require selective extraction, not file-by-file
  porting. Budget reading time accordingly.
- The donor has a live bug worth not reproducing: `SKILL_POINTS_PER_LEVEL` is defined as `1`
  in `js/stickman/constants.js`, but `js/hud.js:631` falls back to `3` when it reads as
  undefined. This port fixes the value at `1` and documents it in `characterStats.ts`.
- The donor's `createStickProfile` initializes `nextXp: Infinity` while `js/hud.js:611` uses
  `40` as the recruitment default. This port uses `40` as the level-1 requirement.
- Donor stat scaling divides by aura multipliers to recover a base value
  (`cacheBaseStatsFromCurrent`). This port stores base values explicitly instead and derives
  forward only, which avoids the donor's drift when a multiplier is zero.

## Per-phase completion rules

Each phase is one coherent commit on `main` under an autosync lease, with a `BUILD_NUMBER`
patch bump in `src/build-info.ts`, validated with `npm run build`, `npm run lint`, and
`npm test`. See `AGENTS.md` for the lease workflow.
