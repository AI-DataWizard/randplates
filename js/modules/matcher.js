// matcher.js — PRD §9.1 scoring engine. PURE FUNCTIONS: no DOM, no fetch, no IndexedDB.
// Deterministic and explainable: same inputs → same outputs, always.
//
//   coverage(R)    = Σ(weight_i × has_i) / Σ(weight_i)         // tier-weighted
//   missingCost(R) = Σ(price of missing NON-optional items)
//   eligible(R)    = missingCost ≤ remainingBudget AND no unpriced required missing AND dietary passes AND time ≤ maxTime
//   score(R)       = coverage × 100
//                    − 25 × (missingCost / remainingBudget)   // buy-more penalty
//                    + timeBonus (≤20 min: +5)
//                    + freshnessBonus (+3 per fresh pantry item used, capped +9)

import {
  costRecipe,
  perPlateCents,
  qtyInPackBasis,
  topUpCostCents,
} from "./costing.js";

/**
 * Does the pantry cover this ingredient line?
 * P-104R Day 4: precise path first — convert BOTH sides to a common grams/ml
 * basis through costing.js's conversion authority (piece weights, tin = the
 * priced pack, slice grams). Only when either side can't be converted do we
 * fall back to the loose rough-draft matching. Same conversion source as the
 * costing math, so "covered" and "costed" can never disagree.
 */
export function pantryHas(pantry, line, ingredient, priceOf = null) {
  const entry = pantry.find((p) => p.id === line.id);
  if (!entry) return false;
  return pantryHasEntry(entry, line, ingredient, priceOf);
}

/** P-202: the hot path core — scoreRecipe passes the map-resolved entry so a
 *  rank builds ONE pantry index instead of rescanning the array per line. */
export function pantryHasEntry(entry, line, ingredient, priceOf = null) {
  let packQty = 0;
  if (priceOf) {
    const p = priceOf(line.id);
    if (p && p.pack_qty) packQty = p.pack_qty;
  }
  const lineG = qtyInPackBasis(line.qty, line.unit, "g", {
    id: line.id,
    packQty,
  });
  const pantryG = qtyInPackBasis(entry.qty, entry.unit, "g", {
    id: entry.id,
    packQty,
  });
  if (lineG !== null && pantryG !== null) return pantryG >= lineG - 0.001;
  // fallback: loose unit match (rough draft) for anything the tables don't know
  if (
    line.unit === entry.unit ||
    line.unit === "unit" ||
    line.unit === "can" ||
    line.unit === "bunch" ||
    line.unit === "slice"
  ) {
    return entry.qty >= line.qty;
  }
  const lq = line.unit === "l" ? line.qty * 1000 : line.qty;
  const pq =
    entry.unit === "l"
      ? entry.qty * 1000
      : entry.unit === "kg"
        ? entry.qty * 1000
        : entry.qty;
  return pq >= lq - 0.001;
}

/**
 * AUTO RUNNING-LOW (P-112 → P-113a semantics, owner rule Oct 13): the user
 * never ticks "running low" — the engine derives it from what they have
 * against the size the product is USUALLY BOUGHT AT (unit_basis, the same
 * basis the price math uses). Below one usual pack → running low.
 * Owner's example: 410g baked beans is a full standard pack — a recipe needing
 * two tins must NOT flag it; the recipe-requirement rule from P-112 did, so
 * it was replaced. Coverage still goes through pantryHas's conversion
 * authority, so a 410g entry vs a usual-buy of "1 can" converts correctly.
 * Pure + deterministic: same pantry → same set, always.
 */
/**
 * P-565: the ONE merge of user-saved (decoded) recipes into the matcher pool.
 * Every surface that needs "the recipes the engine ranks" goes through this:
 * boot hydration, decoder save, decoder remove, undo. Before this, boot loaded
 * the corpus and saved_recipes into two separate stores and NEVER merged —
 * so every reload silently dropped decoded recipes from the matcher/planner
 * until the user re-saved them. Saved recipes win id collisions (the saved
 * copy is the user's edited truth); corpus order preserved, users appended.
 */
