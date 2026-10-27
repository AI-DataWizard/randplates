// scripts/lib/safety.mjs — P-443: the safety set. THE LAW: nothing vague
// auto-saves. A fixture is SAFETY when its expectation is "zero auto-save"
// (review queue / ignored / vague) — the product floor per P-432 §5.
export const SAFETY_CATEGORIES = new Set(['D', 'H', 'SQ', 'vague', 'nonsense', 'vague-equiv']);

/** v1: categories D (instructions/nutrition never ingredient) + H
 *  (vague-equivalents, zero auto-save) + the A05 vague-quantifier case.
 *  v2: any REVIEW_QUEUE/IGNORED expectation. v3: category in the set. */
export function isSafetyFixture(fx) {
  if (fx.corpus === 'v1') return fx.category === 'D' || fx.category === 'H' || fx.id === 'A05';
  if (fx.corpus === 'v2') return fx.kind === 'line' && /^(REVIEW_QUEUE|IGNORED)/.test(fx.expected);
  return SAFETY_CATEGORIES.has(fx.category);
}
