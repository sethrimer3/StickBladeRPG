import { PlayerProgress } from '../progression/playerProgress';
import { WORLD1_LEVELS } from '../levels/world1';
import { WORLD2_LEVELS } from '../levels/world2';
import { LevelDef, LevelTheme, computeLevelDifficultyMultiplier } from '../levels/levelDef';
import {
  WORLD_MAP_NODES,
  WORLD_TREE_HUB_NODE,
  WorldMapNodeDef,
  computeWorldMapLinks,
  isWorldMapNodeUnlocked,
} from '../levels/worldMapTopology';
import { DecorativeParticleBackground } from '../render/decorativeParticles';
import { t, tPlural } from '../i18n';
import { ParticleKind } from '../sim/particles/kinds';

export interface WorldMapCallbacks {
  onStartLevel: (progress: PlayerProgress, level: LevelDef) => void;
}

const THEME_PALETTES: Record<LevelTheme, { primary: string; border: string; glow: string; bg: string }> = {
  physical: { primary: '#44dd88', border: '#66eeaa', glow: 'rgba(68,221,136,0.35)', bg: '#0d2215' },
  water:    { primary: '#33aaff', border: '#66c2ff', glow: 'rgba(51,170,255,0.35)', bg: '#0d1a29' },
  ice:      { primary: '#77ddff', border: '#aaeeff', glow: 'rgba(119,221,255,0.40)', bg: '#0d222b' },
  fire:     { primary: '#ff6622', border: '#ff8844', glow: 'rgba(255,102,34,0.40)', bg: '#29140a' },
  lava:     { primary: '#ff3300', border: '#ff5522', glow: 'rgba(255,51,0,0.45)', bg: '#290c05' },
  stone:    { primary: '#ffcc44', border: '#ffdd66', glow: 'rgba(255,204,68,0.35)', bg: '#26200a' },
  metal:    { primary: '#aa88ff', border: '#ccaaee', glow: 'rgba(170,136,255,0.35)', bg: '#1c102b' },
  boss:     { primary: '#ff3366', border: '#ff6688', glow: 'rgba(255,51,102,0.50)', bg: '#2b0a14' },
};

const WORLD_NAMES: Record<number, string> = {
  0: 'World Tree Sanctuary',
  1: 'Verdant Canopy',
  2: 'Glacier Peak',
  3: 'Ashen Caldera',
  4: 'Tidal Trench',
  5: 'Solar Dunes',
  6: 'Obsidian Abyss',
  7: 'Chrono Spire',
  8: 'Parallax Void',
};

/**
 * Creates a playable LevelDef for any WorldMapNodeDef.
 * Reuses existing pre-authored levels when matching (e.g. World 1/2),
 * or constructs a scaled stage instance with bosses/enemies.
 */
