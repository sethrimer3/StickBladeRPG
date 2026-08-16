/**
 * editorPreviewRenderer.ts — live, game-accurate room preview for the editor.
 *
 * ## What this is
 *
 * Historically the editor drew its own schematic view of a room: coloured
 * outlines for walls, marker rectangles for background blocks, and so on. What
 * the room would actually look like in-game was only visible by playtesting.
 * The gameplay scene rendered behind the editor overlays
 * (gameScreenEditorBackdrop.ts) draws the *live sim world*, which reflects the
 * room as it was last activated — not the edits made since.
 *
 * This module renders the room being edited through the real gameplay
 * renderers, straight from live `EditorRoomData`, so the editor canvas shows
 * the room as the player would see it after pressing Play. It is a frozen
 * still: nothing here advances time, and no animated or simulation-driven
 * content is drawn (see "Coverage" below).
 *
 * ## Incremental updates
 *
 * The gameplay wall/background renderers cache rendered output in 32×32-block
 * chunk canvases. Placing a block must not throw that cache away, so:
 *
 *   - The chunk caches are handed a **stable layout identity**
 *     (`_WALL_LAYOUT_REF`) via `renderWallSpritesWithLayout`, instead of the
 *     rebuilt `CachedWallLayout` object gameplay passes. That disables the
 *     renderers' own "layout object changed ⇒ everything is stale" rule.
 *   - This module owns invalidation instead: each frame it flushes the block
 *     region edited since the last frame (see editorPreviewInvalidation.ts)
 *     into `invalidateChunkRect` / `invalidateBackgroundBlockChunkRect`, so
 *     only chunks overlapping the edit rebuild. Everything else is re-blitted.
 *
 * Whole-room invalidation still happens where it must: a room/theme/lighting
 * /zoom change reassigns chunk-cache ownership, and any edit whose footprint
 * the caller could not determine marks the room fully dirty (correct, just
 * slower — see `markEditorPreviewDirtyAll`).
 *
 * The room's wall *layout* (occupancy, surface exposure, ambient depths) is
 * still derived whole-room, but at most once per frame and only when wall
 * geometry actually changed — it is a cheap grid pass with no canvas work, and
 * it is shared with the Surface Rim overlay via
 * `getEditorWallGeometry`.
 *
 * ## Coverage
 *
 * Drawn from live edit data: background blocks, and walls / platforms / ramps
 * / stairs with real sprites, ambient light shading, seam blending, and
 * surface rims. Custom blocks are left to `drawEditorCustomBlocks`, which
 * already draws the same cached sprites the gameplay renderer uses.
 *
 * Everything else — enemies, hazards, particles, interactables — keeps its
 * existing editor overlay marker, which is also what stays selectable and
 * draggable. The preview is drawn *underneath* those overlays, so authoring
 * affordances are never hidden by it.
 */

import type { EditorRoomData } from './editorElementTypes';
import type { EditorState } from './editorState';
import { buildEditorRenderMask } from './editorRenderMask';
import { BLOCK_SIZE_SMALL } from '../levels/roomDef';
import type { RoomDef } from '../levels/roomDef';
import {
  renderWallSpritesWithLayout,
  invalidateChunkRect,
  activateWallChunkCacheOwnership,
  setActiveBlockSpriteWorld,
  setActiveBlockSpriteTheme,
  setActiveBlockLighting,
  setActiveSeamBlending,
  setRenderViewportSize,
  setActiveDarkAmbientBlockers,
  renderDarkAmbientBlockerOverlay,
} from '../render/walls/blockSpriteRenderer';
import {
  renderBackgroundBlocks,
  invalidateBackgroundBlockChunkRect,
  activateBgChunkCacheOwnership,
} from '../render/walls/backgroundBlockRenderer';
import { computeRenderStateKey } from '../render/walls/roomRenderCacheStore';
import {
  DEFAULT_DIRECTIONAL_BIAS,
  DEFAULT_SIDE_EXPOSURE_STRENGTH,
  DEFAULT_MINIMUM_WALL_LIGHT,
  DEFAULT_FALLOFF_POWER,
  DEFAULT_BACKGROUND_LIGHT_SPILL,
  DEFAULT_SOLID_LIGHT_SOFTNESS,
} from '../render/walls/ambientLightDepths';
import { getEditorWallGeometry } from './editorWallSurfaceRimPreview';
import {
  getEditorPreviewDirtyState,
  markEditorPreviewFullyDirty,
  clearEditorPreviewDirty,
  hasEditorPreviewDirty,
} from './editorPreviewInvalidation';

/** The region edited since the last preview frame — flushed once per frame. */
const _dirty = getEditorPreviewDirtyState();

// ── Cached per-room render state ──────────────────────────────────────────────

/**
 * Stable object handed to the wall chunk cache as its layout identity. Never
 * replaced, so the cache never self-invalidates and this module stays the sole
 * owner of wall-chunk invalidation (see the module doc comment).
 */
