// planner.js — PRD §9.2 greedy week planner. PURE FUNCTIONS: no DOM, no fetch, no IndexedDB.
//
// Objective: maximize meals within the weekly budget while minimizing distinct new
// ingredients (waste proxy).
//   1. Feasible meal candidates come from the matcher (eligible results).
//   2. Sort by (coverage desc, per-plate asc).
//   3. Greedily fill the 7-day grid while listTotal + marginalCost ≤ budget,
//      preferring meals whose missing-set overlaps already-planned purchases
//      (shared shopping → the marginal cost of the next meal drops).
//   4. Emit: plan grid, consolidated priced shopping list (deduped, aisle-sorted),
//      projected total vs budget, savings vs eating-out baseline.
//
// v1 ships greedy; v2 upgrade path: proper set-cover if quality demands it (PRD §9.2).
//
// P-301 (Phase 3 Day 1): dayOptions/applyPick give the UI tap-to-place, single-day
// swap and single-day regeneration. CRITICAL: they reuse planWeek's accumulator
// and consolidation helpers verbatim (ONE ENGINE) — a swapped day is priced by the
// same math that planned the week, so grid, slip and log can never disagree.

import {
  formatRands,
  qtyInPackBasis,
  defaultPrice,
  rescaleRecipe,
  costRecipe,
} from "./costing.js";
import { STAPLE_TIER_MAX } from "./matcher.js";

/** Eating-out baseline per serving (rough draft constant — tune with real data in Phase 4). */
export const TAKEOUT_BASELINE_CENTS = 5500; // R55/plate typical takeout

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MAX_REPEATS = 2; // "cook once, eat twice" welcome; not the same meal 7 nights

/** P-313: DINNER-FIT (owner rebrand, PRD v1 scope) — the planner recommends
 *  DINNERS only. Single source of truth for every planning path (planWeek,
 *  dayOptions, applyPick): a candidate is plan material iff its recipe carries
 *  the 'dinner' tag. Breakfast/lunch/snack/dessert recipes stay discovery food
 *  in the matcher and explorer; they can never enter a plan or its pickers.
 *  Tags live on the matcher result (cand.tags), so the filter is pure data. */
// P-540 ruling (a): desserts NEVER take planner slots — even if a future
// recipe carries BOTH dinner and dessert tags (today's overlap is 0).
export const isDinnerFit = (cand) =>
  Array.isArray(cand.tags) &&
  cand.tags.includes("dinner") &&
  !cand.tags.includes("dessert");

/**
 * Convert a missing item {qty, unit} into the priced pack-basis quantity,
 * scaled for the household serving count. Returns { basis: number|null } —
 * null means the recipe unit can't be honestly converted (e.g. "2 slices" vs a
 * priced loaf); those are priced as 1 pack per occurrence.
 */
function missingToBasis(m, scale, priceEntry) {
  const qty = m.qty * scale;
  if (!priceEntry) return { basis: null };
  const basis = qtyInPackBasis(qty, m.unit, priceEntry.pack_unit);
  return { basis: basis === null ? null : basis };
}

// ---------------- shared accumulator helpers (ONE ENGINE, P-301) ----------------

/** Total list cost in cents given an accumulator's contents. */
function accTotal(acc) {
  let t = 0;
  for (const item of acc.values()) {
    const p = item.priceEntry;
    if (!p) continue;
    const pq = p.pack_qty > 0 ? p.pack_qty : 1; // P-308: corrupt rows degrade, never divide by 0
    const packs = item.basis === null ? item.packs : Math.ceil(item.basis / pq);
    t += Math.round(packs * p.price_cents);
  }
  return t;
}

/** Consolidate accumulator → deduped, aisle-sorted, priced shopping list. */
function consolidate(acc, metaById) {
  const shoppingList = [];
  for (const [id, item] of acc) {
    const p = item.priceEntry;
    const meta = metaById.get(id);
    const packs =
      item.basis === null
        ? item.packs
        : Math.max(1, Math.ceil(item.basis / p.pack_qty));
    shoppingList.push({
      id,
      name: meta?.name || id,
      aisle: meta?.aisle || "other",
      packs,
      priceCents: packs * p.price_cents,
      unitPriceCents: p.price_cents,
      pack_qty: p.pack_qty,
      pack_unit: p.pack_unit,
      last_verified: p.last_verified,
      store: p.store,
      source: tierOf(p.source), // P-540/P-519: tier split on the slip (normalized)
    });
  }
  shoppingList.sort(
    (a, b) => a.aisle.localeCompare(b.aisle) || a.name.localeCompare(b.name),
  );
  return shoppingList;
}

/** Derive the finished plan artifact (grid + list + totals + status + warnings). */
// ---------------- P-306: the cook sheet — honest pantry accounting ----------------
// THE HOLE THIS FIXES: the old accumulator trusted each candidate's per-recipe
// `missing` snapshot, computed against the ORIGINAL pantry. Two meals sharing
// 500g of owned onions each saw themselves covered — the same stock twice —
// and a partially-covered line bought its full quantity instead of the gap.
// The sheet consumes pantry stock LINE BY LINE as meals commit: every gram is
// spent exactly once, the shop list buys only true gaps, and a meal placed
// after the stock is gone honestly pays full price.
// STAPLES stay assumed-home (PRD): tier ≤ STAPLE_TIER_MAX lines are never
// bought and never consume tracked stock.

