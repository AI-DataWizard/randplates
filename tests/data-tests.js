// data-tests.js — Day 1 (P-101): data-shape scenarios for the real v1 engine data.
// Same contract as matcher-tests.js: export run() -> [{suite, name, ok, err}]
import {
  defaultPrice,
  costRecipe,
  perPlateCents,
  ingredientCostCents,
} from "../js/modules/costing.js";

// P-111 fix: fs imports killed the ENTIRE browser suite on tests.html (the
// module graph aborted before any suite could run). Same data, loaded the
// way each runtime likes: node:fs in Node, fetch in the browser.
const isNode = typeof process !== "undefined" && !!process.versions?.node;
const readJSON = async (rel) => {
  const url = new URL(rel, import.meta.url);
  if (isNode) {
    const { readFileSync } = await import("node:fs");
    return JSON.parse(readFileSync(url));
  }
  return (await fetch(url)).json();
};
const ing = await readJSON("../data/ingredients.json");
const pri = await readJSON("../data/prices.json");
const rec = await readJSON("../data/recipes.json");

const UNITS = [
  "g",
  "ml",
  "l",
  "kg",
  "tsp",
  "tbsp",
  "cup",
  "can",
  "tin",
  "slice",
  "clove",
  "unit",
  "bunch",
  "handful",
  "pinch",
];
const TAGS = [
  "budget",
  "vegetarian",
  "breakfast",
  "lunch",
  "dinner",
  "dessert",
  "snack",
  "quick",
  "family",
  "traditional",
  "student",
  "braai",
]; // braai: P-561 achievement red-team (first-braai badge was unreachable)
const AISLES = [
  "bakery",
  "dairy",
  "frozen",
  "fruit",
  "pantry",
  "protein-fresh",
  "protein-tinned",
  "spices",
  "starches",
  "veg",
  "other",
]; // bakery: P-420 · other: P-514 snacks

const priceMap = {};
for (const e of pri.entries) (priceMap[e.ingredient_id] ||= []).push(e);
const priceOf = (id) => defaultPrice(id, priceMap[id] || []);

const results = [];
function T(name, fn) {
  try {
    fn();
    results.push({ suite: "data", name, ok: true });
  } catch (e) {
    results.push({
      suite: "data",
      name,
      ok: false,
      err: String(e.message || e),
    });
  }
}

T(
  "registry: 499 items (494 + 5 P-566 HOLD-unblocking rows), unique ids, contract fields",
  () => {
    const ids = new Set(ing.items.map((i) => i.id));
    if (ing.items.length !== 499)
      throw new Error(`expected 499, got ${ing.items.length}`); // P-566: +snoek/morogo-fresh/morogo-frozen/skop/mala
    if (ids.size !== 499) throw new Error("duplicate ids");
    for (const i of ing.items) {
      if (!i.name || !Array.isArray(i.aliases) || !i.aliases.length)
        throw new Error(`${i.id}: bad name/aliases`);
      if (![0.5, 1, 2, 3].includes(i.tier))
        throw new Error(`${i.id}: bad tier ${i.tier}`);
      if (!AISLES.includes(i.aisle))
        throw new Error(`${i.id}: bad aisle ${i.aisle}`);
      if (!Number.isInteger(i.shelf_life_days) || i.shelf_life_days <= 0)
        throw new Error(`${i.id}: bad shelf_life_days`);
      const ub = i.unit_basis;
      if (
        ![
          "g",
          "ml",
          "unit",
          "bunch",
          "can",
          "tin",
          "pack",
          "packet",
          "box",
          "jar",
          "tub",
          "bottle",
          "bar",
          "tube",
        ].includes(ub.unit) ||
        !(ub.qty > 0)
      )
        throw new Error(`${i.id}: bad unit_basis ${JSON.stringify(ub)}`); // P-567b T4 purchase forms
      if (i.aliases.some((a) => typeof a !== "string" || a !== a.toLowerCase()))
        throw new Error(`${i.id}: alias not lowercase`);
    }
  },
);

T("registry: 1,494 aliases present (the search moat)", () => {
  const n = ing.items.reduce((s, i) => s + i.aliases.length, 0);
  if (n < 1400) throw new Error(`alias count ${n} below 1400`);
});

