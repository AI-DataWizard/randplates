// main.js — bootstrap: data load, db init, hash router, view rendering, worker wiring,
// SW registration. The UI layer subscribes to the store and renders (PRD §10 rule 1).

import { store } from "./modules/store.js";
import * as db from "./modules/db.js";
import { searchIngredients, normalize } from "./modules/search.js";
import {
  normalizeTitle,
  prepareRecipe,
  findDuplicates,
} from "./modules/dedupe.js";
import { quickTryPicks } from "./modules/coverage.js";
import { formatRands } from "./modules/costing.js";
import { THEMES } from "./modules/themeData.js";
import {
  defaultPrice,
  ingredientCostCents,
  rescaleRecipe,
  perPlateCents,
  costRecipe,
  qtyInPackBasis,
  qtyFromGrams,
  PIECE_WEIGHTS_G,
  packBandTable,
  PRICED_UNITS,
} from "./modules/costing.js";
import {
  rankRecipes,
  scorePayload,
  mealIntentFor,
  unlockInsights,
  pantryHas,
  autoRunningLow,
  mergeUserRecipes,
  STAPLE_TIER_MAX,
  maxCookableServings,
} from "./modules/matcher.js";
import {
  planWeek,
  shoppingListToText,
  dayOptions,
  applyPick,
} from "./modules/planner.js";
import {
  decodeRecipeText,
  draftToRecipe,
  UNIT_CANON,
  confidenceV2,
  confBand,
  CONF_TIERS,
} from "./modules/decoder.js";
import {
  extractCandidate,
  buildReport,
  applyHandled,
  GENERIC_HEAD_SET,
} from "./modules/gapreport.js";
import { buildPlanPdf, planPdfName } from "./modules/pdf.js";
import { PDF_TOKENS } from "./modules/pdfTokens.js";
import { serializePantry, validatePantryImport } from "./modules/backup.js";
import {
  getAchievementStats,
  localDateStr,
  heatByDate,
  xpForCook,
  titleForLevel,
  newlyEarned,
} from "./modules/achievements.js";
import { buildRecipeIndex, searchRecipes } from "./modules/recipeSearch.js";
import {
  passesFilters as rowPasses,
  countFor as facetCount,
  deadEndAdvice,
  FILTER_DEFS,
} from "./modules/matchFilters.js";
import {
  shelfWord,
  packSizeLabel,
  packLabel,
  badgeWord,
  packsCount,
  stepSizeFor as stepForBasis,
  pantryBasis,
  expiringThisWeek,
  expiryEstimate as expiryEstimateOf,
  useSoonInfo as useSoonInfoOf,
  pantryStatusOf as pantryStatusOfMeta,
} from "./modules/pantryMath.js";

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
function trimQty(n) {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

let worker = null;
try {
  worker = new Worker("js/workers/matcher.worker.js", { type: "module" });
} catch {
  worker = null;
}

// ---------------- bootstrap ----------------

async function boot() {
  // load static data (network-first via SW; data is sample-grade until Phase 0)
  const [ingRes, priceRes, recRes] = await Promise.all([
    fetch("data/ingredients.json").then((r) => r.json()),
    fetch("data/prices.json").then((r) => r.json()),
    fetch("data/recipes.json").then((r) => r.json()),
  ]);
  store.set({
    ingredients: ingRes.items,
    prices: priceRes.entries,
    recipes: recRes.recipes,
    priceMeta: {
      last_verified: priceRes.last_verified,
      version: priceRes.version,
    },
  });
  rebuildRecipeIndex(); // P-537: search index rides the data load

  // hydrate user state from IndexedDB (db is the persistence layer, store the live copy)
  const [pantryRaw, cookLog, savedRecipes, savedPlansRaw] = await Promise.all([
    db.getAll("pantry"),
    db.getAll("cook_log"),
    db.getAll("saved_recipes"),
    db.getAll("saved_plans"),
  ]);
  // P-112: running_low is DERIVED, so the very first paint after boot must be
  // enriched too — otherwise reloads show stale flags until the next edit.
  const { ingredients } = store.get();
  const bootLow = autoRunningLow(pantryRaw, ingredients, priceOf);
  const pantry = pantryRaw.map((p) => ({
    ...p,
    running_low: bootLow.has(p.id),
  }));
  // P-565 BUG FIX: decoded/saved recipes rejoin the matcher pool at boot —
  // before this, a reload silently dropped them from matcher + planner until
  // the user re-saved (the in-session save paths merged, boot did not).
  const mergedRecipes = mergeUserRecipes(store.get().recipes, savedRecipes);
  store.set({
    pantry,
    cookLog,
    savedRecipes,
    savedPlans: savedPlansRaw,
    recipes: mergedRecipes,
    ready: true,
  });
  rebuildRecipeIndex(); // index now sees the merged pool, corpus + user saves

  const settings = db.getSettings();
  if (settings.budgetCents) {
    store.update("matcher", { budgetCents: settings.budgetCents });
    // P-545 FIX: the planner dial also follows the persisted weekly default —
    // before this, a reload reset the dial to R600 even when the user had set
    // R250 in Settings (found by the P-545 verification contract 7).
    store.update("planner", { weekBudgetCents: settings.budgetCents });
  }
  // P-104T: restore meal choice ('' = Anything, null = never chosen -> auto from the clock) + favourites
  if (settings.mealChoice !== undefined)
    store.update("matcher", { mealChoice: settings.mealChoice });
  store.update("matcher", {
    favouriteIds: Array.isArray(settings.favouriteIds)
      ? settings.favouriteIds
      : [],
  });
  // P-111: restore the persisted filter bar state (tune panel)
  if (settings.matcherFilters && typeof settings.matcherFilters === "object") {
    const f = settings.matcherFilters;
    store.update("matcher", {
      plateMaxCents: Number.isFinite(f.plateMaxCents) ? f.plateMaxCents : null,
      tier: ["all", "ready", "almost", "stretch"].includes(f.tier)
        ? f.tier
        : "all",
      maxMissing:
        f.maxMissing == null ? null : Math.max(0, parseInt(f.maxMissing, 10)),
      tagFilter: Array.isArray(f.tagFilter) ? f.tagFilter : [],
      favouritesOnly: !!f.favouritesOnly,
      sortMode: ["match", "cheap", "fast", "fewest"].includes(f.sortMode)
        ? f.sortMode
        : "match",
      dietary: f.dietary || null,
      maxTimeMin: f.maxTimeMin || null,
    });
  }

  // P-545 SETTINGS PERSONALIZATION — boot defaults. Explicit matcher filter
  // choices (matcherFilters) still win over these; defaults apply on fresh
  // profiles so a vegetarian never sees meat on first open.
  applyDisplayPrefs();
  const prof = profileOf();
  const s545 = db.getSettings();
  if (!s545.matcherFilters && s545.plateCeilCents != null) {
    // untouched tune panel: seed ceiling
    store.update("matcher", { plateMaxCents: s545.plateCeilCents });
  }
  const bootServings =
    Number.isFinite(prof.defaultServings) && prof.defaultServings > 0
      ? Math.min(12, Math.round(prof.defaultServings))
      : Number.isFinite(prof.household) && prof.household > 0
        ? Math.min(12, Math.round(prof.household))
        : 2;
  store.update("planner", { servings: bootServings });
  if (Number.isFinite(prof.household) && prof.household > 0) {
    store.update("planner", {
      household: Math.min(12, Math.round(prof.household)),
    });
  }

  // P-557: 'Follow system' mode tracks the OS color scheme live
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      if ((db.getSettings().display || {}).mode === "auto") applyDisplayPrefs();
    });

  // P-412 Pulse: aggregate usage counters, localStorage-only, never transmitted.
  const PULSE_KEY = "randplates-pulse-v1";
  const pulseRead = () => {
    try {
      return JSON.parse(localStorage.getItem(PULSE_KEY)) || {};
    } catch {
      return {};
    }
  };
  window.__pulseRead = pulseRead;
  window.__pulseBump = (k) => {
    const p = pulseRead();
    p[k] = (p[k] || 0) + 1;
    try {
      localStorage.setItem(PULSE_KEY, JSON.stringify(p));
    } catch {}
  };

  // SW registration (skipped on file:// where workers/modules also break)
  // Publish the real sticky-header height so sticky panels never guess (Fan Zone lesson).
  const setStickyOffset = () => {
    const h = $(".topbar")?.getBoundingClientRect().height || 0;
    document.documentElement.style.setProperty(
      "--sticky-offset",
      `${Math.round(h)}px`,
    );
  };
  setStickyOffset();
  window.addEventListener("resize", setStickyOffset);
  const isLocalDev = ["localhost", "127.0.0.1", "[::1]"].includes(
    location.hostname,
  );
  if (isLocalDev && "serviceWorker" in navigator) {
    // DEV: never serve a stale shell while building. Unregister + purge caches.
    navigator.serviceWorker
      .getRegistrations()
      .then((rs) => rs.forEach((r) => r.unregister()));
    if (window.caches)
      caches.keys().then((ks) => ks.forEach((k) => caches.delete(k)));
  } else if (
    "serviceWorker" in navigator &&
    location.protocol.startsWith("http")
  ) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  // P-311 FIX (caught while shooting the post #3 asset): the flag element had
  // teaching copy but NO wiring — nothing toggled its .on class on the online/offline
  // events, so the indicator had never actually displayed. The harness read its
  // text (works on hidden elements) and passed a dead flag. Now the class is
  // synced on boot and on both events.
  const $offlineFlag = $("#offline-flag");
  const syncOfflineFlag = () => {
    $offlineFlag.classList.toggle("on", !store.get().online);
    setStickyOffset(); // P-603: flag toggles can change topbar height -> re-measure so scroll offsets stay true
  };
  window.addEventListener("online", () => {
    store.set({ online: true });
    syncOfflineFlag();
  });
  window.addEventListener("offline", () => {
    store.set({ online: false });
    syncOfflineFlag();
  });
  store.set({ online: navigator.onLine });
  syncOfflineFlag();

  // ---- P-311: installability ----
  // POLICY (documented per the sprint spec):
  //   • standalone display (already installed) → the button NEVER renders.
  //   • the user dismisses the native prompt / the A2HS sheet → a 7-day
  //     cooldown is stamped; no nag, no re-show inside the window.
  //   • install completes → appinstalled hides the button for good.
  //   • Android/desktop: the button appears only on the browser's own
  //     beforeinstallprompt signal (we never beg before Chrome says yes).
  //   • iOS: no signal exists, so the button opens the teaching sheet
  //     instead of a native prompt.
  const INSTALL_KEY = "rp-install-dismissed-at";
  const INSTALL_COOLDOWN_MS = 7 * 864e5;
  const isStandalone = () =>
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches ||
    navigator.standalone === true;
  const isIOS = () =>
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); // iPadOS pretends to be a Mac
  const inCooldown = () => {
    const t = Number(localStorage.getItem(INSTALL_KEY));
    return Number.isFinite(t) && Date.now() - t < INSTALL_COOLDOWN_MS;
  };
  const $installBtn = $("#install-btn");
  const $a2hs = $("#a2hs-sheet");
  let deferredPrompt = null;

  const showInstallBtn = () => {
    if (isStandalone() || inCooldown()) return;
    if (deferredPrompt || isIOS()) {
      $installBtn.hidden = false;
    }
  };
  const dismissInstall = () => {
    localStorage.setItem(INSTALL_KEY, String(Date.now()));
    $installBtn.hidden = true;
  };

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // we render our own button, on our terms
    deferredPrompt = e;
    showInstallBtn();
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    $installBtn.hidden = true;
    toast("RandPlates installed 🎉 — check your home screen");
  });

  $installBtn.addEventListener("click", async () => {
    if (deferredPrompt) {
      const { outcome } = await deferredPrompt.prompt();
      deferredPrompt = null;
      if (outcome === "accepted") $installBtn.hidden = true;
      else dismissInstall(); // a "no" is respected for 7 days
    } else if (isIOS()) {
      $a2hs.showModal(); // iOS: teach, then respect the close
    }
  });
  $a2hs.querySelector("#a2hs-close").addEventListener("click", () => {
    $a2hs.close();
    dismissInstall(); // closing the sheet = heard it once
  });
  showInstallBtn(); // P-311 boot pass: iOS has no install signal to wait for —
  // the teaching affordance must appear on its own (desktop
  // stays hidden until beforeinstallprompt says otherwise).

  // router
  const route = () => {
    const view = (location.hash.replace("#", "") || "home").split("?")[0];
    const known = [
      "home",
      "pantry",
      "matcher",
      "planner",
      "explorer",
      "cooklog",
      "decoder",
      "settings",
    ];
    const target = known.includes(view) ? view : "home";
    // P-406: honest per-route titles — crawlers get the static prices.html
    // split-out; users get the right tab title on every view.
    const TITLES = {
      explorer: "Cheap Meal Plan South Africa - Real Prices | RandPlates",
    };
    // P-532 SEO: per-view title + meta description, keyword-mapped to SA
    // dinner-planning intent. No live-price claims (P-519 contract).
    const META = {
      home: [
        "RandPlates — cheap dinner ideas for South Africa, planned by rands",
        "Tell RandPlates your kitchen and budget; get meals you can cook tonight and a priced weekly plan. Works offline, free.",
      ],
      pantry: [
        "My Pantry — stock your kitchen | RandPlates",
        "Add what you have — English or vernacular — and RandPlates prices every recipe you can make from it.",
      ],
      matcher: [
        "What can I cook tonight? — the Matcher | RandPlates",
        "Match %, missing items priced, true cost per plate. Cheap dinner ideas from what you already own.",
      ],
      planner: [
        "Meal plan on a budget — the weekly Planner | RandPlates",
        "A week of dinners inside your budget with one aisle-sorted, priced shopping list. Plans offline.",
      ],
      explorer: [
        "Cheap Meal Plan South Africa - Real Prices | RandPlates",
        "Real South African shelf prices with freshness dates — check any ingredient before the shops.",
      ],
      cooklog: [
        "My Cook Log — history, streaks, real costs | RandPlates",
        "Every cook priced and remembered. Your cooking history stays on your phone.",
      ],
      decoder: [
        "Recipe Decoder — paste any recipe, get it priced | RandPlates",
        "Paste a WhatsApp forward or blog recipe; get ingredients, steps and a per-plate rand cost.",
      ],
      settings: [
        "Settings & About | RandPlates",
        "Export, import or erase your data — and meet the builder. Your data never leaves your phone.",
      ],
    };
    document.title =
      TITLES[target] ||
      META[target]?.[0] ||
      "RandPlates - dinner, planned by rands";
    const md = document.querySelector('meta[name="description"]');
    if (md && META[target]) md.setAttribute("content", META[target][1]);
    store.set({ view: target });
    $$("#nav a").forEach((a) =>
      a.classList.toggle("active", a.dataset.view === target),
    );
    $$(".view").forEach((v) => (v.hidden = v.id !== `view-${target}`));
    if (target === "pantry") renderPantry();
    if (target === "matcher") runMatcher();
    if (target === "planner") renderPlanner();
    if (target === "settings") renderPulse();
    if (target === "explorer") renderExplorer();
    if (target === "cooklog") renderCookLog();
    if (target === "decoder") renderGapReport();
    if (target === "decoder") renderDecodedLibrary(); // P-448
    if (target === "home") renderHome();
    window.scrollTo({ top: 0 });
  };
  window.addEventListener("hashchange", route);

  wireGlobalEvents();
  wireMatcherSearch(); // P-537: search bar lives with the matcher events
  wireOutsideClose($("#ing-modal")); // P-537 UX: tap-outside closes, swipe never does
  wireOutsideClose($("#mp-detail"));
  route();
  primeBadgeSnapshot(); // P-561: baseline AFTER first render — nothing earned at boot ever celebrates
}

// ---------------- helpers ----------------

// P-202: defaultPrice filtered the whole prices array on EVERY line lookup;
// a 179-recipe re-rank made ~1,200 of those. Cache a by-id map, invalidated by
// array identity (prices load once at boot; backup import replaces the array).
let __priceSrc = null,
  __priceMap = null;
const priceOf = (id) => {
  const src = store.get().prices;
  if (src !== __priceSrc) {
    __priceSrc = src;
    __priceMap = {};
    for (const e of src) (__priceMap[e.ingredient_id] ||= []).push(e);
  }
  return defaultPrice(id, __priceMap[id] || []);
};
// P-567d #2: the line-aware picker needs the FULL row pool per id.
const rowsOf = (id) => {
  priceOf(id);
  return __priceMap[id] || [];
};

/* P-537: precomputed recipe search index — built once per data load and after
 * recipe mutations, NEVER per keystroke (spec: instant at 400+ recipes). */
let recipeIndex = null;
function rebuildRecipeIndex() {
  const { recipes } = store.get();
  recipeIndex = buildRecipeIndex(recipes || [], (id) => ingredientMeta(id));
}

function ingredientMeta(id) {
  return store.get().ingredients.find((i) => i.id === id);
}

// "Usually bought as 2 kg" — secondary line shown instead of vernacular aliases.
// Registry stores g/ml/unit/bunch/can; display converts to the unit a shopper reads.
/* P-534 shelf words: how a SA shopper says the pack. Deterministic, documented
   real shelf forms. Aisle rule + id overrides; ids NOT here render wordless
   ("1 x 500 g") which is honest rather than guessed. New registry items must
   add their word here at merge time (P-515 checklist). */

// Human aisle names. Registry ids stay kebab-case; the UI never shows them raw.
const AISLE_LABELS = {
  starches: "Starches & grains",
  "protein-fresh": "Fresh meat & fish",
  "protein-tinned": "Tinned protein",
  dairy: "Dairy & eggs",
  veg: "Vegetables",
  fruit: "Fruit",
  spices: "Spices & seasoning",
  pantry: "Pantry staples",
  frozen: "Frozen",
  other: "Other",
};
const aisleLabel = (a) => AISLE_LABELS[a] || a;

// ---------------- P-402: badge unlock celebration ----------------
// A body-level sticker burst (the P-311 lesson: never mount overlays inside a
// hidden view). Multiple simultaneous unlocks stack inside one panel. The
// motion is pure CSS and switches OFF under prefers-reduced-motion.
let __burstT = null;
function celebrateBadges(badges) {
  const $burst = $("#unlock-burst");
  if (!$burst) return;
  $burst.innerHTML = badges
    .map(
      (b, i) => `
    <div class="ub-badge" style="--tilt:${i % 2 ? 2.5 : -2.5}deg; animation-delay:${i * 0.18}s">
      <span class="medal" aria-hidden="true">${b.icon}</span>
      <div><strong>${esc(b.name)}</strong><span>${esc(b.line)}</span></div>
    </div>`,
    )
    .join("");
  $burst.hidden = false;
  $burst.classList.add("on");
  clearTimeout(__burstT);
  __burstT = setTimeout(() => {
    $burst.classList.remove("on");
    $burst.hidden = true;
  }, 4600);
}

// P-411 (owner report, mobile): consecutive events used to CLOBBER each other —
// "Logged to cook log" vanished the moment the achievement toast fired, because
// both wrote into ONE #toast element. Toasts now STACK: #toast is the fixed
// container, each toast() is its own .toast-item with an independent timer.
// Max 3 visible — a 4th drops the oldest — so a burst can't wall off the screen.
function toast(message, undoFn = null, ms = 4000) {
  let host = $("#toast");
  if (!host) {
    // P-540 hardening: a stripped/broken DOM never silences toasts
    host = document.createElement("div");
    host.id = "toast";
    host.setAttribute("role", "status");
    host.setAttribute("aria-live", "polite");
    document.body.appendChild(host);
    console.warn("[toast] #toast host was missing — recreated it.");
  }
  // P-411b: only ONE undo toast may live at a time — a second undo action
  // invalidates the first's context (draft snapshots). Supersede: instantly
  // retire older undo toasts so their buttons/ids can never collide.
  if (undoFn)
    host.querySelectorAll(".toast-item .toast-undo").forEach((b) => {
      const it = b.closest(".toast-item");
      if (!it) return;
      it.classList.remove("show");
      setTimeout(() => it.remove(), 400);
    });
  while (host.children.length >= 3) {
    const old = host.firstElementChild;
    old.remove();
  }
  const el = document.createElement("div");
  el.className = "toast-item";
  el.innerHTML =
    esc(message) +
    (undoFn
      ? ' <button type="button" id="toast-undo" class="toast-undo">Undo</button>'
      : "");
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show")); // transition runs from laid-out state
  let gone = false;
  const hide = () => {
    if (gone) return;
    gone = true;
    el.classList.remove("show");
    setTimeout(() => el.remove(), 400); // let the slide-out finish; reduced-motion makes it instant
  };
  setTimeout(hide, ms);
  const undo = el.querySelector(".toast-undo");
  if (undo)
    undo.onclick = () => {
      hide();
      undoFn();
    };
}

// ---- P-561: Phase 4/5 achievement context + ONE unlock chokepoint ----
// Badges now watch more than the cook log: decoder drafts, themes tried,
// pantry state and saved plans. achievementCtx() gathers those signals;
// checkBadgeUnlocks() diffs the badge set against the last snapshot and
// celebrates anything new. Snapshot-diffing makes it idempotent — every
// caller can fire it freely and a badge celebrates exactly once.
const STAPLE_IDS = [
  "cooking-oil",
  "table-salt",
  "black-pepper",
  "white-sugar",
  "stock-cubes",
  "curry-powder",
  "chicken-spice",
  "tomato-sauce",
];

function achievementCtx() {
  const { pantry, savedRecipes, savedPlans, ingredients } = store.get();
  const aisleSet = new Set();
  for (const p of pantry || [])
    aisleSet.add(ingredientMeta(p.id)?.aisle || "other");
  const have = new Set((pantry || []).map((p) => p.id));
  return {
    pantryCount: (pantry || []).length,
    pantryAisles: aisleSet.size,
    staplesOwned: STAPLE_IDS.filter((id) => have.has(id)).length,
    decodedCount: (savedRecipes || []).length,
    decodedIds: (savedRecipes || []).map((r) => r.id),
    themesTried: (db.getSettings().display?.themesTried || []).length,
    savedPlansCount: (savedPlans || []).length,
  };
}

let lastStatsSnapshot = null;
function primeBadgeSnapshot() {
  lastStatsSnapshot = getAchievementStats(
    store.get().cookLog,
    achievementCtx(),
  );
}

function checkBadgeUnlocks() {
  const stats = getAchievementStats(store.get().cookLog, achievementCtx());
  if (!lastStatsSnapshot) {
    lastStatsSnapshot = stats;
    return;
  }
  const fresh = newlyEarned(lastStatsSnapshot, stats);
  if (fresh.length) celebrateBadges(fresh);
  if (stats.level > lastStatsSnapshot.level)
    toast(`⭐ LEVEL ${stats.level}: ${stats.levelTitle}!`, null, 6000);
  lastStatsSnapshot = stats;
}

async function refreshPantry({ silent = false } = {}) {
  const rows = await db.getAll("pantry");
  // AUTO RUNNING-LOW (P-112/P-113a): computed from what the user actually has —
  // never a manual toggle. Every pantry consumer (list, chips, counter,
  // matcher freshness, exports) reads this enriched copy. P-113a: `silent`
  // skips the repaint — stepper ticks update the store ~9×/s and must not
  // rebuild the DOM mid-gesture (that destroyed the held button and spawned
  // immortal zombie intervals). Callers that end a gesture pass no flag.
  const { ingredients } = store.get();
  const low = autoRunningLow(rows, ingredients, priceOf);
  store.set({
    pantry: rows.map((p) => ({ ...p, running_low: low.has(p.id) })),
  });
  checkBadgeUnlocks(); // P-561: fully-stocked / aisle / staple badges fire on add
  if (!silent) renderPantry();
}

// ---------------- HOME ----------------

// P-407: scroll motion is feedback, not decoration — under prefers-reduced-motion
// every scroll lands instantly (PRD 6 motion doctrine, CP-4).
function motionBehavior() {
  // P-545: manual override wins — 'off' always snaps, 'on' always glides,
  // 'auto' (default) follows the device's reduced-motion preference.
  const pref = db.getSettings().display?.motion || "auto";
  if (pref === "off") return "auto";
  if (pref === "on") return "smooth";
  return window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}

function renderHome() {
  $("#home-price-stamp").textContent =
    store.get().priceMeta.last_verified || "—";
  const mpStamp = $("#matcher-price-stamp"); // P-310: matcher carries the price stamp too
  if (mpStamp) mpStamp.textContent = store.get().priceMeta.last_verified || "—";
  const { ingredients, recipes } = store.get();

  // P-530 HERO NUMBER — real, live, never hardcoded: the cheapest per-plate
  // dinner in the corpus on a buy-everything basis (full-priced basket).
  // Costs come from the same priceOf pipeline the matcher uses, so the hero
  // can never disagree with the app. Recipes with unpriced lines are only
  // counted when everything in them prices; honesty over reach.
  let minPlate = Infinity;
  for (const r of recipes) {
    // P-521 audit fix (Oct 27, veto-flagged): the hero claims "dinners" but
    // was counting EVERY recipe — meringues (a dessert) set R16.50. The hero
    // now uses the planner's own dinner-fit gate (P-522 ruling: dinners
    // only, desserts never). New hero: cheapest dinner-fit fully-priced plate.
    if (
      !Array.isArray(r.tags) ||
      !r.tags.includes("dinner") ||
      r.tags.includes("dessert")
    )
      continue;
    const { totalCents, unpriced } = costRecipe(r, priceOf, rowsOf); // P-567d line-aware picker
    if (unpriced > 0 || totalCents <= 0) continue;
    const pp = perPlateCents(totalCents, r.servings);
    if (pp > 0 && pp < minPlate) minPlate = pp;
  }
  const heroNum = $("#home-hero-number");
  if (heroNum)
    heroNum.textContent =
      minPlate === Infinity ? "R—/plate" : `${formatRands(minPlate)}/plate`;

  // P-530 FAST LANE — the quicktry matcher is GONE from home (owner pick).
  // Its one good idea survives: coverage-derived starter chips (P-111
  // doctrine) that now write to the REAL pantry via the same db path the
  // Pantry view uses, then point you at the real Matcher for results.
  const { chips } = quickTryPicks(ingredients, recipes, {
    minTier: STAPLE_TIER_MAX,
  });
  const pantryIds = new Set(store.get().pantry.map((p) => p.id));
  const flc = $("#fl-chips");
  flc.innerHTML = chips
    .map((c) => {
      const meta = ingredients.find((i) => i.id === c.id);
      return `<button type="button" class="qt-chip ${pantryIds.has(c.id) ? "on" : ""}" data-id="${c.id}" aria-label="Add ${esc(meta?.name || c.id)} to pantry">${esc(meta?.name || c.id)}</button>`;
    })
    .join("");
  $$(".qt-chip", flc).forEach(
    (btn) =>
      (btn.onclick = async () => {
        const id = btn.dataset.id;
        if (pantryIds.has(id)) return; // already in the kitchen — no double-write
        const basis = ingredientMeta(id).unit_basis;
        await db.putPantryItem({
          id,
          qty: basis.qty,
          unit: basis.unit,
          running_low: false,
        });
        await refreshPantry();
        pantryIds.add(id);
        btn.classList.add("on");
        const hint = $("#fl-hint");
        if (hint)
          hint.textContent =
            'In your pantry for real. Now tap "Show me dinners" — your matches are already live.';
        toast(`Added ${esc(ingredientMeta(id).name)} to your pantry`);
      }),
  );

  // How-it-works card: scroll the fast lane into view BELOW the sticky chrome
  // (measured offset pattern — standing UX rule; never pin content under the bar).
  const guide = $("#cta-guide");
  if (guide) guide.onclick = () => goGuide("guide");
  renderGuidedDemo();
}

// ---- P-531: deep-link into the site guide (scroll-offset pattern, standing UX rule) ----
function goGuide(anchorId) {
  const scrollIn = () => {
    const el = document.getElementById(anchorId) || $("#guide");
    if (!el) return;
    const chromeH = $(".topbar")?.getBoundingClientRect().height || 64;
    window.scrollTo({
      top: el.getBoundingClientRect().top + window.scrollY - chromeH - 12,
      behavior: motionBehavior(),
    });
  };
  if (store.get().view !== "home") location.hash = "#home"; // hashchange scrolls to top; we scroll after
  // wait a tick either way so the home render (and any hashchange top-scroll) settles first
  setTimeout(scrollIn, store.get().view === "home" ? 0 : 120);
}

/* ---- P-531 GUIDED DEMO — one scripted fake-session the user taps through.
   Doctrine: experiential over aggregation. The demo runs the REAL engine on a
   sample kitchen (rankRecipes + matcherCtx + real priceOf) but writes NOTHING:
   the sample pantry lives only inside this closure. Numbers shown are real
   computations, never typed-in theatre. Manual "Next" button per the
   manual-trigger doctrine. */
function renderGuidedDemo() {
  const demo = $("#guided-demo");
  if (!demo) return;
  const { ingredients, recipes } = store.get();
  // Sample kitchen: exactly what "Pap and Eggs" needs + one extra — real ids,
  // real pack basis from the registry.
  const SAMPLE = ["maize-meal", "eggs", "onions", "tomatoes"];
  const samplePantry = SAMPLE.map((id) => {
    const meta = ingredients.find((i) => i.id === id);
    const basis = meta?.unit_basis || { qty: 1, unit: "unit" };
    return { id, qty: basis.qty, unit: basis.unit, running_low: false };
  }).filter((p) => ingredients.some((i) => i.id === p.id));
  const results = rankRecipes(
    recipes,
    matcherCtx(samplePantry, 60000, {}),
  ).filter((r) => r.eligible);
  const top = results.slice(0, 2);
  // slip source: the first top match that actually has missing items (most
  // realistic "what the shops will cost"); if fully stocked, the R0 honesty line.
  const slipSrc = top.find((r) => r.missing?.length) || top[0] || results[0];

  const stageEls = {
    1: () => `
      <p class="demo-note">Stage 1 — a sample kitchen: ${samplePantry.length} things you might own.</p>
      <div class="demo-pantry">${samplePantry
        .map((p) => {
          const meta = ingredients.find((i) => i.id === p.id);
          return `<span class="qt-chip on">${esc(meta?.name || p.id)}</span>`;
        })
        .join("")}</div>
      <p class="demo-note">In the real Pantry you'd search for these and tap once each. Prices attach automatically.</p>`,
    2: () => `
      <p class="demo-note">Stage 2 — the Matcher ranks what those 4 things cook tonight:</p>
      ${top
        .map(
          (r) => `
        <div class="missing-line"><span>🍽️ ${esc(r.title)} <span class="pct">${r.matchPct}%</span></span>
        <span class="price money money--sm">${formatRands(r.perPlateCents)}/plate</span></div>`,
        )
        .join("")}
      <p class="demo-note">Match % = how much of the recipe you already own. The per-plate price is what it costs from scratch — your real pantry shaves it.</p>`,
    3: () => {
      const lines = slipSrc?.missing || [];
      if (!lines.length)
        return `
        <p class="demo-note">Stage 3 — the till slip: nothing missing tonight.</p>
        <div class="slip"><div class="slip-head"><span class="slip-brand">RANDPLATES</span><span class="slip-sub">${esc(slipSrc?.title || "")}</span></div>
        <div class="shop-line"><span class="n">Nothing to buy</span><span class="money">R0.00</span></div>
        <div class="shop-line total-line"><span class="n">TOTAL EXTRA</span><span class="money">R0.00</span></div></div>
        <p class="demo-note">Fully stocked dinners cost R0 extra — the matcher found that for free.</p>`;
      const total = lines.reduce((s, m) => s + (m.priceCents || 0), 0);
      return `
        <p class="demo-note">Stage 3 — the priced till slip for ${esc(slipSrc.title)}'s missing items:</p>
        <div class="slip"><div class="slip-head"><span class="slip-brand">RANDPLATES</span><span class="slip-sub">MISSING ITEMS · ${esc(slipSrc.title).toUpperCase()}</span></div>
        ${lines.map((m) => `<div class="shop-line"><span class="n">${esc(m.name)}</span><span class="money">${m.unpriced ? "unpriced" : formatRands(m.priceCents)}</span></div>`).join("")}
        <div class="shop-line total-line"><span class="n">TOTAL EXTRA</span><span class="money">${formatRands(total)}</span></div></div>
        <p class="demo-note">Real shelf prices, top-up amounts only — never re-buys what you have. This was the demo; your real session starts in the Pantry.</p>`;
    },
  };
  const LAST = 3;
  const paint = (stage) => {
    demo.dataset.stage = stage;
    $("#gd-stage").innerHTML = stageEls[stage]();
    $("#gd-count").textContent = `${stage} / ${LAST}`;
    $("#gd-next").textContent = stage === LAST ? "Start for real →" : "Next →";
  };
  let stage = 1;
  paint(stage);
  $("#gd-next").onclick = () => {
    if (stage >= LAST) {
      goGuide("guide");
      setTimeout(() => {
        stage = 1;
        paint(1);
      }, 600);
      location.hash = "#pantry";
      toast("Demo over — this one counts. Build your real pantry.");
      return;
    }
    paint(++stage);
  };
}

// ---------------- PANTRY ----------------

// ---- Pantry qty steppers (P-102) ----
// Unit-aware step sizes: grams/ml step in realistic kitchen amounts, counts step by 1.
/** P-534 pack-sensible step: a quarter of the usual buy in nice kitchen sizes
 *  (2 kg potatoes -> 500 g; 410 g tin -> 100 g; 50 g chillies -> 25 g).
 *  Count things (eggs, rolls, bunches) step by 1 — a person picks up one. */
