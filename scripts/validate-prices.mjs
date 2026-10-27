#!/usr/bin/env node
// RandPlates price-entry validator — deterministic, no LLM involvement.
// 2026-10-07: product-path regex widened — Checkers also serves real product
// pages at /All-Departments/.../p/<code> (verified live); the old rule only
// accepted /prod/ and /product/ paths and wrongly quarantined valid rows.
// Seed of scripts/validate-data.mjs (roadmap Day 5, P-107).
// Usage: node scripts/validate-prices.mjs <raw-batch.json> [output-prefix]
import fs from 'fs';

const ALLOWED_UNITS = ['g','kg','ml','l','tsp','tbsp','cup','can','tin','slice','clove','unit','bunch','handful','pinch'];
const ALLOWED_STORES = ['Shoprite','Boxer','PNP','Checkers','Woolworths','Spaza'];
// 2026-10-07: Mr D (mrd.com) is PnP's official grocery delivery partner and shows
// PnP in-store prices ("Get groceries at in-store prices" - verified live,
// carrots R12.99 exact match). pnp.co.za is unreachable from research tools,
// so mrd.com is the accepted PnP channel - FULL PRODUCT PAGES ONLY:
// /delivery/groceries/products/<id>/... Bare mrd.com links stay rejected.
const STORE_DOMAIN = { Shoprite:['checkers.co.za','shoprite.co.za'], Checkers:['checkers.co.za'], PNP:['pnp.co.za','mrd.com'], Woolworths:['woolworths.co.za'], Boxer:['boxer.co.za'], Spaza:[] };

const inPath = process.argv[2];
const outPrefix = process.argv[3] || inPath.replace(/\.json$/, '');
const rows = JSON.parse(fs.readFileSync(inPath, 'utf8'));

const staged = [], quarantined = [], fixes = [], advisories = [];
const codeOwner = new Map();   // product code -> ingredient_id (or '__SHARED__')
const urlOwner = new Map();

// Pass 1: register product codes + URLs across the whole batch to detect reuse
for (const r of rows) {
  const codes = (r.url || '').match(/\d{8,14}[A-Z]{0,2}/g) || [];
  for (const c of codes) {
    if (!codeOwner.has(c)) codeOwner.set(c, r.ingredient_id);
    else if (codeOwner.get(c) !== r.ingredient_id) codeOwner.set(c, '__SHARED__');
  }
  if (r.url) {
    if (!urlOwner.has(r.url)) urlOwner.set(r.url, r.ingredient_id);
    else if (urlOwner.get(r.url) !== r.ingredient_id) urlOwner.set(r.url, '__SHARED__');
  }
}

// Pass 2: classify each row
for (const [i, r] of rows.entries()) {
  if (r.price_cents === null || r.url === null) {
    quarantined.push({ row: i, ingredient_id: r.ingredient_id, store: r.store, reasons: ['null-price'] });
    continue;
  }
  const reasons = [];
  if (r.source !== 'estimated') fixes.push(`row ${i} (${r.ingredient_id}/${r.store}): source "${r.source}" -> forced to "estimated"`);
  if (!Number.isInteger(r.price_cents) || r.price_cents <= 0) reasons.push('bad-price-cents');
  if (!/^([a-z0-9]+-)*[a-z0-9]+$/.test(r.ingredient_id || '')) reasons.push('bad-ingredient-id');
  if (!ALLOWED_STORES.includes(r.store)) reasons.push('bad-store');
  if (!ALLOWED_UNITS.includes(r.pack_unit)) {
    if (r.pack_unit === 'pack') { r.pack_unit = 'unit'; fixes.push(`row ${i} (${r.ingredient_id}/${r.store}): pack_unit "pack" -> "unit"`); }
    else reasons.push(`bad-unit:${r.pack_unit}`);
  }
  let host = '';
  try { host = new URL(r.url).hostname; } catch { reasons.push('unparseable-url'); }
  const dom = STORE_DOMAIN[r.store] || [];
  if (r.store && dom.length && !dom.some(d => r.url.includes(d))) reasons.push(`wrong-domain:${host}`);
  if (r.url.includes('mrd.com') && !/\/delivery\/groceries\/products\//.test(r.url)) reasons.push('mrd-not-product-page');
  if (!/mrd\.com/.test(r.url) && !/\/prod\/|\/product\/|\/p\/\d{6,14}[A-Z]{0,2}/.test(r.url)) reasons.push('no-product-path'); // mrd.com paths checked separately
  const codes = r.url.match(/\d{8,14}[A-Z]{0,2}/g) || [];
  if (codes.some(c => codeOwner.get(c) === '__SHARED__')) reasons.push('shared-product-code');
  if (urlOwner.get(r.url) === '__SHARED__') reasons.push('duplicate-url');
  if (reasons.length) { quarantined.push({ row: i, ingredient_id: r.ingredient_id, store: r.store, brand: r.brand, price_cents: r.price_cents, reasons }); continue; }
  r.source = 'estimated';
  staged.push(r);
}

// Pass 3: advisory spread check (per-100-unit normalized, staged rows only)
const perIng = new Map();
for (const r of staged) {
  if (!perIng.has(r.ingredient_id)) perIng.set(r.ingredient_id, []);
  perIng.get(r.ingredient_id).push(r);
}
for (const [ing, rs] of perIng) {
  if (rs.length < 2) continue;
  const perUnit = rs.map(r => r.price_cents / r.pack_qty);
  const max = Math.max(...perUnit), min = Math.min(...perUnit);
  if (min > 0 && max / min > 2.5) advisories.push(`${ing}: per-unit spread ${max / min}x across staged stores — check pack math`);
}

const report = {
  input: inPath, rows_in: rows.length,
  staged: staged.length, quarantined: quarantined.length,
  quarantine_reasons: quarantined.flatMap(q => q.reasons || []).reduce((a, r) => { const k = r.split(':')[0]; a[k] = (a[k] || 0) + 1; return a; }, {}),
  auto_fixes: fixes, advisories,
};
fs.writeFileSync(outPrefix + '-staged.json', JSON.stringify(staged, null, 2));
fs.writeFileSync(outPrefix + '-quarantine.json', JSON.stringify(quarantined, null, 2));
fs.writeFileSync(outPrefix + '-report.json', JSON.stringify(report, null, 2));

console.log(`rows in:        ${rows.length}`);
console.log(`staged:         ${staged.length}`);
console.log(`quarantined:    ${quarantined.length}`);
console.log(`reason counts:  ${JSON.stringify(report.quarantine_reasons)}`);
console.log(`auto-fixes:     ${fixes.length}`);
fixes.forEach(f => console.log('  ' + f));
console.log(`advisories:     ${advisories.length}`);
advisories.forEach(a => console.log('  ' + a));