T(
  "prices: 369 entries keyed to registry, positive integer cents (R0 tap-water is the sanctioned free exception), honest tiers",
  () => {
    if (pri.entries.length !== 541)
      throw new Error(
        `expected 541 rows (524 P-516 iteration-1 estimate-tier + 16 owner-verified via Sixty60 passes + 1 tap-water free reference), got ${pri.entries.length}`,
      );
    for (const e of pri.entries) {
      if (
        !Number.isInteger(e.price_cents) ||
        (e.price_cents <= 0 && e.source !== "reference")
      )
        throw new Error(`${e.ingredient_id}: bad cents`);
      if (!ing.items.some((i) => i.id === e.ingredient_id))
        throw new Error(`${e.ingredient_id}: not in registry`);
      // honest labeling: a row is EITHER verified (has last_verified) or an estimate
      if (!e.last_verified && e.source !== "estimate")
        throw new Error(
          `${e.ingredient_id}: unverified row must be source=estimate`,
        );
      if (e.last_verified && e.source === "estimate" && !e.last_verified)
        throw new Error("unreachable");
    }
    // P-509: every row is dated; tiers live in source. Honest tiers = closed set.
    const LEGAL = ["verified", "estimated", "estimate", "reference"];
    for (const e of pri.entries)
      if (!LEGAL.includes(e.source))
        throw new Error(`illegal source ${e.source} on ${e.ingredient_id}`);
    const nVer = pri.entries.filter((e) => e.source === "verified").length;
    if (nVer !== 16)
      throw new Error(`expected 16 owner-verified rows, got ${nVer}`);
  },
);

T("prices: registry coverage 173/208 — 83%", () => {
  const cov = new Set(pri.entries.map((e) => e.ingredient_id)).size;
  if (cov < 170) throw new Error(`coverage ${cov} below 170`);
});

T(
  "P-569: every step is one short imperative sentence (target 14, hard cap 18)",
  () => {
    // Amended Oct 27 (veto-flagged to owner): the DeepSeek rewave proved 14 is
    // unreachable for quantity-dense steps without losing stated amounts;
    // 18 is the honest floor. Fused number-units ("2tsp") are banned display style.
    for (const r of rec.recipes) {
      for (const st of r.steps) {
        const w = st.trim().split(/\s+/).length;
        if (w > 18) throw new Error(`${r.id}: step exceeds 18 words (${w})`);
        if (/\d(tbsp|tsp|ml|g|min|can|pinch)\b/.test(st))
          throw new Error(`${r.id}: fused number-unit token (display style)`);
      }
    }
  },
);

T("recipes: 447 validated recipes, ids unique, ingredients in registry", () => {
  const ids = new Set(ing.items.map((i) => i.id));
  const rids = new Set();
  if (rec.recipes.length !== 447)
    throw new Error(`expected 447, get ${rec.recipes.length}`); // P-570: 442 + 5 unblocked traditionals
  for (const r of rec.recipes) {
    if (rids.has(r.id)) throw new Error(`dup recipe id ${r.id}`);
    rids.add(r.id);
    if (!r.title) throw new Error(`${r.id}: no title`);
    if (!Number.isInteger(r.servings) || r.servings < 1 || r.servings > 8)
      throw new Error(`${r.id}: bad servings`);
    if (
      !Number.isInteger(r.time_minutes) ||
      r.time_minutes < 5 ||
      r.time_minutes > 200
    )
      throw new Error(`${r.id}: bad time`); // P-570: 90->200 cap, slow-cooked traditionals (mogodu 180); veto-flagged to owner
    if (!r.tags.length || r.tags.some((t) => !TAGS.includes(t)))
      throw new Error(`${r.id}: bad tags`);
    for (const i of r.ingredients) {
      if (!ids.has(i.id))
        throw new Error(`${r.id}: unknown ingredient ${i.id}`);
      if (!(i.qty > 0)) throw new Error(`${r.id}: bad qty on ${i.id}`);
      if (!UNITS.includes(i.unit))
        throw new Error(`${r.id}: bad unit ${i.unit} on ${i.id}`);
    }
    if (!Array.isArray(r.steps) || r.steps.length < 4 || r.steps.length > 10)
      throw new Error(`${r.id}: bad steps`);
  }
});

