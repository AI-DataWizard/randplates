// achievements.js — cook log badges/streaks (PRD §7.8, the Pitch26 pattern evolved).
// getAchievementStats() is the single live-calculation source of truth: the hub and any
// stats screen must call THIS, never keep their own counts. PURE FUNCTIONS.

/** Badge catalogue. `earned(log, stats)` decides from the cook log itself. */
export const BADGES = [
  {
    id: "first-plate",
    name: "First Plate",
    icon: "🍽️",
    line: "You've cooked your first RandPlates meal - lekker start!",
    desc: "Cook your first RandPlates meal.",
    earned: (log) => log.length >= 1,
  },
  {
    id: "hat-trick",
    name: "Hat-Trick",
    icon: "🔥",
    line: "Three days straight of home-cooked plates - you're on fire.",
    desc: "Cook 3 days in a row.",
    earned: (log, s) => s.longestStreak >= 3,
  },
  {
    id: "week-warrior",
    name: "Week Warrior",
    icon: "⚡",
    line: "Seven days in a row - your kitchen never rested.",
    desc: "Cook 7 days in a row.",
    earned: (log, s) => s.longestStreak >= 7,
  },
  {
    id: "first-braai",
    name: "First Braai",
    icon: "🍖",
    line: "You've fired up a braai-tagged recipe - sizzle success.",
    desc: 'Cook a recipe tagged "braai".',
    earned: (log) => log.some((e) => (e.tags || []).includes("braai")),
  },
  {
    id: "r25-plate-week",
    name: "R25-Per-Plate Week",
    icon: "💰",
    line: "Your average this week stayed at R25.00 or less per plate.",
    desc: "Average ≤ R25 per plate over your last 7 cooks.",
    earned: (log) =>
      log.length >= 7 &&
      log.slice(-7).reduce((t, e) => t + e.perPlateCents, 0) / 7 <= 2500,
  },
  {
    id: "no-waste-week",
    name: "No-Waste Week",
    icon: "♻️",
    line: "Five meals made only from what you already had - waste-free.",
    desc: "Cook 5 meals that used only what you already had (zero missing items).",
    earned: (log) => log.filter((e) => e.missingCount === 0).length >= 5,
  },
  {
    id: "ten-plates",
    name: "Ten Plates",
    icon: "🍲",
    line: "Ten RandPlates dishes logged - your pantry's getting busy.",
    desc: "Log 10 cooks.",
    earned: (log) => log.length >= 10,
  },
  // ---- P-415 expansion (owner-driven): way more achievements ----
  {
    id: "twenty-plates",
    name: "Twenty Plates",
    icon: "🥘",
    line: "Twenty home-cooked plates logged - you're a regular.",
    desc: "Log 20 cooks.",
    earned: (log) => log.length >= 20,
  },
  {
    id: "fifty-plates",
    name: "Fifty Plates",
    icon: "🏆",
    line: "Fifty meals cooked - your kitchen's a powerhouse.",
    desc: "Log 50 cooks.",
    earned: (log) => log.length >= 50,
  },
  {
    id: "streak-14",
    name: "Two-Week Fire",
    icon: "🌶️",
    line: "Fourteen consecutive cooking days - you've kept the heat on.",
    desc: "Cook 14 days in a row.",
    earned: (log, s) => s.longestStreak >= 14,
  },
  {
    id: "variety-ten",
    name: "Explorer",
    icon: "🧭",
    line: "Ten different recipes tried - you've tasted variety.",
    desc: "Cook 10 different recipes.",
    earned: (log) => new Set(log.map((e) => e.recipeId || e.title)).size >= 10,
  },
  {
    id: "r15-plate-week",
    name: "R15-Per-Plate Week",
    icon: "🪙",
    line: "Your weekly average hit R15.00 per plate or less.",
    desc: "Average ≤ R15 per plate over your last 7 cooks.",
    earned: (log) =>
      log.length >= 7 &&
      log.slice(-7).reduce((t, e) => t + e.perPlateCents, 0) / 7 <= 1500,
  },
  {
    id: "veg-week",
    name: "Veggie Streak",
    icon: "🥬",
    line: "Seven vegetarian plates logged - greens on repeat.",
    desc: "Cook 7 vegetarian recipes.",
    earned: (log) =>
      log.filter((e) => (e.tags || []).includes("vegetarian")).length >= 7,
  },
  {
    id: "budget-ten",
    name: "Budget Cook",
    icon: "🧾",
    line: "Ten budget-tagged dishes logged - you're stretching every R.",
    desc: "Cook 10 recipes tagged budget.",
    earned: (log) =>
      log.filter((e) => (e.tags || []).includes("budget")).length >= 10,
  },
  {
    id: "tradition-keeper",
    name: "Tradition Keeper",
    icon: "🫓",
    line: "Five traditional recipes cooked - you honour the classics.",
    desc: "Cook 5 recipes tagged traditional.",
    earned: (log) =>
      log.filter((e) => (e.tags || []).includes("traditional")).length >= 5,
  },
  {
    id: "zero-waste-pro",
    name: "Zero-Waste Pro",
    icon: "🌱",
    line: "Fifteen meals made solely from pantry stock - zero waste.",
    desc: "Cook 15 meals entirely from what you already had.",
    earned: (log) => log.filter((e) => e.missingCount === 0).length >= 15,
  },
  {
    id: "month-marathon",
    name: "Month Marathon",
    icon: "📅",
    line: "Twenty dishes logged in a calendar month - nonstop cooking.",
    desc: "Log 20 cooks within one calendar month.",
    earned: (log) => {
      const byMonth = new Map();
      for (const e of log) {
        const m = String(e.date || "").slice(0, 7); // YYYY-MM
        if (!/^\d{4}-\d{2}$/.test(m)) continue;
        byMonth.set(m, (byMonth.get(m) || 0) + 1);
      }
      for (const n of byMonth.values()) if (n >= 20) return true;
      return false;
    },
  },
  // ---- P-561 expansion (owner-directed, Oct 24): Phase 4/5 signals ----
  // Decoder (Phase 4), themes (P-545/P-557), dessert cooking (P-522a), the
  // Planner (P-540), and pantry stocking — the full product, not just cooks.
  {
    id: "kitchen-decoder",
    name: "Kitchen Decoder",
    icon: "🔎",
    line: "You decoded your first recipe - from photo or text to pantry-ready.",
    desc: "Decode your first recipe with the Decoder.",
    earned: (log, s) => (s.decodedCount || 0) >= 1,
  },
  {
    id: "recipe-whisperer",
    name: "Recipe Whisperer",
    icon: "📸",
    line: "Five recipes decoded - your camera roll is a cookbook now.",
    desc: "Decode 5 recipes.",
    earned: (log, s) => (s.decodedCount || 0) >= 5,
  },
  {
    id: "screen-to-stove",
    name: "From Screen to Stove",
    icon: "📱",
    line: "You cooked a recipe YOU decoded - that's the full circle.",
    desc: "Cook a recipe you decoded yourself.",
    earned: (log, s) =>
      log.some((e) => (s.decodedIds || []).includes(e.recipeId)),
  },
  {
    id: "sweet-tooth",
    name: "Sweet Tooth",
    icon: "🍰",
    line: "A dessert made it from the corpus to your table - lekker.",
    desc: "Cook a dessert recipe.",
    earned: (log) => log.some((e) => (e.tags || []).includes("dessert")),
  },
  {
    id: "new-look",
    name: "New Look",
    icon: "🎨",
    line: "Three themes tried - RandPlates has a wardrobe now.",
    desc: "Try 3 different themes in Settings.",
    earned: (log, s) => (s.themesTried || 0) >= 3,
  },
  {
    id: "full-wardrobe",
    name: "Full Wardrobe",
    icon: "🖌️",
    line: "Eight themes tried - you have seen every mood the app has.",
    desc: "Try 8 different themes.",
    earned: (log, s) => (s.themesTried || 0) >= 8,
  },
  {
    id: "fully-stocked",
    name: "Fully Stocked",
    icon: "🧺",
    line: "Twenty different ingredients in your kitchen - a real spaza.",
    desc: "Keep 20+ ingredients in your pantry.",
    earned: (log, s) => (s.pantryCount || 0) >= 20,
  },
  {
    id: "aisle-explorer",
    name: "Aisle Explorer",
    icon: "🛒",
    line: "Six different aisles represented in your kitchen - a full shop.",
    desc: "Own ingredients from 6 different aisles.",
    earned: (log, s) => (s.pantryAisles || 0) >= 6,
  },
  {
    id: "staple-start",
    name: "Back to Basics",
    icon: "🧂",
    line: "All eight everyday staples stocked - your kitchen has a spine.",
    desc: "Stock all 8 common staples (oil, salt, pepper, sugar, stock, curry, chicken spice, tomato sauce).",
    earned: (log, s) => (s.staplesOwned || 0) >= 8,
  },
  {
    id: "taste-the-world",
    name: "Taste the World",
    icon: "🌍",
    line: "Twenty-five different recipes tried - variety is your spice.",
    desc: "Cook 25 different recipes.",
    earned: (log) => new Set(log.map((e) => e.recipeId || e.title)).size >= 25,
  },
  {
    id: "the-planner",
    name: "The Planner",
    icon: "🗓️",
    line: "A full week of dinners planned - future you approves.",
    desc: "Save a 7-dinner plan in the Planner.",
    earned: (log, s) => (s.savedPlansCount || 0) >= 1,
  },
  {
    id: "big-saver",
    name: "Big Saver",
    icon: "🐷",
    line: "You saved R500+ versus takeout - that's a serious pocket win.",
    desc: "Save R500+ versus takeout.",
    earned: (log, s) => s.totalSavedCents >= 50000,
  },
];