/** Build a fresh sheet from the user's pantry snapshot (pack-basis where priced). */
export function makeSheet(pantry, priceOf) {
  const left = new Map();
  const loose = new Map();
  const priced = new Map();
  for (const p of pantry || []) {
    // P-308: garbage pantry rows (missing/NaN/negative qty) are skipped, not trusted
    if (
      !p ||
      typeof p.qty !== "number" ||
      !Number.isFinite(p.qty) ||
      p.qty <= 0
    )
      continue;
    let basis = null;
    const pe = priceOf(p.id);
    if (pe)
      basis = qtyInPackBasis(p.qty, p.unit, pe.pack_unit, {
        id: p.id,
        packQty: pe.pack_qty,
      });
    if (basis === null)
      basis = qtyInPackBasis(p.qty, p.unit, "g", { id: p.id });
    if (Number.isFinite(basis) && basis > 0) {
      left.set(p.id, (left.get(p.id) || 0) + basis);
      if (pe) priced.set(p.id, pe);
      continue;
    }
    // unconvertible pantry entry: old semantics covered loose lines by presence —
    // now it is consumed ONCE instead of covering unlimited meals
    loose.set(p.id, (loose.get(p.id) || 0) + 1);
  }
  return {
    buy: new Map(),
    left,
    start: new Map(left),
    loose,
    looseStart: new Map(loose),
    priced,
  };
}

/** Commit one meal's lines against the sheet (buying true gaps, consuming stock). */
function commitMealToSheet(sheet, cand, servings, priceOf, metaById) {
  const scale = servings / (cand.servings > 0 ? cand.servings : 1);
  for (const line of cand.ingredients || []) {
    if (line.optional) continue;
    const meta = metaById.get(line.id);
    if (meta && meta.tier <= STAPLE_TIER_MAX) continue; // assumed-home staples: never bought, never consumed
    const pe = priceOf(line.id);
    if (!pe) continue; // unpriced required lines never reach here (eligibility gates)
    const { basis } = missingToBasis(
      { qty: line.qty, unit: line.unit },
      scale,
      pe,
    );
    if (basis === null) {
      // loose unit line: consume one loose pantry entry if any, else count-buy
      const looseLeft = sheet.loose.get(line.id) ?? 0;
      if (looseLeft > 0) {
        sheet.loose.set(line.id, looseLeft - 1);
        continue;
      }
      const ex = sheet.buy.get(line.id);
      if (ex) ex.packs += 1;
      else sheet.buy.set(line.id, { basis: null, packs: 1, priceEntry: pe });
      continue;
    }
    const have = sheet.left.get(line.id) ?? 0;
    const use = Math.min(have, basis);
    if (use > 0) sheet.left.set(line.id, have - use);
    const gap = basis - use;
    if (gap <= 0.0001) continue; // fully covered by REMAINING stock
    const ex = sheet.buy.get(line.id);
    if (ex && ex.basis !== null) ex.basis += gap;
    else if (ex) {
      ex.basis = gap;
    } // mixed null+basis: the basis wins (old rule)
    else sheet.buy.set(line.id, { basis: gap, packs: 1, priceEntry: pe });
  }
}

/** Snapshot a sheet so probes never mutate the real one. */
function sheetSnap(sheet) {
  const buy = new Map();
  for (const [k, v] of sheet.buy) buy.set(k, { ...v });
  return {
    buy,
    left: new Map(sheet.left),
    loose: new Map(sheet.loose),
    start: sheet.start,
    looseStart: sheet.looseStart,
    priced: sheet.priced,
  };
}

const sheetTotal = (sheet) => accTotal(sheet.buy);

/** Marginal shop cost of placing cand on top of the sheet. */
function marginalOnSheet(sheet, cand, servings, priceOf, metaById) {
  const probe = sheetSnap(sheet);
  commitMealToSheet(probe, cand, servings, priceOf, metaById);
  return sheetTotal(probe) - sheetTotal(sheet);
}

/** P-306: pantry consumption list for the slip/PDF — what the plan EATS from
 *  your kitchen, with proportional value (same pricing authority as missingCost). */
export function pantryUseFrom(sheet, metaById) {
  const out = [];
  for (const [id, startQty] of sheet.start) {
    const remaining = sheet.left.get(id) ?? 0;
    const used = startQty - remaining;
    if (used <= 0.0001) continue;
    const pe = sheet.priced.get(id) || null; // price authority recorded when the stock was basified
    const meta = metaById.get(id);
    out.push({
      id,
      name: meta?.name || id,
      aisle: meta?.aisle || "other",
      qty: Math.round(used * 100) / 100,
      unit: pe ? pe.pack_unit : meta?.unit_basis?.unit || "unit",
      valueCents: pe ? Math.round((used / pe.pack_qty) * pe.price_cents) : null,
    });
  }
  for (const [id, startCount] of sheet.looseStart) {
    const used = startCount - (sheet.loose.get(id) ?? 0);
    if (used <= 0) continue;
    const meta = metaById.get(id);
    out.push({
      id,
      name: meta?.name || id,
      aisle: meta?.aisle || "other",
      qty: used,
      unit: "unit",
      valueCents: null,
    });
  }
  return out.sort(
    (a, b) => a.aisle.localeCompare(b.aisle) || a.name.localeCompare(b.name),
  );
}

