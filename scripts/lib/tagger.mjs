// scripts/lib/tagger.mjs — P-443: responsible-layer inference per P-432 §1.2.
// Priority list, specific-first; explicit fixture tags always win. An
// ambiguous inference (2+ signals, no tag) goes to the `ambiguous` bucket —
// an ambiguous fixture is a corpus bug, not a rule bug.
const SUSPICIOUS = /[\u200B-\u200D\uFEFF\u2150-\u218F]|#[A-Za-z]|https?:\/\//;

export function inferLayer(fx, why, draft) {
  if (fx.layer) return { layer: fx.layer, ambiguous: false };
  const w = String(why || '');
  const signals = [];
  if (/recipes|multi/i.test(w) || (fx.kind === 'v3' && 'recipes' in fx.expected)) signals.push('multi');
  if (/qty_canon|unit_canon|canon/i.test(w)) signals.push('canon');
  if (/qty=|unit=|qtys|numeric/i.test(w)) signals.push('quantity');
  if (/steps?|ingredient|ingCount|title|serveWith/i.test(w)) signals.push('classifier');
  if (/reviewRequired|reasons?=|REVIEW_QUEUE|ignored/i.test(w)) signals.push('queue');
  if (SUSPICIOUS.test(fx.input) || /strip|emoji|hashtag|ZWSP|fraction/i.test(w)) signals.push('preprocess');
  const uniq = [...new Set(signals)];
  for (const l of ['multi', 'canon', 'quantity', 'classifier', 'queue', 'preprocess'])
    if (uniq.includes(l)) return { layer: l, ambiguous: uniq.length > 1 };
  return { layer: 'preprocess', ambiguous: false };
}
