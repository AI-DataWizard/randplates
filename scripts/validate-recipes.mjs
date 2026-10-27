#!/usr/bin/env node
// RandPlates recipe validator — deterministic, no LLM involvement.
// P-000d encoding pipeline: contract checks against registry + schema.
// Usage: node scripts/validate-recipes.mjs <batches-dir-glob-prefix> <registry.json>
//   e.g. node scripts/validate-recipes.mjs data/pending/recipes-batch*-raw.json data/pending/registry-all-staged.json
import fs from 'fs';

const UNITS = ['g','kg','ml','l','tsp','tbsp','cup','can','tin','slice','clove','unit','bunch','handful','pinch'];
const TAGS = ['budget','vegetarian','breakfast','lunch','dinner','dessert','snack','quick','family','traditional','student'];

const files = process.argv.slice(2, -1);
const regPath = process.argv[process.argv.length - 1];
const regIds = new Set(JSON.parse(fs.readFileSync(regPath, 'utf8')).map(r => r.id));

const staged = [], quarantined = [], advisories = [];
const seenIds = new Map();
let n = 0;

for (const f of files) {
  const rows = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const r of rows) {
    n++;
    const reasons = [];
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(r.id || '')) reasons.push(`bad-id:${r.id}`);
    if (seenIds.has(r.id)) reasons.push(`dup-id:${r.id} (also in ${seenIds.get(r.id)})`);
    else seenIds.set(r.id, f);
    if (!r.title || typeof r.title !== 'string') reasons.push('bad-title');
    if (!Number.isInteger(r.servings) || r.servings < 1 || r.servings > 8) reasons.push(`bad-servings:${r.servings}`);
    if (!Number.isInteger(r.time_minutes) || r.time_minutes < 5 || r.time_minutes > 90) reasons.push(`bad-time:${r.time_minutes}`);
    if (!Array.isArray(r.tags) || r.tags.length < 1) reasons.push('bad-tags');
    else if (r.tags.some(t => !TAGS.includes(t))) reasons.push(`bad-tag:${r.tags.filter(t => !TAGS.includes(t)).join(',')}`);
    if (!Array.isArray(r.ingredients) || r.ingredients.length === 0) reasons.push('no-ingredients');
    else for (const ing of r.ingredients) {
      if (!regIds.has(ing.id)) { reasons.push(`unknown-ingredient:${ing.id}`); continue; }
      if (typeof ing.qty !== 'number' || ing.qty <= 0) reasons.push(`bad-qty:${ing.id}`);
      if (!UNITS.includes(ing.unit)) reasons.push(`bad-unit:${ing.unit}(${ing.id})`);
    }
    if (!Array.isArray(r.steps) || r.steps.length < 4 || r.steps.length > 10
        || r.steps.some(s => typeof s !== 'string' || !s.trim())) reasons.push(`bad-steps:${Array.isArray(r.steps) ? r.steps.length : '?'}`);
    if (!r.source || r.source.platform !== 'orig' || !r.source.creator) reasons.push('bad-source');
    if (reasons.length) { quarantined.push({ id: r.id, title: r.title, reasons }); continue; }
    if (r.servings === 1 && !r.tags.includes('snack') && !r.tags.includes('dessert')) advisories.push(`${r.id}: servings 1 without snack/dessert tag`);
    if (r.steps.length === 10 && r.time_minutes <= 15) advisories.push(`${r.id}: 10 steps in ${r.time_minutes} min — check time honesty`);
    staged.push(r);
  }
}

fs.writeFileSync('.tmp/recipes-encoded-staged.json', JSON.stringify(staged, null, 2));
fs.writeFileSync('.tmp/recipes-encoded-quarantine.json', JSON.stringify(quarantined, null, 2));
console.log(`recipes in:    ${n}`);
console.log(`staged:        ${staged.length}`);
console.log(`quarantined:   ${quarantined.length}`);
quarantined.forEach(q => console.log(`  ${q.id || 'NO-ID'}: ${q.reasons.join(' | ')}`));
console.log(`advisories:    ${advisories.length}`);
advisories.forEach(a => console.log('  ' + a));

// tag + pantry coverage stats
const ingUse = new Map();
for (const r of staged) for (const ing of r.ingredients) ingUse.set(ing.id, (ingUse.get(ing.id) || 0) + 1);
const unused = [...regIds].filter(id => !ingUse.has(id));
console.log(`ingredients used: ${ingUse.size}/${regIds.size} | never used: ${unused.length}`);
if (unused.length <= 40) console.log('  unused: ' + unused.join(', '));
