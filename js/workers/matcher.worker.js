// matcher.worker.js — scoring off the main thread (PRD §7.3).
// ES module worker: the Budget Dial re-ranks on every move while the UI stays 60fps.
// main.js falls back to synchronous scoring if Worker construction fails (e.g. file://).
//
// P-104S: the payload must be PLAIN DATA — functions cannot cross postMessage
// (structuredClone throws DataCloneError; this silently killed the matcher in
// real browsers before the fix). priceOf is rebuilt HERE from priceEntries.

import { rankRecipes } from "../modules/matcher.js";
import { defaultPrice } from "../modules/costing.js";

self.onmessage = (e) => {
  const { type, payload } = e.data;
  if (type !== "score") return;
  const { recipes, ingredients, priceEntries, ctx } = payload;
  const priceMap = {};
  for (const entry of priceEntries)
    (priceMap[entry.ingredient_id] ||= []).push(entry);
  const priceOf = (id) => defaultPrice(id, priceMap[id] || []);
  // P-567d #2: same line-aware picker as the main thread — worker parity.
  const rowsOf = (id) => priceMap[id] || [];
  const results = rankRecipes(recipes, {
    ...ctx,
    ingredients,
    priceOf,
    rowsOf,
  });
  self.postMessage({ type: "scored", payload: { results } });
};