const _WALL_LAYOUT_REF: { readonly tag: string } = { tag: 'editor-preview-walls' };

/**
 * Reusable room view passed to `renderBackgroundBlocks`. Its identity is
 * deliberately stable, because that renderer uses the room object as *its*
 * chunk-cache layout identity — a fresh object each frame would rebuild every
 * background chunk every frame. Fields are mutated in place; invalidation is
 * ours (its own content signature still guards the cell-bucket layout).
 */
type PreviewRoomView = Pick<RoomDef, 'id' | 'worldNumber' | 'blockTheme' | 'backgroundBlocks'>;
const _previewRoomView: {
  id: string;
  worldNumber: number;
  blockTheme: RoomDef['blockTheme'];
  backgroundBlocks: RoomDef['backgroundBlocks'];
} = {
  id: '',
  worldNumber: 1,
  blockTheme: undefined,
  backgroundBlocks: undefined,
};

/**
 * Last applied renderer configuration. The `setActive*` setters each invalidate
 * the whole wall chunk cache, so they run only when the derived state actually
 * changed — otherwise the preview would rebuild every chunk every frame.
 */
let _appliedRenderStateKey: string | null = null;
let _appliedRoomId: string | null = null;
let _appliedZoom = -1;

/**
 * Drops all cached preview state. Call when the editor opens or closes, or
 * when a different room is loaded for editing, so nothing survives into a
 * context it was not built for.
 */
export function resetEditorPreviewRenderer(): void {
  _appliedRenderStateKey = null;
  _appliedRoomId = null;
  _appliedZoom = -1;
  markEditorPreviewFullyDirty();
}

/**
 * Builds the ambient-light blocker key sets from live editor data.
 *
 * Mirrors `buildRoomAmbientBlockerKeys` (levels/roomAmbientBlockers.ts) — both
 * blocker sources and the dark-blocker subset — but reads `EditorRoomData`,
 * whose blocker entries carry `isDarkFlag` rather than `isDark`.
 */
function _buildEditorBlockerKeys(room: EditorRoomData): {
  blockerKeys: Set<string>;
  darkBlockerKeys: Set<string>;
} {
  const blockerKeys = new Set<string>();
  const darkBlockerKeys = new Set<string>();

  for (const b of room.ambientLightBlockers) {
    const key = `${b.xBlock},${b.yBlock}`;
    blockerKeys.add(key);
    if (b.isDarkFlag === 1) darkBlockerKeys.add(key);
  }

  const bgBlocks = room.backgroundBlocks;
  if (bgBlocks !== undefined) {
    for (const b of bgBlocks) {
      if (b.isLightBlockingFlag !== 1) continue;
      for (let dy = 0; dy < b.hBlock; dy++) {
        for (let dx = 0; dx < b.wBlock; dx++) {
          blockerKeys.add(`${b.xBlock + dx},${b.yBlock + dy}`);
        }
      }
    }
  }

  return { blockerKeys, darkBlockerKeys };
}

/**
 * Whether the live preview owns the terrain this frame.
 *
 * Single source of truth for the two sides that must agree: the backdrop,
 * which decides whether to draw sim-world terrain or call
 * {@link renderEditorRoomPreview}, and the editor overlays, which suppress the
 * schematic stand-ins the preview replaces. If these ever disagreed the room
 * would render either twice or not at all.
 */
export function isEditorLivePreviewActive(state: {
  isLivePreviewEnabled: boolean;
  layers: EditorState['layers'];
}): boolean {
  return state.isLivePreviewEnabled && buildEditorRenderMask(state as EditorState).isLayerVisible('terrain');
}

/**
 * Draws the game-accurate preview of the room currently being edited.
 *
 * Called from the backdrop's terrain slot (gameScreenEditorBackdrop.ts) so the
 * gameplay draw order is preserved: terrain first, then hazards, enemies and
 * interactables, then the editor's own overlays last of all.
 *
 * @param wallGeometryRevision Wall-geometry revision, forwarded to the shared
 *   editor wall geometry cache so a frame with no geometry change reuses the
 *   existing layout instead of re-deriving its signature.
 */
