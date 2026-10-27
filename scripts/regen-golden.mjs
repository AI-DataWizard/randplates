#!/usr/bin/env node
// Regen the matcher golden file (P-104R Day 4) and determinism fixture (P-208).
// Run ONLY after a deliberate data or algorithm change; the diff must be human-reviewed before commit.
// Protocol: prices refresh weekly -> costs drift -> regen + review diff +
// commit together with the price update. Golden is the determinism lock:
// same inputs must always produce the same outputs.
import fs from "fs";
import { rankRecipes } from "../js/modules/matcher.js";
import { defaultPrice } from "../js/modules/costing.js";

const root = new URL("..", import.meta.url).pathname;
const ing = JSON.parse(fs.readFileSync(root + "data/ingredients.json")).items;
const rec = JSON.parse(fs.readFileSync(root + "data/recipes.json")).recipes;
const pri = JSON.parse(fs.readFileSync(root + "data/prices.json")).entries;
const priceMap = {};
for (const e of pri) (priceMap[e.ingredient_id] ||= []).push(e);
const priceOf = (id) => defaultPrice(id, priceMap[id] || []);
const fixtures = JSON.parse(
  fs.readFileSync(root + "tests/golden/pantries.json"),
).pantries;

const ids = new Set(ing.map((i) => i.id));
for (const f of fixtures)
  for (const i of f.pantry)
    if (!ids.has(i.id)) {
      console.error(`unknown id ${i.id} in fixture ${f.name}`);
      process.exit(1);
    }

const BUDGET = 60000; // R600/week fixture budget
const golden = {
  note: "Determinism lock for the matcher+costing engine. Regenerate ONLY via scripts/regen-golden.mjs after a deliberate change; review the diff before committing.",
  prices_last_verified: pri.reduce(
    (m, e) => (e.last_verified > m ? e.last_verified : m),
    "",
  ),
  budget_cents: BUDGET,
  pantries: fixtures.map((f) => {
    const results = rankRecipes(rec, {
      pantry: f.pantry,
      ingredients: ing,
      priceOf,
      remainingBudgetCents: BUDGET,
      constraints: {},
    });
    return {
      name: f.name,
      eligible_count: results.filter((r) => r.eligible).length,
      top: results
        .filter((r) => r.eligible)
        .slice(0, 20)
        .map((r) => ({
          id: r.recipeId,
          readiness: r.readiness,
          perPlateCents: r.perPlateCents,
          score: r.score,
          coverage: r.coverage,
        })),
    };
  }),
};
fs.writeFileSync(
  root + "tests/golden/matcher-golden.json",
  JSON.stringify(golden, null, 2) + "\n",
);
console.log(
  "golden written:",
  golden.pantries.map((p) => `${p.name}=${p.eligible_count}`).join(" "),
);

// P-208: Determinism fixture (150-item synthetic pantry x 179 recipes)
function lcg(seed = 42) {
  let s = seed >>> 0;
  return () => (s = (1103515245 * s + 12345) >>> 0) / 2 ** 32;
}

function synthPantry(ingredients, n = 150, seed = 42) {
  const rnd = lcg(seed);
  const stride = Math.max(1, Math.floor(ingredients.length / n));
  return ingredients
    .filter((_, i) => i % stride === 0)
    .slice(0, n)
    .map((meta) => {
      const f = 0.1 + rnd() * 2.9;
      return {
        id: meta.id,
        qty: Math.round(meta.unit_basis.qty * f * 100) / 100,
        unit: meta.unit_basis.unit,
        running_low: false,
      };
    });
}

const synthP = synthPantry(ing, 150, 42);
const detRanked = rankRecipes(rec, {
  pantry: synthP,
  ingredients: ing,
  priceOf,
  remainingBudgetCents: BUDGET,
  constraints: {},
  recentCookIds: [],
  favouriteIds: [],
  mealIntent: null,
  mealStrict: false,
});

const detGolden = {
  note: "RandPlates P-208 golden determinism fixture. Generated from 150-item synthetic pantry (LCG seed 42) x 179 recipes. Regenerate ONLY via scripts/regen-golden.mjs.",
  seed: 42,
  pantry_count: synthP.length,
  recipe_count: rec.length,
  budget_cents: BUDGET,
  results: detRanked.map((r) => ({
    recipeId: r.recipeId,
    eligible: r.eligible,
    score: r.score,
    readiness: r.readiness,
    coverage: r.coverage,
    matchPct: r.matchPct,
    heroCovered: r.heroCovered,
    missingCostCents: r.missingCostCents,
    totalCostCents: r.totalCostCents,
    perPlateCents: r.perPlateCents,
    ownedCount: r.ownedCount,
    realCount: r.realCount,
    freshnessBonus: r.freshnessBonus,
    timeBonus: r.timeBonus,
    heroBonus: r.heroBonus,
    substanceBonus: r.substanceBonus,
    thinPenalty: r.thinPenalty,
    intentBonus: r.intentBonus,
    varietyAdj: r.varietyAdj,
    reasons: r.reasons,
  })),
};
fs.writeFileSync(
  root + "tests/golden/determinism.json",
  JSON.stringify(detGolden, null, 2) + "\n",
);
console.log(
  "determinism fixture written:",
  detGolden.results.length,
  "recipes",
);
