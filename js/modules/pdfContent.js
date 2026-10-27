// pdfContent.js — P-563: the Masterclass content compiler.
// Pure module: turns a planner plan into the neutral section model the themed
// PDF engine renders. Every number is DERIVED from the plan, the corpus, the
// registry, prices and the pantry — nothing invented (no nutrition science,
// no chef lore; tag/aisle claims only, each with its honesty line).
// Compute cost comes from the planner's own costing engine (mealCostAt), so
// swap savings and corpus percentiles trace to the same math as the site.

import {
  formatRands,
  defaultPrice,
  rescaleRecipe,
  costRecipe,
} from "./costing.js";
import { mealCostAt, isDinnerFit } from "./planner.js";

const MON = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

/** Build a priceOf closure from a prices array (same contract as main.js). */
export function priceOfFrom(prices) {
  const map = {};
  for (const e of prices || []) (map[e.ingredient_id] ||= []).push(e);
  return (id) => defaultPrice(id, map[id] || []);
}

const R = (c) => formatRands(c ?? 0);

/** ISO date of the Monday of the export week + day dates. */
function weekDates(date) {
  const d = date instanceof Date ? new Date(date) : new Date();
  const day = (d.getDay() + 6) % 7; // Mon=0
  const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
  return MON.map((_, i) => {
    const x = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i);
    return x.toISOString().slice(0, 10);
  });
}

/** The neutral row grammar the PDF engine renders. */
const line = (left, right, o = {}) => ({ kind: "line", left, right, ...o });
const note = (text, o = {}) => ({ kind: "note", text, ...o });
const sub = (text) => ({ kind: "sub", text });

/**
 * masterclass(plan, opts) → { cover, sections: [ { id, title, rows } ] }
 * opts: { metaById: Map id→ingredient meta, recipes: corpus[], pantry: [],
 *         prices: [] | priceOf: fn, settings: { household, themeName },
 *         date: Date }
 */
