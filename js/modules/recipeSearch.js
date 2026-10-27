/* ============================================================================
 * RECIPE SEARCH (P-537) — the matcher's search bar. Pure + node-testable.
 * Index is PRECOMPUTED once per data load (never per keystroke): accent-folded
 * via the shared search.js normalize, alias-merged (recipe title aliases when
 * P-504 lands; ingredient registry aliases now).
 *
 * Match kinds, best-wins per recipe:
 *   title      — phrase or all-words-prefix hit on the recipe title   (rank 4)
 *   alias      — hit on a recipe title alias (P-504 field)           (rank 3)
 *   ingredient — hit on any ingredient name/alias                    (rank 2)
 *   tag        — hit on a tag ("budget", "vegetarian", …)            (rank 1)
 *
 * Ingredient matches report WHICH ingredient matched, so the UI can rank
 * those recipes by how much of them the user already has (pantry share).
 * ========================================================================== */
import { normalize } from './search.js';

/** All tokens appear as word-prefixes somewhere in the hay
 *  ("pap maize" → "maize meal pap with…"). */
function allTokenHits(hay, tokens) {
  if (!tokens.length) return false;
  return tokens.every(t => hay.includes(t));   // hay is already normalized + space-joined
}

export function buildRecipeIndex(recipes, metaOf) {
  const index = new Map();
  for (const r of recipes || []) {
    const ings = [];
    for (const line of r.ingredients || []) {
      const meta = metaOf?.(line.id);
      if (!meta) continue;
      const names = [meta.name, ...(meta.aliases || [])];
      ings.push({ id: line.id, hay: names.map(normalize).join(' ') });
    }
    const aliases = (r.title_aliases || r.aliases || []).map(normalize);
    index.set(r.id, {
      id: r.id,
      title: normalize(r.title),
      aliasHay: aliases.join(' '),
      ings,
      tagHay: ' ' + (r.tags || []).map(normalize).join(' ') + ' ',
    });
  }
  return index;
}

/** Query → Map(recipeId → { kind, rank, matchedIngredient }).
 *  Empty/blank query → null (no filter). Deterministic: same index + query,
 *  same map, byte for byte. */
export function searchRecipes(index, query) {
  const q = normalize(query);
  if (!q) return null;
  const tokens = q.split(' ').filter(Boolean);
  const phrase = tokens.length > 1;
  const hits = new Map();
  for (const e of index.values()) {
    let hit = null;
    const phraseHit = hay => hay.includes(q);
    const tokenHit = hay => tokens.every(t => hay.includes(t));
    // title: phrase first, then all-words
    if (e.title.includes(q) || (phrase && allTokenHits(e.title, tokens)) || (!phrase && tokenHit(e.title))) {
      hit = { kind: 'title', rank: 4 };
    } else if (e.aliasHay && (e.aliasHay.includes(q) || (!phrase && tokenHit(e.aliasHay)))) {
      hit = { kind: 'alias', rank: 3 };
    } else {
      for (const ing of e.ings) {
        if (ing.hay.includes(q) || (!phrase && allTokenHits(ing.hay, tokens))) {
          hit = { kind: 'ingredient', rank: 2, matchedIngredient: ing.id };
          break;
        }
      }
      if (!hit && e.tagHay.includes(' ' + q + ' ')) hit = { kind: 'tag', rank: 1 };
    }
    if (hit) hits.set(e.id, hit);
  }
  return hits;
}
