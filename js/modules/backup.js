// backup.js — pantry export/import contracts (P-103, Day 3).
// PURE functions: no DOM, no IndexedDB, no fetch. Everything here is testable in
// the CLI harness and shareable with any future export surface.
//
// Design decisions:
// - Serialize deterministically (rows sorted by id, fixed field order): the same
//   pantry always exports byte-identically — the same determinism philosophy as
//   the matcher golden files.
// - Validate IMPORTS ruthlessly, but refuse nothing a human can't understand:
//   every error carries { row, field, message } with the row number a human
//   would count (1-based) and the exact offending value.
// - Versioning: format_version on every export. v1 is imported silently;
//   NO version marker imports with a warning (old exports); a NEWER version
//   imports with a warning (known fields kept, unknown ignored) — never a refusal.

export const FORMAT_VERSION = 1;
export const PANTRY_UNITS = ['g', 'ml', 'unit', 'can', 'bunch', 'slice'];

/** Serialize a pantry to the v1 export shape. Deterministic output. */
export function serializePantry(pantry, opts = {}) {
  const rows = [...(pantry || [])]
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map(p => ({ id: p.id, qty: p.qty, unit: p.unit, running_low: !!p.running_low }));
  return {
    app: 'randplates',
    kind: 'pantry',
    format_version: FORMAT_VERSION,
    exported_at: opts.exportedAt || new Date().toISOString(),
    pantry: rows,
  };
}

/**
 * Validate an import payload (raw file text).
 * opts.knownIds: Set/array of registry ingredient ids — when present, unknown
 * ingredient ids are rejected with a row-level error.
 *
 * Returns { ok, errors: [{row, field, message}], warnings: [string], data }
 * - ok true  → data.pantry is a clean, normalized row list safe to write.
 * - ok false → data is null; errors explains exactly what to fix.
 * Never throws: any malformed input becomes an error result.
 */
export function validatePantryImport(text, opts = {}) {
  const known = opts.knownIds ? new Set(opts.knownIds) : null;
  const out = { ok: false, errors: [], warnings: [], data: null };

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    out.errors.push({ row: null, field: null,
      message: `This file isn't valid JSON (${e.message?.split('\n')[0] || 'parse error'}). Did you export it as something other than a RandPlates pantry file?` });
    return out;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    out.errors.push({ row: null, field: null,
      message: `Expected a RandPlates pantry export (a JSON object with a "pantry" list), but this file's top level is ${Array.isArray(parsed) ? 'an array' : typeof parsed}.` });
    return out;
  }
  if (!('pantry' in parsed)) {
    out.errors.push({ row: null, field: 'pantry',
      message: 'No "pantry" list in this file — a RandPlates pantry export always has one.' });
    return out;
  }
  if (!Array.isArray(parsed.pantry)) {
    out.errors.push({ row: null, field: 'pantry',
      message: `"pantry" should be a list, but this file has ${typeof parsed.pantry}.` });
    return out;
  }

  // ---- version handling: warn, never refuse ----
  const v = parsed.format_version;
  if (v === undefined) {
    out.warnings.push('No version marker — treating this as a RandPlates v1 pantry file.');
  } else if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    out.errors.push({ row: null, field: 'format_version',
      message: `"format_version" should be a whole number (1, 2, …), not ${JSON.stringify(v)}.` });
    return out;
  } else if (v > FORMAT_VERSION) {
    out.warnings.push(`This file says format_version ${v}, which is newer than this RandPlates understands (${FORMAT_VERSION}). Importing the fields we know; newer fields are ignored.`);
  }
  if (parsed.kind !== undefined && parsed.kind !== 'pantry') {
    out.warnings.push(`This file says it's a "${parsed.kind}" export, not a pantry one — importing it as a pantry anyway.`);
  }

  // ---- row validation ----
  const seen = new Set();
  const unknownFields = new Set();
  const FIELDS = new Set(['id', 'qty', 'unit', 'running_low']);
  const clean = [];

  for (const [idx, row] of parsed.pantry.entries()) {
    const n = idx + 1; // human row number
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      out.errors.push({ row: n, field: null,
        message: `Row ${n} isn't an ingredient entry (it's ${Array.isArray(row) ? 'a list' : typeof row}). Each row should look like { "id": "maize-meal", "qty": 2500, "unit": "g", "running_low": false }.` });
      continue;
    }
    for (const k of Object.keys(row)) if (!FIELDS.has(k)) unknownFields.add(k);

    // id
    if (typeof row.id !== 'string' || !row.id.trim()) {
      out.errors.push({ row: n, field: 'id',
        message: `Row ${n}: "id" is missing or empty. Every pantry item needs an ingredient id like "maize-meal".` });
      continue;
    }
    if (seen.has(row.id)) {
      out.errors.push({ row: n, field: 'id',
        message: `Row ${n}: "${row.id}" appears twice in this file. Remove the duplicate row and import again.` });
      continue;
    }
    if (known && !known.has(row.id)) {
      out.errors.push({ row: n, field: 'id',
        message: `Row ${n}: "${row.id}" isn't in the RandPlates ingredient list. Check the spelling, or add it from the Pantry search first.` });
      continue;
    }
    seen.add(row.id);

    // qty
    if (typeof row.qty !== 'number' || !Number.isFinite(row.qty) || row.qty < 0) {
      out.errors.push({ row: n, field: 'qty',
        message: `Row ${n}: "qty" should be a positive number (e.g. 2500), but it's ${JSON.stringify(row.qty)}.` });
      continue;
    }

    // unit
    if (!PANTRY_UNITS.includes(row.unit)) {
      out.errors.push({ row: n, field: 'unit',
        message: `Row ${n}: "unit" should be one of ${PANTRY_UNITS.join(', ')} — but it's ${JSON.stringify(row.unit)}.` });
      continue;
    }

    // running_low: coerce with a warning, don't refuse
    let low = false;
    if (row.running_low !== undefined && typeof row.running_low !== 'boolean') {
      out.warnings.push(`Row ${n}: "running_low" should be true or false — treating ${JSON.stringify(row.running_low)} as ${!!row.running_low ? 'true' : 'false'}.`);
    }
    low = !!row.running_low;

    clean.push({ id: row.id, qty: row.qty, unit: row.unit, running_low: low });
  }

  if (out.errors.length) return out;

  if (unknownFields.size) {
    out.warnings.push(`Ignored fields this RandPlates doesn't use yet: ${[...unknownFields].sort().join(', ')}.`);
  }

  clean.sort((a, b) => a.id.localeCompare(b.id));
  out.ok = true;
  out.data = { pantry: clean };
  return out;
}