/**
 * P-305: pack-exact plate costing for a PLANNED meal at the household plate count.
 * Uses the identical rescaleRecipe → costRecipe path the cook log uses (P-207 #11
 * parity), so a planned meal, its card, and its cook-log entry can never disagree.
 * Falls back to null when the candidate carries no lines (defensive).
 */
export function mealCostAt(cand, plates, priceOf) {
  if (
    !cand ||
    !Array.isArray(cand.ingredients) ||
    cand.ingredients.length === 0 ||
    !(plates > 0)
  )
    return null;
  const scaled = rescaleRecipe(
    {
      servings: cand.servings > 0 ? cand.servings : 1,
      ingredients: cand.ingredients,
    },
    plates,
  );
  const costing = costRecipe(scaled, priceOf);
  return {
    mealCents: costing.totalCents,
    perPlateCents: Math.round(costing.totalCents / plates),
    lines: costing.lines, // P-306: per-ingredient scaled qty + cost — the PDF's deep dive
  };
}

/** P-305: THE PLANNER PLANS DINNERS. realCount (matcher, tier-based) separates
 *  real meals from staple-only snacks/desserts (everything they need is
 *  assumed-home staples). A real dinner wins the day whenever one fits the
 *  remaining budget; staple-only recipes are the free fallback that fills
 *  leftover days instead of leaving holes or a week of desserts. */
const isRealMeal = (cand) => (cand.realCount || 0) > 0;

function finishPlan(
  grid,
  sheet,
  weekBudgetCents,
  dayCount,
  servings,
  metaById,
  dinnerPoolCount = 1,
  opts = {},
) {
  const shoppingList = consolidate(sheet.buy, metaById);
  const pantryUse = pantryUseFrom(sheet, metaById);
  const totalCents = shoppingList.reduce((t, i) => t + i.priceCents, 0);

  // ── P-540 (c): waste honesty — pack-rounding surplus of short-shelf items.
  // Buying 400g spinach for 300g leaves 100g that spoils in 3 days; the slip
  // must SAY so instead of quietly charging for garbage.
  const shelfById = new Map(
    (opts.ingredients || [])
      .map((i) => [i.id, i.shelf_life_days])
      .filter(([, v]) => Number.isFinite(v)),
  );
  const packLeftovers = [];
  for (const [id, item] of sheet.buy) {
    if (item.basis === null || !item.priceEntry) continue;
    const shelf = shelfById.get(id);
    if (!shelf || shelf > 7) continue; // only short-shelf items can rot
    const pq = item.priceEntry.pack_qty > 0 ? item.priceEntry.pack_qty : 1;
    const surplus = Math.max(1, Math.ceil(item.basis / pq)) * pq - item.basis;
    if (surplus <= 0.0001) continue;
    const meta = metaById.get(id);
    packLeftovers.push({
      id,
      name: meta?.name || id,
      qty: Math.round(surplus * 100) / 100,
      unit: item.priceEntry.pack_unit,
      valueCents: Math.round((surplus / pq) * item.priceEntry.price_cents),
      shelfDays: shelf,
    });
  }
  packLeftovers.sort(
    (a, b) => a.shelfDays - b.shelfDays || a.name.localeCompare(b.name),
  );

  // ── P-540 (d): the P-519 tier split — the slip states price honesty plainly.
  const priceTiers = shoppingList.reduce(
    (t, i) => {
      if (tierOf(i.source) === "verified") {
        t.verified += i.priceCents;
        t.verifiedCount++;
      } else {
        t.estimated += i.priceCents;
        t.estimatedCount++;
      }
      return t;
    },
    { verified: 0, estimated: 0, verifiedCount: 0, estimatedCount: 0 },
  );
  // P-113b #21/#23/#24: STRICT bands — green < 90%, amber 90%..99.99% (< 100%),
  // red ≥ 100%. The old `<=` boundaries painted exactly-90% green and
  // exactly-100% amber; display rounding must never flip a band either.
  const status =
    totalCents < weekBudgetCents * 0.9
      ? "under"
      : totalCents < weekBudgetCents
        ? "near"
        : "over";

  const mealsPlanned = grid.filter(Boolean).length;
  const baselineCents = mealsPlanned * servings * TAKEOUT_BASELINE_CENTS;
  // P-305: the plan's plate VALUE vs its SHOP cost — the story that explains
  // an R0.00 week: "everything on this plan is already in your kitchen".
  const mealValueCents = grid.reduce(
    (t, m) => t + (m && m.mealCents ? m.mealCents : 0),
    0,
  );
  const pantryCookedCents = Math.max(0, mealValueCents - totalCents);

  // P-113b #19: a partial week is a RESOLVED outcome, not a silent hole —
  // MAX_REPEATS and pantry variety cap the grid; the user must be told why.
  const warnings = [];
  if (mealsPlanned < dayCount && !dinnerPoolCount) {
    // P-313: the honest empty-pool case — a kitchen that can't cook a single
    // DINNER (only snacks/breakfast/lunch reachable) must say exactly that.
    warnings.push(
      "No dinner recipes match your kitchen yet — add a dinner hero (a protein or a starch) and plan again.",
    );
  } else if (mealsPlanned < dayCount) {
    // P-308: budget-limited weeks must SAY so — the repeat-cap excuse reads as a
    // lie when the dial is the reason. Budget-limited = the shop list ate ≥95%
    // of the budget before the days ran out.
    if (totalCents >= weekBudgetCents * 0.95) {
      warnings.push(
        `${formatRands(weekBudgetCents)} only bought ${mealsPlanned} of ${dayCount} dinners — bump the budget or stock the pantry to cover more days.`,
      );
    } else {
      warnings.push(
        `Only ${mealsPlanned} of ${dayCount} days filled — repeat cap and pantry variety limit the week; add a few ingredients to unlock more meals.`,
      );
    }
  }

  return {
    days: DAYS.slice(0, dayCount).map((name, i) => ({
      day: name,
      meal: grid[i],
    })),
    shoppingList,
    pantryUse, // P-306: what the plan consumes from your kitchen (qty + value)
    totalCents,
    weekBudgetCents,
    status, // 'under' (green, <90%) | 'near' (amber, 90%..<100%) | 'over' (red, ≥100%) — PRD §7.5, P-113b bands
    mealsPlanned,
    mealValueCents, // P-305: Σ plate value of planned meals
    pantryCookedCents, // P-305: plate value already owned (shop total is 0 for it)
    warnings,
    savingsCents: baselineCents - totalCents,
    packLeftovers, // P-540 (c): short-shelf pack surplus the plan leaves behind
    priceTiers, // P-540 (d): verified vs estimated price split for the slip
  };
}

