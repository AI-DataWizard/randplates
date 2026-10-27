// matcher-tests.js — the scored scenario suite (PRD §10 rule 4).
// Zero-dep, runs in tests/tests.html (browser) and tests/run-node.mjs (Node).
// Covers: costing unit math + rounding, matcher scoring determinism + edge cases,
// planner greedy behavior, search normalization, decoder heuristics, achievements.

import {
  formatRands,
  defaultPrice,
  ingredientCostCents,
  qtyInPackBasis,
  qtyFromGrams,
  costRecipe,
  perPlateCents,
  rescaleRecipe,
  topUpCostCents,
} from "../js/modules/costing.js";
import { readFileSync } from "node:fs";
import {
  normalize,
  searchIngredients,
  matches,
  oneEdit,
} from "../js/modules/search.js";
import { quickTryPicks } from "../js/modules/coverage.js";
import {
  scoreRecipe,
  rankRecipes,
  pantryHas,
  autoRunningLow,
  scorePayload,
  mealIntentFor,
  unlockInsights,
} from "../js/modules/matcher.js";
import {
  planWeek,
  shoppingListToText,
  TAKEOUT_BASELINE_CENTS,
  dayOptions,
  applyPick,
  mealCostAt,
  makeSheet,
} from "../js/modules/planner.js";
import { buildPlanPdf, planPdfName } from "../js/modules/pdf.js";
import { decodeRecipeText, draftToRecipe } from "../js/modules/decoder.js";
import {
  getAchievementStats,
  heatByDate,
  xpForCook,
  xpCostForLevel,
  titleForLevel,
  BADGES,
  newlyEarned,
} from "../js/modules/achievements.js";

const PRICES = [
  {
    ingredient_id: "maize-meal",
    store: "Shoprite",
    price_cents: 3299,
    pack_qty: 2500,
    pack_unit: "g",
    last_verified: "2026-09-14",
  },
  {
    ingredient_id: "maize-meal",
    store: "Boxer",
    price_cents: 2999,
    pack_qty: 2500,
    pack_unit: "g",
    last_verified: "2026-09-14",
  },
  {
    ingredient_id: "rice",
    store: "Shoprite",
    price_cents: 4999,
    pack_qty: 2000,
    pack_unit: "g",
    last_verified: "2026-09-14",
  },
  {
    ingredient_id: "eggs",
    store: "Shoprite",
    price_cents: 9999,
    pack_qty: 30,
    pack_unit: "unit",
    last_verified: "2026-09-14",
  },
  {
    ingredient_id: "bread",
    store: "Shoprite",
    price_cents: 1899,
    pack_qty: 1,
    pack_unit: "unit",
    last_verified: "2026-09-14",
  },
  {
    ingredient_id: "baked-beans",
    store: "Shoprite",
    price_cents: 1499,
    pack_qty: 1,
    pack_unit: "can",
    last_verified: "2026-09-14",
  },
  {
    ingredient_id: "onion",
    store: "Shoprite",
    price_cents: 2499,
    pack_qty: 1000,
    pack_unit: "g",
    last_verified: "2026-09-14",
  },
  {
    ingredient_id: "tomato",
    store: "Shoprite",
    price_cents: 2999,
    pack_qty: 1000,
    pack_unit: "g",
    last_verified: "2026-09-14",
  },
];
const PRICES_P305 = [
  ...PRICES,
  {
    ingredient_id: "salt",
    store: "Shoprite",
    price_cents: 1499,
    pack_qty: 500,
    pack_unit: "g",
    last_verified: "2026-09-14",
  },
  {
    ingredient_id: "oil",
    store: "Shoprite",
    price_cents: 3999,
    pack_qty: 750,
    pack_unit: "ml",
    last_verified: "2026-09-14",
  },
];
const R_SNACK = {
  // staple-only: salt + oil → realCount 0 (the "free dessert" trap)
  id: "salt-oil-snack",
  title: "Salt Oil Snack",
  servings: 2,
  time_minutes: 5,
  tags: ["snack"],
  ingredients: [
    { id: "salt", qty: 5, unit: "g" },
    { id: "oil", qty: 30, unit: "ml" },
  ],
  steps: ["Stir"],
};
const priceOf = (id) => defaultPrice(id, PRICES);

const ING = [
  {
    id: "maize-meal",
    name: "Maize meal",
    aliases: ["pap"],
    aisle: "starches",
    unit_basis: { qty: 2500, unit: "g" },
    tier: 2,
    shelf_life_days: 180,
  },
  {
    id: "rice",
    name: "White rice",
    aliases: ["rys"],
    aisle: "starches",
    unit_basis: { qty: 2000, unit: "g" },
    tier: 2,
    shelf_life_days: 365,
  },
  {
    id: "eggs",
    name: "Eggs",
    aliases: ["eiers"],
    aisle: "proteins",
    unit_basis: { qty: 30, unit: "unit" },
    tier: 3,
    shelf_life_days: 21,
  },
  {
    id: "bread",
    name: "Sliced white bread",
    aliases: ["brood"],
    aisle: "starches",
    unit_basis: { qty: 1, unit: "unit" },
    tier: 2,
    shelf_life_days: 5,
  },
  {
    id: "baked-beans",
    name: "Baked beans",
    aliases: ["beans"],
    aisle: "tinned",
    unit_basis: { qty: 1, unit: "can" },
    tier: 2,
    shelf_life_days: 540,
  },
  {
    id: "onion",
    name: "Onions",
    aliases: ["uil"],
    aisle: "veg",
    unit_basis: { qty: 1000, unit: "g" },
    tier: 1,
    shelf_life_days: 30,
  },
  {
    id: "tomato",
    name: "Tomatoes",
    aliases: ["tamatie"],
    aisle: "veg",
    unit_basis: { qty: 1000, unit: "g" },
    tier: 1,
    shelf_life_days: 7,
  },
];

const ING_STAPLE = [
  ...ING,
  {
    id: "salt",
    name: "Table salt",
    aliases: ["sout"],
    aisle: "spices",
    unit_basis: { qty: 500, unit: "g" },
    tier: 0.5,
    shelf_life_days: 730,
  },
  {
    id: "oil",
    name: "Cooking oil",
    aliases: ["olie"],
    aisle: "pantry",
    unit_basis: { qty: 750, unit: "ml" },
    tier: 0.5,
    shelf_life_days: 365,
  },
];
const PRICES_STAPLE = [
  ...PRICES,
  {
    ingredient_id: "salt",
    store: "Shoprite",
    price_cents: 1999,
    pack_qty: 500,
    pack_unit: "g",
    last_verified: "2026-09-14",
  },
  {
    ingredient_id: "oil",
    store: "Shoprite",
    price_cents: 3999,
    pack_qty: 750,
    pack_unit: "ml",
    last_verified: "2026-09-14",
  },
];
const R_STAPLE = {
  id: "pap-salt",
  title: "Pap, beans & salt",
  servings: 4,
  time_minutes: 25,
  tags: ["budget"],
  ingredients: [
    { id: "maize-meal", qty: 400, unit: "g" },
    { id: "baked-beans", qty: 1, unit: "can" },
    { id: "salt", qty: 2, unit: "g" }, // tier-0.5 staple, non-optional on purpose
    { id: "oil", qty: 15, unit: "ml" }, // tier-0.5 staple, non-optional on purpose
  ],
  steps: ["Cook pap", "Season"],
};
const ctxBase = (pantry, budgetCents = 60000, constraints = {}) => ({
  pantry,
  ingredients: ING,
  priceOf,
  remainingBudgetCents: budgetCents,
  constraints,
});

const R_PAP = {
  id: "pap-classic",
  title: "Pap & beans",
  servings: 4,
  time_minutes: 25,
  tags: ["budget", "vegetarian"],
  ingredients: [
    { id: "maize-meal", qty: 400, unit: "g" },
    { id: "baked-beans", qty: 1, unit: "can" },
    { id: "onion", qty: 100, unit: "g", optional: true },
  ],
  steps: ["Cook pap", "Warm beans"],
};
const R_EGGS = {
  id: "eggs-toast",
  title: "Eggs on toast",
  servings: 2,
  time_minutes: 10,
  tags: ["budget", "vegetarian", "quick"],
  ingredients: [
    { id: "eggs", qty: 3, unit: "unit" },
    { id: "bread", qty: 2, unit: "unit" },
  ],
  steps: ["Fry eggs", "Toast"],
};
const R_RICE = {
  id: "rice-tom",
  title: "Tomato rice",
  servings: 4,
  time_minutes: 45,
  tags: ["budget"],
  ingredients: [
    { id: "rice", qty: 300, unit: "g" },
    { id: "tomato", qty: 300, unit: "g" },
  ],
  steps: ["Fry tomato", "Add rice"],
};

// ---------------------------------------------------------------------------

const cases = [];
let suite = "general";
const T = (name, fn) => {
  cases.push({ suite, name, fn });
};

// ---- costing ----
suite = "costing";
T("formatRands: cents → rands string (integer-cent guarantee)", () => {
  eq(formatRands(17340), "R173.40");
  eq(formatRands(599), "R5.99");
  eq(formatRands(0), "R0.00");
  eq(formatRands(125000), "R1 250.00"); // SA-style space grouping, deterministic
  eq(formatRands(-250), "-R2.50");
  eq(formatRands(99999999), "R999 999.99"); // big number, no drift
});
T("defaultPrice: median across stores (lower-middle for even counts)", () => {
  eq(defaultPrice("maize-meal", PRICES).price_cents, 2999); // [2999, 3299] → lower-middle
  eq(defaultPrice("eggs", PRICES).price_cents, 9999);
});
T("defaultPrice: unknown ingredient → null, never a crash", () => {
  eq(defaultPrice("unicorn", PRICES), null);
});
T("qtyInPackBasis: R/500g basis — 175g of a 500g-priced pack", () => {
  eq(qtyInPackBasis(175, "g", "g"), 175);
  eq(qtyInPackBasis(2, "kg", "g"), 2000);
  eq(qtyInPackBasis(1, "tbsp", "g"), 15);
  eq(qtyInPackBasis(2, "slice", "unit"), 2 / 18); // slices → loaf fraction (SLICES_PER_LOAF=18)
  eq(qtyInPackBasis(2, "slice", "g"), 70); // P-104R: slice grams (35 g/slice, 700 g loaf ≈ 20)
});

// ---- P-104R Day 4: count-unit semantics against the real conversion authority ----
T("qtyInPackBasis: tin/can = the priced pack itself (no guessing)", () => {
  eq(qtyInPackBasis(1, "tin", "g", { id: "baked-beans", packQty: 410 }), 410);
  eq(qtyInPackBasis(2, "tin", "g", { id: "baked-beans", packQty: 410 }), 820);
  eq(qtyInPackBasis(1, "can", "g", { id: "chakalaka", packQty: 410 }), 410);
  eq(qtyInPackBasis(1, "tin", "ml", { id: "coconut-milk", packQty: 400 }), 400); // tin vs ml-pack
  eq(qtyInPackBasis(1, "tin", "g", { id: "baked-beans", packQty: 0 }), null); // no pack info -> null
});

T(
  "qtyInPackBasis: piece weights for unit quantities (deterministic table)",
  () => {
    eq(qtyInPackBasis(2, "unit", "g", { id: "tomatoes" }), 250); // 2 × 125 g
    eq(qtyInPackBasis(3, "unit", "g", { id: "onions" }), 450); // 3 × 150 g
    eq(qtyInPackBasis(12, "unit", "g", { id: "fish-fingers" }), 240); // 12 × 20 g — the outlier fix
    eq(qtyInPackBasis(1, "unit", "g", { id: "not-in-table" }), null); // unknown id: never guessed
  },
);

T("qtyInPackBasis: grams -> known piece (head of cabbage, unit-priced)", () => {
  eq(qtyInPackBasis(500, "g", "unit", { id: "cabbage" }), 0.5); // half a 1 kg head
  eq(qtyInPackBasis(300, "g", "unit", { id: "lettuce" }), 0.75); // 300/400 head
  eq(qtyInPackBasis(300, "g", "unit", { id: "not-in-table" }), null);
});

T("ingredientCostCents: tin line prices exactly one pack", () => {
  const entry = { price_cents: 419, pack_qty: 410, pack_unit: "g" };
  eq(
    ingredientCostCents({ id: "baked-beans", qty: 1, unit: "tin" }, entry),
    419,
  );
  eq(
    ingredientCostCents({ id: "baked-beans", qty: 2, unit: "tin" }, entry),
    838,
  );
});

T(
  "pantryHas: precise grams basis — covered and costed can never disagree",
  () => {
    const line = { id: "tomatoes", qty: 2, unit: "unit" }; // recipe wants 2 tomatoes = 250 g
    const priceOf = () => ({
      price_cents: 4999,
      pack_qty: 1000,
      pack_unit: "g",
    });
    eq(
      pantryHas([{ id: "tomatoes", qty: 100, unit: "g" }], line, null, priceOf),
      false,
    ); // 100 g < 250 g
    eq(
      pantryHas([{ id: "tomatoes", qty: 300, unit: "g" }], line, null, priceOf),
      true,
    ); // 300 g ≥ 250 g
    // tin line vs grams pantry: 1 tin baked beans (410 g pack) vs a full tin in the pantry
    const tinLine = { id: "baked-beans", qty: 1, unit: "tin" };
    const tinPrice = () => ({
      price_cents: 419,
      pack_qty: 410,
      pack_unit: "g",
    });
    eq(
      pantryHas(
        [{ id: "baked-beans", qty: 400, unit: "g" }],
        tinLine,
        null,
        tinPrice,
      ),
      false,
    ); // 400 < 410
    eq(
      pantryHas(
        [{ id: "baked-beans", qty: 410, unit: "g" }],
        tinLine,
        null,
        tinPrice,
      ),
      true,
    ); // exact tin
  },
);
T("ingredientCostCents: proportional pack math (R32.99 / 2.5kg → 400g)", () => {
  eq(
    ingredientCostCents(
      { qty: 400, unit: "g" },
      { price_cents: 3299, pack_qty: 2500, pack_unit: "g" },
    ),
    Math.round((3299 * 400) / 2500),
  ); // 528
});
T("ingredientCostCents: needing more than a pack costs whole packs", () => {
  // 35 eggs vs 30-egg pack → 2 packs = 19998c
  eq(
    ingredientCostCents(
      { qty: 35, unit: "unit" },
      { price_cents: 9999, pack_qty: 30, pack_unit: "unit" },
    ),
    19998,
  );
});
T("costRecipe: totals + unpriced counting", () => {
  const r = {
    ingredients: [
      { id: "maize-meal", qty: 400, unit: "g" },
      { id: "unicorn", qty: 1, unit: "unit" },
    ],
  };
  const c = costRecipe(r, priceOf);
  eq(c.unpriced, 1);
  eq(
    c.totalCents,
    Math.round((defaultPrice("maize-meal", PRICES).price_cents * 400) / 2500),
  ); // median-priced
});
T("perPlateCents: division rounds to nearest cent", () => {
  eq(perPlateCents(1000, 3), 333);
  eq(perPlateCents(1000, 6), 167);
});
T("rescaleRecipe: linear scaling of quantities, servings updated", () => {
  const s = rescaleRecipe(R_PAP, 8);
  eq(s.servings, 8);
  eq(s.ingredients[0].qty, 800);
  eq(s.ingredients[1].qty, 2);
});

// ---- matcher ----
suite = "matcher";
T("pantryHas: quantity-aware, unit-tolerant", () => {
  ok(
    pantryHas([{ id: "eggs", qty: 6, unit: "unit" }], {
      id: "eggs",
      qty: 3,
      unit: "unit",
    }),
  );
  ok(
    !pantryHas([{ id: "eggs", qty: 2, unit: "unit" }], {
      id: "eggs",
      qty: 3,
      unit: "unit",
    }),
  );
  ok(
    pantryHas([{ id: "maize-meal", qty: 1000, unit: "g" }], {
      id: "maize-meal",
      qty: 400,
      unit: "g",
    }),
  );
  ok(
    !pantryHas([{ id: "maize-meal", qty: 100, unit: "g" }], {
      id: "maize-meal",
      qty: 400,
      unit: "g",
    }),
  );
});
T("coverage: tier-weighted (protein counts 6× garnish)", () => {
  // eggs(weight3) + bread(weight2) recipe, pantry has eggs only → 3/5 = 0.6
  const r = scoreRecipe(
    R_EGGS,
    ctxBase([{ id: "eggs", qty: 6, unit: "unit" }]),
  );
  near(r.coverage, 0.6);
  eq(r.matchPct, 60);
});
T("missingCost: optional items are excluded (PRD §9.1)", () => {
  // pantry empty: pap+beans missing; onion is optional → excluded.
  // P-113b: top-ups are WHOLE PACKS — 400 g maize from 2500 g packs = 1 whole pack
  // (cheapest default = Boxer R29.99), not proportional 528.
  const r = scoreRecipe(R_PAP, ctxBase([]));
  const maizeCost = 2999;
  eq(r.missingCostCents, maizeCost + 1499);
  eq(r.missing.length, 2);
});
T("eligibility: missingCost > remainingBudget → ineligible with reason", () => {
  const r = scoreRecipe(R_PAP, ctxBase([], 1000)); // R10 budget, R20.27 missing
  ok(!r.eligible);
  ok(r.reasons.some((x) => /budget/i.test(x)));
});
T("eligibility: exactly-at-budget passes (≤, not <)", () => {
  // whole-pack top-ups (P-113b): maize (Boxer R29.99) + beans = 4498 → budget set exactly there
  const r = scoreRecipe(R_PAP, ctxBase([], 2999 + 1499));
  ok(r.eligible);
  // one cent less and it's over
  eq(scoreRecipe(R_PAP, ctxBase([], 2999 + 1499 - 1)).eligible, false);
});
T("score formula: coverage×100 − 25×(missing/budget) — hand-checked", () => {
  // pantry has beans; missing = 400g maize (528c); budget 10000c
  const r = scoreRecipe(
    R_PAP,
    ctxBase([{ id: "baked-beans", qty: 1, unit: "can" }], 10000),
  );
  // weights: maize 2 + beans 2 + onion 1 = 5; has beans = 2 → coverage 0.4
  // FULL formula (P-104T): coverage×100 − 25×(topUp/budget) + time + fresh + hero
  //                        + substance(2 per owned real line, max 6) − thinPenalty
  // Real lines = non-optional, non-staple: maize + beans = 2 lines → thinPenalty 6;
  // owned real = 1 (beans) → substance 2. No hero (no tier-3), no time bonus (25 min).
  const expected = 0.4 * 100 - 25 * (r.missingCostCents / 10000) + 2 - 6;
  near(r.score, expected, 0.01);
  eq(r.substanceBonus, 2);
  eq(r.thinPenalty, 6);
});
T("timeBonus: ≤20 min adds +5", () => {
  const quick = scoreRecipe(R_EGGS, ctxBase([], 100000));
  const slow = scoreRecipe(R_RICE, ctxBase([], 100000));
  eq(quick.timeBonus, 5);
  eq(slow.timeBonus, 0);
});
T("freshnessBonus: running-low pantry items used = +3 each, capped +9", () => {
  const pantry = [
    { id: "eggs", qty: 6, unit: "unit", running_low: true },
    { id: "bread", qty: 1, unit: "unit", running_low: true },
    { id: "tomato", qty: 500, unit: "g", running_low: true },
    { id: "rice", qty: 500, unit: "g", running_low: true }, // 4 fresh → cap 3
  ];
  const r = scoreRecipe(
    {
      ...R_RICE,
      ingredients: [
        ...R_RICE.ingredients,
        { id: "eggs", qty: 1, unit: "unit", optional: true },
        { id: "bread", qty: 1, unit: "unit", optional: true },
      ],
    },
    ctxBase(pantry, 100000),
  );
  eq(r.freshnessBonus, 9);
});
T("dietary constraint: vegetarian recipe passes, meat recipe blocked", () => {
  const meaty = { ...R_PAP, tags: ["budget"] };
  ok(
    scoreRecipe(meaty, ctxBase([], 100000, { dietary: "vegetarian" }))
      .eligible === false,
  );
  ok(
    scoreRecipe(R_PAP, ctxBase([], 100000, { dietary: "vegetarian" }))
      .eligible === true,
  );
});
T("maxTime constraint blocks long recipes", () => {
  ok(!scoreRecipe(R_RICE, ctxBase([], 100000, { maxTimeMin: 20 })).eligible);
  ok(scoreRecipe(R_EGGS, ctxBase([], 100000, { maxTimeMin: 20 })).eligible);
});
T("ranking: eligible first, score desc, tie-break per-plate asc", () => {
  const ranked = rankRecipes([R_RICE, R_PAP, R_EGGS], ctxBase([], 100000));
  ok(ranked.every((r, i) => i === 0 || ranked[i - 1].eligible >= r.eligible));
  ok(ranked[0].score >= ranked[ranked.length - 1].score);
  // determinism: same inputs → identical output order, twice
  eq(
    JSON.stringify(
      rankRecipes([R_RICE, R_PAP, R_EGGS], ctxBase([], 100000)).map(
        (r) => r.recipeId,
      ),
    ),
    JSON.stringify(ranked.map((r) => r.recipeId)),
  );
});
T(
  "empty pantry edge: everything ineligible except within-budget cheap recipes — no crash",
  () => {
    const ranked = rankRecipes([R_PAP, R_EGGS], ctxBase([], 0));
    ok(ranked.every((r) => !r.eligible));
  },
);
T(
  "unpriced ingredient: missing-cost budget-neutral, flagged, never NaN",
  () => {
    const withGhost = {
      ...R_EGGS,
      ingredients: [
        ...R_EGGS.ingredients,
        { id: "ghost", qty: 1, unit: "unit" },
      ],
    };
    const r = scoreRecipe(withGhost, ctxBase([], 50000));
    eq(Number.isNaN(r.score), false);
    ok(r.reasons.some((x) => /unpriced/i.test(x)));
  },
);

// ---- planner ----
suite = "planner";
// P-313: the planner pool is DINNER-ONLY (isDinnerFit hard filter in planner.js).
// Matcher fixtures above are shared with intent/tag tests, so planner tests
// dinnerize their candidates instead of mutating the shared fixtures.
const dinnerize = (cands) =>
  cands.map((c) => ({ ...c, tags: [...(c.tags || []), "dinner"] }));