export function mergeUserRecipes(corpus, saved) {
  // junk rows (null/missing id) never enter the matcher pool — the pool feeds
  // rankRecipes + the planner, so the gate lives here, not at each call site.
  const user = (Array.isArray(saved) ? saved : []).filter((r) => r && r.id);
  const userIds = new Set(user.map((r) => r.id));
  const base = (Array.isArray(corpus) ? corpus : []).filter(
    (r) => r && !userIds.has(r.id),
  );
  return [...base, ...user];
}

export function autoRunningLow(pantry, ingredients, priceOf = null) {
  const byId = new Map(ingredients.map((i) => [i.id, i]));
  const low = new Set();
  for (const entry of pantry) {
    const meta = byId.get(entry.id);
    if (!meta || !meta.unit_basis) continue; // unknown ingredient → nothing to measure against
    const { qty: uq, unit: uu } = meta.unit_basis;
    // OWNER BAND RULE v2 (Oct 24, supersedes the Oct 13 10–25% band):
    // running low = ANY remainder under a quarter of the usual bought-at
    // quantity. The old rule left a silent zone below 10% ("effectively out")
    // — on real data the owner read that silence as a bug: a 5%-left bag of
    // rice showed NO badge at all. Now:
    //   ≥ 25% left   → fine, not low
    //   > 0 < 25%    → RUNNING LOW (buy it on the next shop)
    //   0 / gone     → the row is removed at cook time; no stale flags
    // Same conversion authority as everything else (pantryHas + priceOf packs).
    if (!(entry.qty > 0)) continue; // 0 / negative / NaN qty = out, never low
    const quarter = { id: entry.id, qty: uq * 0.25, unit: uu };
    const coversQuarter = pantryHas([entry], quarter, meta, priceOf);
    if (!coversQuarter) low.add(entry.id);
  }
  return low;
}

/**
 * STAPLE FORGIVENESS (P-104S, owner request Oct 9): tier-0.5 items (salt, oil,
 * spices, stock cubes, condiments) are things nearly every kitchen has — people
 * forget to add them. They must NEVER block a recipe, never count against the
 * missing budget, and never drag the match. They surface as a gentle
 * "you might also want" list instead.
 */
export const STAPLE_TIER_MAX = 0.5;

/** HERO tier: proteins and mains (tier 3 in the v1 registry). Recipes whose
 *  heroes are covered surface even when sides are missing — "I have the
 *  CHICKEN, show me the chicken recipes." */
export const HERO_TIER_MIN = 3;

/**
 * Readiness model (P-104S): a recipe isn't binary eligible/ineligible anymore.
 *   ready   — nothing real missing (staples excepted). Cook tonight.
 *   almost  — missing a couple of things, top-up cost ≤ 15% of budget. One small shop away.
 *   stretch — top-up fits the budget, but it's a real shop.
 *   off     — excluded (over budget / dietary / time / contains excluded ingredient).
 * eligible = ready || almost || stretch (the budget dial still governs the cut-off).
 */
export function readinessOf(missing, missingCostCents, remainingBudgetCents) {
  if (missing.length === 0) return "ready";
  if (
    remainingBudgetCents > 0 &&
    missingCostCents <= remainingBudgetCents * 0.15
  )
    return "almost";
  if (remainingBudgetCents > 0 && missingCostCents <= remainingBudgetCents)
    return "stretch";
  return "off";
}

/** Build the serializable worker payload (P-104S bug fix: functions cannot cross
 *  postMessage — the old payload carried priceOf and threw DataCloneError in
 *  every real browser, silently killing the matcher after one render).
 *  The worker rebuilds priceOf from priceEntries itself. */
export function scorePayload(recipes, ingredients, priceEntries, ctx) {
  return {
    type: "score",
    payload: {
      recipes,
      ingredients,
      priceEntries,
      ctx: {
        pantry: ctx.pantry,
        remainingBudgetCents: ctx.remainingBudgetCents,
        constraints: ctx.constraints || {},
        mealIntent: ctx.mealIntent || null,
        mealStrict: !!ctx.mealStrict,
        recentCookIds: ctx.recentCookIds || [],
        favouriteIds: ctx.favouriteIds || [],
      },
    },
  };
}

