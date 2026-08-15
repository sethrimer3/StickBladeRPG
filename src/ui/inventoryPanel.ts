/**
 * Inventory screen — the STICK-RPG inventory, opened with the `I` key.
 *
 * Layout:
 *   1. **Status Bar** — active party member's identity, level, XP progress, health,
 *      attack/defense, coins, and quick stats.
 *   2. **Member Tabs** — when multiple party members are recruited.
 *   3. **Main Content (Two Columns)**:
 *      - **Left: Equipment & Character Paperdoll** — Live physical canvas preview
 *        of the stickman player standing in place, surrounded by actual equipment
 *        slots:
 *          - Armor Slot (1 square, chest icon watermark)
 *          - Hand Slot (1 square divided into Left/Main Hand and Right/Off Hand, or
 *            whole square for 2-handed weapons)
 *          - Shoes Slot (1 square, boot icon watermark)
 *      - **Right: Carried Items Grid** — Grid of actual square slots.
 *        - Two-handed items take up a whole square.
 *        - One-handed items take up half a square (width is half the height, centered).
 *        - Armor and shoes take up square slots.
 *        - Full drag-and-drop and click-to-unequip support.
 *   4. **Footer** — Instructions and Close button.
 */

import {
  canEquipInSubslot,
  computeEquipmentModifiers,
  getRecruitedCount,
  setActiveMember,
  type EquipmentSubslot,
  type PartyMember,
  type PartyState,
} from '../sim/party/partyState';
import {
  equipFromInventory,
  getItemDisplayName,
  unequipToInventory,
  type PlayerInventory,
} from '../sim/party/inventory';
import { computeDerivedStats } from '../sim/stats/characterStats';
import { getWeaponDef } from '../sim/weapons/weaponDefs';
import {
  getItemDef,
  getItemCategory,
  isTwoHandedItem,
  isOneHandedItem,
  isArmorItem,
  isShoeItem,
} from '../sim/items/itemCatalog';
import { CharacterPreviewController } from './characterPreviewRenderer';
import { getItemIconSvg, getSlotWatermarkSvg } from './inventoryIcons';

export interface InventoryPanelCallbacks {
  /** Called once when the screen closes, after all edits have been applied. */
  onClose: () => void;
  /** Called after every equip/unequip so the live weapon can follow the slot. */
  onEquipmentChanged?: () => void;
}

export interface InventoryPanelInputs {
  inventory: PlayerInventory;
  party: PartyState;
  /** Current player health, when known, for the status bar's health readout. */
  healthPoints?: number;
  maxHealthPoints?: number;
}

const GOLD = '#ffd700';
const GOLD_DIM = '#d4a84b';
const PANEL_BG = 'rgba(10,8,6,0.96)';
const SLOT_BG = 'rgba(22, 18, 14, 0.9)';
const SLOT_BORDER = 'rgba(212, 168, 75, 0.35)';

type CategoryFilter = 'all' | 'weapon' | 'armor' | 'shoes';

/**
 * Opens the inventory screen. Returns a cleanup function that removes it
 * WITHOUT firing `onClose`, for teardown paths (room exit, screen destroy).
 */