const REPEAT_DELAY_MS = 400; // holding past this starts auto-repeat
const REPEAT_RATE_MS = 110;
const CLEAR_MS = 900; // long-press on MINUS clears qty to 0 (mobile)

// P-113a STEPPER REBUILD (owner bug report Oct 13: holding + on spinach
// "broke everything"). Root cause: refreshPantry() rendered the whole list on
// EVERY tick, so the held button was destroyed mid-gesture — its pointerup
// listener died with it, stop() never ran, and the repeat interval became an
// immortal zombie that kept writing to the DB (and re-rendering, feeding
// itself). New contract:
//   1. mid-gesture ticks update the store SILENTLY (refreshPantry {silent}),
//   2. gesture state lives in a Map keyed by ingredient id (not in the button
//      closure, which can die in a re-render),
//   3. release is caught by a once-only GLOBAL pointerup — works even if the
//      button (or the whole row) is replaced or the pointer leaves the list,
//   4. a zombie guard kills the timers if the row disappears mid-hold,
//   5. the list repaints ONCE at gesture end.
const stepState = new Map(); // ingredient id -> { repeatTimer, clearTimer, longFired, left }
let activeStepCleanup = null; // removes the global pointerup listener

async function setPantryQty(id, qty, { silent = true } = {}) {
  const item = store.get().pantry.find((p) => p.id === id);
  if (!item) return;
  await db.putPantryItem({ ...item, qty: Math.max(0, qty) });
  await refreshPantry({ silent }); // gesture ticks stay silent; renders happen at gesture end
}

/** P-534 unit-switch conversion authority — same constants the engine trusts,
 *  refuse-over-guess: unknown pairs return null and the row stays honest.
 *  g<->ml 1:1 (engine convention) · tin/can<->g/ml via the priced pack size ·
 *  unit/bunch<->g via PIECE_WEIGHTS_G. */
function convertPantryQty(id, from, to, qty) {
  if (from === to) return qty;
  const pack = defaultPrice(id, store.get().prices);
  const packQty = pack?.pack_qty || 0;
  const gPerPiece = PIECE_WEIGHTS_G[id] || 0;
  const isG = (u) => u === "g" || u === "ml";
  const isPack = (u) => u === "tin" || u === "can";
  if (isG(from) && isG(to)) return qty; // 1 ml ≈ 1 g convention
  if (isG(from) && isPack(to) && packQty > 0)
    return +(qty / packQty).toFixed(3) / 1; // 410 g -> 1 tin
  if (isPack(from) && isG(to) && packQty > 0)
    return +(qty * packQty).toFixed(3) / 1; // 2 tins -> 820 g
  if (isG(from) && (to === "unit" || to === "bunch") && gPerPiece > 0)
    return +(qty / gPerPiece).toFixed(2) / 1;
  if ((from === "unit" || from === "bunch") && isG(to) && gPerPiece > 0)
    return +(qty * gPerPiece).toFixed(1) / 1;
  return null;
}

/** One unit-aware step (or a clear). Updates the input instantly, persists silently.
 * `st` is the live gesture state for ticking holds (zombie guard); quick-taps
 * pass the state directly — the Map entry may already be gone by then. */
async function stepQty(
  id,
  isMinus,
  { clear = false, st = stepState.get(id) } = {},
) {
  const rowEl = $(`.pantry-item[data-id="${id}"]`);
  if (!rowEl) {
    if (st) killStepTimers(id);
    return;
  } // zombie guard: row gone → stop everything
  const input = $(".qty-input", rowEl);
  const item = store.get().pantry.find((p) => p.id === id);
  if (!item) {
    if (st) killStepTimers(id);
    return;
  }
  const unitSel = $(".unit-sel", rowEl).value;
  const step = stepSizeFor(id, unitSel); // adapter below: override-aware basis lookup

  /** P-536: adapter — basis comes from the pantry record's pack override first. */
  function stepSizeFor(id, unit) {
    const rec = store.get().pantry.find((p) => p.id === id);
    return stepForBasis(pantryBasis(rec, ingredientMeta(id)), unit);
  }
  const next = clear
    ? 0
    : Math.max(0, (parseFloat(input.value) || 0) + (isMinus ? -step : step));
  input.value = next;
  const packsEl = $(".pi-packs", rowEl);
  if (packsEl) packssBadge(packsEl, id, next, unitSel);
  await setPantryQty(id, next);
  return next;
}

/** P-534: "≈ 1.5 tins" — the pantry amount said the way the shopper thinks.
 *  Only shown when the entry unit matches the usual-buy unit (same-unit math,
 *  no cross-unit guessing); wordless items say "packs". */
/** badge word: shelf word first, else the basis unit's own word ("2 bunches"),
 *  else "packs" ("1.5 packs" — honest when the shelf form is a plain pack). */
function packsBadgeHtml(id, qty, unit) {
  const meta = ingredientMeta(id);
  const basis = pantryBasis(
    store.get().pantry.find((p) => p.id === id),
    meta,
  ); // P-535 override
  if (!basis || basis.unit !== unit) return "";
  return `<span class="pi-packs">≈ ${packsCount(qty, basis.qty)} ${badgeWord(meta, qty / basis.qty)}</span>`;
}
function packssBadge(el, id, qty, unit) {
  // live update during held steps (repaint catches up at gesture end)
  const meta = ingredientMeta(id);
  const basis = pantryBasis(
    store.get().pantry.find((p) => p.id === id),
    meta,
  ); // P-535 override
  if (!basis || basis.unit !== unit) {
    el.textContent = "";
    return;
  }
  el.textContent = `≈ ${packsCount(qty, basis.qty)} ${badgeWord(meta, qty / basis.qty)}`;
}

function killStepTimers(id) {
  const st = stepState.get(id);
  if (!st) return;
  clearTimeout(st.repeatTimer);
  clearInterval(st.repeatTimer);
  clearTimeout(st.clearTimer);
  stepState.delete(id);
  if (activeStepCleanup) {
    activeStepCleanup();
    activeStepCleanup = null;
  }
}

/** Gesture end: stop timers; a quick tap applies one final step + repaint. */
async function endStepGesture({ noStep = false } = {}) {
  const [id] = stepState.keys();
  if (!id) return;
  const st = stepState.get(id);
  clearTimeout(st.repeatTimer);
  clearInterval(st.repeatTimer);
  clearTimeout(st.clearTimer);
  stepState.delete(id);
  if (activeStepCleanup) {
    activeStepCleanup();
    activeStepCleanup = null;
  }
  const rowEl = $(`.pantry-item[data-id="${id}"]`);
  const quickTap = !noStep && !st.longFired && !st.left && rowEl;
  if (quickTap) await stepQty(id, st.isMinus, { st }); // single tap: apply one final step
  await refreshPantry(); // ONE repaint at gesture end: badge, chips, counter all catch up
}

function wireSteppers(list) {
  $$(".step-btn", list).forEach((btn) => {
    const isMinus = btn.dataset.dir === "minus";
    btn.addEventListener("pointerdown", () => {
      const id = btn.closest(".pantry-item").dataset.id;
      endStepGesture({ noStep: true }); // one gesture at a time
      const st = {
        repeatTimer: null,
        clearTimer: null,
        longFired: false,
        left: false,
        isMinus,
        startQty: store.get().pantry.find((p) => p.id === id)?.qty || 0,
      };
      stepState.set(id, st);
      st.repeatTimer = setTimeout(() => {
        st.repeatTimer = setInterval(
          () => stepQty(id, isMinus, { st }),
          REPEAT_RATE_MS,
        );
      }, REPEAT_DELAY_MS);
      if (isMinus)
        st.clearTimer = setTimeout(async () => {
          clearTimeout(st.repeatTimer);
          clearInterval(st.repeatTimer);
          st.repeatTimer = null;
          st.longFired = true;
          const prev = st.startQty; // qty from BEFORE the gesture — repeat ticks may have drained some already
          await stepQty(id, isMinus, { clear: true, st });
          toast(
            `Cleared ${esc(ingredientMeta(id)?.name || id)} — undo?`,
            async () => {
              await setPantryQty(id, prev, { silent: false }); // restore + repaint
              toast(`Back to ${prev} ✓`);
            },
          );
        }, CLEAR_MS);
      // release catch: global, once-only — survives button/row replacement and
      // pointers released outside the list (the old per-button listener didn't)
      activeStepCleanup?.();
      activeStepCleanup = () => {
        document.removeEventListener("pointerup", onGlobalUp);
        activeStepCleanup = null;
      };
      const onGlobalUp = () => endStepGesture({});
      document.addEventListener("pointerup", onGlobalUp, { once: true });
    });
    btn.addEventListener("pointerleave", () => {
      // drag off the button: stop the repeat, keep the gesture
      const id = btn.closest(".pantry-item").dataset.id;
      const st = stepState.get(id);
      if (!st) return;
      clearTimeout(st.repeatTimer);
      clearInterval(st.repeatTimer);
      clearTimeout(st.clearTimer);
      st.repeatTimer = null;
      st.left = true;
    });
    // P-108 keyboard support: Enter/Space steps once (same path as a single tap).
    // Hold-to-repeat and long-press-clear stay pointer-only; the undo toast covers mistakes.
    btn.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault(); // no double-fire: we own the action, click is not bound
      stepQty(btn.closest(".pantry-item").dataset.id, isMinus).then(() =>
        refreshPantry(),
      ); // keyboard: no live gesture
    });
  });
}

// Pantry list view state (P-104T): status chip + collapsed aisles survive re-renders.
const pantryView = { status: "all", aisle: null, collapsed: new Set() };

/** Pantry item status for the chips: low | soon | ok. */
function pantryStatusOf(p) {
  return pantryStatusOfMeta(p, ingredientMeta(p.id));
} // P-536: pure fn in modules/pantryMath.js
function useSoonInfo(p) {
  return useSoonInfoOf(p, ingredientMeta(p.id));
}
function expiryEstimate(p) {
  return expiryEstimateOf(p, ingredientMeta(p.id));
}
function expiringThisWeekP(p) {
  return expiringThisWeek(p);
} // real expiry dates only (pure fn)

function renderPantry() {
  if (!$("#pantry-search")) return;
  const { pantry, ingredients, recipes } = store.get();

  // ---- counter: now a two-part card (headline + stat pills) with ONE clear CTA.
  // P-104T: the old orange banner sat flush against the filter field and the sun-yellow
  // number sticker visually fought it. The counter is now self-contained and the filter
  // lives INSIDE the list panel below it, separated by real spacing.
  const results = rankRecipes(recipes, {
    pantry,
    ingredients,
    priceOf,
    rowsOf,
    remainingBudgetCents: 10_000_000,
    constraints: {},
  });
  const cookableNow = results.filter((r) => r.missing.length === 0).length;
  const almost = results.filter(
    (r) => r.missing.length > 0 && r.missing.length <= 2,
  ).length;
  const lowCount = pantry.filter((p) => p.running_low).length;
  $("#pantry-counter").innerHTML = `
    <div class="pc-copy">
      <div class="pc-eyebrow">Your kitchen right now</div>
      <strong class="pc-line">Can cook <span class="pc-num">${cookableNow}</span> of ${recipes.length} recipes</strong>
      <div class="pc-pills">
        <span class="pc-pill">${pantry.length} item${pantry.length === 1 ? "" : "s"}</span>
        <span class="pc-pill">${almost} one or two items away</span>
        ${lowCount ? `<span class="pc-pill pc-pill--warn">${lowCount} running low</span>` : ""}
      </div>
    </div>
    <a class="btn pc-cta" href="#matcher">See what to cook →</a>`;

  // ---- list
  const list = $("#pantry-list");
  const filterBar = $("#pantry-filterbar");
  const filterBox = $("#pantry-filter");
  const chipsBox = $("#pantry-chips");
  const tools = $("#pantry-viewtools");
  const big = pantry.length > 8;
  filterBar.hidden = !big;
  chipsBox.hidden = !big;
  tools.hidden = !big;
  if (!big) {
    pantryView.status = "all";
    if (filterBox) filterBox.value = "";
  }

  const filterText = (filterBox && filterBox.value ? filterBox.value : "")
    .trim()
    .toLowerCase();
  const matchesText = (p) => {
    if (!filterText) return true;
    const meta = ingredientMeta(p.id);
    const hay =
      `${meta?.name || ""} ${p.id} ${(meta?.aliases || []).join(" ")}`.toLowerCase();
    return hay.includes(filterText);
  };
  // P-535: unpriced = no price rows (standing rule keeps them out of matcher math)
  const hasPrice = (id) =>
    store.get().prices.some((pr) => pr.ingredient_id === id);
  const counts = { all: pantry.length, low: 0, soon: 0, week: 0, unpriced: 0 };
  for (const p of pantry) {
    // P-565: low and soon are INDEPENDENT lenses — quantity vs time. The old
    // exclusive model (soon beats low) made a low+soon item invisible to the
    // low count while the matcher sticker counted it: sticker 1, chip 0.
    if (p.running_low) counts.low++;
    if (useSoonInfo(p, ingredientMeta(p.id))) counts.soon++;
    if (expiringThisWeekP(p)) counts.week++;
    if (!hasPrice(p.id)) counts.unpriced++;
  }
  const matchesStatus = (p) =>
    pantryView.status === "all" ||
    (pantryView.status === "low"
      ? !!p.running_low
      : pantryView.status === "soon"
        ? !!useSoonInfo(p, ingredientMeta(p.id))
        : pantryView.status === "week"
          ? expiringThisWeekP(p)
          : !hasPrice(p.id));
  const matchesAisle = (p) =>
    !pantryView.aisle ||
    (ingredientMeta(p.id)?.aisle || "other") === pantryView.aisle;
  const shownPantry = pantry.filter(
    (p) => matchesText(p) && matchesStatus(p) && matchesAisle(p),
  );

  if (big) {
    chipsBox.innerHTML = [
      ["all", "All", counts.all],
      ["low", "Running low", counts.low],
      ["soon", "Use soon", counts.soon],
      ["week", "Expiring this week", counts.week],
      ["unpriced", "Unpriced", counts.unpriced],
    ]
      .map(
        ([k, label, n]) =>
          `<button type="button" class="pchip${pantryView.status === k ? " on" : ""}" data-status="${k}" aria-pressed="${pantryView.status === k}">${label} <span class="pchip-n">${n}</span></button>`,
      )
      .join("");
    $$(".pchip", chipsBox).forEach(
      (b) =>
        (b.onclick = () => {
          pantryView.status = b.dataset.status;
          renderPantry();
        }),
    );

    // P-535: aisle chips — same shape as the explorer, AND-composed with status + search
    const aisleCounts = {};
    for (const p of pantry) {
      const a = ingredientMeta(p.id)?.aisle || "other";
      aisleCounts[a] = (aisleCounts[a] || 0) + 1;
    }
    const aislesBox = $("#pantry-aisles");
    aislesBox.hidden = false;
    aislesBox.innerHTML = Object.entries(aisleCounts)
      .sort((a, b) => b[1] - a[1])
      .map(
        ([a, n]) =>
          `<button type="button" class="pchip pchip--aisle${pantryView.aisle === a ? " on" : ""}" data-aisle="${a}" aria-pressed="${pantryView.aisle === a}">${esc(aisleLabel(a))} <span class="pchip-n">${n}</span></button>`,
      )
      .join("");
    $$(".pchip", aislesBox).forEach(
      (b) =>
        (b.onclick = () => {
          pantryView.aisle =
            pantryView.aisle === b.dataset.aisle ? null : b.dataset.aisle;
          renderPantry();
        }),
    );
    $("#pantry-filter-count").textContent =
      filterText || pantryView.status !== "all" || pantryView.aisle
        ? `${shownPantry.length} of ${pantry.length}`
        : "";
  } else {
    pantryView.aisle = null;
    const aislesBox = $("#pantry-aisles");
    if (aislesBox) {
      aislesBox.hidden = true;
      aislesBox.innerHTML = "";
    }
  }

  // staples safety net: forgotten basics never block recipes, offer them once
  const COMMON_STAPLES = [
    "cooking-oil",
    "table-salt",
    "black-pepper",
    "white-sugar",
    "stock-cubes",
    "curry-powder",
    "chicken-spice",
    "tomato-sauce",
  ];
  const missingStaples =
    pantry.length >= 3
      ? COMMON_STAPLES.filter(
          (id) => !pantry.some((p) => p.id === id) && ingredientMeta(id),
        )
      : [];
  const staplesBanner = missingStaples.length
    ? `
    <div class="staples-banner" id="staples-banner">
      <div class="sb-copy"><strong>Quick check. Most kitchens have:</strong>
        <span class="sb-chips">${missingStaples.map((id) => `<span class="chip">${esc(ingredientMeta(id).name)}</span>`).join("")}</span>
        <span class="muted">You can still cook without them. RandPlates won't count these against a recipe.</span></div>
      <button type="button" class="btn" id="add-staples">Add ${missingStaples.length} staple${missingStaples.length === 1 ? "" : "s"}</button>
    </div>`
    : "";

  if (!pantry.length) {
    list.innerHTML = `<div class="empty" data-cp="pantry-empty"><span class="big">🧺</span>
      <strong>Add five basics – eggs, oil, rice, beans, tomato – and watch recipes appear.</strong><br>
      <button type="button" class="chip-link" data-guide="guide-pantry">show me how</button>
      <span class="muted">Search on the left. Try “pap”, “wors” or “morogo”. Real SA shelf prices do the rest.</span></div>`;
  } else {
    const aisles = {};
    for (const p of shownPantry) {
      const meta = ingredientMeta(p.id);
      (aisles[meta?.aisle || "other"] ||= []).push(p);
    }
    const searching = !!filterText || pantryView.status !== "all";
    const noMatchNote =
      searching && !shownPantry.length
        ? `<div class="empty"><span class="big">🔍</span>Nothing in your pantry matches that.<br><button type="button" class="ghost small section-gap" id="pantry-clear-filter">Clear filter</button></div>`
        : "";
    list.innerHTML =
      staplesBanner +
      noMatchNote +
      Object.entries(aisles)
        .map(([aisle, items]) => {
          // while searching, force-open groups so hits are never hidden inside a folded aisle
          const open = searching || !pantryView.collapsed.has(aisle);
          return `
      <details class="aisle-group" data-aisle="${aisle}" ${open ? "open" : ""}><summary class="aisle-h">${esc(aisleLabel(aisle))} <span class="aisle-count">${items.length}</span></summary>
        ${items
          .map((p) => {
            const meta = ingredientMeta(p.id);
            const dispName = esc(p.nickname || meta?.name || p.id);
            const name = esc(meta?.name || p.id);
            const soon = useSoonInfo(p);
            const basis = pantryBasis(p, meta); // P-535: user's own pack wins the hint
            // P-565: low and soon coexist on one row — they answer different
            // questions (buy more vs eat first). The old priority suppression is
            // gone so the row can never contradict the chip counts.
            return `<div class="pantry-item${p.running_low ? " is-low" : ""}${soon ? " is-soon" : ""}" data-id="${p.id}">
            <div class="pi-main" role="button" tabindex="0" aria-label="Open ${name} dossier" data-dossier="${p.id}">
              <div class="pi-line"><strong class="pi-name" title="${esc(dispName)}">${dispName}</strong>${p.nickname ? ` <span class="pi-nick-tag" title="your nickname">${esc(name)}</span>` : ""}${soon ? ` <span class="pi-tag" data-dossier="${p.id}" title="Why use-soon — open the dossier">use soon</span>` : ""}</div>
              <span class="pi-hint">${p.pack_override ? "You buy" : "Usually bought as"} ${esc(packLabel(basis, meta))}</span>
            </div>
            <div class="pi-controls">
              ${packsBadgeHtml(p.id, p.qty, p.unit)}
              <div class="stepper" data-id="${p.id}">
                <button type="button" class="step-btn" data-dir="minus" aria-label="Decrease ${name} (hold to repeat, long-press clears)">−</button>
                <input class="qty-input" type="number" min="0" step="0.5" value="${p.qty}" aria-label="${name} quantity">
                <button type="button" class="step-btn" data-dir="plus" aria-label="Increase ${name} (hold to repeat)">＋</button>
              </div>
              <select class="unit-sel" aria-label="${name} unit">
                ${["g", "ml", "unit", "tin", "can", "bunch", "slice"].map((u) => `<option ${u === p.unit ? "selected" : ""}>${u}</option>`).join("")}
              </select>
              <button type="button" class="pantry-remove" aria-label="Remove ${name}" title="Remove">✕</button>
            </div>
            ${
              p.running_low
                ? `<span class="low-pill low-pill--auto" title="Auto-detected: what's left no longer covers every recipe that uses this">Running low</span>`
                : ""
            }
          </div>`;
          })
          .join("")}
      </details>`;
        })
        .join("");

    // remember which aisles the user folded (survives re-render / adding items)
    $$("details.aisle-group", list).forEach((d) =>
      d.addEventListener("toggle", () => {
        if (searching) return;
        if (d.open) pantryView.collapsed.delete(d.dataset.aisle);
        else pantryView.collapsed.add(d.dataset.aisle);
      }),
    );
    $("#pantry-clear-filter")?.addEventListener("click", () => {
      filterBox.value = "";
      pantryView.status = "all";
      renderPantry();
    });

    // P-535: row body / use-soon tag -> ingredient dossier modal (one source of
    // truth with the explorer's tap — same openIngModal, two entry points).
    $$("[data-dossier]", list).forEach((el) => {
      el.addEventListener("click", () => {
        const ing = ingredientMeta(el.dataset.dossier);
        if (ing) openIngModal(ing);
      });
      el.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          const ing = ingredientMeta(el.dataset.dossier);
          if (ing) openIngModal(ing);
        }
      });
    });

    $$(".pantry-remove", list).forEach(
      (b) =>
        (b.onclick = async () => {
          const id = b.closest(".pantry-item").dataset.id;
          const old = store.get().pantry.find((p) => p.id === id);
          await db.remove("pantry", id);
          await refreshPantry();
          toast(
            `Removed ${ingredientMeta(id)?.name || id}. Undo?`,
            async () => {
              await db.putPantryItem(old);
              await refreshPantry();
              toast(`Back in the pantry ✓`);
            },
          );
        }),
    );
    wireSteppers(list);
    $$(".qty-input", list).forEach(
      (inp) =>
        (inp.onchange = async (e) => {
          const id = e.target.closest(".pantry-item").dataset.id;
          const item = store.get().pantry.find((p) => p.id === id);
          if (item)
            await db.putPantryItem({
              ...item,
              qty: parseFloat(e.target.value) || 0,
            });
          // P-112/P-113a: the auto running-low badge is qty-driven, so the list
          // repaints (refreshPantry renders) — but rebuilding the DOM must not
          // strand keyboard users.
          await refreshPantry();
          $(`.pantry-item[data-id="${id}"] .qty-input`)?.focus();
        }),
    );
    $$(".unit-sel", list).forEach(
      (sel) =>
        (sel.onchange = async (e) => {
          const id = e.target.closest(".pantry-item").dataset.id;
          const item = store.get().pantry.find((p) => p.id === id);
          if (item) {
            const to = e.target.value;
            const converted = convertPantryQty(id, item.unit, to, item.qty);
            if (converted !== null) {
              await db.putPantryItem({ ...item, unit: to, qty: converted });
              toast(
                `Now ${+converted.toFixed(2)} ${to} — same amount, measured the way you buy it`,
              );
            } else {
              await db.putPantryItem({ ...item, unit: to }); // no safe conversion — keep the number, say so
              toast(
                `No exact ${item.unit} → ${to} conversion for this one — check the amount`,
              );
            }
          }
          // unit changes can flip auto running-low (coverage is unit-aware) — same
          // repaint + focus-restore contract as qty edits.
          await refreshPantry();
          $(`.pantry-item[data-id="${id}"] .unit-sel`)?.focus();
        }),
    );
  }

  const addStaples = $("#add-staples");
  if (addStaples)
    addStaples.onclick = async () => {
      for (const id of missingStaples) {
        const meta = ingredientMeta(id);
        await db.putPantryItem({
          id,
          qty: meta.unit_basis.qty,
          unit: meta.unit_basis.unit,
          running_low: false,
        });
      }
      await refreshPantry();
      toast(`Added ${missingStaples.length} staples to your pantry ✓`);
    };
  if (filterBox && !filterBox.dataset.wired) {
    filterBox.dataset.wired = "1";
    filterBox.addEventListener("input", () => renderPantry());
    // Escape clears the filter: standard search-field behaviour
    filterBox.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        filterBox.value = "";
        renderPantry();
      }
    });
  }
  const expandAll = $("#pantry-expand-all"),
    collapseAll = $("#pantry-collapse-all");
  if (expandAll && !expandAll.dataset.wired) {
    expandAll.dataset.wired = "1";
    expandAll.onclick = () => {
      pantryView.collapsed.clear();
      renderPantry();
    };
    collapseAll.onclick = () => {
      $$("#pantry-list details.aisle-group").forEach((d) =>
        pantryView.collapsed.add(d.dataset.aisle),
      );
      renderPantry();
    };
  }
  renderPantrySuggestions($("#pantry-search").value);
}

function renderPantrySuggestions(query) {
  // P-562: the OLD panel showed a 12-item slice — one group deep and nothing
  // to explore. It is now the FULL browsable catalog: every not-in-pantry
  // registry item, grouped by aisle with counts, scrollable in place on
  // desktop (sticky panel scrolls itself) and naturally down the page on
  // mobile. Search narrows it; add-rows leave the list as they land in the
  // kitchen so the catalog and your pantry never disagree.
  const box = $("#pantry-suggestions");
  const { ingredients, pantry } = store.get();
  const have = new Set(pantry.map((p) => p.id));
  const hits = searchIngredients(query, ingredients).filter(
    (i) => !have.has(i.id),
  );
  if (query && !hits.length) {
    box.innerHTML =
      '<p class="muted">Nothing found. Add a staple – type “eg”, “rice”, “oil” and choose the suggestion.</p>';
    return;
  }
  if (!query && !hits.length) {
    box.innerHTML =
      '<p class="muted">Every ingredient in the catalog is already in your kitchen. Lekker stocked.</p>';
    return;
  }
  const grouped = {};
  for (const item of hits) (grouped[item.aisle] ||= []).push(item);
  box.innerHTML = Object.entries(grouped)
    .map(
      ([aisle, items]) => `
    <div class="aisle-group"><h3>${esc(aisleLabel(aisle))} <span class="aisle-count">${items.length}</span></h3>
      ${items
        .map(
          (
            i,
          ) => `<button type="button" class="sugg" data-id="${i.id}" aria-label="Add ${esc(i.name)} to pantry">
        <span class="sugg-text"><span class="sugg-name">${esc(i.name)}</span><span class="sugg-hint">${esc(packLabel(i.unit_basis, i))}</span></span>
        <span class="sugg-add" aria-hidden="true">＋</span></button>`,
        )
        .join("")}
    </div>`,
    )
    .join("");
  $$(".sugg", box).forEach(
    (b) =>
      (b.onclick = async () => {
        const id = b.dataset.id;
        const basis = ingredientMeta(id).unit_basis;
        await db.putPantryItem({
          id,
          qty: basis.qty,
          unit: basis.unit,
          running_low: false,
        });
        await refreshPantry();
        toast(`Added ${esc(ingredientMeta(id).name)}`);
        $("#pantry-search").focus();
      }),
  );
}

// ---------------- MATCHER ----------------

/** The active meal intent: the user's chip choice wins; otherwise the clock decides (P-104T). */
function activeMealIntent() {
  const { mealChoice } = store.get().matcher;
  if (mealChoice === "") return null; // "Anything"
  if (mealChoice) return mealChoice; // explicit chip
  const d = new Date();
  return mealIntentFor(d.getHours(), d.getMinutes()); // auto from the clock
}

/** P-540: recipes the user deliberately repeats — cooked >= 3 times, ever.
 *  These are EXEMPT from the planner's 5-day recency bench (variety is a
 *  preference, not a rule imposed on a user who cooks pap every night). */
function deliberateRepeaters(minCooks = 3) {
  const counts = new Map();
  for (const e of store.get().cookLog || [])
    counts.set(e.recipeId, (counts.get(e.recipeId) || 0) + 1);
  return [...counts].filter(([, n]) => n >= minCooks).map(([id]) => id);
}

/** Recipe ids cooked in the last 5 days: used for a gentle variety nudge. */
function recentCookIds(days = 5) {
  const cutoff = localDateStr(new Date(Date.now() - days * 864e5)); // P-207 #18: local calendar days
  return [
    ...new Set(
      store
        .get()
        .cookLog.filter((e) => e.date >= cutoff)
        .map((e) => e.recipeId),
    ),
  ];
}

// ── P-546 SETTINGS (SLIMMED) ────────────────────────────────────────────────────
// Owner ruling (Oct 24): Settings keep ONLY household, default servings,
// budget defaults, and the theme/display group. Dietary flags, spice comfort
// and the currency prefix were removed — diet filtering lives in the Matcher's
// own tune-panel chips, not a hidden profile.

function profileOf() {
  return db.getSettings().profile || {};
}

/** P-545: the ONE constraint builder — Matcher and Planner use the same rules,
 * so a view filter can never be honored in one view and ignored in the other. */
function buildConstraints(m) {
  const c = {};
  if (m.dietary) c.dietary = m.dietary;
  if (m.maxTimeMin) c.maxTimeMin = parseInt(m.maxTimeMin, 10);
  return c;
}

/** P-557/P-545: apply look & feel prefs to <html> (data attrs drive tokens.css
 *  + themes.css). Theme sets the whole atlas (colors, fonts, geometry); mode
 *  is light/dark/auto with the system listener wired at boot.
 *  LEGACY: the old 3-accent display pref is grandfathered — theme wins. */
function applyDisplayPrefs() {
  const d = db.getSettings().display || {};
  const html = document.documentElement;
  const theme = THEMES.find((t) => t.id === d.theme) || THEMES[0]; // [0] = Spaza Classic default
  html.dataset.theme = theme.id;
  const modePref = ["light", "dark", "auto"].includes(d.mode)
    ? d.mode
    : "light";
  const sysDark =
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  html.dataset.mode =
    modePref === "auto" ? (sysDark ? "dark" : "light") : modePref;
  // P-546b: density/motion/stickers controls removed from Settings (owner,
  // Oct 24). Defaults apply for everyone — compact was a hidden trap: with no
  // UI, a stored 'off' could never be undone. data-attrs stay available in CSS.
  html.dataset.density = "comfortable";
  html.dataset.motion = "auto";
  html.dataset.stickers = "on";
  // font swap: classic uses the locally-precached Anton/Inter; every other
  // theme loads its Google Fonts once (SW runtime-caches them for offline).
  const link = document.getElementById("gfonts-link");
  if (link) link.href = theme.fontsUrl || "";
}

function matcherCtx(pantry, budgetCents, constraints) {
  const { ingredients, matcher } = store.get();
  return {
    pantry,
    ingredients,
    priceOf,
    rowsOf,
    remainingBudgetCents: budgetCents,
    constraints,
    mealIntent: activeMealIntent(),
    mealStrict:
      typeof matcher.mealChoice === "string" && matcher.mealChoice !== "", // explicit chip tap = strong
    recentCookIds: recentCookIds(),
    favouriteIds: matcher.favouriteIds || [],
  };
}

function toggleFavourite(recipeId) {
  const cur = new Set(store.get().matcher.favouriteIds || []);
  const adding = !cur.has(recipeId);
  if (adding) cur.add(recipeId);
  else cur.delete(recipeId);
  const favouriteIds = [...cur];
  store.update("matcher", { favouriteIds });
  db.setSettings({ favouriteIds });
  return adding;
}

function runMatcher() {
  window.__pulseBump("matcherRuns"); // P-412 Pulse
  syncTuneUI();
  computeAndRender();
}

/* ============ P-111 TUNE PANEL: view-layer filters + facet counts ============
 * The weekly-budget dial never blocked much (every recipe's missing cost sits
 * far under a R600 week), so the matcher now filters on the per-plate price
 * every recipe actually carries, plus tier / shopping / time / diet / tag
 * facets. These are VIEW filters: they re-render from the scored results with
 * zero engine round-trips, so the dial and chips feel instant. Dietary and
 * time still go through the engine (they change eligibility + readiness). */

const MATCHER_FILTER_KEYS = [
  "plateMaxCents",
  "tier",
  "maxMissing",
  "tagFilter",
  "favouritesOnly",
  "sortMode",
  "dietary",
  "maxTimeMin",
  "minCoverage",
  "minFeeds",
];
const matcherFilterSnapshot = () =>
  Object.fromEntries(
    MATCHER_FILTER_KEYS.map((k) => [k, store.get().matcher[k]]),
  );
const persistMatcherFilters = () =>
  db.setSettings({ matcherFilters: matcherFilterSnapshot() });

function setViewFilter(patch) {
  store.update("matcher", patch);
  persistMatcherFilters();
  renderResults();
}

function updatePlateUI() {
  const m = store.get().matcher;
  const dial = $("#plate-dial");
  dial.value = m.plateMaxCents || dial.max;
  $("#plate-display").textContent = m.plateMaxCents
    ? `${formatRands(m.plateMaxCents)} / plate`
    : "Any price";
  const pct = ((dial.value - dial.min) / (dial.max - dial.min)) * 100;
  dial.style.setProperty("--fill", `${pct}%`);
}