/**
 * Plan a week.
 * @param candidates matcher results (eligible ones are used, ineligible skipped)
 * @param opts { weekBudgetCents, servings, days, ingredients, priceEntries, pantry }
 *        pantry — the live pantry snapshot; stock is CONSUMED as meals commit (P-306)
 *        servings = household plates per meal (recipes are rescaled to this)
 */
export function planWeek(candidates, opts) {
  // P-308 red-team: the budget is the user's number, NEVER silently inflated —
  // the old UI floored "R50" up to R100 and the dial lied while totals ran hot.
  const weekBudgetCents = Math.max(
    0,
    Number.isFinite(opts.weekBudgetCents) ? opts.weekBudgetCents : 0,
  );
  const dayCount = opts.days || 7;
  const servings = opts.servings > 0 ? opts.servings : 2;
  const metaById = new Map((opts.ingredients || []).map((i) => [i.id, i]));
  const priceOf = (id) => defaultPrice(id, opts.priceEntries || []);

  // sort: coverage desc, per-plate asc (PRD §9.2 step 2)
  // P-313: dinner-fit is a HARD filter — non-dinner recipes never enter the pool.
  const pool = candidates
    .filter((c) => c.eligible && isDinnerFit(c))
    .sort(
      (a, b) => b.coverage - a.coverage || a.perPlateCents - b.perPlateCents,
    );

  // ── P-540 SEQUENCE-AWARE WEEK (owner: "absolutely refined") ──────────────────
  // A week is not 7 independent picks. Three new rules, all soft-deterministic:
  //  (a) PERISHABLE SEQUENCING: an item bought on day d0 with shelf life S should
  //      be eaten by days that use it while it's still fresh — the greedy gets a
  //      relief on candidates that share perishables already bought (up to 25%
  //      of the pack's value, scaled by the freshness fraction left).
  //  (b) COOK-LOG RECENCY: recipes cooked in the last 5 days sit out (variety),
  //      UNLESS the log shows deliberate repetition (>=3 lifetime cooks) — and
  //      only when the fresh pool can still fill the day (holes beat repeats).
  //  (c) WASTE HONESTY: pack-rounding surplus of short-shelf items is reported,
  //      not silently forgotten (the slip's USE-SOON block).
  const shelfById = new Map(
    (opts.ingredients || [])
      .map((i) => [i.id, i.shelf_life_days])
      .filter(([, v]) => Number.isFinite(v)),
  );
  const boughtOn = new Map(); // perishable id -> day it was first bought this week
  const PERISH_WINDOW_DAYS = 7; // <= 7-day shelf = week-perishable (registry: 77 items)
  const RELIEF_FRACTION = 0.25; // gentle, documented: a R20 pack eaten fresh relieves R5
  const recent = new Set(opts.recentCookIds || []);
  const lovers = new Set(opts.repeatLovers || []);

  /** P-540 (a): relief for eating perishables already bought — the freshness
   *  fraction scales it: day-1 spinach pack is worth more to relieve on day 2
   *  (6/7 fresh) than on day 6 (2/7). */
  const reliefOf = (cand, day) => {
    let relief = 0;
    for (const line of cand.ingredients || []) {
      if (line.optional) continue;
      const boughtDay = boughtOn.get(line.id);
      if (boughtDay === undefined) continue;
      const shelf = shelfById.get(line.id);
      if (!shelf || shelf > PERISH_WINDOW_DAYS) continue;
      const pe = priceOf(line.id);
      if (!pe) continue;
      relief +=
        Math.max(0, (shelf - (day - boughtDay)) / shelf) * pe.price_cents;
    }
    return relief;
  };

  // P-306: the cook sheet — pantry stock is consumed once as meals commit; the
  // shop list buys only true gaps (see makeSheet)
  const sheet = makeSheet(opts.pantry || [], priceOf);
  const used = new Map();
  const grid = [];

  for (let d = 0; d < dayCount; d++) {
    let best = null;
    // P-540 (b): fresh pass first; only if NO fresh candidate fills the day do
    // recently-cooked ones get a look — variety is a preference, holes are worse.
    for (const pass of [0, 1]) {
      for (const cand of pool) {
        if ((used.get(cand.recipeId) || 0) >= MAX_REPEATS) continue;
        if (
          pass === 0 &&
          recent.has(cand.recipeId) &&
          !lovers.has(cand.recipeId)
        )
          continue;
        const cost = marginalOnSheet(sheet, cand, servings, priceOf, metaById);
        if (sheetTotal(sheet) + cost > weekBudgetCents) continue;
        // P-540 (a): the perishable relief discounts the comparison cost —
        // a costlier meal that finishes an expiring pack can win the day.
        const relief = reliefOf(cand, d);
        const effCost = Math.max(0, cost - RELIEF_FRACTION * relief);
        // P-305 preference order: real dinners beat free snacks (see isRealMeal);
        // then effective cost, then bigger perishable saver, then coverage —
        // the "cook once, eat twice" effect still emerges because a repeat's marginal
        // cost collapses toward its pantry-covered share
        const real = isRealMeal(cand);
        if (
          !best ||
          (real && !isRealMeal(best.cand)) ||
          (real === isRealMeal(best.cand) &&
            (effCost < best.effCost ||
              (effCost === best.effCost &&
                (relief > best.relief ||
                  (relief === best.relief &&
                    cand.coverage > best.cand.coverage)))))
        ) {
          best = { cand, cost, effCost, relief };
        }
      }
      if (best) break; // fresh candidates filled the day — recent ones stay benched
    }
    if (!best) {
      grid.push(null);
      continue;
    }
    // commit
    const cand = best.cand;
    commitMealToSheet(sheet, cand, servings, priceOf, metaById);
    used.set(cand.recipeId, (used.get(cand.recipeId) || 0) + 1);
    // P-540 (a): stamp the day this week's perishables entered the sheet
    for (const [id, item] of sheet.buy) {
      if (item.basis === null) continue;
      const shelf = shelfById.get(id);
      if (shelf && shelf <= PERISH_WINDOW_DAYS && !boughtOn.has(id))
        boughtOn.set(id, d);
    }
    // P-305: pack-exact plate costing at the household plate count (cook-log parity)
    const mc = mealCostAt(cand, servings, priceOf) || {
      mealCents: cand.perPlateCents * servings,
      perPlateCents: cand.perPlateCents,
    };
    grid.push({
      recipeId: cand.recipeId,
      title: cand.title,
      plates: servings,
      perPlateCents: mc.perPlateCents,
      mealCents: mc.mealCents,
      marginalCents: best.cost,
      coverage: cand.coverage,
      matchPct: cand.matchPct,
      real: isRealMeal(cand),
    });
  }

  const upgraded = upgradePass(
    grid,
    pool,
    weekBudgetCents,
    servings,
    priceOf,
    metaById,
    opts.pantry || [],
  );

  // P-313: dinnerPoolCount drives the honest empty-pool warning below.
  return finishPlan(
    upgraded.grid,
    upgraded.sheet,
    weekBudgetCents,
    dayCount,
    servings,
    metaById,
    pool.length,
    opts,
  );
}

