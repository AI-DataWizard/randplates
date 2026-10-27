// store.js — the ONLY shared mutable state (PRD §10 rule 2).
// Pub/sub state manager. Screens subscribe; nobody reads each other's internals.

const listeners = new Set();

export const store = {
  state: {
    view: "home",
    // static data (loaded once at bootstrap)
    ingredients: [], // ingredients.json items
    prices: [], // prices.json entries
    recipes: [], // recipes.json recipes (+ any user-decoded saved ones)
    priceMeta: { last_verified: null, version: null },
    // user state (mirrors IndexedDB; db.js is the persistence layer, store is the live copy)
    pantry: [], // [{ id, qty, unit, running_low, added_date }]
    cookLog: [], // [{ id, date, recipeId, title, perPlateCents, servings, missingCount }]
    savedRecipes: [], // user-decoded recipes
    savedPlans: [], // P-310a: named planner snapshots (db 'saved_plans')
    // matcher screen state
    matcher: {
      budgetCents: 60000, // R600 default weekly budget (readiness cutoff + planner)
      dietary: null, // 'vegetarian' | 'vegan' | null
      maxTimeMin: null,
      plateMaxCents: null, // P-111 per-plate price cap (null = any) — view filter
      tier: "all", // 'all' | 'ready' | 'almost' | 'stretch' — view filter
      maxMissing: null, // max missing items (null = any) — view filter
      minCoverage: null, // P-539 coverage floor: ">= N% already mine" (null = any) — view filter
      minFeeds: null, // P-539 feeds floor: "feeds N+" (null = any) — view filter
      tagFilter: [], // AND-ed tag chips — view filter
      favouritesOnly: false, // view filter
      ingredientFocus: null, // P-535 deep-link: recipes using this ingredient (from the pantry dossier)
      search: "", // P-537 recipe search bar — in-memory only (session-scoped, never persisted)
      sortMode: "match", // 'match' | 'cheap' | 'fast' | 'fewest'
      mealChoice: null, // '' = Anything, null = auto (time-of-day)
      favouriteIds: [],
      results: [],
      computing: false,
    },
    // planner screen state
    planner: { weekBudgetCents: 60000, servings: 2, plan: null },
    // ui
    toast: null, // { message, undoFn? }
    online: true,
    ready: false,
  },

  get() {
    return this.state;
  },

  /** Shallow-merge a patch into state and notify subscribers. */
  set(patch) {
    for (const k in patch) this.state[k] = patch[k];
    this._notify(patch);
  },

  /** Update one namespaced slice, e.g. update('matcher', {budgetCents: x}) */
  update(key, patch) {
    this.state[key] = { ...this.state[key], ...patch };
    this._notify({ [key]: this.state[key] });
  },

  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  _notify(changed) {
    for (const fn of listeners) {
      try {
        fn(this.state, changed);
      } catch (e) {
        console.error("[store] listener error", e);
      }
    }
  },
};