/**
 * Merge duplicate ingredient lines (P-113b red-team #16/#17): data glitches or
 * hand-edited recipes can list the same id twice, which double-counts coverage,
 * missing cost, and pack boundaries. Same id + same unit → sum quantities.
 * Same id + different units → convert both to grams when both are convertible;
 * otherwise the lines are kept separate (rare, un-mergeable, no silent guessing).
 */
function mergeDuplicateLines(lines) {
  const out = [];
  const byId = new Map();
  for (const line of lines) {
    const ex = byId.get(line.id);
    if (!ex) {
      const copy = { ...line };
      byId.set(line.id, copy);
      out.push(copy);
      continue;
    }
    if (ex.unit === line.unit) {
      ex.qty = Math.round((ex.qty + line.qty) * 100) / 100;
      continue;
    }
    const exG = qtyInPackBasis(ex.qty, ex.unit, "g", {
      id: line.id,
      packQty: 0,
    });
    const lnG = qtyInPackBasis(line.qty, line.unit, "g", {
      id: line.id,
      packQty: 0,
    });
    if (exG !== null && lnG !== null) {
      ex.qty = Math.round((exG + lnG) * 100) / 100;
      ex.unit = "g";
      continue;
    }
    out.push({ ...line }); // un-mergeable: keep separate rather than guess
  }
  return out;
}

