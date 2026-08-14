import fs from 'node:fs';
const donorSrc = fs.readFileSync('C:/Users/srime/Documents/GitHub/StickRanger/GameToClone/STICK-RPG/js/weapons.js','utf8');
// Top-level keys of WEAPON_DEFS: lines with exactly two-space indent then `id: {`
const start = donorSrc.indexOf('const WEAPON_DEFS = {');
const body = donorSrc.slice(start);
const ids = [...body.matchAll(/^  ([A-Za-z_$][\w$]*)\s*:\s*\{/gm)].map(m => m[1]);
console.log('donor weapon count:', ids.length);
fs.writeFileSync('scripts/_donor_ids.json', JSON.stringify(ids, null, 0));