export function createLevelFromWorldMapNode(node: WorldMapNodeDef): LevelDef {
  if (node.worldNumber === 1 && WORLD1_LEVELS[node.stageNumber - 1]) {
    const existing = WORLD1_LEVELS[node.stageNumber - 1];
    return {
      ...existing,
      id: node.id,
      difficultyMultiplier: computeLevelDifficultyMultiplier({ ...existing, mapNode: node }),
      mapNode: {
        x: node.x,
        y: node.y,
        branch: node.branch,
        branchStep: node.branchStep,
        stageCode: node.stageCode,
        order: node.order,
        boss: node.isBoss,
      },
    };
  }

  if (node.worldNumber === 2 && WORLD2_LEVELS[node.stageNumber - 1]) {
    const existing = WORLD2_LEVELS[node.stageNumber - 1];
    return {
      ...existing,
      id: node.id,
      difficultyMultiplier: computeLevelDifficultyMultiplier({ ...existing, mapNode: node }),
      mapNode: {
        x: node.x,
        y: node.y,
        branch: node.branch,
        branchStep: node.branchStep,
        stageCode: node.stageCode,
        order: node.order,
        boss: node.isBoss,
      },
    };
  }

  const difficulty = computeLevelDifficultyMultiplier({ mapNode: node });
  const theme = node.theme;
  const kind = theme === 'ice'
    ? ParticleKind.Ice
    : (theme === 'fire' || theme === 'lava')
      ? ParticleKind.FireDust
      : (theme === 'water')
        ? ParticleKind.Water
        : (theme === 'metal' || theme === 'boss')
          ? ParticleKind.Void
          : ParticleKind.Golden;

  const enemies: LevelDef['enemies'] = [
    {
      xFraction: 0.65,
      yFraction: 0.50,
      kinds: [kind],
      particleCount: Math.round(15 + difficulty * 2.5),
      isBossFlag: node.isBoss ? 1 : 0,
    },
  ];

  if (node.stageNumber >= 3) {
    enemies.push({
      xFraction: 0.80,
      yFraction: 0.45,
      kinds: [kind],
      particleCount: Math.round(12 + difficulty * 2.0),
      isBossFlag: 0,
    });
  }

  return {
    id: node.id,
    worldNumber: node.worldNumber,
    levelNumber: node.stageNumber,
    name: node.name,
    theme: node.theme,
    description: node.description,
    enemies,
    walls: [
      { xFraction: 0.05, yFraction: 0.85, wFraction: 0.90, hFraction: 0.10 },
      { xFraction: 0.05, yFraction: 0.05, wFraction: 0.90, hFraction: 0.10 },
      { xFraction: 0.05, yFraction: 0.05, wFraction: 0.05, hFraction: 0.90 },
      { xFraction: 0.90, yFraction: 0.05, wFraction: 0.05, hFraction: 0.90 },
      { xFraction: 0.30, yFraction: 0.65, wFraction: 0.40, hFraction: 0.05 },
    ],
    entryDoor: { xFraction: 0.12, yFraction: 0.70, wFraction: 0.08, hFraction: 0.15, target: 'next' },
    exitDoor: { xFraction: 0.82, yFraction: 0.70, wFraction: 0.08, hFraction: 0.15, target: node.isBoss ? 'menu' : 'next' },
    mapNode: {
      x: node.x,
      y: node.y,
      branch: node.branch,
      branchStep: node.branchStep,
      stageCode: node.stageCode,
      order: node.order,
      boss: node.isBoss,
    },
    boss: node.isBoss
      ? {
        name: node.bossName ?? `${node.name} Boss`,
        kind: 'stickRpgBoss',
        hp: node.bossHp ?? 300,
        attack: node.bossAttack ?? 100,
        defense: node.bossDefense ?? 50,
      }
      : undefined,
    difficultyMultiplier: difficulty,
  };
}