T(
  "recipes: every ingredient reference resolvable against the price file or flagged",
  () => {
    const priced = new Set(pri.entries.map((e) => e.ingredient_id));
    const unpricedUsed = new Set();
    for (const r of rec.recipes)
      for (const i of r.ingredients)
        if (!priced.has(i.id)) unpricedUsed.add(i.id);
    // 5 known-missing items (in-store list); must not silently grow
    if (unpricedUsed.size > 5)
      throw new Error(
        `unpriced-in-use grew to ${unpricedUsed.size}: ${[...unpricedUsed]}`,
      );
  },
);

T("data files: versions at 1.0.0, dates stamped", () => {
  for (const [f, obj] of [
    ["ingredients", ing],
    ["recipes", rec],
    ["prices", pri],
  ]) {
    if (!obj.version.startsWith("1.0.0"))
      throw new Error(`${f}: version ${obj.version}`);
    const stamp = obj.last_updated || obj.last_verified;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(stamp))
      throw new Error(`${f}: bad date stamp`);
  }
});

T(
  "SCHEMA FREEZE v1.0 (P-107): format_version pinned at 1 on all three canonical files",
  () => {
    // Freeze recorded at tag v0.1.0-foundation (Oct 2026). A format_version bump
    // REQUIRES a PRD amendment note per SCHEMA-FREEZE.md — CI enforces this.
    for (const [f, obj] of [
      ["ingredients", ing],
      ["recipes", rec],
      ["prices", pri],
    ]) {
      if (obj.format_version !== 1)
        throw new Error(
          `${f}: format_version is ${obj.format_version}, frozen shape is 1 (see SCHEMA-FREEZE.md)`,
        );
    }
  },
);

T(
  "display names: English-only — no vernacular-prefixed or empty names (UI shows item.name only)",
  () => {
    for (const i of ing.items) {
      if (!i.name || i.name.trim() !== i.name)
        throw new Error(`${i.id}: bad name`);
      if (/^(i-|ama-|izi-|um-|u-)/i.test(i.name))
        throw new Error(`${i.id}: name looks vernacular: ${i.name}`);
    }
  },
);

// ---- P-104R Day 4: engine guarantees on the LIVE data ----
T(
  "engine: ≥150/179 recipes fully priceable (count-unit semantics wired)",
  () => {
    const green = rec.recipes.filter(
      (r) => costRecipe(r, priceOf).unpriced === 0,
    ).length;
    if (green < 150)
      throw new Error(
        `only ${green} fully priceable — unit semantics regressed`,
      );
  },
);

T(
  "engine: median green-plate cost within the R10-R25 band (~R16 expected)",
  () => {
    const plates = rec.recipes
      .map((r) => ({ c: costRecipe(r, priceOf), s: r.servings }))
      .filter((x) => x.c.unpriced === 0)
      .map((x) => perPlateCents(x.c.totalCents, x.s))
      .sort((a, b) => a - b);
    const median = plates[Math.floor(plates.length / 2)];
    if (median < 1000 || median > 2500)
      throw new Error(`median green plate ${median}c outside R10-R25 band`);
  },
);

T(
  'engine: "Fish Fingers, Chips and Peas" outlier fixed (was ~R119/plate rough)',
  () => {
    const ff = rec.recipes.find((r) => r.title.includes("Fish Fingers"));
    const c = costRecipe(ff, priceOf);
    const pp = perPlateCents(c.totalCents, ff.servings);
    if (pp < 2000 || pp > 4000)
      throw new Error(
        `Fish Fingers at ${pp}c/plate — outside the sane R20-R40 band`,
      );
  },
);

export async function run() {
  return results;
}