/** Chip rows + sort + favourites toggle reflect the stored state. */
function syncTuneUI() {
  const m = store.get().matcher;
  updatePlateUI();
  const setOn = (b, on) => {
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  };
  $$("#tier-chips .fchip").forEach((b) => setOn(b, b.dataset.tier === m.tier));
  $$("#missing-chips .fchip").forEach((b) => {
    const v = b.dataset.missing === "" ? null : parseInt(b.dataset.missing, 10);
    setOn(b, (m.maxMissing ?? null) === v);
  });
  $$("#time-chips .fchip").forEach((b) => {
    const v = b.dataset.time === "" ? null : parseInt(b.dataset.time, 10);
    setOn(b, (m.maxTimeMin ?? null) === v);
  });
  $$("#diet-chips .fchip").forEach((b) =>
    setOn(b, (b.dataset.diet || null) === (m.dietary || null)),
  );
  $$("#coverage-chips .fchip").forEach((b) => {
    const v =
      b.dataset.coverage === "" ? null : parseInt(b.dataset.coverage, 10);
    setOn(b, (m.minCoverage ?? null) === v);
  });
  $$("#feeds-chips .fchip").forEach((b) => {
    const v = b.dataset.feeds === "" ? null : parseInt(b.dataset.feeds, 10);
    setOn(b, (m.minFeeds ?? null) === v);
  });
  $$("#tag-chips .fchip").forEach((b) =>
    setOn(b, m.tagFilter.includes(b.dataset.tag)),
  );
  $("#sort-mode").value = m.sortMode || "match";
  setOn($("#fav-only"), !!m.favouritesOnly);
}

/** Does this scored recipe pass every VIEW filter? (engine eligibility already applied) */
function recipeUsesIngredient(recipeId, ingredientId) {
  const r = store.get().recipes.find((x) => x.id === recipeId);
  return !!(r && (r.ingredients || []).some((l) => l.id === ingredientId));
}

// P-539: the filter semantics live in modules/matchFilters.js (pure, fixture-
// tested). This bridge supplies the one impure helper it needs.
const filterHelpers = { usesIngredient: recipeUsesIngredient };
function passesFilters(r, m) {
  return rowPasses(r, m, filterHelpers);
}
const viewPasses = (r) => passesFilters(r, store.get().matcher);

/** Facet count: how many eligible recipes match if THIS patch were applied. */
function countFor(eligible, patch) {
  return facetCount(eligible, store.get().matcher, patch, filterHelpers);
}

/** P-539: row passes every view filter EXCEPT `dim` — used for chips that
 *  represent ENGINE constraints (diet/time): they show what the matcher would
 *  surface if that constraint were applied, without counting the rest twice. */
function viewPassesExcept(r, dim) {
  const m = { ...store.get().matcher };
  if (dim === "maxTimeMin" || dim === "dietary")
    return rowPasses(r, m, filterHelpers); // view layer ignores these anyway
  return rowPasses(r, { ...m, ...FILTER_DEFS[dim]?.clear }, filterHelpers);
}

/** Live counts on every chip — the "shelf label" that shows the filter's reach. */
function updateChipCounts(eligible) {
  const dim = (b, n) => {
    const c = b.querySelector(".fc-n");
    c.textContent = n;
    b.classList.toggle("zero", n === 0 && !b.classList.contains("on"));
  };
  $$("#tier-chips .fchip").forEach((b) =>
    dim(b, countFor(eligible, { tier: b.dataset.tier })),
  );
  $$("#missing-chips .fchip").forEach((b) => {
    const v = b.dataset.missing === "" ? null : parseInt(b.dataset.missing, 10);
    dim(b, countFor(eligible, { maxMissing: v }));
  });
  const m = store.get().matcher;
  $$("#tag-chips .fchip").forEach((b) => {
    const tags = m.tagFilter.includes(b.dataset.tag)
      ? m.tagFilter
      : [...m.tagFilter, b.dataset.tag];
    dim(b, countFor(eligible, { tagFilter: tags }));
  });
  dim($("#fav-only"), countFor(eligible, { favouritesOnly: true }));
  // P-539: time + diet were dead counters since P-111 — now live. They are
  // engine constraints, so their counts are "eligible rows that would survive
  // the re-score with this constraint", read straight off the row data it governs.
  $$("#time-chips .fchip").forEach((b) => {
    const v = b.dataset.time === "" ? null : parseInt(b.dataset.time, 10);
    dim(
      b,
      v === null
        ? eligible.length
        : eligible.filter(
            (r) => r.timeMinutes <= v && viewPassesExcept(r, "maxTimeMin"),
          ).length,
    );
  });
  $$("#diet-chips .fchip").forEach((b) => {
    const v = b.dataset.diet || null;
    dim(
      b,
      v === null
        ? eligible.length
        : eligible.filter(
            (r) => r.tags.includes(v) && viewPassesExcept(r, "dietary"),
          ).length,
    );
  });
  $$("#coverage-chips .fchip").forEach((b) => {
    const v =
      b.dataset.coverage === "" ? null : parseInt(b.dataset.coverage, 10);
    dim(b, countFor(eligible, { minCoverage: v }));
  });
  $$("#feeds-chips .fchip").forEach((b) => {
    const v = b.dataset.feeds === "" ? null : parseInt(b.dataset.feeds, 10);
    dim(b, countFor(eligible, { minFeeds: v }));
  });
}

const SORTS = {
  match: (a, b) => b.score - a.score,
  cheap: (a, b) => a.perPlateCents - b.perPlateCents,
  fast: (a, b) => a.timeMinutes - b.timeMinutes,
  fewest: (a, b) => a.missing.length - b.missing.length,
};

function resetAllFilters() {
  store.update("matcher", {
    plateMaxCents: null,
    tier: "all",
    maxMissing: null,
    tagFilter: [],
    favouritesOnly: false,
    sortMode: "match",
    dietary: null,
    maxTimeMin: null,
    minCoverage: null,
    minFeeds: null,
  });
  persistMatcherFilters();
  syncTuneUI();
  computeAndRender();
}

/** Active-filter summary chips above the results — one tap removes one filter. */
function renderActiveFilters() {
  const m = store.get().matcher;
  const box = $("#active-filters");
  const TIER_LABEL = {
    ready: "Cook now only",
    almost: "One small shop only",
    stretch: "Bigger shop only",
  };
  const chips = [];
  if (m.plateMaxCents)
    chips.push({
      k: "plate",
      label: `≤ ${formatRands(m.plateMaxCents)} / plate`,
    });
  if (m.tier !== "all") chips.push({ k: "tier", label: TIER_LABEL[m.tier] });
  if (m.maxMissing !== null)
    chips.push({
      k: "missing",
      label: m.maxMissing === 0 ? "Nothing to buy" : `≤ ${m.maxMissing} to buy`,
    });
  for (const t of m.tagFilter) chips.push({ k: `tag:${t}`, label: t });
  if (m.favouritesOnly) chips.push({ k: "fav", label: "Favourites only" });
  if (m.dietary) chips.push({ k: "dietary", label: m.dietary });
  if (m.maxTimeMin) chips.push({ k: "time", label: `≤ ${m.maxTimeMin} min` });
  if (m.search) chips.push({ k: "search", label: `“${m.search}”` }); // P-537
  box.hidden = !chips.length;
  box.innerHTML = chips
    .map(
      (c) =>
        `<button type="button" class="af-chip" data-clear="${esc(c.k)}">${esc(c.label)} <span aria-hidden="true">✕</span></button>`,
    )
    .join("");
  // dropdown badge: how many filters are on, visible without opening the panel
  const badge = $("#tune-badge");
  badge.hidden = !chips.length;
  badge.textContent = chips.length;
  $("#tune-panel")?.setAttribute(
    "aria-label",
    chips.length
      ? `${chips.length} filter${chips.length === 1 ? "" : "s"} active`
      : "Open filters",
  );
  $$(".af-chip", box).forEach(
    (b) =>
      (b.onclick = () => {
        const k = b.dataset.clear;
        if (k === "plate") setViewFilter({ plateMaxCents: null });
        else if (k === "tier") setViewFilter({ tier: "all" });
        else if (k === "missing") setViewFilter({ maxMissing: null });
        else if (k === "fav") setViewFilter({ favouritesOnly: false });
        else if (k.startsWith("tag:"))
          setViewFilter({
            tagFilter: store
              .get()
              .matcher.tagFilter.filter((t) => t !== k.slice(4)),
          });
        else if (k === "dietary") {
          store.update("matcher", { dietary: null });
          persistMatcherFilters();
          computeAndRender();
        } else if (k === "time") {
          store.update("matcher", { maxTimeMin: null });
          persistMatcherFilters();
          computeAndRender();
        } else if (k === "search") {
          $("#matcher-search").value = "";
          store.update("matcher", { search: "" });
          renderResults();
        } // P-537
      }),
  );
}

/** 🎲 Surprise me: random pick from the current matches, scrolled into view
 *  BELOW the sticky chrome (measured-offset pattern) and pulsed. */
/* P-537 UX (owner request): tap OUTSIDE an info modal to close it — no more
 * scrolling a long dossier back up to find a close button. A mobile SWIPE
 * (a scroll/drag gesture that starts on the backdrop) must NOT close it, so
 * we track pointer travel: more than 10px of movement is a swipe, not a tap. */
function wireOutsideClose(dlg) {
  if (!dlg) return;
  let px = null,
    py = null;
  dlg.addEventListener(
    "pointerdown",
    (e) => {
      px = e.clientX;
      py = e.clientY;
    },
    { capture: true, passive: true },
  );
  dlg.addEventListener("click", (e) => {
    if (e.target !== dlg) return; // deeper target = inside the card
    if (px === null) return; // synthetic click, no pointer: ignore
    if (Math.abs(e.clientX - px) > 10 || Math.abs(e.clientY - py) > 10) return; // swipe, not a tap
    dlg.close();
  });
}

/* P-537: the search bar. Debounced (typing rhythm), never persisted — a stale
 * search on next visit would be a betrayal of the empty-pantry honesty rule. */
let searchTimer = null;
function wireMatcherSearch() {
  const input = $("#matcher-search");
  if (!input) return;
  input.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      store.update("matcher", { search: input.value.trim() });
      renderResults();
    }, 120);
  });
}

function surpriseMe() {
  const { results } = store.get().matcher;
  const pool = results.filter((r) => r.eligible && viewPasses(r));
  const cookable = pool.filter((r) => r.readiness !== "stretch");
  const list = cookable.length ? cookable : pool;
  if (!list.length) {
    toast("Nothing to surprise you with — loosen a filter or two.");
    return;
  }
  const pick = list[Math.floor(Math.random() * list.length)];
  const reveal = () => {
    const el = $(
      `#matcher-results .mcard[data-id="${CSS.escape(pick.recipeId)}"]`,
    );
    if (!el) return;
    const fold = el.closest("details.show-more");
    if (fold && !fold.open) fold.open = true; // toggle listener lazy-renders the slot
    setTimeout(
      () => {
        const el2 = $(
          `#matcher-results .mcard[data-id="${CSS.escape(pick.recipeId)}"]`,
        );
        if (!el2) return;
        const chromeH = $(".topbar")?.getBoundingClientRect().height || 64;
        window.scrollTo({
          top: el2.getBoundingClientRect().top + window.scrollY - chromeH - 12,
          behavior: motionBehavior(),
        });
        el2.classList.remove("pulse");
        void el2.offsetWidth;
        el2.classList.add("pulse");
        setTimeout(() => el2.classList.remove("pulse"), 2400);
      },
      fold && !fold.open ? 120 : 0,
    );
  };
  // the card may not exist yet if its section fold is closed
  if (!$(`#matcher-results .mcard[data-id="${CSS.escape(pick.recipeId)}"]`)) {
    const folds = $$("#matcher-results details.show-more");
    for (const f of folds) if (!f.open) f.open = true;
    setTimeout(reveal, 120);
  } else reveal();
}

function computeAndRender() {
  const m = store.get().matcher;
  const { recipes, pantry } = store.get();
  const constraints = buildConstraints(m); // P-545: shared builder — profile flags apply everywhere
  const ctx = matcherCtx(pantry, m.budgetCents, constraints);
  store.update("matcher", { computing: true });
  showSkeletonSoon();
  // P-114 loading line: appears the moment the round-trip starts, usually for
  // under 150ms — #results-note is aria-live=polite, so it reads without
  // interrupting. renderResults overwrites it when results land.
  const note = $("#results-note");
  if (note) note.textContent = "Scoring recipes against your ingredients…";

  if (worker) {
    worker.onmessage = (e) => {
      if (e.data.type !== "scored") return;
      // guard: a stale reply (dial moved again) is dropped
      if (store.get().matcher.budgetCents !== ctx.remainingBudgetCents) return;
      store.update("matcher", {
        results: e.data.payload.results,
        computing: false,
      });
      hideSkeletonSoon();
      renderResults();
      tickTuneBadge();
    };
    // P-104S bug fix: the old payload carried the priceOf FUNCTION across
    // postMessage — DataCloneError killed the matcher in real browsers.
    // scorePayload ships plain data; the worker rebuilds priceOf itself.
    let payload = null;
    try {
      payload = scorePayload(
        recipes,
        store.get().ingredients,
        store.get().prices,
        ctx,
      );
      structuredClone(payload); // guard: no function/data ever crosses uncloneable again
    } catch {
      payload = null;
    }
    if (payload) {
      worker.postMessage(payload);
      return;
    }
    // fall through to sync scoring on any payload problem
  } else {
    // sync fallback (file:// etc.)
    store.update("matcher", {
      results: rankRecipes(recipes, ctx),
      computing: false,
    });
    renderResults();
    tickTuneBadge();
  }
}

// Readiness sections (P-104S): ready / almost / stretch / off.
const SECTION_META = {
  ready: {
    icon: "🍳",
    label: "Cook now",
    note: "you have everything that matters",
    chip: "Ready to cook",
  },
  almost: {
    icon: "🛒",
    label: "Almost there",
    note: "one small top-up shop away",
    chip: "Small top-up",
  },
  stretch: {
    icon: "👀",
    label: "Worth a look",
    note: "fits the budget, but a real shop",
    chip: "Bigger shop",
  },
};

// A single-word "what is this" for the card kicker (first matching tag wins).
const KICKER_TAGS = ["breakfast", "lunch", "dinner", "dessert", "snack"];
const kickerOf = (tags) => KICKER_TAGS.find((t) => tags.includes(t)) || "meal";

/** The headline sentence: plain English instead of a bare number (P-104T).
 *  "You have all 4 key ingredients" / "You have 3 of 4 key ingredients" */
function haveHeadline(r) {
  if (r.realCount === 0) return "Made from kitchen basics";
  if (r.ownedCount === r.realCount)
    return `You have all ${r.realCount} key ingredient${r.realCount === 1 ? "" : "s"}`;
  return `You have ${r.ownedCount} of ${r.realCount} key ingredients`;
}

/** SVG match ring with the label INSIDE the ring's own space and real padding (P-104T).
 *  Number + "match" caption stacked; 88px ring, r=36, so the digits keep 8px+ of clear air. */
function matchRing(pct) {
  const R = 36,
    C = 2 * Math.PI * R;
  const off = C * (1 - pct / 100);
  return `<div class="mring" role="img" aria-label="${pct}% of this recipe's weighted ingredients are in your pantry">
    <svg viewBox="0 0 88 88" width="88" height="88" aria-hidden="true">
      <circle cx="44" cy="44" r="${R}" class="mring-track"/>
      <circle cx="44" cy="44" r="${R}" class="mring-arc" stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}" transform="rotate(-90 44 44)"/>
    </svg>
    <div class="mring-label"><strong>${pct}<small>%</small></strong><span>match</span></div>
  </div>`;
}

function matchCard(r, i) {
  const meta = SECTION_META[r.readiness] || SECTION_META.stretch;
  const fav = (store.get().matcher.favouriteIds || []).includes(r.recipeId);
  const staples =
    r.staplesMissing?.length && r.readiness === "ready"
      ? `<p class="mc-staples">Assuming you have <strong>${r.staplesMissing
          .slice(0, 3)
          .map((m) => esc(m.name))
          .join(
            ", ",
          )}</strong>${r.staplesMissing.length > 3 ? ` +${r.staplesMissing.length - 3} more` : ""}. Never counted against you.</p>`
      : "";
  const need =
    r.readiness !== "ready" && r.readiness !== "off"
      ? `<div class="mc-need">
        <div class="mc-need-h">Still to buy <span class="mc-need-total">${formatRands(r.missingCostCents)} top-up</span></div>
        ${r.missing.map((m) => `<div class="missing-line"><span>＋ ${esc(m.name)} <span class="muted">${esc(m.qty)} ${esc(m.unit)}</span></span><span class="price money money--sm" style="font-size:1rem">${m.unpriced ? "—" : formatRands(m.priceCents)}</span></div>`).join("")}
      </div>`
      : "";
  const locked =
    r.readiness === "off"
      ? `<div class="ineligible-note" title="${esc(r.reasons.join("; "))}" aria-label="Held back: ${esc(r.reasons.join("; "))}">🔒 ${esc(chipForReason(r.reasons))}</div>`
      : "";
  const badges = [
    r.cookedRecently ? '<span class="mc-flag">Cooked recently</span>' : "",
    fav ? '<span class="mc-flag mc-flag--fav">★ Favourite</span>' : "",
  ].join("");

  return `
    <article class="recipe-card mcard readiness-${r.readiness}" data-id="${r.recipeId}" style="animation-delay:${Math.min(i * 40, 200)}ms">
      <header class="mc-head">
        <div class="mc-head-main">
          <div class="mc-kicker"><span class="mc-status">${meta.chip}</span><span class="mc-kind">${esc(kickerOf(r.tags))}</span>${badges}</div>
          <h3 class="mc-title">${esc(r.title)}</h3>
          <p class="mc-have">${haveHeadline(r)}</p>
        </div>
        ${matchRing(r.matchPct)}
      </header>

      <div class="mc-facts">
        <span class="mc-fact"><span aria-hidden="true">⏱</span> ${r.timeMinutes} min</span>
        <span class="mc-fact"><span aria-hidden="true">🍽</span> ${r.servings} plate${r.servings === 1 ? "" : "s"}</span>
        <span class="mc-fact mc-fact--price"><span class="money money--sm">${formatRands(r.perPlateCents)}</span><span class="mc-per">per plate</span></span>
      </div>

      ${need}${staples}${locked}

      <div class="mc-actions">
        <button type="button" class="mc-open" aria-expanded="false">See recipe &amp; ingredients</button>
        <button type="button" class="mc-fav${fav ? " on" : ""}" aria-pressed="${fav}" aria-label="${fav ? "Remove from favourites" : "Add to favourites"}" title="Favourite">${fav ? "★" : "☆"}</button>
      </div>
      <div class="mc-detail" hidden></div>
    </article>`;
}

/* P-201: skeletons are the patience-backstop, not the default. The first paint
 * stays as-is; only if the worker hasn't answered after 150ms do we flash 3
 * card-shaped skeletons. Fast loads never see them. */
let skeletonTimer = null;
function showSkeletonSoon() {
  clearTimeout(skeletonTimer);
  skeletonTimer = setTimeout(() => {
    const m = store.get().matcher;
    if (m.computing && !m.results.length) renderResults();
  }, 150);
}
function hideSkeletonSoon() {
  clearTimeout(skeletonTimer);
}

/** P-201 score-chip tick: a 120ms scale-pulse on the result count after every
 *  ENGINE re-rank (worker or sync). View-filter renders (dial drag) don't tick —
 *  that would strobe. prefers-reduced-motion kills the animation in CSS. */
function tickTuneBadge() {
  const badge = $("#tune-badge");
  const target = badge && !badge.hidden ? badge : $("#results-title");
  if (!target) return;
  target.classList.remove("tick");
  void target.offsetWidth; // restart the animation on back-to-back ranks
  target.classList.add("tick");
}

function renderResults() {
  const { results, computing } = store.get().matcher;
  const box = $("#matcher-results");
  const strip = $("#unlock-strip");
  if (computing && !results.length) {
    box.innerHTML = Array.from(
      { length: 3 },
      () => `
      <article class="mcard skeleton-card" aria-hidden="true">
        <div class="sk sk-head"></div>
        <div class="sk sk-line"></div>
        <div class="sk sk-line sk-short"></div>
        <div class="sk sk-row"></div>
      </article>`,
    ).join("");
    strip.hidden = true;
    return;
  }
  const { pantry } = store.get();
  if (!pantry.length) {
    box.innerHTML = `<div class="empty"><span class="big">🧺</span>Your pantry is empty. The Matcher needs a kitchen to match.<br><a class="btn section-gap" href="#pantry" style="display:inline-flex">Build my pantry</a> <button type="button" class="chip-link" data-guide="guide-matcher">show me how</button></div>`;
    $("#results-title").textContent = "";
    $("#results-note").textContent = "";
    strip.hidden = true;
    return;
  }

  // meal chips reflect the active intent
  const intent = activeMealIntent();
  const chosen = store.get().matcher.mealChoice;
  $$("#meal-chips .meal-chip").forEach((b) => {
    const v = b.dataset.meal;
    const on =
      chosen === undefined || chosen === null
        ? v === (intent || "") && false
        : v === chosen;
    b.classList.toggle("on", on);
    b.classList.toggle("auto", chosen == null && v === (intent || ""));
    b.setAttribute(
      "aria-pressed",
      on || (chosen == null && v === (intent || "")) ? "true" : "false",
    );
  });

  // P-111: the scored results feed a view filter layer, then facet counts.
  const m = store.get().matcher;
  // P-537: search hits are computed ONCE against the precomputed index, then
  // annotated onto each scored row — so facet counts, filters and the visible
  // list all see the same truth.
  const searchHits =
    m.search && recipeIndex ? searchRecipes(recipeIndex, m.search) : null;
  const eligible = results.filter((r) => r.eligible);
  for (const r of eligible)
    r.__srch = searchHits ? searchHits.get(r.recipeId) || null : null;
  const visible = eligible.filter((r) => viewPasses(r));

  // P-535: "3 recipes use this — match now" lands here: a dismissible focus
  // chip above the results, honest count, one-tap clear.
  const focus = store.get().matcher.ingredientFocus;
  const focusStrip = $("#focus-strip");
  if (focusStrip) {
    if (focus) {
      const ing = ingredientMeta(focus);
      const n = visible.length;
      focusStrip.hidden = false;
      focusStrip.innerHTML = `<button type="button" class="fchip on" id="focus-clear" aria-pressed="true">
        Using: ${esc(ing?.name || focus)} — ${n} recipe${n === 1 ? "" : "s"} <span class="fc-x" aria-hidden="true">✕</span></button>`;
      $("#focus-clear").onclick = () => {
        store.set({
          matcher: { ...store.get().matcher, ingredientFocus: null },
        });
        renderResults();
      };
    } else {
      focusStrip.hidden = true;
      focusStrip.innerHTML = "";
    }
  }
  const groups = { ready: [], almost: [], stretch: [], off: [] };
  for (const r of visible) groups[r.readiness].push(r);
  const sortFn = SORTS[m.sortMode] || SORTS.match;
  // P-537: while searching, matched recipes surface by match kind first
  // (title > ingredient > tag), and ingredient matches rank by pantry share —
  // "what can I make with spinach?" answers with what you can MOSTLY cook.
  const searchCmp = (a, b) => {
    const ra = a.__srch?.rank ?? 0,
      rb = b.__srch?.rank ?? 0;
    if (ra !== rb) return rb - ra;
    if (ra === 2) {
      // ingredient matches: more of the recipe already in the pantry wins
      const share = (r) => {
        const rec = store.get().recipes.find((x) => x.id === r.recipeId);
        const n = rec?.ingredients?.length || 1;
        return 1 - r.missing.length / n;
      };
      return share(b) - share(a);
    }
    return 0;
  };
  for (const k of ["ready", "almost", "stretch"])
    groups[k].sort(
      (a, b) =>
        (m.search ? searchCmp(a, b) : 0) || sortFn(a, b) || b.score - a.score,
    );
  const cookable = groups.ready.length + groups.almost.length;

  $("#results-title").textContent =
    `${groups.ready.length} to cook now · ${groups.almost.length} almost there`;
  const hidden = results.length - visible.length;
  const q = m.search ? ` for “${m.search.trim()}”` : "";
  // P-539 dead-end honesty: never a silent wall of nothing — every filtered
  // state names the ONE filter whose clear reveals the most.
  const advice = hidden > 0 ? deadEndAdvice(m, eligible, filterHelpers) : [];
  const best = advice[0];
  const unlockNote = best
    ? ` — clear ${best.label === "search" ? "the search" : `“${best.label}”`} to see ${best.wouldShow}`
    : "";
  $("#results-note").textContent =
    hidden > 0
      ? `${visible.length} of ${results.length} shown${q} · ${hidden} hidden by your filters${unlockNote}`
      : `${visible.length} recipes matched${q}`;

  syncTuneUI();
  updateChipCounts(eligible);
  renderActiveFilters();

  // UNLOCK STRIP: "buy X and unlock N recipes"
  const insights = unlockInsights(results, 3);
  if (insights.length && insights[0].unlocks >= 2) {
    strip.hidden = false;
    strip.innerHTML = `<div class="us-h"><span aria-hidden="true">💡</span> Smart shop: one item, more dinners</div>
      <div class="us-items">${insights
        .filter((u) => u.unlocks >= 2)
        .map(
          (u) => `
        <div class="us-item"><strong>${esc(u.name)}</strong>
          <span class="us-n">unlocks ${u.unlocks} recipes</span>
          <span class="muted us-ex">${u.titles.slice(0, 2).map(esc).join(", ")}…</span></div>`,
        )
        .join("")}</div>`;
  } else strip.hidden = true;

  const section = (key, cards, inline = Infinity) => {
    if (!cards.length) return "";
    const m = SECTION_META[key];
    const shown = cards.slice(0, inline);
    const rest = cards.slice(inline);
    return `
      <div class="readiness-section" data-section="${key}">
        <h3 class="readiness-h"><span>${m.icon}</span> ${m.label} <span class="aisle-count">${cards.length}</span>
          <span class="muted readiness-note">${m.note}</span></h3>
        ${shown.map((r, i) => matchCard(r, i)).join("")}
        ${
          rest.length
            ? `<details class="show-more" data-lazy="${key}"><summary>Show ${rest.length} more ${m.label.toLowerCase()}</summary>
          <div class="lazy-slot"></div></details>`
            : ""
        }
      </div>`;
  };

  // MEAL-AWARE LEAD SECTION (P-104T): when the user TAPS a meal chip, recipes that fit
  // that meal lead, whatever their readiness. Otherwise "Cook now" would always be full
  // of snacks and desserts that happen to be 100% covered, burying the breakfast they asked for.
  let html = "";
  const strictMeal =
    typeof chosen === "string" && chosen !== "" ? chosen : null;
  if (strictMeal) {
    const MEAL_LABEL = {
      breakfast: ["🌅", "Best for breakfast"],
      lunch: ["🥪", "Best for lunch"],
      dinner: ["🍲", "Best for dinner"],
      dessert: ["🍮", "Best for dessert"],
      snack: ["🍿", "Best for snack time"],
    };
    const fits = results
      .filter((r) => r.eligible && viewPasses(r) && r.tags.includes(strictMeal))
      .slice(0, 12);
    if (fits.length) {
      const [icon, label] = MEAL_LABEL[strictMeal];
      html += `<div class="readiness-section meal-lead" data-section="meal-lead">
        <h3 class="readiness-h"><span>${icon}</span> ${label} <span class="aisle-count">${fits.length}</span>
          <span class="muted readiness-note">ranked by what you already have</span></h3>
        ${fits.map((r, i) => matchCard(r, i)).join("")}
      </div>`;
      const leadIds = new Set(fits.map((r) => r.recipeId));
      for (const k of ["ready", "almost", "stretch"])
        groups[k] = groups[k].filter((r) => !leadIds.has(r.recipeId));
    }
  }
  const TIERS = m.tier === "all" ? ["ready", "almost", "stretch"] : [m.tier];
  html += TIERS.map((k) =>
    k === "ready"
      ? section("ready", groups.ready)
      : k === "almost"
        ? section("almost", groups.almost, 8)
        : section("stretch", groups.stretch, 6),
  ).join("");
  // P-206 T2 (Groq winner, adapted for truth; P-315): the old comment said
  // staples forgiveness kept ~7 basics eligible at ANY budget — that was the
  // treat-tiering bug (condensed milk etc. marked assumed-home), which let
  // desserts claim "cook now" from an EMPTY kitchen. With honest tiers the
  // budget-starved state is: the pantry genuinely readies its recipes, and
  // everything that needs shopping is held back by money.
  const shopBlockedN = results.filter(
    (r) => !r.eligible && /budget/i.test(r.reasons.join(";")),
  ).length;
  if (
    groups.ready.length &&
    !groups.almost.length &&
    !groups.stretch.length &&
    shopBlockedN > 5
  ) {
    html =
      `<div class="budget-note section-gap"><span aria-hidden="true">💡</span>
      <strong>Everything else costs more than your budget.</strong>
      <span class="muted">Raise the budget or trim your list.</span>
      <button type="button" class="budget-note-cta" id="zr-budget2">Open the weekly budget</button></div>` +
      html;
  }

  const blocked = results.length - eligible.length;
  if (blocked) {
    const inel = results.filter((r) => !r.eligible).slice(0, 12);
    html += `<details class="off-fold"><summary>🔒 ${blocked} recipe${blocked === 1 ? "" : "s"} held back</summary>
      <div class="off-list">${inel
        .map(
          (r) => `<div class="off-row" title="${esc(r.reasons.join("; "))}">
        <span class="off-title">${esc(r.title)}</span>
        <span class="off-chip">${esc(chipForReason(r.reasons))}</span></div>`,
        )
        .join("")}
      ${blocked > 12 ? `<div class="muted off-more">+ ${blocked - 12} more</div>` : ""}</div></details>`;
  }
  if (!groups.ready.length && !groups.almost.length && !groups.stretch.length) {
    if (m.search) {
      // P-537: the search itself may be the culprit — say it honestly, offer
      // the three next actions: relax filters, clear the search, or decode.
      const clearSearch = () => {
        $("#matcher-search").value = "";
        store.update("matcher", { search: "" });
        renderResults();
      };
      const clearFilters = {
        plateMaxCents: null,
        tier: "all",
        maxMissing: null,
        tagFilter: [],
        favouritesOnly: false,
        ingredientFocus: null,
      };
      const nNoFilters = eligible.filter((r) => {
        const rr = { ...r, __srch: r.__srch };
        const fakeM = { ...m, ...clearFilters };
        return (
          !fakeM.plateMaxCents &&
          fakeM.tier === "all" &&
          fakeM.tagFilter.every((t) => true) &&
          !fakeM.favouritesOnly &&
          !fakeM.ingredientFocus &&
          fakeM.maxMissing === null
        );
      }).length;
      box.innerHTML = `<div class="empty"><span class="big">🔍</span><strong>No recipes for “${esc(m.search)}”.</strong><br>
        <span class="muted">Search covers titles, ingredients (vernacular included) and tags.</span><br>
        <div class="empty-actions section-gap">
          <button type="button" class="btn" id="zr-clear-search">Clear the search</button>
          ${nNoFilters > 0 ? `<button type="button" class="chip-link" id="zr-clear-filters">Clear filters too (${nNoFilters} hidden)</button>` : ""}
          <a class="chip-link" href="#decoder">Paste the recipe into the Decoder instead</a>
        </div></div>`;
      $("#zr-clear-search").onclick = clearSearch;
      $("#zr-clear-filters")?.addEventListener("click", () => {
        $("#matcher-search").value = "";
        store.update("matcher", { ...clearFilters, search: "" });
        renderResults();
      });
      $("#results-title").textContent = "";
      $("#results-note").textContent = "";
      strip.hidden = true;
      renderActiveFilters();
      return;
    }
    if (!eligible.length) {
      // P-206 (Groq P-205 winners): NOTHING qualifies, filters aren't the culprit.
      // Distinguish budget-blocked from a too-shy pantry; each state offers ONE action.
      const inel = results.filter((r) => !r.eligible);
      const jAll = inel.map((r) => r.reasons.join("; ")).join("; ");
      const budgetBlocked =
        inel.length > 0 &&
        /budget/i.test(jAll) &&
        !/Not |Contains|Too long/i.test(jAll);
      const dietBlocked = /Not |Contains|Too long/i.test(jAll);
      if (budgetBlocked) {
        html = `<div class="empty"><span class="big">💸</span><strong>Recipes exist but all cost more than your budget.</strong><br>
          <span class="muted">Raise the budget or trim your list.</span><br>
          <button type="button" class="btn section-gap" id="zr-budget">Open the weekly budget</button></div>`;
      } else if (dietBlocked) {
        html = `<div class="empty"><span class="big">🥗</span><strong>Nothing fits that diet or cook-time right now.</strong><br>
          <span class="muted">Loosen the constraint, or <a href="#pantry" style="text-decoration:underline">add a few more things to your pantry</a>.</span></div>`;
      } else {
        html = `<div class="empty"><span class="big">🧺</span><strong>Your pantry's too shy for a match.</strong><br>
          <span class="muted">Add a couple of basics.</span><br>
          <a class="btn section-gap" href="#pantry" style="display:inline-flex">Build my pantry</a></div>`;
      }
      $("#results-title").textContent = "";
      $("#results-note").textContent = "";
      box.innerHTML = html;
      strip.hidden = true;
      $("#zr-budget")?.addEventListener("click", () => {
        location.hash = "#planner";
        setTimeout(() => $("#week-budget")?.focus(), 400);
      });
      return;
    }
    // P-111: diagnose WHICH filter is starving the results and offer the fix.
    const tries = [];
    if (m.plateMaxCents)
      tries.push({ label: "plate cap", apply: { plateMaxCents: null } });
    if (m.tier !== "all")
      tries.push({ label: "readiness filter", apply: { tier: "all" } });
    if (m.maxMissing !== null)
      tries.push({ label: "shopping limit", apply: { maxMissing: null } });
    if (m.tagFilter.length)
      tries.push({ label: "topic filters", apply: { tagFilter: [] } });
    if (m.favouritesOnly)
      tries.push({
        label: "favourites-only",
        apply: { favouritesOnly: false },
      });
    if (m.minCoverage)
      tries.push({ label: "coverage floor", apply: { minCoverage: null } }); // P-539
    if (m.minFeeds)
      tries.push({ label: "feeds floor", apply: { minFeeds: null } }); // P-539
    if (m.ingredientFocus)
      tries.push({
        label: "ingredient focus",
        apply: { ingredientFocus: null },
      }); // P-535
    const cure = tries
      .map((t) => ({ ...t, n: countFor(eligible, t.apply) }))
      .find((t) => t.n > 0);
    const hint = cure
      ? `<p class="section-gap">Loosening your <strong>${cure.label}</strong> brings back ${cure.n} recipe${cure.n === 1 ? "" : "s"}.</p>
         <button type="button" class="btn" id="loosen-btn">Loosen it — show me</button>`
      : `<p class="section-gap">Your dietary or time filter is the tightest one here. Loosen it, or
         <a href="#pantry" style="text-decoration:underline">add a few more things to your pantry</a>.</p>`;
    html = `<div class="empty"><span class="big">🔍</span><strong>Nothing fits those filters right now.</strong><br>${hint}</div>`;
  }
  box.innerHTML = html;
  $("#zr-budget2")?.addEventListener("click", () => {
    location.hash = "#planner";
    setTimeout(() => $("#week-budget")?.focus(), 400);
  });
  $("#loosen-btn")?.addEventListener("click", () => {
    const tries = [];
    if (m.plateMaxCents)
      tries.push({ label: "plate cap", apply: { plateMaxCents: null } });
    if (m.tier !== "all")
      tries.push({ label: "readiness filter", apply: { tier: "all" } });
    if (m.maxMissing !== null)
      tries.push({ label: "shopping limit", apply: { maxMissing: null } });
    if (m.tagFilter.length)
      tries.push({ label: "topic filters", apply: { tagFilter: [] } });
    if (m.favouritesOnly)
      tries.push({
        label: "favourites-only",
        apply: { favouritesOnly: false },
      });
    const cure = tries
      .map((t) => ({ ...t, n: countFor(eligible, t.apply) }))
      .find((t) => t.n > 0);
    if (cure) setViewFilter(cure.apply);
    else resetAllFilters();
  });

  // LAZY FOLDS (P-104T): the overflow cards are only built when the user opens "Show more".
  // 179 cards at once was heavy on phones; now the page renders ~25 and the rest on demand.
  const overflow = {
    almost: groups.almost.slice(8),
    stretch: groups.stretch.slice(6),
  };
  $$("details.show-more[data-lazy]", box).forEach((d) =>
    d.addEventListener("toggle", () => {
      if (!d.open || d.dataset.done) return;
      d.dataset.done = "1";
      d.querySelector(".lazy-slot").innerHTML = overflow[d.dataset.lazy]
        .map((r, i) => matchCard(r, i))
        .join("");
    }),
  );
}

