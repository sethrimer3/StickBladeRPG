import { BLOCK_SIZE_MEDIUM, type RoomDef } from '../levels/roomDef';
import { renderWorldBackground } from '../render/backgroundRenderer';
import type { RainParallaxBackground } from '../render/effects/rain/rainParallaxBackground';
import type { ThunderstormLightning } from '../render/effects/weather/thunderstormLightning';
import {
  isTheroShowcaseRoom,
  renderTheroShowcaseEffect,
  renderTheroBackgroundEffect,
  renderCrystallineCracksBackground,
} from '../render/effects/theroEffectManager';
import { STAGE_BACKGROUND, type RenderProfiler } from '../render/hud/renderProfiler';

/**
 * Minimal metadata for the staged (previous) room's background rendering.
 * Used only when seamless room crossing staging is active.
 */
export interface StagedRoomBgInfo {
  /** RoomDef of the staged room — used for worldNumber and backgroundId. */
  room: RoomDef;
  /** World-space X origin of the staged room. */
  originXWorld: number;
  /** World-space Y origin of the staged room. */
  originYWorld: number;
}

/**
 * Inputs for the static world-background image layer alone (no procedural
 * background effects).  Coordinates are always expressed in virtual/logical
 * pixels — the caller may pre-scale the context to draw the same layout at a
 * higher device resolution.
 */
export interface WorldBackgroundLayerContext {
  ctx: CanvasRenderingContext2D;
  currentRoom: RoomDef;
  stagedRoom: StagedRoomBgInfo | null;
  ox: number;
  oy: number;
  zoom: number;
  virtualWidthPx: number;
  virtualHeightPx: number;
  roomWidthWorld: number;
  roomHeightWorld: number;
}

export interface BackgroundPassContext extends WorldBackgroundLayerContext {
  nowMs: number;
  renderProfiler?: RenderProfiler;
  rainParallaxBackground?: RainParallaxBackground;
  thunderstormLightning?: ThunderstormLightning;
  /**
   * When true the static world-background image was already drawn by the
   * caller — at device resolution, on the device canvas — so this pass renders
   * only the procedural background effects on top.
   */
  worldBackgroundDrawnExternally?: boolean;
}

/**
 * Draw the static world-background image (plus the staged room's background
 * when a seamless crossing is active), clipped to each room's screen rect.
 *
 * Split out of {@link renderBackgroundPass} so the game renderer can draw this
 * layer straight onto the device canvas at full screen resolution: at the
 * game's native virtual resolution the parallax offset quantises to whole
 * virtual pixels, which makes slow camera motion look like it stutters.
 */
export function renderWorldBackgroundLayer(r: WorldBackgroundLayerContext): void {
  const {
    ctx,
    currentRoom,
    stagedRoom,
    ox,
    oy,
    zoom,
    virtualWidthPx,
    virtualHeightPx,
    roomWidthWorld,
    roomHeightWorld,
  } = r;

  if (stagedRoom !== null) {
    const stagedW = stagedRoom.room.widthBlocks * BLOCK_SIZE_MEDIUM;
    const stagedH = stagedRoom.room.heightBlocks * BLOCK_SIZE_MEDIUM;
    const stagedOx = ox + stagedRoom.originXWorld * zoom;
    const stagedOy = oy + stagedRoom.originYWorld * zoom;

    ctx.save();
    try {
      ctx.beginPath();
      ctx.rect(stagedOx, stagedOy, stagedW * zoom, stagedH * zoom);
      ctx.clip();
      renderWorldBackground(
        ctx,
        stagedRoom.room.worldNumber,
        virtualWidthPx,
        virtualHeightPx,
        stagedOx,
        stagedOy,
        stagedW,
        stagedH,
        zoom,
        stagedRoom.room.backgroundId,
        stagedRoom.room.backgroundBlur === true,
      );
    } finally {
      ctx.restore();
    }

    ctx.save();
    try {
      ctx.beginPath();
      ctx.rect(ox, oy, roomWidthWorld * zoom, roomHeightWorld * zoom);
      ctx.clip();
      renderWorldBackground(
        ctx,
        currentRoom.worldNumber,
        virtualWidthPx,
        virtualHeightPx,
        ox,
        oy,
        roomWidthWorld,
        roomHeightWorld,
        zoom,
        currentRoom.backgroundId,
        currentRoom.backgroundBlur === true,
      );
    } finally {
      ctx.restore();
    }
  } else {
    renderWorldBackground(
      ctx,
      currentRoom.worldNumber,
      virtualWidthPx,
      virtualHeightPx,
      ox,
      oy,
      roomWidthWorld,
      roomHeightWorld,
      zoom,
      currentRoom.backgroundId,
      currentRoom.backgroundBlur === true,
    );
  }
}

/**
 * Render room background and procedural background effects for the current frame.
 */
export function renderBackgroundPass(r: BackgroundPassContext): void {
  const {
    ctx,
    currentRoom,
    ox,
    oy,
    zoom,
    virtualWidthPx,
    virtualHeightPx,
    roomWidthWorld,
    roomHeightWorld,
    nowMs,
    renderProfiler,
    rainParallaxBackground,
    thunderstormLightning,
  } = r;

  if (renderProfiler !== undefined) renderProfiler.stageBegin(STAGE_BACKGROUND);

  if (r.worldBackgroundDrawnExternally !== true) renderWorldBackgroundLayer(r);

  const roomCenterOffsetXPx = virtualWidthPx * 0.5 - roomWidthWorld * 0.5 * zoom;
  const roomCenterOffsetYPx = virtualHeightPx * 0.5 - roomHeightWorld * 0.5 * zoom;
  const relCameraOffsetXPx = ox - roomCenterOffsetXPx;
  const relCameraOffsetYPx = oy - roomCenterOffsetYPx;

  if (rainParallaxBackground !== undefined) {
    rainParallaxBackground.render(ctx, relCameraOffsetXPx, relCameraOffsetYPx, virtualWidthPx, virtualHeightPx, nowMs);
  }

  // Thunderstorm lightning — background-only; walls/entities drawn after
  // this pass occlude it, so it never brightens the foreground.
  if (thunderstormLightning !== undefined) {
    thunderstormLightning.render(ctx, virtualWidthPx, virtualHeightPx);
  }

  const renderedTheroBackground = renderTheroBackgroundEffect(
    ctx,
    currentRoom.backgroundId,
    virtualWidthPx,
    virtualHeightPx,
    nowMs,
    relCameraOffsetXPx,
    relCameraOffsetYPx,
  );
  if (!renderedTheroBackground && isTheroShowcaseRoom(currentRoom.id)) {
    renderTheroShowcaseEffect(
      ctx,
      currentRoom.id,
      virtualWidthPx,
      virtualHeightPx,
      nowMs,
      relCameraOffsetXPx,
      relCameraOffsetYPx,
    );
  }

  if (currentRoom.backgroundId === 'crystallineCracks') {
    renderCrystallineCracksBackground(
      ctx,
      virtualWidthPx,
      virtualHeightPx,
      nowMs,
      relCameraOffsetXPx,
      relCameraOffsetYPx,
    );
  }

  if (renderProfiler !== undefined) renderProfiler.stageEnd(STAGE_BACKGROUND);
}
