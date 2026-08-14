import { createStickRangerBody, stepStickRangerBody, SR_FRAME_MS, SR_HIP, SR_HEAD, SR_FOOT_L, SR_FOOT_R } from '../sim/clusters/stickRangerBody';
const floorY = 140;
const floor = { isSolid: (_x: number, y: number) => y >= floorY } as never;
const b = createStickRangerBody(100, floorY - 9.6);
for (let i = 0; i < 200; i++) stepStickRangerBody(b, floor, 0, SR_FRAME_MS);
const x0 = b.x[SR_HIP];
let minH = Infinity, maxGap = 0;
for (let i = 0; i < 240; i++) { stepStickRangerBody(b, floor, 1, SR_FRAME_MS); minH = Math.min(minH, (b.y[SR_FOOT_L]+b.y[SR_FOOT_R])/2 - b.y[SR_HEAD]); maxGap = Math.max(maxGap, Math.abs(b.x[SR_FOOT_R]-b.x[SR_FOOT_L])); }
const speed = (b.x[SR_HIP]-x0)/(240*SR_FRAME_MS/1000);
const stopX = b.x[SR_HIP];
let stopFrames = -1;
for (let i = 0; i < 120; i++) {
  stepStickRangerBody(b, floor, 0, SR_FRAME_MS);
  if (stopFrames < 0 && Math.abs(b.x[SR_HIP]-b.prevX[SR_HIP]) < 0.05) stopFrames = i;
}
console.log(`speed=${speed.toFixed(1)} stride=${maxGap.toFixed(1)} minH=${minH.toFixed(1)} skid=${(b.x[SR_HIP]-stopX).toFixed(1)}u in ${stopFrames}f  restGap=${(b.x[SR_FOOT_R]-b.x[SR_FOOT_L]).toFixed(1)} restH=${((b.y[SR_FOOT_L]+b.y[SR_FOOT_R])/2-b.y[SR_HEAD]).toFixed(1)}`);