/** Per-line pantry state for the checklist: 'have' | 'short' | 'none' | 'staple' (P-104T). */
function lineState(line, scaledQty) {
  const meta = ingredientMeta(line.id);
  const p = store.get().pantry.find((x) => x.id === line.id);
  if (meta && meta.tier <= STAPLE_TIER_MAX && !p) return "staple";
  if (!p) return "none";
  return pantryHas(
    store.get().pantry,
    { ...line, qty: scaledQty },
    meta,
    priceOf,
  )
    ? "have"
    : "short";
}

const STATE_UI = {
  have: { icon: "✓", label: "In your pantry" },
  short: { icon: "◐", label: "You have some, not enough" },
  none: { icon: "＋", label: "Need to buy" },
  staple: { icon: "○", label: "Kitchen basic (assumed)" },
};

/* P-206 (Groq P-205 winners): short why-held-back chip labels. The chip is
 * what a greyed-out recipe shows at a glance; the full reasons ride along in
 * the title/aria-label. Budget + unpriced = winner copy verbatim. */
const INELIGIBLE_CHIPS = {
  budget: "Missing items exceed budget",
  excluded: "Contains excluded ingredient",
  diet: "Doesn't fit your diet",
  unpriced: "Price unknown for one ingredient",
  time: "Too long to cook now",
};
function chipForReason(reasons) {
  const j = reasons.join("; ");
  if (/price/i.test(j)) return INELIGIBLE_CHIPS.unpriced;
  if (/budget/i.test(j)) return INELIGIBLE_CHIPS.budget;
  if (/Contains/.test(j)) return INELIGIBLE_CHIPS.excluded;
  if (/Not /.test(j)) return INELIGIBLE_CHIPS.diet;
  if (/Too long|time/i.test(j)) return INELIGIBLE_CHIPS.time;
  return INELIGIBLE_CHIPS.budget;
}

function renderRecipeDetail(r) {
  // P-532 SEO: server-free Recipe + Offer JSON-LD, rendered with the modal.
  // Offer price = derived per-plate cost from verified prices (never a
  // "live price" claim — P-519 contract). Values come from the same engine
  // that computes the visible card, so markup can't disagree with the UI.
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Recipe",
    name: r.title,
    recipeYield: `${r.servings} servings`,
    recipeCategory: "Dinner",
    recipeCuisine: "South African",
    recipeIngredient: (r.ingredients || []).map((l) => {
      const meta = ingredientMeta(l.id);
      return `${l.qty ?? ""}${l.qty && l.unit ? " " : ""}${l.unit ?? ""} ${meta?.name || l.id}`.trim();
    }),
    recipeInstructions: (r.steps || []).map((s) => ({
      "@type": "HowToStep",
      text: s,
    })),
    offers: {
      "@type": "Offer",
      name: `${r.title} — derived cost per plate`,
      price: (r.perPlateCents / 100).toFixed(2),
      priceCurrency: "ZAR",
      availability: "https://schema.org/InStock",
      description:
        "Per-plate cost derived from verified South African retail prices; check in-app for the price date of each ingredient.",
    },
  }).replace(/</g, "\u003c");
  return (
    `
    <script type="application/ld+json" data-recipe-ld>${jsonLd}</script>
  ` +
    `
    <div class="md-plates">
      <label class="md-plates-l" for="plates-${esc(r.recipeId)}">Cooking for</label>
      <div class="md-stepper" role="group" aria-label="Number of plates">
        <button type="button" class="md-step" data-dir="-1" aria-label="Fewer plates">−</button>
        <output class="md-plates-n" id="plates-${esc(r.recipeId)}">${r.servings}</output>
        <button type="button" class="md-step" data-dir="1" aria-label="More plates">＋</button>
      </div>
      <span class="md-plates-unit">plates</span>
      <span class="md-total"><span class="money money--sm plates-cost">…</span><span class="mc-per">per plate</span></span>
      <span class="md-tier-note muted" hidden></span>
    </div>
    <h4 class="md-h">Ingredients <span class="md-legend"><span class="ls ls-have">✓ have</span><span class="ls ls-none">＋ buy</span></span></h4>
    <div class="ing-lines"></div>
    <h4 class="md-h">Steps</h4>
    <ol class="steps md-steps">${r.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
    <div class="md-cook">
      <button type="button" class="cook-btn">🍳 Cook it</button>
      <span class="muted">Logs to your Cook Log and uses up pantry quantities.</span>
      <div class="md-cook-note" hidden></div>
    </div>`
  );
}

function wireDetail(root, r) {
  const { recipes } = store.get();
  const recipe = recipes.find((x) => x.id === r.recipeId);
  // P-545: the profile's default servings drive the cook size (and the cost
  // per plate) — the dial is still right there for this-cook overrides.
  const prof = profileOf();
  const profServ =
    Number.isFinite(prof.defaultServings) && prof.defaultServings > 0
      ? prof.defaultServings
      : prof.household;
  let plates =
    Number.isFinite(profServ) && profServ > 0 && profServ <= 12
      ? Math.round(profServ)
      : recipe.servings;
  const out = root.querySelector(".md-plates-n");

  const draw = () => {
    out.textContent = plates;
    const scaled = rescaleRecipe(recipe, plates);
    // P-571: same line-aware picker as the card chip, same proportional usage
    // model — the stepper can never disagree with the sticker again.
    const costing = costRecipe(scaled, priceOf, rowsOf);
    root.querySelector(".plates-cost").textContent = formatRands(
      perPlateCents(costing.totalUsageCents, scaled.servings),
    );
    // P-542: the reader's cost surface carries the same P-519 honesty as the
    // slip — per-ingredient ≈ for estimated rows, and a tier note under the
    // plate price whenever the cook leans on estimates (silence = all ✓).
    const tiers = costing.lines.reduce(
      (t, { priceEntry, costCents }) => {
        if (costCents === null || !priceEntry) return t;
        if ((priceEntry.source ?? "estimated") === "verified") t.v++;
        else t.e++;
        return t;
      },
      { v: 0, e: 0 },
    );
    const tierNote = root.querySelector(".md-tier-note");
    if (tierNote) {
      tierNote.hidden = tiers.e === 0;
      tierNote.textContent =
        tiers.e === 0
          ? ""
          : `≈ ${tiers.e} estimated price${tiers.e === 1 ? "" : "s"} in this cook · ${tiers.v} checked`;
    }
    root.querySelector(".ing-lines").innerHTML = costing.lines
      .map(({ line, usageCents, priceEntry }) => {
        const meta = ingredientMeta(line.id);
        const st = lineState(line, line.qty);
        const ui = STATE_UI[st];
        const est =
          usageCents !== null &&
          priceEntry &&
          (priceEntry.source ?? "estimated") !== "verified"
            ? ' <span class="sub" title="estimated price — verify in store">≈</span>'
            : "";
        return `<div class="ing-row st-${st}" title="${ui.label}">
        <span class="ing-state" aria-label="${ui.label}">${ui.icon}</span>
        <span class="ing-name">${esc(meta?.name || line.id)}${line.optional ? ' <em class="muted">(optional)</em>' : ""}</span>
        <span class="ing-qty muted">${line.qty} ${esc(line.unit)}</span>
        <span class="ing-price">${usageCents === null ? "—" : formatRands(usageCents)}${est}</span>
      </div>`;
      })
      .join("");
  };
  root.querySelectorAll(".md-step").forEach(
    (b) =>
      (b.onclick = () => {
        plates = Math.min(8, Math.max(1, plates + parseInt(b.dataset.dir, 10)));
        draw();
      }),
  );
  draw();

  /**
   * P-452 cook gate (owner rule Oct 21): cook only what the pantry can
   * actually cover. On press the availability analysis RE-RENDERS from the
   * live store (real-time), then the engine decides:
   *   - covered at the requested plates  → cook
   *   - short but ≥ 1 whole plate fits   → offer the smaller batch, one tap
   *   - not even one plate fits          → hard block with the exact shortfall
   * Same gate runs inside cookRecipe, so no entry point can bypass it.
   */
  const note = root.querySelector(".md-cook-note");
  root.querySelector(".cook-btn").onclick = () => {
    draw(); // fresh pantry → fresh ✓/◐/＋
    const gate = maxCookableServings(
      recipe,
      plates,
      store.get().pantry,
      ingredientMeta,
      priceOf,
    );
    if (gate.max >= plates) {
      note.hidden = true;
      return cookRecipe(recipe, plates, r);
    }
    note.hidden = false;
    if (gate.max >= 1) {
      note.className = "md-cook-note md-cook-note--short";
      note.innerHTML = `<p>You have enough for <strong>${gate.max} of ${plates} plates</strong> right now.</p>
        <button type="button" class="cook-smaller">Cook ${gate.max} plate${gate.max === 1 ? "" : "s"}</button>
        <button type="button" class="md-step-cancel">Not now</button>`;
      note.querySelector(".cook-smaller").onclick = () => {
        note.hidden = true;
        cookRecipe(recipe, gate.max, r);
      };
      note.querySelector(".md-step-cancel").onclick = () => {
        note.hidden = true;
      };
    } else {
      const list = gate.blockers
        .map(
          (b) =>
            `<li><strong>${esc(b.name)}</strong> — ${b.state === "none" ? "not in your pantry" : "not enough in your pantry"}</li>`,
        )
        .join("");
      note.className = "md-cook-note md-cook-note--block";
      note.innerHTML = `<p>Can't cook this yet: you're short on <strong>${gate.blockers.length} ingredient${gate.blockers.length === 1 ? "" : "s"}</strong>, and even 1 plate needs them all.</p>
        <ul>${list}</ul>
        <p class="muted">Add or top up these in your Pantry, then come back.</p>`;
    }
    const chromeH = $(".topbar")?.getBoundingClientRect().height || 64;
    window.scrollTo({
      top: note.getBoundingClientRect().top + window.scrollY - chromeH - 12,
      behavior: motionBehavior(),
    });
  };
}

/**
 * COOK IT (P-104T). One awaited pipeline so every screen is consistent when it ends:
 *   1. consume pantry quantities (snapshotting the BEFORE state for undo)
 *   2. write the cook-log entry
 *   3. refresh store.pantry AND store.cookLog   <- the Cook Log page now shows it instantly
 *   4. re-rank the matcher against the shrunken pantry
 *   5. offer a one-tap Undo that restores pantry + removes the log entry
 * The user then lands on the Cook Log (their streak/XP just moved: the reward moment).
 */
async function cookRecipe(recipe, plates, result) {
  // P-452: the gate is law at the engine level too — no entry point (modal,
  // standalone card, cook-log log-again, decoded modal) can cook more than the
  // pantry covers. Insufficient at the requested plates is NEVER silently
  // clamped here; the UI offers the smaller batch explicitly.
  const gate = maxCookableServings(
    recipe,
    plates,
    store.get().pantry,
    ingredientMeta,
    priceOf,
  );
  if (gate.max < plates) {
    toast(
      gate.max >= 1
        ? `Your pantry covers ${gate.max} of ${plates} plates of “${recipe.title}” — cook the smaller batch instead.`
        : `Not enough in your pantry to cook “${recipe.title}” — even one plate needs every ingredient.`,
    );
    return;
  }
  const factor = plates / recipe.servings;
  const before = []; // [{ id, item|null }] snapshot for undo
  const used = []; // human summary of what was consumed
  for (const line of recipe.ingredients) {
    const item = store.get().pantry.find((p) => p.id === line.id);
    if (!item) continue;
    before.push({ id: line.id, item: { ...item } });
    // P-204: deduct in a COMMON gram basis via the same conversion authority the
    // matcher uses (qtyInPackBasis), then store the remainder back in the row's
    // own unit (qtyFromGrams). The old raw subtraction took "1 unit onion" off a
    // 1000 g bag as ONE GRAM — wrong for 667 of 1072 real recipe lines whose
    // unit differs from the pantry row's unit.
    const pEntry = priceOf(line.id);
    const packQty = pEntry && pEntry.pack_qty ? pEntry.pack_qty : 0;
    const needG = qtyInPackBasis(line.qty * factor, line.unit, "g", {
      id: line.id,
      packQty,
    });
    const haveG = qtyInPackBasis(item.qty, item.unit, "g", {
      id: line.id,
      packQty,
    });
    let remaining,
      remUnit = item.unit;
    if (needG !== null && haveG !== null) {
      const remG = Math.max(0, haveG - needG);
      const back = qtyFromGrams(remG, item.unit, { id: line.id, packQty });
      if (back !== null) {
        remaining = Math.round(back * 100) / 100;
      } else {
        remaining = Math.round(remG * 100) / 100;
        remUnit = "g"; // unconvertible family: store grams
      }
    } else {
      remaining = Math.max(0, item.qty - line.qty * factor); // unconvertible pair: legacy raw path
    }
    const name = ingredientMeta(line.id)?.name || line.id;
    if (remaining > 0.0001) {
      await db.putPantryItem({ ...item, qty: remaining, unit: remUnit });
      used.push(`${name}: ${item.qty} → ${remaining} ${remUnit}`);
    } else {
      await db.remove("pantry", line.id);
      used.push(`${name}: used up`);
    }
  }
  const costing = costRecipe(rescaleRecipe(recipe, plates), priceOf);
  // P-542: snapshot the P-519 tier split AT COOK TIME. The log entry is history —
  // prices drift, but what the cook COST FROM is frozen with the plate price.
  // Legacy entries (pre-P-542) have no field and stay honestly silent.
  const priceTiers = costing.lines.reduce(
    (t, { priceEntry, costCents }) => {
      if (costCents === null || !priceEntry) return t;
      if ((priceEntry.source ?? "estimated") === "verified") t.verifiedCount++;
      else t.estimatedCount++;
      return t;
    },
    { verifiedCount: 0, estimatedCount: 0 },
  );
  window.__pulseBump("cookLogs"); // P-412 Pulse
  const logRec = await db.logCook({
    recipeId: recipe.id,
    title: recipe.title,
    tags: recipe.tags,
    date: localDateStr(), // P-207 #18: local calendar day (was UTC)
    servings: plates,
    perPlateCents: perPlateCents(costing.totalUsageCents, plates), // P-571: frozen cook cost = usage model
    missingCount: result?.missing?.length || 0,
    priceTiers, // P-542: honesty travels with the history
  });

  justCooked = logRec.id;

  // P-555 TOAST-FIRST RESTRUCTURE (owner: toasts STILL not appearing after the
  // P-554 XP-chain guard): the real structural flaw was ordering — the toast
  // was the LAST statement, after refreshPantry + a full matcher re-render.
  // Any throw in that render path on real-device data killed the toast while
  // the cook itself had already succeeded. The toast is the cook's RECEIPT:
  // it now fires the moment the log entry is durable, BEFORE any re-render.
  let xpLine = "";
  try {
    const cookedXp = xpForCook({
      perPlateCents: logRec?.perPlateCents,
      servings: plates,
      missingCount: result?.missing?.length || 0,
    });
    xpLine = ` · +${cookedXp} XP`;
  } catch (e) {
    console.error("[cook] XP line failed (toast still shown):", e);
  }
  toast(
    `🍳 Cooked ${recipe.title}${xpLine}`,
    async () => {
      // UNDO: restore each pantry item exactly as it was; delete the log entry we just wrote
      for (const b of before) await db.putPantryItem(b.item);
      if (logRec && logRec.id) await db.remove("cook_log", logRec.id);
      // P-204: undo goes through refreshPantry (same as cook) so running_low flags
      // are re-derived after restore — the raw store.set left stale flags.
      store.set({ cookLog: await db.getAll("cook_log") });
      await refreshPantry();
      if (store.get().planner.plan)
        store.update("planner", { planStale: true }); // P-207: same rule for restores
      renderPantry();
      computeAndRender();
      if (store.get().view === "cooklog") renderCookLog();
      toast("Undone. Your pantry is back as it was.");
    },
    7000,
  );

  // POST-RECEIPT WORK — everything below is cosmetic bookkeeping that must
  // NEVER be able to kill the cook receipt. Any failure here is a console
  // error, not a swallowed toast (the P-554 lesson, applied to the whole
  // downstream render path, not just the XP chain).
  try {
    // refresh EVERYTHING that depends on pantry or log (the stale-cook-log bug).
    // P-113a: through refreshPantry so running_low is re-derived.
    store.set({ cookLog: await db.getAll("cook_log") });
    await refreshPantry();
    if (store.get().planner.plan) store.update("planner", { planStale: true }); // P-207: plan was priced against the OLD pantry
    computeAndRender(); // matcher re-ranks against the new pantry
    // P-402/P-561: sticker-burst celebration for badges that just earned —
    // ONE chokepoint now (snapshot diff), so cook-, decode-, theme- and
    // pantry-unlocks all celebrate through the same code path.
    checkBadgeUnlocks();
    location.hash = "#cooklog"; // the reward: your streak just moved
  } catch (e) {
    console.error(
      "[cook] post-receipt render failed (cook succeeded, toast shown):",
      e,
    );
  }
}

/** Delegated card events: open/close detail, favourite toggle (P-104T). One listener, no per-render rewiring. */
function wireMatcherDelegation() {
  const box = $("#matcher-results");
  if (box.dataset.wired) return;
  box.dataset.wired = "1";
  box.addEventListener("click", (e) => {
    const card = e.target.closest(".mcard");
    if (!card) return;
    const id = card.dataset.id;
    if (e.target.closest(".mc-fav")) {
      const adding = toggleFavourite(id);
      const b = card.querySelector(".mc-fav");
      b.classList.toggle("on", adding);
      b.textContent = adding ? "★" : "☆";
      b.setAttribute("aria-pressed", String(adding));
      toast(
        adding
          ? "Added to favourites ★. These rank a little higher."
          : "Removed from favourites.",
      );
      return;
    }
    if (e.target.closest(".mc-open")) {
      const btn = card.querySelector(".mc-open");
      const panel = card.querySelector(".mc-detail");
      const open = panel.hidden;
      panel.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
      btn.textContent = open ? "Hide recipe" : "See recipe & ingredients";
      card.classList.toggle("is-open", open);
      if (open && !panel.dataset.done) {
        panel.dataset.done = "1";
        const result = store
          .get()
          .matcher.results.find((r) => r.recipeId === id);
        if (result) {
          panel.innerHTML = renderRecipeDetail(result);
          wireDetail(panel, result);
        }
      }
    }
  });
}

// ---------------- PLANNER ----------------

function renderPulse() {
  // P-412: Settings > Pulse (this-device aggregates only)
  const p = window.__pulseRead ? window.__pulseRead() : {};
  const set = (id, v) => {
    const el = $(id);
    if (el) el.textContent = String(v || 0);
  };
  set("#pulse-matcher", p.matcherRuns);
  set("#pulse-plans", p.plansGenerated);
  set("#pulse-cooks", p.cookLogs);
  set("#pulse-decodes", p.decodes);
}

function renderPlanner() {
  const p = store.get().planner;
  $("#week-budget").value = Math.round(p.weekBudgetCents / 100);
  $("#week-servings").value = p.servings;
  updateSavePlanBtn();
  renderSavedPlans();
  const out = $("#plan-output");
  if (!p.plan) {
    out.innerHTML =
      '<div class="empty section-gap"><span class="big">🗓️</span>Set your budget and hit “Plan my week”.<br><span class="muted">Matches come from your pantry — build it first for better plans.</span><br><button type="button" class="chip-link" data-guide="guide-planner">show me how</button></div>';
    return;
  }
  drawPlan(p.plan);
}

// ---------------- P-301: day picker (tap-to-place, swap, single-day regen) ----------------

/** Candidates for planning: same engine inputs as the "Plan my week" button —
 *  the picker must rank from the SAME pool the week was planned from, or the
 *  marginal costs it shows would lie about the plan they edit. */
function computePlannerCandidates(budgetCents) {
  const { pantry, recipes, matcher: m } = store.get();
  const constraints = buildConstraints(m); // P-545: same builder as the Matcher — profile flags can't diverge
  // P-313: the planner plans DINNERS, period (PRD v1 scope). The matcher view's
  // meal chips and the time-of-clock hint are DISCOVERY signals and must never
  // leak into planning: every planning path ranks with a hard dinner intent.
  return rankRecipes(recipes, {
    ...matcherCtx(pantry, budgetCents, constraints),
    mealIntent: "dinner",
    mealStrict: true,
  });
}

/** P-307: one runner for every planning trigger — button, budget dial, plates.
 *  announce=false keeps the frequent dial re-plans quiet. */
function runPlannerPlan({ announce = true } = {}) {
  // P-308 FIX: the old Math.max(10000, ...) silently floored any dial under
  // R100 up to R100 — "R50" planned at R100 and the totals looked lawless.
  // The dial is the user's number: clamp only against negatives/NaN.
  const raw = (parseFloat($("#week-budget").value) || 0) * 100;
  const budgetCents = Number.isFinite(raw) && raw > 0 ? raw : 0;
  const servings = Math.max(1, parseInt($("#week-servings").value, 10) || 2);
  store.update("planner", { weekBudgetCents: budgetCents, servings });
  const candidates = computePlannerCandidates(budgetCents);
  // P-306 FIX: this literal previously OMITTED the pantry. Every planning path
  // now flows through plannerOpts() (single source of truth).
  const plan = planWeek(
    candidates,
    plannerOpts({ weekBudgetCents: budgetCents, servings, days: 7 }),
  );
  store.update("planner", { plan, planStale: false });
  drawPlan(plan);
  if (announce)
    toast(
      `Planned ${plan.mealsPlanned} meals for ${formatRands(plan.totalCents)}`,
    );
}

function plannerOpts(overrides = {}) {
  const p = store.get().planner;
  // P-306: plannerOpts is the SINGLE planning-options authority (every path —
  // plan button, day picker, swap — flows through it, so the pantry sheet can
  // never be omitted again). overrides win; a missing plan (first run) must
  // not crash — budget falls back to the last saved setting, then the PRD default.
  return {
    weekBudgetCents:
      overrides.weekBudgetCents ?? p.plan?.weekBudgetCents ?? 60000,
    servings: overrides.servings ?? p.servings ?? 2,
    days: overrides.days ?? 7,
    ingredients: store.get().ingredients,
    priceEntries: store.get().prices,
    pantry: store.get().pantry, // the sheet consumes this stock as meals commit
    recentCookIds: recentCookIds(), // P-540 (b): 5-day variety bench
    repeatLovers: deliberateRepeaters(), // P-540 (b): deliberate repeaters exempt
  };
}

let pickerOriginDay = -1;

function openDayPicker(dayIndex) {
  const p = store.get().planner;
  if (!p.plan) return;
  const res = dayOptions(
    p.plan,
    computePlannerCandidates(p.plan.weekBudgetCents),
    plannerOpts(),
    dayIndex,
  );
  if (res.error) {
    // a placed meal vanished from the candidate pool (recipe deleted / filters
    // changed) — the honest move is a full re-plan, never a silent list change
    toast('Recipes changed since this plan — hit "Plan my week" to rebuild it');
    return;
  }
  pickerOriginDay = dayIndex;
  const slot = p.plan.days[dayIndex];
  $("#mp-day").textContent = `${slot.day} — pick dinner`;
  $("#mp-sub").textContent = slot.meal
    ? `Replacing ${slot.meal.title}. Tap a recipe for its details.`
    : "Nothing planned here yet. Tap a recipe for its details.";
  // P-307: rows are now deliberately MINIMAL (title · per-plate · cost pill) —
  // everything else lives one tap deeper in the detail modal. A crowded row was
  // the loudest complaint; clean hierarchy beats compressed density.
  // P-308: the old "Clear this day" list row rendered badly and answered no
  // question — clearing lives on the placed meal's detail modal now.
  $("#mp-list").innerHTML = res.options
    .map(
      (
        o,
      ) => `<button type="button" class="mp-option" role="option" tabindex="-1" title="${esc(o.title)} — tap for details" data-detail="${esc(o.recipeId)}">
        <div class="mp-main"><div class="mp-name">${esc(o.title)}</div><div class="mp-meta muted">${formatRands(o.perPlateCents)}/plate${o.matchPct != null ? ` · ${o.matchPct}% match` : ""}</div></div>
        <div class="mp-cost">${
          o.overBudget
            ? `<span class="mp-over">over ${formatRands(o.overByCents)}</span>`
            : o.marginalCents === 0
              ? `<span class="mp-free">✓ on your list</span>`
              : `<span class="mp-add">+${formatRands(o.marginalCents)}</span>`
        }</div>
      </button>`,
    )
    .join("");
  lastPickerState = {
    dayIndex,
    options: res.options,
    candidates: computePlannerCandidates(p.plan.weekBudgetCents),
    originRow: null,
    dayLabel: slot.day,
    dayHasMeal: !!slot.meal,
  };
  $$("#mp-list .mp-option").forEach(
    (b) =>
      (b.onclick = () => {
        if (b.dataset.choice === "clear") {
          handlePick(dayIndex, "clear");
          return;
        }
        lastPickerState.originRow = b;
        openPickDetail(b.dataset.detail);
      }),
  );
  const dlg = $("#meal-picker");
  if (!dlg.open) dlg.showModal();
  const first = $("#mp-list .mp-option:not(:disabled)");
  if (first) first.focus();
}

let lastPickerState = null;

/** P-307: the recipe detail modal — full information one tap under the picker row.
 *  Shows the meal's numbers at the planned plate count, its ingredients with
 *  quantities, a link out to the full recipe in the matcher, and the swap action.
 */
/** P-308: detail for the meal ALREADY on the day — the day cell's first stop.
 *  Stats come from the plan itself (pack-exact); actions: swap, clear, recipe. */
function openPlacedDetail(dayIndex, recipeId) {
  const p = store.get().planner;
  const plan = p.plan;
  const meal = plan?.days?.[dayIndex]?.meal;
  if (!meal || meal.recipeId !== recipeId) return;
  const plates = meal.plates || plan.servings || 2;
  const cands = computePlannerCandidates(plan.weekBudgetCents);
  const cand = cands.find((c) => c.recipeId === recipeId);
  const scale = cand && cand.servings > 0 ? plates / cand.servings : 1;
  const metaById = new Map(store.get().ingredients.map((i) => [i.id, i]));
  $("#mpd-title").textContent = meal.title;
  $("#mpd-day").textContent = `${plan.days[dayIndex].day} · on the plan`;
  $("#mpd-body").innerHTML = `
    <div class="mpd-money">
      <div class="mpd-stat"><span class="lbl">PER PLATE</span><strong>${formatRands(meal.perPlateCents)}</strong></div>
      <div class="mpd-stat"><span class="lbl">${plates} PLATES</span><strong>${formatRands(meal.mealCents ?? meal.perPlateCents * plates)}</strong></div>
      <div class="mpd-stat"><span class="lbl">ADDS TO SHOP</span><strong class="${(meal.marginalCents ?? 0) === 0 ? "mp-free" : "mp-add"}">${(meal.marginalCents ?? 0) === 0 ? "✓ covered" : `+${formatRands(meal.marginalCents)}`}</strong></div>
    </div>
    ${
      cand
        ? `<div class="mpd-meta muted">${meal.matchPct != null ? `${meal.matchPct}% match` : ""}${cand.timeMinutes ? ` · ${cand.timeMinutes} min` : ""}${(cand.tags || []).length ? ` · ${cand.tags.slice(0, 3).join(" · ")}` : ""}</div>
    <h3 class="mpd-h">Ingredients <span class="muted">· ${plates} plates</span></h3>
    <ul class="mpd-ing">${(cand.ingredients || [])
      .map((l) => {
        const meta = metaById.get(l.id);
        return `<li><span>${esc(meta ? meta.name : l.id)}${meta && meta.tier <= STAPLE_TIER_MAX ? ' <span class="mpd-staple">staple</span>' : ""}</span><span class="muted">${trimQty(l.qty * scale)} ${esc(l.unit)}${l.optional ? " · optional" : ""}</span></li>`;
      })
      .join("")}</ul>`
        : `<p class="muted">This recipe's full details open below.</p>`
    }
    <div class="mpd-actions">
      <button type="button" class="btn" id="mpd-swap-day">Swap this day</button>
      <button type="button" class="ghost" id="mpd-clear">Clear this day</button>
      <button type="button" class="ghost" id="mpd-open-recipe">Open full recipe →</button>
    </div>`;
  lastPickerState = null; // placed context: Esc returns to the grid, not a list row
  $("#mpd-swap-day").onclick = () => {
    $("#mp-detail").close();
    openDayPicker(dayIndex);
  };
  $("#mpd-clear").onclick = () => handlePick(dayIndex, "clear");
  // P-556 (owner): the planner detail shows the recipe HERE — the old flow
  // bounced the user to the matcher (view switch + scroll hunt). Same doctrine
  // as the cook log (P-415): the matcher-independent standalone reader.
  $("#mpd-open-recipe").onclick = () => {
    const recipe = store.get().recipes.find((r) => r.id === recipeId);
    $("#mp-detail").close();
    if (recipe)
      openRecipeStandalone(
        recipe,
        `${plan.days[dayIndex].day} · on the plan · ${plates} plate${plates === 1 ? "" : "s"}`,
      );
    else toast("This recipe is no longer in the library.");
  };
  const dlg = $("#mp-detail");
  if (!dlg.open) dlg.showModal();
  $("#mpd-swap-day").focus();
}

function openPickDetail(recipeId) {
  const st = lastPickerState;
  if (!st) return;
  const o = st.options.find((x) => x.recipeId === recipeId);
  const cand = st.candidates.find((c) => c.recipeId === recipeId);
  if (!o || !cand) return;
  const plates = o.plates || 2;
  const scale = plates / (cand.servings > 0 ? cand.servings : 1);
  const metaById = new Map(store.get().ingredients.map((i) => [i.id, i]));
  const dlg = $("#mp-detail");
  $("#mpd-title").textContent = cand.title || o.title;
  $("#mpd-day").textContent = `${st.dayLabel ?? ""}`;
  $("#mpd-body").innerHTML = `
    <div class="mpd-money">
      <div class="mpd-stat"><span class="lbl">PER PLATE</span><strong>${formatRands(o.perPlateCents)}</strong></div>
      <div class="mpd-stat"><span class="lbl">${plates} PLATES</span><strong>${formatRands(o.mealCents ?? o.perPlateCents * plates)}</strong></div>
      <div class="mpd-stat"><span class="lbl">ADDS TO SHOP</span><strong class="${o.overBudget ? "mp-over" : o.marginalCents === 0 ? "mp-free" : "mp-add"}">${o.overBudget ? `over by ${formatRands(o.overByCents)}` : o.marginalCents === 0 ? "✓ nothing" : `+${formatRands(o.marginalCents)}`}</strong></div>
    </div>
    <div class="mpd-meta muted">${o.matchPct != null ? `${o.matchPct}% match` : ""}${cand.timeMinutes ? ` · ${cand.timeMinutes} min` : ""}${(cand.tags || []).length ? ` · ${cand.tags.slice(0, 3).join(" · ")}` : ""}</div>
    <h3 class="mpd-h">Ingredients <span class="muted">· ${plates} plates</span></h3>
    <ul class="mpd-ing">${(cand.ingredients || [])
      .map((l) => {
        const meta = metaById.get(l.id);
        return `<li><span>${esc(meta ? meta.name : l.id)}${meta && meta.tier <= STAPLE_TIER_MAX ? ' <span class="mpd-staple">staple</span>' : ""}</span><span class="muted">${trimQty(l.qty * scale)} ${esc(l.unit)}${l.optional ? " · optional" : ""}</span></li>`;
      })
      .join("")}</ul>
    ${
      o.overBudget
        ? `<p class="mpd-blocked muted">This meal is ${formatRands(o.overByCents)} over your remaining budget — lower the per-day cost or raise the budget and it becomes available.</p>`
        : ""
    }
    <div class="mpd-actions">
      <button type="button" class="btn" id="mpd-swap" ${o.overBudget ? "disabled" : ""}>${st.dayHasMeal ? "Swap this in" : "Plan this meal"}</button>
      <button type="button" class="ghost" id="mpd-open-recipe">Open full recipe →</button>
    </div>`;
  $("#mpd-swap").onclick = () => handlePick(st.dayIndex, recipeId);
  // P-556: read the recipe in its own modal — no matcher redirect.
  $("#mpd-open-recipe").onclick = () => {
    const recipe = store.get().recipes.find((r) => r.id === recipeId);
    $("#mp-detail").close();
    $("#meal-picker").close();
    if (recipe)
      openRecipeStandalone(
        recipe,
        `Planning ${store.get().planner.plan?.days?.[st.dayIndex]?.day || "this day"}`,
      );
    else toast("This recipe is no longer in the library.");
  };
  if (!dlg.open) dlg.showModal();
  $("#mpd-swap") && !$("#mpd-swap").disabled && $("#mpd-swap").focus();
}

/** Arrow-key navigation inside the picker list (roving focus, listbox pattern). */
function wirePickerKeys(e) {
  const opts = $$("#mp-list .mp-option:not(:disabled)");
  if (!opts.length) return;
  const i = opts.indexOf(document.activeElement);
  let j = null;
  if (e.key === "ArrowDown") j = Math.min(opts.length - 1, i + 1);
  else if (e.key === "ArrowUp") j = Math.max(0, i - 1);
  else if (e.key === "Home") j = 0;
  else if (e.key === "End") j = opts.length - 1;
  if (j !== null) {
    e.preventDefault();
    opts[j].focus();
  }
}

function handlePick(dayIndex, choice) {
  const p = store.get().planner;
  const res = applyPick(
    p.plan,
    computePlannerCandidates(p.plan.weekBudgetCents),
    plannerOpts(),
    dayIndex,
    choice,
  );
  if (!res.ok) {
    toast(
      res.reason === "over-budget"
        ? `That one's ${formatRands(res.overByCents)} over your week budget`
        : 'Recipes changed — hit "Plan my week" to rebuild',
    );
    return;
  }
  store.update("planner", { plan: res.plan, planStale: false });
  $("#mp-detail").close(); // P-307: swaps can fire from the detail modal
  $("#meal-picker").close();
  drawPlan(res.plan);
  const cell = $(`.day-cell[data-day="${dayIndex}"]`);
  if (cell) cell.focus();
  const slot = res.plan.days[dayIndex];
  toast(
    choice === "clear"
      ? `${slot.day} cleared — shop list now ${formatRands(res.plan.totalCents)}`
      : `${slot.day}: ${slot.meal.title} — shop list now ${formatRands(res.plan.totalCents)}`,
  );
}