/** P-307: BUDGET UTILIZATION - a fuller week, not the cheapest one.
 *  The greedy is a floor-finder: cheapest marginal first, so a R600 week can
 *  legitimately end at R90 of snacks. The remaining budget should buy
 *  SUBSTANCE. This pass repeatedly swaps planned days for higher-quality
 *  candidates while budget headroom covers the cost delta. Quality =
 *  realCount (real, non-staple ingredients - pantry-independent substance),
 *  coverage as tie-break; a candidate that is not strictly better never
 *  displaces a planned meal. Deterministic: best gain, cheapest delta, day.
 */
function upgradePass(
  grid,
  pool,
  weekBudgetCents,
  servings,
  priceOf,
  metaById,
  pantry,
) {
  const byId = new Map(pool.map((c) => [c.recipeId, c]));
  const replay = (g) => {
    const s = makeSheet(pantry, priceOf);
    for (const m of g) {
      if (!m) continue;
      const cand = byId.get(m.recipeId);
      if (cand) commitMealToSheet(s, cand, servings, priceOf, metaById);
    }
    return s;
  };
  const cur = { grid: [...grid], sheet: replay(grid) };
  for (let guard = 0; guard < 40; guard++) {
    const total = sheetTotal(cur.sheet);
    let best = null;
    for (let d = 0; d < cur.grid.length; d++) {
      const meal = cur.grid[d];
      if (!meal) continue;
      const oldCand = byId.get(meal.recipeId);
      if (!oldCand) continue;
      const usedNow = new Map();
      for (let i = 0; i < cur.grid.length; i++) {
        if (i === d || !cur.grid[i]) continue;
        usedNow.set(
          cur.grid[i].recipeId,
          (usedNow.get(cur.grid[i].recipeId) || 0) + 1,
        );
      }
      const without = replay(cur.grid.filter((_, i) => i !== d));
      for (const cand of pool) {
        if ((usedNow.get(cand.recipeId) || 0) >= MAX_REPEATS) continue;
        if (cand.recipeId === meal.recipeId) continue;
        const gain =
          (cand.realCount || 0) * 1000 +
          cand.coverage -
          ((oldCand.realCount || 0) * 1000 + oldCand.coverage);
        if (gain <= 0) continue;
        const delta =
          sheetTotal(without) +
          marginalOnSheet(without, cand, servings, priceOf, metaById) -
          total;
        if (total + delta > weekBudgetCents) continue;
        if (
          !best ||
          gain > best.gain ||
          (gain === best.gain && delta < best.delta) ||
          (gain === best.gain && delta === best.delta && d < best.day)
        ) {
          best = { day: d, cand, gain, delta, without };
        }
      }
    }
    if (!best) break;
    const mc = mealCostAt(best.cand, servings, priceOf) || {
      mealCents: best.cand.perPlateCents * servings,
      perPlateCents: best.cand.perPlateCents,
    };
    cur.grid[best.day] = {
      recipeId: best.cand.recipeId,
      title: best.cand.title,
      plates: servings,
      perPlateCents: mc.perPlateCents,
      mealCents: mc.mealCents,
      marginalCents: marginalOnSheet(
        best.without,
        best.cand,
        servings,
        priceOf,
        metaById,
      ),
      coverage: best.cand.coverage,
      matchPct: best.cand.matchPct,
      real: isRealMeal(best.cand),
    };
    cur.sheet = replay(cur.grid);
  }
  return cur;
}

