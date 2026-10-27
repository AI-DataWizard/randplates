// search.js — accent-insensitive, deterministic ingredient search (PRD §7.2, P-111).
// Pure functions only: same query + same registry → same result, byte for byte.

/**
 * Normalize a string for matching: lowercase, strip accents/diacritics,
 * collapse whitespace, trim. "Pilchards in brīne" → "pilchards in brine".
 */
export function normalize(str) {
  return (
    String(str ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "") // strip combining diacritics
      .toLowerCase()
      .replace(/\s+/g, " ")
      // P-515: strip edge noise decoration ("oil!", "flour*", "vinegar?") —
      // matches the decoder doctrine: decoration never reaches the resolver.
      .replace(/^[!?,.;:*]+|[!?,.;:*]+$/g, "")
      .trim()
  );
}

/**
 * Tokenize a normalized string for word-level matching.
 */
export function tokenize(str) {
  return normalize(str).split(" ").filter(Boolean);
}

/**
 * Does the query match the candidate? Accent-insensitive, word-prefix aware.
 * "pap" matches "maize meal pap"; "miel" matches "mielie meal".
 */
export function matches(query, candidate) {
  const q = normalize(query);
  if (!q) return true;
  const c = normalize(candidate);
  return c.includes(q);
}

/* ---------------------------------------------------------------------------
 * P-111 RANK TIERS — strict, deterministic ordering.
 *
 *   9  name exact          "eggs" → Eggs
 *   8  alias exact         "pap" → Maize meal (the vernacular moat: an exact
 *                              street alias outranks a mere name-prefix, so
 *                              "pap" finds maize meal BEFORE Paprika)
 *   7  name prefix         "pap" → Paprika
 *   6  name contains
 *   5  alias prefix
 *   4  alias contains  |  1-edit misspelling of the name
 *   3  1-edit misspelling of an alias
 *   2  category (aisle) word
 *
 * Ranker sanity (P-111): exact-name > alias > category-word holds at the
 * extremes; alias-exact deliberately sits above name-prefix/contains because
 * the registry's aliases ARE the product promise (see the "pap" example).
 * ------------------------------------------------------------------------- */
const TIER = {
  NAME_EXACT: 9,
  ALIAS_EXACT: 8,
  NAME_PREFIX: 7,
  NAME_CONTAINS: 6,
  ALIAS_PREFIX: 5,
  ALIAS_CONTAINS: 4,
  FUZZY_NAME: 4,
  FUZZY_ALIAS: 3,
  CATEGORY: 2,
};

/**
 * Bounded Levenshtein: is `a` within ONE edit (sub/insert/delete) of `b`?
 * O(n) scan with early exit — deliberately NOT a general fuzzy matcher
 * (PRD keeps search deterministic and cheap).
 */
export function oneEdit(a, b) {
  if (a === b) return true;
  const la = a.length,
    lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) {
    // one substitution
    let diff = 0;
    for (let i = 0; i < la; i++) {
      if (a[i] !== b[i] && ++diff > 1) return false;
    }
    return true;
  }
  const [short, long] = la < lb ? [a, b] : [b, a]; // one insert/delete
  let i = 0,
    j = 0,
    edits = 0;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i++;
      j++;
    } else if (++edits > 1) return false;
    else j++;
  }
  return true; // ≤1 trailing char left in `long` counts as that one edit
}

/** 1-edit check of a token against every word of a candidate string. */
function fuzzyWord(token, str) {
  if (token.length < 3) return false; // no fuzzy on short noise-prone words
  for (const w of tokenize(str)) {
    if (w.length < 3) continue;
    if (oneEdit(token, w)) return true;
  }
  return false;
}

/** Best tier a single token earns against one candidate string. */
function wordTier(token, cand, exactTier, prefixTier, containsTier) {
  if (cand === token) return exactTier;
  if (cand.startsWith(token)) return prefixTier; // equality already returned above
  if (cand.includes(token)) return containsTier;
  return 0;
}

/** Best tier of a whole normalized query against one item's signals. */
function scoreItem(q, tokens, item) {
  const name = normalize(item.name);
  const aliases = (item.aliases || []).map(normalize);
  const cat = normalize(item.aisle);

  // 1) full-string tiers (the common path)
  let s = wordTier(
    q,
    name,
    TIER.NAME_EXACT,
    TIER.NAME_PREFIX,
    TIER.NAME_CONTAINS,
  );
  // P-434: an EXACT alias (8) outranks a name that merely CONTAINS the query (6).
  // Before, "pilchards" resolved to the alphabetically-first variant whose NAME
  // contains the word, shadowing the item that owns the exact alias.
  if (s && s < TIER.NAME_EXACT) {
    for (const a of aliases) if (normalize(a) === q) return TIER.ALIAS_EXACT;
  }
  if (!s)
    for (const a of aliases) {
      s = Math.max(
        s,
        wordTier(
          q,
          a,
          TIER.ALIAS_EXACT,
          TIER.ALIAS_PREFIX,
          TIER.ALIAS_CONTAINS,
        ),
      );
      if (s >= TIER.ALIAS_EXACT) break;
    }
  if (s) return s;

  // 2) category (aisle) word — the floor of the ranker
  if (cat && (cat === q || cat.startsWith(q) || q.includes(cat)))
    return TIER.CATEGORY;

  // 3) token fallback — multi-word AND semantics ("pap mielie" reversed
  //    order) plus 1-edit misspellings ("mielies", "egss"). Reached only
  //    when the full string matched nothing, so it can't pollute good hits.
  let min = Infinity;
  for (const t of tokens) {
    let ts = wordTier(
      t,
      name,
      TIER.NAME_EXACT,
      TIER.NAME_PREFIX,
      TIER.NAME_CONTAINS,
    );
    if (!ts)
      for (const a of aliases) {
        ts = Math.max(
          ts,
          wordTier(
            t,
            a,
            TIER.ALIAS_EXACT,
            TIER.ALIAS_PREFIX,
            TIER.ALIAS_CONTAINS,
          ),
        );
        if (ts >= TIER.ALIAS_EXACT) break;
      }
    if (!ts && cat && (cat === t || cat.startsWith(t) || t.includes(cat)))
      ts = TIER.CATEGORY;
    if (!ts && fuzzyWord(t, name)) ts = TIER.FUZZY_NAME;
    if (!ts && aliases.some((a) => fuzzyWord(t, a))) ts = TIER.FUZZY_ALIAS;
    if (!ts) return 0; // one unmatched word kills the AND
    min = Math.min(min, ts);
  }
  return tokens.length ? min : 0;
}

/**
 * Search ingredient registry: name + aliases + aisle, accent-insensitively,
 * with 1-edit misspelling fallback. Best-first; ties break alphabetically
 * (name, then id) so ordering is fully deterministic.
 */
export function searchIngredients(query, items) {
  const q = normalize(query);
  if (!q) return [...items];
  const tokens = tokenize(q);
  const scored = [];
  for (const item of items) {
    const score = scoreItem(q, tokens, item);
    if (score > 0) scored.push({ item, score });
  }
  return scored
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.item.name.localeCompare(b.item.name) ||
        a.item.id.localeCompare(b.item.id),
    )
    .map((s) => s.item);
}