export function showWorldMap(
  root: HTMLElement,
  progress: PlayerProgress,
  callbacks: WorldMapCallbacks,
): () => void {
  const bg = new DecorativeParticleBackground('worldmap');
  bg.resize(window.innerWidth, window.innerHeight);

  const completedSet = new Set<string>(progress.completedStageIds ?? []);
  if (progress.world1UnlockedCount > 1) {
    for (let s = 1; s < progress.world1UnlockedCount && s <= 5; s++) {
      completedSet.add(`world1Stage${s}`);
    }
  }
  if ((progress.world2UnlockedCount ?? 0) > 1) {
    for (let s = 1; s < (progress.world2UnlockedCount ?? 0) && s <= 5; s++) {
      completedSet.add(`world2Stage${s}`);
    }
  }

  const allNodes: WorldMapNodeDef[] = [WORLD_TREE_HUB_NODE, ...WORLD_MAP_NODES];
  const links = computeWorldMapLinks();

  let selectedWorldFilter = 0; // 0 = all
  let hoveredNode: WorldMapNodeDef | null = null;
  let selectedNode: WorldMapNodeDef = WORLD_MAP_NODES[0];

  const mapCanvas = document.createElement('canvas');
  mapCanvas.style.cssText = `
    position: absolute; top: 0; left: 0; width: 100%; height: 100%;
    z-index: 1; cursor: pointer;
  `;
  const ctx = mapCanvas.getContext('2d')!;

  const uiContainer = document.createElement('div');
  uiContainer.id = 'world-map-ui';
  uiContainer.style.cssText = `
    position: absolute; top: 0; left: 0; width: 100%; height: 100%;
    display: flex; flex-direction: column; justify-content: space-between;
    pointer-events: none; z-index: 2; font-family: 'Cinzel', serif; color: #fff;
    padding: 1.2rem; box-sizing: border-box;
  `;

  // ── Header ─────────────────────────────────────────────────────────────
  const header = document.createElement('div');
  header.style.cssText = 'text-align: center; pointer-events: auto;';
  header.innerHTML = `
    <h2 style="font-size: 1.8rem; color: #00e5ff; text-shadow: 0 0 16px rgba(0,229,255,0.6); margin: 0 0 0.2rem; letter-spacing: 0.1em;">
      ${t('worldMap.title')}
    </h2>
    <p style="color: #8da3d7; font-size: 0.85rem; margin: 0 0 0.6rem;">
      ${tPlural('worldMap.subtitle', progress.dustSlots, { level: progress.level })}
    </p>
  `;

  // World selector filter tabs
  const filterRow = document.createElement('div');
  filterRow.style.cssText = 'display: flex; gap: 0.4rem; justify-content: center; flex-wrap: wrap; margin-bottom: 0.5rem;';
  const filterButtons: HTMLButtonElement[] = [];

  for (let w = 0; w <= 8; w++) {
    const btn = document.createElement('button');
    btn.textContent = w === 0 ? 'All Worlds' : `W${w}`;
    btn.style.cssText = `
      background: ${w === selectedWorldFilter ? 'rgba(0,229,255,0.3)' : 'rgba(10,20,35,0.7)'};
      border: 1px solid ${w === selectedWorldFilter ? '#00e5ff' : 'rgba(100,150,220,0.3)'};
      color: ${w === selectedWorldFilter ? '#fff' : '#8da3d7'};
      padding: 0.3rem 0.7rem; font-size: 0.75rem; border-radius: 4px; cursor: pointer;
      font-family: 'Cinzel', serif; transition: all 0.15s;
    `;
    btn.addEventListener('click', () => {
      selectedWorldFilter = w;
      for (let i = 0; i < filterButtons.length; i++) {
        const isCurrent = i === selectedWorldFilter;
        filterButtons[i].style.background = isCurrent ? 'rgba(0,229,255,0.3)' : 'rgba(10,20,35,0.7)';
        filterButtons[i].style.borderColor = isCurrent ? '#00e5ff' : 'rgba(100,150,220,0.3)';
        filterButtons[i].style.color = isCurrent ? '#fff' : '#8da3d7';
      }
      renderMap();
    });
    filterButtons.push(btn);
    filterRow.appendChild(btn);
  }
  header.appendChild(filterRow);
  uiContainer.appendChild(header);

  // ── Inspector Panel (Bottom) ──────────────────────────────────────────
  const inspector = document.createElement('div');
  inspector.style.cssText = `
    align-self: center; width: 100%; max-width: 580px;
    background: rgba(8, 14, 26, 0.88); border: 1px solid rgba(100, 180, 255, 0.4);
    box-shadow: 0 0 24px rgba(0, 140, 255, 0.25); border-radius: 8px;
    padding: 0.9rem 1.4rem; pointer-events: auto; backdrop-filter: blur(8px);
    display: flex; justify-content: space-between; align-items: center; gap: 1rem;
    transition: all 0.2s;
  `;

  const infoCol = document.createElement('div');
  infoCol.style.cssText = 'flex: 1; min-width: 0;';

  const deployBtn = document.createElement('button');
  deployBtn.style.cssText = `
    background: linear-gradient(135deg, #0099ff, #00ddbb); border: none;
    color: #05111d; font-weight: bold; font-family: 'Cinzel', serif;
    font-size: 0.95rem; padding: 0.8rem 1.6rem; border-radius: 6px;
    cursor: pointer; box-shadow: 0 0 16px rgba(0, 220, 200, 0.4);
    transition: all 0.15s; white-space: nowrap;
  `;
  deployBtn.textContent = t('worldMap.deploy');
  deployBtn.addEventListener('mouseenter', () => {
    deployBtn.style.transform = 'scale(1.04)';
    deployBtn.style.boxShadow = '0 0 24px rgba(0, 220, 200, 0.7)';
  });
  deployBtn.addEventListener('mouseleave', () => {
    deployBtn.style.transform = 'scale(1)';
    deployBtn.style.boxShadow = '0 0 16px rgba(0, 220, 200, 0.4)';
  });
  deployBtn.addEventListener('click', () => {
    if (selectedNode && isWorldMapNodeUnlocked(selectedNode, completedSet)) {
      const level = createLevelFromWorldMapNode(selectedNode);
      callbacks.onStartLevel(progress, level);
    }
  });

  inspector.appendChild(infoCol);
  inspector.appendChild(deployBtn);
  uiContainer.appendChild(inspector);

  function updateInspector(node: WorldMapNodeDef): void {
    const isUnlocked = isWorldMapNodeUnlocked(node, completedSet);
    const isCompleted = completedSet.has(node.id);
    const palette = THEME_PALETTES[node.theme] ?? THEME_PALETTES.physical;
    const diff = computeLevelDifficultyMultiplier({ mapNode: node });

    infoCol.innerHTML = `
      <div style="display:flex; align-items:center; gap: 0.6rem; margin-bottom: 0.25rem;">
        <span style="background:${palette.border}; color:#000; font-weight:bold; font-size:0.75rem; padding:0.15rem 0.45rem; border-radius:3px;">
          ${node.stageCode}${node.isBoss ? ' ★ BOSS' : ''}
        </span>
        <span style="font-size: 1.1rem; font-weight: bold; color: ${isUnlocked ? palette.border : '#666'};">
          ${isUnlocked ? node.name : '— Locked Stage —'}
        </span>
        <span style="font-size: 0.75rem; color: #8da3d7; opacity: 0.8;">
          ${WORLD_NAMES[node.worldNumber] ?? ''}
        </span>
      </div>
      <div style="font-size: 0.8rem; color: #bbb; margin-bottom: 0.3rem; line-height: 1.3;">
        ${isUnlocked ? node.description : 'Defeat the preceding stage to unlock this sector.'}
      </div>
      <div style="display:flex; gap: 1rem; font-size: 0.75rem; color: #8da3d7;">
        <span>Theme: <b style="color:${palette.border};">${node.theme.toUpperCase()}</b></span>
        <span>Difficulty: <b style="color:#ffcc44;">${diff}×</b></span>
        <span>Status: <b style="color:${isCompleted ? '#44ff88' : isUnlocked ? '#00e5ff' : '#888'};">
          ${isCompleted ? '✓ Cleared' : isUnlocked ? 'Ready' : 'Locked'}
        </b></span>
      </div>
    `;

    deployBtn.disabled = !isUnlocked;
    deployBtn.style.opacity = isUnlocked ? '1' : '0.4';
    deployBtn.style.cursor = isUnlocked ? 'pointer' : 'not-allowed';
    deployBtn.textContent = isCompleted ? t('worldMap.replay') : t('worldMap.deploy');
  }

  function getScreenCoords(xFrac: number, yFrac: number): { x: number; y: number } {
    const w = mapCanvas.width;
    const h = mapCanvas.height;
    const margin = 70;
    const mapW = w - margin * 2;
    const mapH = h - margin * 2 - 80;
    return {
      x: margin + xFrac * mapW,
      y: margin + 30 + yFrac * mapH,
    };
  }

  function renderMap(): void {
    const w = mapCanvas.width;
    const h = mapCanvas.height;
    ctx.clearRect(0, 0, w, h);

    // Filter nodes if world filter is active
    const visibleNodes = selectedWorldFilter === 0
      ? allNodes
      : allNodes.filter(n => n.worldNumber === 0 || n.worldNumber === selectedWorldFilter);

    const visibleNodeIds = new Set(visibleNodes.map(n => n.id));

    // Draw connecting links
    for (const link of links) {
      if (!visibleNodeIds.has(link.fromId) || !visibleNodeIds.has(link.toId)) continue;
      const fromNode = allNodes.find(n => n.id === link.fromId);
      const toNode = allNodes.find(n => n.id === link.toId);
      if (!fromNode || !toNode) continue;

      const p1 = getScreenCoords(fromNode.x, fromNode.y);
      const p2 = getScreenCoords(toNode.x, toNode.y);

      const isToUnlocked = isWorldMapNodeUnlocked(toNode, completedSet);

      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);

      if (isToUnlocked) {
        ctx.strokeStyle = 'rgba(77, 180, 255, 0.45)';
        ctx.lineWidth = 3;
        ctx.setLineDash([]);
        ctx.stroke();

        ctx.strokeStyle = 'rgba(120, 220, 255, 0.8)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
      } else {
        ctx.strokeStyle = 'rgba(60, 75, 100, 0.25)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 6]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Draw nodes
    for (const node of visibleNodes) {
      const pos = getScreenCoords(node.x, node.y);
      const isUnlocked = isWorldMapNodeUnlocked(node, completedSet);
      const isCompleted = completedSet.has(node.id);
      const isHovered = hoveredNode?.id === node.id;
      const isSelected = selectedNode?.id === node.id;
      const palette = THEME_PALETTES[node.theme] ?? THEME_PALETTES.physical;

      const radius = node.id === 'worldTree' ? 24 : node.isBoss ? 20 : 16;

      // Glow halo
      if (isSelected || isHovered) {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, radius + 8, 0, Math.PI * 2);
        ctx.fillStyle = palette.glow;
        ctx.fill();
      }

      // Outer ring
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = isUnlocked ? palette.bg : '#0a0d14';
      ctx.fill();
      ctx.lineWidth = isSelected ? 3 : isHovered ? 2.5 : 1.5;
      ctx.strokeStyle = isSelected ? '#ffffff' : isUnlocked ? palette.border : '#334455';
      ctx.stroke();

      // Inner badge / label
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `bold ${radius * 0.65}px 'Cinzel', serif`;
      ctx.fillStyle = isUnlocked ? (isCompleted ? '#44ff88' : palette.border) : '#556677';
      ctx.fillText(node.order ?? node.stageCode, pos.x, pos.y);

      // Boss star icon
      if (node.isBoss) {
        ctx.font = '10px serif';
        ctx.fillStyle = '#ff4466';
        ctx.fillText('★', pos.x, pos.y - radius - 6);
      }
    }
  }

  function handleMouseMove(e: MouseEvent): void {
    const rect = mapCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const visibleNodes = selectedWorldFilter === 0
      ? allNodes
      : allNodes.filter(n => n.worldNumber === 0 || n.worldNumber === selectedWorldFilter);

    let found: WorldMapNodeDef | null = null;
    for (const node of visibleNodes) {
      const pos = getScreenCoords(node.x, node.y);
      const radius = node.id === 'worldTree' ? 24 : node.isBoss ? 20 : 16;
      const dx = mx - pos.x;
      const dy = my - pos.y;
      if (dx * dx + dy * dy <= (radius + 6) * (radius + 6)) {
        found = node;
        break;
      }
    }

    if (hoveredNode !== found) {
      hoveredNode = found;
      if (found) {
        selectedNode = found;
        updateInspector(found);
      }
      renderMap();
    }
  }

  function handleClick(e: MouseEvent): void {
    const rect = mapCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const visibleNodes = selectedWorldFilter === 0
      ? allNodes
      : allNodes.filter(n => n.worldNumber === 0 || n.worldNumber === selectedWorldFilter);

    for (const node of visibleNodes) {
      const pos = getScreenCoords(node.x, node.y);
      const radius = node.id === 'worldTree' ? 24 : node.isBoss ? 20 : 16;
      const dx = mx - pos.x;
      const dy = my - pos.y;
      if (dx * dx + dy * dy <= (radius + 6) * (radius + 6)) {
        selectedNode = node;
        updateInspector(node);
        renderMap();
        break;
      }
    }
  }

  function onResize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    bg.resize(w, h);
    mapCanvas.width = w;
    mapCanvas.height = h;
    renderMap();
  }

  mapCanvas.addEventListener('mousemove', handleMouseMove);
  mapCanvas.addEventListener('click', handleClick);
  window.addEventListener('resize', onResize);

  root.appendChild(bg.canvas);
  root.appendChild(mapCanvas);
  root.appendChild(uiContainer);

  onResize();
  updateInspector(selectedNode);
  bg.start();

  return () => {
    bg.stop();
    window.removeEventListener('resize', onResize);
    mapCanvas.removeEventListener('mousemove', handleMouseMove);
    mapCanvas.removeEventListener('click', handleClick);
    if (bg.canvas.parentElement !== null) bg.canvas.parentElement.removeChild(bg.canvas);
    if (mapCanvas.parentElement !== null) mapCanvas.parentElement.removeChild(mapCanvas);
    if (uiContainer.parentElement !== null) uiContainer.parentElement.removeChild(uiContainer);
  };
}