// ---------------- P-301: day picker + single-day swap (pure) ----------------

/** Shared setup for the day-picker path: derived context from opts. */
function pickCtx(plan, candidates, dayIndex, opts) {
  const servings = opts.servings > 0 ? opts.servings : 2;
  const priceOf = (id) => defaultPrice(id, opts.priceEntries || []);
  const metaById = new Map((opts.ingredients || []).map((i) => [i.id, i]));

  /**
   * Rebuild the accumulator and repeat-usage counts as if `dayIndex` were empty.
   * Returns { acc, used } or { error: 'unknown-recipe', recipeId } when a placed
   * meal is no longer in the candidate set (recipe deleted / matcher context
   * changed) — the UI must prompt a full re-plan rather than silently dropping
   * that meal's purchases from the list.
   */
  const rebuildWithoutDay = () => {
    const byId = new Map(candidates.map((c) => [c.recipeId, c]));
    // P-306: replay placed meals through the SAME sheet math the greedy uses —
    // pantry stock consumption included, so day-swap costs stay honest
    const sheet = makeSheet(opts.pantry || [], priceOf);
    const used = new Map();
    for (let i = 0; i < plan.days.length; i++) {
      if (i === dayIndex) continue;
      const meal = plan.days[i].meal;
      if (!meal) continue;
      const cand = byId.get(meal.recipeId);
      if (!cand) return { error: "unknown-recipe", recipeId: meal.recipeId };
      commitMealToSheet(sheet, cand, servings, priceOf, metaById);
      used.set(meal.recipeId, (used.get(meal.recipeId) || 0) + 1);
    }
    return { sheet, used };
  };

  return { servings, priceOf, metaById, rebuildWithoutDay };
}

/**
 * Rank every feasible meal for a given day, with its honest marginal cost
 * ("+R18.99 to the shop") computed against the rest of the week as planned.
 * A candidate already placed twice on OTHER days is not offered (repeat cap);
 * the meal currently on this day does NOT count toward its own cap (a swap
 * with itself must be possible). Over-budget picks are returned but flagged,
 * never silently hidden — the user sees the cost of their want.
 *
 * @param opts same shape as planWeek's opts (weekBudgetCents, servings, ingredients, priceEntries)
 */