export function renderEditorRoomPreview(
  ctx: CanvasRenderingContext2D,
  room: EditorRoomData,
  offsetXPx: number,
  offsetYPx: number,
  zoom: number,
  canvasWidthPx: number,
  canvasHeightPx: number,
  wallGeometryRevision: number,
): void {
  const { blockerKeys, darkBlockerKeys } = _buildEditorBlockerKeys(room);

  const blockTheme = room.blockTheme ?? null;
  const worldNumber = room.worldNumber ?? 1;
  const lightingEffect = room.lightingEffect ?? 'Ambient';
  const ambientDirection = room.ambientLightDirection ?? 'omni';
  const seamBlending = room.blockSeamBlending ?? 'off';
  const directionalBias = room.directionalBias ?? DEFAULT_DIRECTIONAL_BIAS;
  const sideExposureStrength = room.sideExposureStrength ?? DEFAULT_SIDE_EXPOSURE_STRENGTH;
  const minimumWallLight = room.minimumWallLight ?? DEFAULT_MINIMUM_WALL_LIGHT;
  const falloffPower = room.falloffPower ?? DEFAULT_FALLOFF_POWER;
  const backgroundLightSpill = room.backgroundLightSpill ?? DEFAULT_BACKGROUND_LIGHT_SPILL;
  const solidLightSoftness = room.solidLightSoftness ?? DEFAULT_SOLID_LIGHT_SOFTNESS;

  // Same derivation the gameplay load path uses (roomRenderState.ts), so a
  // preview and a playtest of the same room agree on theme, lighting, and
  // therefore on cached chunk contents.
  const renderStateKey = computeRenderStateKey(
    blockTheme,
    worldNumber,
    lightingEffect,
    ambientDirection,
    seamBlending,
    blockerKeys,
    room.widthBlocks,
    room.heightBlocks,
    directionalBias,
    sideExposureStrength,
    minimumWallLight,
    falloffPower,
    backgroundLightSpill,
    solidLightSoftness,
  );

  // ── Apply renderer configuration only on change ─────────────────────────
  // Each setter below invalidates the entire wall chunk cache, so running them
  // unconditionally would defeat the whole point of the chunk cache.
  if (renderStateKey !== _appliedRenderStateKey || room.id !== _appliedRoomId || zoom !== _appliedZoom) {
    setActiveBlockSpriteWorld(worldNumber);
    if (blockTheme !== null) setActiveBlockSpriteTheme(blockTheme);
    setActiveSeamBlending(seamBlending);
    setActiveBlockLighting(
      lightingEffect,
      room.widthBlocks,
      room.heightBlocks,
      ambientDirection,
      blockerKeys,
      directionalBias,
      sideExposureStrength,
      minimumWallLight,
      falloffPower,
      backgroundLightSpill,
      solidLightSoftness,
    );
    setActiveDarkAmbientBlockers(darkBlockerKeys);
    // Chunks baked for a different room, render state, or zoom cannot be
    // presented here — reassign ownership so both caches start clean.
    activateWallChunkCacheOwnership(room.id, renderStateKey, zoom);
    activateBgChunkCacheOwnership(room.id, renderStateKey, zoom);

    _appliedRenderStateKey = renderStateKey;
    _appliedRoomId = room.id;
    _appliedZoom = zoom;
    // Ownership reassignment already cleared both caches; nothing accumulated
    // before it is still meaningful.
    clearEditorPreviewDirty(_dirty);
  } else if (hasEditorPreviewDirty(_dirty)) {
    // ── Targeted invalidation ────────────────────────────────────────────
    if (_dirty.isAllDirty) {
      invalidateChunkRect(0, 0, room.widthBlocks - 1, room.heightBlocks - 1);
      invalidateBackgroundBlockChunkRect(0, 0, room.widthBlocks - 1, room.heightBlocks - 1);
    } else {
      invalidateChunkRect(_dirty.colMin, _dirty.rowMin, _dirty.colMax, _dirty.rowMax);
      invalidateBackgroundBlockChunkRect(_dirty.colMin, _dirty.rowMin, _dirty.colMax, _dirty.rowMax);
    }
    clearEditorPreviewDirty(_dirty);
  }

  setRenderViewportSize(canvasWidthPx, canvasHeightPx);

  // ── Room view (stable identity, mutated in place) ────────────────────────
  _previewRoomView.id = room.id;
  _previewRoomView.worldNumber = worldNumber;
  _previewRoomView.blockTheme = room.blockTheme;
  _previewRoomView.backgroundBlocks = room.backgroundBlocks;

  // ── Draw, in gameplay order ─────────────────────────────────────────────
  // `renderBackgroundBlocks` is typed against the full `RoomDef` but reads
  // only the fields in `PreviewRoomView`; the cast narrows that contract to
  // what this view actually provides.
  const view = _previewRoomView as PreviewRoomView as RoomDef;
  renderBackgroundBlocks(
    ctx,
    view,
    offsetXPx,
    offsetYPx,
    zoom,
    canvasWidthPx,
    canvasHeightPx,
  );

  const geometry = getEditorWallGeometry(room, wallGeometryRevision);
  renderWallSpritesWithLayout(
    ctx,
    geometry.snapshot,
    geometry.layout,
    _WALL_LAYOUT_REF,
    offsetXPx,
    offsetYPx,
    zoom,
    BLOCK_SIZE_SMALL,
  );

  renderDarkAmbientBlockerOverlay(
    ctx,
    offsetXPx,
    offsetYPx,
    zoom,
    BLOCK_SIZE_SMALL,
    canvasWidthPx,
    canvasHeightPx,
  );
}