// ---- P-420 absorption invariants (Oct 19) ----
const { searchIngredients } = await import("../js/modules/search.js");
T("P-420: brand-as-product-name resolves", () => {
  const s = (q) => searchIngredients(q, ing.items)[0];
  if (s("nutella").id !== "hazelnut-choc-spread") throw new Error("nutella");
  if (s("ouma rusks").id !== "rusks") throw new Error("ouma rusks");
  if (s("aromat").id !== "aromat-seasoning") throw new Error("aromat");
  if (s("mageu").id !== "mageu") throw new Error("mageu");
});
T("P-420: no ambiguous steal after +231 aliases", () => {
  const s = (q) => searchIngredients(q, ing.items)[0];
  if (s("maas").id !== "amasi") throw new Error("maas -> amasi");
  if (s("wors").id !== "boerewors") throw new Error("wors -> boerewors");
  if (s("milo").id !== "drinking-chocolate") throw new Error("milo");
  if (s("koo baked beans").id !== "baked-beans")
    throw new Error("koo beans -> " + s("koo baked beans").id);
});
T(
  "P-420/P-434: promoted items carry ONLY estimate rows until till verification",
  () => {
    const priceMap = {};
    for (const e of pri.entries) (priceMap[e.ingredient_id] ||= []).push(e);
    for (const u of [
      "hazelnut-choc-spread",
      "rusks",
      "aromat-seasoning",
      "mageu",
    ]) {
      const rows = priceMap[u] || [];
      if (!rows.length) throw new Error(`${u} must be priced (promoted)`);
      // P-509: every row is dated now (the tier lives in source, not in date
      // absence). The P-434 intent — no fake verification — is preserved here:
      // promoted items carry ONLY estimate-tier rows until the owner's pass.
      if (rows.some((e) => e.source === "verified"))
        throw new Error(`${u} has a verified row before the owner pass`);
      if (
        !rows.every((e) => e.source === "estimated" || e.source === "estimate")
      )
        throw new Error(`${u} estimate rows mislabeled`);
    }
  },
);

T(
  "P-433: new-item aliases resolve to their own items (post-push audit)",
  () => {
    const s = (q) => searchIngredients(q, ing.items)[0];
    if (s("mielies").id !== "mielies")
      throw new Error("mielies -> " + s("mielies").id);
    if (s("tinned tomatoes").id !== "whole-peeled-tomatoes")
      throw new Error("tinned tomatoes");
    if (s("sunfoil").id !== "cooking-oil") throw new Error("sunfoil");
    if (s("five roses").id !== "black-tea")
      throw new Error("five roses -> " + s("five roses").id);
  },
);
T(
  "P-509b/c piece-weight + bridge sweep: NO priced corpus line costs null (oreo/clove/herb bug class)",
  () => {
    // The owner report: a decoded oreo cake undercosted because 'unit' lines
    // against g-packs had no PIECE_WEIGHTS_G bridge. Lock the whole class:
    // every priced corpus ingredient line in 'unit' must resolve to a cost.
    const priceMap = {};
    for (const e of pri.entries) (priceMap[e.ingredient_id] ||= []).push(e);
    const priceOf = (id) => defaultPrice(id, priceMap[id] || []);
    const nulls = [];
    for (const r of rec.recipes)
      for (const i of r.ingredients) {
        // P-509c: sweep EVERY line unit (the clove bug hid from the unit-only lock)
        const p = priceOf(i.id);
        if (!p) continue;
        const c = ingredientCostCents(i, p);
        if (c === null) nulls.push(`${r.id}:${i.id}:${i.unit}`);
      }
    if (nulls.length)
      throw new Error(
        "priced lines still costing null: " +
          [...new Set(nulls)].slice(0, 8).join(", "),
      );
  },
);

T("P-434: promoted estimates are honestly labeled and matcher-visible", () => {
  // P-509 convention: estimate tier = source estimated/estimate (dated).
  const est = pri.entries.filter(
    (e) => e.source === "estimated" || e.source === "estimate",
  );
  if (est.length !== 524)
    throw new Error(`expected 524 estimate-tier rows, got ${est.length}`);
  // sugar-beans was the flagship exclusion case: it must now be PRICED
  if (!pri.entries.some((e) => e.ingredient_id === "sugar-beans"))
    throw new Error("sugar-beans must be priced after promotion");
});
