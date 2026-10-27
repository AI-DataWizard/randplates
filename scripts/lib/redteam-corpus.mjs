// scripts/lib/redteam-corpus.mjs — P-443: single source of truth for red-team
// corpus loading + evaluation. Both scripts/redteam-decoder.mjs (the P-419
// runner) and scripts/redteam-loop.mjs (the P-432 training loop) import THIS
// module, so the two harnesses can never drift apart on what "pass" means.
//
// One engine rule respected: evaluation calls ONLY the public entry
// decodeRecipeText() (passed in as decoderMod so blast can swap engine
// variants) — never internals.
import { readFileSync, existsSync } from 'node:fs';
import { searchIngredients } from '../../js/modules/search.js';

// ---------- fixture shapes ----------
// { id, corpus: 'v1'|'v2'|'v3', category, input, kind, expected, layer? }
//   kind: 'check' (v1 CHECKS table) | 'line' (v2 line semantics) |
//         'sq' (step quality) | 'golden' (draft-shape lock) |
//         'v3' (P-442-era JSONL: field-by-field expected)

export function makeResolver() {
  const INGREDIENTS = JSON.parse(readFileSync('data/ingredients.json', 'utf8')).items;
  return (name) => searchIngredients(name, INGREDIENTS)[0] || null;
}

// ---------- v1: tests/fixtures/red-team-decoder-tests.txt (LIVE, do not touch) ----------
export function loadV1() {
  const raw = readFileSync('tests/fixtures/red-team-decoder-tests.txt', 'utf8');
  const cases = [];
  let cat = null, id = null, title = null, collecting = false, buf = [];
  const flush = () => { if (id) cases.push({ corpus: 'v1', category: cat, id, title, kind: 'check', input: buf.join('\n') }); id = null; buf = []; };
  for (const line of raw.split('\n')) {
    const m = line.match(/^CATEGORY ([A-J]):/);
    if (m) { flush(); cat = m[1]; collecting = false; continue; }
    const t = line.match(/^--- TEST (I?\d+|[A-J]\d+): (.+?) ---/);
    if (t) { flush(); id = t[1]; title = t[2]; collecting = false; continue; }
    if (/^--- MASSIVE MIX START ---/.test(line)) { flush(); id = 'I-MIX'; title = '15-recipe dump'; buf = []; collecting = true; continue; }
    if (/^--- MASSIVE MIX END ---/.test(line)) { flush(); collecting = false; continue; }
    if (cat === 'H' && /^\d+\.\s/.test(line) && !id) {
      cases.push({ corpus: 'v1', category: 'H', id: 'H' + cases.filter(c => c.category === 'H').length, title: line.slice(3).trim(), kind: 'check', input: line.slice(3).trim() });
      continue;
    }
    if (id && /^Input:/.test(line)) { collecting = true; continue; }
    if (collecting) {
      if (/^={5,}/.test(line)) { flush(); collecting = false; continue; }
      buf.push(line);
    }
  }
  flush();
  for (const c of cases) c.input = c.input.replace(/\s+$/, '');
  return cases;
}

