/* ============================================================================
 * PANTRY MATH (P-536) — pure functions, decoder-grade.
 * Extracted from main.js so the red-team blast (scripts/pantry-blast.mjs) can
 * import and hammer them under node, same contract as the decoder corpus.
 * NO DOM, NO store, NO fetch: everything arrives as arguments.
 * ========================================================================== */

export const STEP_BY_UNIT = { g: 50, ml: 100 }; // fallback only (no unit_basis known)
export const NICE_STEPS = [25, 50, 100, 150, 200, 250, 500, 1000]; // real SA kitchen measures

/* ---- pack vocabulary (P-534) -------------------------------------------- */
export const PACK_WORDS = {
  sweetcorn: "tin",
  "tomato-paste": "tin",
  "whole-peeled-tomatoes": "tin",
  "white-bread": "loaf",
  "brown-bread": "loaf",
  "cooking-oil": "bottle",
  "fresh-milk": "bottle",
  amasi: "bottle",
  "long-life-milk": "carton",
  eggs: "eggs",
  butter: "block",
  margarine: "tub",
};
export const PACK_WORD_BY_AISLE = { "protein-tinned": "tin" };
export const NOT_TINNED = new Set([
  "soya-chunks",
  "soya-mince",
  "soup-mix",
  "firm-tofu",
  "mixed-bean-salad",
]); // packets/tubs in a tinned aisle

export function shelfWord(meta) {
  if (PACK_WORDS[meta?.id]) return PACK_WORDS[meta.id];
  if (meta?.aisle === "protein-tinned" && !NOT_TINNED.has(meta.id))
    return "tin";
  return null;
}

export function packSizeLabel(qty, unit) {
  if (unit === "g")
    return qty >= 1000 ? `${+(qty / 1000).toFixed(2)} kg` : `${qty} g`;
  if (unit === "ml")
    return qty >= 1000 ? `${+(qty / 1000).toFixed(2)} L` : `${qty} ml`;
  return null;
}

export function packLabel(basis, meta) {
  if (!basis) return "";
  const { qty, unit } = basis;
  if (unit === "g" || unit === "ml") {
    const size = packSizeLabel(qty, unit);
    const word = shelfWord(meta);
    return word ? `1 x ${size} ${word}` : `1 x ${size}`; // "1 x 410 g tin" (P-534 form)
  }
  const word = shelfWord(meta);
  if (word)
    return qty === 1
      ? `1 ${word}`
      : `${qty} ${word}${word === "eggs" ? "" : "s"}`; // "6 eggs", "2 tins"
  if (unit === "unit") return qty === 1 ? "1 item" : `${qty}-pack`;
  if (unit === "bunch") return qty === 1 ? "1 bunch" : `${qty} bunches`;
  if (unit === "can") return qty === 1 ? "1 can" : `${qty} cans`;
  if (unit === "tin") return qty === 1 ? "1 tin" : `${qty} tins`;
  return `${qty} ${unit}`;
}

export function badgeWord(meta, packs) {
  const singular = Math.abs(packs - 1) < 0.005;
  const word = shelfWord(meta);
  const uw = meta?.unit_basis?.unit;
  if (word) return singular ? word : word + (word === "eggs" ? "" : "s");
  if (uw === "bunch") return singular ? "bunch" : "bunches";
  if (uw === "tin") return singular ? "tin" : "tins";
  if (uw === "can") return singular ? "can" : "cans";
  return singular ? "pack" : "packs";
}

/** SAFETY (P-536 spec): basisQty <= 0 must never produce Infinity/NaN.
 *  Hand-stamped expected: null. */
export function packsCount(qty, basisQty) {
  if (!(basisQty > 0)) return null; // P-536 fix: guard the divide
  const packs = qty / basisQty;
  return Math.abs(packs - Math.round(packs)) < 0.005
    ? Math.round(packs)
    : +packs.toFixed(1);
}

/** Stepper: quarter-of-usual-buy snapped to a real kitchen measure.
 *  basis may be null (no unit_basis / no override) → unit fallbacks. */
export function stepSizeFor(basis, unit) {
  if ((unit === "g" || unit === "ml") && basis && basis.unit === unit) {
    const target = Math.max(basis.qty / 4, 25);
    return NICE_STEPS.reduce(
      (best, n) => (Math.abs(n - target) < Math.abs(best - target) ? n : best),
      NICE_STEPS[0],
    );
  }
  return STEP_BY_UNIT[unit] || 1;
}

/** P-535: the pantry record's own usual-buy form — pack override beats the
 *  registry default when the user says "I buy the 2.5 kg bag". */
export function pantryBasis(p, meta) {
  const o = p?.pack_override;
  if (o && o.qty > 0 && o.unit) return o;
  return meta?.unit_basis;
}

/** Expiring-this-week filter: only REAL expiry dates count (estimates would
 *  make the filter lie about what the user actually knows). */
export function expiringThisWeek(p) {
  if (!p.expiry) return false;
  const t = new Date(p.expiry + "T00:00:00").getTime();
  if (Number.isNaN(t)) return false;
  const days = Math.ceil((t - Date.now()) / 864e5);
  return days <= 7;
}

/** P-536: days-until-expiry by best evidence, priority:
 *  user expiry > created_date + typical shelf life > bare shelf life.
 *  'user'/'estimate' are live counts; 'shelf' is the static window. */
export function expiryEstimate(p, meta) {
  const shelf = meta?.shelf_life_days;
  if (p.expiry) {
    const t = new Date(p.expiry + "T00:00:00").getTime();
    if (!Number.isNaN(t))
      return { kind: "user", days: Math.ceil((t - Date.now()) / 864e5), shelf };
  }
  if (shelf === undefined) return null;
  if (p.created_date) {
    const added = new Date(p.created_date).getTime();
    if (!Number.isNaN(added)) {
      const elapsed = Math.floor((Date.now() - added) / 864e5);
      return {
        kind: "estimate",
        days: Math.max(0, shelf - elapsed),
        shelf,
        added: p.created_date,
        elapsed,
      };
    }
  }
  return { kind: "shelf", days: shelf, shelf };
}

/** Use-soon classification: the estimate counts too — elapsed time eats the
 *  shelf window, so a 30-day item added 25 days ago IS use-soon. */
export function useSoonInfo(p, meta) {
  const est = expiryEstimate(p, meta);
  if (!est) return null;
  if (est.kind === "user") return est.days <= 7 ? est : null;
  return est.days <= 7 ? est : null;
}

/** Pantry item status for the chips: low | soon | ok.
 *  P-540 red-team (owner: confusing dual labels): TIME BEATS QUANTITY. An item
 *  that is BOTH under the running-low band AND inside its use-soon window is
 *  'soon' — the shelf clock is the binding constraint and the actionable one
 *  ("cook it this week"), so it lives in exactly ONE bucket and carries exactly
 *  ONE tag. The running_low FLAG itself is untouched (the matcher badge keeps
 *  its own, never-contradicting semantics). */
export function pantryStatusOf(p, meta) {
  if (useSoonInfo(p, meta)) return "soon";
  if (p.running_low) return "low";
  return "ok";
}
