import { SR_HAND_L, SR_HAND_R, SR_HIP, SR_SHOULDER_L, SR_SHOULDER_R,
  createStickRangerBody, stepStickRangerBody } from '../src/sim/clusters/stickRangerBody';
import type { SolidMask } from '../src/sim/pixelMaterials/pixelMaterialSolid';
import { createWorldState } from '../src/sim/world';
import { createClusterState } from '../src/sim/clusters/state';
import { equipPlayerWeapon, syncStickmanCarryHands } from '../src/sim/weapons/playerWeaponState';

const DT = 1000 / 60;
const floor = { isSolid: (_x: number, y: number): boolean => y >= 40 } as unknown as SolidMask;

function run(weapon: string | null, label: string) {
  const w = createWorldState(DT, 8);
  w.clusters.push(createClusterState(1, 0, 0, 1, 100));
  const b = createStickRangerBody(0, 20);
  w.stickRangerBody = b;
  if (weapon) equipPlayerWeapon(w.playerWeapon, weapon);
  b.facingDirection = 1;
  syncStickmanCarryHands(w);
  const grip = () => (b.x[SR_HAND_L] + b.x[SR_HAND_R]) * 0.5 - b.x[SR_HIP];
  const at: Record<number, number> = {};
  for (let i = 1; i <= 240; i++) {
    b.facingDirection = 1;
    stepStickRangerBody(b, floor, 0, DT, false);
    if ([20, 40, 60, 120, 240].includes(i)) at[i] = grip();
  }
  console.log(label.padEnd(16),
    `grip@20 ${at[20].toFixed(2).padStart(6)} @40 ${at[40].toFixed(2).padStart(6)} @60 ${at[60].toFixed(2).padStart(6)} @120 ${at[120].toFixed(2).padStart(6)} @240 ${at[240].toFixed(2).padStart(6)}`,
    `| L vs sh ${((b.x[SR_HAND_L]-b.x[SR_SHOULDER_L])).toFixed(2).padStart(6)}`,
    `R vs sh ${((b.x[SR_HAND_R]-b.x[SR_SHOULDER_R])).toFixed(2).padStart(6)}`,
    `finite ${b.x.every(v => Number.isFinite(v))}`);
}
run(null, 'unarmed');
run('woodenSword', 'woodenSword');
run('goldweaveBlade', 'goldweave1H');