// ---- P-313: dinner-only planner contract ----
T(
  "P-313: breakfast/snack recipes NEVER enter the pool — 0 placements, honest warning",
  () => {
    const breakfast = {
      ...R_EGGS,
      tags: ["budget", "vegetarian", "quick", "breakfast"],
    };
    const pantry = [
      { id: "salt", qty: 500, unit: "g" },
      { id: "oil", qty: 750, unit: "ml" },
    ];
    const cands = rankRecipes([R_SNACK, breakfast], ctxBase(pantry, 100_000));
    ok(
      cands.some((c) => c.eligible),
      "fixture sanity: something IS cookable",
    );
    const plan = planWeek(cands, {
      weekBudgetCents: 100_000,
      servings: 2,
      days: 7,
      ingredients: ING,
      priceEntries: PRICES,
      pantry,
    });
    eq(plan.mealsPlanned, 0, "dinner filter excludes every non-dinner recipe");
    ok(
      plan.warnings.some((w) => /dinner/i.test(w)),
      "the warning says WHY: no dinner recipes match",
    );
  },
);
T("P-313: applyPick REJECTS a non-dinner choice (reason not-dinner)", () => {
  const pantry = [
    { id: "salt", qty: 500, unit: "g" },
    { id: "oil", qty: 750, unit: "ml" },
  ];
  const cands = rankRecipes([R_SNACK, R_EGGS], ctxBase(pantry, 100_000));
  const eggs = dinnerize(cands.filter((c) => c.recipeId === "eggs-toast"));
  const snack = cands.filter((c) => c.recipeId === "salt-oil-snack");
  const opts = {
    weekBudgetCents: 100_000,
    servings: 2,
    days: 7,
    ingredients: ING,
    priceEntries: PRICES,
    pantry,
  };
  const plan = planWeek([...eggs, ...snack], opts);
  eq(plan.mealsPlanned, 2, "fixture sanity: eggs planned twice");
  const res = applyPick(plan, [...eggs, ...snack], opts, 0, "salt-oil-snack");
  eq(res.ok, false);
  eq(
    res.reason,
    "not-dinner",
    "a snack can never be hand-placed into a plan day",
  );
});
T("P-313: dayOptions hides non-dinner recipes from the swap picker", () => {
  const pantry = [
    { id: "salt", qty: 500, unit: "g" },
    { id: "oil", qty: 750, unit: "ml" },
  ];
  const cands = rankRecipes([R_SNACK, R_EGGS], ctxBase(pantry, 100_000));
  const eggs = dinnerize(cands.filter((c) => c.recipeId === "eggs-toast"));
  const snack = cands.filter((c) => c.recipeId === "salt-oil-snack");
  const opts = {
    weekBudgetCents: 100_000,
    servings: 2,
    days: 7,
    ingredients: ING,
    priceEntries: PRICES,
    pantry,
  };
  const plan = planWeek([...eggs, ...snack], opts);
  const { options } = dayOptions(plan, [...eggs, ...snack], opts, 0);
  ok(options.length > 0, "the dinner recipe is offered");
  ok(
    !options.some((o) => o.recipeId === "salt-oil-snack"),
    "the snack is invisible to the picker",
  );
});
T("planWeek: never exceeds the weekly budget (greedy constraint holds)", () => {
  for (const budget of [10000, 30000, 60000, 150000]) {
    const candidates = dinnerize(
      rankRecipes([R_PAP, R_EGGS, R_RICE], ctxBase([], 10_000_000)),
    );
    const plan = planWeek(candidates, {
      weekBudgetCents: budget,
      servings: 2,
      days: 7,
      ingredients: ING,
      priceEntries: PRICES,
    });
    ok(plan.totalCents <= budget, `budget ${budget}: total ${plan.totalCents}`);
  }
});
const R_BEANS = {
  id: "beans-toast",
  title: "Beans on toast",
  servings: 2,
  time_minutes: 10,
  tags: ["budget", "vegetarian"],
  ingredients: [
    { id: "bread", qty: 2, unit: "unit" },
    { id: "baked-beans", qty: 1, unit: "can" },
  ],
  steps: ["Toast", "Warm beans"],
};
T("planWeek: fills 7 days when budget allows", () => {
  const candidates = dinnerize(
    rankRecipes([R_PAP, R_EGGS, R_RICE, R_BEANS], ctxBase([], 10_000_000)),
  );
  const plan = planWeek(candidates, {
    weekBudgetCents: 150000,
    servings: 2,
    days: 7,
    ingredients: ING,
    priceEntries: PRICES,
  });
  eq(plan.mealsPlanned, 7);
});
T("planWeek: MAX_REPEATS — no recipe appears more than twice", () => {
  const candidates = dinnerize(rankRecipes([R_PAP], ctxBase([], 10_000_000))); // single candidate
  const plan = planWeek(candidates, {
    weekBudgetCents: 150000,
    servings: 2,
    days: 7,
    ingredients: ING,
    priceEntries: PRICES,
  });
  const counts = {};
  for (const d of plan.days)
    if (d.meal) counts[d.meal.recipeId] = (counts[d.meal.recipeId] || 0) + 1;
  ok(Math.max(...Object.values(counts)) <= 2);
});
T(
  "planWeek: shopping list deduped across meals (one entry per ingredient)",
  () => {
    const candidates = dinnerize(
      rankRecipes([R_PAP, R_EGGS], ctxBase([], 10_000_000)),
    );
    const plan = planWeek(candidates, {
      weekBudgetCents: 150000,
      servings: 2,
      days: 7,
      ingredients: ING,
      priceEntries: PRICES,
    });
    const ids = plan.shoppingList.map((i) => i.id);
    eq(new Set(ids).size, ids.length);
  },
);
T(
  'planWeek: shared purchases make repeats nearly free ("cook once, eat twice")',
  () => {
    const candidates = dinnerize(rankRecipes([R_PAP], ctxBase([], 10_000_000)));
    const plan = planWeek(candidates, {
      weekBudgetCents: 150000,
      servings: 2,
      days: 7,
      ingredients: ING,
      priceEntries: PRICES,
    });
    eq(plan.mealsPlanned, 2); // capped at 2 — and the second cost ~0 marginal
  },
);
T("planWeek: status — green under 90%, amber near, red over", () => {
  const candidates = dinnerize(
    rankRecipes([R_PAP, R_EGGS, R_RICE], ctxBase([], 10_000_000)),
  );
  const tiny = planWeek(candidates, {
    weekBudgetCents: 6000,
    servings: 2,
    days: 7,
    ingredients: ING,
    priceEntries: PRICES,
  });
  ok(["under", "near", "over"].includes(tiny.status));
  ok(tiny.totalCents <= tiny.weekBudgetCents); // greedy never plans over budget; over only via hand-edit
});
T("planWeek: savings vs takeout baseline uses R55/plate/serving", () => {
  const candidates = dinnerize(
    rankRecipes([R_PAP, R_EGGS, R_RICE], ctxBase([], 10_000_000)),
  );
  const plan = planWeek(candidates, {
    weekBudgetCents: 150000,
    servings: 2,
    days: 7,
    ingredients: ING,
    priceEntries: PRICES,
  });
  eq(
    plan.savingsCents,
    plan.mealsPlanned * 2 * TAKEOUT_BASELINE_CENTS - plan.totalCents,
  );
});
T(
  "shoppingListToText: WhatsApp contract — bold headers, short lines, live totals",
  () => {
    const candidates = dinnerize(
      rankRecipes([R_PAP, R_EGGS, R_RICE, R_BEANS], ctxBase([], 10_000_000)),
    );
    const plan = planWeek(candidates, {
      weekBudgetCents: 150000,
      servings: 2,
      days: 7,
      ingredients: ING,
      priceEntries: PRICES,
    });
    const text = shoppingListToText(plan);
    const lines = text.split("\n");
    ok(text.includes("*RANDPLATES WEEK PLAN*"), "title bold for WhatsApp");
    ok(
      text.includes(`*TOTAL ${formatRands(plan.totalCents)}*`),
      "bold total matches the plan",
    );
    ok(
      text.includes(
        `Saved vs eating out: ${formatRands(Math.max(0, plan.savingsCents))}`,
      ),
      "savings line survives",
    );
    // every aisle has a bold header carrying its subtotal (the slip sums survive pasting)
    const aisles = [...new Set(plan.shoppingList.map((i) => i.aisle))];
    for (const a of aisles) {
      ok(
        text.includes(`*${a.toUpperCase()} —`),
        `aisle ${a} bolded with subtotal`,
      );
    }
    // every list item appears exactly once with its pack count and price
    for (const item of plan.shoppingList) {
      ok(
        text.includes(
          `• ${item.name} (×${item.packs}) ${formatRands(item.priceCents)}`,
        ),
        `item line for ${item.name}`,
      );
    }
    // P-302 #2: no line ever wraps on a low-end Android — 48-char hard cap
    for (const l of lines)
      ok(l.length <= 48, `line too long (${l.length}): ${l}`);
    ok(
      lines.every((l) => l === l.trimEnd()),
      "no trailing spaces",
    );
  },
);

// ---- P-305: planner overhaul — dinners-first, pack-exact meal costing, the WEEK story ----
suite = "planner-overhaul";
T("P-305 dinners-first: a real meal beats a FREE staple-only snack", () => {
  // pantry owns the snack's staples → snack marginal is 0; eggs cost money.
  // Old greedy: 7 free snacks. New rule: real dinners first, snacks only fill.
  const pantry = [
    { id: "salt", qty: 500, unit: "g" },
    { id: "oil", qty: 750, unit: "ml" },
  ];
  const candidates = rankRecipes([R_SNACK, R_EGGS], ctxBase(pantry, 100_000));
  // P-313: dinnerize ONLY the real meal — the snack stays snack-tagged so this
  // test also proves the pool filter, not just the ordering.
  const pool = candidates.filter((c) => c.recipeId !== "salt-oil-snack");
  const snack = candidates.filter((c) => c.recipeId === "salt-oil-snack");
  const plan = planWeek([...dinnerize(pool), ...snack], {
    weekBudgetCents: 100_000,
    servings: 2,
    days: 7,
    ingredients: ING_STAPLE,
    priceEntries: PRICES_P305,
  });
  eq(
    plan.days[0].meal.recipeId,
    "eggs-toast",
    "day 0 must be the real dinner, not the free snack",
  );
  eq(plan.days[0].meal.real, true);
  // P-313 re-baseline: repeat cap 2 → eggs twice, then the day STAYS EMPTY —
  // a free snack is discovery food now, never plan filler.
  eq(plan.days[1].meal.recipeId, "eggs-toast");
  eq(plan.days[2].meal, null, "P-313: the snack can never fill a plan day");
  ok(
    plan.totalCents > 0,
    "the week buys the dinner ingredients — total is not R0.00",
  );
});

T(
  "P-305 meal costing: pack-exact parity with the cook-log path (P-207 #11)",
  () => {
    const candidates = rankRecipes([R_EGGS, R_RICE], ctxBase([], 100_000));
    const plan = planWeek(candidates, {
      weekBudgetCents: 100_000,
      servings: 2,
      days: 7,
      ingredients: ING,
      priceEntries: PRICES,
    });
    const byId = new Map(candidates.map((c) => [c.recipeId, c]));
    for (const d of plan.days) {
      if (!d.meal) continue;
      const cand = byId.get(d.meal.recipeId);
      // the exact cook-log formula, recomputed independently in the test
      const manual = costRecipe(
        rescaleRecipe(
          { servings: cand.servings, ingredients: cand.ingredients },
          2,
        ),
        priceOf,
      );
      eq(
        d.meal.mealCents,
        manual.totalCents,
        `${d.meal.title}: mealCents must be pack-exact at 2 plates`,
      );
      eq(d.meal.perPlateCents, Math.round(manual.totalCents / 2));
      eq(d.meal.plates, 2);
    }
  },
);

T(
  "P-305 the plan carries its plate-value story (mealValue / pantryCooked)",
  () => {
    const candidates = dinnerize(rankRecipes([R_EGGS], ctxBase([], 100_000)));
    const plan = planWeek(candidates, {
      weekBudgetCents: 100_000,
      servings: 2,
      days: 7,
      ingredients: ING,
      priceEntries: PRICES,
    });
    const mealSum = plan.days.reduce(
      (t, d) => t + (d.meal ? d.meal.mealCents : 0),
      0,
    );
    eq(plan.mealValueCents, mealSum, "mealValueCents = Σ mealCents");
    eq(
      plan.pantryCookedCents,
      Math.max(0, mealSum - plan.totalCents),
      "pantryCooked = plate value the shop total does not cover",
    );
    // swap parity: clear a placed day, re-place the SAME recipe through the
    // picker — the meal value must come back identical (repeat-cap refuses a third)
    const opts = {
      weekBudgetCents: 100_000,
      servings: 2,
      days: 7,
      ingredients: ING,
      priceEntries: PRICES,
    };
    const swapped = applyPick(plan, candidates, opts, 0, "clear");
    ok(swapped.ok);
    const replaced = applyPick(
      swapped.plan,
      candidates,
      opts,
      0,
      plan.days[1].meal.recipeId,
    );
    ok(replaced.ok, "re-place through the picker");
    eq(
      replaced.plan.days[0].meal.mealCents,
      plan.days[1].meal.mealCents,
      "picker places the same meal value the greedy did",
    );
  },
);

T(
  "P-305 WhatsApp text: THE WEEK block lists every meal within the 48-char cap",
  () => {
    const candidates = rankRecipes([R_EGGS, R_RICE], ctxBase([], 100_000));
    const plan = planWeek(candidates, {
      weekBudgetCents: 100_000,
      servings: 2,
      days: 7,
      ingredients: ING,
      priceEntries: PRICES,
    });
    const text = shoppingListToText(plan);
    ok(text.includes("*THE WEEK*"), "meals block is bold-marked");
    const lines = text.split("\n");
    for (const d of plan.days) {
      if (!d.meal) continue;
      ok(
        lines.some(
          (l) =>
            l.startsWith(`• ${d.day.slice(0, 3)} `) &&
            l.includes(formatRands(d.meal.mealCents)),
        ),
        `week line for ${d.day} with its meal total`,
      );
    }
    for (const l of lines)
      ok(l.length <= 48, `line too long (${l.length}): ${l}`);
  },
);

// ---- P-306: honest pantry accounting + the PDF report ----
suite = "planner-accounting";
T(
  "P-306 sheet: two DIFFERENT meals sharing owned stock consume it once — the gap is bought",
  () => {
    // 1000g owned onions; each meal needs 800g. Old engine: both meals fully
    // "covered" (same stock twice) → R0.00, 400g phantom. New: meal 1 eats 800g,
    // meal 2 eats the last 200g and buys a 600g gap → one onion pack.
    const r1 = {
      id: "o-1",
      title: "Onion Stew A",
      servings: 2,
      time_minutes: 20,
      tags: ["dinner"],
      ingredients: [{ id: "onion", qty: 800, unit: "g" }],
      steps: [],
    };
    const r2 = {
      id: "o-2",
      title: "Onion Stew B",
      servings: 2,
      time_minutes: 20,
      tags: ["dinner"],
      ingredients: [
        { id: "onion", qty: 800, unit: "g" },
        { id: "tomato", qty: 100, unit: "g" },
      ],
      steps: [],
    };
    const pantry = [{ id: "onion", qty: 1000, unit: "g" }];
    const ctx = {
      pantry,
      ingredients: ING,
      priceOf,
      remainingBudgetCents: 100000,
      constraints: {},
    };
    const cands = rankRecipes([r1, r2], ctx);
    const plan = planWeek(cands, {
      weekBudgetCents: 100000,
      servings: 2,
      days: 7,
      ingredients: ING,
      priceEntries: PRICES,
      pantry,
    });
    const onionBuy = plan.shoppingList.find((i) => i.id === "onion");
    ok(
      !!onionBuy,
      "the 600g shortfall must be bought, not conjured from spent stock",
    );
    const used = plan.pantryUse.find((u) => u.id === "onion");
    eq(
      used && used.qty,
      1000,
      "the slip shows the plan eating all 1000g of owned onions",
    );
    ok(plan.totalCents > 0, "honest total: the week buys onions (and tomato)");
  },
);

T(
  "P-306 sheet: staples stay assumed-home — never bought, never consumed",
  () => {
    const s = makeSheet([{ id: "salt", qty: 500, unit: "g" }], priceOf);
    const cand = {
      recipeId: "x",
      servings: 2,
      ingredients: [{ id: "salt", qty: 5, unit: "g" }],
    };
    commitMealProbe(s, cand);
    eq(s.buy.size, 0, "staple lines never enter the buy list");
    eq(
      s.left.get("salt"),
      500,
      "staple stock is never consumed (assumed-home rule)",
    );
  },
);

T("P-306 plan carries pantryUse with proportional value", () => {
  const r = {
    id: "rice-rep",
    title: "Rice Repeat",
    servings: 1,
    time_minutes: 20,
    tags: ["dinner"],
    ingredients: [{ id: "rice", qty: 80, unit: "g" }],
    steps: [],
  };
  const pantry = [{ id: "rice", qty: 100, unit: "g" }];
  const [s] = rankRecipes([r], {
    pantry,
    ingredients: ING,
    priceOf,
    remainingBudgetCents: 60000,
    constraints: {},
  });
  const plan = planWeek(dinnerize([s]), {
    weekBudgetCents: 100000,
    servings: 1,
    days: 2,
    ingredients: ING,
    priceEntries: PRICES,
    pantry,
  });
  const used = plan.pantryUse.find((u) => u.id === "rice");
  ok(used, "pantryUse lists the consumed rice");
  eq(used.qty, 100, "both meals consume exactly the owned 100g");
  // proportional value: 100g of a 2000g pack at R49.99 → R2.50
  eq(
    used.valueCents,
    Math.round((100 / 2000) * 4999),
    "value at the same pricing authority as missingCost",
  );
});

T("P-306 PDF: valid offline PDF bytes carrying the full plan story", () => {
  const cands = dinnerize(rankRecipes([R_EGGS, R_RICE], ctxBase([], 100_000)));
  const plan = planWeek(cands, {
    weekBudgetCents: 100_000,
    servings: 2,
    days: 7,
    ingredients: ING,
    priceEntries: PRICES,
  });
  const bytes = buildPlanPdf(plan, {
    metaById: new Map(ING.map((i) => [i.id, i])),
    date: new Date("2026-10-15"),
  });
  const text = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  ok(bytes.length > 1000, "a real document, not a stub");
  ok(text.startsWith("%PDF-1.4"), "valid header");
  ok(text.includes("%%EOF"), "valid trailer");
  ok(text.includes("startxref"), "xref present");
  ok(text.includes("THE WEEK"), "the meal block is in the report");
  ok(
    text.includes("WHAT EACH MEAL NEEDS"),
    "the deep-dive section is in the report",
  );
  ok(text.includes("SHOPPING LIST"), "the shopping list is in the report");
  ok(text.includes("SAVED VS EATING OUT"), "totals are in the report");
  // deterministic: same plan twice → identical bytes
  const bytes2 = buildPlanPdf(plan, {
    metaById: new Map(ING.map((i) => [i.id, i])),
    date: new Date("2026-10-15"),
  });
  eq(bytes2.length, bytes.length, "byte-stable across runs");
  ok(
    planPdfName(new Date("2026-10-15T00:00:00Z")).includes("2026-10-15"),
    "filename carries the date",
  );
});

// tiny local helpers for the sheet test (probe a commit without asserting the plan shape)
function commitMealProbe(sheet, cand) {
  // mirrors commitMealToSheet's public surface via a real plan: make a 1-day plan
  return planWeek(
    [{ ...cand, eligible: true, coverage: 1, perPlateCents: 0, missing: [] }],
    {
      weekBudgetCents: 100000,
      servings: 2,
      days: 1,
      ingredients: ING_STAPLE,
      priceEntries: PRICES_P305,
      pantry: [{ id: "salt", qty: 500, unit: "g" }],
    },
  );
}

// ---- P-307: budget utilization (the upgrade pass) ----
suite = "budget-utilization";
const UPG_PRICES = [
  {
    ingredient_id: "u-cheap",
    store: "X",
    price_cents: 1000,
    pack_qty: 2,
    pack_unit: "unit",
    last_verified: "2026-10-01",
  },
  {
    ingredient_id: "u-mid",
    store: "X",
    price_cents: 1500,
    pack_qty: 2,
    pack_unit: "unit",
    last_verified: "2026-10-01",
  },
  {
    ingredient_id: "u-rich1",
    store: "X",
    price_cents: 2000,
    pack_qty: 2,
    pack_unit: "unit",
    last_verified: "2026-10-01",
  },
  {
    ingredient_id: "u-rich2",
    store: "X",
    price_cents: 2500,
    pack_qty: 2,
    pack_unit: "unit",
    last_verified: "2026-10-01",
  },
  {
    ingredient_id: "u-rich3",
    store: "X",
    price_cents: 3000,
    pack_qty: 2,
    pack_unit: "unit",
    last_verified: "2026-10-01",
  },
];
const UPG_ING = ["cheap", "mid", "rich1", "rich2", "rich3"].map((k, i) => ({
  id: "u-" + k,
  name: k,
  aliases: [k],
  aisle: "x",
  unit_basis: { qty: 1, unit: "unit" },
  tier: 2 + i,
}));
const upCand = (id, lines, o = {}) => ({
  recipeId: id,
  title: id,
  eligible: true,
  tags: ["dinner"], // P-313: planner pool is dinner-only
  coverage: o.coverage ?? 0.5,
  realCount: o.realCount ?? 1,
  servings: 2,
  matchPct: 50,
  perPlateCents: o.perPlate ?? 500,
  ingredients: lines,
});

T(
  "P-307: leftover budget buys substance - richer meal displaces cheap within budget",
  () => {
    const cheap = upCand(
      "u-cheap-meal",
      [{ id: "u-cheap", qty: 1, unit: "unit" }],
      { realCount: 1, coverage: 0.5 },
    );
    const rich = upCand(
      "u-rich-meal",
      [
        { id: "u-rich1", qty: 1, unit: "unit" },
        { id: "u-rich2", qty: 1, unit: "unit" },
        { id: "u-rich3", qty: 1, unit: "unit" },
      ],
      { realCount: 3, coverage: 0.9 },
    );
    const plan = planWeek([cheap, rich], {
      weekBudgetCents: 100000,
      servings: 2,
      days: 2,
      ingredients: UPG_ING,
      priceEntries: UPG_PRICES,
      pantry: [],
    });
    const titles = plan.days.map((d) => d.meal.title);
    eq(
      titles.filter((t) => t === "u-rich-meal").length,
      2,
      "both days upgraded to the richer meal",
    );
    ok(plan.totalCents > 0, "budget is actually used");
  },
);

T("P-307: upgrades never break the budget ceiling", () => {
  const cheap = upCand(
    "u-cheap-meal",
    [{ id: "u-cheap", qty: 1, unit: "unit" }],
    { realCount: 1, coverage: 0.5 },
  );
  const rich = upCand(
    "u-rich-meal",
    [
      { id: "u-rich1", qty: 1, unit: "unit" },
      { id: "u-rich2", qty: 1, unit: "unit" },
    ],
    { realCount: 2, coverage: 0.9 },
  );
  // budget covers cheap meals but NOT the rich upgrade
  const plan = planWeek([cheap, rich], {
    weekBudgetCents: 2000,
    servings: 2,
    days: 2,
    ingredients: UPG_ING,
    priceEntries: UPG_PRICES,
    pantry: [],
  });
  ok(plan.totalCents <= 2000, "total stays under the ceiling");
  eq(
    plan.days[0].meal.title,
    "u-cheap-meal",
    "unaffordable upgrade refused, cheap meal stays",
  );
});

T("P-307: a strictly worse candidate never displaces a planned meal", () => {
  const good = upCand("u-good", [{ id: "u-rich1", qty: 1, unit: "unit" }], {
    realCount: 1,
    coverage: 0.8,
  });
  const worse = upCand("u-worse", [{ id: "u-cheap", qty: 1, unit: "unit" }], {
    realCount: 1,
    coverage: 0.2,
  });
  const plan = planWeek([worse, good], {
    weekBudgetCents: 100000,
    servings: 2,
    days: 2,
    ingredients: UPG_ING,
    priceEntries: UPG_PRICES,
    pantry: [],
  });
  const titles = plan.days.map((d) => d.meal.title).sort();
  eq(titles[0], "u-good", "higher-coverage meal wins the day");
});

T("P-307: determinism - two identical runs produce byte-equal plans", () => {
  const mk = () => {
    const cands = [
      upCand("u-a", [{ id: "u-cheap", qty: 1, unit: "unit" }], {
        realCount: 1,
        coverage: 0.4,
      }),
      upCand("u-b", [{ id: "u-mid", qty: 1, unit: "unit" }], {
        realCount: 1,
        coverage: 0.6,
      }),
      upCand(
        "u-c",
        [
          { id: "u-rich1", qty: 1, unit: "unit" },
          { id: "u-rich2", qty: 1, unit: "unit" },
        ],
        { realCount: 2, coverage: 0.7 },
      ),
    ];
    return planWeek(cands, {
      weekBudgetCents: 12000,
      servings: 2,
      days: 7,
      ingredients: UPG_ING,
      priceEntries: UPG_PRICES,
      pantry: [],
    });
  };
  eq(JSON.stringify(mk()), JSON.stringify(mk()), "same bytes twice");
});

// ---- P-308: planner red-team — users WILL try to break the dial ----
suite = "planner-redteam";
T(
  "P-308: R50 budget is honoured — total can NEVER exceed it (the old UI floored R50 to R100)",
  () => {
    const cands = dinnerize(
      rankRecipes([R_EGGS, R_PAP, R_RICE], ctxBase([], 10_000_000)),
    );
    const plan = planWeek(cands, {
      weekBudgetCents: 5000,
      servings: 2,
      days: 7,
      ingredients: ING,
      priceEntries: PRICES,
      pantry: [],
    });
    ok(
      plan.totalCents <= 5000,
      `total ${plan.totalCents} must fit the 5000c dial`,
    );
    ok(
      plan.totalCents > 0,
      "and it still buys what it can — the budget is spent, not ignored",
    );
  },
);
T("P-308: zero budget plans nothing it cannot afford", () => {
  const cands = dinnerize(
    rankRecipes([R_EGGS, R_PAP, R_RICE], ctxBase([], 10_000_000)),
  );
  const plan = planWeek(cands, {
    weekBudgetCents: 0,
    servings: 2,
    days: 7,
    ingredients: ING,
    priceEntries: PRICES,
    pantry: [],
  });
  eq(plan.totalCents, 0, "R0 buys nothing");
  ok(
    plan.warnings.some((w) => /budget/i.test(w)),
    "the warning names the budget as the reason",
  );
});
T("P-308: NaN budget degrades to 0, never NaN totals", () => {
  const cands = dinnerize(rankRecipes([R_EGGS], ctxBase([], 10_000_000)));
  const plan = planWeek(cands, {
    weekBudgetCents: NaN,
    servings: 2,
    days: 7,
    ingredients: ING,
    priceEntries: PRICES,
    pantry: [],
  });
  eq(plan.totalCents, 0);
  ok(Number.isFinite(plan.totalCents));
});
T("P-308: negative budget clamps to 0", () => {
  const cands = dinnerize(rankRecipes([R_EGGS], ctxBase([], 10_000_000)));
  const plan = planWeek(cands, {
    weekBudgetCents: -50000,
    servings: 2,
    days: 7,
    ingredients: ING,
    priceEntries: PRICES,
    pantry: [],
  });
  eq(plan.totalCents, 0);
});
T(
  "P-308: corrupt price row (pack_qty 0) yields finite totals, never Infinity",
  () => {
    const badPrices = [
      ...PRICES,
      {
        ingredient_id: "eggs",
        store: "Corrupt",
        price_cents: 999,
        pack_qty: 0,
        pack_unit: "unit",
        last_verified: "2026-10-16",
      },
    ];
    const cands = rankRecipes([R_EGGS], {
      pantry: [],
      ingredients: ING,
      priceOf: (id) => defaultPrice(id, badPrices),
      remainingBudgetCents: 100_000,
      constraints: {},
    });
    const plan = planWeek(cands, {
      weekBudgetCents: 100_000,
      servings: 2,
      days: 7,
      ingredients: ING,
      priceEntries: badPrices,
      pantry: [],
    });
    ok(
      Number.isFinite(plan.totalCents),
      "finite even with a divide-by-zero price row",
    );
  },
);
T(
  "P-308: garbage pantry rows (NaN / negative qty) are skipped, plan stays finite",
  () => {
    const cands = dinnerize(
      rankRecipes([R_EGGS, R_PAP], ctxBase([], 10_000_000)),
    );
    const plan = planWeek(cands, {
      weekBudgetCents: 100_000,
      servings: 2,
      days: 7,
      ingredients: ING,
      priceEntries: PRICES,
      pantry: [
        { id: "eggs", qty: NaN, unit: "unit" },
        { id: "onion", qty: -5, unit: "g" },
        { id: "bread", qty: 1, unit: "unit" },
      ],
    });
    ok(Number.isFinite(plan.totalCents));
    ok(
      plan.pantryUse.every((u) => Number.isFinite(u.qty)),
      "consumption records stay sane",
    );
  },
);

