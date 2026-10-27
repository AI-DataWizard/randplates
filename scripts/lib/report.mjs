// scripts/lib/report.mjs — P-443: confusion report (JSON artifact + markdown
// block for HARDENING_NOTES.md) per P-432 §1.3 + §7.
import { writeFileSync, appendFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

export function emitReport({ engineSha, corpus, evals, safety, matrix, target }) {
  const failed = evals.filter(e => !e.pass);
  const report = {
    runAt: new Date().toISOString(),
    engineSha,
    corpus,
    total: evals.length, passed: evals.length - failed.length, failed: failed.length,
    safety,
    matrix: matrix.matrix, marginals: { byCategory: matrix.byCategory, byLayer: matrix.byLayer },
    ambiguous: matrix.ambiguous,
    target,
    failures: failed.map(f => ({ id: f.id, corpus: f.corpus, category: f.category, layer: f.layer,
                                 why: (f.why || '').slice(0, 300) })),
  };
  writeFileSync('tests/redteam/last-report.json', JSON.stringify(report, null, 2));
  return report;
}

export function toMarkdown(report) {
  const L = report.matrix && Object.keys(report.matrix).length
    ? Object.keys(Object.values(report.matrix)[0]) : [];
  const head = '| category \\ layer | ' + L.map(x => x.slice(0, 5)).join(' | ') + ' | Σ |';
  const sep = '|---' + L.map(() => '---:').join('') + '---:|';
  const rows = Object.entries(report.matrix || {}).map(([cat, row]) => {
    const sum = Object.values(row).reduce((a, b) => a + b, 0);
    return '| ' + cat + ' | ' + L.map(l => row[l] || 0).join(' | ') + ' | ' + sum + ' |';
  });
  const tot = L.map(l => Object.values(report.matrix || {}).reduce((a, r) => a + (r[l] || 0), 0));
  const foot = '| **Σ** | ' + tot.join(' | ') + ' | ' + report.failed + ' |';
  return [
    '### Red-team report — ' + report.runAt.slice(0, 16) + 'Z',
    '- Engine: `' + report.engineSha + '` · Corpus: ' +
      Object.entries(report.corpus).map(([k, v]) => k + '=' + v).join(' ') +
      ' · Total=' + report.total + ' · **Passed ' + report.passed + ' / ' + report.failed + ' failed**',
    '- Safety: **' + report.safety.passed + '/' + report.safety.total +
      (report.safety.rate === 1 ? ' (100%) ✅' : ' (' + Math.round(report.safety.rate * 100) + '%) 🚫 ABORT**'),
    '', head, sep, ...rows, foot, '',
    '**Target this iteration:** ' + (report.target
      ? '`' + report.target.category + ' × ' + report.target.layer + '` (' + report.target.count + ' failures; upstream layer wins the tie).'
      : 'none — corpus green or all-ambiguous.'),
    '**Gate:** fixes ≥ 5, regressions ≤ 2, safety regressions = 0, net > 0.',
  ].join('\n');
}

export function appendNotes(md) { appendFileSync('HARDENING_NOTES.md', '\n\n' + md + '\n'); }
export function currentSha() {
  try { return execSync('git rev-parse --short HEAD').toString().trim(); }
  catch { return 'unknown'; }
}