/** P-306: full plan report as a real PDF file — meals, per-ingredient quantities,
 *  shopping list, pantry use, totals. Generated 100% locally (pdf.js has no deps). */
function downloadPlanPdf(plan) {
  if (!plan) return;
  try {
    const st = store.get();
    const metaById = new Map(st.ingredients.map((i) => [i.id, i]));
    const s = db.getSettings();
    const themeId = s.display?.theme || "spaza-classic";
    const theme = THEMES.find((t) => t.id === themeId) || THEMES[0];
    // P-563: the PDF wears the CURRENT site theme and carries the masterclass
    // inputs (corpus, pantry, prices, household) so every derived section
    // computes from real data at export time. Invalid tokens fall back inside.
    const bytes = buildPlanPdf(plan, {
      metaById,
      recipes: st.recipes,
      pantry: st.pantry,
      prices: st.prices,
      settings: { household: s.profile?.household || 2, themeName: theme.name },
      tokens: PDF_TOKENS[themeId],
      date: new Date(),
    });
    const blob = new Blob([bytes], { type: "application/pdf" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = planPdfName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 8000);
    toast(`Masterclass plan PDF downloaded (${theme.name})`);
  } catch (e) {
    console.error("pdf build failed", e);
    toast(
      "Could not build the PDF — the plan is still in the slip and WhatsApp copy",
    );
  }
}

function drawPlan(plan) {
  window.__pulseBump("plansGenerated"); // P-412 Pulse
  updateSavePlanBtn(); // P-310b: every plan-mutating path funnels through here
  const cls =
    plan.status === "under" ? "" : plan.status === "near" ? "near" : "over";
  // P-207 #13/#14 (DeepSeek batch 2): a plan is a derived artifact. Cooking (or
  // undoing) changes the pantry it was computed against — the honest move is a
  // visible stale marker + one tap to recompute, never silently showing the old
  // list as current.
  const stale = store.get().planner.planStale;
  $("#plan-output").innerHTML = `
    ${
      stale
        ? `<div class="plan-stale" role="status"><span aria-hidden="true">⚠️</span>
      <strong>Your kitchen changed since this plan.</strong>
      <span class="muted">Hit "Plan my week" to refresh the list against what you have now.</span></div>`
        : ""
    }
    <div class="panel section-gap">
      <div class="week-grid" role="group" aria-label="Week plan — arrow keys move between days, Enter picks">${plan.days
        .map((d, i) =>
          d.meal
            ? `<button type="button" class="day-cell" data-day="${i}" aria-label="${d.day}: ${esc(d.meal.title)}, ${formatRands(d.meal.perPlateCents)} per plate, ${formatRands(d.meal.mealCents ?? d.meal.perPlateCents * (d.meal.plates || 2))} for ${d.meal.plates || 2} plates. Tap for details, swap or clear."><div class="d">${d.day}</div><div class="meal-title">${esc(d.meal.title)}</div><div class="cell-pricing"><span class="money money--sm">${formatRands(d.meal.perPlateCents)}/plate</span><span class="cell-total money money--sm">${formatRands(d.meal.mealCents ?? d.meal.perPlateCents * (d.meal.plates || 2))}<i class="cell-plates"> · ${d.meal.plates || 2}p</i></span></div><div class="swap-hint">tap for details</div></button>`
            : `<button type="button" class="day-cell empty-day" data-day="${i}" aria-label="${d.day}: empty. Tap to plan a meal."><div class="d">${d.day}</div><span class="plan-hint">+ plan dinner</span></button>`,
        )
        .join("")}
      </div>
      ${(plan.warnings || []).map((w) => `<p class="muted plan-warning" role="note">${esc(w)}</p>`).join("")}
      <div class="budget-bar ${cls} section-gap"><i style="width:${Math.min(100, (plan.totalCents / plan.weekBudgetCents) * 100)}%"></i></div>
      <div class="totals section-gap">
        <div class="stat"><div class="lbl">WEEK TOTAL</div><span class="money ${plan.status === "under" ? "" : plan.status === "near" ? "money--warn" : "money--over"}">${formatRands(plan.totalCents)}</span></div>
        <div class="stat"><div class="lbl">BUDGET</div><strong style="font-size:1.3rem">${formatRands(plan.weekBudgetCents)}</strong></div>
        <div class="stat"><div class="lbl">MEALS PLANNED</div><strong style="font-size:1.3rem">${plan.mealsPlanned}/7</strong></div>
        <div class="stat"><div class="lbl">SAVED VS EATING OUT</div><strong style="font-size:1.3rem;color:var(--clr-coin)">${formatRands(Math.max(0, plan.savingsCents))}</strong></div>
        ${(plan.pantryCookedCents || 0) > 0 ? `<div class="stat stat--pantry"><div class="lbl">COOKED FROM PANTRY</div><strong style="font-size:1.3rem;color:var(--clr-brand-strong)">${formatRands(plan.pantryCookedCents)}</strong></div>` : ""}
      </div>
    </div>
    <div class="panel slip section-gap" id="till-slip">
      <div class="slip-head">
        <div>
          <div class="slip-brand">RANDPLATES TILL SLIP</div>
          <div class="slip-sub">${new Date().toLocaleDateString("en-ZA", { weekday: "long", day: "numeric", month: "long", year: "numeric" })} · ${plan.mealsPlanned} meals · budget ${formatRands(plan.weekBudgetCents)}</div>
        </div>
        <div class="slip-actions">
          <button class="ghost small" id="copy-list" title="Copy the whole slip for WhatsApp">📋 WhatsApp</button>
          <button class="ghost small" id="pdf-plan" title="Masterclass plan report: analysis, shopping, pantry - themed and offline">🧾 PDF</button>
        </div>
      </div>
      ${(function renderWeek() {
        const meals = plan.days.filter((d) => d.meal);
        if (!meals.length) return "";
        return `<div class="slip-week">
          <div class="slip-sec-title">THE WEEK</div>
          ${meals
            .map(
              (d) => `<div class="week-line">
            <div><span class="w-day">${esc(d.day.slice(0, 3).toUpperCase())}</span> <span class="w-title">${esc(d.meal.title)}</span>
              <div class="sub">${d.meal.plates || 2} plate${(d.meal.plates || 2) === 1 ? "" : "s"} · ${formatRands(d.meal.perPlateCents)}/plate${d.meal.real === false ? " · staple-only" : ""}</div></div>
            <span class="money money--sm">${formatRands(d.meal.mealCents ?? d.meal.perPlateCents * (d.meal.plates || 2))}</span>
          </div>`,
            )
            .join("")}
          ${plan.pantryCookedCents > 0 ? `<div class="week-line pantry-note"><div class="n">COOKED FROM YOUR PANTRY</div><span class="money money--sm">${formatRands(plan.pantryCookedCents)}</span></div>` : ""}
        </div>`;
      })()}
      ${(function renderAisles() {
        // shoppingList arrives aisle-sorted from the engine — group in order
        const sections = [];
        for (const i of plan.shoppingList) {
          const last = sections[sections.length - 1];
          if (!last || last.aisle !== i.aisle)
            sections.push({ aisle: i.aisle, items: [i] });
          else last.items.push(i);
        }
        return sections
          .map((sec) => {
            const sub = sec.items.reduce((t, i) => t + i.priceCents, 0);
            return `<details class="aisle-sec" open>
            <summary><span class="as-name">${esc(sec.aisle.toUpperCase())}</span><span class="as-meta">${sec.items.length} · ${formatRands(sub)}</span></summary>
            ${sec.items
              .map(
                (i) => `<div class="shop-line" data-id="${esc(i.id)}">
              <div><span class="n">${esc(i.name)}${i.source === "estimated" ? ' <span class="sub" title="estimated price — verify in store">≈</span>' : ""}</span> <span class="sub">${i.packs} × ${i.pack_qty} ${esc(i.pack_unit)}</span></div>
              <span class="money money--sm" style="font-size:1rem">${formatRands(i.priceCents)}</span></div>`,
              )
              .join("")}
          </details>`;
          })
          .join("");
      })()}
      ${(function renderPantryUse() {
        // P-306: what the plan EATS from your kitchen — the slip's other half.
        // An R0.00 covered week reads as a full document, not an error.
        const use = plan.pantryUse || [];
        if (!use.length) return "";
        const total = use.reduce((t, u) => t + (u.valueCents || 0), 0);
        return `<div class="slip-week">
          <div class="slip-sec-title">FROM YOUR PANTRY</div>
          ${use
            .map(
              (u) => `<div class="week-line">
            <div><span class="w-title">${esc(u.name)}</span>
              <div class="sub">uses ${trimQty(u.qty)} ${esc(u.unit)}</div></div>
            <span class="money money--sm">${u.valueCents !== null ? formatRands(u.valueCents) : "—"}</span>
          </div>`,
            )
            .join("")}
          <div class="week-line pantry-note"><div class="n">KITCHEN STOCK USED</div><span class="money money--sm">${formatRands(total)}</span></div>
        </div>`;
      })()}
      ${(function renderLeftovers() {
        // P-540 (c): the pack surplus that spoils — an honest USE-SOON block,
        // same language as the pantry's running-low tags.
        const lo = plan.packLeftovers || [];
        if (!lo.length) return "";
        return `<div class="slip-week use-soon-block">
          <div class="slip-sec-title">USE SOON — LEFT FROM YOUR PACKS</div>
          ${lo
            .map(
              (
                l,
              ) => `<div class="week-line"><div><span class="w-title">${esc(l.name)}</span>
            <div class="sub">${trimQty(l.qty)} ${esc(l.unit)} left · ${l.shelfDays}-day shelf</div></div>
            <span class="money money--sm">${formatRands(l.valueCents)}</span></div>`,
            )
            .join("")}
        </div>`;
      })()}
      <div class="shop-line total-line"><div class="n">TOTAL</div><span class="money money--sm">${formatRands(plan.totalCents)}</span></div>
      ${
        plan.totalCents === 0
          ? '<div class="slip-sub shop-note">Nothing to buy — everything on this plan is already in your kitchen.</div>'
          : ""
      }
      ${(function renderTierFoot() {
        // P-540 (d): the P-519 honesty line — verified vs estimated, with the
        // ≈ legend so the slip reads like a receipt that admits its sources.
        const t = plan.priceTiers;
        if (!t || (!t.verifiedCount && !t.estimatedCount)) return "";
        return `<div class="slip-sub tier-foot">${t.verifiedCount} verified price${t.verifiedCount === 1 ? "" : "s"} (${formatRands(t.verified)}) · ${t.estimatedCount} estimated ≈ (${formatRands(t.estimated)})</div>`;
      })()}
      <div class="slip-bar" aria-hidden="true"></div>
      <div class="slip-foot">* * * * THANK YOU — STAY FED * * * *</div>
    </div>`;
  $("#copy-list").onclick = async () => {
    const text = shoppingListToText(plan);
    try {
      await navigator.clipboard.writeText(text);
      toast("Shopping list copied — paste it into WhatsApp 👌");
    } catch {
      // fallback for older browsers / http
      prompt("Copy your shopping list:", text);
    }
  };
}

// ---------------- P-310a: SAVED PLANS ----------------
// A plan is derivable, but the ARRANGEMENT is the user's work. Saving snapshots
// the exact grid (+ the pantry it was planned against); loading restores it
// verbatim — and if the kitchen changed since, honestly flags it stale rather
// than pretending it still matches.

function pantryFingerprint() {
  return store
    .get()
    .pantry.map((p) => `${p.id}:${p.qty}`)
    .sort()
    .join("|");
}

// P-310b hardening: savedPlans must never be read unguarded — a partially
// applied build (or an import that wipes state) left `undefined` here and the
// save handler died SILENTLY, which read to the owner as "no toast, not working".
// Every read goes through this accessor; every db call is wrapped so failures
// surface as toasts, never as silent dead clicks.
const savedPlans = () => store.get().savedPlans || [];

/** The Save button only exists for a plan worth saving: enabled exactly when
 *  a rendered plan with at least one meal is on screen. Called from drawPlan
 *  (every mutating path funnels through it) and renderPlanner (no-plan case). */
function updateSavePlanBtn() {
  const btn = $("#save-plan");
  if (btn) btn.disabled = !store.get().planner.plan?.mealsPlanned;
}

function openSavePlanDialog() {
  const p = store.get().planner;
  if (!p.plan || !p.plan.mealsPlanned) {
    toast("Nothing to save yet — plan a week first");
    return;
  }
  $("#save-plan-name").value =
    `R${Math.round(p.plan.totalCents / 100)} week — ${p.plan.mealsPlanned} dinners`;
  $("#save-plan-meta").textContent =
    `${formatRands(p.weekBudgetCents)} budget · ${p.servings} plates/meal · ${localDateStr()}`;
  $("#save-plan-dialog").showModal();
}

async function confirmSavePlan() {
  const p = store.get().planner;
  if (!p.plan || !p.plan.mealsPlanned) {
    toast("Nothing to save yet — plan a week first");
    return;
  }
  const name = ($("#save-plan-name").value || "").trim() || "My week";
  try {
    const same = savedPlans().find((s) => s.name === name);
    if (same && !confirm(`A plan called “${name}” exists — overwrite it?`))
      return;
    await db.put("saved_plans", {
      id: same ? same.id : undefined,
      name,
      savedOn: localDateStr(),
      weekBudgetCents: p.weekBudgetCents,
      servings: p.servings,
      pantryFp: pantryFingerprint(),
      plan: p.plan,
    });
    store.set({ savedPlans: await db.getAll("saved_plans") });
    checkBadgeUnlocks(); // P-561: the-planner fires on the first saved week
  } catch (err) {
    // never a silent dead click: a failed save says so (console keeps the cause)
    console.error("[saved-plans] save failed:", err);
    toast("Could not save — check the console for details");
    return;
  }
  $("#save-plan-dialog").close();
  renderSavedPlans();
  toast("Plan saved ✓");
  // standing UX rule: new content reveals BELOW the sticky chrome, measured
  const panel = $("#saved-plans");
  const chromeH = $(".topbar")?.getBoundingClientRect().height || 64;
  window.scrollTo({
    top: panel.getBoundingClientRect().top + window.scrollY - chromeH - 12,
    behavior: motionBehavior(),
  });
}

function loadSavedPlan(id) {
  const rec = savedPlans().find((s) => s.id === id);
  if (!rec || !rec.plan) {
    toast("That saved plan looks corrupt — re-save it");
    return;
  }
  if (!confirm("Load replaces your changes.")) return; // honest, under 12 words
  const staleNow = rec.pantryFp !== pantryFingerprint();
  store.update("planner", {
    plan: rec.plan,
    weekBudgetCents: rec.weekBudgetCents,
    servings: rec.servings,
    planStale: staleNow,
  });
  $("#week-budget").value = Math.round(rec.weekBudgetCents / 100);
  $("#week-servings").value = rec.servings;
  drawPlan(rec.plan);
  toast(
    staleNow ? "Loaded — your kitchen changed since saving" : "Plan loaded ✓",
  );
}

function downloadSavedSlip(rec) {
  const text = shoppingListToText(rec.plan);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  a.download = `${rec.name.replace(/[^a-z0-9 -]/gi, "")} — till slip.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function deleteSavedPlan(id) {
  try {
    await db.remove("saved_plans", id);
    store.set({ savedPlans: await db.getAll("saved_plans") });
  } catch (err) {
    console.error("[saved-plans] delete failed:", err);
    toast("Could not delete — check the console");
    return;
  }
  renderSavedPlans();
  toast("Plan deleted");
}

function renderSavedPlans() {
  const box = $("#saved-plans");
  if (!box) return;
  const plans = savedPlans();
  box.hidden = !plans.length;
  // FIX (found by qa-p310a): on empty, CLEAR the DOM too — hiding alone left
  // deleted rows in the tree, so reload-less state checks saw ghost rows.
  if (!plans.length) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = `
    <div class="panel">
      <h2 class="sp-title">Saved plans</h2>
      ${plans
        .map(
          (s) => `
        <div class="sp-row" data-id="${esc(s.id)}">
          <div class="sp-info">
            <div class="sp-name">${esc(s.name)}</div>
            <div class="muted sp-meta">${esc(s.savedOn)} · ${formatRands(s.plan.totalCents)} · ${s.plan.mealsPlanned || s.plan.days.filter((d) => d.meal).length} dinners</div>
          </div>
          <div class="sp-actions">
            <button type="button" class="small" data-load="${esc(s.id)}">Load</button>
            <button type="button" class="ghost small" data-slip="${esc(s.id)}">Slip</button>
            <button type="button" class="ghost small" data-del="${esc(s.id)}">Delete</button>
          </div>
        </div>`,
        )
        .join("")}
    </div>`;
}

function wireSavedPlans() {
  $("#save-plan").addEventListener("click", openSavePlanDialog);
  $("#save-plan-close").addEventListener("click", () =>
    $("#save-plan-dialog").close(),
  );
  $("#save-plan-confirm").addEventListener("click", confirmSavePlan);
  $("#saved-plans").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    if (btn.dataset.load) loadSavedPlan(btn.dataset.load);
    else if (btn.dataset.slip)
      downloadSavedSlip(savedPlans().find((s) => s.id === btn.dataset.slip));
    else if (btn.dataset.del) deleteSavedPlan(btn.dataset.del);
  });
}

// ---------------- EXPLORER ----------------

// P-417: everything about one ingredient — every retailer that stocks it,
// what it costs you right now (pantry), and the recipes that use it. The
// "never leave RandPlates" panel: compare, decide, cook.
function openIngModal(ing) {
  const { prices, recipes, pantry } = store.get();
  $("#ing-title").textContent = ing.name;
  $("#ing-sub").textContent =
    `${ing.aisle} · usually bought as ${packLabel(ing.unit_basis, ing)}`.trim();
  const rows = prices
    .filter((p) => p.ingredient_id === ing.id)
    .sort((a, b) => a.price_cents - b.price_cents);
  const best = rows[0];
  const inPantry = pantry.find((p) => p.id === ing.id);
  const usedIn = recipes.filter((r) =>
    (r.ingredients || []).some((l) => l.id === ing.id),
  );
  const unit100 = (p) =>
    ["g", "ml"].includes(p.pack_unit)
      ? `R${(p.price_cents / p.pack_qty).toFixed(2)} / 100${p.pack_unit}`
      : `R${(p.price_cents / p.pack_qty / 100).toFixed(2)} / ${p.pack_unit}`; // P-509c: cents/unit -> rands; P-418 count-pack per-unit
  // P-535 DOSSIER FACTS: shelf-life + freshness chips make the dossier complete
  const shelfDays = ing.shelf_life_days;
  const soon = inPantry ? useSoonInfo(inPantry) : null;
  const est = inPantry ? expiryEstimate(inPantry) : null;
  const soonLine = soon
    ? est.kind === "user"
      ? `Use soon: your expiry date is <strong>${esc(inPantry.expiry)}</strong> (${est.days <= 0 ? "already past" : est.days + (est.days === 1 ? " day" : " days") + " left"})${est.shelf ? ` · typical shelf life ${est.shelf}d` : ""}`
      : est.kind === "estimate"
        ? `Use soon: <strong>~${est.days} ${est.days === 1 ? "day" : "days"} left</strong> by estimate — added ${esc(String(est.added).slice(0, 10))} · typical shelf life ${est.shelf}d. Set a real expiry date below and we'll use that instead.`
        : `Use soon: typical shelf life is only <strong>${est.shelf} days</strong> — this is a short-shelf item. Set a real expiry date below and we'll use that instead.`
    : est
      ? `<span class="muted">No expiry set — <strong>~${est.kind === "estimate" ? est.days + " days left by estimate" : "typical shelf life " + est.shelf + "d"}</strong>. Set a real expiry date below and we'll use that instead.</span>`
      : "";
  const dossierFacts = `
    <div class="ing-facts">
      ${shelfDays ? `<span class="chip">Shelf life ${shelfDays}d${shelfDays <= 7 ? " · short-shelf" : ""}</span>` : ""}
      <span class="chip">${esc(aisleLabel(ing.aisle))}</span>
    </div>
    ${soonLine ? `<div class="ing-soon">${soonLine}</div>` : ""}`;

  // P-535 PANTRY RECORD EDITOR: expiry / nickname / pack override / notes —
  // persisted on the pantry record, driving use-soon math + row display.
  const recordEditor = `
    <h3 class="mpd-h">${inPantry ? "Your pantry record" : "Add to pantry"}</h3>
    ${
      inPantry
        ? `
      <form id="ing-record" class="ing-form" data-id="${esc(ing.id)}">
        <label class="if-field">Expiry date (beats shelf-life guesswork)
          <input type="date" name="expiry" value="${esc(inPantry.expiry || "")}">
        </label>
        <label class="if-field">Nickname (what you call it)
          <input type="text" name="nickname" value="${esc(inPantry.nickname || "")}" placeholder="${esc(ing.name)}" maxlength="40">
        </label>
        <label class="if-field">Your usual pack
          <span class="if-pack">
            <input type="number" name="pack_qty" min="0" step="any" value="${inPantry.pack_override ? esc(String(inPantry.pack_override.qty)) : ""}" placeholder="${ing.unit_basis ? ing.unit_basis.qty : ""}" aria-label="Pack quantity">
            <input type="text" name="pack_unit" value="${inPantry.pack_override ? esc(inPantry.pack_override.unit) : ""}" placeholder="${ing.unit_basis ? esc(ing.unit_basis.unit) : "g"}" aria-label="Pack unit">
          </span>
        </label>
        <label class="if-field if-field--wide">Notes (how you store it, which brand)
          <textarea name="notes" rows="2" placeholder="e.g. decanted into a jar">${esc(inPantry.notes || "")}</textarea>
        </label>
        <div class="if-actions">
          <button class="btn small" type="submit">Save record</button>
          ${inPantry.expiry || inPantry.nickname || inPantry.pack_override || inPantry.notes ? '<button class="ghost small" type="button" id="ing-record-reset">Reset fields</button>' : ""}
        </div>
      </form>`
        : `<button class="btn small" type="button" id="ing-add-pantry" data-id="${esc(ing.id)}">Add ${esc(ing.name)} to my pantry</button>`
    }`;

  $("#ing-body").innerHTML = `
    ${inPantry ? `<p class="ing-pantry">🧺 In your pantry: <strong>${esc(String(inPantry.qty))} ${esc(inPantry.unit || "")}</strong>${inPantry.notes ? ` — ${esc(inPantry.notes)}` : ""}</p>` : ""}
    ${dossierFacts}
    ${recordEditor}
    <h3 class="mpd-h">Prices across retailers</h3>
    <p class="muted ing-report-line">Wrong price? <a id="ing-price-report" href="#">Tell me what you saw at the store</a> — it gets re-verified.</p>
    ${
      rows.length
        ? `<table class="price-table ing-compare">
      <thead><tr><th>Store</th><th>Brand &amp; pack</th><th>Price</th><th>Per 100g/ml</th><th>Checked</th></tr></thead>
      <tbody>${rows
        .map(
          (p, i) => `<tr class="${i === 0 ? "best-row" : ""}">
        <td><strong>${esc(p.store)}</strong>${i === 0 ? '<span class="best-tag">best price</span>' : ""}</td>
        <td class="muted">${esc(p.brand || "house brand")} · ${p.pack_qty} ${esc(p.pack_unit)}</td>
        <td class="num"><span class="price-tag">${formatRands(p.price_cents)}</span></td>
        <td class="muted">${unit100(p)}</td>
        <td class="muted">${(() => {
          const f = freshnessOf(p);
          const srcTier = p.source === "verified" ? "verified" : "estimated";
          return (
            `<span class="px-src px-src--${srcTier}" title="${srcTier === "verified" ? "In-store verified price." : "Estimated price — verify in store."}">${srcTier === "verified" ? "✓" : "≈"}</span> ` +
            (f
              ? `<span class="chip ${f.tier === "fresh" ? "ok" : f.tier === "aging" ? "warn" : "warn stale"}" title="${f.tier}">${esc(p.last_verified)} · ${esc(f.label)}</span>`
              : '<span class="chip warn" title="estimate until till-verified">estimate</span>')
          );
        })()}</td>
      </tr>`,
        )
        .join("")}</tbody></table>`
        : '<p class="muted">No verified prices for this ingredient yet.</p>'
    }
    <h3 class="mpd-h">Cook it (${usedIn.length} recipe${usedIn.length === 1 ? "" : "s"})</h3>
    ${usedIn.length ? `<button class="btn small" type="button" id="ing-match-now">Match now — ${usedIn.length} recipe${usedIn.length === 1 ? "" : "s"} use this</button>` : ""}
    ${
      usedIn.length
        ? `<div class="ing-recipes">${usedIn
            .slice(0, 12)
            .map(
              (r) => `
      <a class="ing-recipe" href="#matcher" data-recipe="${esc(r.id)}">
        <strong>${esc(r.title)}</strong>
        <span class="muted">${r.time_minutes ? r.time_minutes + " min" : ""}${(r.tags || []).slice(0, 2).length ? " · " + r.tags.slice(0, 2).join(" · ") : ""}</span>
      </a>`,
            )
            .join(
              "",
            )}${usedIn.length > 12 ? `<span class="muted">+ ${usedIn.length - 12} more in the Matcher</span>` : ""}</div>`
        : '<p class="muted">Not used in any recipe yet — it may be decoder-only.</p>'
    }
  `;
  const dlg = $("#ing-modal");
  if (!dlg.open) dlg.showModal();
  $("#ing-close").onclick = () => dlg.close();
  const rLink = $("#ing-price-report");
  if (rLink)
    rLink.href =
      "mailto:tadiwachopambaweb@gmail.com" +
      "?subject=" +
      encodeURIComponent("RandPlates price correction") +
      "&body=" +
      encodeURIComponent(
        "Hi Tadiwa,\n\nI spotted a price that looks wrong in RandPlates.\n\n" +
          "Item: " +
          ing.name +
          "\nStore (and branch if you remember): \nPrice on the shelf (R): \n" +
          "Date I saw it: \n\nThanks — this helps every plate stay honest.",
      ); // item pre-filled

  // P-535 wiring — record editor: save / reset / add-to-pantry / match-now
  const form = $("#ing-record");
  if (form)
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const id = form.dataset.id;
      const rec = store.get().pantry.find((p) => p.id === id);
      if (!rec) return;
      const fd = new FormData(form);
      const expiryRaw = String(fd.get("expiry") || "").trim();
      const nickRaw = String(fd.get("nickname") || "").trim();
      const pqRaw = parseFloat(fd.get("pack_qty"));
      const puRaw = String(fd.get("pack_unit") || "")
        .trim()
        .toLowerCase();
      const notesRaw = String(fd.get("notes") || "").trim();
      // refuse-over-guess: a bad date is dropped with an honest toast, not saved
      if (
        expiryRaw &&
        Number.isNaN(new Date(expiryRaw + "T00:00:00").getTime())
      ) {
        toast("That expiry date does not look right — it was not saved.");
        return;
      }
      if (expiryRaw) {
        const y = new Date(expiryRaw + "T00:00:00").getFullYear();
        if (y < 2020 || y > 2035) {
          toast("Expiry year looks wrong (2020-2035) — not saved.");
          return;
        }
      }
      const next = { ...rec };
      if (expiryRaw) next.expiry = expiryRaw;
      else delete next.expiry;
      if (nickRaw) next.nickname = nickRaw;
      else delete next.nickname;
      if (notesRaw) next.notes = notesRaw;
      else delete next.notes;
      if (
        pqRaw > 0 &&
        puRaw &&
        ["g", "ml", "l", "kg", "unit", "bunch", "can", "tin"].includes(puRaw)
      ) {
        next.pack_override = { qty: pqRaw, unit: puRaw };
      } else {
        delete next.pack_override;
        if ((pqRaw || puRaw) && !(pqRaw > 0 && puRaw))
          toast("Pack override needs both a size and a unit — not saved.");
      }
      await db.putPantryItem(next);
      await refreshPantry();
      toast(`Saved: ${ingredientMeta(id)?.name || id} record updated.`);
      openIngModal(ingredientMeta(id)); // re-render the dossier with the new facts
    };
  $("#ing-record-reset")?.addEventListener("click", async () => {
    const id = $("#ing-record").dataset.id;
    const rec = store.get().pantry.find((p) => p.id === id);
    if (!rec) return;
    const next = { ...rec };
    delete next.expiry;
    delete next.nickname;
    delete next.notes;
    delete next.pack_override;
    await db.putPantryItem(next);
    await refreshPantry();
    toast("Cleared — back to registry defaults.");
    openIngModal(ingredientMeta(id));
  });
  $("#ing-add-pantry")?.addEventListener("click", async (ev) => {
    const id = ev.currentTarget.dataset.id;
    const meta = ingredientMeta(id);
    await db.putPantryItem({
      id,
      qty: meta.unit_basis?.qty || 1,
      unit: meta.unit_basis?.unit || "g",
      running_low: false,
    });
    await refreshPantry();
    toast(`Added ${meta?.name || id} to your pantry.`);
    openIngModal(meta);
  });
  const matchNow = $("#ing-match-now");
  if (matchNow)
    matchNow.onclick = () => {
      store.set({
        matcher: { ...store.get().matcher, ingredientFocus: ing.id },
      });
      dlg.close();
      location.hash = "#matcher";
      renderResults();
    };
  // P-418 red-team fix: the links used to deep-link into the matcher — where
  // desserts/breakfasts may not even render (dinner pool). The doctrine fix:
  // open the full recipe (steps + Cook it) RIGHT HERE, matcher-independent.
  $$("#ing-body a.ing-recipe").forEach(
    (a) =>
      (a.onclick = (ev) => {
        ev.preventDefault();
        const recipe = store
          .get()
          .recipes.find((r) => r.id === a.dataset.recipe);
        dlg.close();
        if (recipe) openRecipeStandalone(recipe, `uses ${ing.name}`);
        else {
          location.hash = "#matcher";
        }
      }),
  );
}