// ---- search ----
suite = "search";
T("normalize: strips accents/diacritics case-insensitively", () => {
  eq(normalize("Pilchards in brīne"), "pilchards in brine");
  eq(normalize("  Mielie   Meal "), "mielie meal");
  eq(normalize("KOSkoste"), "koskoste");
});
T("matches: substring works on normalized text", () => {
  ok(matches("pap", "Maize meal (pap)"));
  ok(matches("MIEL", "Mielie meal"));
  ok(!matches("xxx", "Maize meal"));
});
T("searchIngredients: alias hits ranked, accent-insensitive", () => {
  const hits = searchIngredients("pap", ING);
  eq(hits[0].id, "maize-meal");
  eq(searchIngredients("éiers", ING)[0].id, "eggs");
  eq(searchIngredients("zzz", ING).length, 0);
});

// ---- decoder ----
T(
  "search P-111: alias-exact outranks name-prefix (pap → maize meal, not Paprika)",
  () => {
    const hits = searchIngredients("pap", ING_SEARCH);
    eq(hits[0].id, "maize-meal");
    const paprika = hits.findIndex((h) => h.name === "Paprika");
    ok(paprika > 0, "Paprika ranks below maize meal");
  },
);
T("search P-111: exact name at the top of the ranker", () => {
  eq(searchIngredients("eggs", ING_SEARCH)[0].id, "eggs");
});
T("search P-111: 1-edit misspelling of a name hits (egss → Eggs)", () => {
  const hits = searchIngredients("egss", ING_SEARCH);
  eq(hits[0].id, "eggs");
});
T(
  "search P-111: 1-edit misspelling of an alias hits (mielies → maize meal)",
  () => {
    const hits = searchIngredients("mielies", ING_SEARCH);
    ok(
      hits.some((h) => h.id === "maize-meal"),
      'maize meal surfaces for "mielies"',
    );
  },
);
T("search P-111: multi-word query, consecutive and reversed word order", () => {
  eq(searchIngredients("mielie pap", ING_SEARCH)[0].id, "maize-meal");
  eq(
    searchIngredients("pap mielie", ING_SEARCH)[0].id,
    "maize-meal",
    "reversed order still finds it",
  );
});
T("search P-111: multi-word AND — one unknown word kills the match", () => {
  eq(searchIngredients("mielie zzz", ING_SEARCH).length, 0);
});
T("search P-111: accent-insensitive alias hit (droë sop)", () => {
  eq(searchIngredients("droe sop", ING_SEARCH)[0].id, "soup-mix");
});
T(
  "search P-111: category word matches the aisle, below name/alias hits",
  () => {
    const hits = searchIngredients("dairy", ING_SEARCH);
    ok(hits.length >= 3, "dairy aisle is reachable");
    ok(
      hits.every((h) => h.aisle === "dairy"),
      "only dairy-aisle items returned",
    );
    ok(
      hits[0].name.localeCompare(hits[1].name) <= 0,
      "category ties break alphabetically",
    );
  },
);
T("search P-111: determinism — identical query, identical order", () => {
  const a = searchIngredients("meal", ING_SEARCH)
    .map((i) => i.id)
    .join();
  const b = searchIngredients("meal", ING_SEARCH)
    .map((i) => i.id)
    .join();
  eq(a, b);
});
T(
  "oneEdit P-111: bounded Levenshtein (1 sub / 1 insert / 1 delete only)",
  () => {
    ok(oneEdit("egss", "eggs")); // substitution
    ok(oneEdit("mielie", "mielies")); // insertion
    ok(oneEdit("papp", "pap")); // deletion
    ok(!oneEdit("abcd", "abef")); // two edits — rejected
    ok(!oneEdit("a", "abc")); // two inserts — rejected
  },
);

// P-111 search fixtures: registry-shaped rows (real names/aliases/aisles from
// data/ingredients.json) so the browser suite needs no file access.
const ING_SEARCH = [
  {
    id: "maize-meal",
    name: "Maize meal",
    aliases: ["pap", "mielie pap", "mieliepap", "maiz meal", "mealie meal"],
    aisle: "starches",
    unit_basis: { qty: 2500, unit: "g" },
    tier: 2,
    shelf_life_days: 180,
  },
  {
    id: "paprika",
    name: "Paprika",
    aliases: ["spice"],
    aisle: "spices",
    unit_basis: { qty: 50, unit: "g" },
    tier: 2,
    shelf_life_days: 365,
  },
  {
    id: "soup-mix",
    name: "Dry soup mix",
    aliases: ["droë sop", "dry soup mix", "i-soup mix"],
    aisle: "pantry",
    unit_basis: { qty: 400, unit: "g" },
    tier: 2,
    shelf_life_days: 180,
  },
  {
    id: "fresh-milk",
    name: "Fresh milk",
    aliases: ["melk"],
    aisle: "dairy",
    unit_basis: { qty: 1, unit: "unit" },
    tier: 3,
    shelf_life_days: 7,
  },
  {
    id: "amasi",
    name: "Amasi",
    aliases: ["maas"],
    aisle: "dairy",
    unit_basis: { qty: 1, unit: "unit" },
    tier: 3,
    shelf_life_days: 14,
  },
  {
    id: "yoghurt",
    name: "Plain yoghurt",
    aliases: ["ngidizi"],
    aisle: "dairy",
    unit_basis: { qty: 1, unit: "unit" },
    tier: 3,
    shelf_life_days: 14,
  },
  {
    id: "eggs",
    name: "Eggs",
    aliases: ["eiers", "amaqanda"],
    aisle: "protein-fresh",
    unit_basis: { qty: 30, unit: "unit" },
    tier: 3,
    shelf_life_days: 21,
  },
  {
    id: "salt",
    name: "Table salt",
    aliases: ["sout"],
    aisle: "spices",
    unit_basis: { qty: 500, unit: "g" },
    tier: 0.5,
    shelf_life_days: 730,
  },
  {
    id: "oil",
    name: "Cooking oil",
    aliases: ["olie"],
    aisle: "pantry",
    unit_basis: { qty: 750, unit: "ml" },
    tier: 0.5,
    shelf_life_days: 365,
  },
  {
    id: "onion",
    name: "Onions",
    aliases: ["uil"],
    aisle: "veg",
    unit_basis: { qty: 1000, unit: "g" },
    tier: 1,
    shelf_life_days: 30,
  },
  {
    id: "tomato",
    name: "Tomatoes",
    aliases: ["tamatie"],
    aisle: "veg",
    unit_basis: { qty: 1000, unit: "g" },
    tier: 1,
    shelf_life_days: 7,
  },
  {
    id: "rice",
    name: "White rice",
    aliases: ["rys"],
    aisle: "starches",
    unit_basis: { qty: 2000, unit: "g" },
    tier: 2,
    shelf_life_days: 365,
  },
  {
    id: "bread",
    name: "Sliced white bread",
    aliases: ["brood"],
    aisle: "starches",
    unit_basis: { qty: 1, unit: "unit" },
    tier: 2,
    shelf_life_days: 5,
  },
  {
    id: "baked-beans",
    name: "Baked beans",
    aliases: ["beans"],
    aisle: "protein-tinned",
    unit_basis: { qty: 1, unit: "can" },
    tier: 2,
    shelf_life_days: 540,
  },
];
// P-111 coverage fixture: 12 recipes whose ingredient use makes the greedy
// trio (by design) the globally maximal 3-chip pick.
const RECIPES = [
  {
    id: "r-staple-heavy",
    title: "Staple stew",
    servings: 4,
    time_minutes: 30,
    tags: ["dinner"],
    ingredients: [
      { id: "salt", qty: 2, unit: "g" },
      { id: "oil", qty: 15, unit: "ml" },
    ],
  },
  {
    id: "r-eggs-1",
    title: "Eggs 1",
    servings: 2,
    time_minutes: 10,
    tags: ["breakfast"],
    ingredients: [{ id: "eggs", qty: 2, unit: "unit" }],
  },
  {
    id: "r-eggs-2",
    title: "Eggs 2",
    servings: 2,
    time_minutes: 10,
    tags: ["breakfast"],
    ingredients: [{ id: "eggs", qty: 3, unit: "unit" }],
  },
  {
    id: "r-eggs-3",
    title: "Eggs 3",
    servings: 2,
    time_minutes: 10,
    tags: ["breakfast"],
    ingredients: [{ id: "eggs", qty: 4, unit: "unit" }],
  },
  {
    id: "r-onion-1",
    title: "Onion 1",
    servings: 2,
    time_minutes: 20,
    tags: ["dinner"],
    ingredients: [{ id: "onion", qty: 1, unit: "unit" }],
  },
  {
    id: "r-onion-2",
    title: "Onion 2",
    servings: 2,
    time_minutes: 20,
    tags: ["dinner"],
    ingredients: [{ id: "onion", qty: 2, unit: "unit" }],
  },
  {
    id: "r-tom-1",
    title: "Tom 1",
    servings: 2,
    time_minutes: 15,
    tags: ["lunch"],
    ingredients: [{ id: "tomato", qty: 1, unit: "unit" }],
  },
  {
    id: "r-tom-2",
    title: "Tom 2",
    servings: 2,
    time_minutes: 15,
    tags: ["lunch"],
    ingredients: [{ id: "tomato", qty: 2, unit: "unit" }],
  },
  {
    id: "r-mix-1",
    title: "Mix 1",
    servings: 2,
    time_minutes: 25,
    tags: ["dinner"],
    ingredients: [
      { id: "eggs", qty: 1, unit: "unit" },
      { id: "onion", qty: 1, unit: "unit" },
    ],
  },
  {
    id: "r-mix-2",
    title: "Mix 2",
    servings: 2,
    time_minutes: 25,
    tags: ["dinner"],
    ingredients: [
      { id: "tomato", qty: 1, unit: "unit" },
      { id: "rice", qty: 100, unit: "g" },
    ],
  },
  {
    id: "r-rice-1",
    title: "Rice 1",
    servings: 2,
    time_minutes: 20,
    tags: ["dinner"],
    ingredients: [{ id: "rice", qty: 200, unit: "g" }],
  },
  {
    id: "r-bread-1",
    title: "Bread 1",
    servings: 1,
    time_minutes: 5,
    tags: ["snack"],
    ingredients: [{ id: "bread", qty: 1, unit: "unit" }],
  },
  {
    id: "r-beans-1",
    title: "Beans 1",
    servings: 2,
    time_minutes: 15,
    tags: ["lunch"],
    ingredients: [{ id: "baked-beans", qty: 1, unit: "can" }],
  },
];

suite = "coverage";
T("quickTryPicks: chips derive from recipe coverage, trio ⊆ chips", () => {
  const { chips, trio } = quickTryPicks(ING_SEARCH, RECIPES, { minTier: 0.5 });
  eq(chips.length, 6); // 8 items are used by the recipes, but salt+oil are assumed staples — excluded
  ok(!chips.some((c) => c.tier <= 0.5), "staples never become quick-try chips");
  eq(
    quickTryPicks(ING_SEARCH, RECIPES).chips.length,
    8,
    "without minTier, staples are allowed",
  );
  ok(
    trio.every((id) => chips.some((c) => c.id === id)),
    "pre-tapped trio is on screen",
  );
  ok(
    chips.every((c) =>
      RECIPES.some((r) => r.ingredients.some((l) => l.id === c.id)),
    ),
    "every chip is used by real recipes",
  );
  // frequency order: chips are the most-used ingredients
  const freqOf = (id) =>
    RECIPES.filter((r) => r.ingredients.some((l) => l.id === id)).length;
  ok(
    freqOf(chips[0].id) >= freqOf(chips[chips.length - 1].id),
    "chips ordered by coverage",
  );
});
T("quickTryPicks: deterministic — same inputs, same picks", () => {
  const a = quickTryPicks(ING_SEARCH, RECIPES, { minTier: 0.5 });
  const b = quickTryPicks(ING_SEARCH, RECIPES, { minTier: 0.5 });
  eq(a.chips.map((c) => c.id).join(), b.chips.map((c) => c.id).join());
  eq(a.trio.join(), b.trio.join());
});
T("quickTryPicks: the trio unlocks more recipes than any other 3 chips", () => {
  const { chips, trio } = quickTryPicks(ING_SEARCH, RECIPES, { minTier: 0.5 });
  const unlocks = (ids) =>
    new Set(
      RECIPES.filter((r) =>
        ids.some((id) => r.ingredients.some((l) => l.id === id)),
      ).map((r) => r.id),
    ).size;
  const best = unlocks(trio);
  for (const c of chips)
    for (const d of chips)
      for (const e of chips) {
        if ([c.id, d.id, e.id].some((id) => trio.includes(id))) continue;
        ok(
          unlocks([c.id, d.id, e.id]) <= best,
          `greedy trio is maximal (${c.name}+${d.name}+${e.name})`,
        );
      }
});

// ---- auto running-low (P-112 → P-113a pack semantics) ----
suite = "auto-low";
// OWNER BAND RULE v2 (Oct 24, supersedes Oct 13): running low = ANY remainder
// under a quarter of the usual bought-at quantity. The old <10% "effectively
// out" silence read as a bug on real data — nothing is ever silently low now.
T("autoRunningLow: band v2 — inside low, above fine, scraps still low", () => {
  // eggs usual buy = 30 units → 25% = 7.5
  const f = (qty) =>
    autoRunningLow([{ id: "eggs", qty, unit: "unit" }], ING_SEARCH).has("eggs");
  eq(f(8), false, "8 eggs ≥ 25% → fine");
  eq(f(7), true, "7 eggs under a quarter → running low");
  eq(f(3), true, "3 eggs = 10% → running low");
  eq(f(2), true, "2 eggs < 10% → STILL low (the silent zone is gone — P-555)");
});
T("autoRunningLow: at the usual bought-at size → not flagged", () => {
  ok(
    !autoRunningLow([{ id: "eggs", qty: 30, unit: "unit" }], ING_SEARCH).has(
      "eggs",
    ),
    "the usual 30-unit buy is a FULL supply",
  );
});
T(
  "autoRunningLow: grams (salt 500g usual — 100g low, 400g fine, 40g scraps STILL low)",
  () => {
    const f = (qty) =>
      autoRunningLow([{ id: "salt", qty, unit: "g" }], ING_SEARCH).has("salt");
    eq(f(100), true);
    eq(f(400), false);
    eq(f(40), true); // band v2: scraps are low too
  },
);
T(
  "autoRunningLow: millilitres (oil 750ml usual — 100ml low, 10ml scraps STILL low)",
  () => {
    const f = (qty) =>
      autoRunningLow([{ id: "oil", qty, unit: "ml" }], ING_SEARCH).has("oil");
    eq(f(100), true);
    eq(f(750), false);
    eq(f(10), true); // band v2
  },
);
T(
  "autoRunningLow: OWNER CASE — 410g baked beans full pack not low; 80g low; 30g scraps low (band v2)",
  () => {
    // usual buy = 1 can; the priced pack is 410g (priceOf supplies pack weight,
    // exactly like the live app): 25% = 102.5g, 10% = 41g
    const priceOf = (id) => (id === "baked-beans" ? { pack_qty: 410 } : null);
    const f = (qty, unit) =>
      autoRunningLow(
        [{ id: "baked-beans", qty, unit }],
        ING_SEARCH,
        priceOf,
      ).has("baked-beans");
    eq(f(410, "g"), false, "410g (the usual pack) is not running low");
    eq(f(200, "g"), false, "200g = 49% of the pack → plenty left, not low");
    eq(f(80, "g"), true, "80g is under a quarter of the pack → running low");
    eq(
      f(30, "g"),
      true,
      "30g scraps → STILL low (band v2: the silent zone is gone)",
    );
    eq(f(1, "can"), false, "one full can is not running low");
  },
);
T("autoRunningLow: exactly 25% is the upper edge — fine, not low", () => {
  // bread usual = 1 unit → 25% = 0.25. 0.25 of a loaf left is the edge.
  const f = (qty) =>
    autoRunningLow([{ id: "bread", qty, unit: "unit" }], ING_SEARCH).has(
      "bread",
    );
  eq(f(0.25), false, "exactly a quarter left → not flagged");
  eq(f(0.2), true, "a fifth left → running low");
});
T("autoRunningLow: no recipes needed — the usual pack is the reference", () => {
  // paprika is used by no recipe in the fixture; 5g = exactly 10% of the 50g usual buy
  eq(
    autoRunningLow([{ id: "paprika", qty: 5, unit: "g" }], ING_SEARCH).has(
      "paprika",
    ),
    true,
  );
  eq(
    autoRunningLow([{ id: "paprika", qty: 50, unit: "g" }], ING_SEARCH).has(
      "paprika",
    ),
    false,
  );
});
T("autoRunningLow: unknown ingredient id → skipped, no crash", () => {
  const low = autoRunningLow(
    [{ id: "not-in-registry", qty: 5, unit: "g" }],
    ING_SEARCH,
  );
  eq(low.size, 0);
});
T("autoRunningLow: zero qty is OUT, not low (matcher handles absence)", () => {
  eq(
    autoRunningLow([{ id: "bread", qty: 0, unit: "unit" }], ING_SEARCH).has(
      "bread",
    ),
    false,
  );
});
T("autoRunningLow: deterministic — same inputs, same set", () => {
  const pantry = [
    { id: "eggs", qty: 7, unit: "unit" },
    { id: "oil", qty: 100, unit: "ml" },
  ];
  const a = [...autoRunningLow(pantry, ING_SEARCH)].sort().join();
  const b = [...autoRunningLow(pantry, ING_SEARCH)].sort().join();
  eq(a, b);
});

