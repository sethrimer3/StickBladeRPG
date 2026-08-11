/**
 * Skill Points Allocation UI panel.
 *
 * Modeled on `src/ui/weaveLoadout.ts` and `src/ui/skillTombLoadout.ts`.
 * Displays character stats, XP progress, and lets the player spend unspent
 * skill points on Health, Attack, and Defense tracks with live derived-stat preview.
 */

import type { PartyState } from '../sim/party/partyState';
import type { SkillTrack } from '../sim/stats/characterStats';
import {
  allocateSkillPoint,
  respecSkillPoints,
  computeDerivedStats,
  computeSkillMultipliers,
} from '../sim/stats/characterStats';

export interface SkillPanelCallbacks {
  onConfirm: (updatedParty: PartyState) => void;
  onCancel: () => void;
}

const GOLD = '#ffd700';
const GOLD_DIM = '#d4a84b';
const PANEL_BG = 'rgba(10,8,6,0.96)';

export function showSkillPanel(
  root: HTMLElement,
  currentParty: PartyState,
  callbacks: SkillPanelCallbacks,
): () => void {
  // Deep clone so changes are isolated until confirmed
  const party: PartyState = JSON.parse(JSON.stringify(currentParty));
  let selectedMemberIndex = party.activeIndex;

  // Root container
  const el = document.createElement('div');
  el.id = 'skill-panel-screen';
  el.style.cssText = `
    position: absolute; top: 0; left: 0; width: 100%; height: 100%;
    background: ${PANEL_BG};
    color: #eee; font-family: 'Cinzel', serif;
    display: flex; flex-direction: column; align-items: center;
    overflow-y: auto; box-sizing: border-box; padding: 24px 16px 80px;
    z-index: 1500;
  `;
  root.appendChild(el);

  // Header
  const header = document.createElement('div');
  header.style.cssText = 'text-align:center; margin-bottom:16px; width:100%;';
  header.innerHTML = `
    <h2 style="font-size:1.8rem; color:${GOLD}; margin:0 0 6px;">Skill Allocations</h2>
    <p style="color:#aaa; font-size:0.85rem; margin:0;">
      Spend skill points earned from level-ups to boost character attributes.
    </p>
  `;
  el.appendChild(header);

  // Member tabs
  const memberTabs = document.createElement('div');
  memberTabs.style.cssText = 'display:flex; gap:8px; margin-bottom:20px; justify-content:center;';
  el.appendChild(memberTabs);

  // Main content box
  const contentBox = document.createElement('div');
  contentBox.style.cssText = `
    width: 100%; max-width: 500px;
    background: rgba(20,20,30,0.9); border: 1px solid ${GOLD_DIM};
    border-radius: 8px; padding: 20px; box-sizing: border-box;
    display: flex; flex-direction: column; gap: 16px; margin-bottom: 24px;
  `;
  el.appendChild(contentBox);

  function render(): void {
    // Render member tabs
    memberTabs.innerHTML = '';
    party.members.forEach((member, index) => {
      if (!member.isRecruited) return;
      const isSelected = selectedMemberIndex === index;
      const tabBtn = document.createElement('button');
      tabBtn.textContent = `${member.name} (Lv.${member.stats.level})`;
      tabBtn.style.cssText = `
        font-family: 'Cinzel', serif; font-size: 0.85rem; padding: 6px 14px;
        border-radius: 4px; border: 1px solid ${isSelected ? GOLD : '#555'};
        background: ${isSelected ? 'rgba(212,168,75,0.2)' : 'rgba(0,0,0,0.5)'};
        color: ${isSelected ? GOLD : '#aaa'};
        cursor: pointer; font-weight: bold; transition: all 0.15s;
      `;
      tabBtn.addEventListener('click', () => {
        selectedMemberIndex = index;
        render();
      });
      memberTabs.appendChild(tabBtn);
    });

    const member = party.members[selectedMemberIndex] ?? party.members[0];
    if (!member) return;

    const stats = member.stats;
    const derived = computeDerivedStats(stats);
    const multipliers = computeSkillMultipliers(stats.skillAllocations);

    // XP Progress bar
    const xpPercent = stats.xpToNextLevel > 0
      ? Math.min(100, Math.round((stats.xp / stats.xpToNextLevel) * 100))
      : 100;

    contentBox.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #333; padding-bottom:10px;">
        <span style="font-size:1.1rem; color:${GOLD}; font-weight:bold;">${member.name}</span>
        <span style="color:#aaa; font-size:0.9rem;">Level <b style="color:#eee;">${stats.level}</b></span>
      </div>

      <div>
        <div style="display:flex; justify-content:space-between; font-size:0.75rem; color:#888; margin-bottom:4px;">
          <span>Experience</span>
          <span>${stats.xp} / ${stats.xpToNextLevel} XP</span>
        </div>
        <div style="background:#111; height:8px; border-radius:4px; overflow:hidden; border:1px solid #333;">
          <div style="background:#5cd65c; height:100%; width:${xpPercent}%;"></div>
        </div>
      </div>

      <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(212,168,75,0.1); border:1px solid rgba(212,168,75,0.3); border-radius:6px; padding:10px 14px;">
        <span style="color:#ddd; font-size:0.9rem;">Available Skill Points:</span>
        <span style="font-size:1.2rem; color:${GOLD}; font-weight:bold;">${stats.skillPoints}</span>
      </div>

      <div id="tracks-container" style="display:flex; flex-direction:column; gap:12px;"></div>

      <div style="display:flex; justify-content:flex-end;">
        <button id="respec-btn" style="
          font-family: 'Cinzel', serif; font-size:0.75rem; padding:4px 10px;
          background: transparent; color: #ff9999; border: 1px solid #883333;
          border-radius: 4px; cursor: pointer;
        ">Reset Points</button>
      </div>
    `;

    // Respec button
    const respecBtn = contentBox.querySelector('#respec-btn') as HTMLButtonElement;
    if (respecBtn) {
      respecBtn.addEventListener('click', () => {
        respecSkillPoints(stats);
        render();
      });
    }

    // Tracks
    const tracksContainer = contentBox.querySelector('#tracks-container');
    if (!tracksContainer) return;

    const tracks: Array<{ key: SkillTrack; label: string; color: string; val: number; mult: number; finalStat: number }> = [
      { key: 'health', label: 'Health', color: '#5cd65c', val: stats.skillAllocations.health, mult: multipliers.maxHealth, finalStat: derived.maxHealth },
      { key: 'attack', label: 'Attack', color: '#ff6666', val: stats.skillAllocations.attack, mult: multipliers.attack, finalStat: derived.attack },
      { key: 'defense', label: 'Defense', color: '#66a3ff', val: stats.skillAllocations.defense, mult: multipliers.defense, finalStat: derived.defense },
    ];

    tracks.forEach(tInfo => {
      const row = document.createElement('div');
      row.style.cssText = `
        display: flex; justify-content: space-between; align-items: center;
        background: rgba(0,0,0,0.35); border-radius: 6px; padding: 8px 12px;
        border-left: 3px solid ${tInfo.color};
      `;

      row.innerHTML = `
        <div style="display:flex; flex-direction:column;">
          <span style="color:${tInfo.color}; font-weight:bold; font-size:0.9rem;">${tInfo.label}</span>
          <span style="color:#777; font-size:0.75rem;">Total: <b style="color:#eee;">${tInfo.finalStat}</b> (×${tInfo.mult.toFixed(1)})</span>
        </div>
        <div style="display:flex; align-items:center; gap:8px;">
          <span style="font-size:0.95rem; color:#eee; min-width:20px; text-align:center;">+${tInfo.val}</span>
        </div>
      `;

      const plusBtn = document.createElement('button');
      plusBtn.textContent = '+';
      plusBtn.disabled = stats.skillPoints <= 0;
      plusBtn.style.cssText = `
        font-family: 'Cinzel', serif; font-size: 1rem; width: 28px; height: 28px;
        display: flex; align-items: center; justify-content: center;
        border-radius: 4px; border: 1px solid ${stats.skillPoints > 0 ? GOLD : '#444'};
        background: ${stats.skillPoints > 0 ? GOLD : 'transparent'};
        color: ${stats.skillPoints > 0 ? '#111' : '#444'};
        cursor: ${stats.skillPoints > 0 ? 'pointer' : 'default'};
        font-weight: bold;
      `;
      plusBtn.addEventListener('click', () => {
        if (allocateSkillPoint(stats, tInfo.key)) {
          render();
        }
      });

      row.querySelector('div:last-child')?.appendChild(plusBtn);
      tracksContainer.appendChild(row);
    });
  }

  render();

  // Bottom action bar
  const actionBar = document.createElement('div');
  actionBar.style.cssText = `
    position: fixed; bottom: 0; left: 0; right: 0;
    display: flex; gap: 16px; justify-content: center; align-items: center;
    background: rgba(5,4,3,0.95); border-top: 1px solid ${GOLD_DIM};
    padding: 12px 16px; box-sizing: border-box; z-index: 1510;
  `;
  el.appendChild(actionBar);

  function cleanup(): void {
    if (el.parentNode) el.parentNode.removeChild(el);
  }

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = `
    font-family: 'Cinzel', serif; font-size: 0.9rem; padding: 8px 24px;
    background: transparent; color: #888; border: 1px solid #555;
    border-radius: 4px; cursor: pointer; transition: all 0.15s;
  `;
  cancelBtn.addEventListener('mouseenter', () => { cancelBtn.style.color = '#fff'; cancelBtn.style.borderColor = '#888'; });
  cancelBtn.addEventListener('mouseleave', () => { cancelBtn.style.color = '#888'; cancelBtn.style.borderColor = '#555'; });
  cancelBtn.addEventListener('click', () => {
    cleanup();
    callbacks.onCancel();
  });
  actionBar.appendChild(cancelBtn);

  const confirmBtn = document.createElement('button');
  confirmBtn.textContent = 'Confirm';
  confirmBtn.style.cssText = `
    font-family: 'Cinzel', serif; font-size: 0.9rem; padding: 8px 28px;
    background: ${GOLD}; color: #111; font-weight: bold; border: 1px solid ${GOLD};
    border-radius: 4px; cursor: pointer; transition: all 0.15s;
  `;
  confirmBtn.addEventListener('mouseenter', () => { confirmBtn.style.background = '#ffe555'; });
  confirmBtn.addEventListener('mouseleave', () => { confirmBtn.style.background = GOLD; });
  confirmBtn.addEventListener('click', () => {
    cleanup();
    callbacks.onConfirm(party);
  });
  actionBar.appendChild(confirmBtn);

  return cleanup;
}
