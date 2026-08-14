import fs from 'node:fs';
import { WEAPONS } from '../src/sim/weapons/weaponDefs';
const donor: string[] = JSON.parse(fs.readFileSync('scripts/_donor_ids.json','utf8'));
const ours = Object.keys(WEAPONS);
const donorSet = new Set(donor), ourSet = new Set(ours);
console.log('donor:', donor.length, ' ours:', ours.length);
console.log('MISSING (in donor, not ported):', donor.filter(i => !ourSet.has(i)));
console.log('EXTRA (ours, not in donor):', ours.filter(i => !donorSet.has(i)));
