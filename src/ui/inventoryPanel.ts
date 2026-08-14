/**
 * Inventory screen — the STICK-RPG inventory, opened with the `I` key.
 *
 * Layout, top to bottom:
 *   1. **Status bar** — the active member's identity, level, XP progress, health,
 *      derived attack/defense, coins, and the three equipment slots. Always
 *      visible; it is the "top bar" the screen is built around.
 *   2. Member tabs, when more than one member is recruited.
 *   3. The carried-item grid.
 *
 * Unlike `partyPanel.ts` / `skillPanel.ts`, which edit a deep clone and commit
 * on Confirm, this screen mutates the live `PlayerInventory` / `PartyState`
 * records directly: equipping is a *move* between the item pool and a slot, and
 * a toggle-open-toggle-closed screen with no Confirm button should not silently
 * discard what the player just did. `onClose` is where the caller re-equips the
 * live weapon and saves.
 */

import {
  EQUIPMENT_SUBSLOTS,
  canEquipInSubslot,
  computeEquipmentModifiers,
  getRecruitedCount,
  isTwoHandedWeapon,
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
import {
  getWeaponDef,
  isWeaponRuntimeImplemented,
  resolveWeaponGrip,
  type WeaponDef,
} from '../sim/weapons/weaponDefs';

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
const SLOT_LABELS: Record<EquipmentSubslot, string> = {
  mainHand: 'Main Hand',
  offHand: 'Off Hand',
  armor: 'Armor',
};

/**
 * Which mouse button fires each hand. Shown on the slot itself, because the
 * hands are the control scheme: left button swings the main hand, right button
 * the off hand, and a two-handed weapon claims both.
 */
const SLOT_BUTTON_HINTS: Record<EquipmentSubslot, string> = {
  mainHand: 'LMB',
  offHand: 'RMB',
  armor: '',
};

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

  /**
   * What is currently under the cursor mid-drag.
   *
   * Held here rather than read from `DataTransfer`, because `dragover` — where
   * a slot decides whether it will accept the drop — is forbidden from reading
   * transfer data. The payload is still written to `DataTransfer` as well so the
   * browser treats the gesture as a real drag.
   */
  type DragPayload =
    | { from: 'inventory'; itemId: string }
    | { from: 'slot'; itemId: string; subslot: EquipmentSubslot };
  let dragPayload: DragPayload | null = null;
  /** Text filter over the carried-item grid. */
  let itemFilter = '';

  const el = document.createElement('div');
  el.id = 'inventory-panel-screen';
  el.style.cssText = `
    position: absolute; top: 0; left: 0; width: 100%; height: 100%;
    background: ${PANEL_BG};
    color: #eee; font-family: 'Cinzel', serif;
    display: flex; flex-direction: column; align-items: center;
    overflow-y: auto; box-sizing: border-box; padding: 0 0 72px;
    z-index: 1500;
  `;
  root.appendChild(el);

  // ── Status bar (sticky) ───────────────────────────────────────────────────
  const statusBar = document.createElement('div');
  statusBar.id = 'inventory-status-bar';
  statusBar.style.cssText = `
    position: sticky; top: 0; width: 100%;
    background: linear-gradient(180deg, rgba(18,14,10,0.98), rgba(12,10,8,0.98));
    border-bottom: 2px solid ${GOLD_DIM};
    padding: 12px 20px; box-sizing: border-box; z-index: 2;
    display: flex; flex-wrap: wrap; gap: 20px; align-items: center; justify-content: center;
  `;
  el.appendChild(statusBar);

  const memberTabs = document.createElement('div');
  memberTabs.style.cssText = 'display:flex; gap:8px; justify-content:center; margin:16px 0 4px;';
  el.appendChild(memberTabs);

  const itemsSection = document.createElement('div');
  itemsSection.style.cssText = `
    width: 100%; max-width: 900px; padding: 8px 16px 0; box-sizing: border-box;
  `;
  el.appendChild(itemsSection);

  function selectedMember(): PartyMember {
    return party.members[selectedMemberIndex] ?? party.members[0];
  }

  function notifyEquipmentChanged(): void {
    if (callbacks.onEquipmentChanged) callbacks.onEquipmentChanged();
  }

  // ── Status bar contents ───────────────────────────────────────────────────
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
    identity.style.cssText = 'display:flex; flex-direction:column; gap:4px; min-width:200px;';
    identity.innerHTML = `
      <div style="display:flex; align-items:baseline; gap:8px;">
        <span style="color:${GOLD}; font-size:1.15rem;">${escapeHtml(member.name)}</span>
        <span style="color:#aaa; font-size:0.8rem;">Level ${stats.level}</span>
      </div>
      <div style="height:8px; width:200px; background:#1a1a24; border:1px solid #444; border-radius:4px; overflow:hidden;">
        <div style="height:100%; width:${(xpRatio * 100).toFixed(1)}%; background:${GOLD_DIM};"></div>
      </div>
      <div style="color:#888; font-size:0.7rem;">XP ${Math.round(stats.xp)} / ${Math.round(stats.xpToNextLevel)}</div>
    `;
    statusBar.appendChild(identity);

    // Derived stats + coins
    const statsBlock = document.createElement('div');
    statsBlock.style.cssText = 'display:flex; gap:18px; align-items:center;';
    statsBlock.appendChild(statChip('Health', healthText, '#ff6b6b'));
    statsBlock.appendChild(statChip('Attack', derived.attack.toFixed(2), '#ffa94d'));
    statsBlock.appendChild(statChip('Defense', derived.defense.toFixed(2), '#74c0fc'));
    statsBlock.appendChild(statChip('Coins', String(inventory.gold), GOLD));
    if (stats.skillPoints > 0) {
      statsBlock.appendChild(statChip('Skill Points', String(stats.skillPoints), '#b197fc'));
    }
    statusBar.appendChild(statsBlock);

    // Equipment slots
    const slots = document.createElement('div');
    slots.style.cssText = 'display:flex; gap:10px; align-items:stretch;';
    for (const subslot of EQUIPMENT_SUBSLOTS) {
      slots.appendChild(equipmentSlotChip(member, subslot));
    }
    statusBar.appendChild(slots);
  }

  function statChip(label: string, value: string, color: string): HTMLElement {
    const chip = document.createElement('div');
    chip.style.cssText = 'display:flex; flex-direction:column; align-items:center; gap:2px;';
    chip.innerHTML = `
      <span style="color:#888; font-size:0.65rem; letter-spacing:0.08em; text-transform:uppercase;">${escapeHtml(label)}</span>
      <span style="color:${color}; font-size:1rem;">${escapeHtml(value)}</span>
    `;
    return chip;
  }

  /**
   * Resolves a drop onto `subslot`, returning true when anything moved.
   *
   * A slot-to-slot drag unequips the source first: a two-hander in the main
   * hand blocks the off hand while it is still worn, so asking
   * `equipFromInventory` before releasing it would always be refused. If the
   * equip then fails anyway, the source is put back, leaving the drag a no-op
   * rather than dumping the item on the floor.
   */
  function applyDropOnSlot(
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

  /** True when a drop of `payload` onto `subslot` would be accepted. */
  function canDropOnSlot(
    member: PartyMember,
    subslot: EquipmentSubslot,
    payload: DragPayload,
  ): boolean {
    if (payload.from === 'slot' && payload.subslot === subslot) return false;
    if (payload.from === 'slot' && payload.subslot === 'mainHand' && subslot === 'offHand') {
      // The main hand is about to be emptied by the move, so judge the off hand
      // against the equipment it will actually see.
      const preview = { ...member.equipment, mainHand: null };
      return canEquipInSubslot(preview, subslot, payload.itemId);
    }
    return canEquipInSubslot(member.equipment, subslot, payload.itemId);
  }

  function equipmentSlotChip(member: PartyMember, subslot: EquipmentSubslot): HTMLElement {
    const itemId = member.equipment[subslot];
    const isBlockedByTwoHander = subslot === 'offHand'
      && isTwoHandedWeapon(getWeaponDef(member.equipment.mainHand));

    const chip = document.createElement('div');
    chip.style.cssText = `
      min-width: 120px; padding: 6px 10px; box-sizing: border-box;
      background: ${itemId === null ? 'rgba(25,25,35,0.85)' : 'rgba(212,168,75,0.12)'};
      border: 1px solid ${itemId === null ? 'rgba(212,168,75,0.3)' : GOLD};
      border-radius: 6px; display: flex; flex-direction: column; gap: 2px;
      cursor: ${itemId === null ? 'default' : 'pointer'};
    `;

    const name = itemId !== null
      ? getItemDisplayName(itemId)
      : (isBlockedByTwoHander ? 'Both hands in use' : 'Empty');
    // A two-hander in the main hand answers to both buttons, so say so there
    // rather than leaving the off hand looking merely broken.
    const hint = subslot === 'mainHand' && isTwoHandedWeapon(getWeaponDef(itemId))
      ? 'LMB + RMB'
      : (isBlockedByTwoHander ? '' : SLOT_BUTTON_HINTS[subslot]);
    chip.innerHTML = `
      <span style="color:#888; font-size:0.65rem; letter-spacing:0.08em; text-transform:uppercase;">
        ${SLOT_LABELS[subslot]}${hint === '' ? '' : ` · <span style="color:${GOLD_DIM};">${hint}</span>`}
      </span>
      <span style="color:${itemId === null ? '#666' : '#eee'}; font-size:0.85rem;">${escapeHtml(name)}</span>
    `;

    if (itemId !== null) {
      chip.title = 'Click to unequip · drag to another slot or back to the grid';
      chip.addEventListener('click', () => {
        unequipToInventory(inventory, member.equipment, subslot);
        notifyEquipmentChanged();
        render();
      });
      chip.draggable = true;
      chip.addEventListener('dragstart', e => {
        dragPayload = { from: 'slot', itemId, subslot };
        e.dataTransfer?.setData('text/plain', itemId);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        chip.style.opacity = '0.5';
      });
      chip.addEventListener('dragend', () => {
        dragPayload = null;
        chip.style.opacity = '1';
      });
    }

    // Drop target — the whole point of the screen's drag gesture.
    chip.addEventListener('dragover', e => {
      if (dragPayload === null || !canDropOnSlot(member, subslot, dragPayload)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      chip.style.background = 'rgba(255,215,0,0.28)';
      chip.style.borderColor = GOLD;
    });
    chip.addEventListener('dragleave', () => {
      chip.style.background = itemId === null ? 'rgba(25,25,35,0.85)' : 'rgba(212,168,75,0.12)';
      chip.style.borderColor = itemId === null ? 'rgba(212,168,75,0.3)' : GOLD;
    });
    chip.addEventListener('drop', e => {
      e.preventDefault();
      const payload = dragPayload;
      dragPayload = null;
      if (payload === null) return;
      if (!applyDropOnSlot(member, subslot, payload)) {
        render();
        return;
      }
      notifyEquipmentChanged();
      render();
    });

    return chip;
  }

  // ── Member tabs ───────────────────────────────────────────────────────────
  function renderMemberTabs(): void {
    memberTabs.innerHTML = '';
    if (getRecruitedCount(party) <= 1) return;

    party.members.forEach((member, index) => {
      if (!member.isRecruited) return;
      const isSelected = selectedMemberIndex === index;
      const isLeader = party.activeIndex === index;
      const tab = document.createElement('button');
      tab.textContent = isLeader ? `${member.name} ★` : member.name;
      tab.title = isLeader ? 'Active member' : 'Click to view; double-click to make active';
      tab.style.cssText = `
        font-family: 'Cinzel', serif; font-size: 0.85rem; padding: 6px 16px;
        background: ${isSelected ? 'rgba(212,168,75,0.18)' : 'transparent'};
        color: ${isSelected ? GOLD : '#999'};
        border: 1px solid ${isSelected ? GOLD : '#555'};
        border-radius: 4px; cursor: pointer;
      `;
      tab.addEventListener('click', () => {
        selectedMemberIndex = index;
        render();
      });
      tab.addEventListener('dblclick', () => {
        if (setActiveMember(party, index)) {
          selectedMemberIndex = index;
          // Switching who the player controls changes the equipped weapon.
          notifyEquipmentChanged();
        }
        render();
      });
      memberTabs.appendChild(tab);
    });
  }

  // ── Item grid ─────────────────────────────────────────────────────────────
  function renderItems(): void {
    const member = selectedMember();
    itemsSection.innerHTML = '';

    const heading = document.createElement('div');
    heading.style.cssText = `
      display:flex; justify-content:space-between; align-items:baseline; gap:12px;
      border-bottom:1px solid rgba(212,168,75,0.3); padding-bottom:6px; margin-bottom:12px;
    `;
    heading.innerHTML = `
      <span style="color:${GOLD}; font-size:1.1rem;">Carried Items</span>
      <span style="color:#888; font-size:0.75rem;">${inventory.stacks.length} stack(s)</span>
    `;
    itemsSection.appendChild(heading);

    // With every weapon unlocked the grid runs to dozens of cards, so a filter
    // is the difference between "pick a weapon" and "scroll for a while".
    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Filter items…';
    search.value = itemFilter;
    search.style.cssText = `
      width: 100%; box-sizing: border-box; margin-bottom: 12px; padding: 6px 10px;
      font-family: 'Cinzel', serif; font-size: 0.8rem;
      background: rgba(25,25,35,0.85); color: #eee;
      border: 1px solid rgba(212,168,75,0.3); border-radius: 4px;
    `;
    search.addEventListener('input', () => {
      itemFilter = search.value;
      renderItems();
      // Re-rendering replaces the input, so focus and caret must be restored.
      const next = itemsSection.querySelector('input');
      if (next instanceof HTMLInputElement) {
        next.focus();
        next.setSelectionRange(next.value.length, next.value.length);
      }
    });
    // The panel's global handler closes on `i`; typing one here must not.
    search.addEventListener('keydown', e => {
      if (e.key !== 'Escape') e.stopPropagation();
    });
    itemsSection.appendChild(search);

    if (inventory.stacks.length === 0) {
      const empty = document.createElement('p');
      empty.style.cssText = 'color:#777; font-size:0.85rem; text-align:center; margin:24px 0;';
      empty.textContent = 'Nothing carried. Everything you own is equipped.';
      itemsSection.appendChild(empty);
      return;
    }

    const grid = document.createElement('div');
    grid.style.cssText = `
      display:grid; grid-template-columns:repeat(auto-fill, minmax(220px, 1fr)); gap:12px;
      min-height: 80px;
    `;
    itemsSection.appendChild(grid);

    // Dropping a worn item back on the grid unequips it — the inverse gesture.
    grid.addEventListener('dragover', e => {
      if (dragPayload === null || dragPayload.from !== 'slot') return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      grid.style.outline = `1px dashed ${GOLD_DIM}`;
    });
    grid.addEventListener('dragleave', () => { grid.style.outline = 'none'; });
    grid.addEventListener('drop', e => {
      e.preventDefault();
      const payload = dragPayload;
      dragPayload = null;
      grid.style.outline = 'none';
      if (payload === null || payload.from !== 'slot') return;
      if (unequipToInventory(inventory, member.equipment, payload.subslot) === null) return;
      notifyEquipmentChanged();
      render();
    });

    const needle = itemFilter.trim().toLowerCase();
    let shown = 0;
    inventory.stacks.forEach((stack, stackIndex) => {
      if (needle !== '' && !getItemDisplayName(stack.id).toLowerCase().includes(needle)
        && !stack.id.toLowerCase().includes(needle)) {
        return;
      }
      grid.appendChild(itemCard(member, stack.id, stack.count, stackIndex));
      shown++;
    });

    if (shown === 0) {
      const none = document.createElement('p');
      none.style.cssText = 'color:#777; font-size:0.85rem; text-align:center; margin:24px 0;';
      none.textContent = `No carried item matches “${itemFilter.trim()}”.`;
      itemsSection.appendChild(none);
    }
  }

  function itemCard(
    member: PartyMember,
    itemId: string,
    count: number,
    stackIndex: number,
  ): HTMLElement {
    const def = getWeaponDef(itemId);
    const card = document.createElement('div');
    card.dataset.itemId = itemId;
    card.dataset.stackIndex = String(stackIndex);
    card.style.cssText = `
      background: rgba(25,25,35,0.85); border: 1px solid rgba(212,168,75,0.3);
      border-radius: 6px; padding: 10px; box-sizing: border-box;
      display: flex; flex-direction: column; gap: 6px; cursor: grab;
    `;

    // Drag source. The equip buttons below stay as the keyboard/click path;
    // dragging is the shortcut, not the only way in.
    card.draggable = true;
    card.addEventListener('dragstart', e => {
      dragPayload = { from: 'inventory', itemId };
      e.dataTransfer?.setData('text/plain', itemId);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      card.style.opacity = '0.5';
    });
    card.addEventListener('dragend', () => {
      dragPayload = null;
      card.style.opacity = '1';
    });

    const title = document.createElement('div');
    title.style.cssText = 'display:flex; justify-content:space-between; align-items:baseline; gap:8px;';
    title.innerHTML = `
      <span style="color:#eee; font-size:0.9rem;">${escapeHtml(getItemDisplayName(itemId))}</span>
      <span style="color:${GOLD_DIM}; font-size:0.8rem;">×${count}</span>
    `;
    card.appendChild(title);

    const meta = document.createElement('div');
    meta.style.cssText = 'color:#8a8a95; font-size:0.7rem;';
    meta.textContent = def === null ? 'Unknown item' : describeWeapon(def);
    card.appendChild(meta);

    if (def !== null && !isWeaponRuntimeImplemented(def)) {
      const note = document.createElement('div');
      note.style.cssText = 'color:#c98a3a; font-size:0.65rem;';
      note.textContent = 'No combat behavior in this build.';
      card.appendChild(note);
    }

    const buttons = document.createElement('div');
    buttons.style.cssText = 'display:flex; gap:6px; margin-top:2px;';
    for (const subslot of EQUIPMENT_SUBSLOTS) {
      // Armor has no item table yet, so nothing in the pool can legally go
      // there; the button would always be dead. Hide it rather than tease it.
      if (subslot === 'armor') continue;
      buttons.appendChild(equipButton(member, subslot, itemId));
    }
    card.appendChild(buttons);

    return card;
  }

  function equipButton(
    member: PartyMember,
    subslot: EquipmentSubslot,
    itemId: string,
  ): HTMLElement {
    const allowed = canEquipInSubslot(member.equipment, subslot, itemId);
    const button = document.createElement('button');
    button.textContent = SLOT_LABELS[subslot];
    button.disabled = !allowed;
    button.style.cssText = `
      flex: 1; font-family: 'Cinzel', serif; font-size: 0.75rem; padding: 5px 8px;
      background: ${allowed ? 'rgba(212,168,75,0.14)' : 'transparent'};
      color: ${allowed ? GOLD : '#555'};
      border: 1px solid ${allowed ? GOLD_DIM : '#333'};
      border-radius: 4px; cursor: ${allowed ? 'pointer' : 'not-allowed'};
    `;
    if (!allowed) {
      button.title = subslot !== 'offHand'
        ? 'This item cannot go in that slot.'
        : (isTwoHandedWeapon(getWeaponDef(itemId))
          ? 'Two-handed: it goes in the main hand and uses both mouse buttons.'
          : 'Blocked: the two-handed weapon in the main hand needs both hands.');
    }
    button.addEventListener('click', () => {
      if (!equipFromInventory(inventory, member.equipment, subslot, itemId)) return;
      notifyEquipmentChanged();
      render();
    });
    return button;
  }

  function render(): void {
    renderStatusBar();
    renderMemberTabs();
    renderItems();
  }

  render();

  // ── Footer ────────────────────────────────────────────────────────────────
  const actionBar = document.createElement('div');
  actionBar.style.cssText = `
    position: fixed; bottom: 0; left: 0; right: 0;
    display: flex; gap: 16px; justify-content: center; align-items: center;
    background: rgba(5,4,3,0.95); border-top: 1px solid ${GOLD_DIM};
    padding: 12px 16px; box-sizing: border-box; z-index: 1510;
  `;
  el.appendChild(actionBar);

  const hint = document.createElement('span');
  hint.style.cssText = 'color:#777; font-size:0.75rem;';
  hint.textContent = 'Drag an item onto a slot to equip · drag it back to unequip · I or Esc to close';
  actionBar.appendChild(hint);

  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  closeBtn.style.cssText = `
    font-family: 'Cinzel', serif; font-size: 0.9rem; padding: 8px 28px;
    background: ${GOLD}; color: #111; font-weight: bold; border: 1px solid ${GOLD};
    border-radius: 4px; cursor: pointer;
  `;
  closeBtn.addEventListener('click', () => closeAndNotify());
  actionBar.appendChild(closeBtn);

  // The panel owns its own close keys. The game loop is frozen while it is
  // open, so its input handler is not running and cannot do this for us.
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
    if (el.parentNode) el.parentNode.removeChild(el);
  }

  function closeAndNotify(): void {
    if (isClosed) return;
    cleanup();
    callbacks.onClose();
  }

  return cleanup;
}

/** One-line summary of a weapon for the item card. */
function describeWeapon(def: WeaponDef): string {
  const parts: string[] = [def.kind];
  // Resolved, not read raw: most donor weapons declare no grip, and the card
  // must agree with the slot rules about which hands the weapon needs.
  const grip = resolveWeaponGrip(def);
  parts.push(grip === 'twoHand' ? 'two-handed' : grip === 'dual' ? 'dual' : 'one-handed');
  if (typeof def.dmg === 'number') parts.push(`${def.dmg} dmg`);
  if (def.element !== undefined && def.element !== 'physical') parts.push(def.element);
  return parts.join(' · ');
}

/** Escapes text interpolated into the innerHTML templates above. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
