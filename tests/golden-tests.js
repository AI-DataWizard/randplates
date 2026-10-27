// golden-tests.js — P-104R Day 4: the matcher determinism lock.
// Recomputes the 10 fixture pantries through the live engine and compares
// against tests/golden/matcher-golden.json (regen ONLY via scripts/regen-golden.mjs).
// Any drift here means data or algorithm changed — regenerate deliberately and
// review the diff, never silence the test.
import { rankRecipes } from "../js/modules/matcher.js";
import { defaultPrice } from "../js/modules/costing.js";

// P-111 fix: same node/browser-safe loader as data-tests.js — top-level fs
// imports aborted the whole browser suite on tests.html.
const isNode = typeof process !== "undefined" && !!process.versions?.node;
const readJSON = async (rel) => {
  const url = new URL(rel, import.meta.url);
  if (isNode) {
    const { readFileSync } = await import("node:fs");
    return JSON.parse(readFileSync(url));
  }
  return (await fetch(url)).json();
};
const ing = (await readJSON("../data/ingredients.json")).items;
const rec = (await readJSON("../data/recipes.json")).recipes;
const pri = (await readJSON("../data/prices.json")).entries;
const golden = await readJSON("./golden/matcher-golden.json");
const fixtures = (await readJSON("./golden/pantries.json")).pantries;

const priceMap = {};
for (const e of pri) (priceMap[e.ingredient_id] ||= []).push(e);
const priceOf = (id) => defaultPrice(id, priceMap[id] || []);

const results = [];
function T(name, fn) {
  try {
    fn();
    results.push({ suite: "golden", name, ok: true });
  } catch (e) {
    results.push({
      suite: "golden",
      name,
      ok: false,
      err: String(e.message || e),
    });
  }
}
const eq = (a, b, m) => {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(
      `${m || "golden drift"}\n  got:  ${JSON.stringify(a).slice(0, 300)}\n  want: ${JSON.stringify(b).slice(0, 300)}`,
    );
};

function compute(fixture) {
  const results = rankRecipes(rec, {
    pantry: fixture.pantry,
    ingredients: ing,
    priceOf,
    remainingBudgetCents: golden.budget_cents,
    constraints: {},
  });
  return {
    name: fixture.name,
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
}

T(
  "golden file matches fixtures one-to-one (same 10 pantries, same order)",
  () => {
    eq(
      golden.pantries.map((p) => p.name),
      fixtures.map((f) => f.name),
      "fixture/golden pantry lists differ",
    );
  },
);

T(
  "GOLDEN LOCK: all 10 fixture pantries reproduce their expected matches + costs",
  () => {
    for (const fixture of fixtures) {
      const want = golden.pantries.find((g) => g.name === fixture.name);
      if (!want) throw new Error(`no golden entry for ${fixture.name}`);
      eq(compute(fixture), want, `${fixture.name} drifted from golden`);
    }
  },
);

T("golden lock is deterministic: two runs agree byte-for-byte", () => {
  for (const fixture of fixtures.slice(0, 3)) {
    eq(
      compute(fixture),
      compute(fixture),
      `${fixture.name}: engine is not deterministic`,
    );
  }
});

T("empty pantry still ranks by score (no crash, no NaN scores)", () => {
  const empty = fixtures.find((f) => f.name === "empty");
  const top = compute(empty).top;
  if (top.length !== 20)
    throw new Error("empty pantry should still produce 20 ranked matches");
  for (const t of top) {
    if (!Number.isFinite(t.score) || !Number.isFinite(t.perPlateCents))
      throw new Error(`NaN in empty-pantry ranking: ${JSON.stringify(t)}`);
  }
});

T(
  "weekday-30 ranks recipes that USE the pantry higher than unrelated ones",
  () => {
    // sanity signal beyond the byte-lock: a pantry-aware ranker puts pantry-backed
    // recipes above orphan recipes — verify the top-10 average coverage beats the top-20 tail
    const wk = golden.pantries.find((p) => p.name === "weekday-30");
    const head = wk.top.slice(0, 10).map((t) => t.coverage);
    const tail = wk.top.slice(10, 20).map((t) => t.coverage);
    const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    if (avg(head) < avg(tail))
      throw new Error("ranking is not pantry-aware: tail coverage beats head");
  },
);

export async function run() {
  return results;
}