/** P-414 price-freshness layer: a verified date is only honest with its AGE.
 *  Tiers: fresh <= 14d · aging 15-30d · stale > 30d. Estimated rows carry no
 *  verified date and stay under their own "estimate" contract (never guessed).
 *  Returns null for unverified rows so callers render their estimate branch. */
function freshnessOf(p) {
  if (!p || !p.last_verified) return null;
  const days = Math.max(
    0,
    Math.floor(
      (Date.now() - new Date(p.last_verified + "T00:00:00").getTime()) / 864e5,
    ),
  );
  const tier = days <= 14 ? "fresh" : days <= 30 ? "aging" : "stale";
  const label =
    days === 0
      ? "today"
      : days < 14
        ? days + "d ago"
        : days < 60
          ? Math.round(days / 7) + "w ago"
          : Math.round(days / 30) + "mo ago";
  return { days, tier, label };
}

function renderExplorer() {
  const { prices, ingredients, priceMeta } = store.get();
  // P-406: freshness renders as the human month ("October 2026") from the
  // verified stamp — the trust line must read like a claim, not a debug field.
  const stamp = priceMeta.last_verified || localDateStr();
  $("#explorer-stamp").textContent = new Date(
    stamp + "T00:00:00",
  ).toLocaleDateString("en-ZA", { month: "long", year: "numeric" });

  // ---- P-417 filters: store chips, aisle chips, search, sort ----
  const storeBox = $("#px-store-chips");
  const aisleBox = $("#px-aisle-chips");
  const searchEl = $("#px-search");
  const sortEl = $("#px-sort");
  const state = { store: "All stores", aisles: new Set(), q: "", sort: "name" };

  const stores = ["All stores", ...new Set(prices.map((p) => p.store))];
  storeBox.innerHTML = stores
    .map(
      (s) =>
        `<button type="button" class="px-chip${s === state.store ? " on" : ""}" data-store="${esc(s)}">${esc(s)}</button>`,
    )
    .join("");
  storeBox.querySelectorAll(".px-chip").forEach(
    (c) =>
      (c.onclick = () => {
        state.store = c.dataset.store;
        storeBox
          .querySelectorAll(".px-chip")
          .forEach((x) =>
            x.classList.toggle("on", x.dataset.store === state.store),
          );
        draw();
      }),
  );

  const aisles = [
    ...new Set(ingredients.filter((i) => priceOf(i.id)).map((i) => i.aisle)),
  ].sort();
  aisleBox.innerHTML = aisles
    .map(
      (a) =>
        `<button type="button" class="px-chip${state.aisles.has(a) ? " on" : ""}" data-aisle="${esc(a)}">${esc(a)}</button>`,
    )
    .join("");
  aisleBox.querySelectorAll(".px-chip").forEach(
    (c) =>
      (c.onclick = () => {
        const a = c.dataset.aisle;
        state.aisles.has(a) ? state.aisles.delete(a) : state.aisles.add(a);
        c.classList.toggle("on", state.aisles.has(a));
        draw();
      }),
  );

  searchEl.oninput = () => {
    state.q = normalize(searchEl.value);
    draw();
  };
  sortEl.onchange = () => {
    state.sort = sortEl.value;
    draw();
  };

  // P-414: per-aisle cheapest-store hint — counts, per aisle, which store wins
  // the most lowest-per-unit comparisons. Only aisles with >= 3 items priced
  // at >= 2 stores qualify — a 1-item "win" is noise, not a shopping hint.
  const drawHints = () => {
    // P-509: band-aware wins — a store only counts a win when it beats another
    // store on the SAME pack band (same aisle, same unit, same size class).
    // The old code compared c/g against c/l and 500g against 2kg: skew wins.
    // estimate-store rows are research placeholders, not a shop you can walk
    // into — they never compete in the hints either.
    const bandOf = packBandTable(
      prices
        .filter((p) => ingredientMeta(p.ingredient_id))
        .map((p) => ({
          aisle: ingredientMeta(p.ingredient_id)?.aisle || "other",
          unit: p.pack_unit,
          qty: p.pack_qty,
        })),
    );
    const wins = {}; // aisle -> { store: nWins, compared }
    for (const ing of ingredients) {
      const rows = prices.filter(
        (x) => x.ingredient_id === ing.id && x.store !== "estimate",
      );
      const groups = {};
      for (const x of rows) {
        const band = bandOf(ing.aisle || "other", x.pack_unit, x.pack_qty);
        const k = x.pack_unit + "|" + band;
        (groups[k] ||= []).push(x);
      }
      for (const g of Object.values(groups)) {
        const perStore = {};
        for (const x of g) {
          const u = x.price_cents / x.pack_qty;
          if (perStore[x.store] === undefined || u < perStore[x.store].u)
            perStore[x.store] = { u };
        }
        const sts = Object.keys(perStore);
        if (sts.length < 2) continue; // no same-band competitor -> no win counted
        let best = sts[0];
        for (const s of sts) if (perStore[s].u < perStore[best].u) best = s;
        wins[ing.aisle] = wins[ing.aisle] || { storeWins: {}, compared: 0 };
        wins[ing.aisle].storeWins[best] =
          (wins[ing.aisle].storeWins[best] || 0) + 1;
        wins[ing.aisle].compared++;
      }
    }
    const box = $("#px-aisle-hints");
    if (!box) return;
    const chips = Object.entries(wins)
      .filter(([, w]) => w.compared >= 3)
      .map(([aisle, w]) => {
        const [store, n] = Object.entries(w.storeWins).sort(
          (a, b) => b[1] - a[1],
        )[0];
        return `<button type="button" class="px-hint" data-store="${esc(store)}" data-aisle="${esc(aisle)}"
          title="Across ${w.compared} ${aisle.toLowerCase()} items priced at 2+ stores, ${esc(store)} had the most lowest unit prices. Tap to filter."
          aria-label="Show ${esc(store)} ${esc(aisle)} prices"><span class="px-hint-tag">cheapest</span>${esc(store)} · ${esc(aisle.toLowerCase())} <span class="muted">(${n}/${w.compared})</span></button>`;
      })
      .join("");
    box.innerHTML = chips;
    box.querySelectorAll(".px-hint").forEach(
      (c) =>
        (c.onclick = () => {
          state.store = c.dataset.store;
          storeBox
            .querySelectorAll(".px-chip")
            .forEach((x) =>
              x.classList.toggle("on", x.dataset.store === state.store),
            );
          state.aisles = new Set([c.dataset.aisle]);
          aisleBox
            .querySelectorAll(".px-chip")
            .forEach((x) =>
              x.classList.toggle("on", x.dataset.aisle === c.dataset.aisle),
            );
          draw();
        }),
    );
  };

  const draw = () => {
    drawHints();
    let rows = ingredients
      .map((ing) => {
        const p = state.store.startsWith("All")
          ? priceOf(ing.id)
          : prices.filter(
              (x) => x.ingredient_id === ing.id && x.store === state.store,
            )[0] || null;
        const fr = freshnessOf(p);
        return { ing, p, stale: !!(fr && fr.tier !== "fresh"), fr };
      })
      .filter((r) => r.p)
      .filter((r) => !state.aisles.size || state.aisles.has(r.ing.aisle))
      .filter(
        (r) =>
          !state.q ||
          normalize(r.ing.name).includes(state.q) ||
          (r.ing.aliases || []).some((a) => normalize(a).includes(state.q)),
      );
    const unitCents = (p) => (p ? p.price_cents / p.pack_qty : 0);
    if (state.sort === "price")
      rows.sort((a, b) => a.p.price_cents - b.p.price_cents);
    else if (state.sort === "unit")
      rows.sort((a, b) => unitCents(a.p) - unitCents(b.p));
    else rows.sort((a, b) => a.ing.name.localeCompare(b.ing.name));

    // P-418 red-team fix: aisle chips used to ignore the store filter — a
    // "starches" click under PnP could show an aisle PnP doesn't stock.
    const stocked = new Set(
      ingredients
        .filter((i) => {
          const p = state.store.startsWith("All")
            ? priceOf(i.id)
            : prices.some(
                (x) => x.ingredient_id === i.id && x.store === state.store,
              );
          return p;
        })
        .map((i) => i.aisle),
    );
    aisleBox
      .querySelectorAll(".px-chip")
      .forEach((c) =>
        c.toggleAttribute("disabled", !stocked.has(c.dataset.aisle)),
      );

    $("#px-count").textContent =
      `${rows.length} ingredient${rows.length === 1 ? "" : "s"} priced`;
    // P-543: live verified-vs-estimate split for whatever's on screen —
    // same vocabulary as the till-slip tier footer (✓/≈ legend).
    const nVer = rows.filter((r) => r.p.source === "verified").length;
    $("#px-tier-line").textContent =
      `· ${nVer}✓ in-store verified · ${rows.length - nVer}≈ estimated`;
    if (!rows.length) {
      // P-418 red-team fix: empty search left a header-only table
      $("#explorer-table").innerHTML = `<div class="px-empty">
        <strong>Nothing matches that yet.</strong>
        <span class="muted">Clear the search or tap a different aisle — or check the Matcher: your recipe may use a synonym we price under another name.</span>
      </div>`;
      return;
    }
    $("#explorer-table").innerHTML = `<table class="price-table px-table">
      <thead><tr><th>Item</th><th>Brand &amp; pack</th><th class="num">Price</th><th>Per 100g/ml</th><th>Store</th><th>Checked</th></tr></thead>
      <tbody>${rows
        .map(({ ing, p, stale, fr }) => {
          // P-543 (P-519 layer): the source honesty mark. Doctrine = planner's
          // tierOf: ONLY in-store/shelf-confirmed rows are ✓ verified; estimate/
          // estimated/reference spellings are honestly ≈. The old header said
          // "Verified" over a column of estimates — that lie is gone.
          const srcTier = p.source === "verified" ? "verified" : "estimated";
          // P-406: per-100g/ml where the pack is a weight/volume — the honest
          // unit shoppers compare; count packs show plain per-unit.
          const gramPack = ["g", "ml"].includes(p.pack_unit);
          // P-509c: count-pack per-unit is CENTS/unit — the R-prefix needs /100 (the garlic R1999.00/unit bug).
          // The per-100g branch stays: cents-per-gram NUMERICALLY equals rands per 100 g.
          const unit = gramPack
            ? `R${(p.price_cents / p.pack_qty).toFixed(2)} / 100${p.pack_unit}`
            : `R${(p.price_cents / p.pack_qty / 100).toFixed(2)}/${p.pack_unit}`;
          return `<tr class="px-row" data-id="${esc(ing.id)}" role="button" tabindex="0" aria-label="Compare prices for ${esc(ing.name)}">
          <td><strong>${esc(ing.name)}</strong><span class="muted px-aisle">${esc(ing.aisle)}</span></td>
          <td class="muted">${esc(p.brand || "house brand")} · ${p.pack_qty} ${esc(p.pack_unit)}</td>
          <td class="num"><span class="price-tag money money--sm">${formatRands(p.price_cents)}</span></td>
          <td class="muted">${unit}</td>
          <td class="muted">${esc(p.store)}</td>
          <td class="muted"><span class="px-src px-src--${srcTier}"
            title="${srcTier === "verified" ? "In-store verified price — checked against a real shelf/receipt." : "Estimated price — best available research, not shelf-verified. Verify in store."}"
            role="note" aria-label="${srcTier} price">${srcTier === "verified" ? "✓" : "≈"}</span> ${esc(p.last_verified)} <span class="px-age px-age--${fr ? fr.tier : "estimate"}"
            title="${fr && fr.tier === "stale" ? "Over a month since this price was checked — it may have drifted. Tap the row to compare stores." : fr && fr.tier === "aging" ? "Two-plus weeks since this price was checked." : "Price checked recently."}"
            role="note">${fr ? fr.label : "estimate"}</span></td>
        </tr>`;
        })
        .join("")}</tbody></table>`;
  };
  draw();

  // P-417: row -> compare modal (click + keyboard)
  const tbl = $("#explorer-table");
  tbl.onclick = (ev) => {
    const row = ev.target.closest(".px-row");
    if (row) openIngModal(ingredients.find((i) => i.id === row.dataset.id));
  };
  tbl.onkeydown = (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const row = ev.target.closest(".px-row");
    if (row) {
      ev.preventDefault();
      openIngModal(ingredients.find((i) => i.id === row.dataset.id));
    }
  };
}

// ---------------- COOK LOG ----------------

/** P-403: last 8 weeks as Mon–Sun rows — sun-yellow intensity, today outlined. */
function buildHeatmap(log) {
  const heat = heatByDate(log);
  const monday = new Date();
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7)); // this week's Monday
  const todayStr = localDateStr();
  let html = "";
  for (let w = 7; w >= 0; w--) {
    html += '<div class="hm-week">';
    for (let d = 0; d < 7; d++) {
      const day = new Date(monday);
      day.setDate(day.getDate() - w * 7 + d);
      const ds = localDateStr(day);
      const n = heat.get(ds) || 0;
      const lvl = n >= 3 ? 3 : n;
      html += `<button type="button" class="hm-cell hm-${lvl}${ds === todayStr ? " hm-today" : ""}"
        data-date="${ds}" data-n="${n}" aria-label="${ds}: ${n} cook${n === 1 ? "" : "s"}">${day.getDate()}</button>`;
    }
    html += "</div>";
  }
  return html;
}

/** P-403: the personalized read of the log — go-to dish, cadence, price trend. */
function kitchenGlance(log, stats) {
  const bits = [];
  // P-416: one-line cook personality — busiest day + top tag + honest average
  if (log.length && stats.busiestDayIdx >= 0) {
    const DAYS = [
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ];
    const tag = stats.topTags[0] ? stats.topTags[0].tag : "";
    const style = tag
      ? `a ${DAYS[stats.busiestDayIdx]} ${tag} cook`
      : `a ${DAYS[stats.busiestDayIdx]} cook`;
    bits.push(
      `<p class="kg-personality">You're ${style} — ${formatRands(stats.avgPerPlateCents)}/plate on average. That's the RandPlates way.</p>`,
    );
  }
  if (stats.mostCooked) {
    bits.push(`<div class="kg-row"><span class="kg-l">YOUR GO-TO</span>
      <span><strong>${esc(stats.mostCooked.title)}</strong> — cooked ${stats.mostCooked.count}×</span></div>`);
  }
  bits.push(`<div class="kg-row"><span class="kg-l">THIS WEEK</span>
    <span>${stats.cooksThisWeek} cook${stats.cooksThisWeek === 1 ? "" : "s"}${stats.avgLast7Cents !== null ? ` · ${formatRands(stats.avgLast7Cents)}/plate` : ""}</span></div>`);
  if (stats.avgLast7Cents !== null && stats.avgPrev7Cents !== null) {
    const diff = stats.avgLast7Cents - stats.avgPrev7Cents;
    const trend =
      diff <= 0
        ? `<span class="kg-good">▼ ${formatRands(Math.abs(diff))} cheaper per plate than last week</span>`
        : `<span class="kg-warn">▲ ${formatRands(diff)} up on last week</span>`;
    bits.push(
      `<div class="kg-row"><span class="kg-l">TREND</span>${trend}</div>`,
    );
  }
  if (log.length) {
    bits.push(`<div class="kg-row"><span class="kg-l">PLATES COOKED</span>
      <span><strong>${stats.totalPlates}</strong> across ${stats.totalCooks} cook${stats.totalCooks === 1 ? "" : "s"} · ${stats.distinctRecipes} different recipe${stats.distinctRecipes === 1 ? "" : "s"}</span></div>`);
    if (stats.busiestDayIdx >= 0) {
      const DAYS = [
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
        "Sunday",
      ];
      const max = Math.max(1, ...stats.weekdayProfile);
      bits.push(`<div class="kg-row kg-row--bars"><span class="kg-l">YOUR KITCHEN DAYS</span>
        <div class="kg-bars" aria-label="Cooks by weekday">${stats.weekdayProfile
          .map(
            (c, i) => `
          <div class="kg-bar${i === stats.busiestDayIdx ? " kg-bar--hot" : ""}" title="${DAYS[i]}: ${c}">
            <i style="height:${Math.round(8 + (c / max) * 42)}px"></i>
            <span>${DAYS[i].slice(0, 1)}</span>
          </div>`,
          )
          .join("")}</div>
        <span class="muted kg-busy">${DAYS[stats.busiestDayIdx]} is your day</span></div>`);
    }
    if (stats.topTags.length) {
      bits.push(`<div class="kg-row"><span class="kg-l">YOU COOK</span>
        <span class="kg-tags">${stats.topTags.map((t) => `<i>${esc(t.tag)} ×${t.count}</i>`).join("")}</span></div>`);
    }
  }
  if (!log.length)
    bits.push(
      '<div class="kg-row muted">Cook a few meals and your patterns show up here.</div>',
    );
  return bits.join("");
}

/** P-415: open any logged recipe — full steps + ingredients — from history.
 *  Deliberately matcher-independent: the recipe may not survive current
 *  filters, but the user's history is not the matcher's business. */
/** P-418: matcher-independent recipe reader — used by the cook log AND the
 *  ingredient modal. Desserts/breakfasts survive no matcher pool at all. */
function openRecipeStandalone(recipe, subLine) {
  $("#cd-title").textContent = recipe.title;
  $("#cd-sub").textContent = subLine || "";
  // honest missing-count: non-optional lines you don't own
  const missing = (recipe.ingredients || [])
    .filter(
      (l) => !l.optional && !store.get().pantry.some((p) => p.id === l.id),
    )
    .map((l) => l.id);
  // renderRecipeDetail reads steps/ingredients off the RESULT object (matcher
  // candidates carry the recipe payload) — the synthesized candidate must
  // carry them too, or the render throws before showModal.
  const synth = {
    recipeId: recipe.id,
    title: recipe.title,
    servings: recipe.servings,
    missing,
    steps: recipe.steps || [],
    ingredients: recipe.ingredients || [],
    tags: recipe.tags || [],
  };
  const body = $("#cd-body");
  body.innerHTML = renderRecipeDetail(synth);
  wireDetail(body, synth);
  const dlg = $("#cook-detail");
  if (!dlg.open) dlg.showModal();
  // P-418 red-team fix: Close was wired only in wireHistory (cook-log render)
  // — sessions that opened this dialog from the explorer had a DEAD close
  // button and an inert, blocked page. Wire it here; the assignment is idempotent.
  $("#cd-close").onclick = () => dlg.close();
}

function openCookDetail(logEntry) {
  const recipe = store.get().recipes.find((r) => r.id === logEntry.recipeId);
  if (!recipe) {
    toast("That recipe is no longer in the library.");
    return;
  }
  const tiers = logEntry.priceTiers;
  const tierLine = !tiers
    ? ""
    : tiers.estimatedCount > 0
      ? ` (≈ ${tiers.estimatedCount} estimated price${tiers.estimatedCount === 1 ? "" : "s"} in that cook)`
      : " (✓ all verified prices)";
  openRecipeStandalone(
    recipe,
    `you cooked this on ${logEntry.date}` +
      (logEntry.perPlateCents != null
        ? ` · ${formatRands(logEntry.perPlateCents)}/plate at the time`
        : "") +
      tierLine,
  );
}

