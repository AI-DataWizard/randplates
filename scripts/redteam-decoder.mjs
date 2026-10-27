#!/usr/bin/env node
// redteam-decoder.mjs — P-419 red-team runner, P-443 refactor: a thin CLI
// over scripts/lib/redteam-corpus.mjs (the single source of evaluation
// truth, shared with scripts/redteam-loop.mjs). Output format unchanged
// from the original P-419 runner.
// Usage: node scripts/redteam-decoder.mjs <before|after>
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadV1, loadV2, makeResolver, evaluate, CHECKS, H_CHECK } from './lib/redteam-corpus.mjs';
import { loadPatched } from './lib/engine-loader.mjs';

const label = process.argv[2] || 'run';
const engine = await loadPatched();
const resolve = makeResolver();

const cases = [...loadV1(), ...loadV2()];
const results = [];
let crashes = 0;
for (const c of cases) {
  const r = evaluate(c, engine, resolve);
  if (/^CRASH:/.test(r.why)) crashes++;
  results.push({ corpus: c.corpus, category: c.category, id: c.id, title: c.title, pass: r.pass,
    why: r.why, kind: c.kind,
    checks: [{ ok: r.pass, why: r.why }],
    ingredients: r.draft.ingredients?.map(i => ({ qty: i.qty, unit: i.unit, id: i.id })) || [],
    review: r.draft.unresolved || [], ignored: 0, steps: r.draft.steps ?? 0,
    multi: r.draft.multi });
}

const byCat = {};
for (const r of results) (byCat[r.category] = byCat[r.category] || []).push(r);
const catRates = Object.fromEntries(Object.entries(byCat).map(([k, v]) => [k, { pass: v.filter(x => x.pass).length, total: v.length, rate: +(v.filter(x => x.pass).length / v.length * 100).toFixed(1) }]));
const tier1 = ['A', 'B', 'C'], tier2 = ['E', 'F', 'G'];
const rate = cats => { const all = results.filter(r => cats.includes(r.category)); return +(all.filter(r => r.pass).length / Math.max(all.length, 1) * 100).toFixed(1); };
const safety = ['D', 'H'].flatMap(k => byCat[k] || []);

const report = { label, generated: new Date().toISOString(), totalCases: results.length, crashes,
  tier1_precision_ABC: rate(tier1), tier2_EFG: rate(tier2),
  safety_DH: { pass: safety.filter(x => x.pass).length, total: safety.length, autoSavedViolations: safety.filter(x => !x.pass).map(x => x.id) },
  categories: catRates, cases: results.filter(r => !r.pass).map(r => ({ id: r.id, why: r.why })) };
mkdirSync('reports', { recursive: true });
writeFileSync(`reports/red_team_report_${label}.json`, JSON.stringify(report, null, 1));

console.log(`\n=== RED-TEAM ${label.toUpperCase()} ===`);
console.log(`Tier1 (A/B/C): ${rate(tier1)}% | Tier2 (E/F/G): ${rate(tier2)}% | Safety (D/H): ${safety.filter(x => x.pass).length}/${safety.length} | Crashes: ${crashes}`);
for (const [k, v] of Object.entries(catRates)) console.log(`  ${k}: ${v.pass}/${v.total} (${v.rate}%)`);
const v2 = results.filter(r => r.corpus === 'v2');
const v2pass = v2.filter(r => r.pass).length;
const v2failures = v2.filter(r => !r.pass).map(r => '  ✘ ' + r.id + ' :: ' + r.why);
console.log(`V2 (K-P): ${v2pass}/${v2.length} pass${v2failures.length ? '\n' + v2failures.join('\n') : ''}`);
