/**
 * Party Management UI panel.
 *
 * Modeled on `src/ui/weaveLoadout.ts` and `src/ui/skillTombLoadout.ts`.
 * Displays the 3 party member roster, lets the player switch active leader,
 * view stats, and configure equipment (mainHand, offHand, armor).
 */

import type { PartyState } from '../sim/party/partyState';
import {
  setActiveMember,
  equipToSubslot,
  computeEquipmentModifiers,
} from '../sim/party/partyState';
import { computeDerivedStats } from '../sim/stats/characterStats';
import { WEAPON_IDS, getWeaponDef, isPlayerEquippableWeapon } from '../sim/weapons/weaponDefs';

export interface PartyPanelCallbacks {
  onConfirm: (updatedParty: PartyState) => void;
  onCancel: () => void;
}

const GOLD = '#ffd700';
const GOLD_DIM = '#d4a84b';
const PANEL_BG = 'rgba(10,8,6,0.96)';

export function showPartyPanel(
  root: HTMLElement,
  currentParty: PartyState,
  callbacks: PartyPanelCallbacks,
): () => void {
  // Deep clone so changes are isolated until confirmed
  const party: PartyState = JSON.parse(JSON.stringify(currentParty));

  // Available player equippable weapons
  const equippableWeapons = WEAPON_IDS.map(id => ({ id, def: getWeaponDef(id)! }))
    .filter(w => w.def !== null && isPlayerEquippableWeapon(w.def));

  // Root container
  const el = document.createElement('div');
  el.id = 'party-panel-screen';
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
  header.style.cssText = 'text-align:center; margin-bottom:20px; width:100%;';
  header.innerHTML = `
    <h2 style="font-size:1.8rem; color:${GOLD}; margin:0 0 6px;">Party Roster</h2>
    <p style="color:#aaa; font-size:0.85rem; margin:0;">
      Select the active leader and equip weapons for each party member.
    </p>
  `;
  el.appendChild(header);

  // Cards container
  const cardsContainer = document.createElement('div');
  cardsContainer.style.cssText = `
    display: flex; gap: 16px; flex-wrap: wrap; justify-content: center;
    width: 100%; max-width: 900px; margin-bottom: 24px;
  `;
  el.appendChild(cardsContainer);

  function renderMemberCards(): void {
    cardsContainer.innerHTML = '';

    party.members.forEach((member, index) => {
      const isActive = party.activeIndex === index;
      const card = document.createElement('div');
      card.style.cssText = `
        flex: 1; min-width: 250px; max-width: 280px;
        background: ${isActive ? 'rgba(212,168,75,0.12)' : 'rgba(25,25,35,0.85)'};
        border: 2px solid ${isActive ? GOLD : 'rgba(212,168,75,0.3)'};
        border-radius: 8px; padding: 16px; box-sizing: border-box;
        display: flex; flex-direction: column; gap: 12px;
        transition: border-color 0.2s, background 0.2s;
      `;

      // Header row
      const cardHeader = document.createElement('div');
      cardHeader.style.cssText = 'display:flex; justify-content:space-between; align-items:center;';

      const nameEl = document.createElement('div');
      nameEl.style.cssText = `font-size:1.1rem; font-weight:bold; color:${isActive ? GOLD : '#ddd'};`;
      nameEl.textContent = member.name || `Member ${index + 1}`;
      cardHeader.appendChild(nameEl);

      if (member.isRecruited) {
        const leaderBtn = document.createElement('button');
        leaderBtn.textContent = isActive ? '★ LEADER' : 'Make Leader';
        leaderBtn.style.cssText = `
          font-family: 'Cinzel', serif; font-size: 0.75rem; padding: 4px 8px;
          border-radius: 4px; border: 1px solid ${isActive ? GOLD : '#666'};
          background: ${isActive ? GOLD : 'transparent'};
          color: ${isActive ? '#111' : '#aaa'};
          cursor: ${isActive ? 'default' : 'pointer'}; font-weight: bold;
        `;
        if (!isActive) {
          leaderBtn.addEventListener('click', () => {
            setActiveMember(party, index);
            renderMemberCards();
          });
        }
        cardHeader.appendChild(leaderBtn);
      } else {
        const unrecruitedBadge = document.createElement('span');
        unrecruitedBadge.textContent = 'Locked';
        unrecruitedBadge.style.cssText = 'font-size:0.75rem; color:#666; font-style:italic;';
        cardHeader.appendChild(unrecruitedBadge);
      }
      card.appendChild(cardHeader);

      if (!member.isRecruited) {
        const lockedMsg = document.createElement('div');
        lockedMsg.style.cssText = 'color:#666; font-size:0.8rem; text-align:center; padding: 30px 0;';
        lockedMsg.textContent = 'Not recruited yet';
        card.appendChild(lockedMsg);
        cardsContainer.appendChild(card);
        return;
      }

      // Stats preview
      const eqMods = computeEquipmentModifiers(member.equipment);
      const derived = computeDerivedStats(member.stats, eqMods);

      const statsEl = document.createElement('div');
      statsEl.style.cssText = `
        background: rgba(0,0,0,0.4); border-radius: 6px; padding: 8px 10px;
        font-size: 0.8rem; display: grid; grid-template-columns: 1fr 1fr; gap: 4px 8px;
      `;
      statsEl.innerHTML = `
        <span style="color:#888;">Level: <b style="color:#eee;">${member.stats.level}</b></span>
        <span style="color:#888;">HP: <b style="color:#5cd65c;">${derived.maxHealth}</b></span>
        <span style="color:#888;">Attack: <b style="color:#ff6666;">${derived.attack}</b></span>
        <span style="color:#888;">Defense: <b style="color:#66a3ff;">${derived.defense}</b></span>
      `;
      card.appendChild(statsEl);

      // Equipment selectors
      const eqSection = document.createElement('div');
      eqSection.style.cssText = 'display:flex; flex-direction:column; gap:8px;';

      // Main Hand
      const mainHandLabel = document.createElement('label');
      mainHandLabel.style.cssText = 'font-size:0.75rem; color:#aaa; display:flex; flex-direction:column; gap:2px;';
      mainHandLabel.textContent = 'Main Hand:';
      const mainHandSelect = document.createElement('select');
      mainHandSelect.style.cssText = `
        background: #1a1a24; color: #eee; border: 1px solid #444; border-radius: 4px;
        padding: 4px 6px; font-family: 'Cinzel', serif; font-size: 0.8rem;
      `;
      const noneOpt = document.createElement('option');
      noneOpt.value = '';
      noneOpt.textContent = '— None —';
      mainHandSelect.appendChild(noneOpt);

      for (const w of equippableWeapons) {
        const opt = document.createElement('option');
        opt.value = w.id;
        opt.textContent = `${w.def.name} (${w.def.kind})`;
        if (member.equipment.mainHand === w.id) opt.selected = true;
        mainHandSelect.appendChild(opt);
      }
      mainHandSelect.addEventListener('change', () => {
        equipToSubslot(member.equipment, 'mainHand', mainHandSelect.value || null);
        renderMemberCards();
      });
      mainHandLabel.appendChild(mainHandSelect);
      eqSection.appendChild(mainHandLabel);

      // Off Hand
      const mainDef = getWeaponDef(member.equipment.mainHand);
      const isTwoHand = mainDef?.grip === 'twoHand';

      const offHandLabel = document.createElement('label');
      offHandLabel.style.cssText = `font-size:0.75rem; color:${isTwoHand ? '#555' : '#aaa'}; display:flex; flex-direction:column; gap:2px;`;
      offHandLabel.textContent = isTwoHand ? 'Off Hand (2-Handed Weapon Equipped):' : 'Off Hand:';
      const offHandSelect = document.createElement('select');
      offHandSelect.disabled = isTwoHand;
      offHandSelect.style.cssText = `
        background: ${isTwoHand ? '#111' : '#1a1a24'};
        color: ${isTwoHand ? '#555' : '#eee'};
        border: 1px solid ${isTwoHand ? '#222' : '#444'};
        border-radius: 4px; padding: 4px 6px; font-family: 'Cinzel', serif; font-size: 0.8rem;
      `;
      const offNoneOpt = document.createElement('option');
      offNoneOpt.value = '';
      offNoneOpt.textContent = '— None —';
      offHandSelect.appendChild(offNoneOpt);

      for (const w of equippableWeapons) {
        if (w.def.grip === 'twoHand') continue; // cannot equip 2H in offHand
        const opt = document.createElement('option');
        opt.value = w.id;
        opt.textContent = `${w.def.name} (${w.def.kind})`;
        if (member.equipment.offHand === w.id) opt.selected = true;
        offHandSelect.appendChild(opt);
      }
      offHandSelect.addEventListener('change', () => {
        equipToSubslot(member.equipment, 'offHand', offHandSelect.value || null);
        renderMemberCards();
      });
      offHandLabel.appendChild(offHandSelect);
      eqSection.appendChild(offHandLabel);

      card.appendChild(eqSection);
      cardsContainer.appendChild(card);
    });
  }

  renderMemberCards();

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