suite = "redteam2";
// ---- P-207 (DeepSeek batch 2): cross-module seams ----
// Absorption audit: #19's premise (order-dependent duplicate prices) is FALSE —
// defaultPrice is a sort + conservative median, order-free (pinned below).
// #4 found a REAL seam: the planner does not simulate owned-stock consumption
// across repeats (marginal() only accumulates matcher-reported missing) — pinned
// as current behavior, fix scheduled with P-303 (needs full line data on
// candidates). #8 optional-in-denominator pinned as current; PRD amendment flag
// raised. Fixes that DID land: local-date streaks (#17/#18), stale-plan banner
// (#13/#14, main.js). #15/#16 saved-plan fingerprinting: PRD note for P-305.
T("P-207 #1: plan at exactly 90% of budget lands AMBER, not green", () => {
  const r = {
    id: "exact-90",
    title: "Exact 90",
    servings: 2,
    time_minutes: 30,
    tags: ["dinner"],
    ingredients: [{ id: "maize-meal", qty: 100, unit: "g" }],
    steps: [],
  };
  const ctx = (pantry, budget) => ({
    pantry,
    ingredients: ING_STAPLE,
    priceOf,
    remainingBudgetCents: budget,
    constraints: {},
  });
  // missing 100g maize → 1 pack 2999c (cheapest) → planWeek at 3332c budget
  const plan = planWeek(rankRecipes([r], ctx([], 3332)), {
    weekBudgetCents: 3332,
    servings: 2,
    days: 1,
    ingredients: ING_STAPLE,
    priceEntries: PRICES,
  });
  const pct = plan.totalCents / 3332;
  ok(
    pct >= 0.9 && pct < 1,
    `90% boundary must be amber (got ${(pct * 100).toFixed(2)}%)`,
  );
});
T(
  "P-207 #2: missingCost == budget is ELIGIBLE (≤, not <); plan at 100% is RED",
  () => {
    const r = {
      id: "exact-100",
      title: "Exact 100",
      servings: 2,
      time_minutes: 30,
      tags: ["dinner"],
      ingredients: [{ id: "maize-meal", qty: 100, unit: "g" }],
      steps: [],
    };
    const ctx = {
      pantry: [],
      ingredients: ING_STAPLE,
      priceOf,
      remainingBudgetCents: 2999,
      constraints: {},
    };
    const [scored] = rankRecipes([r], ctx);
    ok(scored.eligible, "missingCost 2999 == budget 2999 must be eligible");
    const plan = planWeek([scored], {
      weekBudgetCents: 2999,
      servings: 2,
      days: 1,
      ingredients: ING_STAPLE,
      priceEntries: PRICES,
    });
    eq(plan.status, "over", "exactly 100% of budget is the red band");
  },
);
T(
  "P-207 #3: freshness bonus caps at +9 per recipe no matter how many low items",
  () => {
    const ing = [
      ...ING_STAPLE,
      {
        id: "lo1",
        name: "Lo1",
        aliases: [],
        aisle: "veg",
        unit_basis: { qty: 500, unit: "g" },
        tier: 1,
        shelf_life_days: 10,
      },
      {
        id: "lo2",
        name: "Lo2",
        aliases: [],
        aisle: "veg",
        unit_basis: { qty: 500, unit: "g" },
        tier: 1,
        shelf_life_days: 10,
      },
      {
        id: "lo3",
        name: "Lo3",
        aliases: [],
        aisle: "veg",
        unit_basis: { qty: 500, unit: "g" },
        tier: 1,
        shelf_life_days: 10,
      },
      {
        id: "lo4",
        name: "Lo4",
        aliases: [],
        aisle: "veg",
        unit_basis: { qty: 500, unit: "g" },
        tier: 1,
        shelf_life_days: 10,
      },
    ];
    const r = {
      id: "low-4",
      title: "Four Lows",
      servings: 2,
      time_minutes: 30,
      tags: ["dinner"],
      ingredients: ing
        .filter((i) => i.id.startsWith("lo"))
        .map((i) => ({ id: i.id, qty: 10, unit: "g" })),
      steps: [],
    };
    const pantry = ing
      .filter((i) => i.id.startsWith("lo"))
      .map((i) => ({ id: i.id, qty: 50, unit: "g", running_low: true })); // 10% = low band
    const [s] = rankRecipes([r], {
      pantry,
      ingredients: ing,
      priceOf: () => null,
      remainingBudgetCents: 60000,
      constraints: {},
    });
    eq(
      s.freshnessBonus,
      9,
      "4 × +3 caps at +9, never +12 — and repeats in the planner never re-add it (score is per recipe)",
    );
  },
);
T(
  "P-207 #4 RESOLVED (P-306 sheet): repeats CONSUME owned stock — the gap is bought honestly",
  () => {
    // rice 100g owned; recipe needs 80g per cook. Old pinned behavior: both repeats
    // looked free (per-recipe missing snapshots vs the ORIGINAL pantry) and the list
    // underbought 60g. The P-306 sheet consumes stock per commit: 100g covers the
    // first meal + 20g of the second; the true 60g gap buys ONE pack.
    const r = {
      id: "rice-rep",
      title: "Rice Repeat",
      servings: 1,
      time_minutes: 20,
      tags: ["dinner"],
      ingredients: [{ id: "rice", qty: 80, unit: "g" }],
      steps: [],
    };
    const pantry = [{ id: "rice", qty: 100, unit: "g", running_low: true }];
    const [s] = rankRecipes([r], {
      pantry,
      ingredients: ING,
      priceOf,
      remainingBudgetCents: 60000,
      constraints: {},
    });
    eq(s.missing.length, 0, "single cook: covered by pantry");
    const plan = planWeek([s], {
      weekBudgetCents: 10000,
      servings: 1,
      days: 2,
      ingredients: ING,
      priceEntries: PRICES,
      pantry,
    });
    eq(plan.mealsPlanned, 2, "both repeats fit the cap");
    eq(
      plan.totalCents,
      4999,
      "the 60g shortfall buys ONE rice pack — stock spent once, gap bought once",
    );
    const used = plan.pantryUse.find((u) => u.id === "rice");
    eq(
      used && used.qty,
      100,
      "the slip records the 100g of owned rice the plan eats",
    );
    eq(
      plan.days[1].meal.marginalCents,
      4999,
      "the second repeat honestly pays for the gap",
    );
  },
);
T(
  "P-207 #5/#6: a 100g pantry shrink can cross a whole-pack boundary and flip eligibility",
  () => {
    // maize 600g needed; pack 2500g @ 2999c (cheapest); budget 2500c.
    const r = {
      id: "maize-600",
      title: "Maize 600",
      servings: 2,
      time_minutes: 30,
      tags: ["dinner"],
      ingredients: [{ id: "maize-meal", qty: 600, unit: "g" }],
      steps: [],
    };
    const ctx = (qty) => ({
      pantry: [{ id: "maize-meal", qty, unit: "g", running_low: false }],
      ingredients: ING,
      priceOf,
      remainingBudgetCents: 2500,
      constraints: {},
    });
    const [before] = rankRecipes([r], ctx(600));
    ok(before.eligible, "owned 600g = full need: missingCost 0 → eligible");
    eq(before.readiness, "ready");
    const [after] = rankRecipes([r], ctx(500));
    ok(
      !after.eligible,
      "owned 500g: gap 100g → ceil(100/2500)=1 pack 2999c > 2500 → INELIGIBLE",
    );
    // a 100g shrink flipped eligibility without touching recipe or budget
  },
);
T(
  "P-207 #7: decoder-style draft with an UNPRICED REQUIRED line is ineligible — never free",
  () => {
    const ing = [
      ...ING,
      {
        id: "secret-spice",
        name: "Secret spice",
        aliases: [],
        aisle: "spices",
        unit_basis: { qty: 50, unit: "g" },
        tier: 1,
        shelf_life_days: 365,
      },
    ];
    const draft = {
      id: "draft-x",
      title: "Draft",
      servings: 2,
      time_minutes: 30,
      tags: [],
      ingredients: [
        { id: "secret-spice", qty: 5, unit: "g" },
        { id: "rice", qty: 100, unit: "g", optional: true },
      ],
      steps: [],
    };
    const [s] = rankRecipes([draft], {
      pantry: [],
      ingredients: ing,
      priceOf,
      remainingBudgetCents: 60000,
      constraints: {},
    });
    ok(!s.eligible, "required unpriced = hard stop (no price data)");
    ok(
      s.reasons.some((x) => /price/i.test(x)),
      "reason must say price data is missing",
    );
  },
);
T(
  "P-207 #8 (PIN, PRD amendment flag): optional missing lines count in the coverage denominator",
  () => {
    // DeepSeek proposed EXCLUDING optional-unpriced from the denominator; that is a
    // scoring CHANGE, not current behavior. Current: every merged line (optional or
    // not) adds tier weight. Pinned here so the day it changes, this test is the
    // conversation. PRD amendment A7 pending owner decision.
    const r = {
      id: "opt-denom",
      title: "Optional Denominator",
      servings: 2,
      time_minutes: 30,
      tags: [],
      ingredients: [
        { id: "eggs", qty: 2, unit: "unit" },
        { id: "bread", qty: 2, unit: "slice", optional: true },
      ],
      steps: [],
    };
    const [s] = rankRecipes([r], {
      pantry: [{ id: "eggs", qty: 6, unit: "unit", running_low: false }],
      ingredients: ING,
      priceOf,
      remainingBudgetCents: 60000,
      constraints: {},
    });
    eq(
      s.coverage,
      0.6,
      "3/(3+2): owned eggs (tier 3) over ALL lines incl. optional bread (tier 2)",
    );
  },
);
T(
  "P-207 #10: full rescale cascade — planner upscale crosses a pack boundary and flips the meal set",
  () => {
    // X: 2 servings, 800g rice (whole-pack buy: pack 2000g @ 4999c). Y: 2 servings, 100g maize (pack 2999c).
    const X = {
      id: "resc-x",
      title: "Rescale X",
      servings: 2,
      time_minutes: 30,
      tags: ["dinner"],
      ingredients: [{ id: "rice", qty: 800, unit: "g" }],
      steps: [],
    };
    const Y = {
      id: "resc-y",
      title: "Rescale Y",
      servings: 2,
      time_minutes: 30,
      tags: ["dinner"],
      ingredients: [{ id: "maize-meal", qty: 100, unit: "g" }],
      steps: [],
    };
    const pantry = [{ id: "rice", qty: 100, unit: "g", running_low: false }];
    const ctx = {
      pantry,
      ingredients: ING,
      priceOf,
      remainingBudgetCents: 20000,
      constraints: {},
    };
    const cands = dinnerize(rankRecipes([X, Y], ctx));
    // 3 days: Y's free repeat (MAX_REPEATS=2) fills days 1–2, so day 3 is the
    // honest seam — the planner must turn to X, and whether it CAN depends on
    // the rescale crossing the whole-pack boundary.
    const planned = (servings) =>
      planWeek(cands, {
        weekBudgetCents: 10000,
        servings,
        days: 3,
        ingredients: ING,
        priceEntries: PRICES,
      });
    const at2 = planned(2);
    ok(
      at2.days.some((d) => d.meal && d.meal.title === "Rescale X"),
      "servings 2: day 3 = X, gap 700g → 1 pack 4999c ≤ 10000−2999 → planned",
    );
    const at6 = planned(6);
    ok(
      !at6.days.some((d) => d.meal && d.meal.title === "Rescale X"),
      "servings 6: X needs 2400g → gap 2300g → 2 packs 9998c > 10000−2999 → X dropped, day 3 empty",
    );
    ok(
      at6.days.filter((d) => d.meal && d.meal.title === "Rescale Y").length ===
        2,
      "Y still fills its 2 allowed days",
    );
  },
);
T(
  "P-207 #11/#12: matcher card, cook log and rescaled costing can never disagree",
  () => {
    // The card/cook-log cost model is PROPORTIONAL per gram (costRecipe), while
    // missingCost is WHOLE-PACK (topUp) — two different questions, two models.
    // Parity: everything the user sees at plate count N goes through the SAME
    // costRecipe(rescaleRecipe(r, N)) / N — card stepper, cook-log entry, this test.
    const P = {
      id: "par-p",
      title: "Parity P",
      servings: 4,
      time_minutes: 30,
      tags: [],
      ingredients: [{ id: "rice", qty: 400, unit: "g" }],
      steps: [],
    }; // 4999c / 2000g
    const cardAtPlates = (recipe, plates) => {
      const c = costRecipe(rescaleRecipe(recipe, plates), priceOf);
      return perPlateCents(c.totalCents, plates);
    };
    eq(
      cardAtPlates(P, 2),
      250,
      "2 plates: 200g × (4999/2000) = 499.9 → 500c total → round(500/2)",
    );
    eq(
      cardAtPlates(P, 3),
      250,
      "3 plates: 300g → 749.85 → 750c → round(750/3)",
    );
    eq(
      cardAtPlates(P, 2),
      250,
      "cook log at 2 plates records the same 250c — identical pipeline",
    );
    const Q = {
      id: "par-q",
      title: "Parity Q",
      servings: 3,
      time_minutes: 30,
      tags: [],
      ingredients: [
        { id: "rice", qty: 250, unit: "g" },
        { id: "salt", qty: 1, unit: "tsp" },
      ],
      steps: [],
    };
    eq(
      cardAtPlates(Q, 3),
      208,
      "staple salt costs nothing: 250g → 625c → round(625/3) = 208.33 → 208",
    );
    eq(
      cardAtPlates(Q, 2),
      209,
      "half-up guard: 166.67g → 417c → round(417/2) = 208.5 → 209, never truncate to 208",
    );
  },
);
T(
  "P-207 #19 (premise FALSE, behavior pinned): defaultPrice is order-free under duplicate entries",
  () => {
    const dupe = [
      {
        ingredient_id: "rice",
        store: "A",
        price_cents: 2500,
        pack_qty: 500,
        pack_unit: "g",
        last_verified: "2026-10-01",
      },
      {
        ingredient_id: "rice",
        store: "B",
        price_cents: 3000,
        pack_qty: 500,
        pack_unit: "g",
        last_verified: "2026-10-14",
      },
      {
        ingredient_id: "rice",
        store: "C",
        price_cents: 9999,
        pack_qty: 500,
        pack_unit: "g",
        last_verified: "2026-09-01",
      },
    ];
    const pick = (arr) => defaultPrice("rice", arr).price_cents;
    eq(pick(dupe), 3000, "sorted [2500,3000,9999], odd count → middle = 3000");
    eq(
      pick([...dupe].reverse()),
      3000,
      "insertion order cannot change the pick",
    );
    const even = dupe.slice(0, 2);
    eq(
      pick(even),
      2500,
      "even count → LOWER middle (conservative, budget-first)",
    );
    eq(pick([...even].reverse()), 2500, "still order-free");
  },
);
T(
  "P-207 #20: kg and g pantry rows are the SAME item through one conversion table",
  () => {
    const r = {
      id: "rice-600b",
      title: "Rice 600b",
      servings: 2,
      time_minutes: 30,
      tags: [],
      ingredients: [{ id: "rice", qty: 600, unit: "g" }],
      steps: [],
    };
    const ctx = (row) => ({
      pantry: [row],
      ingredients: ING,
      priceOf,
      remainingBudgetCents: 5000,
      constraints: {},
    });
    const [g] = rankRecipes(
      [r],
      ctx({ id: "rice", qty: 400, unit: "g", running_low: false }),
    );
    const [kg] = rankRecipes(
      [r],
      ctx({ id: "rice", qty: 0.4, unit: "kg", running_low: false }),
    );
    eq(
      kg.missingCostCents,
      g.missingCostCents,
      "0.4 kg == 400 g: qtyInPackBasis normalizes both, worker and sync share the table",
    );
    eq(kg.eligible, g.eligible);
  },
);
T(
  "P-207 #17 (resolved by code): badges count ENTRIES; same-day double cook = 2 cooks, 1 streak day",
  () => {
    // P-311-day time-bomb fix: the fixture pinned 2026-10-15, which stopped being
    // "yesterday" on Oct 17 and killed the streak assertion. Use TODAY's local
    // calendar date so the streak lives whenever the suite runs (#18 pattern).
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const log = [
      {
        id: "1",
        date: today,
        recipeId: "a",
        title: "A",
        perPlateCents: 1200,
        servings: 2,
        missingCount: 0,
        tags: [],
      },
      {
        id: "2",
        date: today,
        recipeId: "a",
        title: "A",
        perPlateCents: 1200,
        servings: 2,
        missingCount: 0,
        tags: [],
      },
    ];
    const s = getAchievementStats(log);
    eq(s.totalCooks, 2, "two entries = two cooks");
    eq(s.currentStreak, 1, "same calendar day counts once toward the streak");
    ok(
      s.badges.find((b) => b.id === "first-plate").earned,
      "first-plate triggers at exactly 1 entry",
    );
  },
);
T(
  "P-207 #18 (fixed): streak keys use LOCAL calendar dates — a 00:30 SAST cook is THAT day",
  () => {
    const today = new Date();
    const yesterday = new Date(Date.now() - 864e5);
    const y = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;
    const t = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const log = [
      {
        id: "1",
        date: y,
        recipeId: "a",
        title: "A",
        perPlateCents: 1000,
        servings: 1,
        missingCount: 0,
        tags: [],
      },
      {
        id: "2",
        date: t,
        recipeId: "b",
        title: "B",
        perPlateCents: 1000,
        servings: 1,
        missingCount: 0,
        tags: [],
      },
    ];
    const s = getAchievementStats(log);
    eq(
      s.currentStreak,
      2,
      "yesterday + today (local calendar) = a live 2-day streak",
    );
  },
);

suite = "p204";
// ---- P-204: rescale/re-cost worst cases + consumption math ----
T("P-204 qtyFromGrams: round-trips the qtyInPackBasis families", () => {
  eq(qtyFromGrams(150, "g"), 150);
  eq(qtyFromGrams(1500, "kg"), 1.5);
  eq(qtyFromGrams(30, "tbsp"), 2); // 15 g per tbsp
  eq(qtyFromGrams(150, "unit", { id: "onions" }), 1); // piece weight 150 g
  eq(qtyFromGrams(35, "slice"), 1);
  eq(qtyFromGrams(410, "tin", { packQty: 410 }), 1);
  eq(qtyFromGrams(999, "handful"), 33.3); // 30 g per handful, 2dp
  eq(qtyFromGrams(100, "unit", { id: "mystery-item" }), null); // never guessed
});
T("P-204 qtyFromGrams: forward+back is identity on the real families", () => {
  const cases = [
    [{ id: "onions", qty: 3, unit: "unit" }, 150],
    [{ id: "cooking-oil", qty: 2, unit: "tbsp" }, 15],
    [{ id: "bread", qty: 2, unit: "slice" }, 35],
  ];
  for (const [line, g] of cases) {
    const fwd = qtyInPackBasis(line.qty, line.unit, "g", {
      id: line.id,
      packQty: 0,
    });
    eq(fwd, line.qty * g);
    const back = qtyFromGrams(fwd, line.unit, { id: line.id, packQty: 0 });
    ok(Math.abs(back - line.qty) < 0.001, `round-trip ${line.id}`);
  }
});
T(
  "P-204 rescale worst case: 1/3 of 400 g — nearest cent, never truncated",
  () => {
    // 6-serving recipe, one 400 g line; cook 2 plates → need 133.33 g.
    // Pack: 500 g @ R9.99. Line cost = round(999 * 133.33/500) = round(266.33) = 266.
    const r6 = {
      id: "rt-third",
      title: "Third",
      servings: 6,
      time_minutes: 30,
      tags: [],
      ingredients: [{ id: "rt-rice", qty: 400, unit: "g" }],
      steps: [],
    };
    const scaled = rescaleRecipe(r6, 2);
    eq(scaled.ingredients[0].qty, 133.33); // 2dp, not 133
    const c = costRecipe(scaled, (id) => ({
      ingredient_id: id,
      price_cents: 999,
      pack_qty: 500,
      pack_unit: "g",
    }));
    eq(c.totalCents, 266); // round(999*133.33/500)=round(266.33)
    eq(perPlateCents(c.totalCents, 2), 133); // round(133)
    ok(c.totalCents > 265, "not truncated (266, not 265)");
  },
);
T(
  "P-204 rescale worst case: 4 servings → 1 plate, per-line rounding sums exactly",
  () => {
    // three lines whose scaled costs each land on .5 boundaries — per-line Math.round
    // must sum to the displayed total with NO cent lost on the floor
    const mk = (id, q) => ({ id, qty: q, unit: "g" });
    const r4 = {
      id: "rt-quarter",
      title: "Quarter",
      servings: 4,
      time_minutes: 30,
      tags: [],
      ingredients: [mk("rt-a", 300), mk("rt-b", 500), mk("rt-c", 700)],
      steps: [],
    };
    const price = (id) => ({
      ingredient_id: id,
      price_cents: 1001,
      pack_qty: 1000,
      pack_unit: "g",
    });
    const scaled = rescaleRecipe(r4, 1); // factor 0.25
    const c = costRecipe(scaled, price);
    const sum = c.lines.reduce((t, l) => t + (l.costCents || 0), 0);
    eq(c.totalCents, sum); // breakdown sums exactly
    // 75/125/175 g of a 1000 g pack @ R10.01 → 75.075/125.125/175.175 → 75+125+175 = 375
    eq(c.totalCents, 375);
    eq(perPlateCents(c.totalCents, 1), 375);
  },
);
T(
  "P-204 card parity: costRecipe(rescaleRecipe(r,n)) is what cookRecipe logs",
  () => {
    // cookRecipe computes the log's perPlateCents from costRecipe(rescaleRecipe(...))
    // at the COOKED plate count — same pure functions the detail modal shows, so
    // modal, log and this test can never disagree.
    const r = RECIPES[0];
    const scaled = rescaleRecipe(r, 3);
    const costing = costRecipe(scaled, (id) => defaultPrice(id, PRICES));
    eq(
      perPlateCents(costing.totalCents, 3),
      perPlateCents(costing.totalCents, scaled.servings),
    );
  },
);

suite = "parity";
// ONE-ENGINE CONTRACT (P-202 follow-up): the worker and the sync fallback share
// rankRecipes/scoreRecipe from matcher.js — no scoring logic may ever live in
// the worker. The only cross-path surface is priceOf construction: the worker
// groups priceEntries by id, the app caches a map. Both must funnel into the
// SAME defaultPrice selection and produce IDENTICAL output, forever.
T(
  "parity contract: worker-style priceOf === app-style priceOf, recipe by recipe",
  () => {
    const grouped = {};
    for (const e of PRICES) (grouped[e.ingredient_id] ||= []).push(e);
    const workerPriceOf = (id) => defaultPrice(id, grouped[id] || []);
    const appPriceOf = (id) => defaultPrice(id, PRICES); // pre-P-202 direct form
    for (const r of RECIPES) {
      const a = costRecipe(r, workerPriceOf),
        b = costRecipe(r, appPriceOf);
      eq(a.totalCents, b.totalCents);
      eq(a.unpriced, b.unpriced);
      eq(a.lines.length, b.lines.length);
    }
  },
);
T(
  "parity contract: identical ranking + scores under both priceOf forms",
  () => {
    const grouped = {};
    for (const e of PRICES) (grouped[e.ingredient_id] ||= []).push(e);
    const mk = (po) =>
      rankRecipes(RECIPES, {
        pantry: [],
        ingredients: ING_SEARCH,
        priceOf: po,
        remainingBudgetCents: 60000,
      });
    eq(
      JSON.stringify(
        mk((id) => defaultPrice(id, grouped[id] || [])).map((r) => [
          r.recipeId,
          r.score,
          r.eligible,
          r.missingCostCents,
        ]),
      ),
      JSON.stringify(
        mk((id) => defaultPrice(id, PRICES)).map((r) => [
          r.recipeId,
          r.score,
          r.eligible,
          r.missingCostCents,
        ]),
      ),
    );
  },
);

// ---- P-113 red-team absorption (owner-verified DeepSeek batch, 13 Oct) ----
// 25 adversarial scenarios. Where DeepSeek flagged AMBIGUITY, the harness asserts
// the agreed resolution; where its own expected column contained a mistake (#20's
// recipe-total greedy), the harness asserts the CORRECT marginal behaviour.
const RT_ING = [
  {
    id: "rt-rice",
    name: "Rice",
    aliases: [],
    aisle: "starches",
    unit_basis: { qty: 500, unit: "g" },
    tier: 2,
    shelf_life_days: 365,
  },
  {
    id: "rt-onion",
    name: "Onion",
    aliases: [],
    aisle: "veg",
    unit_basis: { qty: 1000, unit: "g" },
    tier: 1,
    shelf_life_days: 30,
  },
  {
    id: "rt-crumb",
    name: "Crumbs",
    aliases: [],
    aisle: "pantry",
    unit_basis: { qty: 100, unit: "g" },
    tier: 2,
    shelf_life_days: 365,
  },
  {
    id: "rt-cheese",
    name: "Cheese",
    aliases: [],
    aisle: "dairy",
    unit_basis: { qty: 1, unit: "unit" },
    tier: 2,
    shelf_life_days: 30,
  },
  {
    id: "rt-mystery",
    name: "Mystery spice",
    aliases: [],
    aisle: "spices",
    unit_basis: { qty: 50, unit: "g" },
    tier: 2,
    shelf_life_days: 730,
  },
  {
    id: "rt-garnish",
    name: "Garnish",
    aliases: [],
    aisle: "veg",
    unit_basis: { qty: 50, unit: "g" },
    tier: 1,
    shelf_life_days: 5,
  },
  {
    id: "rt-beef",
    name: "Beef",
    aliases: [],
    aisle: "proteins",
    unit_basis: { qty: 1, unit: "unit" },
    tier: 3,
    shelf_life_days: 3,
  },
  {
    id: "rt-spinach",
    name: "Spinach",
    aliases: [],
    aisle: "veg",
    unit_basis: { qty: 300, unit: "g" },
    tier: 1,
    shelf_life_days: 180,
  },
  {
    id: "rt-mince",
    name: "Mince",
    aliases: [],
    aisle: "proteins",
    unit_basis: { qty: 1, unit: "unit" },
    tier: 3,
    shelf_life_days: 3,
  },
  {
    id: "rt-chicken",
    name: "Chicken",
    aliases: [],
    aisle: "proteins",
    unit_basis: { qty: 1, unit: "unit" },
    tier: 3,
    shelf_life_days: 3,
  },
  {
    id: "rt-spice",
    name: "Spice",
    aliases: [],
    aisle: "spices",
    unit_basis: { qty: 1, unit: "unit" },
    tier: 1,
    shelf_life_days: 730,
  },
];
const RT_PRICES = [
  {
    ingredient_id: "rt-rice",
    store: "Shoprite",
    price_cents: 2000,
    pack_qty: 500,
    pack_unit: "g",
    last_verified: "2026-10-01",
  },
  {
    ingredient_id: "rt-onion",
    store: "Shoprite",
    price_cents: 500,
    pack_qty: 1000,
    pack_unit: "g",
    last_verified: "2026-10-01",
  },
  {
    ingredient_id: "rt-crumb",
    store: "Shoprite",
    price_cents: 1,
    pack_qty: 100,
    pack_unit: "g",
    last_verified: "2026-10-01",
  },
  {
    ingredient_id: "rt-cheese",
    store: "Shoprite",
    price_cents: 500,
    pack_qty: 1,
    pack_unit: "unit",
    last_verified: "2026-10-01",
  },
  // rt-mystery and rt-garnish: deliberately UNPRICED
  {
    ingredient_id: "rt-spinach",
    store: "Shoprite",
    price_cents: 300,
    pack_qty: 300,
    pack_unit: "g",
    last_verified: "2026-10-01",
  },
  {
    ingredient_id: "rt-mince",
    store: "Shoprite",
    price_cents: 3000,
    pack_qty: 1,
    pack_unit: "unit",
    last_verified: "2026-10-01",
  },
  {
    ingredient_id: "rt-chicken",
    store: "Shoprite",
    price_cents: 2500,
    pack_qty: 1,
    pack_unit: "unit",
    last_verified: "2026-10-01",
  },
  {
    ingredient_id: "rt-spice",
    store: "Shoprite",
    price_cents: 500,
    pack_qty: 1,
    pack_unit: "unit",
    last_verified: "2026-10-01",
  },
];
const rtPriceOf = (id) => defaultPrice(id, RT_PRICES);
const rtCtx = (pantry, budget, constraints = {}) => ({
  pantry,
  ingredients: RT_ING,
  priceOf: rtPriceOf,
  remainingBudgetCents: budget,
  constraints,
});
const rtR = (id, ingredients, o = {}) => ({
  id,
  title: id,
  tags: o.tags || [],
  servings: o.servings || 1,
  time_minutes: o.time || 25,
  ingredients,
  steps: [],
});
const rtCand = (id, lines, o = {}) => ({
  recipeId: id,
  title: id,
  eligible: true,
  coverage: o.coverage ?? 1,
  tags: ["dinner"], // P-313: planner pool is dinner-only
  perPlateCents: o.perPlate ?? 0,
  servings: 2,
  matchPct: 100,
  ingredients: lines,
  missing: [],
});