/** Score ONE recipe against pantry + context. Returns a full explainable result. */
export function scoreRecipe(recipe, ctx) {
  const { pantry, ingredients, priceOf, remainingBudgetCents, constraints } =
    ctx;
  // P-202: rankRecipes builds these once per batch; a direct call (tests, decoder)
  // still works by building them here — correctness identical, just slower.
  const byId = ctx.byId || new Map(ingredients.map((i) => [i.id, i]));
  const pantryById = ctx.pantryById || null;
  const ing = mergeDuplicateLines(recipe.ingredients); // P-113b: duplicates count once, qty summed

  // coverage (tier-weighted) + hero tracking
  let weightSum = 0,
    weightHas = 0;
  let heroWeightSum = 0,
    heroWeightHas = 0;
  for (const line of ing) {
    // P-538 (standing rule, owner Oct 2026): optional UNPRICED lines are
    // excluded from the coverage denominator entirely until a price exists —
    // an unpriced "garnish if you like" must never drag the match % down.
    // (Optional PRICED lines still count: they are real ingredients.)
    if (line.optional && !priceOf(line.id)) continue;
    const meta = byId.get(line.id);
    const w = meta ? meta.tier : 0.5;
    weightSum += w;
    if (meta && meta.tier >= HERO_TIER_MIN) heroWeightSum += w;
    const pEntry = pantryById
      ? pantryById.get(line.id)
      : pantry.find((p) => p.id === line.id);
    const has = pEntry ? pantryHasEntry(pEntry, line, meta, priceOf) : false;
    if (has) {
      weightHas += w;
      if (meta && meta.tier >= HERO_TIER_MIN) heroWeightHas += w;
    }
  }
  const coverage = weightSum > 0 ? weightHas / weightSum : 0;
  const heroCovered = heroWeightSum > 0 ? heroWeightHas / heroWeightSum : 1;

  // costing + missing split: real missing vs forgotten staples (tier ≤ 0.5)
  const costing = costRecipe(
    { ...recipe, ingredients: ing },
    priceOf,
    ctx.rowsOf || null,
  ); // same merged lines; P-567d line-aware picker
  const missing = [];
  const staplesMissing = [];
  let missingCostCents = 0;
  let unpriced = 0;
  let unpricedRequired = 0; // P-113b #10: unpriced missing REQUIRED is a hard stop
  for (const { line, priceEntry, costCents } of costing.lines) {
    if (line.optional) continue;
    if (pantryHas(pantry, line, byId.get(line.id), priceOf)) continue;
    const meta = byId.get(line.id);
    // P-113b #13: top-up prices only the GAP between the line and what the
    // pantry already holds (pack-basis). No pantry entry → full line.
    const ownedEntry = pantry.find((x) => x.id === line.id);
    const ownedBasis =
      ownedEntry && priceEntry
        ? qtyInPackBasis(
            ownedEntry.qty,
            ownedEntry.unit,
            priceEntry.pack_unit,
            { id: line.id, packQty: priceEntry.pack_qty },
          )
        : 0;
    const topUp = topUpCostCents(line, priceEntry, ownedBasis);
    const entry = {
      id: line.id,
      name: meta?.name || line.id,
      qty: line.qty,
      unit: line.unit,
      priceCents: topUp,
      unpriced: topUp === null,
    };
    const isStaple = meta && meta.tier <= STAPLE_TIER_MAX;
    if (topUp === null) {
      unpriced++;
      if (!isStaple) unpricedRequired++; // owned-unpriced never reaches here (line is missing)
    }
    // staples never block and never cost against the budget: assumed kitchen basics
    if (isStaple) {
      staplesMissing.push(entry);
      continue;
    }
    if (topUp !== null) missingCostCents += topUp;
    missing.push(entry);
  }

  // P-571: the card chip is an EVALUATION surface — proportional usage cost
  // (owner ruling Oct 27), while missing/top-up above keeps whole-pack truth.
  const plateCents = perPlateCents(costing.totalUsageCents, recipe.servings);

  // freshness bonus: recipe uses pantry items that are running low / short shelf life
  const freshUsed = [];
  for (const line of ing) {
    const p = pantry.find((x) => x.id === line.id);
    if (!p) continue;
    const meta = byId.get(line.id);
    const fresh =
      p.running_low ||
      (meta && meta.shelf_life_days !== undefined && meta.shelf_life_days <= 7);
    if (fresh && !freshUsed.includes(line.id)) freshUsed.push(line.id);
  }
  const freshnessBonus = Math.min(freshUsed.length, 3) * 3; // capped +9
  const timeBonus = recipe.time_minutes <= 20 ? 5 : 0;

  // eligibility + readiness
  const reasons = [];
  let eligible = true;
  // P-113b #2/#3: the budget only gates recipes that need money — a R0-budget
  // user with a fully-stocked pantry can cook for free (missingCost 0 ≤ 0).
  // The single missingCost > remaining check covers every blocking case.
  if (missingCostCents > remainingBudgetCents) {
    eligible = false;
    reasons.push(`Missing items cost more than remaining budget`);
  }
  if (unpricedRequired > 0) {
    eligible = false; // P-113b #10: a null price must never silently count as free
    reasons.push(
      `${unpricedRequired} required item${unpricedRequired === 1 ? "" : "s"} with no price data — can't budget honestly`,
    );
  }
  const c = constraints || {};
  if (c.dietary && !recipe.tags.includes(c.dietary)) {
    eligible = false;
    reasons.push(`Not ${c.dietary}`);
  }
  if (c.excludeIds && c.excludeIds.length) {
    const hit = ing.find((l) => c.excludeIds.includes(l.id));
    if (hit) {
      eligible = false;
      reasons.push(`Contains ${byId.get(hit.id)?.name || hit.id}`);
    }
  }
  if (c.maxTimeMin && recipe.time_minutes > c.maxTimeMin) {
    eligible = false;
    reasons.push(`Takes ${recipe.time_minutes} min (max ${c.maxTimeMin})`);
  }
  if (unpriced > 0)
    reasons.push(`${unpriced} unpriced item(s) — sample price data`);

  const readiness = eligible
    ? readinessOf(missing, missingCostCents, remainingBudgetCents)
    : "off";

  const buyPenalty =
    remainingBudgetCents > 0
      ? 25 * (missingCostCents / remainingBudgetCents)
      : 0;
  // hero anchor: owning the protein/main is the strongest "this is for me" signal
  const heroBonus = heroWeightSum > 0 ? Math.round(10 * heroCovered) : 0;

  // SUBSTANCE (P-104T): a 1-ingredient "recipe" shouldn't beat a real meal just
  // because it can hit 100%. Count only non-staple, non-optional lines you OWN.
  const realLines = ing.filter(
    (l) => !l.optional && (byId.get(l.id)?.tier ?? 0.5) > STAPLE_TIER_MAX,
  );
  const ownedReal = realLines.filter((l) =>
    pantryHas(pantry, l, byId.get(l.id), priceOf),
  ).length;
  const substanceBonus = Math.min(ownedReal, 6) * 2; // 0..12: reward using more of YOUR stuff
  const thinPenalty =
    realLines.length <= 1 ? 18 : realLines.length === 2 ? 6 : 0; // snack-as-dinner guard

  // MEAL INTENT (P-104T): lean toward what suits the time of day. Gentle (±6),
  // never a filter: the user can always see everything. Dessert/snack only get
  // pushed down when the pantry itself says "dinner kitchen" (a protein is owned).
  // TWO STRENGTHS: the clock-derived hint is a gentle nudge (x1), but when the user
  // TAPS a meal chip (ctx.mealStrict) they are stating intent, so it is a strong
  // re-order (x5). Neither is a filter: everything stays visible and eligible.
  const intent = ctx.mealIntent || null; // 'breakfast' | 'lunch' | 'dinner' | null
  const k = ctx.mealStrict ? 5 : 1;
  const tagSet = new Set(recipe.tags || []);
  let intentBonus = 0;
  if (intent && tagSet.has(intent)) intentBonus += 6 * k;
  if (intent === "dinner" || intent === "lunch") {
    if ((tagSet.has("dessert") || tagSet.has("snack")) && !tagSet.has(intent))
      intentBonus -= 6 * k;
  }
  if (
    intent === "breakfast" &&
    tagSet.has("dinner") &&
    !tagSet.has("breakfast")
  )
    intentBonus -= 4 * k;
  if (intent === "dinner" && tagSet.has("breakfast") && !tagSet.has("dinner"))
    intentBonus -= 4 * k;

  // PREFERENCE SIGNALS (P-104T): recipes you've cooked recently drop a little
  // (variety), saved/favourited recipes rise. Pure data in, no hidden state.
  const recentCooks = ctx.recentCookIds || [];
  const cookedRecently = recentCooks.includes(recipe.id);
  const favourite = (ctx.favouriteIds || []).includes(recipe.id);
  const varietyAdj = (cookedRecently ? -8 : 0) + (favourite ? 6 : 0);

  const score =
    coverage * 100 -
    buyPenalty +
    timeBonus +
    freshnessBonus +
    heroBonus +
    substanceBonus -
    thinPenalty +
    intentBonus +
    varietyAdj;

  return {
    recipeId: recipe.id,
    title: recipe.title,
    servings: recipe.servings,
    timeMinutes: recipe.time_minutes,
    tags: recipe.tags,
    steps: recipe.steps,
    ingredients: ing,
    coverage, // 0..1
    matchPct: Math.round(coverage * 100), // the displayed "match %"
    heroCovered, // 0..1 fraction of hero-tier weight covered
    missing, // [{id,name,qty,unit,priceCents,unpriced}] — real missing (blocks budget)
    staplesMissing, // forgotten kitchen basics — never block (P-104S)
    missingCostCents, // honest top-up cost (proportional, staples excluded)
    readiness, // ready | almost | stretch | off (P-104S)
    totalCostCents: costing.totalCents,
    perPlateCents: plateCents,
    freshnessBonus,
    timeBonus,
    heroBonus,
    substanceBonus,
    thinPenalty,
    intentBonus,
    varietyAdj,
    cookedRecently,
    favourite,
    ownedCount: ownedReal,
    realCount: realLines.length, // "you own 5 of 7 key ingredients" (UI headline)
    score: Math.round(score * 100) / 100,
    eligible,
    reasons,
  };
}

