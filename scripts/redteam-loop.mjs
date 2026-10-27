#!/usr/bin/env node
// scripts/redteam-loop.mjs — P-443: the deterministic training loop CLI
// (P-432 DeepSeek runbook v1, absorbed). The corpus is the trainer, the
// failure matrix is the gradient, the gate says no.
//
//   node scripts/redteam-loop.mjs report  [--md]                # confusion report (+ HARDENING_NOTES block)
//   node scripts/redteam-loop.mjs blast   --rule TAG [--patch file.diff]
//   node scripts/redteam-loop.mjs gate    --blast file.json
//   node scripts/redteam-loop.mjs iterate --rule TAG [--patch file.diff] [--allow-tail] [--no-e2e]
//   node scripts/redteam-loop.mjs plateau [--record <net>]
//
// No LLM, no network, no auto-commit. The gate advises, the owner decides.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { loadBaseline, loadPatched } from './lib/engine-loader.mjs';
import { loadCorpus, makeResolver } from './lib/redteam-corpus.mjs';
import { evaluate } from './lib/redteam-corpus.mjs';
import { isSafetyFixture } from './lib/safety.mjs';
import { inferLayer } from './lib/tagger.mjs';
import { buildMatrix, pickTargetCell } from './lib/matrix.mjs';
import { blast } from './lib/blast.mjs';
import { gate } from './lib/gate.mjs';
import { record as recordPlateau, history, isPlateau } from './lib/plateau.mjs';
import { emitReport, toMarkdown, appendNotes, currentSha } from './lib/report.mjs';
import { unitWall, e2eWall } from './lib/wall.mjs';

const arg = (k) => {
  const i = process.argv.indexOf(k);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  return v !== undefined && !v.startsWith('--') ? v : true;
};

// ---------- report ----------
async function cmdReport({ md = false } = {}) {
  const corpus = loadCorpus();
  const resolve = makeResolver();
  const engine = await loadPatched();
  const evals = [];
  for (const fx of corpus) {
    const r = evaluate(fx, engine, resolve);
    const t = r.pass ? { layer: null, ambiguous: false } : inferLayer(fx, r.why, r.draft);
    evals.push({ ...fx, ...r, layer: t.layer, ambiguous: t.ambiguous });
  }
  const safetyFx = evals.filter(e => isSafetyFixture(e));
  const matrix = buildMatrix(evals.filter(e => !e.pass));
  const counts = { v1: corpus.filter(f => f.corpus === 'v1').length,
                   v2: corpus.filter(f => f.corpus === 'v2').length,
                   v3: corpus.filter(f => f.corpus === 'v3').length };
  const report = emitReport({
    engineSha: currentSha(),
    corpus: counts,
    evals,
    safety: { total: safetyFx.length, passed: safetyFx.filter(e => e.pass).length,
              rate: safetyFx.length ? safetyFx.filter(e => e.pass).length / safetyFx.length : 1 },
    matrix,
    target: pickTargetCell(matrix),
  });
  console.log(toMarkdown(report));
  console.log('\n→ tests/redteam/last-report.json' + (report.ambiguous ? `\n⚠ ${report.ambiguous} ambiguous failure(s) — pin @layer in the fixture before targeting` : ''));
  if (md) { appendNotes(toMarkdown(report)); console.log('→ HARDENING_NOTES.md (appended)'); }
  return report;
}

// ---------- blast ----------
async function cmdBlast({ rule, patch }) {
  if (!rule) fail('--rule <TAG> is required — one rule change per iteration is enforced mechanically.');
  if (!patch) console.warn('⚠ no --patch recorded; the blast report will lack the diff reference.');
  else {
    const diff = readFileSync(patch, 'utf8');
    if (!/@rule:/.test(diff) && !diff.includes(rule))
      fail(`diff ${patch} does not declare the rule tag (@rule: ${rule} or the tag itself). Refusing — one rule change per iteration.`);
    const touched = [...diff.matchAll(/^diff --git a\/(\S+)/gm)].map(m => m[1]);
    if (touched.some(f => !/decoder|costing|search|main/.test(f)))
      fail('diff touches files outside the engine surface: ' + touched.join(', '));
  }
  const corpus = loadCorpus();
  const resolve = makeResolver();
  console.log(`loading baseline (HEAD) + patched (working tree) … corpus=${corpus.length}`);
  const baseline = await loadBaseline('HEAD');
  const patched = await loadPatched();
  const result = await blast(corpus, baseline, patched, resolve);
  const verdict = gate(result);
  const out = { rule, patch: patch || null, baselineSha: currentSha(), ...result, verdict };
  writeFileSync('tests/redteam/last-blast.json', JSON.stringify(out, null, 2));
  console.log(`fixes ${result.fixes.length} | regressions ${result.regressions.length} | safety ${result.safetyRegressions.length} | safeFlips ${result.safeFlips.length} | noise ${result.noise.length}`);
  console.log('gate:', verdict.verdict + (verdict.reason ? ` (${verdict.reason})` : ` net=${verdict.net}`));
  console.log('→ tests/redteam/last-blast.json');
  return out;
}