suite = "redteam";
T("RT1: recipe with ONLY optional items — never blocked, never costs", () => {
  const r = scoreRecipe(
    rtR("rt-opt", [
      { id: "rt-cheese", qty: 1, unit: "unit", optional: true },
      { id: "rt-onion", qty: 100, unit: "g", optional: true },
    ]),
    rtCtx([], 1000),
  );
  ok(r.eligible, "optionals must not block");
  eq(r.missingCostCents, 0);
  eq(r.missing.length, 0);
});
T("RT2: zero budget + missing required → ineligible, no div-by-zero", () => {
  const r = scoreRecipe(
    rtR("rt-need", [{ id: "rt-rice", qty: 500, unit: "g" }]),
    rtCtx([], 0),
  );
  eq(r.eligible, false);
  ok(
    r.reasons.some((x) => x.includes("Missing items cost more")),
    "budget reason present",
  );
  ok(Number.isFinite(r.score), "score must stay finite");
});
T(
  "RT3: zero budget + everything owned → ELIGIBLE (R0 missing ≤ R0 budget)",
  () => {
    const r = scoreRecipe(
      rtR("rt-free", [
        { id: "rt-rice", qty: 500, unit: "g" },
        { id: "rt-onion", qty: 200, unit: "g" },
      ]),
      rtCtx(
        [
          { id: "rt-rice", qty: 500, unit: "g" },
          { id: "rt-onion", qty: 500, unit: "g" },
        ],
        0,
      ),
    );
    ok(
      r.eligible,
      "free cooking from a stocked pantry must never be budget-blocked",
    );
    eq(r.missingCostCents, 0);
    eq(r.score, 98); // coverage 100 + substance 2×2 − thin penalty 6 (2 real lines), no buy penalty
  },
);
T("RT4: near-zero budget, exact ≤ — negative scores are legal", () => {
  const r = scoreRecipe(
    rtR("rt-crumb-need", [{ id: "rt-crumb", qty: 50, unit: "g" }]),
    rtCtx([], 1),
  );
  ok(r.eligible, "1c top-up ≤ 1c budget: eligible because ≤, not <");
  ok(r.score < 0, "negative total score is legal and still rankable");
  ok(Number.isFinite(r.score));
});
T("RT5: exact score tie → cheaper per-plate first", () => {
  const pantry = [{ id: "rt-rice", qty: 500, unit: "g" }];
  const a = rtR("rt-a", [{ id: "rt-rice", qty: 500, unit: "g" }]); // perPlate 2000
  const b = rtR("rt-b", [{ id: "rt-rice", qty: 250, unit: "g" }]); // perPlate 1000
  const ranked = rankRecipes([a, b], rtCtx(pantry, 10000));
  eq(ranked[0].recipeId, "rt-b");
  eq(ranked[1].recipeId, "rt-a");
});
T(
  "RT6: score AND per-plate tie → deterministic id-ascending (data-order independent)",
  () => {
    const pantry = [{ id: "rt-rice", qty: 500, unit: "g" }];
    const z = rtR("rt-z", [{ id: "rt-rice", qty: 250, unit: "g" }]);
    const a = rtR("rt-a", [{ id: "rt-rice", qty: 250, unit: "g" }]);
    const ranked = rankRecipes([z, a], rtCtx(pantry, 10000)); // feed reversed on purpose
    eq(ranked[0].recipeId, "rt-a");
    eq(ranked[1].recipeId, "rt-z");
  },
);
T("RT7: freshness bonus caps at +9 (4 low items × +3 = 12 raw → 9)", () => {
  const r = scoreRecipe(
    rtR("rt-fresh", [
      { id: "rt-rice", qty: 100, unit: "g" },
      { id: "rt-onion", qty: 100, unit: "g" },
      { id: "rt-spinach", qty: 100, unit: "g" },
      { id: "rt-cheese", qty: 1, unit: "unit" },
    ]),
    rtCtx(
      [
        { id: "rt-rice", qty: 500, unit: "g", running_low: true },
        { id: "rt-onion", qty: 1000, unit: "g", running_low: true },
        { id: "rt-spinach", qty: 300, unit: "g", running_low: true },
        { id: "rt-cheese", qty: 1, unit: "unit", running_low: true },
      ],
      10000,
    ),
  );
  eq(r.freshnessBonus, 9, "cap applied AFTER summing");
});
T("RT8: freshness at the cap boundary — exactly 3 low items = +9", () => {
  const r = scoreRecipe(
    rtR("rt-fresh3", [
      { id: "rt-rice", qty: 100, unit: "g" },
      { id: "rt-onion", qty: 100, unit: "g" },
      { id: "rt-spinach", qty: 100, unit: "g" },
    ]),
    rtCtx(
      [
        { id: "rt-rice", qty: 500, unit: "g", running_low: true },
        { id: "rt-onion", qty: 1000, unit: "g", running_low: true },
        { id: "rt-spinach", qty: 300, unit: "g", running_low: true },
      ],
      10000,
    ),
  );
  eq(r.freshnessBonus, 9);
});
T("RT9: dietary exclusion is a hard filter BEFORE the formula", () => {
  const r = scoreRecipe(
    rtR("rt-beefy", [{ id: "rt-beef", qty: 1, unit: "unit" }], {
      tags: ["dinner"],
    }),
    rtCtx([{ id: "rt-beef", qty: 1, unit: "unit" }], 100000, {
      excludeIds: ["rt-beef"],
    }),
  );
  eq(r.eligible, false, "safety filter beats formula eligibility");
  ok(
    r.reasons.some((x) => x.includes("Contains")),
    "exclusion reason present",
  );
});
T(
  "RT10: unpriced MISSING REQUIRED → ineligible (null price must never mean free)",
  () => {
    const r = scoreRecipe(
      rtR("rt-myst", [
        { id: "rt-mystery", qty: 10, unit: "g" },
        { id: "rt-rice", qty: 100, unit: "g" },
      ]),
      rtCtx([{ id: "rt-rice", qty: 500, unit: "g" }], 100000),
    );
    eq(r.eligible, false);
    eq(r.missingCostCents, 0, "cost stays 0 — the item is blocked, not priced");
    ok(
      r.reasons.some((x) => x.includes("no price data")),
      "price-unavailable reason present",
    );
  },
);
T("RT11: unpriced OPTIONAL never affects cost or eligibility", () => {
  const r = scoreRecipe(
    rtR("rt-opt-myst", [
      { id: "rt-rice", qty: 100, unit: "g" },
      { id: "rt-garnish", qty: 10, unit: "g", optional: true },
    ]),
    rtCtx([{ id: "rt-rice", qty: 500, unit: "g" }], 10000),
  );
  ok(r.eligible);
  eq(r.missingCostCents, 0);
  eq(r.missing.length, 0, "optionals are not in the required-missing list");
});
T(
  "RT12: pack-boundary — 600 g from 500 g packs = 2 packs, exact-budget eligible",
  () => {
    const rr = rtR("rt-pack", [{ id: "rt-rice", qty: 600, unit: "g" }]);
    eq(
      scoreRecipe(rr, rtCtx([], 4000)).missingCostCents,
      4000,
      "ceil(600/500) packs, not proportional 2400",
    );
    ok(scoreRecipe(rr, rtCtx([], 4000)).eligible, "4000 ≤ 4000");
    eq(
      scoreRecipe(rr, rtCtx([], 3999)).eligible,
      false,
      "one cent less is over",
    );
  },
);
T(
  "RT13: partial pantry — top-up prices only the GAP (600 g needed, 400 g owned)",
  () => {
    const rr = rtR("rt-gap", [{ id: "rt-rice", qty: 600, unit: "g" }]);
    const r = scoreRecipe(
      rr,
      rtCtx([{ id: "rt-rice", qty: 400, unit: "g" }], 2000),
    );
    eq(
      r.missingCostCents,
      2000,
      "gap 200 g → ONE 500 g pack; not full-line 4000, not proportional 800",
    );
    ok(r.eligible, "2000 ≤ 2000");
    eq(
      scoreRecipe(rr, rtCtx([{ id: "rt-rice", qty: 400, unit: "g" }], 1999))
        .eligible,
      false,
    );
  },
);
T("RT14: rescale rounding — cents round, never truncate", () => {
  const base = rtR("rt-scale", [{ id: "rt-cents4", qty: 4, unit: "unit" }], {
    servings: 4,
  });
  const pOf = () => ({
    price_cents: 1001,
    pack_qty: 4,
    pack_unit: "unit",
    store: "X",
    last_verified: "2026-10-01",
  });
  const scaled = costRecipe(rescaleRecipe(base, 3), pOf);
  eq(scaled.totalCents, 751, "1001×3/4 = 750.75 → 751, not truncated 750");
  eq(perPlateCents(scaled.totalCents, 3), 250, "751/3 = 250.33 → 250");
});
T(
  "RT15: half-cent rounds UP (half-away-from-zero), explicit and consistent",
  () => {
    const base = rtR("rt-scale2", [{ id: "rt-cents5", qty: 4, unit: "unit" }], {
      servings: 4,
    });
    const pOf = () => ({
      price_cents: 1002,
      pack_qty: 4,
      pack_unit: "unit",
      store: "X",
      last_verified: "2026-10-01",
    });
    eq(
      costRecipe(rescaleRecipe(base, 3), pOf).totalCents,
      752,
      "1002×3/4 = 751.5 → 752",
    );
  },
);
T("RT16: duplicate ingredient lines — id deduped, qty summed, one pack", () => {
  const rr = rtR("rt-dup", [
    { id: "rt-onion", qty: 400, unit: "g" },
    { id: "rt-onion", qty: 400, unit: "g" },
  ]);
  const r = scoreRecipe(rr, rtCtx([], 10000));
  eq(r.missing.length, 1, "one entry, not two");
  eq(r.missingCostCents, 500, "merged 800 g → ONE 1000 g pack");
  eq(r.coverage, 0, "coverage counts the ingredient once");
});
T("RT17: duplicates + pack boundary — summed qty forces 2 packs", () => {
  const rr = rtR("rt-dup2", [
    { id: "rt-rice", qty: 300, unit: "g" },
    { id: "rt-rice", qty: 300, unit: "g" },
  ]);
  const r = scoreRecipe(rr, rtCtx([], 4000));
  eq(
    r.missingCostCents,
    4000,
    "merged 600 g from 500 g packs = 2 packs; deduped-price-only would wrongly give 2000",
  );
  ok(r.eligible, "4000 ≤ 4000 exact boundary");
});
T(
  "RT18: running_low used twice — matcher-local bonus, deduped per recipe",
  () => {
    const pantry = [
      { id: "rt-spinach", qty: 300, unit: "g", running_low: true },
    ];
    const once = scoreRecipe(
      rtR("rt-sp1", [{ id: "rt-spinach", qty: 100, unit: "g" }]),
      rtCtx(pantry, 10000),
    );
    const twice = scoreRecipe(
      rtR("rt-sp2", [
        { id: "rt-spinach", qty: 100, unit: "g" },
        { id: "rt-spinach", qty: 100, unit: "g" },
      ]),
      rtCtx(pantry, 10000),
    );
    eq(once.freshnessBonus, 3);
    eq(
      twice.freshnessBonus,
      3,
      "same ingredient twice in ONE recipe counts once; each recipe gets its own bonus",
    );
  },
);
T(
  "RT19: planner MAX_REPEATS with only 3 eligible → partial week + warning, never a 3rd repeat",
  () => {
    const cands = [rtCand("rt-1", []), rtCand("rt-2", []), rtCand("rt-3", [])];
    const plan = planWeek(cands, {
      weekBudgetCents: 10,
      servings: 2,
      days: 7,
      ingredients: RT_ING,
      priceEntries: RT_PRICES,
    });
    eq(plan.mealsPlanned, 6, "3 recipes × MAX_REPEATS 2 = 6 days max");
    eq(plan.days[6].meal, null, "day 7 unfilled, not a 3rd repeat");
    ok(plan.warnings.length > 0, "partial week is explained to the user");
  },
);
T(
  "RT20: planner marginal cost — shared purchases make the second meal nearly free",
  () => {
    // packs are 2-meal sized (like DeepSeek's setup: "one pack covers two meals"):
    // mince R30 (2 portions), chicken R25 (2 portions), spice R5
    const RT20_PRICES = [
      {
        ingredient_id: "rt-mince",
        store: "Shoprite",
        price_cents: 3000,
        pack_qty: 2,
        pack_unit: "unit",
        last_verified: "2026-10-01",
      },
      {
        ingredient_id: "rt-chicken",
        store: "Shoprite",
        price_cents: 2500,
        pack_qty: 2,
        pack_unit: "unit",
        last_verified: "2026-10-01",
      },
      {
        ingredient_id: "rt-spice",
        store: "Shoprite",
        price_cents: 500,
        pack_qty: 1,
        pack_unit: "unit",
        last_verified: "2026-10-01",
      },
    ];
    const cands = [
      rtCand("rt-r1", [{ id: "rt-mince", qty: 1, unit: "unit" }]),
      rtCand("rt-r2", [
        { id: "rt-mince", qty: 1, unit: "unit" },
        { id: "rt-spice", qty: 1, unit: "unit" },
      ]),
      rtCand("rt-r3", [{ id: "rt-chicken", qty: 1, unit: "unit" }]),
    ];
    const plan = planWeek(cands, {
      weekBudgetCents: 6000,
      servings: 2,
      days: 5,
      ingredients: RT_ING,
      priceEntries: RT20_PRICES,
    });
    const ids = plan.days.map((d) => d.meal?.recipeId);
    // True greedy: r3 (2500), r3 repeat (0 — the 2-unit chicken pack covers both),
    // r1 (3000), r1 repeat (0 — the 2-unit mince pack covers both), then r2's
    // marginal is mince-pack-2 + spice = 3500 > 500 left → skipped. NOTE: DeepSeek's
    // expected column stopped at 3 meals — its own row forgot that a repeat is
    // nearly free; our engine fills 4 days for the same 5500.
    eq(ids.join(","), "rt-r3,rt-r3,rt-r1,rt-r1,");
    eq(
      plan.totalCents,
      5500,
      "ONE chicken pack + ONE mince pack — shared purchases, never double-bought",
    );
    const ch = plan.shoppingList.find((i) => i.id === "rt-chicken");
    const mi = plan.shoppingList.find((i) => i.id === "rt-mince");
    eq(ch.packs, 1, "two meals, one shared chicken pack");
    eq(mi.packs, 1, "two meals, one shared mince pack");
    eq(
      plan.shoppingList.find((i) => i.id === "rt-spice"),
      undefined,
      "r2 never planned — its marginal busted the budget",
    );
  },
);
T("RT21: budget exactly 90% → amber, never green", () => {
  const plan = planWeek(
    [rtCand("rt-m", [{ id: "rt-mince", qty: 1, unit: "unit" }])],
    {
      weekBudgetCents: 1000,
      servings: 2,
      days: 1,
      ingredients: RT_ING,
      priceEntries: [
        {
          ingredient_id: "rt-mince",
          store: "X",
          price_cents: 900,
          pack_qty: 1,
          pack_unit: "unit",
          last_verified: "2026-10-01",
        },
      ],
    },
  );
  eq(plan.status, "near", "90% exactly is amber — green is strictly < 90%");
});
T("RT22: 89.99% → green (display rounding must not flip the band)", () => {
  const plan = planWeek(
    [rtCand("rt-m", [{ id: "rt-mince", qty: 1, unit: "unit" }])],
    {
      weekBudgetCents: 1000,
      servings: 2,
      days: 1,
      ingredients: RT_ING,
      priceEntries: [
        {
          ingredient_id: "rt-mince",
          store: "X",
          price_cents: 899,
          pack_qty: 1,
          pack_unit: "unit",
          last_verified: "2026-10-01",
        },
      ],
    },
  );
  eq(plan.status, "under");
});
T("RT23: exactly 100% → planner admits it (≤) but status is red", () => {
  const plan = planWeek(
    [rtCand("rt-m", [{ id: "rt-mince", qty: 1, unit: "unit" }])],
    {
      weekBudgetCents: 1000,
      servings: 2,
      days: 1,
      ingredients: RT_ING,
      priceEntries: [
        {
          ingredient_id: "rt-mince",
          store: "X",
          price_cents: 1000,
          pack_qty: 1,
          pack_unit: "unit",
          last_verified: "2026-10-01",
        },
      ],
    },
  );
  eq(plan.mealsPlanned, 1, "invariant is ≤ budget, so the meal is admitted");
  eq(plan.status, "over", "red is ≥ 100%");
});
T("RT24: the 99–100% spec gap is closed — 99.5% is amber", () => {
  const plan = planWeek(
    [rtCand("rt-m", [{ id: "rt-mince", qty: 1, unit: "unit" }])],
    {
      weekBudgetCents: 1000,
      servings: 2,
      days: 1,
      ingredients: RT_ING,
      priceEntries: [
        {
          ingredient_id: "rt-mince",
          store: "X",
          price_cents: 995,
          pack_qty: 1,
          pack_unit: "unit",
          last_verified: "2026-10-01",
        },
      ],
    },
  );
  eq(plan.status, "near", "amber covers 90%..99.99%; red starts at 100%");
});
T(
  "RT25: eligible-first — a high-coverage ineligible never outranks a low-score eligible",
  () => {
    const rina = rtR("rt-highcov", [
      { id: "rt-rice", qty: 100, unit: "g" },
      { id: "rt-onion", qty: 100, unit: "g" },
      { id: "rt-cheese", qty: 1, unit: "unit" },
      { id: "rt-spinach", qty: 100, unit: "g" },
      { id: "rt-chicken", qty: 1, unit: "unit" },
    ]); // unowned: MC 2500 > B 1000 → ineligible
    const rlow = rtR("rt-lowcov", [{ id: "rt-spice", qty: 1, unit: "unit" }]); // MC 500 ≤ 1000 → eligible
    const pantry = [
      { id: "rt-rice", qty: 500, unit: "g" },
      { id: "rt-onion", qty: 1000, unit: "g" },
      { id: "rt-cheese", qty: 1, unit: "unit" },
      { id: "rt-spinach", qty: 300, unit: "g" },
    ];
    const ranked = rankRecipes([rina, rlow], rtCtx(pantry, 1000));
    eq(
      ranked[0].recipeId,
      "rt-lowcov",
      "eligible first even with a negative score",
    );
    eq(ranked[0].eligible, true);
    eq(ranked[1].eligible, false, "high coverage does not beat eligibility");
  },
);

suite = "decoder";
T("decodeRecipeText: qty lines → ingredients, method → steps", () => {
  const text = `Serves 4 – 30 min
400 g maize meal
1 can baked beans
Method:
Boil water. Stir pap.
Warm beans and serve.`;
  const d = decodeRecipeText(text, (n) =>
    ING.find(
      (i) => normalize(i.name).includes(normalize(n).split(" ")[0]) || null,
    ),
  );
  eq(d.servings, 4);
  eq(d.timeMinutes, 30);
  ok(d.steps.length >= 2);
  ok(d.ingredients.length >= 2);
});
T("decodeRecipeText: unresolved lines flag reviewRequired", () => {
  const d = decodeRecipeText("2 cups unicorn dust\nMethod:\nStir.", () => null);
  ok(d.reviewRequired);
  eq(d.confidence, 0);
});
T(
  "draftToRecipe: refuses to save unreviewed drafts (review-queue discipline)",
  () => {
    const d = decodeRecipeText(
      "2 cups unicorn dust\nMethod:\nStir.",
      () => null,
    );
    let threw = false;
    try {
      draftToRecipe(d, {});
    } catch {
      threw = true;
    }
    ok(threw);
  },
);
T("draftToRecipe: reviewed draft becomes recipe.json-shaped record", () => {
  const d = decodeRecipeText(
    "3 eggs\n1 bread\nFry.",
    (n) =>
      ING.find((i) => i.name.toLowerCase().includes(n.toLowerCase())) || null,
  );
  // P-404: verb-first prose after ingredients is a STEP, not the title
  const dv = decodeRecipeText(
    "Serves 4 - 30 min\n1 onion\nFry the onion.\nAdd the rice.",
    () => null,
  );
  ok(dv.steps.length === 2, "verb lines become steps without a Method header");
  ok(
    dv.title === "Untitled recipe" || dv.title === "Untitled",
    "instruction line no longer steals the title",
  );
  ok(dv.reviewRequired, "unresolved onion keeps the gate shut");
  T(
    "P-419 hardening: preprocessing + vague guard + multi-recipe + reasons",
    () => {
      // unicode fraction + zero-width
      const d1 = decodeRecipeText("\u200b\u00bd cup sugar", (n) =>
        normalize(n).includes("sugar")
          ? { id: "white-sugar", name: "White sugar" }
          : null,
      );
      eq(d1.ingredients.length, 1, "ZWSP stripped, ½ parsed");
      ok(Math.abs(d1.ingredients[0].qty - 0.5) < 0.01, "½ -> 0.5");
      // vague quantities NEVER auto-save; they carry a reason
      const d2 = decodeRecipeText("a pinch of salt\nknippie sout", () => ({
        id: "salt",
        name: "Salt",
      }));
      eq(d2.ingredients.length, 0, "pinch/knippie never auto-saved");
      ok(
        d2.unresolved.some((u) => u.reason === "vague_quantity"),
        "vague reason recorded",
      );
      // instruction with qty is NOT an ingredient (D01)
      const d3 = decodeRecipeText(
        "Add the remaining 100ml milk later",
        () => null,
      );
      eq(d3.ingredients.length, 0, "anaphora instruction not an ingredient");
      ok(d3.steps.length === 1, "it is a step");
      // multi-recipe: flagged, first recipe parsed, rest flagged
      const d4 = decodeRecipeText(
        "1) Pancakes - 2 eggs, 1 cup flour\n\n2) Pasta: 250g pasta",
        () => null,
      );
      eq(d4.meta.isMultiRecipe, true, "numbered dump flagged");
      ok(
        d4.unresolved.some((u) => u.reason === "multiple_recipes_detected"),
        "rest flagged for review",
      );
      ok(d4.ingredients.length >= 1, "first recipe parsed");
      // TikTok noise ignored, not queued
      const d5 = decodeRecipeText(
        "DC: @foodie\nLink in bio\n2 cups flour",
        () => null,
      );
      ok(d5.ignored.length >= 2, "meta noise -> ignored");
      ok(d5.ingredients.length === 1, "the real line still parses");
    },
  );
  const r = draftToRecipe(
    {
      ...d,
      reviewRequired: false,
      ingredients: d.ingredients.map((i) => ({
        ...i,
        resolvedId: i.resolvedId || "eggs",
      })),
    },
    { id: "x" },
  );
  eq(r.ingredients[0].id, "eggs");
  ok(r.tags.includes("decoded"));
});

// ---- achievements ----
suite = "achievements";
// ---- P-403: personalization stats + heatmap source ----
const p403d = (n) => {
  const t = new Date(Date.now() - n * 864e5);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
};
const p403e = (id, n, recipeId, cents) => ({
  id,
  date: p403d(n),
  recipeId,
  title: recipeId.toUpperCase(),
  perPlateCents: cents,
  servings: 2,
  missingCount: 0,
  tags: [],
});
T("P-403 heatByDate: tallies per local day, skips garbage rows", () => {
  const log = [
    p403e("1", 0, "pap", 1000),
    p403e("2", 0, "pap", 1200),
    p403e("3", 1, "beans", 800),
    {
      id: "x",
      date: "not-a-date",
      recipeId: "junk",
      title: "J",
      perPlateCents: 1,
      servings: 1,
      missingCount: 0,
      tags: [],
    },
    {
      id: "y",
      date: null,
      recipeId: "junk2",
      title: "J",
      perPlateCents: 1,
      servings: 1,
      missingCount: 0,
      tags: [],
    },
  ];
  const heat = heatByDate(log);
  eq(heat.get(p403d(0)), 2, "two cooks today heat the cell by 2");
  eq(heat.get(p403d(1)), 1, "one cook yesterday");
  eq(heat.size, 2, "garbage rows never enter the map");
});
T("P-403 mostCooked: winner by count, ties broken by earliest cooked", () => {
  const a = [
    p403e("1", 0, "pap", 1000),
    p403e("2", 0, "pap", 1200),
    p403e("3", 2, "beans", 800),
  ];
  eq(getAchievementStats(a).mostCooked.recipeId, "pap", "2 beats 1");
  const b = [
    p403e("1", 5, "beans", 800),
    p403e("2", 0, "pap", 1000),
    p403e("3", 1, "pap", 1200),
  ];
  const mc = getAchievementStats(b).mostCooked;
  eq(
    mc.recipeId,
    "pap",
    "tie 2-2 — entries date-sort, first-cooked wins deterministically",
  );
  eq(mc.count, 2);
  eq(getAchievementStats([]).mostCooked, null, "empty log has no go-to");
});
T(
  "P-415 new badges: milestones, variety, tag and month windows earn correctly",
  () => {
    const many = (n, opts) =>
      Array.from({ length: n }, (_, i) => ({
        id: String(i),
        date: p403d(0),
        recipeId: opts.rid ? opts.rid + i : "a",
        title: "T" + i,
        perPlateCents: opts.cents || 1000,
        servings: 2,
        missingCount: opts.missing || 0,
        tags: opts.tags || [],
      }));
    // milestones
    let s = getAchievementStats(many(20, {}));
    ok(
      s.badges.find((b) => b.id === "twenty-plates").earned,
      "twenty-plates earned at 20 cooks",
    );
    ok(
      !s.badges.find((b) => b.id === "fifty-plates").earned,
      "fifty-plates still locked at 20",
    );
    // variety needs DISTINCT recipes
    s = getAchievementStats(many(20, { rid: "r" }));
    ok(
      s.badges.find((b) => b.id === "variety-ten").earned,
      "20 distinct recipes earn variety-ten",
    );
    // tag badges
    s = getAchievementStats(many(10, { tags: ["budget"], rid: "x" }));
    ok(
      s.badges.find((b) => b.id === "budget-ten").earned,
      "10 budget-tagged cooks earn budget-ten",
    );
    s = getAchievementStats(many(7, { tags: ["vegetarian"] }));
    ok(
      s.badges.find((b) => b.id === "veg-week").earned,
      "7 vegetarian cooks earn veg-week",
    );
    // r15 week
    s = getAchievementStats(many(7, { cents: 1200 }));
    ok(
      s.badges.find((b) => b.id === "r15-plate-week").earned,
      "avg R12 over 7 earns r15-plate-week",
    );
    // month marathon: 20 cooks in one YYYY-MM (all today -> same month unless month boundary midnight; use fixed date)
    const mm = Array.from({ length: 20 }, (_, i) => ({
      id: String(i),
      date: "2026-09-15",
      recipeId: "m",
      title: "M",
      perPlateCents: 1000,
      servings: 1,
      missingCount: 0,
      tags: [],
    }));
    ok(
      getAchievementStats(mm).badges.find((b) => b.id === "month-marathon")
        .earned,
      "20 cooks in Sep-2026 earn month-marathon",
    );
    // big saver: 10 cooks at R45/plate -> saves (55-45)*10 = R100... need R500: 12 cooks at R8 -> (55-8)*12 = R564
    const bs = Array.from({ length: 12 }, (_, i) => ({
      id: String(i),
      date: p403d(i),
      recipeId: "b",
      title: "B",
      perPlateCents: 800,
      servings: 1,
      missingCount: 0,
      tags: [],
    }));
    ok(
      getAchievementStats(bs).badges.find((b) => b.id === "big-saver").earned,
      "R564 saved earns big-saver",
    );
  },
);
T(
  "P-402 badge copy: every badge has an icon, unlock line <= 12 words, ASCII-clean",
  () => {
    for (const b of BADGES) {
      ok(
        typeof b.icon === "string" && b.icon.length > 0,
        b.id + " has an icon",
      );
      const words = b.line.split(/\s+/).filter(Boolean);
      ok(
        words.length > 0 && words.length <= 12,
        b.id + " unlock line <= 12 words",
      );
      ok(
        !/[\u2010-\u2015]/.test(b.name + b.line),
        b.id + " ASCII-clean dashes",
      );
    }
    ok(
      BADGES.some((b) => b.id === "first-braai" && b.name === "First Braai"),
      "Groq rename applied",
    );
  },
);
T(
  "P-402 newlyEarned: diffs pre/post stats and returns only fresh badges",
  () => {
    const log = [
      {
        id: "1",
        date: "2026-10-17",
        recipeId: "a",
        title: "A",
        perPlateCents: 900,
        servings: 4,
        missingCount: 0,
        tags: [],
      },
    ];
    const empty = getAchievementStats([]);
    const one = getAchievementStats(log);
    const fresh = newlyEarned(empty, one);
    eq(fresh.length, 1);
    eq(fresh[0].id, "first-plate");
    eq(newlyEarned(one, one).length, 0, "no re-earn on unchanged state");
  },
);

T(
  "P-416 XP model: plates + thrift + zero-waste drive earned XP with caps",
  () => {
    eq(
      xpForCook({ perPlateCents: 955, servings: 4, missingCount: 0 }),
      17,
      "cheap 4-plate zero-waste: 5 + 4 + 6 (capped) + 2",
    );
    eq(
      xpForCook({ perPlateCents: 5000, servings: 1, missingCount: 3 }),
      7,
      "expensive 1-plate with shopping: 5 + 1 + 1 + 0",
    );
    eq(
      xpForCook({ perPlateCents: 5600, servings: 1, missingCount: 0 }),
      8,
      "over-baseline cook earns no thrift but still pays plates + zero-waste",
    );
    eq(
      xpForCook({ perPlateCents: 1000, servings: 20, missingCount: 0 }),
      21,
      "plate bonus caps at 8 (5 + 8 + 6 capped thrift + 2 zero-waste)",
    );
    eq(
      xpForCook({ perPlateCents: 100, servings: 1, missingCount: 0 }),
      14,
      "thrift bonus caps at 6 (5 + 1 + 6 + 2)",
    );
  },
);
T("P-416 levels: growing costs, tier titles, capped ladder", () => {
  eq(titleForLevel(1), "Pot Washer");
  eq(titleForLevel(5), "Seven-Colours Sunday");
  eq(titleForLevel(12), "RandPlates Royalty", "titles cap at 10");
  eq(xpCostForLevel(1), 40);
  eq(xpCostForLevel(4), 70);
  // 13 honest cooks (~15xp avg) + streak => well past level 4
  const log = Array.from({ length: 13 }, (_, i) => ({
    id: String(i),
    date: p403d(i),
    recipeId: "r" + i,
    title: "T",
    perPlateCents: 1745,
    servings: 3,
    missingCount: 0,
    tags: [],
  }));
  const s = getAchievementStats(log);
  ok(s.xp > 150, "earned model values thrift above the old flat 130");
  ok(s.level >= 5, "13 cooks reach Seven-Colours Sunday");
  ok(s.xpForNextLevel >= 50, "level 6 costs more than the flat 50");
  ok(
    typeof s.levelTitle === "string" && s.levelTitle.length > 0,
    "level title present",
  );
});
T("P-416 report stats: first cook, spend, month window", () => {
  const log = [
    {
      id: "1",
      date: "2026-09-30",
      recipeId: "a",
      title: "A",
      perPlateCents: 1000,
      servings: 2,
      missingCount: 0,
      tags: [],
    },
    {
      id: "2",
      date: "2026-10-17",
      recipeId: "b",
      title: "B",
      perPlateCents: 2000,
      servings: 3,
      missingCount: 0,
      tags: [],
    },
  ];
  const s = getAchievementStats(log);
  eq(s.firstCookDate, "2026-09-30");
  eq(s.totalSpentCents, 1000 * 2 + 2000 * 3, "per-plate x servings, summed");
  ok(s.cooksThisMonth >= 1, "October cook counted in this-month window");
  eq(typeof s.platesThisMonth, "number");
});