/** P-415: history controls — open detail, delete (+undo), filter, export, clear. */
function wireHistory() {
  const out = $("#cooklog-output");
  if (!out) return;
  const sel = $("#log-filter");
  if (sel) {
    if (window.__logFilter) sel.value = window.__logFilter;
    sel.onchange = () => {
      window.__logFilter = sel.value;
      renderCookLog();
    };
  }
  out.onclick = async (ev) => {
    const del = ev.target.closest(".log-del");
    if (del) {
      ev.preventDefault();
      ev.stopPropagation();
      const id = del.dataset.id;
      const entry = store.get().cookLog.find((e) => e.id === id);
      if (!entry) return;
      await db.remove("cook_log", id);
      store.set({ cookLog: await db.getAll("cook_log") });
      renderCookLog();
      toast(`Removed ${entry.title} from the log`, async () => {
        await db.put("cook_log", entry); // undo restores the exact record
        store.set({ cookLog: await db.getAll("cook_log") });
        renderCookLog();
      });
      return;
    }
    const again = ev.target.closest("a.log-again");
    if (again) {
      // P-542: the href stays as the no-JS fallback, but the click opens the
      // standalone reader — the old deep link just landed on the matcher and
      // nothing ever consumed data-recipe (and desserts never render there).
      ev.preventDefault();
      const rowEntry = store
        .get()
        .cookLog.find(
          (e) => e.id === again.closest(".log-entry")?.dataset.logId,
        );
      const recipe = store
        .get()
        .recipes.find((r) => r.id === again.dataset.recipe);
      if (recipe)
        openRecipeStandalone(
          recipe,
          rowEntry
            ? `you cooked this on ${rowEntry.date} — here it is again`
            : "cook it again",
        );
      else toast("That recipe is no longer in the library.");
      return;
    }
    const row = ev.target.closest(".log-open");
    if (row) {
      const entry = store.get().cookLog.find((e) => e.id === row.dataset.logId);
      if (entry) openCookDetail(entry);
    }
  };
  out.onkeydown = (ev) => {
    // keyboard: rows are role=button
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const row = ev.target.closest(".log-open");
    if (row) {
      ev.preventDefault();
      const entry = store.get().cookLog.find((e) => e.id === row.dataset.logId);
      if (entry) openCookDetail(entry);
    }
  };
  const exportBtn = $("#log-export");
  if (exportBtn)
    exportBtn.onclick = async () => {
      const blob = new Blob(
        [
          JSON.stringify(
            {
              format_version: 1,
              kind: "cook-log",
              entries: await db.getAll("cook_log"),
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      );
      downloadBlob(blob, "randplates-cook-log.json");
      toast("Cook log exported");
    };
  const clearBtn = $("#log-clear");
  if (clearBtn)
    clearBtn.onclick = async () => {
      if (clearBtn.dataset.armed !== "1") {
        // two-tap confirm — no native dialogs
        clearBtn.dataset.armed = "1";
        clearBtn.textContent = "Tap again to clear";
        setTimeout(() => {
          clearBtn.dataset.armed = "";
          clearBtn.textContent = "Clear log";
        }, 5000);
        return;
      }
      const snapshot = await db.getAll("cook_log");
      for (const e of snapshot) await db.remove("cook_log", e.id);
      store.set({ cookLog: [] });
      renderCookLog();
      toast("Cook log cleared", async () => {
        for (const e of snapshot) await db.put("cook_log", e);
        store.set({ cookLog: await db.getAll("cook_log") });
        renderCookLog();
      });
    };
  const cdClose = $("#cd-close");
  if (cdClose) cdClose.onclick = () => $("#cook-detail").close();
}

/** P-403: day-detail reveal — inline under the grid (no page scroll: nothing
 *  to fight the sticky chrome for). Delegated click on the heatmap grid. */
function wireHeatmap() {
  const grid = $("#hm-grid");
  if (!grid) return;
  grid.addEventListener("click", (ev) => {
    const cell = ev.target.closest(".hm-cell");
    if (!cell) return;
    const ds = cell.dataset.date;
    const log = store.get().cookLog.filter((e) => String(e.date) === ds);
    const detail = $("#hm-detail");
    if (!log.length) {
      detail.innerHTML = `<strong>${ds}</strong> — nothing logged this day.`;
    } else {
      detail.innerHTML = `<strong>${ds}</strong> — ${log
        .map(
          (e) =>
            `${esc(e.title)} (${formatRands(e.perPlateCents)}/plate${e.servings ? `, ${e.servings} servings` : ""})`,
        )
        .join(" · ")}`;
    }
    detail.hidden = false;
  });
}

/** P-561: the badge grid, shared by the full report and the empty-log state.
 *  Phase 4/5 badges (decoder, themes, planner, pantry) can ALL be earned
 *  before the first cook — hiding the grid on an empty log made them
 *  invisible exactly when they unlock. */
function badgeGridHtml(stats) {
  return `
    <div class="panel section-gap">
      <h2>Badges</h2>
      <div class="badges">${stats.badges
        .map(
          (b, i) => `
        <div class="badge ${b.earned ? "" : "locked"}" style="--tilt:${((i % 3) - 1) * 2.5}deg">
          <span class="medal" aria-hidden="true">${b.icon}<i class="lock-mini">🔒</i></span>
          <div><div class="t">${esc(b.name)}</div><div class="d">${esc(b.desc)}</div></div>
        </div>`,
        )
        .join("")}</div>
    </div>`;
}

function renderCookLog() {
  const log = store.get().cookLog;
  const stats = getAchievementStats(log, achievementCtx()); // live calculation — the only source of counts (P-561: + Phase 4/5 ctx)
  const out = $("#cooklog-output");
  if (!log.length) {
    out.innerHTML =
      '<div class="empty section-gap"><span class="big">🍳</span><strong>Cook anything from the Matcher and your streak starts here.</strong><br><a class="btn section-gap" href="#matcher" style="display:inline-flex">Match my first cook</a> <button type="button" class="chip-link" data-guide="guide-cooklog">show me how</button></div>' +
      (stats.earnedCount ? badgeGridHtml(stats) : ""); // P-561: badges earned without a cook still show
    return;
  }
  // P-415: history filter (kept across re-renders — a delete shouldn't reset it)
  const cutoffStr = (days) => localDateStr(new Date(Date.now() - days * 864e5));
  const shownLog = (
    window.__logFilter === "week"
      ? log.filter((e) => String(e.date) >= cutoffStr(7))
      : window.__logFilter === "month"
        ? log.filter((e) => String(e.date) >= cutoffStr(30))
        : [...log]
  )
    .reverse()
    .slice(0, 50);

  // P-416: the report window — 8 weeks of grid start to today, human-formatted
  const fmtDay = (d) =>
    d.toLocaleDateString("en-ZA", { day: "numeric", month: "short" });
  const winStart = fmtDay(new Date(Date.now() - 55 * 864e5));
  const fmtFirst = stats.firstCookDate
    ? new Date(stats.firstCookDate + "T00:00:00").toLocaleDateString("en-ZA", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "no cooks yet";

  out.innerHTML = `
    <div class="panel section-gap report-card">
      <div class="report-head">
        <h2>Your cooking report</h2>
        <div class="muted">cooking with RandPlates since ${fmtFirst}${stats.totalCooks ? ` · ${stats.totalPlates} plates · ${stats.distinctRecipes} different recipes` : ""}</div>
        ${(() => {
          // P-542: the report states the log's price honesty plainly — cooks that
          // lean on ≈ estimates say so; legacy entries (no snapshot) count apart.
          const withT = log.filter((e) => e.priceTiers);
          if (!withT.length) return "";
          const allV = withT.filter(
            (e) => e.priceTiers.estimatedCount === 0,
          ).length;
          const someE = withT.length - allV;
          const legacy = log.length - withT.length;
          return `<div class="muted">price honesty: ${allV} cook${allV === 1 ? "" : "s"} priced from ✓ verified prices${someE ? ` · ${someE} used ≈ estimates` : ""}${legacy ? ` · ${legacy} older entr${legacy === 1 ? "y" : "ies"} (before tiers were recorded)` : ""}</div>`;
        })()}
      </div>
      <div class="log-grid">
      <div class="stat-tile"><div class="lbl">CURRENT STREAK</div><span class="money">${stats.currentStreak} 🔥</span><div class="muted">longest: ${stats.longestStreak}</div></div>
      <div class="stat-tile"><div class="lbl">MEALS COOKED</div><span class="money">${stats.totalCooks}</span><div class="muted">this month: ${stats.cooksThisMonth} cook${stats.cooksThisMonth === 1 ? "" : "s"} · ${stats.platesThisMonth} plates</div></div>
      <div class="stat-tile"><div class="lbl">AVG PER PLATE</div><span class="money">${formatRands(stats.avgPerPlateCents)}</span><div class="muted">cheapest: ${formatRands(stats.cheapestPlateCents)} · spent so far: ${formatRands(stats.totalSpentCents)}</div></div>
      <div class="stat-tile"><div class="lbl">SAVED VS TAKEOUT</div><span class="money">${formatRands(stats.totalSavedCents)}</span><div class="muted">takeout would have cost ${formatRands(stats.totalSavedCents + stats.totalSpentCents)}</div></div>
      <div class="stat-tile stat-tile--level"><div class="lbl">LEVEL ${stats.level}</div>
        <span class="money">${stats.level}</span><span class="lvl-title">${esc(stats.levelTitle)}</span>
        <div class="xp-bar section-gap"><i style="width:${Math.min(100, (stats.xpIntoLevel / stats.xpForNextLevel) * 100)}%"></i></div>
        <div class="muted">${stats.xpIntoLevel}/${stats.xpForNextLevel} XP · next up: ${esc(titleForLevel(stats.level + 1))}</div></div>
      <div class="stat-tile"><div class="lbl">BADGES</div><span class="money">${stats.earnedCount}/${stats.badges.length} 🏅</span><div class="muted">${stats.earnedCount === stats.badges.length ? "every badge earned — legend." : "keep cooking to unlock the rest"}</div></div>
      </div>
    </div>
    <div class="panel section-gap hm-card">
      <div class="hm-head">
        <h2>Streak calendar</h2>
        <span class="hm-window muted">${winStart} → today · ${new Date().toLocaleDateString("en-ZA", { month: "long", year: "numeric" })}</span>
      </div>
      <div class="muted hm-hint">tap a day to see what you cooked</div>
      <div class="hm-days" aria-hidden="true"><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span></div>
      <div class="hm-grid" id="hm-grid">${buildHeatmap(log)}</div>
      <div class="hm-legend" aria-hidden="true"><span>less</span><i class="hm-0"></i><i class="hm-1"></i><i class="hm-2"></i><i class="hm-3"></i><span>more</span></div>
      <div class="hm-detail" id="hm-detail" hidden></div>
    </div>
    <div class="panel section-gap">
      <h2>Your kitchen at a glance</h2>
      ${kitchenGlance(log, stats)}
    </div>
    ${badgeGridHtml(stats)}
    <div class="panel section-gap">
      <h2>History <span class="muted hm-hint">tap a meal for the full recipe</span></h2>
      <div class="log-controls">
        <label class="muted" for="log-filter">Show</label>
        <select id="log-filter" class="log-filter">
          <option value="all">All cooks</option>
          <option value="week">Last 7 days</option>
          <option value="month">Last 30 days</option>
        </select>
        <span class="log-controls-spacer"></span>
        <button class="ghost small" id="log-export" type="button">Export log</button>
        <button class="ghost small danger" id="log-clear" type="button">Clear log</button>
      </div>
      ${
        shownLog
          .map(
            (
              e,
              i,
            ) => `<div class="log-entry log-open${i === 0 && justCooked === e.id ? " just-cooked" : ""}" data-log-id="${esc(e.id)}" role="button" tabindex="0" aria-label="Open recipe: ${esc(e.title)}">
        <div><strong>${esc(e.title)}</strong>${i === 0 && justCooked === e.id ? ' <span class="jc-tag">Just cooked</span>' : ""}
          <span class="muted">${esc(e.date)} · ${e.servings} plate${e.servings === 1 ? "" : "s"}</span></div>
        <span class="log-actions">
          <span class="money money--sm" style="font-size:1rem">${formatRands(e.perPlateCents)}/plate${e.priceTiers && e.priceTiers.estimatedCount > 0 ? ' <span class="sub" title="' + e.priceTiers.estimatedCount + ' estimated price(s) at cook time">≈</span>' : ""}</span>
          <a class="ghost small log-again" href="#matcher" data-recipe="${esc(e.recipeId)}">Cook again</a>
          <button class="ghost small danger log-del" data-id="${esc(e.id)}" type="button" aria-label="Remove ${esc(e.title)} from the log">✕</button>
        </span>
      </div>`,
          )
          .join("") || '<p class="muted">No cooks in this range yet.</p>'
      }
    </div>`;
  wireHeatmap(); // P-403: re-wire on every render — innerHTML rebuilds the grid
  wireHistory(); // P-415: detail opens, deletes, filters, export/clear
  justCooked = null; // the highlight shows once
}

// id of the cook-log entry just written, so the Cook Log can celebrate it once (P-104T)
let justCooked = null;

// ---------------- DECODER ----------------

function renderDecoder() {
  /* static markup in index.html; results below */
}

/** P-436: one-tap sample captions (Meta AI P-423 findings, engine-validated).
 *  Sample B was adjusted from the findings: the promo moved to its own line
 *  because the engine (correctly) queues promo-titled lines — copy bends to
 *  the engine. All three verified against decodeRecipeText on Oct 21. */
const DEC_SAMPLES = {
  A: `Easy Student Pap & Chakalaka Bowl
Serves 2
Time: 20 mins
1 cup White Star maize meal (pap)
1 tin Koo baked beans
1 onion, chopped
2 eggs
1. Boil water, stir in pap until thick, cover 5 mins.
2. Fry onion, add baked beans, warm through.
3. Fry eggs, serve everything together.`,
  B: `Quick Polony & Vetkoek
2 for R30 at Shoprite!!
Serves 1
Time: 15 mins
#studentmeals #budget
2 slices white bread
100g poloni (sorry polony)
1 onion
pinch of atchar
1. Toast bread, fry polony till brown.
2. Top with onion and atchar, close sandwich.
Link in bio!!`,
  C: `Gogo's Morogo ne Pap - Sunday Lunch
serves 4-6
Time: 40 mins
2 cups Iwisa maize meal
1 bunch morogo, washed
1 tin Koo baked beans
1 spoon Mrs Balls chutney
1 onion
1. Cook pap till soft, set aside.
2. Fry onion, add morogo until wilted, stir in baked beans.
3. Serve pap with morogo mix, chutney on the side.`,
};

// ---------------- P-441: the gap log (review queue → research queue) ----------
// DOCTRINE: the report PROPOSES, the owner verifies. Nothing logged here
// writes to the registry or price table — it only records what the decoder
// could NOT resolve, so the gaps become a ranked research list.
const GAP_SESSION =
  "gap-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const gapHash = (s) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

/**
 * Log the review queue at decode time (P-428 §1.2):
 *   unresolved_ingredient            → always
 *   unresolved_after_pick            → raised later by the swap-search flow
 *   vague_quantity / unparsed_line   → only with a non-generic candidate
 *   everything else                  → never (not registry gaps)
 * Deterministic ids (`session:decodeHash:lineIndex`) make `put()` idempotent —
 * re-decoding the same caption in one visit never double-counts.
 */
async function logGapQueue(draft, inputText) {
  const decodeId = gapHash((inputText || "").trim());
  const now = Date.now();
  for (const [lineIndex, u] of (draft.unresolved || []).entries()) {
    let log = false,
      candidate = "",
      brandOnly = false,
      viaLexicon = false,
      lexiconFrom = null;
    if (u.reason === "unresolved_ingredient") log = true;
    else if (u.reason === "vague_quantity" || u.reason === "unparsed_line") {
      const ex = extractCandidate(u.line);
      candidate = ex.candidate;
      brandOnly = ex.brandOnly;
      viaLexicon = ex.viaLexicon;
      lexiconFrom = ex.lexiconFrom;
      const single = !candidate.includes(" ");
      log = !!candidate && !(single && GENERIC_HEAD_SET.has(candidate));
    }
    if (!log) continue;
    const ex =
      candidate !== ""
        ? { candidate, brandOnly, viaLexicon, lexiconFrom }
        : extractCandidate(u.line);
    const rec = {
      id: `${GAP_SESSION}:${decodeId}:${lineIndex}`,
      v: 1,
      source: "review_queue",
      sessionId: GAP_SESSION,
      decodeId,
      lineIndex,
      loggedAt: now,
      rawLine: String(u.line).slice(0, 240),
      reasonCode: u.reason,
      outcome: u.reason, // may be upgraded by picker actions
      resolvedId: null,
      candidate: ex.candidate,
      brandOnly: ex.brandOnly,
      viaLexicon: ex.viaLexicon,
      lexiconFrom: ex.lexiconFrom || null,
    };
    window.__gapRecs = window.__gapRecs || {};
    window.__gapRecs[u.line] = rec.id;
    await db.put("gap_log", rec);
  }
  renderGapReport();
}

/** Upgrade a logged record's outcome (picker resolution / drop). */
async function gapOutcome(rawLine, outcome, resolvedId = null) {
  const map = window.__gapRecs || {};
  const id = map[rawLine];
  if (!id) return;
  try {
    const rec = await db.get("gap_log", id);
    if (!rec) return;
    await db.put("gap_log", {
      ...rec,
      outcome,
      resolvedId: resolvedId || rec.resolvedId,
    });
  } catch {
    /* gap log is telemetry — never blocks the draft flow */
  }
}

function runDecoder() {
  const text = $("#decode-input").value;
  const { ingredients } = store.get();
  const resolve = (name) => {
    const hits = searchIngredients(name, ingredients);
    return hits[0] || null;
  };
  const draft = decodeRecipeText(text, resolve);
  window.__decUndo = [];
  window.__decSwap = null;
  window.__decAdd = false; // P-448: fresh state
  if (!draft.ingredients.length) {
    $("#decode-output").innerHTML =
      '<div class="empty section-gap">No ingredient lines found — paste text like “2 cups rice / 1 onion / Fry the onion…”</div>';
    return;
  }
  window.__decodedDraft = draft; // review state lives across re-renders
  renderDecodeOutput();
  window.__pulseBump("decodes"); // P-412 Pulse
  logGapQueue(draft, text); // P-441: the review queue becomes research data
}

/** P-404: honest draft metrics — matched/total lines, unpriced lines. */
function draftMetrics(draft) {
  const total = draft.ingredients.length;
  const matched = draft.ingredients.filter((i) => i.resolvedName).length;
  const unpriced = draft.ingredients.filter(
    (i) => i.resolvedId && !priceOf(i.resolvedId),
  ).length;
  return { total, matched, unpriced };
}

/** P-404: recompute the draft after a manual line resolution — mirrors the
 *  engine's rules exactly (decoder.js: confidence = resolved/total, gate =
 *  any unresolved line OR no steps) so the gate can never be soft-bypassed. */
function recomputeDraft(draft) {
  const { matched, total } = draftMetrics(draft);
  // P-439: mirrors the engine's confidenceV2 exactly — the score is advice,
  // the gate below stays law (never derived from the score)
  draft.confidence = confidenceV2(
    draft.ingredients,
    draft.unresolved || [],
    (draft.steps || []).length,
    draft.meta?.isMultiRecipe || false,
  );
  draft.reviewRequired = matched < total || (draft.steps || []).length === 0;
}

/** P-435: review-queue microcopy (Groq P-422 findings, absorbed).
 *  Caps enforced in qa-p404: banners <=12 words, reasons <=10. */
const DEC_COPY = {
  bannerQueue: "We need a quick check because the line isn’t clear enough.",
  bannerReady: "Looks good – give it a quick skim before saving.",
  reasons: {
    unresolved_ingredient: "Ingredient not in our list – add or clarify name.",
    price_talk:
      "Shop promo, not an ingredient – remove it. Prices come from verified shop data, nothing for you to confirm.",
    vague_quantity:
      "Quantity vague – re-add it below with an exact amount, or remove it.",
    meta_info: "Contains meta data – delete or move to notes.",
    unparsed_line: "Line didn’t match any pattern – rewrite clearly.",
    subjective_or_vague: "Instruction subjective or vague – make it concrete.",
    temperature_or_duration:
      "Temperature or time mentioned – give exact value.",
    serving_range_needs_review:
      "Serving range wide – confirm exact number of plates.",
    unresolved_after_pick:
      "Ingredient still unknown after lookup – add your own entry.",
  },
  emptyQueue: "Add at least one clear cooking step and try again.",
  unpriced: "Price not yet available – will appear once data added.",
  saveOk: (t) => `Recipe “${t}” saved – ready for planning.`,
  saveBlocked: (t, why) => `Cannot save “${t}” – ${why}`,
  saveDup: (t) =>
    `“${t}” is already in your matcher pool – pick a different name.`,
  saveMatcher: "Recipe added to matcher – will appear in your weekly plan.",
  undoRemoved: "Line removed",
  undoChanged: "Line updated",
  added: "Ingredient added",
};

/** P-446: unit dropdown options from the ENGINE contract (UNIT_CANON) —
 *  the UI never invents units the engine can't cost. */
function unitOptions(current) {
  // P-567e: PRICED_UNITS — only units the costing engine implements. The old
  // list (all UNIT_CANON values) offered 7 dead units that always priced null.
  const canon = PRICED_UNITS;
  // P-442: the user's AS-ENTERED unit (koppie, eetlepel, packet…) rides first
  // and selected when the canon list lacks it — display never rewrites it.
  const extra = current && !canon.includes(current) ? [current] : [];
  return [...extra, ...canon]
    .map(
      (u) =>
        `<option value="${u}" ${u === current ? "selected" : ""}>${u}</option>`,
    )
    .join("");
}

/** P-448: the decoded-recipes library — every import, removable from the pool. */
/**
 * P-441: REVIEW QUEUE INSIGHTS — the research queue card. Every review-queue
 * item the decoder has ever logged, aggregated, scored and tiered against the
 * live registry. PROPOSES only: cards are suggestions the owner verifies —
 * "Mark handled" archives a card by content key (it never touches the log).
 */
async function renderGapReport() {
  const el = $("#gap-report-panel");
  if (!el) return;
  const records = await db.getAll("gap_log");
  const { ingredients } = store.get();
  const registry = ingredients.map((i) => ({
    id: i.id,
    name: i.name,
    aliases: i.aliases || [],
    priced: !!priceOf(i.id),
  }));
  // P-454: dismissal is keyed by SUGGESTION, not by card (applyHandled is a
  // pure engine function — one handled suggestion never kills its siblings).
  const handled = JSON.parse(localStorage.getItem("gap-handled") || "[]");
  const rep = buildReport(records, registry, { now: Date.now() });
  const cards = applyHandled(rep.cards, handled);
  // Zero-demand price cards (the registry price scan) are a CHECKLIST, not a
  // ranking — 18 identical "unpriced" cards is noise. They collapse into one
  // till-list panel; ranked research stays as cards.
  const tillList = cards.filter(
    (c) => c.category === "MISSING_PRICE" && c.hits === 0,
  );
  const ranked = cards.filter(
    (c) => !(c.category === "MISSING_PRICE" && c.hits === 0),
  );
  const tierMeta = {
    NOW: { label: "Till pass this week", cls: "gap-tier--now" },
    NEXT: { label: "Web research next", cls: "gap-tier--next" },
    WATCH: {
      label: "Watching — too rare to chase yet",
      cls: "gap-tier--watch",
    },
  };
  const catText = {
    MISSING_INGREDIENT: "Not in the registry at all",
    MISSING_ALIAS: "Known ingredient — this phrasing is missing",
    MISSING_PRICE: "In the registry but unpriced",
  };
  const cardHtml = (c) => `
    <div class="gap-card ${tierMeta[c.tier].cls}">
      <div class="gap-card-head">
        <span class="gap-tier">${tierMeta[c.tier].label}</span>
        <strong class="gap-cand">${esc(c.candidate)}</strong>
        <span class="gap-score" title="Demand score — distinct sessions dominate">${c.score}</span>
      </div>
      <p class="muted gap-cat">${catText[c.category]}${c.tierNote ? " · " + esc(c.tierNote) : ""}</p>
      ${c.autoAccept ? `<p class="gap-suggest">“${esc(c.lexiconFrom || c.candidate)}” almost certainly = <strong>${esc(ingredientMeta(c.matches[0])?.name || c.matches[0])}</strong> — add as alias?</p>` : ""}
      ${
        c.ambiguous
          ? `<p class="muted">Could be one of these — handle them one at a time:</p>
        <div class="gap-amb">${c.matches.map((m) => `<button type="button" class="gap-handled gap-amb-btn" data-cand="${esc(c.candidate)}" data-match="${esc(m)}">✓ ${esc(ingredientMeta(m)?.name || m)}</button>`).join("")}</div>`
          : ""
      }
      <div class="gap-card-meta muted">${c.sessions} session${c.sessions === 1 ? "" : "s"} · ${c.hits} hit${c.hits === 1 ? "" : "s"}${c.picks ? " · searched the picker " + c.picks + "×" : ""}${c.resolvedPicks ? " · found via picker " + c.resolvedPicks + "×" : ""}</div>
      ${c.ambiguous ? "" : `<button type="button" class="gap-handled" data-cand="${esc(c.candidate)}">Mark handled</button>`}
    </div>`;
  el.innerHTML = `
    <div class="panel decode-result section-gap" id="gap-report">
      <h2 style="margin-bottom:var(--sp-2)">🧭 Research queue <span class="muted" style="font-weight:400">— what the registry is missing</span></h2>
      ${
        ranked.length
          ? `
        <p class="muted" style="margin-bottom:var(--sp-2)">Ranked from real decode sessions. Suggestions only — you verify every one.</p>
        <div class="gap-cards">${ranked.slice(0, 30).map(cardHtml).join("")}</div>
        ${ranked.length > 30 ? `<p class="muted">+ ${ranked.length - 30} more (watch list)</p>` : ""}`
          : '<p class="muted">Nothing to research yet — decode recipes and the gaps will queue here.</p>'
      }
      ${
        tillList.length
          ? `
        <div class="gap-till">
          <p><strong>🛒 Till list — ${tillList.length} registry item${tillList.length === 1 ? "" : "s"} still unpriced</strong>
            <span class="muted">No decode demand yet, so nothing to rank. These get priced at the next in-store pass.</span></p>
          <div class="gap-till-chips">${tillList.map((c) => `<span class="chip" title="${esc(catText[c.category])}">${esc(ingredientMeta(c.matches[0])?.name || c.candidate)}</span>`).join("")}</div>
        </div>`
          : ""
      }
      ${rep.noise || rep.closedCount ? `<p class="muted" style="margin-top:var(--sp-2)">${rep.noise} marketing/noise line${rep.noise === 1 ? "" : "s"} filtered · ${rep.closedCount} already fixed since logging.</p>` : ""}
    </div>`;
  el.onclick = (ev) => {
    const b = ev.target.closest(".gap-handled");
    if (!b) return;
    // ambiguous suggestions dismiss by candidate::match; unambiguous by candidate
    const key = b.dataset.match
      ? `${b.dataset.cand}::${b.dataset.match}`
      : b.dataset.cand;
    const list = JSON.parse(localStorage.getItem("gap-handled") || "[]");
    if (!list.includes(key)) list.push(key);
    localStorage.setItem("gap-handled", JSON.stringify(list));
    renderGapReport();
  };
}

/**
 * P-453: DECODED RECIPE CARD (owner request Oct 21). Every saved decoded recipe
 * opens into a full modal card — the same draft-style editing the user knows
 * from the Decoder Lab (title, plates, time, per-line qty/unit, steps), with
 * DEEPER price context: each line shows its own verified cost, and unpriced
 * lines are flagged with a one-tap jump into the Price Explorer to fix them.
 * Cook it runs through the SAME P-452 gate as every other card.
 */
function openDecodedModal(recipe) {
  $("#dm-title").textContent = recipe.title;
  $("#dm-sub").textContent =
    `${recipe.servings ?? "—"} plates · decoded ${perPlateChip(recipe.servings, recipe.ingredients) ? "· prices from the live registry" : ""}`;
  const body = $("#dm-body");
  body.innerHTML = renderDecodedCard(recipe);
  wireDecodedCard(body, recipe);
  const dlg = $("#dec-modal");
  if (!dlg.open) dlg.showModal();
  $("#dm-close").onclick = () => dlg.close();
}

function renderDecodedCard(recipe) {
  const lines = (recipe.ingredients || [])
    .map((l, i) => {
      const meta = ingredientMeta(l.id);
      const price = priceOf(l.id);
      const lineCost = price
        ? ingredientCostCents({ ...l, id: l.id }, price)
        : null;
      return `<div class="dm-line" data-idx="${i}">
      <span class="dm-ing-name">${esc(meta?.name || l.id)}
        ${price ? "" : '<button type="button" class="dm-unpriced" title="No verified price yet — jump to the Price Explorer to fix it">unpriced · fix</button>'}</span>
      <input class="dm-qty" type="number" min="0.01" step="any" value="${esc(String(l.qty))}" aria-label="Quantity">
      <select class="dm-unit" aria-label="Unit">${(PRICED_UNITS.includes(l.unit)
        ? []
        : [l.unit]
      )
        .concat(PRICED_UNITS)
        .map(
          (u) =>
            `<option value="${esc(u)}"${u === l.unit ? " selected" : ""}>${esc(u)}</option>`,
        )
        .join("")}</select>
      <span class="dm-cost">${lineCost === null ? "—" : formatRands(lineCost)}</span>
      <button type="button" class="dm-rm-line" aria-label="Remove this line">✕</button>
    </div>`;
    })
    .join("");
  const steps = (recipe.steps || [])
    .map(
      (s, i) => `
    <div class="dm-step" data-idx="${i}">
      <span class="dm-step-n">${i + 1}</span>
      <textarea class="dm-step-txt" rows="2">${esc(s)}</textarea>
      <button type="button" class="dm-rm-step" aria-label="Remove this step">✕</button>
    </div>`,
    )
    .join("");
  return `
    <div class="dm-meta">
      <label>Title <input id="dm-title-edit" type="text" maxlength="80" value="${esc(recipe.title)}"></label>
      <label>Plates <input id="dm-servings" type="number" min="1" max="99" value="${recipe.servings ?? 1}"></label>
      <label>Time (min) <input id="dm-time" type="number" min="1" max="9999" value="${recipe.time_minutes ?? ""}"></label>
    </div>
    <h4 class="md-h">Ingredients <span class="md-legend"><span class="dm-legend-note">per-line verified prices — fix unpriced lines in the Explorer</span></span></h4>
    <div class="dm-lines">${lines || '<p class="muted">No lines.</p>'}</div>
    <h4 class="md-h">Steps</h4>
    <div class="dm-steps">${steps || '<p class="muted">No steps.</p>'}</div>
    <button type="button" id="dm-add-step" class="ghost small">+ Add a step</button>
    <div class="md-cook dm-footer">
      <span class="muted">${perPlateChip(recipe.servings, recipe.ingredients) || ""}</span>
      <button type="button" class="cook-btn">🍳 Cook it</button>
      <button type="button" id="dm-save" class="primary-btn">Save changes</button>
      <div class="md-cook-note" hidden></div>
    </div>`;
}

function wireDecodedCard(body, recipe) {
  const state = { recipe: JSON.parse(JSON.stringify(recipe)) }; // working copy
  const redrawCosts = () => {
    body.querySelectorAll(".dm-line").forEach((row, i) => {
      const l = state.recipe.ingredients[Number(row.dataset.idx)];
      if (!l) return;
      const price = priceOf(l.id);
      const cost = price ? ingredientCostCents(l, price) : null;
      row.querySelector(".dm-cost").textContent =
        cost === null ? "—" : formatRands(cost);
      row.querySelector(".dm-qty").value = String(l.qty);
      row.querySelector(".dm-unit").value = l.unit;
    });
    $("#dm-title-edit").value = state.recipe.title;
    $("#dm-servings").value = state.recipe.servings ?? 1;
    $("#dm-time").value = state.recipe.time_minutes ?? "";
    const chip = body.querySelector(".dm-footer .dec-price-chip");
    if (chip)
      chip.outerHTML =
        perPlateChip(state.recipe.servings, state.recipe.ingredients) || "";
  };
  // silent text updates (P-446 pattern: no re-render while typing)
  body.addEventListener("input", (ev) => {
    const t = ev.target;
    if (t.id === "dm-title-edit") state.recipe.title = t.value;
    else if (t.id === "dm-servings")
      state.recipe.servings = Math.max(
        1,
        Math.min(99, parseInt(t.value, 10) || 1),
      );
    else if (t.id === "dm-time")
      state.recipe.time_minutes =
        t.value === ""
          ? null
          : Math.max(1, Math.min(9999, parseInt(t.value, 10) || 1));
    else if (t.classList.contains("dm-qty")) {
      const l =
        state.recipe.ingredients[Number(t.closest(".dm-line").dataset.idx)];
      const v = parseFloat(t.value);
      if (l && Number.isFinite(v) && v > 0) l.qty = v;
    } else if (t.classList.contains("dm-step-txt")) {
      state.recipe.steps[Number(t.closest(".dm-step").dataset.idx)] = t.value;
    }
  });
  body.addEventListener("change", (ev) => {
    if (ev.target.classList.contains("dm-unit")) {
      const l =
        state.recipe.ingredients[
          Number(ev.target.closest(".dm-line").dataset.idx)
        ];
      if (l && UNIT_CANON[ev.target.value]) {
        l.unit = ev.target.value;
        redrawCosts();
      }
    }
  });
  // structural changes re-render
  body.addEventListener("click", async (ev) => {
    const t = ev.target;
    if (t.classList.contains("dm-rm-line")) {
      const i = Number(t.closest(".dm-line").dataset.idx);
      state.recipe.ingredients.splice(i, 1);
      body.innerHTML = renderDecodedCard(state.recipe);
      wireDecodedCard(body, state.recipe);
    } else if (t.classList.contains("dm-rm-step")) {
      const i = Number(t.closest(".dm-step").dataset.idx);
      state.recipe.steps.splice(i, 1);
      body.innerHTML = renderDecodedCard(state.recipe);
      wireDecodedCard(body, state.recipe);
    } else if (t.id === "dm-add-step") {
      state.recipe.steps.push("");
      body.innerHTML = renderDecodedCard(state.recipe);
      wireDecodedCard(body, state.recipe);
      const last = body.querySelector(".dm-step:last-of-type .dm-step-txt");
      if (last) {
        last.focus();
        last.scrollIntoView({ block: "nearest" });
      }
    } else if (t.classList.contains("dm-unpriced")) {
      const i = Number(t.closest(".dm-line").dataset.idx);
      const name = ingredientMeta(state.recipe.ingredients[i]?.id)?.name || "";
      $("#dec-modal").close();
      location.hash = "#explorer";
      setTimeout(() => {
        const s = $("#px-search");
        if (s) {
          s.value = name;
          s.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }, 350);
    }
  });
  // Save: full validation through the SAME engine gate (draftToRecipe)
  $("#dm-save").onclick = async () => {
    try {
      const updated = draftToRecipe(
        {
          title: state.recipe.title,
          servings: state.recipe.servings,
          timeMinutes: state.recipe.time_minutes,
          ingredients: (state.recipe.ingredients || []).map((l) => ({
            resolvedId: l.id,
            qty: l.qty,
            unit: l.unit,
          })),
          steps: (state.recipe.steps || []).filter(Boolean),
        },
        {
          id: state.recipe.id,
          tags: (state.recipe.tags || []).filter((x) => x !== "decoded"),
          servings: state.recipe.servings,
        },
      );
      updated.ovenTempC = state.recipe.ovenTempC ?? null;
      updated.serveWith = state.recipe.serveWith || [];
      await db.put("saved_recipes", updated);
      const saved = await db.getAll("saved_recipes");
      store.set({
        savedRecipes: saved,
        recipes: mergeUserRecipes(store.get().recipes, saved),
      });
      rebuildRecipeIndex(); // P-537: keep the search index honest
      rebuildRecipeIndex(); // P-537: keep the search index honest
      renderDecodedLibrary();
      toast(`“${updated.title}” updated — matcher pool refreshed.`);
      $("#dec-modal").close();
    } catch (e) {
      toast(`Couldn't save: ${e.message}`);
    }
  };
  // Cook: the SAME P-452 gate (engine-level too). Serves the SAVED version —
  // edits must be saved first, the same way the matcher never cooks stale data.
  const note = body.querySelector(".md-cook-note");
  body.querySelector(".cook-btn").onclick = async () => {
    const rec =
      (store.get().savedRecipes || []).find((r) => r.id === state.recipe.id) ||
      state.recipe;
    const gate = maxCookableServings(
      rec,
      rec.servings || 1,
      store.get().pantry,
      ingredientMeta,
      priceOf,
    );
    if (gate.max >= (rec.servings || 1)) {
      $("#dec-modal").close();
      return cookRecipe(rec, rec.servings || 1, { missing: [] });
    }
    note.hidden = false;
    if (gate.max >= 1) {
      note.className = "md-cook-note md-cook-note--short";
      note.innerHTML = `<p>You have enough for <strong>${gate.max} of ${rec.servings} plates</strong> right now.</p>
        <button type="button" class="cook-smaller">Cook ${gate.max} plate${gate.max === 1 ? "" : "s"}</button>`;
      note.querySelector(".cook-smaller").onclick = () => {
        $("#dec-modal").close();
        cookRecipe(rec, gate.max, { missing: [] });
      };
    } else {
      note.className = "md-cook-note md-cook-note--block";
      note.innerHTML = `<p>Can't cook this yet — short on ${gate.blockers.length} ingredient${gate.blockers.length === 1 ? "" : "s"}:</p>
        <ul>${gate.blockers.map((b) => `<li><strong>${esc(b.name)}</strong> — ${b.state === "none" ? "not in your pantry" : "not enough in your pantry"}</li>`).join("")}</ul>
        <p class="muted">Top up your Pantry, then come back.</p>`;
    }
  };
}

async function renderDecodedLibrary() {
  const el = $("#decoded-library");
  if (!el) return;
  const saved = store.get().savedRecipes || [];
  if (!saved.length) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = `
    <div class="panel decode-result section-gap">
      <h2 style="margin-bottom:var(--sp-2)">My decoded recipes</h2>
      <div class="dec-lib-table" role="table">
        <div class="dec-lib-head" role="row"><span>Recipe</span><span>Plates</span><span>Price</span><span>Time</span><span>Lines</span><span></span></div>
        ${saved
          .map(
            (r) => `<div class="dec-lib-row" role="row" data-id="${esc(r.id)}">
          <span class="dec-lib-title">${esc(r.title)}</span>
          <span>${r.servings ?? "—"}</span>
          <span>${perPlateChip(r.servings, r.ingredients) || "—"}</span>
          <span>${r.time_minutes ? r.time_minutes + " min" : "—"}</span>
          <span>${(r.ingredients || []).length}</span>
          <span class="dec-row-actions"><button type="button" class="dec-rm lib-rm" data-id="${esc(r.id)}" aria-label="Remove from matcher pool" title="Remove from matcher pool">✕</button></span>
        </div>`,
          )
          .join("")}
      </div>
      <p class="muted" style="margin-top:var(--sp-2)">${saved.length} in the matcher pool${saved.length > 1 ? " — remove any you no longer cook." : "."}</p>
    </div>`;
  el.onclick = async (ev) => {
    // P-453: click the ROW (not the ✕) to open the editable recipe card.
    const row = ev.target.closest(".dec-lib-row");
    if (row && !ev.target.closest(".lib-rm")) {
      const rec = (store.get().savedRecipes || []).find(
        (r) => r.id === row.dataset.id,
      );
      if (rec) openDecodedModal(rec);
      return;
    }
    const rm = ev.target.closest(".lib-rm");
    if (!rm) return;
    const id = rm.dataset.id;
    const recipe = (store.get().savedRecipes || []).find((r) => r.id === id);
    await db.remove("saved_recipes", id);
    const saved = await db.getAll("saved_recipes");
    store.set({
      savedRecipes: saved,
      recipes: store.get().recipes.filter((r) => r.id !== id),
    });
    renderDecodedLibrary();
    if (recipe)
      toast(DEC_COPY.undoRemoved, async () => {
        await db.put("saved_recipes", recipe);
        const s2 = await db.getAll("saved_recipes");
        store.set({
          savedRecipes: s2,
          recipes: [
            ...store.get().recipes.filter((x) => x.id !== recipe.id),
            recipe,
          ],
        });
        rebuildRecipeIndex(); // P-537: keep the search index honest
        renderDecodedLibrary();
      });
  };
}

/** P-448: snapshot undo — every structural mutation snapshots the draft first;
 *  the toast's Undo button restores the last snapshot. Stack caps at 15. */
function draftSnapshot() {
  window.__decUndo = window.__decUndo || [];
  window.__decUndo.push(structuredClone(window.__decodedDraft));
  if (window.__decUndo.length > 15) window.__decUndo.shift();
}
function offerUndo(label) {
  const st = window.__decUndo;
  if (!st || !st.length) return;
  const snap = st[st.length - 1];
  toast(label, () => {
    st.pop();
    window.__decodedDraft = snap;
    window.__decSwap = null;
    window.__decAdd = false;
    recomputeDraft(snap);
    renderDecodeOutput();
  });
}

/** P-451: honest per-plate price chip for decoded drafts + library cards.
 *  Engine truth only: verified registry prices, P-449 conversions; resolved
 *  lines without a price row count as unpriced (never guessed). */
function perPlateChip(servings, ingredients) {
  if (!servings || servings < 1) return "";
  const lines = (ingredients || []).filter((i) => i.id || i.resolvedId);
  if (!lines.length) return "";
  const rec = {
    servings,
    ingredients: lines.map((i) => ({
      id: i.id || i.resolvedId,
      qty: i.qty,
      unit: i.unit,
    })),
  };
  const c = costRecipe(rec, priceOf, rowsOf); // P-571: line-aware + usage model, same as the matcher chip
  if (!c.totalUsageCents)
    return '<span class="dec-price-chip dec-price-none">no verified prices yet</span>';
  const extra =
    c.unpriced > 0
      ? " \u00b7 " +
        c.unpriced +
        " line" +
        (c.unpriced > 1 ? "s" : "") +
        " unpriced"
      : "";
  return (
    '<span class="dec-price-chip" title="Estimate from verified shop prices on your phone">\u2248 ' +
    formatRands(perPlateCents(c.totalUsageCents, servings)) +
    " / plate" +
    extra +
    "</span>"
  );
}

function renderDecodeOutput() {
  const draft = window.__decodedDraft;
  const { matched, total, unpriced } = draftMetrics(draft);
  // P-447: swap suggestions come from the RESOLVED name ("white bread" -> related
  // breads); unresolved lines keep searching their raw text as before.
  const suggestions = (line) =>
    searchIngredients(
      line.resolvedName || line.raw,
      store.get().ingredients,
    ).slice(0, 5);

  $("#decode-output").innerHTML = `
    <div class="panel decode-result section-gap">
      <input id="dec-title" class="dec-title-input" value="${esc(draft.title || "")}" aria-label="Edit recipe title" maxlength="80">
      <div class="meta dec-meta-edit">
        <label class="muted">plates <input id="dec-servings" type="number" min="1" max="99" value="${draft.servings ?? ""}" aria-label="Edit servings"></label>
        <label class="muted">minutes <input id="dec-time" type="number" min="1" max="9999" value="${draft.timeMinutes ?? ""}" aria-label="Edit cook time"></label>
        ${draft.ovenTempC ? `<span class="dec-oven">oven ${draft.ovenTempC}°C</span>` : ""}${perPlateChip(draft.servings, draft.ingredients)}
      </div>
      <div class="confidence">
        <span class="chip dec-conf-band dec-conf-${confBand(draft.confidence)}">${CONF_TIERS[confBand(draft.confidence)].copy}</span>
        <span class="chip ${draft.reviewRequired ? "warn" : ""}">
          ${draft.reviewRequired ? `${DEC_COPY.bannerQueue} (${total - matched} of ${total} lines)` : DEC_COPY.bannerReady}
        </span>
        <span class="muted dec-acc">${matched}/${total} lines matched${unpriced ? ` · ${unpriced} unpriced: ${DEC_COPY.unpriced}` : ""}</span>
      </div>
      ${(draft.steps || []).length === 0 ? `<div class="review-note">${DEC_COPY.emptyQueue}</div>` : ""}
      <h3>Ingredients</h3>
      ${draft.ingredients
        .map((i, idx) =>
          i.resolvedName
            ? `<div class="missing-line dec-resolved ${window.__decSwap === idx ? "dec-swap-open" : ""}" data-idx="${idx}">
             <span class="dec-row-qty"><input class="dec-qty" data-idx="${idx}" type="number" min="0.25" step="0.25" value="${i.qty}" aria-label="Edit quantity"><select class="dec-unit" data-idx="${idx}" aria-label="Edit unit">${unitOptions(i.unit)}</select></span>
             <span class="dec-ing-name">→ ${esc(i.resolvedName)}${priceOf(i.resolvedId) ? "" : " · unpriced"}</span>
             <span class="dec-row-actions">
               <button type="button" class="dec-swap" data-idx="${idx}" aria-label="Match a different ingredient" title="Match a different ingredient">⇄ swap</button>
               <button type="button" class="dec-rm" data-idx="${idx}" aria-label="Remove ingredient">✕</button>
             </span>
             ${
               window.__decSwap === idx
                 ? `<div class="dec-suggest">
               <input class="dec-swap-search" data-idx="${idx}" placeholder="Type what you actually meant…" aria-label="Search the registry to swap in">
               <div class="dec-picker" data-idx="${idx}">
                 ${
                   suggestions(i)
                     .filter((s) => s.id !== i.resolvedId)
                     .map(
                       (s) =>
                         `<button type="button" class="px-chip dec-pick" data-idx="${idx}" data-ing="${esc(s.id)}">→ ${esc(s.name)}</button>`,
                     )
                     .join("") ||
                   '<span class="muted">start typing to search the registry</span>'
                 }
               </div>
             </div>`
                 : ""
             }
           </div>`
            : `<div class="missing-line dec-fix" data-idx="${idx}">
             <span>${i.qty} ${esc(i.unit)} — <input class="dec-edit" data-idx="${idx}" value="${esc(i.raw)}" aria-label="Edit ingredient line"></span>
             <span class="chip warn">unmatched</span>
             <button type="button" class="dec-rm" data-idx="${idx}" aria-label="Remove ingredient">✕</button>
             <div class="dec-suggest">
               ${
                 suggestions(i)
                   .map(
                     (s) =>
                       `<button type="button" class="px-chip dec-pick" data-idx="${idx}" data-ing="${esc(s.id)}">→ ${esc(s.name)}</button>`,
                   )
                   .join("") ||
                 '<span class="muted">no registry suggestion — type a name and pick below</span>'
               }
             </div>
             <div class="dec-picker" data-idx="${idx}"></div>
           </div>`,
        )
        .join("")}
      <button type="button" class="dec-step-add dec-add-ing" id="dec-add-ing">+ Add ingredient</button>
      ${
        window.__decAdd
          ? `<div class="missing-line dec-fix" data-idx="new">
        <input class="dec-swap-search" data-idx="new" placeholder="Type an ingredient name…" aria-label="Search the registry to add">
        <div class="dec-picker" data-idx="new"><span class="muted">start typing to search the registry</span></div>
      </div>`
          : ""
      }
      ${(() => {
        const ingLines = new Set(draft.ingredients.map((i) => i.raw));
        const notes = (draft.unresolved || []).filter(
          (u) => !ingLines.has(u.line),
        );
        return notes.length
          ? `<h3>Review notes</h3>${notes.map((u) => `<div class="review-note dec-note"><span class="dec-note-line">${esc(u.line)}</span> <span class="chip warn">${esc(DEC_COPY.reasons[u.reason] || u.reason)}</span><button type="button" class="dec-note-rm" data-line="${esc(u.line)}" aria-label="Remove this note">✕</button></div>`).join("")}`
          : "";
      })()}
      <h3>Steps</h3>
      <ol class="steps dec-steps">${draft.steps.map((s, idx) => `<li class="dec-step-card" data-step="${idx}"><span class="dec-step-num" draggable="true" data-idx="${idx}" title="Drag to reorder" aria-label="Drag step to reorder">${idx + 1}</span><textarea class="dec-step" data-idx="${idx}" rows="2" aria-label="Edit step">${esc(s)}</textarea><span class="dec-step-move"><button type="button" class="dec-step-up" data-idx="${idx}" aria-label="Move step up" ${idx === 0 ? "disabled" : ""}>↑</button><button type="button" class="dec-step-down" data-idx="${idx}" aria-label="Move step down" ${idx === draft.steps.length - 1 ? "disabled" : ""}>↓</button></span><button type="button" class="dec-step-rm" data-idx="${idx}" aria-label="Remove step">✕</button></li>`).join("") || '<li class="muted">none detected</li>'}</ol>
      <button type="button" class="dec-step-add" id="dec-step-add">+ Add step</button>
      ${(draft.serveWith || []).length ? `<div class="dec-servewith"><span class="muted">Serve with:</span> ${draft.serveWith.map((s) => `<span class="chip dec-serve-chip">${esc(s.resolvedName)}</span>`).join("")}</div>` : ""}
      ${
        draft.reviewRequired
          ? '<div class="review-note">Unreviewed drafts never enter the recipe pool – resolve or remove every line to unlock saving.</div>'
          : '<button id="save-decoded" style="margin-top:var(--sp-3)">Save to my collection</button>'
      }
    </div>`;

  // inline raw-line editing: retype -> fresh suggestions on Enter
  $$("#decode-output .dec-edit").forEach(
    (input) =>
      (input.onkeydown = (ev) => {
        if (ev.key !== "Enter") return;
        ev.preventDefault();
        const idx = Number(input.dataset.idx);
        const hits = searchIngredients(
          input.value,
          store.get().ingredients,
        ).slice(0, 5);
        const box = $(`.dec-picker[data-idx="${idx}"]`);
        box.innerHTML = hits.length
          ? hits
              .map(
                (h) =>
                  `<button type="button" class="px-chip dec-pick" data-idx="${idx}" data-ing="${esc(h.id)}">${esc(h.name)}</button>`,
              )
              .join("")
          : '<span class="muted">nothing in the registry sounds like that — try another spelling</span>';
      }),
  );

  // one-tap resolution — DELEGATED on the container, so picker chips created
  // by the Enter handler (after this render) are never dead buttons (P-404 fix)
  // P-446: delegation now also carries remove/add actions; edits go through
  // 'change'/'input' below and NEVER re-render mid-typing (focus preservation).
  const outEl = $("#decode-output");
  outEl.onclick = (ev) => {
    const noteRm = ev.target.closest(".dec-note-rm");
    if (noteRm) {
      draftSnapshot();
      gapOutcome(noteRm.dataset.line, "dropped_by_user"); // P-441: majority-drops ⇒ noise
      draft.unresolved = (draft.unresolved || []).filter(
        (u) => u.line !== noteRm.dataset.line,
      );
      recomputeDraft(draft);
      renderDecodeOutput();
      offerUndo(DEC_COPY.undoRemoved);
      return;
    }
    const swap = ev.target.closest(".dec-swap");
    if (swap) {
      window.__decSwap =
        window.__decSwap === Number(swap.dataset.idx)
          ? null
          : Number(swap.dataset.idx);
      renderDecodeOutput();
      return;
    }
    if (ev.target.closest("#dec-add-ing")) {
      window.__decAdd = !window.__decAdd;
      renderDecodeOutput();
      return;
    }
    const rm = ev.target.closest(".dec-rm");
    if (rm) {
      draftSnapshot();
      const idx = Number(rm.dataset.idx);
      const gone = draft.ingredients[idx];
      draft.ingredients.splice(idx, 1);
      if (gone)
        draft.unresolved = (draft.unresolved || []).filter(
          (u) => u.line !== gone.raw,
        );
      recomputeDraft(draft);
      renderDecodeOutput();
      offerUndo(DEC_COPY.undoRemoved);
      return;
    }
    const upBtn = ev.target.closest(".dec-step-up");
    if (upBtn && !upBtn.disabled) {
      const i = Number(upBtn.dataset.idx);
      [draft.steps[i - 1], draft.steps[i]] = [
        draft.steps[i],
        draft.steps[i - 1],
      ];
      renderDecodeOutput();
      return; // P-450: a move is not destructive — no undo toast
    }
    const downBtn = ev.target.closest(".dec-step-down");
    if (downBtn && !downBtn.disabled) {
      const i = Number(downBtn.dataset.idx);
      [draft.steps[i], draft.steps[i + 1]] = [
        draft.steps[i + 1],
        draft.steps[i],
      ];
      renderDecodeOutput();
      return;
    }
    const srm = ev.target.closest(".dec-step-rm");
    if (srm) {
      draftSnapshot();
      draft.steps.splice(Number(srm.dataset.idx), 1);
      recomputeDraft(draft);
      renderDecodeOutput();
      offerUndo(DEC_COPY.undoRemoved);
      return;
    }
    const addBtn = ev.target.closest(".dec-step-add");
    if (addBtn) {
      draftSnapshot();
      draft.steps.push("");
      recomputeDraft(draft);
      renderDecodeOutput();
      return;
    }
    const btn = ev.target.closest(".dec-pick");
    if (!btn) return;
    if (btn.dataset.idx === "new") {
      // P-448: add-ingredient flow
      draftSnapshot();
      const ing = store.get().ingredients.find((x) => x.id === btn.dataset.ing);
      const typed =
        $(`.dec-swap-search[data-idx="new"]`)?.value?.trim() || ing.name;
      draft.ingredients.push({
        raw: typed,
        qty: 1,
        unit: "unit",
        resolvedId: ing.id,
        resolvedName: ing.name,
      });
      window.__decAdd = false;
      recomputeDraft(draft);
      renderDecodeOutput();
      offerUndo(DEC_COPY.added);
      return;
    }
    const idx = Number(btn.dataset.idx);
    const ing = store.get().ingredients.find((x) => x.id === btn.dataset.ing);
    if (!ing) return;
    const line = draft.ingredients[idx];
    const wasResolved = !!line.resolvedName; // P-447: a SWAP keeps the user's qty/unit edits
    if (!wasResolved && line.raw)
      gapOutcome(line.raw, "resolved_by_picker", ing.id); // P-441
    // P-404: editing the raw line re-parses qty/unit honestly (the original
    // numbers may have been part of the confusing name)
    const reparsed = decodeRecipeText(
      line.raw + "\n1 onion\nCook it.",
      () => ing,
    ).ingredients[0];
    draft.ingredients[idx] = {
      ...line,
      qty: wasResolved ? line.qty : (reparsed?.qty ?? line.qty),
      unit: wasResolved ? line.unit : (reparsed?.unit ?? line.unit),
      resolvedId: ing.id,
      resolvedName: ing.name,
    };
    window.__decSwap = null;
    recomputeDraft(draft);
    renderDecodeOutput();
    offerUndo(DEC_COPY.undoChanged);
  };

  // P-450: HTML5 drag-to-reorder (desktop); touch uses the ↑/↓ buttons
  const dragged = { idx: null };
  $$(".dec-step-num").forEach((h) => {
    h.addEventListener("dragstart", (e) => {
      dragged.idx = Number(h.dataset.idx);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(dragged.idx));
      h.closest(".dec-step-card")?.classList.add("dragging");
    });
    h.addEventListener("dragend", () => {
      $$(".dec-step-card").forEach((c) =>
        c.classList.remove("dragging", "drag-over"),
      );
    });
  });
  $$(".dec-step-card").forEach((card) => {
    card.addEventListener("dragover", (e) => {
      e.preventDefault();
      card.classList.add("drag-over");
    });
    card.addEventListener("dragleave", () =>
      card.classList.remove("drag-over"),
    );
    card.addEventListener("drop", (e) => {
      e.preventDefault();
      card.classList.remove("drag-over");
      const from = dragged.idx ?? Number(e.dataTransfer.getData("text/plain"));
      const to = Number(card.dataset.step);
      if (
        from === null ||
        Number.isNaN(from) ||
        Number.isNaN(to) ||
        from === to
      )
        return;
      const [moved] = draft.steps.splice(from, 1);
      draft.steps.splice(to, 0, moved);
      renderDecodeOutput();
    });
  });

  const saveBtn = $("#save-decoded");
  if (saveBtn)
    saveBtn.onclick = async () => {
      // the engine gate (draftToRecipe throws on reviewRequired) stays ABSOLUTE —
      // the hidden button is UX; this throw is the law. P-446: edited values are
      // validated the same way and surface as a toast, never a silent failure.
      let recipe;
      try {
        recipe = draftToRecipe(window.__decodedDraft, {
          id: `decoded-${Date.now()}`,
        });
      } catch (e) {
        toast(DEC_COPY.saveBlocked(window.__decodedDraft.title, e.message));
        return;
      }
      // P-448 fast path: exact same title never double-saves silently
      const norm = (s) => String(s).toLowerCase().trim().replace(/\s+/g, " ");
      if (
        (store.get().savedRecipes || []).some(
          (r) => norm(r.title) === norm(recipe.title),
        )
      ) {
        toast(DEC_COPY.saveDup(recipe.title));
        return;
      }
      // P-440: deterministic similarity dedupe (advisory — asks, never blocks)
      const { ingredients } = store.get();
      const isIngWord = (w) => !!searchIngredients(w, ingredients)[0];
      const prep = (r) => {
        const p = prepareRecipe(r, isIngWord);
        return { id: r.id, title: r.title, ...p };
      };
      // P-440 nag-killer: dismissal is keyed on the draft's CONTENT signature,
      // never its ephemeral id — re-decoding the same caption + "new recipe"
      // silences the pair forever, not just this draft instance.
      const draftSig = (d) => d.normTitle + "|" + [...d.ids].sort().join(",");
      const dismissedKey = (d, c) => `dedupe_dismissed/${draftSig(d)}||${c.id}`;
      const dismissedPair = (d, c) =>
        localStorage.getItem(dismissedKey(d, c)) === "1";
      const dRec = {
        id: recipe.id,
        title: recipe.title,
        ...prepareRecipe(recipe, isIngWord),
      };
      const cands = [
        ...(store.get().savedRecipes || []).map(prep),
        ...(store.get().recipes || [])
          .filter(
            (r) =>
              r.source?.platform !== "decoder-lab" && r.ingredients?.length,
          )
          .map(prep),
      ];
      const hits = findDuplicates(dRec, cands, dismissedPair);
      if (hits.length) {
        renderDedupePrompt(hits[0], recipe, dRec, dismissedKey);
        return;
      }
      commitDecodedSave(recipe);
    };

  async function commitDecodedSave(recipe, meta) {
    if (meta) recipe.meta = meta;
    await db.put("saved_recipes", recipe);
    const saved = await db.getAll("saved_recipes");
    store.set({
      savedRecipes: saved,
      recipes: mergeUserRecipes(store.get().recipes, saved),
    });
    checkBadgeUnlocks(); // P-561: kitchen-decoder / recipe-whisperer
    toast(DEC_COPY.saveOk(recipe.title));
    renderDecodeOutput();
    renderDecodedLibrary();
  }

  /** P-440: dedupe prompt — advisory tiers with the P-427 findings' copy. */
  function renderDedupePrompt(hit, recipe, dRec, dismissedKey) {
    const el =
      $("#dec-dedupe-prompt") ||
      (() => {
        const d = document.createElement("div");
        d.id = "dec-dedupe-prompt";
        $("#decode-output").prepend(d);
        return d;
      })();
    const isLib = !(store.get().savedRecipes || []).some(
      (r) => r.id === hit.id,
    );
    const auto = hit.tier === "auto";
    el.innerHTML = `
      <div class="panel dec-dedupe" style="border-left:3px solid var(--clr-brand)">
        <p class="dec-dedupe-copy">${
          auto
            ? `You've already saved this one. <strong>“${esc(hit.title)}”</strong> looks like the same recipe — add it again anyway?`
            : isLib
              ? `Our library already has <strong>“${esc(hit.title)}”</strong>. Open that one instead?`
              : `This looks close to <strong>“${esc(hit.title)}”</strong>. Same recipe, or a new one?`
        }</p>
        <div class="dec-dedupe-actions">
          <button type="button" class="dec-dedupe-open" data-id="${esc(hit.id)}" data-title="${esc(hit.title)}">
            ${auto ? "Open saved recipe" : isLib ? "Open library recipe" : "Same recipe — open it"}</button>
          <button type="button" class="dec-dedupe-anyway">${auto ? "Add anyway" : isLib ? "Save mine" : "New recipe — save"}</button>
        </div>
      </div>`;
    el.querySelector(".dec-dedupe-anyway").onclick = () => {
      if (!auto) localStorage.setItem(dismissedKey(dRec, hit), "1"); // nag-killer
      el.remove();
      commitDecodedSave(
        recipe,
        auto
          ? { savedFrom: "decoder", duplicateOf: hit.id }
          : { savedFrom: "decoder" },
      );
    };
    el.querySelector(".dec-dedupe-open").onclick = () => {
      if (!auto) localStorage.setItem(dismissedKey(dRec, hit), "1");
      el.remove();
      const q = $("#matcher-search") || $("#pantry-search");
      location.hash = "#matcher";
      if (q) {
        setTimeout(() => {
          q.value = hit.title;
          q.dispatchEvent(new Event("input", { bubbles: true }));
        }, 350);
      }
    };
    el.scrollIntoView({ behavior: motionBehavior(), block: "start" });
  }

  // P-446: live-edit wiring. Silent updates on typing (no re-render = no focus
  // loss); structural changes re-render via the click delegation above.
  outEl.oninput = (ev) => {
    const t = ev.target;
    if (t.id === "dec-title") draft.title = t.value;
    else if (t.classList.contains("dec-step"))
      draft.steps[Number(t.dataset.idx)] = t.value;
    else if (t.classList.contains("dec-swap-search")) {
      // P-448: live registry search
      // P-441: the user is SEARCHING for this unresolved line — if they never
      // pick, that is the strongest registry-gap signal in the log.
      if (t.value.trim() && t.dataset.idx !== "new") {
        const row = draft.ingredients[Number(t.dataset.idx)];
        if (row && !row.resolvedName && row.raw)
          gapOutcome(row.raw, "unresolved_after_pick");
      }
      const box = $(`.dec-picker[data-idx="${t.dataset.idx}"]`);
      if (!box) return;
      const hits = t.value.trim()
        ? searchIngredients(t.value, store.get().ingredients).slice(0, 6)
        : [];
      box.innerHTML = hits.length
        ? hits
            .map(
              (h) =>
                `<button type="button" class="px-chip dec-pick" data-idx="${t.dataset.idx}" data-ing="${esc(h.id)}">→ ${esc(h.name)}</button>`,
            )
            .join("")
        : '<span class="muted">nothing sounds like that — try another spelling</span>';
    }
  };
  outEl.onchange = (ev) => {
    const t = ev.target;
    if (t.id === "dec-servings")
      draft.servings = t.value ? Math.round(Number(t.value)) : null;
    else if (t.id === "dec-time")
      draft.timeMinutes = t.value ? Math.round(Number(t.value)) : null;
    else if (t.classList.contains("dec-qty"))
      draft.ingredients[Number(t.dataset.idx)].qty = Number(t.value) || t.min;
    else if (t.classList.contains("dec-unit"))
      draft.ingredients[Number(t.dataset.idx)].unit = t.value;
  };
}

// ---------------- global events ----------------

function wireGlobalEvents() {
  // P-531: every "show me how" empty-state link routes home and scrolls the
  // matching guide section into view below the sticky chrome.
  document.addEventListener("click", (e) => {
    const g = e.target.closest("[data-guide]");
    if (g) goGuide(g.dataset.guide);
  });
  // pantry
  $("#pantry-search").addEventListener("input", (e) =>
    renderPantrySuggestions(e.target.value),
  );
  $("#pantry-export").onclick = async () => {
    // serializePantry: deterministic rows + format_version v1 (backup.js contract)
    const blob = new Blob(
      [JSON.stringify(serializePantry(await db.getAll("pantry")), null, 2)],
      { type: "application/json" },
    );
    downloadBlob(blob, "randplates-pantry.json");
  };
  $("#pantry-import-btn").onclick = () => $("#pantry-import").click();
  $("#pantry-import").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const res = validatePantryImport(await file.text(), {
      knownIds: new Set(store.get().ingredients.map((i) => i.id)),
    });
    if (!res.ok) {
      // specific, human errors: the first one in the toast, all of them in the console
      toast(`Couldn't import: ${res.errors[0].message}`);
      console.warn(
        "[randplates] import rejected —",
        res.errors.length,
        "error(s):",
      );
      for (const err of res.errors) console.warn("  ", err.message);
      e.target.value = "";
      return;
    }
    for (const item of res.data.pantry) await db.putPantryItem(item);
    await refreshPantry();
    if (res.warnings.length) {
      toast(
        `Pantry imported: ${res.data.pantry.length} items — ${res.warnings[0]}`,
      );
      for (const w of res.warnings)
        console.warn("[randplates] import warning:", w);
    } else {
      toast(`Pantry imported: ${res.data.pantry.length} items`);
    }
    e.target.value = "";
  };

  // P-112: floating back-to-top button — long result lists (and Surprise picks
  // way down the page) made getting back to the filters a chore.
  const scrollTop = $("#scroll-top");
  window.addEventListener(
    "scroll",
    () => {
      scrollTop.classList.toggle("show", window.scrollY > 600);
    },
    { passive: true },
  );
  scrollTop.onclick = () =>
    window.scrollTo({ top: 0, behavior: motionBehavior() });

  // matcher — P-111 tune panel
  // Plate slider: a pure VIEW filter (perPlateCents is on every scored recipe),
  // so it re-renders instantly with no worker round-trip. Persist is debounced.
  const plateDial = $("#plate-dial");
  let plateTimer = null;
  // P-201: input events fire per-pixel; re-rendering the whole results list on
  // each one drops frames at 150-pantry scale. Coalesce to ONE render per frame.
  let dialFrame = null;
  plateDial.addEventListener("input", () => {
    const cents = parseInt(plateDial.value, 10);
    store.update("matcher", {
      plateMaxCents: cents >= parseInt(plateDial.max, 10) ? null : cents,
    });
    updatePlateUI();
    if (!dialFrame)
      dialFrame = requestAnimationFrame(() => {
        dialFrame = null;
        renderResults();
      });
    clearTimeout(plateTimer);
    plateTimer = setTimeout(persistMatcherFilters, 400);
  });
  // P-104T: meal chips re-rank instantly; the choice persists (settings) across visits
  $$("#meal-chips .meal-chip").forEach(
    (b) =>
      (b.onclick = () => {
        const v = b.dataset.meal; // '' = Anything
        store.update("matcher", { mealChoice: v });
        db.setSettings({ mealChoice: v });
        computeAndRender();
      }),
  );
  wireMatcherDelegation();

  const wireChips = (rowSel, apply) =>
    $$(rowSel + " .fchip").forEach((b) => (b.onclick = () => apply(b.dataset)));
  // view filters — instant
  wireChips("#tier-chips", (d) => setViewFilter({ tier: d.tier }));
  wireChips("#missing-chips", (d) =>
    setViewFilter({
      maxMissing: d.missing === "" ? null : parseInt(d.missing, 10),
    }),
  );
  $$("#tag-chips .fchip").forEach(
    (b) =>
      (b.onclick = () => {
        const t = b.dataset.tag;
        const cur = new Set(store.get().matcher.tagFilter);
        cur.has(t) ? cur.delete(t) : cur.add(t);
        setViewFilter({ tagFilter: [...cur] });
      }),
  );
  $("#fav-only").onclick = () =>
    setViewFilter({ favouritesOnly: !store.get().matcher.favouritesOnly });
  $("#sort-mode").onchange = (e) => setViewFilter({ sortMode: e.target.value });
  $("#tune-reset").onclick = resetAllFilters;
  $("#surprise-btn").onclick = surpriseMe;
  // engine constraints — these change eligibility, so they re-score
  wireChips("#time-chips", (d) => {
    store.update("matcher", {
      maxTimeMin: d.time ? parseInt(d.time, 10) : null,
    });
    persistMatcherFilters();
    computeAndRender();
  });
  wireChips("#diet-chips", (d) => {
    store.update("matcher", { dietary: d.diet || null });
    persistMatcherFilters();
    computeAndRender();
  });
  // P-539: coverage floor ("I have >= N% already") + feeds floor — pure view
  // filters, instant, compose with search and every other filter.
  wireChips("#coverage-chips", (d) =>
    setViewFilter({
      minCoverage: d.coverage ? parseInt(d.coverage, 10) : null,
    }),
  );
  wireChips("#feeds-chips", (d) =>
    setViewFilter({ minFeeds: d.feeds ? parseInt(d.feeds, 10) : null }),
  );

  // planner
  // P-301: day cells are buttons re-created on every drawPlan — delegate clicks.
  $("#plan-output").addEventListener("click", (e) => {
    const cell = e.target.closest(".day-cell");
    // P-308: a placed day opens ITS OWN detail (stats + swap + clear) — the swap
    // list stays for empty days and explicit swapping, never a blunt default.
    if (cell) {
      const d = parseInt(cell.dataset.day, 10);
      const meal = store.get().planner.plan?.days?.[d]?.meal;
      if (meal) openPlacedDetail(d, meal.recipeId);
      else openDayPicker(d);
    }
    // P-306: check-off mode removed — the WhatsApp copy and the PDF report are
    // the take-to-store formats; the slip stays a static document.
    if (e.target.closest("#pdf-plan"))
      downloadPlanPdf(store.get().planner.plan);
  });
  // P-301: arrows move between days (grid rows are responsive, so Up/Down picks
  // the nearest cell by geometry, not a fixed column count); Enter/Space are the
  // native button activation; Esc is the dialog's native cancel.
  $("#plan-output").addEventListener("keydown", (e) => {
    const cell = e.target.closest(".day-cell");
    if (!cell) return;
    const cells = $$("#plan-output .day-cell");
    const i = cells.indexOf(cell);
    let j = null;
    if (e.key === "ArrowRight") j = Math.min(cells.length - 1, i + 1);
    else if (e.key === "ArrowLeft") j = Math.max(0, i - 1);
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = cells.length - 1;
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const rect = cell.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      let best = null;
      cells.forEach((c, k) => {
        if (k === i) return;
        const r = c.getBoundingClientRect();
        if (
          e.key === "ArrowDown"
            ? r.top >= rect.bottom - 4
            : r.bottom <= rect.top + 4
        ) {
          const d = Math.abs(r.left + r.width / 2 - cx);
          if (!best || d < best.d) best = { k, d };
        }
      });
      if (best) j = best.k;
    }
    if (j !== null) {
      e.preventDefault();
      cells[j].focus();
    }
  });
  // picker: roving keyboard inside the list, Esc returns focus to the origin day
  $("#mp-list").addEventListener("keydown", wirePickerKeys);
  $("#mp-close").onclick = () => $("#meal-picker").close();
  $("#mpd-close").onclick = () => $("#mp-detail").close();
  $("#mp-detail").addEventListener("close", () => {
    // Esc from the detail returns to the picker list, focus on the origin row
    if (lastPickerState && lastPickerState.originRow)
      lastPickerState.originRow.focus();
  });
  $("#meal-picker").addEventListener("close", () => {
    const cell = $(`.day-cell[data-day="${pickerOriginDay}"]`);
    if (cell) cell.focus();
  });
  $("#plan-week").onclick = () => runPlannerPlan({ announce: true });
  wireSavedPlans(); // P-310a: save/load/delete/slip on the planner

  // P-307: THE PLANNER IS DYNAMIC — budget and plates re-plan live (debounced).
  // Only when a plan exists: typing into an empty planner shouldn't auto-start one.
  let dialTimer = null;
  $("#week-budget").addEventListener("input", () => {
    clearTimeout(dialTimer);
    dialTimer = setTimeout(() => {
      if (store.get().planner.plan) runPlannerPlan({ announce: false });
    }, 400);
  });
  $("#week-servings").addEventListener("change", () => {
    if (store.get().planner.plan) runPlannerPlan({ announce: false });
  });

  // decoder
  $("#decode-run").onclick = runDecoder;

  // P-436: onboarding — help overlay + one-tap samples (fill + decode)
  const help = $("#dec-help");
  $("#dec-help-open").onclick = () => {
    help.hidden = false;
    $("#dec-help-close").focus();
  };
  $("#dec-help-close").onclick = () => {
    help.hidden = true;
  };
  help.addEventListener("click", (ev) => {
    if (ev.target === help) help.hidden = true;
  });
  $$(".dec-sample").forEach(
    (btn) =>
      (btn.onclick = () => {
        $("#decode-input").value = DEC_SAMPLES[btn.dataset.sample];
        runDecoder();
        $("#decode-output").scrollIntoView({
          behavior: motionBehavior(),
          block: "start",
        }); // below sticky chrome, measured offset in CSS
      }),
  );

  // settings
  $("#export-all").onclick = async () => {
    const blob = new Blob([JSON.stringify(await db.exportAll(), null, 2)], {
      type: "application/json",
    });
    downloadBlob(blob, "randplates-backup.json");
  };
  $("#import-all-btn").onclick = () => $("#import-all").click();
  $("#import-all").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const { merged, keptLocal } = await db.importAll(
        JSON.parse(await file.text()),
      );
      await boot();
      toast(`Backup merged — ${merged} in, ${keptLocal} newer kept`);
    } catch {
      toast("Not a RandPlates backup file");
    }
    e.target.value = ""; // re-importing the same file must re-fire onchange
  };
  $("#wipe-all").onclick = async () => {
    if (
      !confirm(
        "Erase pantry, cook log and saved recipes from this browser? This cannot be undone.",
      )
    )
      return;
    for (const s of [
      "pantry",
      "cook_log",
      "saved_plans",
      "saved_recipes",
      "gap_log",
    ])
      await db.clear(s);
    await boot();
    toast("All data erased — fresh kitchen");
  };

  // P-546b granular wipe — one collection, confirmed, nothing else touched
  const WIPE_LABELS = {
    pantry: "pantry",
    cook_log: "cook log",
    saved_plans: "saved plans",
    saved_recipes: "saved recipes",
    gap_log: "decoder gap log",
  };
  for (const btn of $$("[data-wipe]"))
    btn.onclick = async () => {
      const store = btn.dataset.wipe;
      if (store === "settings") {
        if (
          !confirm(
            "Reset ALL settings (theme, budget, household) to defaults? Your pantry, cook log and recipes stay.",
          )
        )
          return;
        localStorage.removeItem("randplates.settings");
        await boot();
        toast("Settings reset to defaults");
        return;
      }
      if (
        !confirm(
          `Erase your ${WIPE_LABELS[store] || store}? This cannot be undone.`,
        )
      )
        return;
      await db.clear(store);
      await boot();
      toast(`${WIPE_LABELS[store] || store} erased`);
    };

  // P-546b storage meter — honest, live, no fake numbers
  if (navigator.storage?.estimate) {
    navigator.storage
      .estimate()
      .then(({ usage, quota }) => {
        const mb = (usage / 1048576).toFixed(1);
        const pct = quota
          ? Math.min(100, Math.round((usage / quota) * 100))
          : null;
        $("#storage-meter").textContent =
          pct != null
            ? `RandPlates is using about ${mb} MB of your device storage (${pct}% of the space your browser granted).`
            : `RandPlates is using about ${mb} MB of your device storage.`;
      })
      .catch(() => {
        $("#storage-meter").textContent =
          "Storage usage not available on this browser.";
      });
  } else {
    $("#storage-meter").textContent =
      "Storage usage not available on this browser.";
  }

  // P-546b price-correction mailto — pre-filled for the owner to re-verify
  const PRICE_MAILTO =
    "mailto:tadiwachopambaweb@gmail.com" +
    "?subject=" +
    encodeURIComponent("RandPlates price correction") +
    "&body=" +
    encodeURIComponent(
      "Hi Tadiwa,\n\nI spotted a price that looks wrong in RandPlates.\n\n" +
        "Item: \nStore (and branch if you remember): \nPrice on the shelf (R): \n" +
        "Date I saw it: \n\nThanks — this helps every plate stay honest.",
    );
  const prl = $("#price-report-link");
  if (prl) prl.href = PRICE_MAILTO;
  $("#settings-stamp").textContent = store.get().priceMeta.last_verified || "—";
  $("#settings-version").textContent = store.get().priceMeta.version || "—";
  wireSettingsPanel();
}