/** Rank ALL recipes. Eligible first by score desc; tie-break per-plate asc.
 *  Ineligible recipes are appended (score desc) so the UI can explain why.
 *  The UI groups results by `readiness` (ready > almost > stretch); ranking order
 *  inside a group is this sort. */
export function rankRecipes(recipes, ctx) {
  // P-202 hot-path hoist: one ingredient index + one pantry index per BATCH,
  // not per recipe (179 recipes used to rebuild a 208-entry Map each time).
  const batch = {
    ...ctx,
    byId: ctx.byId || new Map(ctx.ingredients.map((i) => [i.id, i])),
    pantryById: ctx.pantryById || new Map(ctx.pantry.map((p) => [p.id, p])),
  };
  const scored = recipes.map((r) => scoreRecipe(r, batch));
  scored.sort((a, b) => {
    if (a.eligible !== b.eligible) return b.eligible - a.eligible; // eligible first (#25)
    if (b.score !== a.score) return b.score - a.score; // score desc
    if (a.perPlateCents !== b.perPlateCents)
      return a.perPlateCents - b.perPlateCents; // cheaper plate (#5)
    return a.recipeId < b.recipeId ? -1 : 1; // final: id asc — data-order-independent (#6)
  });
  return scored;
}

/**
 * Meal intent from the clock (P-104T). South African eating rhythm:
 * 04:00-10:29 breakfast · 10:30-15:59 lunch · 16:00-03:59 dinner.
 * Pure function of the hour so it is testable; the UI passes `new Date().getHours()`
 * and lets the user override with the meal chips.
 */