/** Local calendar date string YYYY-MM-DD (P-207 #18 fix). The cook log used
 *  toISOString().slice(0,10) — UTC dates — so a 00:30 SAST cook logged as
 *  "yesterday" and streaks/day counts silently drifted for night cooks.
 *  Streaks are a user's OWN calendar: device-local dates are the honest keys. */
export function localDateStr(d = new Date()) {
  const y = d.getFullYear(),
    m = String(d.getMonth() + 1).padStart(2, "0"),
    day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Streaks work on consecutive calendar days of cooking (local-date keys). */
export function streakFromLog(log) {
  const days = [...new Set(log.map((e) => String(e.date).slice(0, 10)))].sort();
  let longest = 0,
    current = 0,
    run = 0;
  let prev = null;
  for (const d of days) {
    if (prev && nextDay(prev) === d) run += 1;
    else run = 1;
    longest = Math.max(longest, run);
    prev = d;
  }
  // current streak: does it reach today (or yesterday, if not cooked yet today)?
  const today = localDateStr();
  const last = days[days.length - 1];
  const yesterday = localDateStr(new Date(Date.now() - 864e5));
  current = last === today || last === yesterday ? run : 0;
  return { longest, current };
}

function nextDay(iso) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * P-403: cook-count per LOCAL calendar day (heatmap source). The log stores
 * local YYYY-MM-DD dates (P-207 #18); this just tallies them. The view owns
 * grid placement — this owns the truth.
 * @returns {Map<string, number>} localDate -> cooks that day
 */
export function heatByDate(log) {
  const counts = new Map();
  for (const e of log || []) {
    const d = String((e && e.date) || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue; // garbage rows don't heat cells
    counts.set(d, (counts.get(d) || 0) + 1);
  }
  return counts;
}

/**
 * THE live calculation (Pitch26 pattern): everything derives from the raw log.
 * @param log [{ id, date, recipeId, title, perPlateCents, servings, missingCount, tags }]
 */
// ---- P-416: earned-XP model + level tiers ----
// XP per cook rewards EFFORT and THRIFT (owner spec: cost of the meal and
// number of plates): base 5, +1 per plate (cap 8), +1 per R5 under the R55
// takeout baseline (cap 6), +2 when you cooked purely from stock. Range 6..21.
// Recomputed from history on every read — no stored XP, so old log entries
// re-value automatically when the model changes.
export function xpForCook(entry) {
  const plates = Math.max(1, Math.min(8, Number(entry?.servings) || 1));
  const perPlate = Number(entry?.perPlateCents);
  const thrift = Number.isFinite(perPlate)
    ? Math.max(0, Math.min(6, Math.round((5500 - perPlate) / 500)))
    : 0;
  const wasteFree = entry?.missingCount === 0 ? 2 : 0;
  return 5 + plates + thrift + wasteFree;
}

// Level cost grows with seniority: 40 XP for 1→2, then +10 per level.
export function xpCostForLevel(level) {
  return 40 + (Math.max(1, level) - 1) * 10;
}

// RandPlates-flavoured ladder — one title per level, capped at 10.
export const LEVEL_TITLES = [
  "Pot Washer", // 1
  "Spaza Apprentice", // 2
  "Home Cook", // 3
  "Pap Veteran", // 4
  "Seven-Colours Sunday", // 5
  "Budget Boss", // 6
  "Braai Master", // 7
  "Gogo's Favourite", // 8
  "Kitchen Legend", // 9
  "RandPlates Royalty", // 10+
];
export function titleForLevel(level) {
  return LEVEL_TITLES[Math.min(LEVEL_TITLES.length, Math.max(1, level)) - 1];
}

/** P-402: diff two stats snapshots -> the badge objects that just earned.
 *  Pure engine logic; the view decides how to celebrate. */
export function newlyEarned(preStats, postStats) {
  const preIds = new Set(
    (preStats?.badges || []).filter((b) => b.earned).map((b) => b.id),
  );
  return (postStats?.badges || []).filter((b) => b.earned && !preIds.has(b.id));
}

export function getAchievementStats(log, ctx = {}) {
  const entries = [...log].sort((a, b) =>
    String(a.date).localeCompare(String(b.date)),
  );
  const { longest, current } = streakFromLog(entries);
  const totalCooks = entries.length;
  const avgPerPlateCents = totalCooks
    ? Math.round(entries.reduce((t, e) => t + e.perPlateCents, 0) / totalCooks)
    : 0;
  const cheapestPlateCents = totalCooks
    ? Math.min(...entries.map((e) => e.perPlateCents))
    : 0;
  const totalSavedCents = entries.reduce(
    (t, e) => t + Math.max(0, 5500 - e.perPlateCents),
    0,
  ); // vs takeout baseline

  // P-416: earned-XP model. xp = sum(xpForCook) + 5/longest-streak-day (streaks
  // still pay — they're the DNA), levels have growing costs + tier titles.
  const earnedXp = entries.reduce((t, e) => t + xpForCook(e), 0);
  const xp = earnedXp + longest * 5;
  let level = 1,
    spent = 0,
    nextCost = xpCostForLevel(1);
  while (spent + nextCost <= xp) {
    spent += nextCost;
    level += 1;
    nextCost = xpCostForLevel(level);
  }
  const xpIntoLevel = xp - spent;
  const levelTitle = titleForLevel(level);

  // ---- P-416 report stats: the "how much have I used RandPlates" mini-report ----
  const dates = entries
    .map((e) => String(e.date || ""))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  const firstCookDate = dates[0] || null;
  const monthKey = localDateStr().slice(0, 7);
  const thisMonth = entries.filter(
    (e) => String(e.date || "").slice(0, 7) === monthKey,
  );
  const cooksThisMonth = thisMonth.length;
  const platesThisMonth = thisMonth.reduce(
    (t, e) => t + (Number(e.servings) || 0),
    0,
  );
  const totalSpentCents = entries.reduce(
    (t, e) =>
      t +
      Math.round((Number(e.perPlateCents) || 0) * (Number(e.servings) || 1)),
    0,
  );

  // P-561: Phase 4/5 context signals ride alongside the cook-log stats —
  // decoder drafts, themes tried, pantry state, saved plans. Defaults keep
  // every pre-P-561 caller (and fixture) honest: no signal, no badge.
  const s2c = {
    longestStreak: longest,
    currentStreak: current,
    avgPerPlateCents,
    totalCooks,
    totalSavedCents,
    pantryCount: ctx.pantryCount || 0,
    pantryAisles: ctx.pantryAisles || 0,
    staplesOwned: ctx.staplesOwned || 0,
    decodedCount: ctx.decodedCount || 0,
    decodedIds: ctx.decodedIds || [],
    themesTried: ctx.themesTried || 0,
    savedPlansCount: ctx.savedPlansCount || 0,
  };
  const badges = BADGES.map((b) => ({
    id: b.id,
    name: b.name,
    desc: b.desc,
    icon: b.icon,
    line: b.line, // P-402: art + unlock line ride along
    earned: safe(() => b.earned(entries, s2c)) || false,
  }));

  // ---- P-403 personalization: go-to dish, this-week cadence, price trend ----
  const byRecipe = new Map();
  for (const e of entries) {
    const k = e.recipeId || e.title || "?";
    byRecipe.set(k, (byRecipe.get(k) || 0) + 1);
  }
  let mostCooked = null;
  for (const [k, count] of byRecipe) {
    if (!mostCooked || count > mostCooked.count) {
      const e = entries.find((x) => (x.recipeId || x.title || "?") === k);
      mostCooked = e ? { recipeId: e.recipeId, title: e.title, count } : null;
    }
  }
  // ---- P-415 expansion: plates, weekday profile, tag profile ----
  const totalPlates = entries.reduce(
    (t, e) => t + (Number(e.servings) || 0),
    0,
  );
  const distinctRecipes = new Set(entries.map((e) => e.recipeId || e.title))
    .size;
  const weekdayProfile = [0, 0, 0, 0, 0, 0, 0]; // Mon..Sun
  for (const e of entries) {
    const iso = String(e.date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) continue;
    const dow = new Date(iso + "T00:00:00Z").getUTCDay(); // 0=Sun
    weekdayProfile[(dow + 6) % 7]++; // -> Mon..Sun
  }
  const tagCounts = new Map();
  for (const e of entries)
    for (const t of e.tags || []) {
      tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
    }
  const topTags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([tag, count]) => ({ tag, count }));
  const busiestDayIdx = entries.length
    ? weekdayProfile.indexOf(Math.max(...weekdayProfile))
    : -1;

  const todayTs = new Date(localDateStr() + "T00:00:00Z").getTime();
  const daysAgo = (e) =>
    (todayTs - new Date(String(e.date) + "T00:00:00Z").getTime()) / 864e5;
  const last7 = entries.filter((e) => daysAgo(e) >= 0 && daysAgo(e) < 7);
  const prev7 = entries.filter((e) => daysAgo(e) >= 7 && daysAgo(e) < 14);
  const avgOf = (arr) =>
    arr.length
      ? Math.round(arr.reduce((t, e) => t + e.perPlateCents, 0) / arr.length)
      : null;

  return {
    totalCooks,
    currentStreak: current,
    longestStreak: longest,
    avgPerPlateCents,
    cheapestPlateCents,
    totalSavedCents,
    xp,
    level,
    xpIntoLevel,
    xpForNextLevel: nextCost, // P-416: grows with level (40, 50, 60, ...)
    badges,
    earnedCount: badges.filter((b) => b.earned).length,
    // P-403 personalization block
    mostCooked, // { recipeId, title, count } | null
    cooksThisWeek: last7.length,
    avgLast7Cents: avgOf(last7), // null when no cooks this week
    avgPrev7Cents: avgOf(prev7), // null when nothing to compare against
    // P-415 expansion
    totalPlates,
    distinctRecipes,
    weekdayProfile, // [Mon..Sun] cook counts
    busiestDayIdx, // 0=Mon..6=Sun, -1 when empty
    topTags, // [{ tag, count }] top 3
    // P-416: progression + report
    earnedXp, // from cooks alone (before the streak bonus)
    levelTitle, // themed tier title for the current level
    firstCookDate, // 'YYYY-MM-DD' | null
    cooksThisMonth,
    platesThisMonth,
    totalSpentCents, // everything spent on plates ever
  };
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return false;
  }
}
