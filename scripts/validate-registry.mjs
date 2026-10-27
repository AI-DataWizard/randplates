#!/usr/bin/env node
// RandPlates registry validator — deterministic, no LLM involvement.
// Validation-lite for P-104/P-106 outputs (roadmap Day 4-5).
// Usage: node scripts/validate-registry.mjs <raw-batch.json> [output-prefix]
import fs from 'fs';

const AISLES = ['starches','protein-fresh','protein-tinned','dairy','veg','fruit','spices','pantry','frozen','bakery','other'];
const TIERS = [3, 2, 1, 0.5];
const SHELF = ['short','medium','long'];
const UNITS = ['g','kg','ml','l','tsp','tbsp','cup','can','tin','slice','clove','unit','bunch','handful','pinch'];
const ID_RE = /^([a-z0-9]+-)*[a-z0-9]+$/;
const SIZE_RE = /-\d+(kg|g|ml|l)$/;

const inPath = process.argv[2];
const outPrefix = process.argv[3] || inPath.replace(/-raw\.json$/, '');
const rows = JSON.parse(fs.readFileSync(inPath, 'utf8'));

const staged = [], quarantined = [], notes = [];
const seen = new Map(); // id -> batch-local index (dup check)
let flaggedAliases = 0;

for (const [i, r] of rows.entries()) {
  const reasons = [];
  if (!r.id || !ID_RE.test(r.id)) reasons.push('bad-id');
  if (r.id && SIZE_RE.test(r.id)) reasons.push('size-embedded-in-id');
  if (seen.has(r.id)) reasons.push(`duplicate-id:${r.id}(${seen.get(r.id)})`);
  else seen.set(r.id, i);
  if (!r.name || typeof r.name !== 'string') reasons.push('bad-name');
  if (!Array.isArray(r.aliases) || r.aliases.length < 3) reasons.push('bad-aliases');
  else {
    for (const a of r.aliases) {
      if (typeof a !== 'string' || a === '') { reasons.push('bad-alias-value'); break; }
      if (a.endsWith('?')) flaggedAliases++;
    }
  }
  if (!AISLES.includes(r.aisle)) reasons.push(`bad-aisle:${r.aisle}`);
  if (!TIERS.includes(r.tier)) reasons.push(`bad-tier:${r.tier}`);
  if (!SHELF.includes(r.shelf_life)) reasons.push(`bad-shelf-life:${r.shelf_life}`);
  const ub = r.unit_basis || {};
  if (!Number.isFinite(ub.qty) || ub.qty <= 0) reasons.push('bad-unit-basis-qty');
  if (!UNITS.includes(ub.unit)) reasons.push(`bad-unit-basis-unit:${ub.unit}`);
  if (reasons.length) { quarantined.push({ row: i, id: r.id, reasons }); continue; }
  staged.push(r);
}

const report = {
  input: inPath, items_in: rows.length,
  staged: staged.length, quarantined: quarantined.length,
  flagged_aliases_needing_review: flaggedAliases,
  quarantine_reasons: quarantined.flatMap(q => q.reasons.map(x => x.split(':')[0])).reduce((a, k) => (a[k] = (a[k] || 0) + 1, a), {}),
};
fs.writeFileSync(outPrefix + '-staged.json', JSON.stringify(staged, null, 2));
fs.writeFileSync(outPrefix + '-quarantine.json', JSON.stringify(quarantined, null, 2));
fs.writeFileSync(outPrefix + '-report.json', JSON.stringify(report, null, 2));
console.log(`items in: ${rows.length} | staged: ${staged.length} | quarantined: ${quarantined.length} | aliases flagged "?": ${flaggedAliases}`);
if (quarantined.length) console.log(JSON.stringify(report.quarantine_reasons));
quarantined.forEach(q => console.log(`  QUARANTINE row ${q.row} (${q.id}): ${q.reasons.join(', ')}`));
