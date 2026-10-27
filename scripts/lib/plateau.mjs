// scripts/lib/plateau.mjs — P-443: diminishing-returns tracker per P-432 §4.
// Plateau = two consecutive iterations with net/totalCorpus < 1%.
import { readFileSync, existsSync, appendFileSync } from 'node:fs';

const P = 'tests/redteam/plateau.jsonl';
export function record(entry) { appendFileSync(P, JSON.stringify(entry) + '\n'); return entry; }
export function history() {
  if (!existsSync(P)) return [];
  return readFileSync(P, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}
export function isPlateau(totalCorpus, h = history()) {
  const lastTwo = h.slice(-2);
  if (lastTwo.length < 2) return false;
  return lastTwo.every(x => (x.net / totalCorpus) < 0.01);
}
