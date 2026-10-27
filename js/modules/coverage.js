// coverage.js — P-111: the home quick-try chips derive from registry coverage,
// not a hardcoded list. Pure function, deterministic: same registry + same
// recipe set → the same chips and the same pre-tapped trio, always.

/**
 * @param {Array} ingredients  registry items (data/ingredients.json)
 * @param {Array} recipes       recipe library (data/recipes.json)
 * @returns {{ chips: Array, trio: string[] }}
 *   chips — the N ingredients that appear in the most recipes (registry
 *           coverage), alphabetical tie-break;
 *   trio  — a greedy set-cover of 3 chips that unlocks the most recipes,
 *           restricted to the chips on screen so the pre-selection is
 *           always visible. These are pre-tapped for the visitor.
 */
export function quickTryPicks(ingredients, recipes, { chipsN = 8, trioN = 3, minTier = 0 } = {}) {
  const freq = new Map();
  for (const r of recipes) for (const line of r.ingredients || []) {
    freq.set(line.id, (freq.get(line.id) || 0) + 1);
  }
  // Staples (tier ≤ minTier) are ASSUMED by the matching engine — "never
  // counted against you" — so tapping them moves nothing. They're excluded
  // from the chips so every tap is a real coverage decision.
  const ranked = ingredients
    .filter(i => freq.has(i.id) && i.tier > minTier)
    .sort((a, b) => (freq.get(b.id) || 0) - (freq.get(a.id) || 0)
      || a.name.localeCompare(b.name)
      || a.id.localeCompare(b.id));
  const chips = ranked.slice(0, chipsN);

  const covered = new Set();
  const trio = [];
  for (let k = 0; k < trioN; k++) {
    let best = null, bestGain = -1;
    for (const c of chips) {
      if (trio.includes(c.id)) continue;
      let gain = 0;
      for (const r of recipes) {
        if (covered.has(r.id)) continue;
        if (r.ingredients.some(l => l.id === c.id)) gain++;
      }
      if (gain > bestGain) { bestGain = gain; best = c.id; }   // first max wins → deterministic
    }
    if (best === null) break;
    trio.push(best);
    for (const r of recipes) {
      if (r.ingredients.some(l => l.id === best)) covered.add(r.id);
    }
  }
  return { chips, trio };
}
