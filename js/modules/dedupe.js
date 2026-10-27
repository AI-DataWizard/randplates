// dedupe.js — deterministic decoded-recipe similarity (P-427 findings, absorbed as P-440).
// Pure functions: no Date, no Math.random, no locale APIs, no fetch, no IDB.
// The registry resolver is INJECTED (isIngredientWord) so the module stays pure
// and testable. Advisory only — it asks, never blocks. The gate is law elsewhere.

const STOP_WORDS = new Set(['a','an','and','with','the','of','in','on','for','my','our',
  'easy','quick','simple','best','homemade','recipe','lekker','delicious','tasty',
  'ultimate','perfect']);

const NICKNAME_PAREN = /^(?:(?:my|our)\s+)?(?:version|way|style|remake|copy|again|final|v\d+|part\s*\d+|no\.?\s*\d+)$/i;

/** Ordered normalization: diacritics → zero-width → URLs → mentions → emoji →
 *  & → paren unwrap (nicknames die, real content survives) → serving suffix →
 *  lowercase punctuation strip → whitespace collapse. */
export function normalizeTitle(raw) {
  if (!raw) return '';
  let s = raw.normalize('NFKD').replace(/\p{M}/gu, '');
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, '');
  s = s.replace(/https?:\/\/\S+|www\.\S+/gi, ' ');
  s = s.replace(/[@#]\w+/g, ' ');
  s = s.replace(/\p{Extended_Pictographic}/gu, ' ');
  s = s.replace(/&/g, ' and ');
  s = s.replace(/\(([^)]*)\)/g, (_, inner) => NICKNAME_PAREN.test(inner.trim()) ? ' ' : ` ${inner} `);
  s = s.replace(/\b(?:serves?|servings?|makes|for)\s*\d+\s*(?:people|ppl|portions?)?\b/g, ' ');
  s = s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ');
  // P-440 ruling: STOP words leave the TITLE too, not just the tokens —
  // "Lekker Chicken Curry" === "Chicken Curry (again)" for dupe purposes
  // (D03 expectation requires it; normTitle only feeds equality checks).
  s = s.split(' ').filter(w => w && !STOP_WORDS.has(w)).join(' ');
  return s.replace(/\s+/g, ' ').trim();
}

/** jaccard of two arrays (treated as sets) */
function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union ? inter / union : 1;
}

/** Prepare a recipe/draft into its dedupe record (written once on save).
 *  isIngredientWord: injected registry lookup (plural-folded alias test). */
export function prepareRecipe(rec, isIngredientWord = () => false) {
  const normTitle = normalizeTitle(rec.title || '');
  const titleTokens = normTitle.split(' ').filter(w =>
    w && !STOP_WORDS.has(w) && !/^\d+$/.test(w) && !isIngredientWord(w));
  const ids = [...new Set((rec.ingredientIds || rec.ids ||
    (rec.ingredients || []).map(i => i.id || i.resolvedId).filter(Boolean)))]
    .filter(id => !['salt', 'pepper', 'water'].includes(id));
  const total = (rec.ingredients || []).length || ids.length;
  return { normTitle, titleTokens, ids, stepCount: (rec.steps || []).length,
    coverage: total ? Math.min(1, ids.length / total) : 0 };
}

/** Signal-level pair scoring (P-427 §5). millis comparison at boundaries. */
export function scorePair(draft, cand) {
  const titleSim =
    draft.normTitle && draft.normTitle === cand.normTitle ? 1
    : (draft.titleTokens.length === 0 && cand.titleTokens.length === 0) ? 0.5
    : jaccard(draft.titleTokens, cand.titleTokens);
  const ingSim = (draft.ids.length && cand.ids.length) ? jaccard(draft.ids, cand.ids) : null;
  const stepSim = (draft.stepCount >= 2 && cand.stepCount >= 2)
    ? 1 - Math.abs(draft.stepCount - cand.stepCount) / Math.max(draft.stepCount, cand.stepCount)
    : null;
  const parts = [[30, titleSim], [60, ingSim], [10, stepSim]].filter(([, v]) => v !== null);
  let s = parts.reduce((a, [w, v]) => a + w * v, 0) / parts.reduce((a, [w]) => a + w, 0);
  if (ingSim !== null && ingSim >= 0.90) s = Math.max(s, 0.75);                    // F1
  if (titleSim === 1 && ingSim !== null && ingSim >= 0.60) s = Math.max(s, 0.75);  // F2
  if (ingSim === null || (draft.coverage ?? 1) < 0.60) s = Math.min(s, 0.89);      // F3
  return { millis: Math.round(s * 1000), signals: { titleSim, ingSim, stepSim } };
}

/** Top candidates over prepared records. Deterministic order:
 *  score desc → title → id. Returns at most 3, tier auto/ask only. */
export function findDuplicates(draftRec, candRecords, dismissed = null) {
  const out = [];
  for (const r of candRecords) {
    if (dismissed && dismissed(draftRec, r)) continue;
    const { millis, signals } = scorePair(draftRec, r);
    if (millis >= 750) out.push({ id: r.id, title: r.title, normTitle: r.normTitle,
      millis, signals, score: millis / 1000, tier: millis >= 900 ? 'auto' : 'ask' });
  }
  out.sort((a, b) => b.millis - a.millis
    || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0)
    || (a.id < b.id ? -1 : 1));
  return out.slice(0, 3);
}