export function dayOptions(plan, candidates, opts, dayIndex) {
  const { servings, priceOf, metaById, rebuildWithoutDay } = pickCtx(
    plan,
    candidates,
    dayIndex,
    opts,
  );
  const rebuilt = rebuildWithoutDay();
  if (rebuilt.error) return rebuilt;
  const { sheet, used } = rebuilt;
  const base = sheetTotal(sheet);
  const budget = opts.weekBudgetCents;

  const options = candidates
    .filter((c) => c.eligible && isDinnerFit(c)) // P-313: pickers are dinner-only
    .filter((c) => (used.get(c.recipeId) || 0) < MAX_REPEATS)
    .map((cand) => {
      const cost = marginalOnSheet(sheet, cand, servings, priceOf, metaById);
      // P-305: show the meal's plate value, pack-exact at the planned plates —
      // exactly what applyPick will charge (engine/UI parity by construction)
      const mc = mealCostAt(cand, servings, priceOf) || {
        mealCents: cand.perPlateCents * servings,
        perPlateCents: cand.perPlateCents,
      };
      return {
        recipeId: cand.recipeId,
        title: cand.title,
        plates: servings,
        perPlateCents: mc.perPlateCents,
        mealCents: mc.mealCents,
        coverage: cand.coverage,
        matchPct: cand.matchPct,
        marginalCents: cost,
        overBudget: base + cost > budget,
        overByCents: Math.max(0, base + cost - budget),
      };
    })
    // rank: cheapest addition first (same preference as the greedy week loop),
    // deterministic tie-breaks for stable keyboard/UI order (P-208 discipline)
    .sort(
      (a, b) =>
        a.marginalCents - b.marginalCents ||
        b.coverage - a.coverage ||
        a.perPlateCents - b.perPlateCents ||
        String(a.recipeId).localeCompare(String(b.recipeId)),
    );
  return { options };
}

/**
 * Place (swap) or clear a single day, then regenerate ONLY that day's effect
 * on the consolidated list — other days' meals are never reconsidered.
 *
 * @param choice a recipeId ('pick') or the literal string 'clear'
 * @returns { ok: true, plan } or { ok: false, reason, overByCents?, recipeId? }
 *          reasons: 'unknown-recipe' | 'not-eligible' | 'repeat-cap' | 'over-budget'
 */
export function applyPick(plan, candidates, opts, dayIndex, choice) {
  const { servings, priceOf, metaById, rebuildWithoutDay } = pickCtx(
    plan,
    candidates,
    dayIndex,
    opts,
  );
  const rebuilt = rebuildWithoutDay();
  if (rebuilt.error)
    return { ok: false, reason: "unknown-recipe", recipeId: rebuilt.recipeId };
  const { sheet, used } = rebuilt;

  let meal = null;
  if (choice !== "clear") {
    const cand = candidates.find((c) => c.recipeId === choice);
    if (!cand) return { ok: false, reason: "unknown-recipe", recipeId: choice };
    if (!cand.eligible)
      return { ok: false, reason: "not-eligible", recipeId: choice };
    if (!isDinnerFit(cand))
      return { ok: false, reason: "not-dinner", recipeId: choice }; // P-313
    if ((used.get(cand.recipeId) || 0) >= MAX_REPEATS)
      return { ok: false, reason: "repeat-cap", recipeId: choice };
    // marginal BEFORE commit — the exact same probe math the greedy loop uses
    const marginalCents = marginalOnSheet(
      sheet,
      cand,
      servings,
      priceOf,
      metaById,
    );
    if (sheetTotal(sheet) + marginalCents > opts.weekBudgetCents) {
      return {
        ok: false,
        reason: "over-budget",
        overByCents: sheetTotal(sheet) + marginalCents - opts.weekBudgetCents,
      };
    }
    commitMealToSheet(sheet, cand, servings, priceOf, metaById);
    const mc = mealCostAt(cand, servings, priceOf) || {
      mealCents: cand.perPlateCents * servings,
      perPlateCents: cand.perPlateCents,
    };
    meal = {
      recipeId: cand.recipeId,
      title: cand.title,
      plates: servings,
      perPlateCents: mc.perPlateCents,
      mealCents: mc.mealCents,
      marginalCents,
      coverage: cand.coverage,
      matchPct: cand.matchPct,
      real: isRealMeal(cand),
    };
  }

  const grid = plan.days.map((d, i) => (i === dayIndex ? meal : d.meal));
  // P-313: honest dinner-pool count for the rebuild path too
  const dinnerPool = candidates.filter(
    (c) => c.eligible && isDinnerFit(c),
  ).length;
  return {
    ok: true,
    plan: finishPlan(
      grid,
      sheet,
      opts.weekBudgetCents,
      plan.days.length,
      servings,
      metaById,
      dinnerPool,
    ),
  };
}

/**
 * WhatsApp-shareable plain-text shopping list (PRD §7.5, P-302 contract).
 * Format rules (P-302 #2 — verified against WhatsApp rendering):
 *   - Section headers and totals are asterisk-wrapped (WhatsApp bold); a header
 *     carries its aisle subtotal so the slip sums survive pasting.
 *   - Every line stays under ~48 chars so low-end Android never soft-wraps a
 *     price off its item line (tests enforce the cap).
 *   - No monospace assumptions, no indent-dependent layout, no trailing spaces.
 */
