import {
  createStickRangerBody, stepStickRangerBody, requestStickRangerJump, SR_FRAME_MS,
  SR_HIP, SR_HEAD, SR_FOOT_L, SR_FOOT_R, SR_KNEE_L, SR_KNEE_R,
} from '../sim/clusters/stickRangerBody';

const floorY = 140;
const floor = { isSolid: (_x: number, y: number) => y >= floorY } as never;

function settled(dropFromY = floorY - 9.6) {
  const b = createStickRangerBody(100, dropFromY);
  for (let i = 0; i < 200; i++) stepStickRangerBody(b, floor, 0, SR_FRAME_MS);
  return b;
}

// Running jump to the right.
const b = settled();
for (let i = 0; i < 20; i++) stepStickRangerBody(b, floor, 1, SR_FRAME_MS);
requestStickRangerJump(b);
console.log('frame  headDx  chestDx  trailFootDx/Dy  leadFootDx/Dy  kneeDy  air  rag');
for (let i = 0; i < 26; i++) {
  stepStickRangerBody(b, floor, 1, SR_FRAME_MS);
  const hx = b.x[SR_HIP], hy = b.y[SR_HIP];
  // right-moving: trailing = left-most foot
  const lIsTrail = b.x[SR_FOOT_L] < b.x[SR_FOOT_R];
  const tf = lIsTrail ? SR_FOOT_L : SR_FOOT_R, lf = lIsTrail ? SR_FOOT_R : SR_FOOT_L;
  const tk = lIsTrail ? SR_KNEE_L : SR_KNEE_R, lk = lIsTrail ? SR_KNEE_R : SR_KNEE_L;
  const legLen = (k: number, f: number) => Math.hypot(b.x[f] - b.x[k], b.y[f] - b.y[k]) +
    Math.hypot(b.x[k] - hx, b.y[k] - hy);
  if (i % 2 === 0) {
    console.log(
      `${String(i).padStart(4)} ${(b.x[SR_HEAD] - hx).toFixed(1).padStart(7)} ${(b.x[1] - hx).toFixed(1).padStart(7)}` +
      ` ${(b.x[tf] - hx).toFixed(1).padStart(6)}/${(b.y[tf] - hy).toFixed(1).padStart(5)}` +
      ` ${(b.x[lf] - hx).toFixed(1).padStart(6)}/${(b.y[lf] - hy).toFixed(1).padStart(5)}` +
      ` trailSpan=${legLen(tk, tf).toFixed(1)} leadSpan=${legLen(lk, lf).toFixed(1)}` +
      ` head-foot=${((b.y[SR_FOOT_L] + b.y[SR_FOOT_R]) / 2 - b.y[SR_HEAD]).toFixed(1)}` +
      ` air=${b.framesSinceGroundContact} rag=${b.ragdollFrames}`,
    );
  }
}

// Impact speeds: ordinary jump vs long fall.
function impactOf(dropUnits: number): { speed: number; rag: number } {
  const c = settled();
  const hipStart = c.y[SR_HIP];
  for (let i = 0; i < 11; i++) c.y[i] -= dropUnits, c.prevY[i] -= dropUnits;
  void hipStart;
  let speed = 0;
  for (let i = 0; i < 300; i++) {
    const v = c.y[SR_HIP] - c.prevY[SR_HIP];
    stepStickRangerBody(c, floor, 0, SR_FRAME_MS);
    if (c.groundContactFlag === 1) { speed = v; break; }
  }
  return { speed, rag: c.ragdollFrames };
}
const j = settled();
for (let i = 0; i < 5; i++) stepStickRangerBody(j, floor, 0, SR_FRAME_MS);
requestStickRangerJump(j);
let jumpImpact = 0;
for (let i = 0; i < 200; i++) {
  const v = j.y[SR_HIP] - j.prevY[SR_HIP];
  stepStickRangerBody(j, floor, 0, SR_FRAME_MS);
  if (i > 5 && j.groundContactFlag === 1) { jumpImpact = v; break; }
}
console.log(`plain jump landing speed=${jumpImpact.toFixed(2)} rag=${j.ragdollFrames}`);
for (const d of [80, 100, 120, 140, 160, 240]) {
  const r = impactOf(d);
  console.log(`fall ${d}u impact=${r.speed.toFixed(2)} rag=${r.rag}`);
}