export function masterclass(plan, opts = {}) {
  const metaById = opts.metaById || new Map();
  const recipes = opts.recipes || [];
  const priceOf = opts.priceOf || priceOfFrom(opts.prices || []);
  const pantry = opts.pantry || [];
  const settings = opts.settings || {};
  const date = opts.date instanceof Date ? opts.date : new Date();
  const days = plan.days || [];
  const meals = days.filter((d) => d.meal && d.meal.real !== false);
  const out = [];
  const dates = weekDates(date);

  // name→meta join for the shopping list (it carries display names)
  const metaByName = new Map();
  for (const m of metaById.values())
    metaByName.set(String(m.name).toLowerCase(), m);
  const metaOfName = (n) =>
    metaById.get(n) || metaByName.get(String(n).toLowerCase()) || null;

  // ── COVER ──
  const cover = {
    title: "RANDPLATES WEEK MASTERCLASS",
    stats: [
      { label: "BUDGET", value: R(plan.weekBudgetCents) },
      { label: "TO BUY", value: R(plan.totalCents) },
      {
        label: "SAVED VS TAKEOUT",
        value: R(Math.max(0, plan.savingsCents ?? 0)),
      },
    ],
    sub: `${MON[0]} ${dates[0].slice(5)} to ${MON[6]} ${dates[6].slice(5)}  |  ${date.toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric" })}`,
    metaLines: [
      `${plan.mealsPlanned} of 7 dinners planned for ${settings.household || 2} ${settings.household === 1 ? "person" : "people"}`,
      `Budget ${R(plan.weekBudgetCents)}  |  To buy ${R(plan.totalCents)}`,
      settings.themeName ? `Theme: ${settings.themeName}` : null,
    ].filter(Boolean),
  };

  // ── precomputes shared by several sections ──
  // corpus per-plate costs at 2 plates (percentile + swap pre-rank)
  const corpusCost = new Map();
  const dinnerPool = [];
  for (const r of recipes) {
    if (!isDinnerFit(r)) continue;
    const c = mealCostAt(r, 2, priceOf);
    if (c) {
      corpusCost.set(r.id, c);
      dinnerPool.push(r);
    }
  }
  const platesSorted = [...corpusCost.values()]
    .map((c) => c.perPlateCents)
    .sort((a, b) => a - b);
  const plannedIds = new Set(meals.map((d) => d.meal.recipeId));

  // ── THE VERDICT ──
  const delta = (plan.totalCents ?? 0) - (plan.weekBudgetCents ?? 0);
  const priciest = meals.reduce(
    (b, d) => (!b || d.meal.mealCents > b.meal.mealCents ? d : b),
    null,
  );
  const swapRows = []; // filled below, verdict reads the best one
  let verdictRows = [
    line(
      `${delta <= 0 ? "Inside budget" : "Over budget"}`,
      R(Math.abs(delta)),
      { strong: true },
    ),
    line("Saved vs eating out (R55/plate line)", R(plan.savingsCents ?? 0)),
    priciest
      ? line(
          `Priciest day: ${priciest.day} - ${priciest.meal.title}`,
          R(priciest.meal.mealCents),
        )
      : null,
  ].filter(Boolean);
  if ((plan.warnings || []).length)
    verdictRows.push(
      note(
        `Watch: ${plan.warnings[0]}${plan.warnings.length > 1 ? ` (+${plan.warnings.length - 1} more in the notes)` : ""}`,
      ),
    );
  out.push({ id: "verdict", title: "The Verdict", rows: verdictRows });

  // ── BUDGET PACING (bought spend allocated by meal share — pantry food is free) ──
  const mealSum = meals.reduce((t, d) => t + (d.meal.mealCents || 0), 0) || 1;
  let cum = 0;
  const pace = days.map((d, i) => {
    const share = d.meal ? (d.meal.mealCents || 0) / mealSum : 0;
    cum += Math.round((plan.totalCents ?? 0) * share);
    const prorated = Math.round(((plan.weekBudgetCents ?? 0) * (i + 1)) / 7);
    return { day: d.day, cum, prorated, gap: cum - prorated };
  });
  const paceRows = pace.map((p) =>
    line(
      `${p.day}: ${R(p.cum)} of the shop spent vs ${R(p.prorated)} pace`,
      `${p.gap > 0 ? "+" : ""}${R(p.gap).replace("R", "R")}`,
      { soft: !p.gap },
    ),
  );
  paceRows.push(
    note(
      `Projected finish: ${R(plan.totalCents)} against ${R(plan.weekBudgetCents)} - ${delta <= 0 ? `you finish ${R(-delta)} under` : `you finish ${R(delta)} over`}. Pantry food is free: only the shopping list is paced.`,
    ),
  );
  out.push({ id: "pacing", title: "Budget Pace", rows: paceRows });

  // ── PRICE CONFIDENCE (verified v vs estimated ~ share of spend) ──
  let verifiedCents = 0,
    estimatedCents = 0;
  const estItems = [];
  for (const i of plan.shoppingList || []) {
    const meta = metaOfName(i.name);
    const pe = meta ? priceOf(meta.id) : null; // tier lives on the price entry (✓ vs ≈)
    const src = pe?.source === "verified" ? "verified" : "estimated";
    if (src === "verified") verifiedCents += i.priceCents;
    else {
      estimatedCents += i.priceCents;
      estItems.push(i);
    }
  }
  const spendTotal = verifiedCents + estimatedCents;
  const pctV = spendTotal
    ? Math.round((100 * verifiedCents) / spendTotal)
    : 100;
  const headroom = (plan.weekBudgetCents ?? 0) - (plan.totalCents ?? 0);
  const honestyRows = [
    line(
      `${pctV}% of this week's spend sits on verified prices (v); ${100 - pctV}% on estimates (~).`,
      null,
    ),
  ];
  if (estItems.length) {
    const top = estItems
      .sort((a, b) => b.priceCents - a.priceCents)
      .slice(0, 5);
    honestyRows.push(sub("Eyeball these in-store (estimates)"));
    for (const i of top)
      honestyRows.push(line(`${i.name}`, `~${R(i.priceCents)}`));
    if (estItems.length > 5)
      honestyRows.push(note(`+${estItems.length - 5} more estimated items.`));
  } else {
    honestyRows.push(note("Every priced line in this plan is verified."));
  }
  if (headroom > 0 && estimatedCents > 0)
    honestyRows.push(
      note(
        `Buffer: estimated prices could rise ${Math.floor((100 * headroom) / estimatedCents)}% before this plan breaks the budget.`,
      ),
    );
  if (headroom < 0)
    honestyRows.push(
      note(`Already over budget by ${R(-headroom)} before any price moves.`),
    );
  out.push({ id: "honesty", title: "Price Confidence", rows: honestyRows });

  // ── THE WEEK (kept from v1: the at-a-glance grid) ──
  const weekRows = days.map((d) =>
    !d.meal
      ? line(`${d.day.toUpperCase()}: (nothing planned)`, null, { soft: true })
      : line(
          `${d.day.toUpperCase()}: ${d.meal.title}`,
          `${d.meal.plates || 2}p ${R(d.meal.mealCents ?? (d.meal.perPlateCents || 0) * (d.meal.plates || 2))}`,
          { soft: d.meal.real === false },
        ),
  );
  out.push({ id: "week", title: "The Week", rows: weekRows });

  // ── WHAT EACH MEAL NEEDS (kept: per-ingredient deep dive) ──
  const needRows = [];
  for (const d of days) {
    if (!d.meal) continue;
    const m = d.meal;
    const plates = m.plates || 2;
    needRows.push(
      sub(`${d.day.toUpperCase()} - ${m.title} (${plates} plates)`),
    );
    // P-564: the planner's committed meal carries no ingredient lines —
    // rebuild them from the corpus recipe at the planned plate count, priced
    // by the same costing engine (costRecipe), tiers from the price source.
    const rec = recipes.find((r) => r.id === m.recipeId);
    if (rec && rec.ingredients && rec.ingredients.length) {
      const scaled = rescaleRecipe(rec, plates);
      const { lines } = costRecipe(scaled, priceOf);
      for (const L of lines) {
        const l = L.line || L;
        const meta = metaById.get(l.id);
        const src = L.priceEntry?.source === "verified" ? "v" : "~";
        needRows.push(
          line(
            `${meta?.name || l.id}  ${trim(l.qty)} ${l.unit}${l.optional ? " (optional)" : ""}`,
            L.costCents != null ? `${src} ${R(L.costCents)}` : "unpriced",
            { indent: 2, soft: !!l.optional },
          ),
        );
      }
    } else {
      needRows.push(note("Recipe detail unavailable offline for this meal."));
    }
    needRows.push({ kind: "gap" });
  }
  out.push({ id: "mealneeds", title: "What Each Meal Needs", rows: needRows });

  // ── SHOPPING LIST (kept, aisle-ordered) ──
  const shopRows = [];
  if (!(plan.shoppingList || []).length) {
    shopRows.push(
      note(
        "Nothing to buy - everything on this plan is already in your kitchen.",
      ),
    );
  } else {
    const sections = [];
    for (const i of plan.shoppingList) {
      const last = sections[sections.length - 1];
      if (!last || last.aisle !== i.aisle)
        sections.push({ aisle: i.aisle, items: [i] });
      else last.items.push(i);
    }
    // meals-used counts: explain multi-pack buys ("used in 5 meals")
    const useCount = new Map();
    for (const d of meals) {
      const rec = recipes.find((r) => r.id === d.meal.recipeId);
      for (const i of rec?.ingredients || [])
        useCount.set(i.id, (useCount.get(i.id) || 0) + 1);
    }
    for (const sec of sections) {
      shopRows.push(
        sub(
          sec.aisle.toUpperCase(),
          sec.items.reduce((t, i) => t + i.priceCents, 0),
        ),
      );
      for (const i of sec.items) {
        const meta = metaOfName(i.name);
        const n = meta ? useCount.get(meta.id) : null;
        shopRows.push(
          line(
            `${i.name}  ${i.packs} x ${i.pack_qty} ${i.pack_unit}${n > 1 ? ` - used in ${n} meals` : ""}`,
            R(i.priceCents),
            { indent: 2 },
          ),
        );
      }
    }
  }
  out.push({ id: "shopping", title: "Shopping List", rows: shopRows });

  // ── KITCHEN ECONOMICS (pantry value + running-low forecast) ──
  const pantryValue = (plan.pantryUse || []).reduce(
    (t, u) => t + (u.valueCents || 0),
    0,
  );
  const share = plan.mealValueCents
    ? Math.round((100 * pantryValue) / plan.mealValueCents)
    : 0;
  const usedIds = new Set();
  for (const d of meals)
    for (const L of d.meal.lines || []) usedIds.add(L.id || (L.line || L).id);
  const lowAfter = (pantry || []).filter(
    (p) => usedIds.has(p.id) && p.running_low,
  );
  const econRows = [
    line(
      `You cooked ${R(pantryValue)} of food you already owned - ${share}% of the week's food value.`,
      null,
    ),
  ];
  if ((plan.pantryUse || []).length) {
    econRows.push(sub("Drawn from your kitchen"));
    const top = [...plan.pantryUse]
      .sort((a, b) => (b.valueCents || 0) - (a.valueCents || 0))
      .slice(0, 5);
    for (const u of top)
      econRows.push(
        line(
          `${u.name}  uses ${trim(u.qty)} ${u.unit}`,
          u.valueCents != null ? R(u.valueCents) : null,
          { indent: 2 },
        ),
      );
    if (plan.pantryUse.length > 5)
      econRows.push(
        note(`+${plan.pantryUse.length - 5} more pantry items used.`),
      );
  }
  if (lowAfter.length)
    econRows.push(
      note(
        `Restock soon: ${lowAfter
          .slice(0, 4)
          .map((p) => metaById.get(p.id)?.name || p.id)
          .join(", ")} run low after this week.`,
      ),
    );
  out.push({ id: "pantry", title: "Kitchen Economics", rows: econRows });

  // ── COOK-BY CHECK (expiry vs planned day) ──
  const byId = new Map(days.map((d, i) => [d.day, i]));
  const cookRows = [];
  const conflicts = [];
  const unplanned = [];
  for (const p of pantry || []) {
    if (!p.expiry) continue;
    if (p.expiry > dates[6]) continue; // dies after the week: not our problem yet
    const useIdx = days.findIndex(
      (d) =>
        d.meal &&
        (d.meal.lines || []).some((L) => (L.id || (L.line || L).id) === p.id),
    );
    const name = metaById.get(p.id)?.name || p.id;
    if (useIdx === -1) {
      unplanned.push({ name, expiry: p.expiry });
      continue;
    }
    if (p.expiry < dates[useIdx])
      conflicts.push({ name, expiry: p.expiry, day: days[useIdx].day });
  }
  conflicts.sort((a, b) => a.expiry.localeCompare(b.expiry));
  for (const c of conflicts.slice(0, 4))
    cookRows.push(
      line(
        `${c.name} expires ${c.expiry} but is first cooked on ${c.day}. Cook it earlier - or move that meal.`,
        null,
      ),
    );
  for (const u of unplanned.slice(0, 3))
    cookRows.push(
      line(`${u.name} expires ${u.expiry} and no planned meal uses it.`, null, {
        soft: true,
      }),
    );
  if (!cookRows.length)
    cookRows.push(
      note(
        "No expiry conflicts: nothing in your kitchen dies before its meal.",
      ),
    );
  if (conflicts.length > 4)
    cookRows.push(note(`+${conflicts.length - 4} more expiry conflicts.`));
  out.push({ id: "cookby", title: "Cook-By Check", rows: cookRows });

  // ── PREP ONCE, USE TWICE (shared ingredient chains across days) ──
  const chains = new Map();
  for (const d of days) {
    if (!d.meal) continue;
    for (const L of d.meal.lines || []) {
      const id = L.id || (L.line || L).id;
      if (!chains.has(id)) chains.set(id, []);
      chains.get(id).push(d.day);
    }
  }
  const shared = [...chains.entries()]
    .filter(([, ds]) => new Set(ds).size >= 2)
    .sort((a, b) => new Set(b[1]).size - new Set(a[1]).size)
    .slice(0, 5);
  const prepRows = shared.length
    ? shared.map(([id, ds]) => {
        const uniq = [...new Set(ds)];
        return line(
          `${metaById.get(id)?.name || id} is used on ${uniq.join(", ")}. Prep it once and store it.`,
          null,
        );
      })
    : [note("No ingredient repeats across days - nothing to batch-prep.")];
  if (
    chains.size &&
    shared.length === 5 &&
    [...chains.values()].filter((ds) => new Set(ds).size >= 2).length > 5
  )
    prepRows.push(note("More repeat ingredients exist - the top 5 are shown."));
  out.push({ id: "prep", title: "Prep Once, Use Twice", rows: prepRows });

  // ── CHEAPER SWAPS (real corpus candidates, honest coverage) ──
  const alreadySuggested = new Set();
  for (const d of days) {
    if (!d.meal || d.meal.real === false) continue;
    const m = d.meal;
    const plates = m.plates || 2;
    let best = null;
    for (const c of dinnerPool) {
      if (
        plannedIds.has(c.id) ||
        c.id === m.recipeId ||
        alreadySuggested.has(c.id)
      )
        continue;
      const cc = mealCostAt(c, plates, priceOf);
      if (!cc || cc.mealCents >= m.mealCents) continue;
      if (!best || cc.mealCents < best.cc.mealCents) best = { c, cc };
    }
    if (best) {
      alreadySuggested.add(best.c.id); // P-564: never suggest the same swap twice
      swapRows.push({
        day: d.day,
        from: m.title,
        to: best.c.title,
        saved: m.mealCents - best.cc.mealCents,
      });
    }
  }
  const swapSectionRows = swapRows.length
    ? swapRows.flatMap((s) => [
        line(`${s.day}: ${s.to} instead of ${s.from}`, `-${R(s.saved)}`),
      ])
    : [
        note(
          "No cheaper dinner-tagged recipe in the corpus beats any planned meal.",
        ),
      ];
  if (swapRows.length)
    swapSectionRows.push(
      note(
        "Computed from real corpus prices at your plate counts. If you already own parts of the swap, it saves even more.",
      ),
    );
  out.push({ id: "swaps", title: "Cheaper Swaps", rows: swapSectionRows });
  const bestSwap = swapRows.sort((a, b) => b.saved - a.saved)[0];
  if (bestSwap)
    verdictRows.splice(
      3,
      0,
      line(
        `Biggest saving: swap ${bestSwap.day} to ${bestSwap.to}`,
        `-${R(bestSwap.saved)}`,
      ),
    );

  // ── WHAT'S LEFT OVER (waste honesty + a real recipe that uses it) ──
  const leftovers = plan.packLeftovers || [];
  const wasteRows = leftovers.length
    ? [
        line(
          `This plan leaves ${R(leftovers.reduce((t, l) => t + (l.valueCents || 0), 0))} of bought food unused.`,
          null,
        ),
      ]
    : [];
  const topL = [...leftovers]
    .sort((a, b) => (b.valueCents || 0) - (a.valueCents || 0))
    .slice(0, 5);
  for (const l of topL) {
    const uses = recipes.find(
      (r) =>
        plannedIds.has(r.id) === false &&
        (r.ingredients || []).some((i) => i.id === l.id),
    );
    wasteRows.push(
      line(
        `${trim(l.qty)} ${l.unit} ${l.name} (${R(l.valueCents)}) left. Use it in: ${uses ? uses.title : "anything this week - it is already paid for"}.`,
        null,
        { indent: 2 },
      ),
    );
  }
  if (leftovers.length > 5)
    wasteRows.push(note(`+${leftovers.length - 5} more leftover items.`));
  if (!leftovers.length)
    wasteRows.push(
      note("Nothing is left over: the plan uses every pack it buys."),
    );
  out.push({ id: "waste", title: "What's Left Over", rows: wasteRows });

  // ── WHERE THIS PLAN SITS (corpus percentile, honest per-plate math) ──
  if (meals.length && platesSorted.length) {
    const avg = Math.round(
      meals.reduce((t, d) => t + d.meal.perPlateCents, 0) / meals.length,
    );
    const cheaper = platesSorted.filter((p) => p < avg).length;
    const median = platesSorted[Math.floor(platesSorted.length / 2)];
    let cheapestT = "",
      priciestT = "";
    let cmin = Infinity,
      cmax = -1;
    for (const [id, c] of corpusCost) {
      if (c.perPlateCents < cmin) {
        cmin = c.perPlateCents;
        cheapestT = (recipes.find((r) => r.id === id) || {}).title || "";
      }
      if (c.perPlateCents > cmax) {
        cmax = c.perPlateCents;
        priciestT = (recipes.find((r) => r.id === id) || {}).title || "";
      }
    }
    out.push({
      id: "percentile",
      title: "Where This Plan Sits",
      rows: [
        line(
          `Average plate (cheaper than ${Math.round((100 * cheaper) / platesSorted.length)}% of corpus)`,
          R(avg),
        ),
        line("Corpus median plate", R(median), { soft: true }),
        line(`Cheapest in corpus: ${cheapestT}`, R(cmin), { soft: true }),
        line(`Priciest in corpus: ${priciestT}`, R(cmax), { soft: true }),
      ],
    });
  } else {
    out.push({
      id: "percentile",
      title: "Where This Plan Sits",
      rows: [
        note("Plan at least one real recipe to compare it to the corpus."),
      ],
    });
  }

  // ── WEEK MIX (tag-based only, with the honesty line) ──
  const tagCount = {};
  for (const d of meals)
    for (const t of d.meal.tags || [])
      if (t !== "dinner") tagCount[t] = (tagCount[t] || 0) + 1;
  const proteinDays = meals.filter((d) => {
    const rec = recipes.find((r) => r.id === d.meal.recipeId);
    return (rec?.ingredients || []).some((i) =>
      String(metaById.get(i.id)?.aisle || "").startsWith("protein"),
    );
  }).length;
  const mixRows = Object.entries(tagCount)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([t, n]) =>
      line(`${n} of ${meals.length} dinners are ${t}.`, null, { soft: true }),
    );
  mixRows.push(
    line(
      `Fresh protein appears in ${proteinDays} of ${meals.length} planned dinners.`,
      null,
      { soft: true },
    ),
  );
  mixRows.push(
    note("Based on recipe tags and aisles only - not nutritional advice."),
  );
  out.push({ id: "mix", title: "Week Mix", rows: mixRows });

  // ── TOTALS (kept) ──
  out.push({
    id: "totals",
    title: "The Numbers",
    rows: [
      line("TOTAL TO BUY", R(plan.totalCents), { strong: true, tag: true }),
      line("PLAN PLATE VALUE", R(plan.mealValueCents ?? 0), { tag: true }),
      line("SAVED VS EATING OUT", R(Math.max(0, plan.savingsCents ?? 0)), {
        tag: true,
      }),
    ],
  });

  // ── NOTES ──
  if ((plan.warnings || []).length)
    out.push({
      id: "notes",
      title: "Notes",
      rows: plan.warnings.map((w) => note(`Note: ${w}`)),
    });

  return { cover, sections: out, meta: { dateStr: cover.sub } };
}

const trim = (n) =>
  Number.isInteger(n) ? String(n) : String(Math.round((n ?? 0) * 100) / 100);