// P-540: qty display helper (main.js has one; modules stay self-contained)
const trimPlanQty = (n) =>
  Number.isFinite(n)
    ? String(Math.round(n * 100) / 100).replace(/\.0+$/, "")
    : String(n);

/** P-540/P-519: the honesty normalizer. Real registry rows carry
 *  'verified' | 'estimated' | 'estimate' | 'reference' — only verified
 *  (in-store / directly confirmed shelf) rows count as verified; the rest
 *  are honestly ≈ (carry the estimate marker on the slip). */
export const tierOf = (source) =>
  source === "verified" ? "verified" : "estimated";

export function shoppingListToText(plan) {
  // aisle subtotals pre-pass (shoppingList is already aisle/name sorted)
  const subtotalByAisle = new Map();
  for (const item of plan.shoppingList) {
    subtotalByAisle.set(
      item.aisle,
      (subtotalByAisle.get(item.aisle) || 0) + item.priceCents,
    );
  }
  const lines = [
    `*RANDPLATES WEEK PLAN*`,
    `${plan.mealsPlanned} meal${plan.mealsPlanned === 1 ? "" : "s"} · ${formatRands(plan.totalCents)} of ${formatRands(plan.weekBudgetCents)} budget`,
    "",
    `*THE WEEK*`,
  ];
  // P-305: the meals themselves — day, dish, plate value. Titles truncate so
  // every line honours the 48-char cap (long dish names must not wrap a price off).
  for (const d of plan.days) {
    if (!d.meal) continue;
    const m = d.meal;
    const mealCents = m.mealCents ?? m.perPlateCents * (m.plates || 2);
    const prefix = `• ${d.day.slice(0, 3)} `;
    const price = ` ${formatRands(mealCents)}`;
    const room = 48 - prefix.length - price.length;
    const title =
      m.title.length > room
        ? m.title.slice(0, Math.max(1, room - 1)) + "…"
        : m.title;
    lines.push(prefix + title + price);
  }
  if (plan.mealsPlanned > 0) lines.push("");

  // P-306: pantry consumption — the covered-week story in text form
  if (plan.pantryUse && plan.pantryUse.length) {
    lines.push("*FROM YOUR PANTRY*");
    for (const u of plan.pantryUse) {
      const price =
        u.valueCents !== null ? ` ${formatRands(u.valueCents)}` : "";
      const room = 48 - 2 - price.length;
      const name =
        u.name.length > room
          ? u.name.slice(0, Math.max(1, room - 1)) + "…"
          : u.name;
      lines.push(`• ${name}${price}`);
    }
    lines.push("");
  }
  let currentAisle = null;
  for (const item of plan.shoppingList) {
    if (item.aisle !== currentAisle) {
      if (currentAisle !== null) lines.push("");
      lines.push(
        `*${item.aisle.toUpperCase()} — ${formatRands(subtotalByAisle.get(item.aisle))}*`,
      );
      currentAisle = item.aisle;
    }
    // P-540 red-team: NO per-item ≈ here — the P-302 WhatsApp contract is
    // frozen ('• name (×packs) R..' exactly, 48-char cap). Tier honesty lives in
    // the slip's HTML legend (full words) + the compact footer line below.
    // P-541 red-team catch: shop lines must honour the SAME 48-char cap as
    // meal/pantry lines — a long name + (×packs) + price soft-wrapped a price
    // off its item line on low-end Android. Truncate the name, never the price.
    {
      const body = `• ${item.name} (×${item.packs}) ${formatRands(item.priceCents)}`;
      if (body.length <= 48) lines.push(body);
      else {
        const price = ` ${formatRands(item.priceCents)}`;
        const head = `• ${item.name} (×${item.packs})`;
        const room = 48 - price.length;
        lines.push(head.slice(0, Math.max(1, room - 1)) + "…" + price);
      }
    }
  }
  // P-540 (c): the pack surplus that spoils — say it in the take-to-store text too
  if (plan.packLeftovers && plan.packLeftovers.length) {
    lines.push("", "*USE SOON (from your packs)*");
    for (const l of plan.packLeftovers)
      lines.push(
        `• ${l.name}: ${trimPlanQty(l.qty)} ${l.unit} left (${l.shelfDays}-day shelf)`,
      );
  }
  lines.push("", `*TOTAL ${formatRands(plan.totalCents)}*`);
  lines.push(
    `Saved vs eating out: ${formatRands(Math.max(0, plan.savingsCents))}`,
  );
  // P-540 (d): price honesty footer — verified vs estimated (≈ marks the lines)
  if (plan.priceTiers) {
    const { verifiedCount, estimatedCount, verified, estimated } =
      plan.priceTiers;
    // P-540 (d): the tier honesty line, compacted for the 48-char cap.
    // '✓' = verified shelf prices; '≈' = estimates — same legend as the slip,
    // which spells both words out in full. Worst case: 'Prices: 123✓ (R9,999.99) · 123≈ (R9,999.99)' = 46.
    lines.push(
      `Prices: ${verifiedCount}✓ (${formatRands(verified)}) · ${estimatedCount}≈ (${formatRands(estimated)})`,
    );
  }
  return lines.join("\n");
}