export function showInventoryPanel(
  root: HTMLElement,
  inputs: InventoryPanelInputs,
  callbacks: InventoryPanelCallbacks,
): () => void {
  const { inventory, party } = inputs;
  let selectedMemberIndex = party.activeIndex;
  let activeCategory: CategoryFilter = 'all';
  let itemFilter = '';

  /** Drag payload tracking. */
  type DragPayload =
    | { from: 'inventory'; itemId: string }
    | { from: 'slot'; itemId: string; subslot: EquipmentSubslot };
  let dragPayload: DragPayload | null = null;

  // Root UI container
  const el = document.createElement('div');
  el.id = 'inventory-panel-screen';
  el.style.cssText = `
    position: absolute; top: 0; left: 0; width: 100%; height: 100%;
    background: ${PANEL_BG};
    color: #eee; font-family: 'Cinzel', serif;
    display: flex; flex-direction: column; align-items: center;
    overflow-y: auto; box-sizing: border-box; padding: 0 0 76px;
    z-index: 1500;
  `;
  root.appendChild(el);

  // ── 1. Status Bar ─────────────────────────────────────────────────────────
  const statusBar = document.createElement('div');
  statusBar.id = 'inventory-status-bar';
  statusBar.style.cssText = `
    position: sticky; top: 0; width: 100%;
    background: linear-gradient(180deg, rgba(20,16,12,0.98), rgba(14,11,9,0.98));
    border-bottom: 2px solid ${GOLD_DIM};
    padding: 10px 24px; box-sizing: border-box; z-index: 10;
    display: flex; flex-wrap: wrap; gap: 20px; align-items: center; justify-content: center;
    box-shadow: 0 4px 20px rgba(0,0,0,0.6);
  `;
  el.appendChild(statusBar);

  // ── 2. Member Tabs ────────────────────────────────────────────────────────
  const memberTabs = document.createElement('div');
  memberTabs.style.cssText = 'display:flex; gap:8px; justify-content:center; margin:12px 0 4px;';
  el.appendChild(memberTabs);

  // ── 3. Main Workspace (Two-Column) ────────────────────────────────────────
  const workspace = document.createElement('div');
  workspace.style.cssText = `
    display: flex; flex-wrap: wrap; gap: 24px; justify-content: center;
    width: 100%; max-width: 1060px; padding: 12px 20px; box-sizing: border-box;
    align-items: flex-start;
  `;
  el.appendChild(workspace);

  // Left Column: Paperdoll & Equipment Slots
  const paperdollColumn = document.createElement('div');
  paperdollColumn.style.cssText = `
    display: flex; flex-direction: column; align-items: center; gap: 14px;
    background: rgba(18, 14, 10, 0.7);
    border: 1px solid rgba(212, 168, 75, 0.25);
    border-radius: 8px; padding: 16px 20px; box-sizing: border-box;
    min-width: 320px;
  `;
  workspace.appendChild(paperdollColumn);

  // Right Column: Carried Items
  const itemsColumn = document.createElement('div');
  itemsColumn.style.cssText = `
    flex: 1; min-width: 440px; max-width: 640px;
    display: flex; flex-direction: column; gap: 12px;
    background: rgba(18, 14, 10, 0.7);
    border: 1px solid rgba(212, 168, 75, 0.25);
    border-radius: 8px; padding: 16px 20px; box-sizing: border-box;
  `;
  workspace.appendChild(itemsColumn);

  // Floating tooltip container
  const tooltipEl = document.createElement('div');
  tooltipEl.style.cssText = `
    position: fixed; display: none; z-index: 2000; pointer-events: none;
    background: rgba(14, 10, 8, 0.96); border: 1px solid ${GOLD};
    border-radius: 6px; padding: 10px 14px; max-width: 260px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.8); color: #eee; font-family: 'Cinzel', serif;
  `;
  document.body.appendChild(tooltipEl);

  function selectedMember(): PartyMember {
    return party.members[selectedMemberIndex] ?? party.members[0];
  }

  function notifyEquipmentChanged(): void {
    if (callbacks.onEquipmentChanged) callbacks.onEquipmentChanged();
  }

  // Character preview controller instance
  let previewController: CharacterPreviewController | null = null;

  // ── Render Status Bar ─────────────────────────────────────────────────────
  function renderStatusBar(): void {
    const member = selectedMember();
    const stats = member.stats;
    const derived = computeDerivedStats(stats, computeEquipmentModifiers(member.equipment));
    const xpRatio = stats.xpToNextLevel > 0
      ? Math.max(0, Math.min(1, stats.xp / stats.xpToNextLevel))
      : 0;
    const health = inputs.healthPoints;
    const maxHealth = inputs.maxHealthPoints;
    const healthText = typeof health === 'number' && typeof maxHealth === 'number'
      ? `${Math.round(health)} / ${Math.round(maxHealth)}`
      : `${Math.round(derived.maxHealth)}`;

    statusBar.innerHTML = '';

    // Identity + XP
    const identity = document.createElement('div');
    identity.style.cssText = 'display:flex; flex-direction:column; gap:3px; min-width:190px;';
    identity.innerHTML = `
      <div style="display:flex; align-items:baseline; gap:8px;">
        <span style="color:${GOLD}; font-size:1.15rem; font-weight:bold;">${escapeHtml(member.name)}</span>
        <span style="color:#aaa; font-size:0.8rem;">Level ${stats.level}</span>
      </div>
      <div style="height:7px; width:190px; background:#1a1a24; border:1px solid #444; border-radius:3px; overflow:hidden;">
        <div style="height:100%; width:${(xpRatio * 100).toFixed(1)}%; background:linear-gradient(90deg, #d4a84b, #ffd700);"></div>
      </div>
      <div style="color:#888; font-size:0.68rem;">XP ${Math.round(stats.xp)} / ${Math.round(stats.xpToNextLevel)}</div>
    `;
    statusBar.appendChild(identity);

    // Derived stats + Coins
    const statsBlock = document.createElement('div');
    statsBlock.style.cssText = 'display:flex; gap:16px; align-items:center;';
    statsBlock.appendChild(statChip('Health', healthText, '#ff6b6b'));
    statsBlock.appendChild(statChip('Attack', derived.attack.toFixed(2), '#ffa94d'));
    statsBlock.appendChild(statChip('Defense', derived.defense.toFixed(2), '#74c0fc'));
    statsBlock.appendChild(statChip('Coins', String(inventory.gold), GOLD));
    if (stats.skillPoints > 0) {
      statsBlock.appendChild(statChip('Skill Points', String(stats.skillPoints), '#b197fc'));
    }
    statusBar.appendChild(statsBlock);
  }

  function statChip(label: string, value: string, color: string): HTMLElement {
    const chip = document.createElement('div');
    chip.style.cssText = 'display:flex; flex-direction:column; align-items:center; gap:2px;';
    chip.innerHTML = `
      <span style="color:#888; font-size:0.65rem; letter-spacing:0.08em; text-transform:uppercase;">${escapeHtml(label)}</span>
      <span style="color:${color}; font-size:0.95rem; font-weight:bold;">${escapeHtml(value)}</span>
    `;
    return chip;
  }

  // ── Render Member Tabs ────────────────────────────────────────────────────
  function renderMemberTabs(): void {
    memberTabs.innerHTML = '';
    if (getRecruitedCount(party) <= 1) return;

    party.members.forEach((member, index) => {
      if (!member.isRecruited) return;
      const isSelected = selectedMemberIndex === index;
      const isLeader = party.activeIndex === index;
      const tab = document.createElement('button');
      tab.textContent = isLeader ? `${member.name} ★` : member.name;
      tab.title = isLeader ? 'Active party leader' : 'Click to inspect; double-click to switch active leader';
      tab.style.cssText = `
        font-family: 'Cinzel', serif; font-size: 0.82rem; padding: 5px 14px;
        background: ${isSelected ? 'rgba(212,168,75,0.2)' : 'rgba(20,20,25,0.6)'};
        color: ${isSelected ? GOLD : '#999'};
        border: 1px solid ${isSelected ? GOLD : '#444'};
        border-radius: 4px; cursor: pointer; transition: all 0.15s;
      `;
      tab.addEventListener('click', () => {
        selectedMemberIndex = index;
        render();
      });
      tab.addEventListener('dblclick', () => {
        if (setActiveMember(party, index)) {
          selectedMemberIndex = index;
          notifyEquipmentChanged();
        }
        render();
      });
      memberTabs.appendChild(tab);
    });
  }

  // ── Render Paperdoll & Equipment Slots ────────────────────────────────────
  function renderPaperdoll(): void {
    const member = selectedMember();
    paperdollColumn.innerHTML = '';

    const title = document.createElement('div');
    title.style.cssText = `
      color:${GOLD}; font-size:1.05rem; font-weight:bold; width:100%; text-align:center;
      border-bottom:1px solid rgba(212,168,75,0.25); padding-bottom:6px; margin-bottom:2px;
      letter-spacing: 0.05em;
    `;
    title.textContent = `${member.name}'s Equipment`;
    paperdollColumn.appendChild(title);

    // Paperdoll Stage (Preview Canvas + Slots on sides/bottom)
    const stage = document.createElement('div');
    stage.style.cssText = `
      display: flex; flex-direction: column; align-items: center; gap: 14px;
      position: relative; width: 100%;
    `;
    paperdollColumn.appendChild(stage);

    // Center Preview Canvas Frame
    const previewFrame = document.createElement('div');
    previewFrame.style.cssText = `
      position: relative; width: 180px; height: 220px;
      border: 1.5px solid rgba(212, 168, 75, 0.4);
      border-radius: 6px; overflow: hidden;
      box-shadow: 0 4px 16px rgba(0,0,0,0.6), inset 0 0 20px rgba(0,0,0,0.8);
    `;
    stage.appendChild(previewFrame);

    if (previewController) {
      previewController.destroy();
      previewController = null;
    }
    previewController = new CharacterPreviewController(previewFrame, member.equipment, {
      width: 180,
      height: 220,
      scale: 5.5,
    });

    // Slots Container
    const slotsGrid = document.createElement('div');
    slotsGrid.style.cssText = `
      display: flex; flex-direction: column; gap: 12px; width: 100%; align-items: center;
    `;
    stage.appendChild(slotsGrid);

    // Row 1: Armor Slot
    const armorRow = document.createElement('div');
    armorRow.style.cssText = 'display:flex; flex-direction:column; align-items:center; gap:4px;';
    armorRow.appendChild(createArmorSlot(member));
    slotsGrid.appendChild(armorRow);

    // Row 2: Hand Slot (Single Square divided into Left/Main and Right/Off or full square 2H)
    const handRow = document.createElement('div');
    handRow.style.cssText = 'display:flex; flex-direction:column; align-items:center; gap:4px;';
    handRow.appendChild(createHandSlot(member));
    slotsGrid.appendChild(handRow);

    // Row 3: Shoes Slot
    const shoesRow = document.createElement('div');
    shoesRow.style.cssText = 'display:flex; flex-direction:column; align-items:center; gap:4px;';
    shoesRow.appendChild(createShoesSlot(member));
    slotsGrid.appendChild(shoesRow);
  }

  // ── Armor Slot ────────────────────────────────────────────────────────────
  function createArmorSlot(member: PartyMember): HTMLElement {
    const slot = document.createElement('div');
    const itemId = member.equipment.armor;
    const isEquipped = itemId !== null;

    slot.style.cssText = `
      width: 76px; height: 76px; box-sizing: border-box;
      background: ${isEquipped ? 'rgba(35, 28, 18, 0.9)' : SLOT_BG};
      border: 1.5px ${isEquipped ? 'solid' : 'dashed'} ${isEquipped ? GOLD : SLOT_BORDER};
      border-radius: 6px; display: flex; flex-direction: column; align-items: center; justify-content: center;
      position: relative; cursor: ${isEquipped ? 'pointer' : 'default'}; transition: all 0.15s;
    `;

    const label = document.createElement('span');
    label.style.cssText = 'font-size: 0.62rem; color: #888; position: absolute; top: 3px; letter-spacing: 0.05em;';
    label.textContent = 'ARMOR';
    slot.appendChild(label);

    if (isEquipped) {
      slot.innerHTML += getItemIconSvg(itemId, 38, 38);
      const name = document.createElement('span');
      name.style.cssText = `
        font-size: 0.65rem; color: #eee; margin-top: 2px; text-align: center;
        max-width: 70px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      `;
      name.textContent = getItemDisplayName(itemId);
      slot.appendChild(name);

      attachTooltip(slot, itemId);

      slot.addEventListener('click', () => {
        unequipToInventory(inventory, member.equipment, 'armor');
        notifyEquipmentChanged();
        render();
      });

      slot.draggable = true;
      slot.addEventListener('dragstart', e => {
        dragPayload = { from: 'slot', itemId, subslot: 'armor' };
        e.dataTransfer?.setData('text/plain', itemId);
        slot.style.opacity = '0.5';
      });
      slot.addEventListener('dragend', () => {
        dragPayload = null;
        slot.style.opacity = '1';
      });
    } else {
      const watermark = document.createElement('div');
      watermark.innerHTML = getSlotWatermarkSvg('armor', 32);
      watermark.style.cssText = 'opacity: 0.4; margin-top: 6px;';
      slot.appendChild(watermark);
    }

    // Drop target
    slot.addEventListener('dragover', e => {
      if (!dragPayload || !canDropOnSubslot(member, 'armor', dragPayload)) return;
      e.preventDefault();
      slot.style.borderColor = GOLD;
      slot.style.background = 'rgba(255, 215, 0, 0.2)';
    });
    slot.addEventListener('dragleave', () => {
      slot.style.borderColor = isEquipped ? GOLD : SLOT_BORDER;
      slot.style.background = isEquipped ? 'rgba(35, 28, 18, 0.9)' : SLOT_BG;
    });
    slot.addEventListener('drop', e => {
      e.preventDefault();
      const payload = dragPayload;
      dragPayload = null;
      if (!payload) return;
      applyDrop(member, 'armor', payload);
      notifyEquipmentChanged();
      render();
    });

    return slot;
  }

  // ── Hand Slot (Single Square with Left / Right sides, or 2H full square) ──
  function createHandSlot(member: PartyMember): HTMLElement {
    const handSlot = document.createElement('div');
    const mainId = member.equipment.mainHand;
    const offId = member.equipment.offHand;
    const is2H = mainId !== null && isTwoHandedItem(mainId);

    handSlot.style.cssText = `
      width: 80px; height: 80px; box-sizing: border-box;
      background: ${SLOT_BG};
      border: 1.5px solid ${(mainId || offId) ? GOLD : SLOT_BORDER};
      border-radius: 6px; display: flex; position: relative; overflow: hidden;
      box-shadow: inset 0 0 10px rgba(0,0,0,0.5);
    `;

    const label = document.createElement('span');
    label.style.cssText = `
      font-size: 0.58rem; color: #888; position: absolute; top: 2px; width: 100%;
      text-align: center; letter-spacing: 0.05em; z-index: 3; pointer-events: none;
    `;
    label.textContent = is2H ? 'HANDS (2H)' : 'HANDS (L / R)';
    handSlot.appendChild(label);

    if (is2H) {
      // ── Two-Handed: Takes up the whole square ─────────────────────────────
      const twoHandCard = document.createElement('div');
      twoHandCard.style.cssText = `
        width: 100%; height: 100%; display: flex; flex-direction: column;
        align-items: center; justify-content: center; padding-top: 10px; box-sizing: border-box;
        background: rgba(45, 35, 20, 0.85); cursor: pointer;
      `;
      twoHandCard.innerHTML = getItemIconSvg(mainId, 42, 42);
      const nameSpan = document.createElement('span');
      nameSpan.style.cssText = `
        font-size: 0.62rem; color: #eee; margin-top: 2px; text-align: center;
        max-width: 74px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      `;
      nameSpan.textContent = getItemDisplayName(mainId);
      twoHandCard.appendChild(nameSpan);

      attachTooltip(twoHandCard, mainId);

      twoHandCard.addEventListener('click', () => {
        unequipToInventory(inventory, member.equipment, 'mainHand');
        notifyEquipmentChanged();
        render();
      });

      twoHandCard.draggable = true;
      twoHandCard.addEventListener('dragstart', e => {
        dragPayload = { from: 'slot', itemId: mainId, subslot: 'mainHand' };
        e.dataTransfer?.setData('text/plain', mainId);
        twoHandCard.style.opacity = '0.5';
      });
      twoHandCard.addEventListener('dragend', () => {
        dragPayload = null;
        twoHandCard.style.opacity = '1';
      });

      handSlot.appendChild(twoHandCard);
    } else {
      // ── One-Handed: Left Half (Main Hand) & Right Half (Off Hand) ─────────
      // Left side: Main Hand (LMB)
      const leftHalf = document.createElement('div');
      leftHalf.style.cssText = `
        width: 50%; height: 100%; display: flex; flex-direction: column;
        align-items: center; justify-content: center; padding-top: 10px; box-sizing: border-box;
        border-right: 1px dashed rgba(212, 168, 75, 0.35); position: relative;
        background: ${mainId ? 'rgba(35, 28, 18, 0.8)' : 'transparent'};
        cursor: ${mainId ? 'pointer' : 'default'};
      `;

      if (mainId) {
        leftHalf.innerHTML = getItemIconSvg(mainId, 28, 28);
        const lmbTag = document.createElement('span');
        lmbTag.style.cssText = `font-size: 0.55rem; color: ${GOLD_DIM}; font-weight: bold; margin-top: 1px;`;
        lmbTag.textContent = 'LMB';
        leftHalf.appendChild(lmbTag);

        attachTooltip(leftHalf, mainId);

        leftHalf.addEventListener('click', () => {
          unequipToInventory(inventory, member.equipment, 'mainHand');
          notifyEquipmentChanged();
          render();
        });

        leftHalf.draggable = true;
        leftHalf.addEventListener('dragstart', e => {
          dragPayload = { from: 'slot', itemId: mainId, subslot: 'mainHand' };
          e.dataTransfer?.setData('text/plain', mainId);
          leftHalf.style.opacity = '0.5';
        });
        leftHalf.addEventListener('dragend', () => {
          dragPayload = null;
          leftHalf.style.opacity = '1';
        });
      } else {
        const watermark = document.createElement('div');
        watermark.innerHTML = getSlotWatermarkSvg('handLeft', 24);
        watermark.style.cssText = 'opacity: 0.35; margin-top: 4px;';
        leftHalf.appendChild(watermark);
        const sub = document.createElement('span');
        sub.style.cssText = 'font-size: 0.5rem; color: #666; margin-top: 2px;';
        sub.textContent = 'LMB';
        leftHalf.appendChild(sub);
      }

      // Right side: Off Hand (RMB)
      const rightHalf = document.createElement('div');
      rightHalf.style.cssText = `
        width: 50%; height: 100%; display: flex; flex-direction: column;
        align-items: center; justify-content: center; padding-top: 10px; box-sizing: border-box;
        position: relative;
        background: ${offId ? 'rgba(35, 28, 18, 0.8)' : 'transparent'};
        cursor: ${offId ? 'pointer' : 'default'};
      `;

      if (offId) {
        rightHalf.innerHTML = getItemIconSvg(offId, 28, 28);
        const rmbTag = document.createElement('span');
        rmbTag.style.cssText = `font-size: 0.55rem; color: ${GOLD_DIM}; font-weight: bold; margin-top: 1px;`;
        rmbTag.textContent = 'RMB';
        rightHalf.appendChild(rmbTag);

        attachTooltip(rightHalf, offId);

        rightHalf.addEventListener('click', () => {
          unequipToInventory(inventory, member.equipment, 'offHand');
          notifyEquipmentChanged();
          render();
        });

        rightHalf.draggable = true;
        rightHalf.addEventListener('dragstart', e => {
          dragPayload = { from: 'slot', itemId: offId, subslot: 'offHand' };
          e.dataTransfer?.setData('text/plain', offId);
          rightHalf.style.opacity = '0.5';
        });
        rightHalf.addEventListener('dragend', () => {
          dragPayload = null;
          rightHalf.style.opacity = '1';
        });
      } else {
        const watermark = document.createElement('div');
        watermark.innerHTML = getSlotWatermarkSvg('handRight', 24);
        watermark.style.cssText = 'opacity: 0.35; margin-top: 4px;';
        rightHalf.appendChild(watermark);
        const sub = document.createElement('span');
        sub.style.cssText = 'font-size: 0.5rem; color: #666; margin-top: 2px;';
        sub.textContent = 'RMB';
        rightHalf.appendChild(sub);
      }

      handSlot.appendChild(leftHalf);
      handSlot.appendChild(rightHalf);

      // Subslot drop handling
      setupSubslotDrop(leftHalf, member, 'mainHand');
      setupSubslotDrop(rightHalf, member, 'offHand');
    }

    // Whole handSlot dragover for 2H drops
    handSlot.addEventListener('dragover', e => {
      if (!dragPayload) return;
      if (isTwoHandedItem(dragPayload.itemId)) {
        if (!canDropOnSubslot(member, 'mainHand', dragPayload)) return;
        e.preventDefault();
        handSlot.style.borderColor = GOLD;
        handSlot.style.background = 'rgba(255, 215, 0, 0.2)';
      }
    });
    handSlot.addEventListener('dragleave', () => {
      handSlot.style.borderColor = (mainId || offId) ? GOLD : SLOT_BORDER;
      handSlot.style.background = SLOT_BG;
    });
    handSlot.addEventListener('drop', e => {
      if (!dragPayload || !isTwoHandedItem(dragPayload.itemId)) return;
      e.preventDefault();
      const payload = dragPayload;
      dragPayload = null;
      applyDrop(member, 'mainHand', payload);
      notifyEquipmentChanged();
      render();
    });

    return handSlot;
  }

  function setupSubslotDrop(targetEl: HTMLElement, member: PartyMember, subslot: EquipmentSubslot): void {
    targetEl.addEventListener('dragover', e => {
      if (!dragPayload || isTwoHandedItem(dragPayload.itemId)) return;
      if (!canDropOnSubslot(member, subslot, dragPayload)) return;
      e.preventDefault();
      e.stopPropagation();
      targetEl.style.background = 'rgba(255, 215, 0, 0.25)';
    });
    targetEl.addEventListener('dragleave', () => {
      const isEquipped = member.equipment[subslot] !== null;
      targetEl.style.background = isEquipped ? 'rgba(35, 28, 18, 0.8)' : 'transparent';
    });
    targetEl.addEventListener('drop', e => {
      if (!dragPayload || isTwoHandedItem(dragPayload.itemId)) return;
      e.preventDefault();
      e.stopPropagation();
      const payload = dragPayload;
      dragPayload = null;
      applyDrop(member, subslot, payload);
      notifyEquipmentChanged();
      render();
    });
  }

  // ── Shoes Slot ────────────────────────────────────────────────────────────
  function createShoesSlot(member: PartyMember): HTMLElement {
    const slot = document.createElement('div');
    const itemId = member.equipment.shoes;
    const isEquipped = itemId !== null;

    slot.style.cssText = `
      width: 76px; height: 76px; box-sizing: border-box;
      background: ${isEquipped ? 'rgba(35, 28, 18, 0.9)' : SLOT_BG};
      border: 1.5px ${isEquipped ? 'solid' : 'dashed'} ${isEquipped ? GOLD : SLOT_BORDER};
      border-radius: 6px; display: flex; flex-direction: column; align-items: center; justify-content: center;
      position: relative; cursor: ${isEquipped ? 'pointer' : 'default'}; transition: all 0.15s;
    `;

    const label = document.createElement('span');
    label.style.cssText = 'font-size: 0.62rem; color: #888; position: absolute; top: 3px; letter-spacing: 0.05em;';
    label.textContent = 'SHOES';
    slot.appendChild(label);

    if (isEquipped) {
      slot.innerHTML += getItemIconSvg(itemId, 38, 38);
      const name = document.createElement('span');
      name.style.cssText = `
        font-size: 0.65rem; color: #eee; margin-top: 2px; text-align: center;
        max-width: 70px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      `;
      name.textContent = getItemDisplayName(itemId);
      slot.appendChild(name);

      attachTooltip(slot, itemId);

      slot.addEventListener('click', () => {
        unequipToInventory(inventory, member.equipment, 'shoes');
        notifyEquipmentChanged();
        render();
      });

      slot.draggable = true;
      slot.addEventListener('dragstart', e => {
        dragPayload = { from: 'slot', itemId, subslot: 'shoes' };
        e.dataTransfer?.setData('text/plain', itemId);
        slot.style.opacity = '0.5';
      });
      slot.addEventListener('dragend', () => {
        dragPayload = null;
        slot.style.opacity = '1';
      });
    } else {
      const watermark = document.createElement('div');
      watermark.innerHTML = getSlotWatermarkSvg('shoes', 32);
      watermark.style.cssText = 'opacity: 0.4; margin-top: 6px;';
      slot.appendChild(watermark);
    }

    // Drop target
    slot.addEventListener('dragover', e => {
      if (!dragPayload || !canDropOnSubslot(member, 'shoes', dragPayload)) return;
      e.preventDefault();
      slot.style.borderColor = GOLD;
      slot.style.background = 'rgba(255, 215, 0, 0.2)';
    });
    slot.addEventListener('dragleave', () => {
      slot.style.borderColor = isEquipped ? GOLD : SLOT_BORDER;
      slot.style.background = isEquipped ? 'rgba(35, 28, 18, 0.9)' : SLOT_BG;
    });
    slot.addEventListener('drop', e => {
      e.preventDefault();
      const payload = dragPayload;
      dragPayload = null;
      if (!payload) return;
      applyDrop(member, 'shoes', payload);
      notifyEquipmentChanged();
      render();
    });

    return slot;
  }

  // ── Drag & Drop Resolution ────────────────────────────────────────────────
  function canDropOnSubslot(
    member: PartyMember,
    subslot: EquipmentSubslot,
    payload: DragPayload,
  ): boolean {
    if (payload.from === 'slot' && payload.subslot === subslot) return false;
    if (payload.from === 'slot' && payload.subslot === 'mainHand' && subslot === 'offHand') {
      const preview = { ...member.equipment, mainHand: null };
      return canEquipInSubslot(preview, subslot, payload.itemId);
    }
    return canEquipInSubslot(member.equipment, subslot, payload.itemId);
  }

  function applyDrop(
    member: PartyMember,
    subslot: EquipmentSubslot,
    payload: DragPayload,
  ): boolean {
    if (payload.from === 'slot') {
      if (payload.subslot === subslot) return false;
      if (unequipToInventory(inventory, member.equipment, payload.subslot) === null) return false;
      if (!equipFromInventory(inventory, member.equipment, subslot, payload.itemId)) {
        equipFromInventory(inventory, member.equipment, payload.subslot, payload.itemId);
        return false;
      }
      return true;
    }
    return equipFromInventory(inventory, member.equipment, subslot, payload.itemId);
  }

  // ── Render Carried Items Grid ─────────────────────────────────────────────
  function renderItems(): void {
    const member = selectedMember();
    itemsColumn.innerHTML = '';

    // Header & Category Filter Tabs
    const headerRow = document.createElement('div');
    headerRow.style.cssText = `
      display: flex; justify-content: space-between; align-items: baseline; gap: 12px;
      border-bottom: 1px solid rgba(212,168,75,0.25); padding-bottom: 6px;
    `;
    headerRow.innerHTML = `
      <span style="color:${GOLD}; font-size:1.05rem; font-weight:bold; letter-spacing:0.05em;">Carried Items</span>
      <span style="color:#888; font-size:0.75rem;">${inventory.stacks.length} stack(s)</span>
    `;
    itemsColumn.appendChild(headerRow);

    // Search and Category Tabs Row
    const controlsRow = document.createElement('div');
    controlsRow.style.cssText = 'display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 4px 0 6px;';
    itemsColumn.appendChild(controlsRow);

    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Filter items…';
    search.value = itemFilter;
    search.style.cssText = `
      flex: 1; min-width: 140px; box-sizing: border-box; padding: 6px 10px;
      font-family: 'Cinzel', serif; font-size: 0.78rem;
      background: rgba(25,22,18,0.85); color: #eee;
      border: 1px solid rgba(212,168,75,0.3); border-radius: 4px;
    `;
    search.addEventListener('input', () => {
      itemFilter = search.value;
      renderItemsGrid();
      const next = itemsColumn.querySelector('input');
      if (next instanceof HTMLInputElement) {
        next.focus();
        next.setSelectionRange(next.value.length, next.value.length);
      }
    });
    search.addEventListener('keydown', e => {
      if (e.key !== 'Escape') e.stopPropagation();
    });
    controlsRow.appendChild(search);

    const categories: Array<{ id: CategoryFilter; label: string }> = [
      { id: 'all', label: 'All' },
      { id: 'weapon', label: 'Weapons' },
      { id: 'armor', label: 'Armor' },
      { id: 'shoes', label: 'Shoes' },
    ];

    categories.forEach(cat => {
      const btn = document.createElement('button');
      const isActive = activeCategory === cat.id;
      btn.textContent = cat.label;
      btn.style.cssText = `
        font-family: 'Cinzel', serif; font-size: 0.72rem; padding: 4px 10px;
        background: ${isActive ? 'rgba(212,168,75,0.25)' : 'rgba(25,22,18,0.6)'};
        color: ${isActive ? GOLD : '#888'};
        border: 1px solid ${isActive ? GOLD : '#444'};
        border-radius: 4px; cursor: pointer; transition: all 0.15s;
      `;
      btn.addEventListener('click', () => {
        activeCategory = cat.id;
        renderItems();
      });
      controlsRow.appendChild(btn);
    });

    // Grid Container
    const gridWrapper = document.createElement('div');
    gridWrapper.id = 'carried-items-grid-wrapper';
    gridWrapper.style.cssText = `
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(72px, 72px));
      gap: 10px;
      padding: 10px 4px;
      min-height: 240px;
      max-height: 380px;
      overflow-y: auto;
      box-sizing: border-box;
    `;
    itemsColumn.appendChild(gridWrapper);

    // Dropping a worn item onto the inventory grid unequips it
    gridWrapper.addEventListener('dragover', e => {
      if (!dragPayload || dragPayload.from !== 'slot') return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      gridWrapper.style.outline = `1px dashed ${GOLD_DIM}`;
    });
    gridWrapper.addEventListener('dragleave', () => { gridWrapper.style.outline = 'none'; });
    gridWrapper.addEventListener('drop', e => {
      e.preventDefault();
      const payload = dragPayload;
      dragPayload = null;
      gridWrapper.style.outline = 'none';
      if (!payload || payload.from !== 'slot') return;
      if (unequipToInventory(inventory, member.equipment, payload.subslot) === null) return;
      notifyEquipmentChanged();
      render();
    });

    renderItemsGrid();
  }

  function renderItemsGrid(): void {
    const member = selectedMember();
    const gridWrapper = itemsColumn.querySelector('#carried-items-grid-wrapper');
    if (!gridWrapper) return;
    gridWrapper.innerHTML = '';

    const needle = itemFilter.trim().toLowerCase();
    const matchingStacks = inventory.stacks.filter(stack => {
      const cat = getItemCategory(stack.id);
      if (activeCategory !== 'all' && cat !== activeCategory) return false;
      if (needle !== '') {
        const name = getItemDisplayName(stack.id).toLowerCase();
        if (!name.includes(needle) && !stack.id.toLowerCase().includes(needle)) return false;
      }
      return true;
    });

    if (matchingStacks.length === 0) {
      const emptyMsg = document.createElement('div');
      emptyMsg.style.cssText = 'grid-column: 1 / -1; color:#777; font-size:0.82rem; text-align:center; padding:32px 0;';
      emptyMsg.textContent = inventory.stacks.length === 0
        ? 'Carried inventory is empty. All owned gear is equipped.'
        : 'No carried items match the current filter.';
      gridWrapper.appendChild(emptyMsg);
      return;
    }

    matchingStacks.forEach(stack => {
      gridWrapper.appendChild(createInventorySlotCell(member, stack.id, stack.count));
    });

    // Pad out with empty square slots for a polished RPG grid look
    const emptyCount = Math.max(0, 24 - matchingStacks.length);
    for (let i = 0; i < emptyCount; i++) {
      const emptySlot = document.createElement('div');
      emptySlot.style.cssText = `
        width: 72px; height: 72px; box-sizing: border-box;
        background: rgba(16, 12, 10, 0.4);
        border: 1px dashed rgba(212, 168, 75, 0.15);
        border-radius: 6px;
      `;
      gridWrapper.appendChild(emptySlot);
    }
  }

  // ── Inventory Slot Cell ───────────────────────────────────────────────────
  function createInventorySlotCell(member: PartyMember, itemId: string, count: number): HTMLElement {
    const is2H = isTwoHandedItem(itemId);
    const is1H = !is2H && !isArmorItem(itemId) && !isShoeItem(itemId);

    // The outer slot box is a square
    const slotBox = document.createElement('div');
    slotBox.style.cssText = `
      width: 72px; height: 72px; box-sizing: border-box;
      background: ${SLOT_BG};
      border: 1.5px solid ${SLOT_BORDER};
      border-radius: 6px; display: flex; align-items: center; justify-content: center;
      position: relative; cursor: grab; transition: transform 0.1s, border-color 0.15s;
    `;

    // Item card inside the square slot:
    // - 2H: whole square
    // - 1H: half-square width (width = height / 2, e.g. 36px wide by 68px tall), centered
    // - Armor / Shoes: whole square
    const itemCard = document.createElement('div');
    itemCard.style.cssText = `
      width: ${is1H ? '36px' : '100%'};
      height: 100%;
      box-sizing: border-box;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      position: relative;
      background: ${is1H ? 'rgba(38, 30, 20, 0.85)' : 'transparent'};
      border: ${is1H ? '1px solid rgba(212, 168, 75, 0.3)' : 'none'};
      border-radius: ${is1H ? '4px' : '0'};
    `;
    slotBox.appendChild(itemCard);

    // Grip / category badge
    const badge = document.createElement('span');
    badge.style.cssText = `
      position: absolute; top: 2px; right: ${is1H ? '1px' : '3px'};
      font-size: 0.52rem; color: ${GOLD_DIM}; font-weight: bold; line-height: 1;
    `;
    if (is2H) badge.textContent = '2H';
    else if (is1H) badge.textContent = '1H';
    else if (isArmorItem(itemId)) badge.textContent = 'ARM';
    else if (isShoeItem(itemId)) badge.textContent = 'FT';
    itemCard.appendChild(badge);

    // Icon
    const iconWrapper = document.createElement('div');
    iconWrapper.innerHTML = getItemIconSvg(itemId, is1H ? 26 : 36, is1H ? 26 : 36);
    itemCard.appendChild(iconWrapper);

    // Count badge
    if (count > 1) {
      const countBadge = document.createElement('span');
      countBadge.style.cssText = `
        position: absolute; bottom: 2px; left: 3px;
        font-size: 0.58rem; color: #aaa; font-weight: bold;
      `;
      countBadge.textContent = `×${count}`;
      itemCard.appendChild(countBadge);
    }

    // Name abbreviation / label
    const nameLabel = document.createElement('span');
    nameLabel.style.cssText = `
      font-size: 0.55rem; color: #ccc; margin-top: 1px; text-align: center;
      max-width: ${is1H ? '34px' : '68px'}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    `;
    nameLabel.textContent = getItemDisplayName(itemId);
    itemCard.appendChild(nameLabel);

    // Tooltip
    attachTooltip(slotBox, itemId);

    // Drag-and-drop source
    slotBox.draggable = true;
    slotBox.addEventListener('dragstart', e => {
      dragPayload = { from: 'inventory', itemId };
      e.dataTransfer?.setData('text/plain', itemId);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      slotBox.style.opacity = '0.5';
    });
    slotBox.addEventListener('dragend', () => {
      dragPayload = null;
      slotBox.style.opacity = '1';
    });

    // Double-click to auto-equip shortcut
    slotBox.addEventListener('dblclick', () => {
      if (isArmorItem(itemId)) {
        equipFromInventory(inventory, member.equipment, 'armor', itemId);
      } else if (isShoeItem(itemId)) {
        equipFromInventory(inventory, member.equipment, 'shoes', itemId);
      } else if (isTwoHandedItem(itemId)) {
        equipFromInventory(inventory, member.equipment, 'mainHand', itemId);
      } else {
        // If mainHand is empty, equip there; otherwise try offHand
        if (member.equipment.mainHand === null) {
          equipFromInventory(inventory, member.equipment, 'mainHand', itemId);
        } else if (member.equipment.offHand === null && canEquipInSubslot(member.equipment, 'offHand', itemId)) {
          equipFromInventory(inventory, member.equipment, 'offHand', itemId);
        } else {
          equipFromInventory(inventory, member.equipment, 'mainHand', itemId);
        }
      }
      notifyEquipmentChanged();
      render();
    });

    return slotBox;
  }

  // ── Tooltip Helper ────────────────────────────────────────────────────────
  function attachTooltip(element: HTMLElement, itemId: string): void {
    element.addEventListener('mouseenter', e => {
      const item = getItemDef(itemId);
      if (!item) return;

      const name = getItemDisplayName(itemId);
      const is2H = isTwoHandedItem(itemId);
      const is1H = isOneHandedItem(itemId);

      let subline = '';
      if ('kind' in item) {
        if (item.kind === 'armor') subline = 'Armor';
        else if (item.kind === 'shoes') subline = 'Footwear / Shoes';
        else {
          const gripText = is2H ? 'Two-Handed' : (is1H ? 'One-Handed' : 'Dual-Wield');
          subline = `${gripText} ${item.kind.toUpperCase()}`;
        }
      }

      let statsHtml = '';
      const def = getWeaponDef(itemId);
      if (def && typeof def.dmg === 'number') {
        statsHtml += `<div style="color:#ffa94d; font-size:0.75rem;">Damage: ${def.dmg}</div>`;
      }
      if (def?.element && def.element !== 'physical') {
        statsHtml += `<div style="color:#74c0fc; font-size:0.75rem;">Element: ${def.element}</div>`;
      }
      if (typeof item.defenseMultiplier === 'number' && item.defenseMultiplier > 1) {
        const pct = Math.round((item.defenseMultiplier - 1) * 100);
        statsHtml += `<div style="color:#74c0fc; font-size:0.75rem;">Defense: +${pct}%</div>`;
      }
      if (typeof item.healthMultiplier === 'number' && item.healthMultiplier > 1) {
        const pct = Math.round((item.healthMultiplier - 1) * 100);
        statsHtml += `<div style="color:#ff6b6b; font-size:0.75rem;">Health: +${pct}%</div>`;
      }
      if (typeof item.speedMultiplier === 'number' && item.speedMultiplier > 1) {
        const pct = Math.round((item.speedMultiplier - 1) * 100);
        statsHtml += `<div style="color:#51cf66; font-size:0.75rem;">Speed: +${pct}%</div>`;
      }

      let descHtml = '';
      if (item.description) {
        descHtml = `<div style="color:#999; font-size:0.7rem; margin-top:4px; font-style:italic;">${escapeHtml(item.description)}</div>`;
      }

      tooltipEl.innerHTML = `
        <div style="font-weight:bold; color:${GOLD}; font-size:0.88rem; margin-bottom:2px;">${escapeHtml(name)}</div>
        <div style="color:#aaa; font-size:0.7rem; margin-bottom:6px; letter-spacing:0.05em;">${escapeHtml(subline)}</div>
        ${statsHtml}
        ${descHtml}
        <div style="color:#666; font-size:0.62rem; margin-top:6px; border-top:1px solid #333; padding-top:4px;">
          Drag onto slot to equip · Click/Double-click shortcut
        </div>
      `;

      tooltipEl.style.display = 'block';
      positionTooltip(e);
    });

    element.addEventListener('mousemove', positionTooltip);

    element.addEventListener('mouseleave', () => {
      tooltipEl.style.display = 'none';
    });
  }

  function positionTooltip(e: MouseEvent): void {
    const x = Math.min(window.innerWidth - 270, e.clientX + 14);
    const y = Math.min(window.innerHeight - 200, e.clientY + 14);
    tooltipEl.style.left = `${x}px`;
    tooltipEl.style.top = `${y}px`;
  }

  // ── Global Render Routine ─────────────────────────────────────────────────
  function render(): void {
    renderStatusBar();
    renderMemberTabs();
    renderPaperdoll();
    renderItems();
  }

  render();

  // ── Footer & Controls ─────────────────────────────────────────────────────
  const actionBar = document.createElement('div');
  actionBar.style.cssText = `
    position: fixed; bottom: 0; left: 0; right: 0;
    display: flex; gap: 16px; justify-content: space-between; align-items: center;
    background: rgba(8,6,4,0.97); border-top: 1px solid ${GOLD_DIM};
    padding: 10px 24px; box-sizing: border-box; z-index: 1510;
  `;
  el.appendChild(actionBar);

  const hint = document.createElement('span');
  hint.style.cssText = 'color:#888; font-size:0.75rem;';
  hint.textContent = 'Drag gear to equipment slots · Double-click to auto-equip · I or Esc to close';
  actionBar.appendChild(hint);

  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  closeBtn.style.cssText = `
    font-family: 'Cinzel', serif; font-size: 0.88rem; padding: 7px 26px;
    background: ${GOLD}; color: #111; font-weight: bold; border: 1px solid ${GOLD};
    border-radius: 4px; cursor: pointer; transition: all 0.15s;
  `;
  closeBtn.addEventListener('click', () => closeAndNotify());
  actionBar.appendChild(closeBtn);

  // Keyboard navigation & closing
  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape' || e.key === 'i' || e.key === 'I') {
      e.preventDefault();
      e.stopPropagation();
      closeAndNotify();
    }
  }
  window.addEventListener('keydown', onKeyDown, true);

  let isClosed = false;

  function cleanup(): void {
    if (isClosed) return;
    isClosed = true;
    window.removeEventListener('keydown', onKeyDown, true);
    if (previewController) {
      previewController.destroy();
      previewController = null;
    }
    if (tooltipEl.parentNode) {
      tooltipEl.parentNode.removeChild(tooltipEl);
    }
    if (el.parentNode) {
      el.parentNode.removeChild(el);
    }
  }

  function closeAndNotify(): void {
    if (isClosed) return;
    cleanup();
    callbacks.onClose();
  }

  return cleanup;
}

/** Escapes text interpolated into templates. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
