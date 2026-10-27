// matchFilters.js — P-539 matcher view-filter layer, PURE: no DOM, no store.
// Extracted from main.js so the filter semantics, facet counts and the
// dead-end ("clear one filter to see N more") honesty can be fixture-tested
// in the node wall like every other engine module.
//
// A scored row here is exactly what the matcher engine produced:
//   { recipeId, tags, servings, perPlateCents, matchPct, readiness, missing[],
//     eligible, timeMinutes, __srch (search annotation, optional) }
// Filter state m is the store's matcher slice:
//   { plateMaxCents, tier, maxMissing, tagFilter[], favouritesOnly,
//     ingredientFocus, search, minCoverage, minFeeds }
// (dietary + maxTimeMin are ENGINE constraints — they change eligibility and
//  re-score; they never appear in view filtering, only in chip counts.)
//
// P-539 doctrine: filters are view-layer, never dead-ends. Every chip carries
// a live count, and every active filter knows how many recipes it hides.

/** One row's pass/fail against the FULL view-filter state. */
export function passesFilters(r, m, helpers = {}) {
  return (!m.plateMaxCents || r.perPlateCents <= m.plateMaxCents)
    && (m.tier === 'all' || r.readiness === m.tier)
    && (m.maxMissing === null || m.maxMissing === undefined || r.missing.length <= m.maxMissing)
    && (m.tagFilter || []).every(t => r.tags.includes(t))
    && (!m.favouritesOnly || (m.favouriteIds || []).includes(r.recipeId))
    && (!m.ingredientFocus || (helpers.usesIngredient ? helpers.usesIngredient(r.recipeId, m.ingredientFocus) : true))
    && (!m.search || !!r.__srch)                       // P-537: search ANDs with every filter
    && (!m.minCoverage || r.matchPct >= m.minCoverage) // P-539: "I already have most of it"
    && (!m.minFeeds || r.servings >= m.minFeeds);      // P-539: feeds N+
}

/** Facet count: how many eligible recipes match if THIS patch were applied. */
export function countFor(eligible, m, patch, helpers = {}) {
  const merged = { ...m, ...patch };
  return eligible.filter(r => passesFilters(r, merged, helpers)).length;
}

/** Human labels for the dead-end advice — one per clearable dimension. */
export const FILTER_DEFS = {
  plateMaxCents: { label: 'price cap', clear: { plateMaxCents: null } },
  tier:          { label: 'readiness', clear: { tier: 'all' } },
  maxMissing:    { label: 'shopping limit', clear: { maxMissing: null } },
  tagFilter:     { label: 'tag filter', clear: { tagFilter: [] } },
  favouritesOnly:{ label: 'favourites only', clear: { favouritesOnly: false } },
  ingredientFocus:{ label: 'ingredient focus', clear: { ingredientFocus: null } },
  search:        { label: 'search', clear: { search: '' } },
  minCoverage:   { label: 'coverage floor', clear: { minCoverage: null } },
  minFeeds:      { label: 'feeds floor', clear: { minFeeds: null } },
  maxTimeMin:    { label: 'time cap', clear: { maxTimeMin: null } },
  dietary:       { label: 'diet', clear: { dietary: null } },
};

/** Which single-filter clears would reveal the most? Returns advice entries
 *  sorted by unlock size, only for dimensions the user actually set. Pure —
 *  the caller decides how to word/surface it ("clear X to see N more"). */
export function deadEndAdvice(m, eligible, helpers = {}) {
  const out = [];
  const activeDims = Object.keys(FILTER_DEFS).filter(k => {
    const v = m[k];
    return v !== null && v !== undefined && v !== false && !(Array.isArray(v) && v.length === 0)
      && v !== '' && v !== 'all';
  });
  for (const k of activeDims) {
    // counts with EVERYTHING as-is except this one dimension cleared
    const wouldShow = countFor(eligible, m, FILTER_DEFS[k].clear, helpers);
    const now = countFor(eligible, m, {}, helpers);
    if (wouldShow > now) out.push({ dim: k, label: FILTER_DEFS[k].label, clear: FILTER_DEFS[k].clear, now, wouldShow });
  }
  return out.sort((a, b) => b.wouldShow - a.wouldShow);
}