export function mealIntentFor(hour, minute = 0) {
  const t = hour * 60 + minute;
  if (t >= 4 * 60 && t < 10 * 60 + 30) return "breakfast";
  if (t >= 10 * 60 + 30 && t < 16 * 60) return "lunch";
  return "dinner";
}

/**
 * UNLOCK INSIGHTS (P-104T) — "buy THIS and unlock N more recipes".
 * For every missing, non-staple ingredient across the near-miss recipes, count how
 * many recipes would become READY-or-ALMOST-with-nothing-else-missing if the user
 * bought just that one item. Sorted by unlock count, then by cheapest top-up.
 * Only counts recipes where that item is the ONLY real gap (single-item unlocks are
 * the honest, actionable ones — "buy eggs" beats "buy 4 things").
 */
export function unlockInsights(results, limit = 5) {
  const tally = new Map();
  for (const r of results) {
    if (!r.eligible || r.missing.length !== 1) continue;
    const gap = r.missing[0];
    const t = tally.get(gap.id) || {
      id: gap.id,
      name: gap.name,
      unlocks: 0,
      costCents: 0,
      recipeIds: [],
      titles: [],
    };
    t.unlocks += 1;
    t.costCents = Math.max(t.costCents, gap.priceCents || 0);
    t.recipeIds.push(r.recipeId);
    if (t.titles.length < 3) t.titles.push(r.title);
    tally.set(gap.id, t);
  }
  return [...tally.values()]
    .sort((a, b) => b.unlocks - a.unlocks || a.costCents - b.costCents)
    .slice(0, limit);
}

/**
 * COOK GATE (P-452, owner rule Oct 21). A recipe may only be cooked when the
 * pantry PHYSICALLY covers every required, non-staple line at the requested
 * plate count. When quantities run short, the engine offers the largest WHOLE
 * serving count the pantry can actually cook — never below 1 (a half serving
 * is not realistic). Missing entirely, even for one plate → max 0, hard block.
 *
 * Same conversion authority as pantryHas/scoreRecipe, so "covered" and
 * "cookable" can never disagree. Physical availability only: prices affect the
 * COST display, never the gate (you can cook a decoded line that is unpriced
 * if it is genuinely in the pantry).
 *
 * Staples (tier ≤ STAPLE_TIER_MAX) and optional lines never gate — the same
 * doctrine that keeps staples from hiding recipes from the matcher.
 *
 * Pure + deterministic: same inputs → same max, always.
 */
export function maxCookableServings(
  recipe,
  plates,
  pantry,
  metaOf,
  priceOf = null,
) {
  const want = Math.max(1, Math.floor(plates || recipe.servings || 1));
  const gating = (recipe.ingredients || []).filter((l) => {
    if (l.optional) return false;
    const m = metaOf(l.id);
    return !(m && m.tier <= STAPLE_TIER_MAX);
  });
  const blockersAt = (p) => {
    const f = p / (recipe.servings || 1);
    const out = [];
    for (const l of gating) {
      const entry = pantry.find((x) => x.id === l.id);
      if (!entry) {
        out.push({ id: l.id, name: metaOf(l.id)?.name || l.id, state: "none" });
        continue;
      }
      if (
        !pantryHasEntry(entry, { ...l, qty: l.qty * f }, metaOf(l.id), priceOf)
      ) {
        out.push({
          id: l.id,
          name: metaOf(l.id)?.name || l.id,
          state: "short",
        });
      }
    }
    return out;
  };
  for (let p = want; p >= 1; p--) {
    if (blockersAt(p).length === 0) return { max: p, want, blockers: [] };
  }
  return { max: 0, want, blockers: blockersAt(1) };
}
