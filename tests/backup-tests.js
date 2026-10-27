// backup-tests.js — P-103 scenarios: the pantry export/import contract.
// The round-trip guarantee is the headline: serialize -> wipe -> import must
// reproduce identical state, and it's proven here at the pure-function level
// (the IndexedDB plumbing above it is exercised by tests.html in the browser).
import { serializePantry, validatePantryImport, FORMAT_VERSION, PANTRY_UNITS } from '../js/modules/backup.js';

const results = [];
function T(name, fn) {
  try { fn(); results.push({ suite: 'backup', name, ok: true }); }
  catch (e) { results.push({ suite: 'backup', name, ok: false, err: String(e.message || e) }); }
}
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m || 'not equal'}:\n  got:  ${JSON.stringify(a)}\n  want: ${JSON.stringify(b)}`); };

const PANTRY = [
  { id: 'maize-meal', qty: 2500, unit: 'g', running_low: false },
  { id: 'cooking-oil', qty: 750, unit: 'ml', running_low: true },
  { id: 'eggs', qty: 6, unit: 'unit', running_low: false },
];
const KNOWN = new Set(['maize-meal', 'cooking-oil', 'eggs', 'white-rice']);
const roundTrip = (pantry, opts = {}) => {
  const file = JSON.stringify(serializePantry(pantry, { exportedAt: '2026-10-09T00:00:00.000Z' }));
  return validatePantryImport(file, { knownIds: KNOWN, ...opts });
};

// ---------- the guarantee ----------
T('ROUND-TRIP: export -> import reproduces the pantry exactly', () => {
  const res = roundTrip(PANTRY);
  if (!res.ok) throw new Error('failed: ' + JSON.stringify(res.errors));
  eq(res.data.pantry, PANTRY.sort((a, b) => a.id.localeCompare(b.id)), 'round-trip state');
});

T('ROUND-TRIP: byte-identical exports (determinism discipline)', () => {
  const a = JSON.stringify(serializePantry(PANTRY, { exportedAt: '2026-10-09T00:00:00.000Z' }));
  const b = JSON.stringify(serializePantry([...PANTRY].reverse(), { exportedAt: '2026-10-09T00:00:00.000Z' }));
  eq(a, b, 'serialization must not depend on row input order');
});

T('ROUND-TRIP: empty pantry exports and re-imports cleanly', () => {
  const res = roundTrip([]);
  if (!res.ok || res.data.pantry.length) throw new Error('empty pantry should round-trip to empty');
});

T('exports carry app/kind/format_version markers', () => {
  const f = serializePantry(PANTRY, { exportedAt: '2026-10-09T00:00:00.000Z' });
  eq(f.app, 'randplates'); eq(f.kind, 'pantry'); eq(f.format_version, FORMAT_VERSION);
  eq(f.exported_at, '2026-10-09T00:00:00.000Z');
});

// ---------- rejections: specific, human, never a raw exception ----------
T('invalid JSON -> ok:false with a human message, no throw', () => {
  const res = validatePantryImport('{"pantry": [', { knownIds: KNOWN });
  if (res.ok) throw new Error('should refuse');
  if (!res.errors[0].message.includes('JSON')) throw new Error('message should explain the JSON problem');
});

T('wrong top-level shape -> error says what it expected', () => {
  const res = validatePantryImport('[1,2,3]', {});
  if (res.ok) throw new Error('should refuse an array root');
  if (!res.errors[0].message.includes('pantry')) throw new Error('message should mention the expected shape');
});

T('missing pantry list -> error names the field', () => {
  const res = validatePantryImport('{"app":"randplates"}', {});
  eq(res.errors[0].field, 'pantry');
});

T('unknown ingredient id -> row + field + the actual id', () => {
  const file = JSON.stringify({ format_version: 1, pantry: [
    { id: 'maize-meal', qty: 2500, unit: 'g', running_low: false },
    { id: 'ingrdient-x', qty: 100, unit: 'g', running_low: false },
  ]});
  const res = validatePantryImport(file, { knownIds: KNOWN });
  if (res.ok) throw new Error('should refuse unknown id');
  eq(res.errors[0].row, 2);
  eq(res.errors[0].field, 'id');
  if (!res.errors[0].message.includes('Row 2') || !res.errors[0].message.includes('ingrdient-x')) throw new Error('error must name row + id');
});

T('duplicate id -> refused with the second row number (no silent overwrite)', () => {
  const file = JSON.stringify({ pantry: [
    { id: 'eggs', qty: 6, unit: 'unit' },
    { id: 'eggs', qty: 12, unit: 'unit' },
  ]});
  const res = validatePantryImport(file, { knownIds: KNOWN });
  if (res.ok) throw new Error('duplicates must be refused, not silently upserted');
  eq(res.errors[0].row, 2);
});

T('bad qty -> row + field error, value quoted', () => {
  for (const bad of ['five', -5, null, '2500']) {
    const file = JSON.stringify({ pantry: [{ id: 'eggs', qty: bad, unit: 'unit' }] });
    const res = validatePantryImport(file, { knownIds: KNOWN });
    if (res.ok) throw new Error(`qty ${JSON.stringify(bad)} must be refused`);
    eq(res.errors[0].field, 'qty');
    if (!res.errors[0].message.includes('Row 1')) throw new Error('error must name the row');
  }
});

T('bad unit -> error lists the allowed units', () => {
  const file = JSON.stringify({ pantry: [{ id: 'eggs', qty: 6, unit: 'kg' }] });
  const res = validatePantryImport(file, { knownIds: KNOWN });
  if (res.ok) throw new Error('unit kg must be refused (pantry units only)');
  if (!res.errors[0].message.includes(PANTRY_UNITS.join(', '))) throw new Error('error should list allowed units');
});

// ---------- warnings: never block, always inform ----------
T('no version marker -> imports with a warning (old exports)', () => {
  const file = JSON.stringify({ pantry: [{ id: 'eggs', qty: 6, unit: 'unit', running_low: false }] });
  const res = validatePantryImport(file, { knownIds: KNOWN });
  if (!res.ok) throw new Error('old exports must import');
  if (!res.warnings.some(w => w.includes('version'))) throw new Error('should warn about the missing version');
});

T('future format_version -> imports known fields with a warning, never refuses', () => {
  const file = JSON.stringify({ format_version: 2, pantry: [
    { id: 'eggs', qty: 6, unit: 'unit', running_low: false, expiry: '2030-01-01' },
  ]});
  const res = validatePantryImport(file, { knownIds: KNOWN });
  if (!res.ok) throw new Error('newer versions must import with a warning, not a refusal');
  if (!res.warnings.some(w => w.includes('newer'))) throw new Error('should warn about newer version');
  eq(res.data.pantry[0].id, 'eggs');
  if ('expiry' in res.data.pantry[0]) throw new Error('unknown newer fields must be dropped');
});

T('non-boolean running_low -> coerced with a warning', () => {
  const file = JSON.stringify({ pantry: [{ id: 'eggs', qty: 6, unit: 'unit', running_low: 'yes' }] });
  const res = validatePantryImport(file, { knownIds: KNOWN });
  if (!res.ok) throw new Error('coercible values should not block import');
  eq(res.data.pantry[0].running_low, true);
  if (!res.warnings.length) throw new Error('should warn about the coercion');
});

T('unknown extra fields -> dropped, aggregated into ONE warning', () => {
  const file = JSON.stringify({ pantry: [
    { id: 'eggs', qty: 6, unit: 'unit', brand: 'Sasko' },
    { id: 'eggs2', qty: 1, unit: 'unit', expiry: 'x', brand: 'y' },
  ]});
  const res = validatePantryImport(file, { knownIds: new Set([...KNOWN, 'eggs2']) });
  if (!res.ok) throw new Error('extra fields should warn, not refuse');
  if (!res.warnings.some(w => w.includes('brand') && w.includes('expiry'))) throw new Error('warning should aggregate ignored fields');
  if ('brand' in res.data.pantry[0]) throw new Error('ignored fields must not enter the pantry');
});

export async function run() { return results; }