// ---------- gate ----------
function cmdGate({ blastFile }) {
  const r = JSON.parse(readFileSync(blastFile, 'utf8'));
  const verdict = gate(r, { allowTail: false });
  console.log(JSON.stringify(verdict, null, 2));
  return verdict;
}

// ---------- iterate (report → blast → gate → wall → plateau; NO auto-commit) ----------
async function cmdIterate({ rule, patch, allowTail, noE2e }) {
  console.log('== 1. baseline wall (report) ==');
  const report = await cmdReport({ md: false });
  if (report.safety.rate !== 1) {
    console.log('🚫 SAFETY < 100% — the wall is broken. Fix safety before any new rule.');
    process.exit(1);
  }
  console.log('\n== 2-3. blast + gate ==');
  const b = await cmdBlast({ rule, patch });
  const v = gate(b, { allowTail: !!allowTail });
  if (v.verdict === 'REJECT') {
    appendFileSync('tests/redteam/rejected.jsonl', JSON.stringify({ at: new Date().toISOString(), rule, patch, verdict: v, blast: { fixes: b.fixes, regressions: b.regressions, safetyRegressions: b.safetyRegressions } }) + '\n');
    console.log(`REJECT (${v.reason}) → tests/redteam/rejected.jsonl. Revert the working tree; do not commit.`);
    return;
  }
  console.log('\n== 4. full regression wall ==');
  const u = unitWall(); console.log('unit:', u.pass ? '✅ ' + u.summary : '🚫 ' + u.summary);
  let e2e = { pass: true, summary: 'skipped (--no-e2e)' };
  if (!noE2e) { e2e = e2eWall(); console.log('e2e :', e2e.pass ? '✅ ' + e2e.summary : '🚫 ' + e2e.summary); }
  if (!u.pass || !e2e.pass) {
    console.log('POST_GATE_SAFETY_FAILURE — hard revert the working tree. This should be impossible; if you see it, the gate has a bug.');
    process.exit(1);
  }
  console.log('\n== 5. plateau tracker ==');
  const net = b.fixes.length - b.regressions.length;
  recordPlateau({ at: new Date().toISOString(), rule, net, total: report.total, ratio: +(net / report.total).toFixed(4) });
  if (isPlateau(report.total)) {
    console.log('PLATEAU: two consecutive iterations under 1% net gain. STOP editing decoder.js.');
    console.log('Escalate by layer — remaining failure classes are in tests/redteam/last-report.json:');
    console.log('  preprocess/multi → owner escalation · unknown-unit + unresolved_ingredient → P-428 gap report · canon table miss → P-442 extension');
  } else {
    console.log(`ACCEPT net=+${net}. The gate advises, the owner decides: review the diff, then commit with the rule tag.`);
  }
}

// ---------- plateau ----------
function cmdPlateau({ recordNet }) {
  if (recordNet !== undefined) {
    const total = loadCorpus().length;
    recordPlateau({ at: new Date().toISOString(), net: Number(recordNet), total, ratio: +(recordNet / total).toFixed(4) });
  }
  const h = history();
  console.table ? console.table(h) : console.log(JSON.stringify(h, null, 2));
  console.log('plateau:', isPlateau(loadCorpus().length) ? 'YES — escalate' : 'no (needs 2 consecutive <1% iterations)');
}

function fail(msg) { console.error('✘ ' + msg); process.exit(1); }

// ---------- dispatch ----------
const cmd = process.argv[2];
try {
  if (cmd === 'report') await cmdReport({ md: arg('--md') });
  else if (cmd === 'blast') await cmdBlast({ rule: arg('--rule'), patch: arg('--patch') });
  else if (cmd === 'gate') cmdGate({ blastFile: arg('--blast') });
  else if (cmd === 'iterate') await cmdIterate({ rule: arg('--rule'), patch: arg('--patch'), allowTail: arg('--allow-tail'), noE2e: arg('--no-e2e') });
  else if (cmd === 'plateau') cmdPlateau({ recordNet: arg('--record') });
  else {
    console.log('usage: redteam-loop.mjs report [--md] | blast --rule TAG [--patch f.diff] | gate --blast f.json | iterate --rule TAG [...] | plateau [--record net]');
    process.exit(cmd ? 0 : 1);
  }
} catch (e) { fail(e.message); }
