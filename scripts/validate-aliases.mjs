#!/usr/bin/env node
// RandPlates vernacular-alias validator — deterministic, no LLM involvement.
// P-105 pipeline: structure checks + junk heuristic. Authenticity is NOT
// verifiable here — low-confidence and suspicious terms go to human review.
// Usage: node scripts/validate-aliases.mjs <aliases-batch.json> <registry.json> [output-prefix]
import fs from 'fs';

const LANGS = ['zulu','xhosa','sesotho','afrikaans'];
const CONFS = ['high','medium','low'];
const JUNK_RE = /(.)\1\1/;          // triple repeated char ("eiee")
const PREFIX_JUNK = /^(i-|ama-|di-|u-)/; // loanword morphology is legit; kept, but flagged below only if paired with junk

const inPath = process.argv[2], regPath = process.argv[3];
const outPrefix = process.argv[4] || inPath.replace(/-raw\.json$/, '');
const rows = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const regIds = new Set(JSON.parse(fs.readFileSync(regPath, 'utf8')).map(r => r.id));

const staged = [], quarantined = [], lowConf = [], suspicious = [];
let terms = 0;

for (const [i, row] of rows.entries()) {
  if (!regIds.has(row.id)) { quarantined.push({ row: i, id: row.id, reasons: ['unknown-id'] }); continue; }
  if (!Array.isArray(row.terms) || row.terms.length === 0) { quarantined.push({ row: i, id: row.id, reasons: ['no-terms'] }); continue; }
  const clean = [];
  const seen = new Set();
  for (const t of row.terms) {
    const reasons = [];
    if (!t.term || typeof t.term !== 'string' || t.term.length < 2) reasons.push('bad-term');
    if (t.term && JUNK_RE.test(t.term.replace(/\s/g,''))) reasons.push('junk-chars');
    if (!LANGS.includes(t.lang)) reasons.push(`bad-lang:${t.lang}`);
    if (!CONFS.includes(t.confidence)) reasons.push(`bad-confidence:${t.confidence}`);
    if (reasons.length) { quarantined.push({ row: i, id: row.id, term: t.term, reasons }); continue; }
    const key = `${t.term}|${t.lang}`;
    if (seen.has(key)) continue; // exact dup within item
    seen.add(key);
    terms++;
    if (t.confidence === 'low') { lowConf.push({ id: row.id, ...t }); continue; }
    if (reasons.length === 0 && JUNK_RE.test(t.term)) { suspicious.push({ id: row.id, ...t }); continue; }
    clean.push(t);
  }
  staged.push({ id: row.id, terms: clean });
}

fs.writeFileSync(outPrefix + '-staged.json', JSON.stringify(staged, null, 2));
fs.writeFileSync(outPrefix + '-quarantine.json', JSON.stringify(quarantined, null, 2));
fs.writeFileSync(outPrefix + '-review.json', JSON.stringify({ low_confidence: lowConf, suspicious }, null, 2));
console.log(`${inPath}: ${rows.length} items | clean terms: ${staged.reduce((a,r)=>a+r.terms.length,0)} | low-conf: ${lowConf.length} | suspicious: ${suspicious.length} | quarantined: ${quarantined.length}`);
quarantined.forEach(q => console.log(`  QUARANTINE ${q.id || 'row ' + q.row}: ${(q.reasons||[]).join(', ')}${q.term ? ' [' + q.term + ']' : ''}`));
