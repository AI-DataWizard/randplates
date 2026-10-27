// determinism-tests.js — P-208: the byte-identical determinism lock.
// Same idea as golden-tests.js but at FULL scale: 150-item synthetic pantry
// (LCG seed 42 — same generator as scripts/regen-golden.mjs) x the entire
// 179-recipe set, serialized field-by-field and compared byte-for-byte against
// tests/golden/determinism.json. Any drift = red build. Regen ONLY via
// scripts/regen-golden.mjs; review the diff before committing.
//
// P-207 BATCH 2 SLOT: adversarial scenarios from DeepSeek batch 2 (cross-module
// seams) get absorbed into tests/matcher-tests.js suite 'redteam2' once the
// owner's red-team table is audited — NOT here. This file stays pure drift-detection.
import { rankRecipes } from '../js/modules/matcher.js';
import { defaultPrice } from '../js/modules/costing.js';

const isNode = typeof process !== 'undefined' && !!process.versions?.node;
const readJSON = async (rel) => {
  const url = new URL(rel, import.meta.url);
  if (isNode) {
    const { readFileSync } = await import('node:fs');
    return JSON.parse(readFileSync(url));
  }
  return (await fetch(url)).json();
};
const ing = (await readJSON('../data/ingredients.json')).items;
const rec = (await readJSON('../data/recipes.json')).recipes;
const pri = (await readJSON('../data/prices.json')).entries;
const det = await readJSON('./golden/determinism.json');

const priceMap = {};
for (const e of pri) (priceMap[e.ingredient_id] ||= []).push(e);
const priceOf = (id) => defaultPrice(id, priceMap[id] || []);

// EXACT replica of the generator in scripts/regen-golden.mjs — byte-identity
// starts with identical inputs: same LCG, same stride, same rounding.
function lcg(seed = 42) {
  let s = seed >>> 0;
  return () => (s = (1103515245 * s + 12345) >>> 0) / 2 ** 32;
}
function synthPantry(ingredients, n = 150, seed = 42) {
  const rnd = lcg(seed);
  const stride = Math.max(1, Math.floor(ingredients.length / n));
  return ingredients.filter((_, i) => i % stride === 0).slice(0, n).map((meta) => {
    const f = 0.1 + rnd() * 2.9;
    return { id: meta.id, qty: Math.round(meta.unit_basis.qty * f * 100) / 100, unit: meta.unit_basis.unit, running_low: false };
  });
}

const results = [];
function T(name, fn) {
  try { fn(); results.push({ suite: 'determinism', name, ok: true }); }
  catch (e) { results.push({ suite: 'determinism', name, ok: false, err: String(e.message || e) }); }
}
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || 'drift'}\n  got:  ${String(a).slice(0, 300)}\n  want: ${String(b).slice(0, 300)}`); };

T('fixture shape: 150 pantry items x 179 recipes at R600 budget', () => {
  eq(det.pantry_count, 150, 'pantry_count');
  eq(det.recipe_count, 179, 'recipe_count');
  eq(det.budget_cents, 60000, 'budget_cents');
});

T('FULL-SCALE DETERMINISM LOCK: byte-identical ranked output vs fixture', () => {
  const pantry = synthPantry(ing, 150, 42);
  const ranked = rankRecipes(rec, {
    pantry, ingredients: ing, priceOf,
    remainingBudgetCents: det.budget_cents, constraints: {},
    recentCookIds: [], favouriteIds: [], mealIntent: null, mealStrict: false,
  });
  eq(ranked.length, det.results.length, 'result count');
  // compare the exact fixed field shape the fixture stores, in order
  const shape = (r) => JSON.stringify({
    recipeId: r.recipeId, eligible: r.eligible, score: r.score, readiness: r.readiness,
    coverage: r.coverage, matchPct: r.matchPct, heroCovered: r.heroCovered,
    missingCostCents: r.missingCostCents, totalCostCents: r.totalCostCents,
    perPlateCents: r.perPlateCents, ownedCount: r.ownedCount, realCount: r.realCount,
    freshnessBonus: r.freshnessBonus, timeBonus: r.timeBonus, heroBonus: r.heroBonus,
    substanceBonus: r.substanceBonus, thinPenalty: r.thinPenalty,
    intentBonus: r.intentBonus, varietyAdj: r.varietyAdj, reasons: r.reasons,
  });
  for (let i = 0; i < ranked.length; i++) {
    if (shape(ranked[i]) !== JSON.stringify(det.results[i])) {
      throw new Error(`drift at rank ${i}: ${ranked[i].recipeId}\n  got:  ${shape(ranked[i]).slice(0, 300)}\n  want: ${JSON.stringify(det.results[i]).slice(0, 300)}`);
    }
  }
});

T('determinism across two consecutive in-process runs (same bytes twice)', () => {
  const one = JSON.stringify(rankRecipes(rec, { pantry: synthPantry(ing, 150, 42), ingredients: ing, priceOf, remainingBudgetCents: det.budget_cents, constraints: {} }).map(r => [r.recipeId, r.score, r.perPlateCents]));
  const two = JSON.stringify(rankRecipes(rec, { pantry: synthPantry(ing, 150, 42), ingredients: ing, priceOf, remainingBudgetCents: det.budget_cents, constraints: {} }).map(r => [r.recipeId, r.score, r.perPlateCents]));
  eq(one, two, 'two runs differ');
});

export async function run() { return results; }