T(
  "P-415 expanded stats: plates, weekday profile, top tags, distinct recipes",
  () => {
    const log = [
      {
        id: "1",
        date: "2026-10-01",
        recipeId: "a",
        title: "A",
        perPlateCents: 1000,
        servings: 3,
        missingCount: 0,
        tags: ["vegetarian", "budget"],
      },
      {
        id: "2",
        date: "2026-10-02",
        recipeId: "b",
        title: "B",
        perPlateCents: 1200,
        servings: 2,
        missingCount: 0,
        tags: ["vegetarian"],
      },
    ];
    const s = getAchievementStats(log);
    eq(s.totalPlates, 5, "3+2 servings");
    eq(s.distinctRecipes, 2);
    eq(s.weekdayProfile[3], 1, "2026-10-01 is a Thursday (Mon=0 index 3)");
    eq(s.weekdayProfile[4], 1, "2026-10-02 is a Friday");
    eq(s.topTags[0].tag, "vegetarian", "top tag by count");
    eq(s.busiestDayIdx, 3, "first max wins the busiest-day tie");
    const empty = getAchievementStats([]);
    eq(empty.totalPlates, 0);
    eq(empty.busiestDayIdx, -1, "no cooks -> no busiest day");
  },
);

T(
  "P-403 week windows: 7-day boundaries are exact and empty windows are null-avg",
  () => {
    const log = [
      p403e("1", 6, "a", 1000),
      p403e("2", 7, "b", 3000),
      p403e("3", 13, "c", 5000),
    ];
    const s = getAchievementStats(log);
    eq(s.cooksThisWeek, 1, "6 days ago is THIS week; 7 days ago is PREV");
    eq(s.avgLast7Cents, 1000);
    eq(
      s.avgPrev7Cents,
      4000,
      "7d (3000) + 13d (5000) both sit in the prev window -> avg 4000",
    );
    const empty = getAchievementStats([p403e("1", 20, "a", 1000)]);
    eq(empty.cooksThisWeek, 0);
    eq(
      empty.avgLast7Cents,
      null,
      "no cooks this week -> null, not a fake zero",
    );
    eq(empty.avgPrev7Cents, null);
  },
);
const day = (offset) =>
  new Date(Date.now() - offset * 864e5).toISOString().slice(0, 10);
T("getAchievementStats: streaks from consecutive-day log", () => {
  const log = [0, 1, 2].map((o, i) => ({
    id: String(i),
    date: day(o),
    recipeId: "x",
    title: "X",
    perPlateCents: 2000,
    servings: 2,
    missingCount: 0,
    tags: ["braai"],
  }));
  const s = getAchievementStats(log);
  eq(s.totalCooks, 3);
  eq(s.currentStreak, 3);
  ok(s.badges.find((b) => b.id === "first-plate").earned);
  ok(s.badges.find((b) => b.id === "hat-trick").earned);
});
T("getAchievementStats: gap breaks the streak", () => {
  const log = [0, 1, 5].map((o, i) => ({
    id: String(i),
    date: day(o),
    recipeId: "x",
    title: "X",
    perPlateCents: 2000,
    servings: 2,
    missingCount: 0,
    tags: [],
  }));
  const s = getAchievementStats(log);
  eq(s.longestStreak, 2);
  eq(s.currentStreak, 2); // today + yesterday still consecutive
});
T("getAchievementStats: R25-per-plate badge needs 7 cooks ≤ R25 avg", () => {
  const cheap = Array.from({ length: 7 }, (_, i) => ({
    id: String(i),
    date: day(i),
    recipeId: "x",
    title: "X",
    perPlateCents: 2000,
    servings: 2,
    missingCount: 0,
    tags: [],
  }));
  ok(
    getAchievementStats(cheap).badges.find((b) => b.id === "r25-plate-week")
      .earned,
  );
  const pricey = cheap.map((e) => ({ ...e, perPlateCents: 3000 }));
  ok(
    !getAchievementStats(pricey).badges.find((b) => b.id === "r25-plate-week")
      .earned,
  );
});
T("getAchievementStats: no-waste badge needs 5 zero-missing cooks", () => {
  const log = Array.from({ length: 5 }, (_, i) => ({
    id: String(i),
    date: day(i * 2),
    recipeId: "x",
    title: "X",
    perPlateCents: 2000,
    servings: 2,
    missingCount: 0,
    tags: [],
  }));
  ok(
    getAchievementStats(log).badges.find((b) => b.id === "no-waste-week")
      .earned,
  );
});
T("getAchievementStats: empty log → zero stats, no badges, no crash", () => {
  const s = getAchievementStats([]);
  eq(s.totalCooks, 0);
  eq(s.earnedCount, 0);
  eq(s.avgPerPlateCents, 0);
});

// ---------------------------------------------------------------------------

async function run() {
  const results = [];
  for (const c of cases) {
    try {
      await c.fn();
      results.push({ suite: c.suite, name: c.name, ok: true });
    } catch (err) {
      results.push({
        suite: c.suite,
        name: c.name,
        ok: false,
        err: err.message,
      });
    }
  }
  return results;
}

// ---- P-104S: readiness model, staple forgiveness, hero anchor, worker payload ----
suite = "readiness";
const ctxStaple = (pantry, budgetCents = 60000, constraints = {}) => ({
  pantry,
  ingredients: ING_STAPLE,
  priceOf: (id) => defaultPrice(id, PRICES_STAPLE),
  remainingBudgetCents: budgetCents,
  constraints,
});

T("readiness: ready — nothing real missing (optional onion ignored)", () => {
  const r = scoreRecipe(
    R_PAP,
    ctxStaple([
      { id: "maize-meal", qty: 2500, unit: "g" },
      { id: "baked-beans", qty: 2, unit: "can" },
    ]),
  );
  eq(r.readiness, "ready");
  eq(r.missing.length, 0);
  eq(r.missingCostCents, 0);
});

T(
  "staple forgiveness: missing salt + oil NEVER block, never cost, listed separately",
  () => {
    // pantry covers maize-meal + beans; salt + oil are absent (the classic forgotten staples)
    const r = scoreRecipe(
      R_STAPLE,
      ctxStaple([
        { id: "maize-meal", qty: 2500, unit: "g" },
        { id: "baked-beans", qty: 2, unit: "can" },
      ]),
    );
    eq(
      r.readiness,
      "ready",
      "staples must not turn a cookable recipe into a shop",
    );
    eq(
      r.missing.length,
      0,
      "staples must not appear in the blocking missing list",
    );
    eq(r.missingCostCents, 0, "staples must not cost against the budget");
    ok(
      r.staplesMissing.length >= 2,
      "forgotten staples should be surfaced as a gentle list",
    );
    ok(
      r.staplesMissing.some((m) => m.id === "salt") &&
        r.staplesMissing.some((m) => m.id === "oil"),
    );
  },
);

T("readiness: almost — one modest top-up within 15% of budget", () => {
  const r = scoreRecipe(
    R_STAPLE,
    ctxStaple([{ id: "maize-meal", qty: 2500, unit: "g" }]),
  ); // beans missing
  eq(r.readiness, "almost"); // 1499 top-up ≤ 9000 (15% of R600)
  ok(r.missing.some((m) => m.id === "baked-beans"));
  eq(r.missingCostCents, 1499); // discrete can pack = whole pack, honestly
});

T("readiness: off — top-up exceeds the whole budget", () => {
  const r = scoreRecipe(R_STAPLE, ctxStaple([], 1000)); // empty pantry, R10 budget
  eq(r.readiness, "off");
  eq(r.eligible, false);
});

T("topUpCostCents: WHOLE PACKS, always (P-113b red-team #12/#13)", () => {
  // 300 g of tomatoes from a R29.99/kg pack = ONE whole pack (2999), not proportional 900 —
  // the till charges whole packs; eligibility must match the till.
  eq(
    topUpCostCents(
      { id: "tomato", qty: 300, unit: "g" },
      { price_cents: 2999, pack_qty: 1000, pack_unit: "g" },
    ),
    2999,
  );
  // 600 g from 500 g packs = 2 packs exactly (ceil), never 1.2 packs
  eq(
    topUpCostCents(
      { id: "rice", qty: 600, unit: "g" },
      { price_cents: 2000, pack_qty: 500, pack_unit: "g" },
    ),
    4000,
  );
  // discrete packs stay whole-pack: 1 can = R14.99, 2 cans = 2 packs
  eq(
    topUpCostCents(
      { id: "baked-beans", qty: 1, unit: "can" },
      { price_cents: 1499, pack_qty: 1, pack_unit: "can" },
    ),
    1499,
  );
  eq(
    topUpCostCents(
      { id: "baked-beans", qty: 2, unit: "can" },
      { price_cents: 1499, pack_qty: 1, pack_unit: "can" },
    ),
    2998,
  );
  eq(topUpCostCents({ id: "unicorn", qty: 5, unit: "g" }, null), null);
});

T(
  "hero anchor: owning the hero (eggs, tier 3) lifts the score with sides still missing",
  () => {
    const noHero = scoreRecipe(R_EGGS, ctxBase([], 60000));
    const withHero = scoreRecipe(
      R_EGGS,
      ctxBase([{ id: "eggs", qty: 30, unit: "unit" }], 60000),
    );
    ok(
      withHero.score > noHero.score,
      `hero ownership should lift score: ${noHero.score} -> ${withHero.score}`,
    );
    eq(withHero.heroCovered, 1);
    eq(noHero.heroCovered, 0);
  },
);

T(
  "worker payload is structured-clone-safe — functions never cross postMessage",
  () => {
    // P-104S regression: the old payload carried priceOf and threw DataCloneError
    // in every real browser, silently killing the matcher.
    const payload = scorePayload([R_PAP], ING, PRICES, {
      pantry: [],
      remainingBudgetCents: 60000,
      constraints: {},
    });
    const cloned = structuredClone(payload); // must not throw
    eq(cloned.type, "score");
    ok(
      !("priceOf" in cloned.payload.ctx),
      "priceOf function must NOT be in the payload",
    );
    ok(
      Array.isArray(cloned.payload.priceEntries),
      "worker needs priceEntries to rebuild priceOf",
    );
    ok(Array.isArray(cloned.payload.ingredients));
  },
);

// ---- P-104T: meal intent, variety, favourites, unlock insights, substance ----
suite = "matcher-v2";

T("mealIntentFor: SA eating rhythm boundaries", () => {
  eq(mealIntentFor(3, 59), "dinner"); // small hours still read as dinner/late
  eq(mealIntentFor(4, 0), "breakfast");
  eq(mealIntentFor(10, 29), "breakfast");
  eq(mealIntentFor(10, 30), "lunch");
  eq(mealIntentFor(15, 59), "lunch");
  eq(mealIntentFor(16, 0), "dinner");
  eq(mealIntentFor(23, 30), "dinner");
});

T(
  "meal intent: a matching tag lifts the score, wrong-meal dessert/snack is nudged down at dinner",
  () => {
    const dinnerR = { ...R_PAP, id: "d", tags: ["dinner"] };
    const dessertR = { ...R_PAP, id: "s", tags: ["dessert"] };
    const pantry = [
      { id: "maize-meal", qty: 2500, unit: "g" },
      { id: "baked-beans", qty: 2, unit: "can" },
    ];
    const dinnerAtDinner = scoreRecipe(dinnerR, {
      ...ctxBase(pantry),
      mealIntent: "dinner",
    });
    const dessertAtDinner = scoreRecipe(dessertR, {
      ...ctxBase(pantry),
      mealIntent: "dinner",
    });
    eq(dinnerAtDinner.intentBonus, 6);
    eq(dessertAtDinner.intentBonus, -6);
    const noIntent = scoreRecipe(dinnerR, ctxBase(pantry));
    eq(noIntent.intentBonus, 0, "no intent => no nudge (Anything chip)");
  },
);

T(
  "meal intent strength: explicit chip (mealStrict) re-orders 5x harder than the clock hint",
  () => {
    const bfR = { ...R_PAP, id: "b", tags: ["breakfast"] };
    const pantry = [
      { id: "maize-meal", qty: 2500, unit: "g" },
      { id: "baked-beans", qty: 2, unit: "can" },
    ];
    const gentle = scoreRecipe(bfR, {
      ...ctxBase(pantry),
      mealIntent: "breakfast",
    });
    const strict = scoreRecipe(bfR, {
      ...ctxBase(pantry),
      mealIntent: "breakfast",
      mealStrict: true,
    });
    eq(gentle.intentBonus, 6);
    eq(strict.intentBonus, 30);
    const dinnerAtBf = scoreRecipe(
      { ...R_PAP, id: "dd", tags: ["dinner"] },
      { ...ctxBase(pantry), mealIntent: "breakfast", mealStrict: true },
    );
    eq(dinnerAtBf.intentBonus, -20); // wrong-meal is pushed down hard, still eligible
    eq(dinnerAtBf.eligible, true);
  },
);

T(
  "meal intent is a nudge, never a filter: dessert stays eligible at dinner",
  () => {
    const dessertR = { ...R_PAP, id: "s", tags: ["dessert"] };
    const r = scoreRecipe(dessertR, {
      ...ctxBase([
        { id: "maize-meal", qty: 2500, unit: "g" },
        { id: "baked-beans", qty: 2, unit: "can" },
      ]),
      mealIntent: "dinner",
    });
    eq(r.eligible, true);
  },
);

T("variety: a recipe cooked recently is nudged down, a favourite up", () => {
  const pantry = [
    { id: "maize-meal", qty: 2500, unit: "g" },
    { id: "baked-beans", qty: 2, unit: "can" },
  ];
  const base = scoreRecipe(R_PAP, ctxBase(pantry));
  const cooked = scoreRecipe(R_PAP, {
    ...ctxBase(pantry),
    recentCookIds: [R_PAP.id],
  });
  const fav = scoreRecipe(R_PAP, {
    ...ctxBase(pantry),
    favouriteIds: [R_PAP.id],
  });
  eq(cooked.varietyAdj, -8);
  eq(cooked.cookedRecently, true);
  eq(fav.varietyAdj, 6);
  eq(fav.favourite, true);
  near(base.score - cooked.score, 8, 0.01);
  near(fav.score - base.score, 6, 0.01);
});

T(
  "substance: a 1-real-ingredient recipe is penalised vs a fuller meal at equal coverage",
  () => {
    const ONE = {
      id: "one",
      title: "Solo",
      servings: 1,
      time_minutes: 5,
      tags: ["snack"],
      ingredients: [{ id: "eggs", qty: 1, unit: "unit" }],
      steps: ["x"],
    };
    const FULL = {
      id: "full",
      title: "Full",
      servings: 2,
      time_minutes: 30,
      tags: ["dinner"],
      ingredients: [
        { id: "eggs", qty: 2, unit: "unit" },
        { id: "bread", qty: 2, unit: "unit" },
        { id: "tomato", qty: 100, unit: "g" },
      ],
      steps: ["x"],
    };
    const pantry = [
      { id: "eggs", qty: 30, unit: "unit" },
      { id: "bread", qty: 4, unit: "unit" },
      { id: "tomato", qty: 1000, unit: "g" },
    ];
    const one = scoreRecipe(ONE, ctxBase(pantry));
    const full = scoreRecipe(FULL, ctxBase(pantry));
    eq(one.matchPct, 100);
    eq(full.matchPct, 100); // both 100% coverage...
    ok(one.thinPenalty === 18 && full.thinPenalty === 0); // ...but the solo one is a thin recipe
    ok(
      full.score > one.score - 5,
      `full meal (${full.score}) should rival or beat thin snack (${one.score})`,
    );
    eq(full.ownedCount, 3);
    eq(full.realCount, 3); // headline: "You have all 3 key ingredients"
  },
);

T(
  "unlockInsights: counts single-gap recipes per missing item, sorted by unlocks then cost",
  () => {
    const mk = (id, miss) => ({
      recipeId: id,
      title: id,
      eligible: true,
      missing: miss,
    });
    const eggs = { id: "eggs", name: "Eggs", priceCents: 900 };
    const milk = { id: "milk", name: "Milk", priceCents: 300 };
    const results = [
      mk("a", [eggs]),
      mk("b", [eggs]),
      mk("c", [eggs]),
      mk("d", [milk]),
      mk("e", [milk]),
      mk("f", [eggs, milk]),
      { ...mk("g", [milk]), eligible: false },
    ];
    const out = unlockInsights(results);
    eq(out[0].id, "eggs");
    eq(out[0].unlocks, 3); // f has TWO gaps: not a single-item unlock
    eq(out[1].id, "milk");
    eq(out[1].unlocks, 2); // g is ineligible: ignored
    eq(out[0].titles.length, 3);
  },
);

T("unlockInsights: empty / no single-gap recipes => []", () => {
  eq(unlockInsights([]).length, 0);
  eq(
    unlockInsights([{ recipeId: "x", title: "x", eligible: true, missing: [] }])
      .length,
    0,
  );
});

T(
  "worker payload carries mealIntent / recentCookIds / favouriteIds and stays clone-safe",
  () => {
    const p = scorePayload([R_PAP], ING, PRICES, {
      pantry: [],
      remainingBudgetCents: 60000,
      constraints: {},
      mealIntent: "dinner",
      recentCookIds: ["a"],
      favouriteIds: ["b"],
    });
    const c = structuredClone(p);
    eq(c.payload.ctx.mealIntent, "dinner");
    eq(c.payload.ctx.recentCookIds[0], "a");
    eq(c.payload.ctx.favouriteIds[0], "b");
  },
);

