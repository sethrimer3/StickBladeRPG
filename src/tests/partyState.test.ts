import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  EQUIPMENT_SUBSLOTS,
  MAX_PARTY_SIZE,
  applyMainHandConstraints,
  canEquipInSubslot,
  computeEquipmentModifiers,
  createDefaultParty,
  createEmptyEquipment,
  createPartyMember,
  cycleActiveMember,
  equipToSubslot,
  findDamageRedirectMemberIndex,
  getActiveMember,
  getMemberById,
  getRecruitedCount,
  getRecruitedMembers,
  isTwoHandedWeapon,
  recruitMember,
  sanitizePartyState,
  setActiveMember,
} from '../sim/party/partyState';
import {
  DEFAULT_FOLLOW_CONFIG,
  computeFollowIntent,
  isFollowerWithParty,
  type FollowActor,
} from '../sim/party/partyFollowAi';
import { WEAPONS, getWeaponDef } from '../sim/weapons/weaponDefs';
import { createDefaultCharacterStats } from '../sim/stats/characterStats';

function actor(x: number, y: number, grounded: 0 | 1 = 1): FollowActor {
  return { positionXWorld: x, positionYWorld: y, isGroundedFlag: grounded };
}

describe('party defaults', () => {
  test('the starting party has one recruited leader and empty roster slots', () => {
    const party = createDefaultParty();
    assert.equal(party.members.length, MAX_PARTY_SIZE);
    assert.equal(getRecruitedCount(party), 1);
    assert.equal(party.members[0].isRecruited, true);
    assert.equal(party.activeIndex, 0);
  });

  test('member ids are unique', () => {
    const party = createDefaultParty();
    const ids = party.members.map(m => m.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('each call returns an independent party', () => {
    const a = createDefaultParty();
    const b = createDefaultParty();
    a.members[0].stats.level = 9;
    assert.equal(b.members[0].stats.level, 1);
  });

  test('a new member starts at level 1 with empty equipment', () => {
    const member = createPartyMember('x', 'X');
    assert.deepEqual(member.stats, createDefaultCharacterStats());
    assert.deepEqual(member.equipment, createEmptyEquipment());
  });
});

describe('active member', () => {
  test('the active member is the leader by default', () => {
    const party = createDefaultParty();
    assert.equal(getActiveMember(party)?.id, 'leader');
  });

  test('control cannot switch to an unrecruited slot', () => {
    const party = createDefaultParty();
    assert.equal(setActiveMember(party, 1), false);
    assert.equal(party.activeIndex, 0);
  });

  test('control switches to a recruited member', () => {
    const party = createDefaultParty();
    recruitMember(party, 1);
    assert.equal(setActiveMember(party, 1), true);
    assert.equal(getActiveMember(party)?.id, party.members[1].id);
  });

  test('cycling skips unrecruited members', () => {
    const party = createDefaultParty();
    recruitMember(party, 2);
    assert.equal(cycleActiveMember(party), 2);
    assert.equal(cycleActiveMember(party), 0);
  });

  test('cycling a solo party stays put rather than spinning', () => {
    const party = createDefaultParty();
    assert.equal(cycleActiveMember(party), 0);
  });

  test('a stale active index falls back to a recruited member', () => {
    const party = createDefaultParty();
    party.activeIndex = 2; // never recruited
    assert.equal(getActiveMember(party)?.id, 'leader');
  });

  test('members are findable by id', () => {
    const party = createDefaultParty();
    assert.equal(getMemberById(party, 'leader')?.name, 'Leader');
    assert.equal(getMemberById(party, 'nobody'), null);
  });
});

describe('recruitment', () => {
  test('recruiting fills a roster slot', () => {
    const party = createDefaultParty();
    assert.equal(recruitMember(party, 1), true);
    assert.equal(getRecruitedCount(party), 2);
    assert.equal(getRecruitedMembers(party).length, 2);
  });

  test('recruiting twice is a no-op', () => {
    const party = createDefaultParty();
    recruitMember(party, 1);
    assert.equal(recruitMember(party, 1), false);
  });

  test('recruiting a nonexistent slot is refused', () => {
    const party = createDefaultParty();
    assert.equal(recruitMember(party, 99), false);
  });

  test('the party never exceeds its maximum', () => {
    const party = createDefaultParty();
    for (let i = 0; i < 10; i++) recruitMember(party, i);
    assert.equal(getRecruitedCount(party), MAX_PARTY_SIZE);
  });
});

describe('equipment rules', () => {
  test('a weapon equips into the main hand', () => {
    const equipment = createEmptyEquipment();
    assert.equal(equipToSubslot(equipment, 'mainHand', 'sword'), true);
    assert.equal(equipment.mainHand, 'sword');
  });

  test('an unknown id is refused from the hands', () => {
    const equipment = createEmptyEquipment();
    assert.equal(equipToSubslot(equipment, 'mainHand', 'notAWeapon'), false);
    assert.equal(equipment.mainHand, null);
  });

  test('a two-handed weapon clears the off hand', () => {
    const equipment = createEmptyEquipment();
    equipToSubslot(equipment, 'offHand', 'sword');
    assert.equal(equipment.offHand, 'sword');

    assert.equal(isTwoHandedWeapon(getWeaponDef('greatsword')), true);
    equipToSubslot(equipment, 'mainHand', 'greatsword');
    assert.equal(equipment.offHand, null, 'a two-hander occupies both hands');
  });

  test('nothing may enter the off hand while a two-hander is held', () => {
    const equipment = createEmptyEquipment();
    equipToSubslot(equipment, 'mainHand', 'greatsword');
    assert.equal(canEquipInSubslot(equipment, 'offHand', 'sword'), false);
    assert.equal(equipToSubslot(equipment, 'offHand', 'sword'), false);
  });

  test('a two-handed weapon is refused by the off hand even with the main hand empty', () => {
    // The hands drive the mouse buttons: the off hand answers to the right
    // button alone, which a weapon needing both cannot be fired from.
    const equipment = createEmptyEquipment();
    assert.equal(canEquipInSubslot(equipment, 'offHand', 'greatsword'), false);
    assert.equal(equipToSubslot(equipment, 'offHand', 'greatsword'), false);
    assert.equal(equipment.offHand, null);
  });

  test('bows are two-handed despite declaring no grip explicitly', () => {
    const equipment = createEmptyEquipment();
    assert.equal(isTwoHandedWeapon(getWeaponDef('bow')), true);
    assert.equal(canEquipInSubslot(equipment, 'offHand', 'bow'), false);
  });

  test('a one-handed weapon leaves the off hand usable', () => {
    const equipment = createEmptyEquipment();
    equipToSubslot(equipment, 'mainHand', 'sword');
    assert.equal(equipToSubslot(equipment, 'offHand', 'dagger'), true);
  });

  test('clearing a slot is always allowed', () => {
    const equipment = createEmptyEquipment();
    equipToSubslot(equipment, 'mainHand', 'greatsword');
    assert.equal(equipToSubslot(equipment, 'mainHand', null), true);
    assert.equal(equipment.mainHand, null);
  });

  test('constraints can be re-applied idempotently', () => {
    const equipment = createEmptyEquipment();
    equipment.mainHand = 'greatsword';
    equipment.offHand = 'sword';
    applyMainHandConstraints(equipment);
    assert.equal(equipment.offHand, null);
    applyMainHandConstraints(equipment);
    assert.equal(equipment.offHand, null);
  });

  test('all four subslots exist', () => {
    assert.deepEqual([...EQUIPMENT_SUBSLOTS], ['mainHand', 'offHand', 'armor', 'shoes']);
  });
});

describe('equipment modifiers', () => {
  test('empty equipment is neutral', () => {
    const modifiers = computeEquipmentModifiers(createEmptyEquipment());
    assert.equal(modifiers.defenseMultiplier, 1);
    assert.equal(modifiers.healthMultiplier, 1);
  });

  test('the wall shield contributes its donor multipliers', () => {
    const equipment = createEmptyEquipment();
    equipToSubslot(equipment, 'mainHand', 'templarianWallShield');
    const modifiers = computeEquipmentModifiers(equipment);
    assert.equal(modifiers.defenseMultiplier, WEAPONS['templarianWallShield'].defenseMultiplier);
    assert.equal(modifiers.healthMultiplier, WEAPONS['templarianWallShield'].healthMultiplier);
  });

  test('a plain weapon contributes nothing', () => {
    const equipment = createEmptyEquipment();
    equipToSubslot(equipment, 'mainHand', 'sword');
    assert.equal(computeEquipmentModifiers(equipment).defenseMultiplier, 1);
  });

  test('damage redirect is found on the member carrying it', () => {
    const party = createDefaultParty();
    recruitMember(party, 1);
    assert.equal(findDamageRedirectMemberIndex(party), -1);

    equipToSubslot(party.members[1].equipment, 'mainHand', 'templarianWallShield');
    assert.equal(findDamageRedirectMemberIndex(party), 1);
  });

  test('gear on an unrecruited member does not redirect damage', () => {
    const party = createDefaultParty();
    equipToSubslot(party.members[2].equipment, 'mainHand', 'templarianWallShield');
    assert.equal(findDamageRedirectMemberIndex(party), -1);
  });
});

describe('sanitizePartyState', () => {
  test('non-object input yields the default party', () => {
    assert.deepEqual(sanitizePartyState(null), createDefaultParty());
    assert.deepEqual(sanitizePartyState('nope'), createDefaultParty());
  });

  test('the member count is normalized', () => {
    const repaired = sanitizePartyState({ members: [], activeIndex: 0 });
    assert.equal(repaired.members.length, MAX_PARTY_SIZE);
  });

  test('extra members are dropped', () => {
    const members = Array.from({ length: 10 }, (_, i) => createPartyMember(`m${i}`, `M${i}`));
    assert.equal(sanitizePartyState({ members, activeIndex: 0 }).members.length, MAX_PARTY_SIZE);
  });

  test('the first slot is always recruited, so control always exists', () => {
    const repaired = sanitizePartyState({
      members: [{ ...createPartyMember('a', 'A'), isRecruited: false }],
      activeIndex: 0,
    });
    assert.equal(repaired.members[0].isRecruited, true);
    assert.notEqual(getActiveMember(repaired), null);
  });

  test('an out-of-range active index falls back to the leader', () => {
    assert.equal(sanitizePartyState({ members: [], activeIndex: 99 }).activeIndex, 0);
  });

  test('an active index pointing at an unrecruited member falls back', () => {
    const party = createDefaultParty();
    assert.equal(sanitizePartyState({ ...party, activeIndex: 2 }).activeIndex, 0);
  });

  test('duplicate ids are disambiguated', () => {
    const repaired = sanitizePartyState({
      members: [createPartyMember('same', 'A'), createPartyMember('same', 'B'), createPartyMember('same', 'C')],
      activeIndex: 0,
    });
    const ids = repaired.members.map(m => m.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('equipment naming a removed weapon is dropped rather than resurrected broken', () => {
    const party = createDefaultParty();
    party.members[0].equipment.mainHand = 'weaponThatNoLongerExists';
    assert.equal(sanitizePartyState(party).members[0].equipment.mainHand, null);
  });

  test('valid equipment survives', () => {
    const party = createDefaultParty();
    party.members[0].equipment.mainHand = 'sword';
    assert.equal(sanitizePartyState(party).members[0].equipment.mainHand, 'sword');
  });

  test('an illegal two-hander plus off-hand combination is repaired on load', () => {
    const party = createDefaultParty();
    party.members[0].equipment.mainHand = 'greatsword';
    party.members[0].equipment.offHand = 'sword';
    assert.equal(sanitizePartyState(party).members[0].equipment.offHand, null);
  });

  test('corrupt stats are repaired', () => {
    const party = createDefaultParty();
    (party.members[0] as { stats: unknown }).stats = { level: 'seven' };
    assert.equal(sanitizePartyState(party).members[0].stats.level, 1);
  });

  test('the input is never mutated', () => {
    const party = createDefaultParty();
    const before = JSON.stringify(party);
    sanitizePartyState(party);
    assert.equal(JSON.stringify(party), before);
  });

  test('is idempotent', () => {
    const once = sanitizePartyState({ members: [], activeIndex: 3 });
    assert.deepEqual(sanitizePartyState(once), once);
  });
});

describe('follow AI', () => {
  test('a follower walks toward a distant leader', () => {
    const intent = computeFollowIntent(actor(0, 0), actor(200, 0), 1);
    assert.equal(intent.moveDx, 1);
    assert.equal(intent.shouldTeleport, false);
  });

  test('a follower walks left toward a leader on its left', () => {
    assert.equal(computeFollowIntent(actor(200, 0), actor(0, 0), 1).moveDx, -1);
  });

  test('a follower at its trailing position holds still', () => {
    // Leader at 100, follower on the left, so its slot is 100 - spacing.
    const slotX = 100 - DEFAULT_FOLLOW_CONFIG.spacingWorld;
    assert.equal(computeFollowIntent(actor(slotX, 0), actor(100, 0), 1).moveDx, 0);
  });

  test('followers fan out by follow order rather than stacking', () => {
    const leader = actor(100, 0);
    const first = computeFollowIntent(actor(0, 0), leader, 1).moveDx;
    assert.equal(first, 1);
    // The second follower's slot is farther back, so from the same spot it
    // still walks right, but it will stop sooner.
    const secondSlotX = 100 - DEFAULT_FOLLOW_CONFIG.spacingWorld * 2;
    assert.equal(computeFollowIntent(actor(secondSlotX, 0), leader, 2).moveDx, 0);
    assert.equal(computeFollowIntent(actor(secondSlotX, 0), leader, 1).moveDx, 1);
  });

  test('a follower jumps for a leader above it', () => {
    const intent = computeFollowIntent(actor(0, 0), actor(20, -100), 1);
    assert.equal(intent.wantsJump, true);
  });

  test('a follower does not jump while airborne', () => {
    const intent = computeFollowIntent(actor(0, 0, 0), actor(20, -100), 1);
    assert.equal(intent.wantsJump, false);
  });

  test('a follower does not jump for a trivial height difference', () => {
    assert.equal(computeFollowIntent(actor(0, 0), actor(20, -2), 1).wantsJump, false);
  });

  test('a follower does not jump for a leader below it', () => {
    assert.equal(computeFollowIntent(actor(0, 0), actor(20, 200), 1).wantsJump, false);
  });

  test('a hopelessly separated follower asks to teleport instead of pathing', () => {
    const intent = computeFollowIntent(actor(0, 0), actor(99999, 0), 1);
    assert.equal(intent.shouldTeleport, true);
    assert.equal(intent.moveDx, 0, 'a teleporting follower should not also walk');
  });

  test('party proximity matches the teleport threshold', () => {
    assert.equal(isFollowerWithParty(actor(0, 0), actor(50, 0)), true);
    assert.equal(isFollowerWithParty(actor(0, 0), actor(99999, 0)), false);
  });

  test('the follower trails on the side it is already on, avoiding crossings', () => {
    const leader = actor(100, 0);
    // Approaching from the right, the slot should be to the RIGHT of the leader.
    const fromRight = computeFollowIntent(actor(300, 0), leader, 1);
    assert.equal(fromRight.moveDx, -1);
    // From the left, the slot is to the LEFT — the follower never crosses over.
    const fromLeft = computeFollowIntent(actor(-100, 0), leader, 1);
    assert.equal(fromLeft.moveDx, 1);
  });
});
