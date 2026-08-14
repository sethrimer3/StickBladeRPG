import fs from 'node:fs';
import vm from 'node:vm';
const src = fs.readFileSync('C:/Users/srime/Documents/GitHub/StickRanger/GameToClone/STICK-RPG/js/weapons.js','utf8');
const ctx = { window: {}, console, module: {}, exports: {} };
vm.createContext(ctx);
try { vm.runInContext(src + '\n;globalThis.__W = typeof WEAPON_DEFS !== "undefined" ? WEAPON_DEFS : null;', ctx); }
catch (e) { console.log('EVAL ERROR:', e.message); }
const W = ctx.__W ?? ctx.globalThis?.__W;
console.log('evaluated defs:', W ? Object.keys(W).length : 'null');
if (W) fs.writeFileSync('scripts/_donor_defs.json', JSON.stringify(W, (k,v) => typeof v === 'function' ? '__FN__' : v));