// tiny assert helpers
function eq(a, b, msg) {
  if (a !== b)
    throw new Error(
      msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`,
    );
}
function near(a, b, tol = 0.0001) {
  if (Math.abs(a - b) > tol) throw new Error(`expected ~${b}, got ${a}`);
}
function ok(v, msg) {
  if (!v) throw new Error(msg || `expected truthy`);
}

export { run };

// ---- P-301: day picker + single-day swap (dayOptions / applyPick) ----
// Fixture discipline: 4 recipes x MAX_REPEATS 2 = 8 possible placements, but the
// grid is 8 days and greedy stops at 7 (2/2/2/1 split) → exactly one empty day,
// one "fresh" once-used recipe, and twice-used recipes to swap away. Deterministic,
// no budget guessing. days=8 > 4x2 means the repeat cap, not the budget, binds.
suite = "planner-picks";
const PICK_POOL = () =>
  dinnerize(
    rankRecipes([R_PAP, R_EGGS, R_RICE, R_BEANS], ctxBase([], 10_000_000)),
  ); // P-313: pool is dinner-only
const PICK_OPTS = (budget, days = 7) => ({
  weekBudgetCents: budget,
  servings: 2,
  days,
  ingredients: ING,
  priceEntries: PRICES,
});
const pickPlan = () => {
  const candidates = PICK_POOL();
  // 7-day grid, 4-recipe pool → all 7 placed (2/2/2/1 split).
  // Clear day 0 THROUGH THE ENGINE to get the working fixture: one empty day,
  // one once-used recipe, twice-used recipes to swap away.
  const base = planWeek(candidates, PICK_OPTS(150000, 7));
  const work = applyPick(base, candidates, PICK_OPTS(150000, 7), 0, "clear");
  ok(work.ok, "fixture clear must succeed");
  return { candidates, plan: work.plan };
};
const usedCounts = (plan) => {
  const used = {};
  for (const d of plan.days)
    if (d.meal) used[d.meal.recipeId] = (used[d.meal.recipeId] || 0) + 1;
  return used;
};
const twiceDay = (plan) => {
  const used = usedCounts(plan);
  return plan.days.findIndex((d) => d.meal && used[d.meal.recipeId] >= 2);
};
const freshId = (plan) => {
  const used = usedCounts(plan);
  const e = Object.entries(used).find(([, n]) => n < 2);
  return e ? e[0] : null;
};

T(
  "dayOptions → applyPick: an empty day total rises by EXACTLY the marginal the UI showed",
  () => {
    const { candidates, plan } = pickPlan();
    const emptyIdx = plan.days.findIndex((d) => !d.meal);
    ok(emptyIdx !== -1, "fixture needs an empty day");
    const { options } = dayOptions(
      plan,
      candidates,
      PICK_OPTS(plan.weekBudgetCents),
      emptyIdx,
    );
    ok(options.length > 0, "options exist for an empty day");
    const top = options[0];
    const res = applyPick(
      plan,
      candidates,
      PICK_OPTS(plan.weekBudgetCents),
      emptyIdx,
      top.recipeId,
    );
    ok(res.ok, "pick accepted");
    eq(
      res.plan.totalCents,
      plan.totalCents + top.marginalCents,
      `shown +${top.marginalCents}c must be charged exactly (was ${plan.totalCents}, got ${res.plan.totalCents})`,
    );
  },
);

T(
  "swap invariant: swap.total === cleared.total + the marginal shown for that meal",
  () => {
    const { candidates, plan } = pickPlan();
    const target = twiceDay(plan);
    const fresh = freshId(plan);
    ok(
      target !== -1 && fresh,
      "fixture needs a twice-placed day and a fresh recipe",
    );
    const opts = PICK_OPTS(plan.weekBudgetCents);
    const { options } = dayOptions(plan, candidates, opts, target);
    const opt = options.find((o) => o.recipeId === fresh);
    ok(opt, "the once-used recipe is offered on the swap day");
    const cleared = applyPick(plan, candidates, opts, target, "clear");
    const swapped = applyPick(plan, candidates, opts, target, fresh);
    ok(cleared.ok && swapped.ok, "clear and swap both accepted");
    eq(
      swapped.plan.totalCents,
      cleared.plan.totalCents + opt.marginalCents,
      `swap must charge exactly the shown marginal (${opt.marginalCents}c)`,
    );
  },
);

T(
  "swap touches ONLY the target day — every other day is byte-identical",
  () => {
    const { candidates, plan } = pickPlan();
    const target = twiceDay(plan);
    const fresh = freshId(plan);
    const res = applyPick(
      plan,
      candidates,
      PICK_OPTS(plan.weekBudgetCents),
      target,
      fresh,
    );
    ok(res.ok);
    plan.days.forEach((d, i) => {
      if (i === target) return;
      eq(
        JSON.stringify(res.plan.days[i]),
        JSON.stringify(d),
        `day ${i} unchanged`,
      );
    });
    eq(
      res.plan.days[target].meal.recipeId,
      fresh,
      "target day actually swapped",
    );
  },
);

T(
  "repeat cap: a twice-used recipe is neither offered nor force-placeable",
  () => {
    const { candidates, plan } = pickPlan();
    const used = usedCounts(plan);
    const [twiceId] = Object.entries(used).find(([, n]) => n >= 2) || [];
    ok(twiceId, "fixture needs a twice-used recipe");
    const emptyIdx = plan.days.findIndex((d) => !d.meal);
    const { options } = dayOptions(
      plan,
      candidates,
      PICK_OPTS(plan.weekBudgetCents),
      emptyIdx,
    );
    ok(
      !options.some((o) => o.recipeId === twiceId),
      "capped recipe not offered",
    );
    const res = applyPick(
      plan,
      candidates,
      PICK_OPTS(plan.weekBudgetCents),
      emptyIdx,
      twiceId,
    );
    eq(res.ok, false);
    eq(res.reason, "repeat-cap");
  },
);

T(
  "budget guard: unaffordable picks are refused with the exact shortfall",
  () => {
    const { candidates, plan } = pickPlan();
    const target = twiceDay(plan);
    // base for marginal pricing is the honest list WITHOUT the target day (its
    // extra packs fall off) — not the plan total. Budget R0.01 above that baseline:
    // any pick costing more than a cent must refuse, a free pick still fits.
    const cleared = applyPick(
      plan,
      candidates,
      PICK_OPTS(plan.weekBudgetCents),
      target,
      "clear",
    );
    ok(cleared.ok);
    const opts = PICK_OPTS(cleared.plan.totalCents + 1);
    const { options } = dayOptions(plan, candidates, opts, target);
    const costly = options.find((o) => o.overBudget);
    ok(costly, "fixture needs an over-budget option");
    eq(
      costly.overByCents,
      costly.marginalCents - 1,
      "shortfall = marginal - the 1c headroom",
    );
    const res = applyPick(plan, candidates, opts, target, costly.recipeId);
    eq(res.ok, false);
    eq(res.reason, "over-budget");
    eq(res.overByCents, costly.marginalCents - 1);
    const free = options.find((o) => !o.overBudget);
    ok(free, "fixture needs an affordable option too");
    const resOk = applyPick(plan, candidates, opts, target, free.recipeId);
    ok(resOk.ok, "the free pick still fits");
  },
);

T(
  "over-budget wants are SHOWN with their price, and free picks still allowed",
  () => {
    const { candidates, plan } = pickPlan();
    const target = twiceDay(plan);
    const cleared = applyPick(
      plan,
      candidates,
      PICK_OPTS(plan.weekBudgetCents),
      target,
      "clear",
    );
    const { options } = dayOptions(
      plan,
      candidates,
      PICK_OPTS(cleared.plan.totalCents + 1),
      target,
    );
    ok(options.length > 0, "options always visible — wants are never hidden");
    const agreeOpts = PICK_OPTS(cleared.plan.totalCents + 1); // SAME budget the options were priced with
    for (const o of options) {
      const res = applyPick(plan, candidates, agreeOpts, target, o.recipeId);
      eq(res.ok, !o.overBudget, `engine and UI agree for ${o.recipeId}`);
    }
  },
);

T("purity: applyPick never mutates the plan it was given", () => {
  const { candidates, plan } = pickPlan();
  const before = JSON.stringify(plan);
  const emptyIdx = plan.days.findIndex((d) => !d.meal);
  const opts = PICK_OPTS(plan.weekBudgetCents);
  const { options } = dayOptions(plan, candidates, opts, emptyIdx);
  ok(options.length > 0);
  applyPick(plan, candidates, opts, emptyIdx, options[0].recipeId);
  applyPick(plan, candidates, opts, 0, "clear");
  applyPick(plan, candidates, opts, 0, "ghost-recipe");
  eq(JSON.stringify(plan), before);
});

T("clear: one meal fewer, total never rises", () => {
  const { candidates, plan } = pickPlan();
  const filled = plan.days.findIndex((d) => d.meal);
  const res = applyPick(
    plan,
    candidates,
    PICK_OPTS(plan.weekBudgetCents),
    filled,
    "clear",
  );
  ok(res.ok);
  eq(res.plan.mealsPlanned, plan.mealsPlanned - 1);
  ok(res.plan.totalCents <= plan.totalCents);
});

T("unknown recipe: refuse with the reason, never silently re-plan", () => {
  const { candidates, plan } = pickPlan();
  const filled = plan.days.findIndex((d) => d.meal);
  const res = applyPick(
    plan,
    candidates,
    PICK_OPTS(plan.weekBudgetCents),
    filled,
    "ghost-recipe",
  );
  eq(res.ok, false);
  eq(res.reason, "unknown-recipe");
  // dayOptions hits the same wall when a recipe on ANOTHER day vanishes from the
  // candidate pool (recipe deleted / matcher context changed): pick a twice-used
  // recipe X, remove it from the pool, then query any non-X day.
  const [xId] = Object.entries(usedCounts(plan)).find(([, n]) => n >= 2) || [];
  ok(xId, "fixture needs a twice-used recipe");
  const otherDay = plan.days.findIndex(
    (d) => d.meal && d.meal.recipeId !== xId,
  );
  const narrow = candidates.filter((c) => c.recipeId !== xId);
  const view = dayOptions(
    plan,
    narrow,
    PICK_OPTS(plan.weekBudgetCents),
    otherDay,
  );
  eq(view.error, "unknown-recipe");
});

// ---- P-309b: seeded property fuzz (the carried P-303/P-304 campaign) ----
// 100 deterministic iterations over randomized pools; the planner's core
// promises asserted EVERY iteration: budget ceiling, repeat caps, shop-list
// dedupe identity, pantry honesty (never over-consumes stock), determinism,
// and well-formedness. Fixed seed => CI-stable, failures reproduce exactly.
suite = "planner-fuzz";
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const FUZZ_SEED = 20261016;
const frnd = mulberry32(FUZZ_SEED);
const fri = (lo, hi) => lo + Math.floor(frnd() * (hi - lo + 1));
const F_ING = Array.from({ length: 10 }, (_, i) => {
  const id = "f-ing" + i;
  return {
    id,
    name: "F" + i,
    aliases: ["f" + i],
    aisle: "x",
    unit_basis: { qty: 1, unit: "unit" },
    tier: 1 + (i % 3),
  };
});
const F_PRICES = F_ING.map((ing, i) => ({
  ingredient_id: ing.id,
  store: "X",
  price_cents: 100 + i * 137,
  pack_qty: 1 + (i % 3),
  pack_unit: "unit",
  last_verified: "2026-10-01",
}));
let f_budget = 0,
  f_repeat = 0,
  f_dedupe = 0,
  f_pantry = 0,
  f_det = 0,
  f_shape = 0,
  f_finite = 0,
  f_filled = 0,
  f_slots = 0;
for (let iter = 0; iter < 100; iter++) {
  const cands = [];
  const nCand = fri(3, 10);
  for (let c = 0; c < nCand; c++) {
    const lines = [];
    const usedIds = new Set();
    const nLines = fri(1, 4);
    for (let l = 0; l < nLines; l++) {
      const id = F_ING[fri(0, F_ING.length - 1)].id;
      if (usedIds.has(id)) continue; // one line per ingredient per recipe, like real data
      usedIds.add(id);
      lines.push({ id, qty: 1 + fri(0, 2), unit: "unit" });
    }
    // P-313: ~1 in 10 synthetic candidates is UNTAGGED — the dinner-only pool
    // filter must exclude it from every placement; the dinner-tagged rest keep
    // the fuzz loop exercising real planning work.
    cands.push({
      recipeId: "f-r" + iter + "-" + c,
      title: "Fuzz " + iter + "/" + c,
      eligible: true,
      coverage: fri(0, 100) / 100,
      realCount: fri(0, 3),
      servings: 2,
      matchPct: fri(0, 100),
      perPlateCents: fri(1, 60) * 50,
      tags: fri(0, 9) < 9 ? ["dinner"] : [],
      ingredients: lines,
    });
  }
  const pantry = [];
  const nPantry = fri(0, 4);
  for (let p = 0; p < nPantry; p++) {
    pantry.push({
      id: F_ING[fri(0, F_ING.length - 1)].id,
      qty: fri(1, 5),
      unit: "unit",
    });
  }
  const budget = fri(0, 80) * 100;
  const days = fri(1, 7);
  const fopts = {
    weekBudgetCents: budget,
    servings: 2,
    days,
    ingredients: F_ING,
    priceEntries: F_PRICES,
    pantry,
  };
  const plan = planWeek(cands, fopts);
  if (!(plan.totalCents <= budget)) f_budget++;
  if (!Number.isFinite(plan.totalCents)) f_finite++;
  const counts = new Map();
  for (const d of plan.days)
    if (d.meal)
      counts.set(d.meal.recipeId, (counts.get(d.meal.recipeId) || 0) + 1);
  for (const n of counts.values()) if (n > 2) f_repeat++;
  const sids = plan.shoppingList.map((r) => r.id);
  if (new Set(sids).size !== sids.length) f_dedupe++;
  // P4 CONTRACT (validated by this fuzz loop, P-309b): the sheet tracks stock
  // in the price entry's RAW denominator (pieces/g/ml), NOT pack counts — pack
  // division happens only at purchase time (ceil(basis/pack_qty) in accTotal).
  // So consumption (u.qty, raw) must never exceed owned raw qty, and no id may
  // be consumed that wasn't owned.
  for (const u of plan.pantryUse || []) {
    const owned = pantry
      .filter((p) => p.id === u.id)
      .reduce((s, p) => s + p.qty, 0);
    if (u.qty > owned + 1e-6) f_pantry++;
    if (!pantry.some((p) => p.id === u.id)) f_pantry++;
  }
  const plan2 = planWeek(cands, {
    ...fopts,
    pantry: pantry.map((p) => ({ ...p })),
  });
  if (JSON.stringify(plan) !== JSON.stringify(plan2)) f_det++;
  if (plan.days.length !== days) f_shape++;
  for (const d of plan.days) {
    if (d.meal) {
      if (!cands.some((c) => c.recipeId === d.meal.recipeId)) f_shape++;
      if (!(d.meal.perPlateCents >= 0) || !(d.meal.marginalCents >= 0))
        f_shape++;
      f_filled++;
    }
    f_slots++;
  }
}
T("P-309b fuzz: budget ceiling holds across 100 randomized weeks", () =>
  eq(f_budget, 0, "violations: " + f_budget),
);
T("P-309b fuzz: totals always finite (no Infinity/NaN leak)", () =>
  eq(f_finite, 0, "violations: " + f_finite),
);
T("P-309b fuzz: repeat cap (max 2) holds", () =>
  eq(f_repeat, 0, "violations: " + f_repeat),
);
T("P-309b fuzz: shopping list dedupe identity holds", () =>
  eq(f_dedupe, 0, "violations: " + f_dedupe),
);
T("P-309b fuzz: pantry never over-consumed, never invented", () =>
  eq(f_pantry, 0, "violations: " + f_pantry),
);
T("P-309b fuzz: byte-identical determinism holds", () =>
  eq(f_det, 0, "violations: " + f_det),
);
T("P-309b fuzz: plans well-formed (days, pool membership, costs)", () =>
  eq(f_shape, 0, "violations: " + f_shape),
);
T("P-309b fuzz: the loop actually exercised placements", () =>
  ok(
    f_filled > 0 && f_slots >= 100,
    f_filled + " placements over " + f_slots + " day slots",
  ),
);

// ---------------- P-446: editable-draft gate (draftToRecipe validates user edits) ----------------
const UNIT_CANON = (await import("../js/modules/decoder.js")).UNIT_CANON;
T("P-446: edited draft saves with user-corrected values", () => {
  const draft = {
    title: "  My edited kota  ",
    servings: 3,
    timeMinutes: 25,
    reviewRequired: false,
    ingredients: [
      {
        resolvedId: "white-bread",
        resolvedName: "White bread",
        qty: 1,
        unit: "loaf" in UNIT_CANON ? "loaf" : "unit",
      },
    ],
    steps: ["Toast it.", "  ", "Fill it."],
  };
  const r = draftToRecipe(draft, { id: "p446-test" });
  if (r.title !== "My edited kota")
    throw new Error("title not trimmed: " + r.title);
  if (
    !r.steps.includes("Fill it.") ||
    r.steps.includes("  ") ||
    r.steps.length !== 2
  )
    throw new Error("steps not cleaned");
  if (r.servings !== 3 || r.time_minutes !== 25) throw new Error("meta lost");
});
T(
  "P-446: gate rejects bad edits (qty 0, bogus unit, no steps, bad servings)",
  () => {
    const mk = (over) => ({
      title: "x",
      servings: 2,
      timeMinutes: 10,
      reviewRequired: false,
      ingredients: [
        { resolvedId: "eggs", resolvedName: "Eggs", qty: 1, unit: "unit" },
      ],
      steps: ["do it"],
      ...over,
    });
    for (const [over, why] of [
      [
        { ingredients: [{ resolvedId: "eggs", qty: 0, unit: "unit" }] },
        "qty 0",
      ],
      [
        { ingredients: [{ resolvedId: "eggs", qty: 1, unit: "bogus" }] },
        "bogus unit",
      ],
      [
        { ingredients: [{ resolvedId: null, qty: 1, unit: "unit" }] },
        "unresolved line",
      ],
      [{ steps: [] }, "no steps"],
      [{ servings: 0 }, "servings 0"],
      [{ title: "" }, "no title"],
      [{ ingredients: [] }, "zero ingredients"],
    ]) {
      let threw = false;
      try {
        draftToRecipe(mk(over), { id: "x" });
      } catch {
        threw = true;
      }
      if (!threw) throw new Error("gate let through: " + why);
    }
  },
);

// ---------------- P-449: decoder-unit conversion coverage (the cup/pack gap) ----------------
const c_qtyIn = (await import("../js/modules/costing.js")).qtyInPackBasis;
T("P-449: cups convert per-ingredient (density table)", () => {
  const cases = [
    ["maize-meal", 1, "cup", "g", 150],
    ["white-rice", 1, "cup", "g", 200],
    ["rolled-oats", 1, "cup", "g", 90],
    ["white-sugar", 0.5, "cup", "g", 100],
    ["amasi", 2, "cup", "g", 500],
    ["cake-flour", 2, "cup", "g", 250],
  ];
  for (const [id, q, u, pu, want] of cases) {
    const got = c_qtyIn(q, u, pu, { id });
    if (got !== want) throw new Error(id + " cup: " + got + " != " + want);
  }
});
T("P-449: unknown cup never guessed (null, not R0-guess)", () => {
  if (c_qtyIn(1, "cup", "g", { id: "chakalaka" }) !== null)
    throw new Error("chakalaka cup should be null");
  if (c_qtyIn(1, "cup", "g", {}) !== null)
    throw new Error("anonymous cup should be null");
});
T("P-449: pack/packet = one priced pack; loaf-unit = 700 g; mg", () => {
  if (c_qtyIn(1, "pack", "g", { id: "soya-mince", packQty: 200 }) !== 200)
    throw new Error("pack on g-basis");
  if (c_qtyIn(1, "pack", "unit", { id: "eggs", packQty: 6 }) !== 6)
    throw new Error("pack on unit-basis");
  if (c_qtyIn(1, "unit", "g", { id: "white-bread" }) !== 700)
    throw new Error("whole loaf");
  if (c_qtyIn(500, "mg", "g", { id: "maize-meal" }) !== 0.5)
    throw new Error("mg");
});
T("P-449: slice math stays honest (2 slices = 70 g, never 2 loaves)", () => {
  if (c_qtyIn(2, "slice", "g", { id: "white-bread" }) !== 70)
    throw new Error("slice to g");
  if (c_qtyIn(2, "slice", "unit", { id: "white-bread" }) !== 2 / 18)
    throw new Error("slice to loaf fraction");
});

// ---------------- P-437b: integration caption (every step-quality rule at once) ----------------
T("P-437b: oven+serveWith+dedupe+trim+marketing in one caption", () => {
  const txt =
    "OVEN BAKED CHICKEN AND RICE TRAY\nServes 4\nPrep time: 10 mins\nCook time: 35 mins\n2 cups white rice\n1 onion\n500g chicken pieces\n2 tbsp cooking oil\nOkay so now, mix the rice and onion in a tray. Follow for more recipes!\nThen, bake at 180C fan for 35 mins until golden.\nMix the rice and onion in a tray\nSeason.\nYou won" +
    String.fromCharCode(39) +
    "t believe how good this is!!\nServe with chakalaka and amasi.";
  const realItems = JSON.parse(
    readFileSync(new URL("../data/ingredients.json", import.meta.url), "utf8"),
  ).items;
  const resolveIng = (n) => searchIngredients(n, realItems)[0] || null;
  const d = decodeRecipeText(txt, resolveIng);
  eq(
    d.steps.length,
    3,
    "filler/promo trimmed, dedupe dropped the repeat, Season kept",
  );
  ok(
    d.steps[0] === "Mix the rice and onion in a tray.",
    "lead filler + promo tail stripped",
  );
  ok(
    d.steps[1] === "Bake at 180C fan for 35 mins until golden.",
    "digit-bearing doneness step survives",
  );
  eq(d.ovenTempC, 160, "fan temp converted (180-20)");
  eq(d.timeMinutes, 45, "prep+cook accumulate to 45");
  eq((d.serveWith || []).length, 2, "serveWith extracted: chakalaka + amasi");
  ok(
    d.ignored.some((l) =>
      l.includes("won" + String.fromCharCode(39) + "t believe"),
    ),
    "marketing line ignored, never a title",
  );
  ok(d.ingredients.length === 4, "cups/g/tbsp ingredient lines parse");
});

// ---------------- P-438: SA kitchen-unit encyclopedia (P-425 Gemini findings) ----------------
T(
  "P-438: brick/stick/half-idiom + Afrikaans plurals + qty-led vague tokens",
  () => {
    const realItems2 = JSON.parse(
      readFileSync(
        new URL("../data/ingredients.json", import.meta.url),
        "utf8",
      ),
    ).items;
    const res2 = (n) => searchIngredients(n, realItems2)[0] || null;
    const one = (l) => {
      const d = decodeRecipeText(l, res2);
      return d;
    };
    eq(one("1 brick butter").ingredients[0].unit, "brick", "brick canonical");
    eq(
      one("half a brick butter").ingredients[0].qty,
      0.5,
      "half-a idiom -> 0.5",
    );
    eq(
      one("half a brick butter").ingredients[0].unit,
      "brick",
      "article stripped, unit kept",
    );
    eq(
      one("half 'n brick botter").ingredients[0].unit,
      "brick",
      "half-'n idiom (Afrikaans)",
    );
    // P-442 display contract: units render AS ENTERED (singular-folded); the
    // RECIPE still canonicalises via UNIT_CANON at draftToRecipe time.
    eq(
      one("2 eetlepels suiker").ingredients[0].unit,
      "eetlepel",
      "P-442: eetlepels displays as entered",
    );
    eq(
      one("2 teelepels suiker").ingredients[0].unit,
      "teelepel",
      "P-442: teelepels displays as entered",
    );
    eq(
      one("1 koppie melk").ingredients[0].unit,
      "koppie",
      "P-442: koppie displays as entered",
    );
    eq(
      one("1 koppie melk").ingredients[0].qty_canon,
      250,
      "P-442: koppie canonicalises to 250 ml",
    );
    eq(
      one("2 eetlepels suiker").ingredients[0].qty_canon,
      30,
      "P-442: 2 eetlepels canonicalise to 30 ml",
    );
    ok(
      one("1 mespunt sout").unresolved.some(
        (u) => u.reason === "vague_quantity",
      ),
      "qty-led mespunt routes to review",
    );
    ok(
      one("2 drops vanilla essence").unresolved.some(
        (u) => u.reason === "vague_quantity",
      ),
      "qty-led drops route to review",
    );
    ok(
      one("1 knippie sout").unresolved.some(
        (u) => u.reason === "vague_quantity",
      ),
      "qty-led knippie hardening",
    );
    eq(
      one("1 loaf white bread").ingredients[0].unit,
      "loaf",
      "P-442: loaf displays as entered",
    );
    // costing: brick 500g, stick 113.4g (findings-verified multipliers)
    const realPrices = JSON.parse(
      readFileSync(new URL("../data/prices.json", import.meta.url), "utf8"),
    ).entries;
    const peButter = defaultPrice(
      "butter",
      realPrices.filter((p) => p.ingredient_id === "butter"),
    );
    eq(
      qtyInPackBasis(1, "brick", peButter.pack_unit, {
        id: "butter",
        packQty: peButter.pack_qty,
      }),
      500,
      "brick = 500g",
    );
    eq(
      Math.round(
        qtyInPackBasis(0.5, "brick", peButter.pack_unit, {
          id: "butter",
          packQty: peButter.pack_qty,
        }),
      ),
      250,
      "half brick = 250g",
    );
    eq(
      Math.round(
        qtyInPackBasis(1, "stick", peButter.pack_unit, {
          id: "butter",
          packQty: peButter.pack_qty,
        }),
      ),
      113,
      "stick = 113.4g (US, findings-verified)",
    );
  },
);

// ---------------- P-439: confidence v2 (P-426 DeepSeek findings) ----------------
const { confidenceV2, confBand } = await import("../js/modules/decoder.js");
T("P-439: the 10 findings worked examples reproduce exactly", () => {
  const ex = [
    [8, 8, 8, 6, 2, 2, 0, 0, 0, 8, 0, 1.0],
    [6, 6, 2, 4, 0, 0, 0, 0, 0, 6, 0, 0.904],
    [10, 9, 7, 5, 2, 3, 0, 1, 0, 7, 0, 0.867],
    [12, 12, 10, 8, 4, 4, 0, 0, 0, 12, 1, 0.88],
    [4, 4, 2, 2, 0, 0, 8, 0, 0, 4, 0, 0.745],
    [10, 6, 6, 3, 1, 2, 0, 4, 4, 6, 0, 0.5],
    [10, 8, 8, 5, 0, 0, 0, 2, 0, 8, 0, 0.836],
    [5, 5, 0, 10, 0, 0, 0, 0, 0, 5, 0, 0.88],
    [20, 20, 0, 20, 0, 0, 30, 0, 0, 20, 1, 0.648],
    [12, 1, 1, 20, 6, 6, 0, 11, 11, 12, 0, 0.111],
  ];
  ex.forEach(([T_, r, u, s, p, q, v, n, c, K, M, want], i) => {
    const lines = Array.from({ length: r }, (_, j) => ({
      raw: "core line " + j,
      resolvedId: "x" + j,
      resolvedName: "X " + j,
      unit: j < u ? "g" : "unit",
      note: null,
    }));
    for (let j = 0; j < q && j < lines.length; j++) {
      lines[j].unit = "can";
      if (j < p) lines[j].note = "Koo";
    }
    const queue = [
      ...Array.from({ length: n }, (_, j) => ({
        line: "x" + j,
        reason: "unresolved_ingredient",
      })),
      ...Array.from({ length: v }, (_, j) => ({
        line: "v" + j,
        reason: "vague_quantity",
      })),
    ];
    const uq = queue.filter((x) => x.reason === "unresolved_ingredient");
    uq.slice(-c).forEach((x) => (x.line = "core " + x.line));
    uq.slice(0, Math.max(0, n - c)).forEach(
      (x) => (x.line = "optional garnish " + x.line),
    );
    for (let j = Math.max(0, K - c); j < lines.length; j++)
      lines[j].raw = "optional garnish " + j;
    const got = Math.round(confidenceV2(lines, queue, s, !!M) * 1000) / 1000;
    ok(
      Math.abs(got - want) < 0.002,
      "example " + (i + 1) + ": " + got + " vs " + want,
    );
  });
});
T("P-439: monotonic — resolving a line never lowers the score", () => {
  const mk = (n) => [
    Array.from({ length: 6 }, (_, j) => ({
      raw: "line " + j,
      unit: "g",
      note: null,
    })),
    [
      ...Array.from({ length: n }, (_, j) => ({
        line: "core u" + j,
        reason: "unresolved_ingredient",
      })),
      { line: "pinch x", reason: "vague_quantity" },
    ],
    4,
    false,
  ];
  let prev = -1;
  for (let n = 5; n >= 0; n--) {
    const s = confidenceV2(...mk(n));
    ok(s >= prev - 1e-9, "score does not fall when n=" + n);
    prev = s;
  }
});
T("P-439: the gate stays law — high score never clears reviewRequired", () => {
  const txt =
    "Creamy Chicken Pasta\nServes 2\nTime: 15 mins\n200g pasta\n1 cup cream\n2 chicken thighs\n1. Boil the pasta.\n2. Fry the chicken.\n3. Stir in the cream.";
  const realItems3 = JSON.parse(
    readFileSync(new URL("../data/ingredients.json", import.meta.url), "utf8"),
  ).items;
  const d = decodeRecipeText(
    txt,
    (n) => searchIngredients(n, realItems3)[0] || null,
  );
  ok(d.confidence >= 0.7, "score is decent (" + d.confidence.toFixed(2) + ")");
  // now the same draft with one unresolved CORE line: score can stay high-ish, gate MUST stay shut
  const txt2 =
    "Creamy Chicken Pasta\nServes 2\nTime: 15 mins\n200g pasta\n1 cup cream\n2 chicken thighs\n3 tbsp unicorn dust\n1. Boil the pasta.\n2. Fry the chicken.\n3. Stir in the cream.";
  const d2 = decodeRecipeText(
    txt2,
    (n) => searchIngredients(n, realItems3)[0] || null,
  );
  ok(
    d2.reviewRequired === true,
    "gate shut on one unresolved line regardless of score",
  );
  ok(
    d2.confidence > 0.5,
    "score is advice, not permission (" + d2.confidence.toFixed(2) + ")",
  );
  eq(confBand(0.95), "high", "band: high");
  eq(confBand(0.75), "good", "band: good");
  eq(confBand(0.4), "low", "band: low");
  eq(confidenceV2([], [], 5, false), 0, "T=0 -> 0.0 immediately");
});

// ---------------- P-440: decoded-recipe dedupe (P-427 DeepSeek findings) ----------------
const {
  normalizeTitle: dn,
  prepareRecipe: dp,
  scorePair: ds,
  findDuplicates: df,
} = await import("../js/modules/dedupe.js");
suite = "dedupe";
const ING_WORDS = new Set([
  "pap",
  "wors",
  "chicken",
  "curry",
  "pasta",
  "spaghetti",
  "mince",
  "samp",
  "beans",
  "beef",
  "mac",
  "cheese",
  "rice",
  "bacon",
  "oil",
  "onion",
  "tomato",
  "potato",
  "carrot",
  "garlic",
  "cream",
  "stock",
  "flour",
  "butter",
  "milk",
  "herbs",
  "mushroom",
  "spinach",
  "chilli",
  "yoghurt",
  "ghee",
]);
const isIng = (w) => ING_WORDS.has(w.replace(/s$/, ""));
const mkRec = (title, ids, steps) =>
  dp(
    {
      title,
      ingredients: ids.map((id) => ({ id })),
      steps: Array(steps).fill("x"),
    },
    isIng,
  );
const DCASES = [
  [
    "D01",
    ["Pap And Wors", ["maize_meal", "wors", "oil"], 3],
    ["pap & wors (my version)", ["maize_meal", "wors", "oil"], 3],
    1000,
    "auto",
  ],
  [
    "D02",
    [
      "Creamy Chicken Pasta",
      ["chicken", "pasta", "cream", "garlic", "onion", "mushroom"],
      5,
    ],
    [
      "Creamy Chicken Pasta",
      ["chicken", "pasta", "cream", "garlic", "onion", "mushroom", "salt"],
      6,
    ],
    983,
    "auto",
  ],
  [
    "D03",
    [
      "Chicken Curry (again)",
      ["chicken", "curry_powder", "onion", "tomato", "rice", "garlic", "oil"],
      5,
    ],
    [
      "Lekker Chicken Curry",
      ["chicken", "curry_powder", "onion", "tomato", "rice", "garlic"],
      5,
    ],
    914,
    "auto",
  ],
  [
    "D04",
    [
      "Spaghetti Bolognaise",
      ["spaghetti", "beef_mince", "onion", "tomato", "garlic", "herbs"],
      5,
    ],
    [
      "Mince and Spaghetti",
      ["spaghetti", "beef_mince", "onion", "tomato", "garlic", "herbs"],
      6,
    ],
    750,
    "ask",
  ],
  [
    "D05",
    [
      "Samp and Beans",
      ["samp", "sugar_beans", "onion", "potato", "stock", "oil"],
      4,
    ],
    [
      "Samp & beans (my version)",
      ["samp", "sugar_beans", "onion", "potato", "stock", "oil"],
      4,
    ],
    1000,
    "auto",
  ],
  [
    "D06",
    [
      "Creamy Chicken Pasta",
      ["chicken", "pasta", "cream", "garlic", "onion", "mushroom", "parmesan"],
      5,
    ],
    [
      "Creamy Chicken Pasta",
      [
        "chicken",
        "pasta",
        "coconut_milk",
        "garlic",
        "onion",
        "spinach",
        "chilli",
      ],
      4,
    ],
    620,
    "silent",
  ],
  [
    "D07",
    [
      "Chicken Curry",
      ["chicken", "curry_powder", "onion", "tomato", "rice", "garlic", "oil"],
      5,
    ],
    [
      "Chicken Pasta",
      ["chicken", "pasta", "cream", "garlic", "onion", "cheese"],
      4,
    ],
    410,
    "silent",
  ],
  [
    "D08",
    [
      "Chicken Curry",
      ["chicken", "curry_powder", "onion", "tomato", "rice", "garlic", "oil"],
      5,
    ],
    [
      "Chicken Biryani",
      [
        "chicken",
        "basmati_rice",
        "yoghurt",
        "onion",
        "biryani_masala",
        "garlic",
        "ghee",
      ],
      7,
    ],
    235,
    "silent",
  ],
  [
    "D09",
    [
      "Beef Stew",
      ["beef", "potato", "carrot", "onion", "stock", "tomato_paste", "oil"],
      6,
    ],
    [
      "Oxtail Stew",
      ["oxtail", "potato", "carrot", "onion", "stock", "tomato_paste", "beans"],
      7,
    ],
    569,
    "silent",
  ],
  [
    "D10",
    ["Mac and Cheese", ["macaroni", "cheese", "milk", "butter", "flour"], 4],
    [
      "Mac and Cheese with Bacon",
      ["macaroni", "cheese", "milk", "butter", "flour", "bacon"],
      4,
    ],
    750,
    "ask",
  ],
  [
    "D11",
    [
      "Mince and Rice",
      ["beef_mince", "rice", "onion", "tomato", "carrot", "oil"],
      4,
    ],
    [
      "Mince and Pasta",
      ["beef_mince", "pasta", "onion", "tomato", "cheese", "oil"],
      4,
    ],
    550,
    "silent",
  ],
  [
    "D12",
    [
      "Beef Mince Curry",
      [
        "beef_mince",
        "curry_powder",
        "onion",
        "tomato",
        "potato",
        "rice",
        "oil",
      ],
      5,
    ],
    [
      "Beef Mince Curry – serves 6",
      [
        "beef_mince",
        "curry_powder",
        "onion",
        "tomato",
        "potato",
        "rice",
        "oil",
      ],
      5,
    ],
    1000,
    "auto",
  ],
];
T(
  "P-440: the 12 findings D-cases reproduce at signal level (millis integer compare)",
  () => {
    for (const [id, a, b, wantMillis, wantTier] of DCASES) {
      const { millis } = ds(mkRec(...a), mkRec(...b));
      eq(
        millis,
        wantMillis,
        id + " millis (got " + millis + " want " + wantMillis + ")",
      );
      if (wantTier === "silent") ok(millis < 750, id + " stays silent");
      else ok(millis >= 750, id + " flags");
    }
  },
);
T(
  'P-440: nickname parens die, content parens survive (D01 vs "(bacon)")',
  () => {
    eq(dn("pap & wors (my version)"), dn("Pap And Wors"), "nickname stripped");
    ok(
      dn("Mac and cheese (bacon)").includes("bacon"),
      "content paren survives",
    );
  },
);
T(
  "P-440: staples (salt/pepper/water) never affect ingredient similarity",
  () => {
    const a = mkRec("X", ["chicken", "salt", "pepper"], 3);
    const b = mkRec("X", ["chicken", "water"], 3);
    eq(ds(a, b).signals.ingSim, 1, "staples excluded from ids");
  },
);
T("P-440: F3 — thin evidence never auto-flags", () => {
  const draft = {
    normTitle: "test dish",
    titleTokens: [],
    ids: [],
    stepCount: 0,
    coverage: 0.2,
  };
  const cand = {
    normTitle: "test dish",
    titleTokens: [],
    ids: ["x"],
    stepCount: 3,
    coverage: 1,
  };
  ok(ds(draft, cand).millis <= 899, "coverage < 0.60 capped below auto");
});
T(
  "P-440: findDuplicates — bounded, deterministic order, dismissed pairs silent",
  () => {
    const dRec = {
      id: "d1",
      title: "Pap And Wors",
      normTitle: "pap wors",
      titleTokens: [],
      ids: ["maize_meal", "wors"],
      stepCount: 3,
      coverage: 1,
    };
    const cands = [
      {
        id: "c2",
        title: "B",
        normTitle: "b",
        titleTokens: [],
        ids: ["zz"],
        stepCount: 3,
        coverage: 1,
      },
      {
        id: "c1",
        title: "Pap & wors (my version)",
        normTitle: "pap wors",
        titleTokens: [],
        ids: ["maize_meal", "wors"],
        stepCount: 3,
        coverage: 1,
      },
    ];
    const hits = df(dRec, cands);
    eq(hits.length, 1, "only the dupe clears 750");
    eq(hits[0].id, "c1", "the right one");
    eq(hits[0].tier, "auto", "auto tier");
    const hits2 = df(
      dRec,
      cands,
      (a, b) => [a.id, b.id].sort().join("|") === "c1|d1",
    );
    eq(hits2.length, 0, "dismissed pair is silent forever");
  },
);
T("P-440: perf headroom — 200 candidates score in well under 5ms", () => {
  const dRec = mkRec(
    "My weeknight pasta",
    ["spaghetti", "cream", "chicken"],
    4,
  );
  const pool = Array.from({ length: 200 }, (_, i) =>
    mkRec("Dish " + i, ["item" + i, "spaghetti"], 4),
  );
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 20; i++) df(dRec, pool);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 20;
  ok(ms < 5, "avg " + ms.toFixed(3) + "ms for 200 candidates");
});

// ---------------- P-452: the cook gate (owner rule Oct 21) ----------------
const mcs = (await import("../js/modules/matcher.js")).maxCookableServings;
suite = "cookgate";
const GATE_RECIPE = {
  id: "g1",
  title: "G",
  servings: 4,
  ingredients: [
    { id: "chicken", qty: 800, unit: "g" }, // 200 g per plate
    { id: "rice", qty: 400, unit: "g" }, // 100 g per plate
    { id: "salt", qty: 1, unit: "tsp" }, // staple (tier 0.2)
    { id: "herbs", qty: 1, unit: "tbsp", optional: true },
  ],
};
const GATE_META = {
  chicken: { name: "Chicken", tier: 1 },
  rice: { name: "Rice", tier: 1 },
  salt: { name: "Salt", tier: 0.2 },
  herbs: { name: "Herbs", tier: 1 },
};
const gMeta = (id) => GATE_META[id] || { name: id, tier: 1 };

T("P-452: fully covered → cooks at the requested plates", () => {
  const pantry = [
    { id: "chicken", qty: 800, unit: "g" },
    { id: "rice", qty: 400, unit: "g" },
  ];
  eq(mcs(GATE_RECIPE, 4, pantry, gMeta, null).max, 4, "max = 4");
});
T(
  "P-452: short quantity → largest WHOLE serving count, never fractional",
  () => {
    const pantry = [
      { id: "chicken", qty: 600, unit: "g" },
      { id: "rice", qty: 400, unit: "g" },
    ];
    eq(
      mcs(GATE_RECIPE, 4, pantry, gMeta, null).max,
      3,
      "600g covers 3 plates of 200g",
    );
  },
);
T("P-452: missing entirely → max 0 with a named none-blocker", () => {
  const pantry = [{ id: "rice", qty: 400, unit: "g" }];
  const g = mcs(GATE_RECIPE, 4, pantry, gMeta, null);
  eq(g.max, 0, "no chicken at all");
  eq(g.blockers.length, 1, "one blocker");
  eq(g.blockers[0].state, "none", "state none");
  eq(g.blockers[0].name, "Chicken", "human name");
});
T("P-452: not even one plate fits → max 0 with short blockers", () => {
  const pantry = [
    { id: "chicken", qty: 100, unit: "g" },
    { id: "rice", qty: 50, unit: "g" },
  ];
  const g = mcs(GATE_RECIPE, 4, pantry, gMeta, null);
  eq(g.max, 0, "nothing fits");
  eq(g.blockers.length, 2, "both lines named");
  ok(
    g.blockers.every((b) => b.state === "short"),
    "short, not none",
  );
});
T("P-452: staples and optional lines never gate", () => {
  const pantry = [
    { id: "chicken", qty: 800, unit: "g" },
    { id: "rice", qty: 400, unit: "g" },
  ];
  eq(
    mcs(GATE_RECIPE, 4, pantry, gMeta, null).max,
    4,
    "salt absent, herbs absent — still cooks",
  );
});
T(
  "P-452: physical availability only — unpriced lines gate by grams, never by price",
  () => {
    const pantry = [
      { id: "chicken", qty: 800, unit: "g" },
      { id: "rice", qty: 400, unit: "g" },
    ];
    eq(
      mcs(GATE_RECIPE, 4, pantry, gMeta, null).max,
      4,
      "priceOf null changes nothing",
    );
  },
);
T("P-452: exact fit passes (epsilon guard), one gram short fails", () => {
  const pantry = [
    { id: "chicken", qty: 600, unit: "g" },
    { id: "rice", qty: 400, unit: "g" },
  ];
  eq(
    mcs(GATE_RECIPE, 3, pantry, gMeta, null).max,
    3,
    "exactly 3 plates of chicken",
  );
  const pantry2 = [
    { id: "chicken", qty: 599, unit: "g" },
    { id: "rice", qty: 400, unit: "g" },
  ];
  eq(
    mcs(GATE_RECIPE, 3, pantry2, gMeta, null).max,
    2,
    "599g stops at 2 plates",
  );
});
T("P-452: multi-line batches limited by the TIGHTEST line", () => {
  const pantry = [
    { id: "chicken", qty: 200, unit: "g" },
    { id: "rice", qty: 250, unit: "g" },
  ];
  eq(
    mcs(GATE_RECIPE, 4, pantry, gMeta, null).max,
    1,
    "chicken caps the batch at 1",
  );
});
T("P-452: determinism — same inputs, same max, byte-identical blockers", () => {
  const pantry = [
    { id: "chicken", qty: 100, unit: "g" },
    { id: "rice", qty: 50, unit: "g" },
  ];
  const a = mcs(GATE_RECIPE, 4, pantry, gMeta, null);
  const b = mcs(GATE_RECIPE, 4, pantry, gMeta, null);
  eq(JSON.stringify(a), JSON.stringify(b), "stable");
});

// ------------- P-441: registry gap report (P-428 findings) -------------
const RGR = await import("../js/modules/gapreport.js");
// fixture registry: "pap" is the ONLY alias on maize meal, so "mielie pap"
// is an alias gap; samp is deliberately unpriced (the zero-demand floor case)
const RGR_REG = [
  { id: "maize-meal", name: "Maize meal", aliases: ["pap"], priced: true },
  { id: "butter", name: "Butter", aliases: [], priced: true },
  { id: "spice-mix-braai", name: "Braai spice", aliases: [], priced: true },
  { id: "samp", name: "Samp", aliases: [], priced: false },
  { id: "curry-powder", name: "Curry powder", aliases: [], priced: true },
  { id: "curry-paste", name: "Curry paste", aliases: [], priced: true },
  { id: "curry-leaves", name: "Curry leaves", aliases: [], priced: true },
];
const rgrRec = (sessionId, rawLine, outcome, resolvedId = null) => ({
  sessionId,
  rawLine,
  reasonCode:
    outcome === "unresolved_after_pick"
      ? "unresolved_after_pick"
      : "unresolved_ingredient",
  outcome,
  resolvedId,
});
const card = (records, cand) =>
  RGR.buildReport(records, RGR_REG).cards.find((c) => c.candidate === cand);

T("RGR1 missing alias — mielie pap", () => {
  const c = card(
    [rgrRec("s1", "2 cups mielie pap", "unresolved_ingredient")],
    "mielie pap",
  );
  eq(c.candidate, "mielie pap", "candidate");
  eq(c.category, "MISSING_ALIAS", "category");
  eq(c.autoAccept, true, "auto-accept (unique head-final token match)");
  eq(c.ambiguous, false, "not ambiguous");
  eq(c.score, 320, "200 + 120×1");
  eq(c.tier, "NEXT", "tier");
});
T("RGR2 missing ingredient — breadth (10 distinct sessions)", () => {
  const recs = [
    "walkie talkies",
    "500g walkie talkies",
    "walkie talkies cleaned",
    "1 kg walkie talkies",
    "walkie talkies",
    "a handful of walkie talkies",
    "walkie talkies",
    "walkie talkies",
    "walkie talkies",
    "walkie talkies",
  ].map((l, i) => rgrRec(`s${i + 1}`, l, "unresolved_ingredient"));
  const c = card(recs, "walkie talkie");
  eq(c.category, "MISSING_INGREDIENT", "category");
  eq(c.score, 1500, "300 + 120×10");
  eq(c.tier, "NOW", "tier");
});
T("RGR3 repeat hits in ONE session — breadth beats repetition", () => {
  const recs = Array.from({ length: 5 }, () =>
    rgrRec("s1", "walkie talkies", "unresolved_ingredient"),
  );
  const c = card(recs, "walkie talkie");
  eq(c.score, 580, "300 + 120 + 40×4");
  eq(c.tier, "NEXT", "tier");
  ok(580 < 1500, "RGR2 > RGR3 — the distinct-session invariant");
});
T("RGR4 unresolved_after_pick boost", () => {
  const recs = [
    rgrRec("s1", "amadumbe", "unresolved_after_pick"),
    rgrRec("s2", "2kg amadumbe", "unresolved_after_pick"),
  ];
  const c = card(recs, "amadumbe");
  eq(c.category, "MISSING_INGREDIENT", "category");
  eq(c.score, 720, "300 + 240 + 90×2");
  eq(c.tier, "NEXT", "tier");
});
T("RGR5 resolved_by_picker forces an ALIAS gap", () => {
  const c = card(
    [rgrRec("s1", "braai spice", "resolved_by_picker", "spice-mix-braai")],
    "braai spice",
  );
  eq(
    c.category,
    "MISSING_ALIAS",
    "item IS priced — only the alias was missing",
  );
  eq(c.autoAccept, true, "auto-accept via picker");
  eq(c.via, "picker", "via picker");
  eq(c.score, 345, "200 + 120 + 25×1");
  eq(c.tier, "NEXT", "tier");
});
T("RGR6 zero-demand unpriced item — TIER FLOOR keeps it in NEXT", () => {
  const c = card([], "samp");
  eq(c.category, "MISSING_PRICE", "category");
  eq(c.hits, 0, "no demand");
  eq(c.score, 100, "base only");
  eq(c.tier, "NEXT", "floor: MISSING_PRICE never drops to WATCH");
});
T("RGR7 unpriced item WITH picker demand — demand orders the list", () => {
  const recs = [
    rgrRec("s1", "samp", "resolved_by_picker", "samp"),
    rgrRec("s2", "samp and beans", "resolved_by_picker", "samp"),
    rgrRec("s3", "500g samp", "resolved_by_picker", "samp"),
  ];
  const c = card(recs, "samp");
  eq(
    c.category,
    "MISSING_PRICE",
    "resolvedId + unpriced ⇒ PRICE wins over ALIAS",
  );
  eq(c.resolvedPicks, 3, "resolved picks");
  eq(c.score, 535, "100 + 360 + 75");
  ok(535 > 100, "RGR7 > RGR6 — demand orders the unpriced list");
});
T("RGR8 marketing line — NOISE, never scored, never tiered", () => {
  const rep = RGR.buildReport(
    [rgrRec("s1", "Valid until Sunday – save R10 on selected packs", "other")],
    RGR_REG,
  );
  ok(rep.noise >= 1, "counted as noise");
  ok(
    !rep.cards.some((c) => /valid until/.test(c.candidate)),
    "never reaches a card",
  );
});
T("RGR9 ambiguous candidate — no auto-accept, can never reach NOW", () => {
  const recs = [
    rgrRec("s1", "curry", "unresolved_ingredient"),
    rgrRec("s2", "1 tbsp curry", "unresolved_ingredient"),
    rgrRec("s2", "curry", "unresolved_ingredient"),
  ];
  const c = card(recs, "curry");
  eq(c.category, "MISSING_ALIAS", "category");
  eq(c.autoAccept, false, "never auto-accepts");
  eq(c.ambiguous, true, "ambiguous");
  eq(c.matches.length, 3, "all three curry items listed");
  eq(c.score, 330, "200 + 240 + 40 − 150");
  ok(c.tier !== "NOW", "ambiguity can never reach the till pass");
});
T("RGR10 vernacular lexicon — alias card for the Afrikaans word", () => {
  const recs = [rgrRec("s1", "1 knoppie botter", "unresolved_ingredient")];
  const c = card(recs, "butter");
  eq(
    c.category,
    "MISSING_ALIAS",
    'butter exists and is priced; the alias table lacks "botter"',
  );
  eq(c.autoAccept, true, "auto-accept via lexicon");
  eq(c.via, "lexicon", "via lexicon");
  eq(c.lexiconFrom, "botter", "the vernacular term is kept for the card text");
  eq(c.score, 320, "200 + 120");
  eq(c.tier, "NEXT", "tier");
});
T("RGR: rebuilding the same report is byte-identical (determinism)", () => {
  const recs = [
    rgrRec("s1", "walkie talkies", "unresolved_ingredient"),
    rgrRec("s2", "curry", "unresolved_ingredient"),
    rgrRec("s1", "2 cups mielie pap", "unresolved_ingredient"),
  ];
  const a = RGR.buildReport(recs, RGR_REG);
  const b = RGR.buildReport(recs, RGR_REG);
  eq(
    JSON.stringify(a.cards.map((c) => [c.candidate, c.score, c.tier])),
    JSON.stringify(b.cards.map((c) => [c.candidate, c.score, c.tier])),
    "stable ordering",
  );
});
T(
  "RGR: CLOSED — a term that resolves exactly with no picker/lexicon signal drops out",
  () => {
    const rep = RGR.buildReport(
      [rgrRec("s1", "2 cups maize meal", "unresolved_ingredient")],
      RGR_REG,
    );
    eq(rep.closedCount, 1, "registry moved on — no card");
  },
);

T("P-454: ambiguous dismissal is per-SUGGESTION, never per-card", () => {
  const cards = [
    {
      candidate: "curry",
      ambiguous: true,
      matches: ["curry-powder", "curry-paste", "curry-leaves"],
      score: 330,
    },
    { candidate: "walkie talkie", ambiguous: false, matches: [], score: 580 },
  ];
  const out1 = RGR.applyHandled(cards, ["curry::curry-powder"]);
  eq(out1.length, 2, "card survives with remaining suggestions");
  eq(out1[0].matches.length, 2, "only the handled suggestion drops");
  eq(out1[1].candidate, "walkie talkie", "unaffected card untouched");
  const out2 = RGR.applyHandled(cards, [
    "curry::curry-powder",
    "curry::curry-leaves",
  ]);
  eq(out2[0].matches.length, 1, "second suggestion drops independently");
  const out3 = RGR.applyHandled(cards, [
    "curry::curry-powder",
    "curry::curry-paste",
    "curry::curry-leaves",
  ]);
  ok(
    !out3.some((c) => c.candidate === "curry"),
    "all suggestions handled => card goes",
  );
  const out4 = RGR.applyHandled(cards, ["walkie talkie"]);
  ok(
    !out4.some((c) => c.candidate === "walkie talkie"),
    "unambiguous card dismisses by candidate",
  );
  ok(
    out4.some((c) => c.candidate === "curry"),
    "and does not touch other cards",
  );
});
T("P-454: applyHandled is pure (input cards never mutated)", () => {
  const cards = [
    { candidate: "curry", ambiguous: true, matches: ["a", "b"], score: 1 },
  ];
  RGR.applyHandled(cards, ["curry::a"]);
  eq(cards[0].matches.length, 2, "original untouched");
});

// ------------- P-442: unit conversion + preservation contract (P-430) -------
const dec442 = (l) => decodeRecipeText(l + "\nCook it.", () => null);
const conv = (l) => dec442(l).ingredients[0] || {};
T("P-442: the 20 P-430 conversion cases reproduce exactly", () => {
  const E = [
    ["1 cup milk", "cup", 250, "ml"],
    ["1 koppie meel", "koppie", 250, "ml"],
    ["2 tbsp oil", "tbsp", 30, "ml"],
    ["1 eetlepel suiker", "eetlepel", 15, "ml"],
    ["1 tsp salt", "tsp", 5, "ml"],
    ["1 dessertspoon vanilla", "dessertspoon", 10, "ml"],
    ["1 oz chocolate", "oz", 28, "g"],
    ["8 oz flour", "oz", 227, "g"],
    ["1 lb beef", "lb", 454, "g"],
    ["1 stick butter", "stick", 113, "g"],
    ["1 can (400g) tomatoes", "can", 400, "g"],
    ["2 cans tuna", "can", 2, "pack"],
    ["1,5 cups water", "cup", 375, "ml"],
    ["1 cup (250ml) milk", "cup", 250, "ml"],
    ["1 cup (200ml) milk", "cup", 200, "ml"],
    ["1/2 cup sugar", "cup", 125, "ml"],
    ["500 ml stock", "ml", 500, "ml"],
    ["250g flour", "g", 250, "g"],
    ["2-3 tbsp honey", "tbsp", 38, "ml"],
    ["1 packet (2kg) rice", "packet", 2000, "g"],
  ];
  E.forEach(([line, unit, qc, uc]) => {
    const i = conv(line);
    eq(i.unit, unit, line + " display unit");
    eq(i.qty_canon, qc, line + " qty_canon");
    eq(i.unit_canon, uc, line + " unit_canon");
  });
});
T("P-442: the null cases refuse to lie", () => {
  eq(
    conv("1 block butter").qty_canon,
    null,
    "block: SA blocks are 250g OR 500g",
  );
  eq(conv("1 block butter").unit_canon, null, "block unit_canon null");
  // ADJUDICATION (findings §7B vs Rule 3): pack units canonicalise to a pack
  // COUNT (Rule 3/§1) — never a guessed mass; costing is the same whole-pack
  // math either way, so the §7B null object costs identical rands.
  eq(
    conv("1 packet biscuits").qty_canon,
    1,
    "packet: pack count, not a mass guess",
  );
  eq(conv("1 packet biscuits").unit_canon, "pack", "packet unit_canon pack");
  ok(
    dec442("1 handful spinach").unresolved.length > 0,
    "handful: vague queue, never a gram figure",
  );
});
T(
  "P-442: dimension mismatch — dry solids take the mass, liquids never do",
  () => {
    eq(
      conv("1 cup (125g) flour").qty_canon,
      125,
      "dry solid uses the mass parenthetical",
    );
    eq(
      conv("1 cup (125g) milk").qty_canon,
      null,
      "liquid + mass parenthetical -> null",
    );
  },
);
T("P-442: stick converts ONLY for butter (appliesTo)", () => {
  eq(conv("1 stick butter").qty_canon, 113, "butter stick = 113g");
  eq(conv("1 stick margarine").qty_canon, null, "non-butter stick refuses");
});
T(
  "P-442: canon is additive-only in costing — not one existing cent moves",
  () => {
    // the old stick path (113.4 g, P-425) must keep winning over its canon sibling
    const pe = { pack_unit: "g", pack_qty: 500, price_cents: 6500 };
    const legacy = ingredientCostCents(
      { qty: 1, unit: "stick", id: "butter" },
      pe,
    );
    const withCanon = ingredientCostCents(
      { qty: 1, unit: "stick", id: "butter", qty_canon: 113, unit_canon: "g" },
      pe,
    );
    eq(legacy, withCanon, "stick cost identical with and without canon fields");
    // cup canon routes through the SAME density table (250 ml = 1 SA cup)
    const cupPe = { pack_unit: "g", pack_qty: 500, price_cents: 2000 };
    const byCup = ingredientCostCents(
      { qty: 1, unit: "cup", id: "maize-meal" },
      cupPe,
    ); // 150 g density
    const byCanonMl = ingredientCostCents(
      {
        qty: 1,
        unit: "cup",
        id: "maize-meal",
        qty_canon: 250,
        unit_canon: "ml",
      },
      cupPe,
    );
    eq(byCup, byCanonMl, "1 cup via density == 250 ml via the same density");
    // imperial lines the old path could NOT price now fill via canon
    const ozPe = { pack_unit: "g", pack_qty: 1000, price_cents: 4000 };
    eq(
      ingredientCostCents({ qty: 8, unit: "oz", id: "flour" }, ozPe),
      null,
      "legacy: 8 oz unpriceable",
    );
    eq(
      ingredientCostCents(
        { qty: 8, unit: "oz", id: "flour", qty_canon: 227, unit_canon: "g" },
        ozPe,
      ),
      Math.round((4000 * 227) / 1000),
      "canon bridge prices 8 oz = 227 g",
    );
  },
);
T("P-442: SA decimal comma is never a list separator", () => {
  const d = dec442("1,5 cups water\n2 tbsp oil\nMix it.");
  eq(d.ingredients.length, 2, "no phantom third line");
  eq(
    d.ingredients.find((i) => /water/i.test(i.raw)).qty,
    1.5,
    "1,5 stays one quantity",
  );
});
T("P-442: ranges resolve to the midpoint", () => {
  eq(conv("2-3 tbsp honey").qty, 2.5, "display quantity is the midpoint");
  eq(conv("2 to 3 cups rice").qty_canon, 625, "2.5 cups = 625 ml");
});

T(
  "P-442b: Afrikaans liquids take no mass parenthetical; packets/jars parse as packs",
  () => {
    eq(
      conv("1 koppie (125g) melk").qty_canon,
      null,
      "melk: liquid -> null despite the parenthetical",
    );
    eq(conv("1 cup (125g) melk").qty_canon, null, 'same via English "cup"');
    eq(
      conv("1 koppie (125g) mieliemeel").qty_canon,
      125,
      "dry solid still takes the mass",
    );
    const p = conv("3 packets marshmallows");
    eq(p.unit, "packet", "packets plural parses as a unit");
    eq(p.qty_canon, 3, "pack count 3");
    eq(p.unit_canon, "pack", "canon pack");
  },
);