/** P-545: fill every preference input from the persisted profile, then wire the
 *  change handlers. Every handler drives REAL behavior + persists (a setting
 *  that changes nothing would be deleted at review time — none here are). */
function wireSettingsPanel() {
  const s = db.getSettings();
  const prof = s.profile || {};
  const disp = s.display || {};
  $("#st-household").value = Number.isFinite(prof.household)
    ? prof.household
    : 2;
  // blank servings = "same as household" (the note explains the coupling)
  $("#st-servings").value = Number.isFinite(prof.defaultServings)
    ? prof.defaultServings
    : "";
  $("#st-weekly").value = Math.round(
    (Number.isFinite(s.budgetCents)
      ? s.budgetCents
      : store.get().matcher.budgetCents) / 100,
  );
  $("#st-plate").value = Number.isFinite(s.plateCeilCents)
    ? Math.round(s.plateCeilCents / 100)
    : "";
  // P-557: theme dropdown (13 atlas entries) + mode dropdown
  const themeSel = $("#st-theme");
  themeSel.innerHTML = THEMES.map(
    (t) => `<option value="${t.id}">${t.name}</option>`,
  ).join("");
  themeSel.value = (THEMES.find((t) => t.id === disp.theme) || THEMES[0]).id;
  $("#st-mode").value = ["light", "dark", "auto"].includes(disp.mode)
    ? disp.mode
    : "light";
  $("#st-theme-note").textContent = (
    THEMES.find((t) => t.id === themeSel.value) || THEMES[0]
  ).vibe;

  // -- profile: household + servings (planner defaults + cook size) --
  const saveProfile = () =>
    db.setSettings({ profile: { ...profileOf(), ...readProfileInputs() } });
  const readProfileInputs = () => {
    const num = (el, fallback) => {
      const v = parseInt($(el).value, 10);
      return Number.isFinite(v) && v > 0 ? Math.min(12, v) : fallback;
    };
    const svRaw = parseInt($("#st-servings").value, 10);
    return {
      household: num("#st-household", 2),
      defaultServings:
        Number.isFinite(svRaw) && svRaw > 0 ? Math.min(12, svRaw) : null, // null = follow household
    };
  };
  const profileChanged = () => {
    saveProfile();
    const { household, defaultServings } = readProfileInputs();
    store.update("planner", {
      household,
      servings: defaultServings || household,
    });
    $("#st-servings-note").textContent = defaultServings
      ? `Servings set the Planner's plates and every recipe card's default cook size (currently ${defaultServings}).`
      : `Servings are blank, so they follow people in the house (${household}). Set a number to decouple them.`;
    if (store.get().view === "planner") renderPlanner();
    computeAndRender(); // cook-size changes re-rank the Matcher live
    toast("Profile saved — Planner re-ranked");
  };
  $("#st-household").onchange = profileChanged;
  $("#st-servings").onchange = profileChanged;

  // -- budget defaults --
  const budgetChanged = () => {
    const weekly = Math.max(0, (parseFloat($("#st-weekly").value) || 0) * 100);
    const plateRaw = parseFloat($("#st-plate").value);
    const plate =
      Number.isFinite(plateRaw) && plateRaw > 0
        ? Math.round(plateRaw * 100)
        : null;
    db.setSettings({ budgetCents: weekly, plateCeilCents: plate });
    store.update("matcher", { budgetCents: weekly, plateMaxCents: plate });
    store.update("planner", { weekBudgetCents: weekly });
    persistMatcherFilters();
    if (store.get().view === "planner") renderPlanner();
    computeAndRender();
    toast(
      plate
        ? `Budget saved — R${Math.round(weekly / 100)} weekly, R${Math.round(plate / 100)} a plate`
        : `Budget saved — R${Math.round(weekly / 100)} weekly`,
    );
  };
  $("#st-weekly").onchange = budgetChanged;
  $("#st-plate").onchange = budgetChanged;

  // -- look & feel --
  const displayChanged = () => {
    const themeId = $("#st-theme").value;
    const d = db.getSettings().display || {};
    const tried = [...new Set([...(d.themesTried || []), themeId])]; // P-561: theme badges
    db.setSettings({
      display: {
        theme: themeId,
        mode: $("#st-mode").value,
        themesTried: tried,
      },
    });
    applyDisplayPrefs();
    const t = THEMES.find((x) => x.id === themeId);
    if (t) $("#st-theme-note").textContent = t.vibe;
    checkBadgeUnlocks(); // P-561: new-look / full-wardrobe
  };
  $("#st-theme").onchange = () => {
    displayChanged();
    toast(
      `Theme: ${THEMES.find((t) => t.id === $("#st-theme").value)?.name || ""}`,
    );
  };
  $("#st-mode").onchange = displayChanged;
}

function downloadBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

boot().catch((err) => {
  document.body.insertAdjacentHTML(
    "afterbegin",
    `<div style="padding:1rem;background:#fdecec;color:#b91c1c;font-family:sans-serif">
     RandPlates failed to boot: ${String(err.message || err)}<br>
     <small>Running from file:// won't work — serve the folder over http (see README).</small></div>`,
  );
});