// ---------- v2: tests/fixtures/red-team-decoder-tests-v2.txt (LIVE) ----------
export function loadV2() {
  const raw = readFileSync('tests/fixtures/red-team-decoder-tests-v2.txt', 'utf8');
  const blocks = raw.split('--- TEST ID: ').slice(1);
  const out = [];
  for (const blk of blocks) {
    const id = blk.split(' ---')[0];
    const input = (blk.match(/Input: ?([\s\S]*?)\nExpected:/) || [])[1]?.trim();
    const exp = (blk.match(/Expected: ?([^\n#]*)/) || [])[1]?.trim() || (blk.match(/Expected:\n?([\s\S]*?)\n---/) || [])[1] || '';
    if (!input) continue;
    if (/^SQ\d/.test(id)) out.push({ corpus: 'v2', category: 'SQ', id, kind: 'sq', input, expected: exp });
    else if (/^P\d/.test(id)) out.push({ corpus: 'v2', category: 'P', id: id.slice(0, 2), kind: 'golden', input, expected: raw });
    else out.push({ corpus: 'v2', category: id.slice(0, 1), id, kind: 'line', input, expected: exp });
  }
  return out;
}

// ---------- v3: tests/corpus/v3.jsonl (P-431 generates; accepted day one) ----------
export function loadV3() {
  const p = 'tests/corpus/v3.jsonl';
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(l => l.trim()).map(l => {
    const f = JSON.parse(l);
    return { corpus: 'v3', category: f.category || 'uncat', id: f.id, kind: 'v3',
             input: f.input, expected: f.expected || {}, layer: f.layer };
  });
}

export function loadCorpus() { return [...loadV1(), ...loadV2(), ...loadV3()]; }

// ---------- v1 CHECKS (ported verbatim from the P-419 runner) ----------
const num = (x) => typeof x === 'number' && isFinite(x);
const ingHas = (d, pred) => d.ingredients.some(pred);
const reviewReasons = (d) => (d.unresolved || []).map(u => u.reason || '?');
const ing = (i) => i.qty + i.unit;

export const CHECKS = {
  A01: d => [{ ok: d.ingredients.length === 5 && d.ingredients.map(i => i.qty).every(num) && Math.abs(d.ingredients[0].qty - .5) < .01 && Math.abs(d.ingredients[3].qty - 1.5) < .01, why: '5 numeric qtys incl. ½→0.5 and 1 ½→1.5, got ' + JSON.stringify(d.ingredients.map(i => i.qty)) }],
  A02: d => [{ ok: d.ingredients.filter(i => num(i.qty)).length >= 5, why: 'spelled/range numbers numeric: ' + JSON.stringify(d.ingredients.map(i => i.qty)) }],
  A03: d => [{ ok: d.ingredients.length === 5 && d.ingredients.every(i => num(i.qty) && i.unit !== 'unit') || i_raw(d, 0), why: 'compact units split: ' + JSON.stringify(d.ingredients.map(ing)) }],
  A04: d => [{ ok: d.ingredients.length === 4 && d.ingredients.every(i => num(i.qty)), why: 'imperial/metric mix: ' + JSON.stringify(d.ingredients.map(ing)) }],
  A05: d => [{ ok: d.ingredients.length === 0 && (d.unresolved || []).length >= 5, why: 'vague quantifiers ALL review, auto-saved ' + d.ingredients.length }],
  A06: d => [{ ok: d.ingredients.length === 5 && d.ingredients.every(i => num(i.qty) && i.unit !== 'unit'), why: 'packaging sizes w/ parenthetical: ' + JSON.stringify(d.ingredients.map(ing)) }],
  B01: d => [{ ok: d.ingredients.filter(i => num(i.qty)).length >= 3 && d.steps.some(s => /180/i.test(s)), why: 'emoji-bulleted ingredients parsed, bake line is a step: ' + JSON.stringify(d.ingredients.map(i => i.raw)) }],
  B02: d => [{ ok: d.ingredients.length >= 2 && d.ingredients.every(i => !/#/.test(i.raw)), why: 'hashtags stripped: ' + JSON.stringify(d.ingredients.map(i => i.raw)) }],
  B03: d => [{ ok: d.ingredients.filter(i => num(i.qty)).length >= 3, why: 'recipe under POV/story wrapper: ' + JSON.stringify(d.ingredients.map(i => i.raw)) }],
  B04: d => [{ ok: d.ingredients.length === 0, why: 'CTA/credit noise: 0 ingredients, got ' + d.ingredients.length }],
  B05: d => [{ ok: d.ingredients.filter(i => num(i.qty)).length >= 2, why: 'all-caps/elongated: ' + JSON.stringify(d.ingredients.map(i => i.raw)) }],
  B06: d => [{ ok: d.ingredients.some(i => /flour/i.test(i.raw) && num(i.qty)) && (d.ignored || []).some(x => /music/i.test(x)), why: '>> prefix parsed, [Music] ignored: ' + JSON.stringify(d.ingredients.map(i => i.raw)) }],
  C01: d => [{ ok: d.ingredients.filter(i => num(i.qty)).length >= 5, why: 'comma-separated line splits: ' + JSON.stringify(d.ingredients.map(i => i.raw)) }],
  C02: d => [{ ok: d.ingredients.filter(i => num(i.qty)).length >= 4 && d.steps.length >= 3, why: 'interleaved: ' + d.ingredients.length + ' ing, ' + d.steps.length + ' steps' }],
  C03: d => [{ ok: d.meta?.isMultiRecipe === true && d.ingredients.length > 0, why: 'multi-recipe flagged + first parsed: ' + JSON.stringify(d.meta || {}) }],
  C04: d => [{ ok: d.ingredients.filter(i => num(i.qty)).length >= 3, why: 'headerless list: ' + JSON.stringify(d.ingredients.map(i => i.raw)) }],
  C05: d => [{ ok: d.steps.length >= 4 && d.ingredients.length === 0, why: 'unnumbered steps: ' + d.steps.length + ' steps, ' + d.ingredients.length + ' ing' }],
  C06: d => [{ ok: d.ingredients.filter(i => num(i.qty)).length >= 4 && d.steps.length >= 2, why: 'markdown stripped: ' + JSON.stringify(d.ingredients.map(i => i.raw)) }],
  D01: d => [{ ok: d.ingredients.length === 0, why: 'instructions with qty: 0 ingredients, got ' + d.ingredients.length }],
  D02: d => [{ ok: d.ingredients.length === 0 && (d.unresolved || []).length >= 4, why: 'subjective doneness ALL review' }],
  D03: d => [{ ok: d.ingredients.length === 0, why: 'equipment never ingredient, got ' + d.ingredients.length }],
  D04: d => [{ ok: d.ingredients.length === 0, why: 'nutrition/cost never ingredient, got ' + d.ingredients.length }],
  D05: d => [{ ok: d.ingredients.every(i => num(i.qty)) && d.ingredients.filter(i => num(i.qty)).length >= 2, why: 'slash alternatives keep real qty: ' + JSON.stringify(d.ingredients.map(i => i.raw)) }],
  E01: d => [{ ok: d.ingredients.filter(i => num(i.qty)).length >= 5, why: 'SA brands qty extraction: ' + JSON.stringify(d.ingredients.map(i => i.qty + i.raw)) }],
  E02: d => [{ ok: d.ingredients.filter(i => num(i.qty)).length >= 3 && (d.unresolved || []).some(u => /knippie|pinch/i.test(u.line)), why: 'Afrikaans qty parsed, knippie vague→review' }],
  E03: d => [{ ok: d.ingredients.filter(i => num(i.qty)).length >= 2, why: 'vernacular lines: ' + JSON.stringify(d.ingredients.map(i => i.raw)) }],
  E04: d => [{ ok: d.ingredients.length === 0, why: 'pricing talk never ingredient, got ' + d.ingredients.length }],
  F01: d => [{ ok: d.ingredients.filter(i => num(i.qty)).length >= 2, why: 'ZWSP/NBSP normalized, lookalikes safe: ' + JSON.stringify(d.ingredients.map(i => i.raw)) }],
  F02: d => [{ ok: d.ingredients.filter(i => num(i.qty)).length >= 1, why: 'mid-line-breaks graceful: ' + JSON.stringify(d.ingredients.map(i => i.raw)) }],
};
function i_raw(d, n) { return d.ingredients[n] && d.ingredients[n].raw.startsWith('200g'); } // A03 legacy escape clause

// H cases: every line MUST be review/ignored, zero auto-save (SAFETY)
export const H_CHECK = d => [{ ok: d.ingredients.length === 0 && ((d.unresolved || []).length >= 1 || (d.ignored || []).length >= 1), why: 'H line auto-saved ' + d.ingredients.length + ' ingredients' }];

// ---------- evaluation (public entry only) ----------
const safeCheck = (fn) => { try { return fn(); } catch (e) { return { ok: false, why: 'CRASH: ' + e.message }; } };

/** Evaluate one fixture against one engine variant.
 *  Returns { pass, why, draft } — draft is a comparable snapshot for blast. */
export function evaluate(fx, decoderMod, resolve) {
  let draft, crash = null;
  try { draft = decoderMod.decodeRecipeText(fx.input, resolve); }
  catch (e) { crash = e.message; }
  const snap = crash ? { crash } : snapshot(draft);
  if (crash) return { pass: false, why: 'CRASH: ' + crash, draft: snap };

  const why = [];
  if (fx.kind === 'check') {
    const checkFn = fx.category === 'H' ? H_CHECK : CHECKS[fx.id] || (() => [{ ok: true, why: 'no assertion (informational)' }]);
    const checks = safeCheck(() => checkFn(draft));
    const arr = Array.isArray(checks) ? checks : [checks];
    if (!arr.every(x => x.ok)) why.push(...arr.filter(x => !x.ok).map(x => x.why));
  } else if (fx.kind === 'line') {
    why.push(...evalLine(fx, draft));
  } else if (fx.kind === 'sq') {
    why.push(...evalSQ(fx, draft));
  } else if (fx.kind === 'golden') {
    why.push(...evalGolden(fx, draft));
  } else if (fx.kind === 'v3') {
    why.push(...evalV3(fx, draft));
  }
  return { pass: why.length === 0, why: why.join('; '), draft: snap };
}

function evalLine(fx, d) {
  const exp = fx.expected, out = [];
  let ok, why;
  if (/servings=|timeMinutes=/.test(exp)) {   // META(...) + TP phrasing family (P-445)
    const sv = exp.match(/servings=(\d+|null)/); const tmv = exp.match(/timeMinutes=(\d+)/);
    ok = (!sv || String(d.servings) === sv[1]) && (!tmv || String(d.timeMinutes) === tmv[1]);
    why = 'servings=' + d.servings + ' time=' + d.timeMinutes;
  } else if (exp === 'RESOLVE') {
    ok = d.ingredients.length > 0 && d.ingredients.every(i => i.resolvedId);
    why = d.ingredients.map(i => (i.resolvedId || '?') + '/' + i.qty).join(',') || 'none';
  } else if (exp === 'IGNORED') {
    ok = d.unresolved.length === 0 && d.ingredients.length === 0 && d.steps.length === 0;
    why = 'ignored:' + d.ignored.length + ' unresolved:' + d.unresolved.length + ' steps:' + d.steps.length;
  } else if (exp.startsWith('RESOLVE_AS_STEP(')) {
    const want = exp.match(/RESOLVE_AS_STEP\("([^"]*)"/)[1];
    ok = d.steps.length > 0 && d.steps[0].toLowerCase().includes(want.toLowerCase());
    why = 'step0=' + JSON.stringify(d.steps[0] || '');
  } else {
    const m = exp.match(/REVIEW_QUEUE\((\w+)\)/);
    ok = m ? d.unresolved.some(u => u.reason === m[1]) : false;
    why = 'reasons=' + (d.unresolved.map(u => u.reason).join(',') || 'none');
  }
  if (!ok) out.push(exp + ' :: ' + why);
  return out;
}

const SQ_IDS = ['maize-meal', 'fruit-chutney', 'chakalaka', 'amasi'];
function evalSQ(fx, d) {
  const exp = fx.expected, out = [];
  const wantSteps = exp.includes('steps: [') ? JSON.parse(exp.match(/steps: (\[[^\]]*\])/)[1]) : null;
  const wantOven = exp.match(/ovenTempC: (\d+|null)/);
  const wantServe = exp.match(/serveWith: \[([^\]]*)\]/);
  const wantIgnored = exp.match(/ignored: \[([^\]]*)\]/);
  if (wantSteps && JSON.stringify(d.steps) !== JSON.stringify(wantSteps)) out.push('steps=' + JSON.stringify(d.steps));
  if (wantOven && String(d.ovenTempC) !== wantOven[1]) out.push('oven=' + d.ovenTempC);
  if (wantServe && (d.serveWith || []).map(s => s.resolvedId).join(', ') !== wantServe[1]) out.push('serveWith=' + (d.serveWith || []).map(s => s.resolvedId).join(', '));
  if (wantIgnored && !(d.ignored || []).some(l => l.includes("won't believe"))) out.push('ignored=' + JSON.stringify(d.ignored));
  return out;
}

function evalGolden(fx, d) {
  // the golden block lives in the raw v2 fixture, keyed by the P-tag
  const raw = fx.expected;
  const g = raw.split('--- GOLDEN ').slice(1).map(b => b.split(':')[0] === fx.id ? b : null).filter(Boolean)[0];
  if (!g) return ['golden block ' + fx.id + ' not found'];
  const out = [];
  const wantIng = (g.match(/ingredients: ([^\n]*)/) || [])[1]?.trim().split(', ').map(s => s.split('/'));
  const wantSteps = parseInt((g.match(/steps: (\d+)/) || [])[1], 10);
  const wantTitle = (g.match(/title="([^"]*)"/) || [])[1];
  const wantServ = parseInt((g.match(/servings=(\d+)/) || [])[1], 10);
  const wantTime = parseInt((g.match(/timeMinutes=(\d+)/) || [])[1], 10);
  if (d.title !== wantTitle) out.push('title=' + JSON.stringify(d.title));
  if (d.servings !== wantServ) out.push('servings=' + d.servings);
  if (d.timeMinutes !== wantTime) out.push('time=' + d.timeMinutes);
  if (d.steps.length !== wantSteps) out.push('steps=' + d.steps.length);
  if (d.ingredients.length !== wantIng.length) out.push('ingCount=' + d.ingredients.length);
  wantIng.forEach((w, i) => {
    const got = d.ingredients[i];
    // P-443: split qty/unit at the first letter — the legacy unit-alternation
    // regex could not handle as-entered units like "packet", "loaf", "egg".
    const q = (w[1].match(/^([\d.]+)/) || [])[1];
    const u = w[1].slice(q.length);
    if (!got || got.resolvedId !== w[0] || String(got.qty) !== q || got.unit !== u) {
      out.push(`ing[${i}]=${got ? got.resolvedId + '/' + got.qty + got.unit : 'none'} want ${w[0] + '/' + w[1]}`);
    }
  });
  if (d.reviewRequired !== false) out.push('reviewRequired=' + d.reviewRequired);
  return out;
}

function evalV3(fx, d) {
  const out = [], e = fx.expected;
  if ('qty' in e && String(d.ingredients[0]?.qty) !== String(e.qty)) out.push('qty=' + d.ingredients[0]?.qty + ' want ' + e.qty);
  if ('unit' in e && (d.ingredients[0]?.unit || '') !== e.unit) out.push('unit=' + d.ingredients[0]?.unit + ' want ' + e.unit);
  if ('qty_canon' in e && String(d.ingredients[0]?.qty_canon) !== String(e.qty_canon)) out.push('qty_canon=' + d.ingredients[0]?.qty_canon + ' want ' + e.qty_canon);
  if ('unit_canon' in e && (d.ingredients[0]?.unit_canon || '') !== e.unit_canon) out.push('unit_canon=' + d.ingredients[0]?.unit_canon + ' want ' + e.unit_canon);
  if ('reviewRequired' in e && d.reviewRequired !== e.reviewRequired) out.push('reviewRequired=' + d.reviewRequired);
  if ('reason' in e && !d.unresolved.some(u => u.reason === e.reason)) out.push('reason= got ' + d.unresolved.map(u => u.reason).join(','));
  if ('recipes' in e && Number(d.meta?.isMultiRecipe ? 2 : 1) !== e.recipes) out.push('recipes=' + (d.meta?.isMultiRecipe));
  if ('servings' in e && d.servings !== e.servings) out.push('servings=' + d.servings);
  if ('timeMinutes' in e && d.timeMinutes !== e.timeMinutes) out.push('time=' + d.timeMinutes);
  if ('steps' in e && d.steps.length !== e.steps) out.push('steps=' + d.steps.length);
  return out;
}

/** Comparable snapshot: the fields the corpus asserts on — canon fields
 *  included (P-442 dual-field is a blast-visible surface). */
function snapshot(d) {
  return {
    servings: d.servings, timeMinutes: d.timeMinutes, reviewRequired: d.reviewRequired,
    ingredients: (d.ingredients || []).map(i => ({ qty: i.qty, unit: i.unit, qty_canon: i.qty_canon ?? null, unit_canon: i.unit_canon ?? null, id: i.resolvedId })),
    steps: d.steps?.length ?? 0, unresolved: (d.unresolved || []).map(u => u.reason || u), multi: !!d.meta?.isMultiRecipe,
  };
}
