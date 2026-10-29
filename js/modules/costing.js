// costing.js — money math (PRD §10 rule 3: ALL money in integer cents internally;
// format to rands only at render). Pure functions: no DOM, no fetch, no IndexedDB.
//
// Unit contract (PRD recipes.SCHEMA.md):
//   g / ml / unit / can / bunch  → map directly onto the priced pack basis
//   tsp / tbsp / slice / clove / pinch / handful → converted to grams via documented
//   approximations (rough-draft constants — refine in Phase 2 with real measurements)

/** Kitchen-unit → gram approximations (documented rough draft constants). */
export const UNIT_TO_GRAMS = {
  tsp: 5,
  tbsp: 15,
  pinch: 1,
  clove: 3,
  handful: 30,
  brick: 500, // P-425: SA commercial butter block (Clover/Parmalat 500g)
  stick: 113.4, // P-425: US butter stick (imported-recipe support) — was riding the pack semantic
};

/**
 * Slices per standard loaf — used when a recipe asks for slices but bread is
 * priced per loaf (documented rough draft constant; only 'slice' appears on
 * loaf-priced items in the v1 registry).
 */
export const SLICES_PER_LOAF = 18;

/**
 * Grams per slice when the pack is WEIGHT-priced (700 g loaf ≈ 20 sandwich
 * slices ≈ 35 g). Day-4 unit semantics (P-104R): deterministic, documented
 * approximations — every constant here is a real SA package/kitchen size,
 * not a fuzzy guess.
 */
export const SLICE_TO_G = 35;

/**
 * Grams per PIECE ("1 tomato") for items priced by weight (per kg). Derived from
 * the empirical Day-1 diagnosis of the 234 null conversions: this table covers
 * every ingredient that appears with a count-unit against a weight-priced pack
 * in the v1 recipe set, plus the two heads (cabbage, lettuce) used in reverse
 * (grams -> heads) for unit-priced produce. Standard SA medium sizes:
 *   tomato 125 g, onion 150 g, carrot 70 g, apple/orange 130 g, naartjie 80 g,
 *   spring onion 15 g, cracker 10 g, jelly sachet 85 g, instant-pudding sachet
 *   100 g, 2-minute noodles pack 80 g, fish finger 20 g (400 g box ≈ 20),
 *   cabbage head 1000 g, lettuce head 400 g.
 * Unknown ids return null — an unknown conversion is never guessed (honesty rule).
 */
/**
 * P-567a — ids where "N units" honestly means "N of the usual purchase form"
 * (tins, tinned fish, mince packs, polony...): a 'unit' line against their
 * g-priced pack bridges as N x pack_qty. The complement of the refuse list:
 * flours, rices, spices, loose produce keep refusing 'unit' lines.
 */
const UNIT_SEMANTICS_PACK = new Set([
  "apricot-jam",
  "babycorn",
  "bacon",
  "baked-beans",
  "baked-beans-with-sausage",
  "bamboo-shoots",
  "black-beans",
  "black-eyed-beans",
  "blue-cheese",
  "boudoir-biscuits",
  "butter-beans",
  "canned-anchovies",
  "canned-clams",
  "canned-crab-meat",
  "canned-mussels",
  "canned-oysters",
  "canned-salmon",
  "canned-sardines-in-oil",
  "canned-shrimp",
  "canned-tuna-in-oil",
  "chakalaka",
  "chakalaka-beans",
  "cheddar-cheese",
  "cheese-curls",
  "chewing-gum",
  "choc-cream-biscuits",
  "choc-kits",
  "coconut-cream",
  "coffee-creamer",
  "condensed-milk",
  "corned-beef",
  "cottage-cheese",
  "cream-cheese",
  "creme-fraiche",
  "dentyne",
  "doritos",
  "eet-sum-mor",
  "fish-roe",
  "flavoured-yoghurt",
  "four-bean-mix",
  "frozen-blueberries",
  "frozen-garlic-bread",
  "frozen-malva-pudding",
  "frozen-mixed-berries",
  "frozen-puff-pastry",
  "frozen-shortcrust-pastry",
  "fruit-chutney",
  "fudge",
  "gnocchi",
  "golden-syrup",
  "green-curry-paste",
  "halva",
  "ham",
  "hazelnut-choc-spread",
  "instant-yeast",
  "jalapenos",
  "jelly",
  "kale",
  "kips",
  "lasagne-sheets",
  "lays-cheese",
  "lays-chips",
  "lays-salt-vinegar",
  "macaroni",
  "macaroons",
  "manhattan-marshmallows",
  "mascarpone-cheese",
  "meringues",
  "mini-cheddars",
  "mixed-bean-salad",
  "mozzarella-cheese",
  "niknaks",
  "niknaks-fruit-chutney",
  "nougat",
  "nuttikrust",
  "nuttikrust-caramel",
  "olives",
  "parmesan-cheese",
  "peanut-butter",
  "pesto-sauce",
  "plant-based-mince",
  "polony",
  "pretzels",
  "processed-cheese-slices",
  "radish",
  "red-curry-paste",
  "rice-cakes",
  "ricotta-cheese",
  "rosemary",
  "royal-creams",
  "seitan",
  "shortbread-biscuits",
  "simba-chips",
  "simba-salt-vinegar",
  "simba-smoked-beef",
  "soup-mix",
  "soup-powder",
  "soya-chunks",
  "soya-mince",
  "spelt-pasta",
  "sweetcorn",
  "sweetie-pies",
  "tahini",
  "tamarind",
  "tameletjies",
  "tinned-lentils",
  "tinned-mackerel-chilli",
  "tinned-mackerel-tomato",
  "tinned-meatballs-tomato",
  "tinned-sardines-chilli",
  "tinned-sardines-tomato",
  "tinned-tuna-tomato",
  "tomato-paste",
  "topper",
  "turkish-delight",
  "waterblommetjie",
  "wheat-crackers",
  "wheatsworth",
  "whole-peeled-tomatoes",
  "wholewheat-noodles",
  "willards-cheese-onion",
  "willards-crinkle-cut",
  "willards-fruit-chutney",
  "willards-tomato",
  "yeast-spread",
]);

export const CUP_WEIGHTS_G = {
  // P-449: cups are DENSITY-dependent - one generic constant would be wrong,
  // so this is per-ingredient. Documented SA kitchen/package approximations
  // (metric cup = 250 ml); unknown ids return null - a cup is never guessed.
  //   liquids 250 ml -> 250 g (oil ~230 g), maize meal 150 g, rice 200 g,
  //   samp 200 g, rolled oats 95 g, white sugar 210 g, icing sugar 120 g,
  //   cake flour 105 g (P-567c), bread flour 127 g, corn flour 120 g
  "maize-meal": 150,
  "white-rice": 200,
  "parboiled-rice": 200,
  samp: 200, // P-567c metric-cup verification
  "rolled-oats": 95,
  "white-sugar": 210,
  "icing-sugar": 120,
  "brown-sugar": 220,
  "cake-flour": 105,
  "bread-flour": 127,
  "self-raising-flour": 125,
  "wholewheat-flour": 125,
  "corn-flour": 120,
  // P-567c additions (label/converter-verified metric cups; maize-rice + samp kitchen-tier)
  "brown-rice": 200,
  "basmati-rice": 190,
  "jasmine-rice": 210,
  "maize-rice": 180,
  couscous: 185,
  "instant-oats": 85,
  "dry-red-lentils": 200,
  "brown-lentils": 210,
  "dried-beans": 200,
  "split-peas": 205,
  quinoa: 180,
  breadcrumbs: 115,
  "desiccated-coconut": 90,
  "cocoa-powder": 90,
  "custard-powder": 160,
  sultanas: 150,
  "popcorn-kernels": 210,
  "sesame-seeds": 150,
  peanuts: 150,
  "fresh-milk": 250,
  "long-life-milk": 250,
  amasi: 250,
  buttermilk: 250,
  "coconut-milk": 240,
  "cooking-oil": 230,
  "sesame-oil": 220,
};

export const PIECE_WEIGHTS_G = {
  onions: 150,
  tomatoes: 125,
  "spring-onions": 15,
  carrots: 80, // P-567c: SA medium carrot ~78 g
  apples: 130,
  oranges: 130,
  naartjies: 80,
  crackers: 10,
  "jelly-powder": 85,
  "instant-pudding": 100,
  "instant-noodles": 80,
  "fish-fingers": 20, // P-567c: SA medium carrot ~78 g; cabbage head 1.3-1.6 kg
  cabbage: 1500,
  lettuce: 400,
  "white-bread": 700,
  "brown-bread": 700, // P-449: "1 loaf" = the priced 700 g loaf
  eggs: 52, // P-509c: standard SA large egg ~50 g
  garlic: 50, // P-567c: SA bulb 40-60 g (was 15 — a clove-scale error)  // P-509c: one garlic BULB ~15 g (registry basis 1 unit); clove lines bridge off this
  // P-509c bunch weights (SA market-standard bunch sizes) — g/handful lines
  // against a 1-bunch price pack bridge through these, same as garlic's cloves.
  spinach: 250,
  coriander: 30,
  parsley: 100,
  mint: 40,
  // ---- P-509b PIECE-WEIGHT SWEEP (Oct 26, owner report: decoded oreo cake
  // undercosted) — the P-516/P-509 merge priced 524 items, but this table
  // still only knew the old 230-era staples, so every piece ("15 Oreos",
  // "4 potatoes") line against a g-pack silently cost null and was excluded.
  // Evidence tiers, highest first:
  //   [owner] stated counts: oreo = 128 g / 14 biscuits (owner, Oct 26).
  //   [pack=1] single-serve bars/slabs: the priced pack IS the piece.
  //   [corpus] whole-produce kitchen standards (same class as onion 150 g).
  //   [std]    biscuit/sweet per-piece norms (Bakers-style packs).
  potatoes: 165,
  "sweet-potatoes": 150,
  bananas: 120,
  lemons: 110, // [corpus]
  peaches: 170,
  pears: 180,
  pineapples: 1200,
  kiwis: 75,
  guavas: 100,
  litchis: 20, // [corpus P-611] fresh-fruit piece classes (spot-verify vs produce scales)
  broccoli: 350, // P-517: the priced Checkers 350 g pack IS one head [pack=1]
  "green-chillies": 5,
  beetroot: 120,
  "whole-chicken": 1500, // [corpus/registry basis]
  "pork-chops": 200,
  "pork-sausages": 75,
  "russian-sausages": 75, // [corpus]
  oreo: 9, // [owner] 128 g / 14
  "marie-biscuits": 8,
  "tennis-biscuits": 9,
  "zoo-biscuits": 15,
  "ginger-nuts": 10, // [std]
  "lemon-creams": 8,
  "savoury-crackers": 8,
  rusks: 28,
  "bokomo-rusks": 28, // [std]
  aero: 40,
  "bar-one": 52,
  chomp: 15,
  flake: 32,
  tex: 40,
  "five-star": 48.5, // [pack=1] bars
  "tv-bar": 47,
  "wonder-bar": 23,
  "top-deck": 36,
  crunchie: 40,
  "black-cat": 48, // [pack=1]
  "cadbury-ps": 19,
  kitkat: 41.5,
  "peppermint-crisp": 49,
  "lunch-bar": 46, // [pack=1]
  "cadbury-dairy-milk": 150, // [pack=1] the priced 150 g slab
  "jelly-babies": 2,
  "jelly-tots": 2,
  "wine-gums": 2,
  "sour-worms": 2, // [std] sweets
  "m-and-ms": 1,
  skittles: 1,
  smarties: 1,
  "sour-balls": 3,
  toffee: 4,
  "wilsons-toffees": 4, // [std]
  // P-567a unit-semantics additions (one piece = grams, model-researched tier)
  "baby-marrow": 70, // P-567a,
  "baking-chocolate": 150, // P-567a,
  "bitter-melon": 120, // P-567a,
  "bottle-gourd": 600, // P-567a low-confidence,
  "breakfast-bar": 40, // P-567a,
  brinjal: 250, // P-567a,
  "brussels-sprouts": 15, // P-567a low-confidence,
  butter: 500, // P-567a,
  cauliflower: 500, // P-567a,
  celeriac: 350, // P-567a low-confidence,
  "cereal-bar": 25, // P-567a,
  chappies: 4, // P-567a,
  dates: 8, // P-567a low-confidence,
  "dried-apricots": 10, // P-567a low-confidence,
  "energy-bar-generic": 40, // P-567a,
  fizzer: 11, // P-567a,
  "frozen-beef-burgers": 100, // P-567a low-confidence,
  "frozen-chicken-nuggets": 25, // P-567a low-confidence,
  "frozen-croissants": 60, // P-567a,
  "frozen-fish-cakes": 75, // P-567a low-confidence,
  "frozen-hash-browns": 60, // P-567a low-confidence,
  "frozen-pancakes": 45, // P-567a,
  "frozen-samosa": 30, // P-567a low-confidence,
  "frozen-spring-rolls": 30, // P-567a low-confidence,
  "frozen-waffles": 65, // P-567a,
  "gem-squash": 180, // P-567a,
  "ghost-pops": 18, // P-567a low-confidence,
  koeksister: 50, // P-567a,
  mushrooms: 200, // P-567a,
  "naan-bread": 90, // P-567a,
  nosh: 40, // P-567a,
  okra: 10, // P-567a low-confidence,
  parsnip: 150, // P-567a,
  "protein-bar": 50, // P-567a,
  snoek: 1200, // P-567a,
  vetkoek: 70, // P-567a
};

/**
 * P-538 — grams per LEVEL tablespoon, per ingredient (tsp = tbsp / 3).
 *
 * WHY: the flat `tbsp: 15` water-density draft constant over-priced every
 * light powder (cocoa hit 4 tbsp = 60 g = R43.20 — real cocoa is ~6 g/tbsp,
 * so 4 tbsp is 24 g ≈ R17). Spoon units are DENSITY-dependent, exactly like
 * the P-449 cups table: one generic constant cannot be right for both
 * turmeric (≈9 g) and dried herbs (≈2.5 g).
 *
 * Rule of authority (mirrors CUP_WEIGHTS_G):
 *   - pack priced per **g** and unit is tbsp/tsp → THIS table (true grams).
 *   - pack priced per **ml** → spoons stay VOLUMES (1 tbsp = 15 ml,
 *     1 tsp = 5 ml) — volume against an ml-priced pack is exact; density
 *     is irrelevant there (4 tbsp oil = 60 ml, priced as 60 ml ✓).
 *   - id not in this table → the flat water-draft constants still apply
 *     (decoder drafts stay priceable, never silently un-priced — P-430).
 *
 * Documented values (USDA FoodData Central / King Arthur weight chart /
 * SA package labels; dip-and-level, unsifted):
 *   spices/ground powders 5-9 g — pepper 6.9, curry 6.4, cinnamon 7.8,
 *   paprika 6.8, chilli 8, turmeric 9, cumin 6.3, garam/biryani 6.3,
 *   braai spice 6.5, salt 17 (fine), dried herbs 2.5, fresh coriander 3
 *   flours 8 g & icing sugar 7.8 g (consistent with the 125 g/cup table),
 *   white sugar 12.5 g (200 g/cup), corn flour 8, custard powder 10,
 *   cocoa 6, drinking chocolate 7, baking powder/soda 13.8, instant
 *   yeast 9, sultanas 10, ginger (grated) 6
 *   syrups/spreads = 15 ml x density — honey & golden syrup 21, jam 20,
 *   peanut butter 16, yeast spread 17, tamarind 16, chutney 16, atchar 15,
 *   salsa 15, tomato paste 16, tomato sauce 16, mayonnaise 14,
 *   butter & margarine 14.2 -> 14 (USDA)
 */
export const TBSP_WEIGHTS_G = {
  // ground spices & seasonings
  "table-salt": 17,
  "black-pepper": 6.9,
  "curry-powder": 6.4,
  "ground-cinnamon": 7.8,
  paprika: 6.8,
  "chilli-powder": 8,
  turmeric: 9,
  "ground-cumin": 7.4,
  "garam-masala": 6.3,
  "biryani-spice": 6.3,
  "braai-spice": 10,
  "mixed-herbs": 3,
  coriander: 5, // P-567c: USDA ground coriander 5 g/tbsp
  // baking powders & flours
  "baking-powder": 13.8,
  "bicarbonate-of-soda": 13.8,
  "instant-yeast": 9,
  "cake-flour": 7.2,
  "bread-flour": 7.2, // P-567c: King Arthur/BakeGrams spooned-flour spoons 'icing-sugar': 7.8, 'corn-flour': 8,
  "custard-powder": 10,
  "cocoa-powder": 5.3,
  "drinking-chocolate": 15,
  // sugars & dried fruit
  "white-sugar": 12.5,
  sultanas: 10,
  // syrups, spreads, sauces (15 ml x density)
  honey: 21,
  "golden-syrup": 21,
  "apricot-jam": 20,
  "peanut-butter": 16,
  "yeast-spread": 15,
  tamarind: 16,
  "fruit-chutney": 15,
  atchar: 15,
  salsa: 15,
  "tomato-paste": 16,
  "tomato-sauce": 15,
  mayonnaise: 14,
  butter: 14,
  margarine: 14,
  // fresh
  ginger: 6,
};

/** P-538: grams for a spoon measure of a KNOWN ingredient (tsp = tbsp/3).
 *  Returns null for unknown ids — callers fall back to the flat draft
 *  constants; a density is never guessed. */

/**
 * P-567e: the CURATED unit dropdown list — every canonical unit the costing
 * engine can actually price (audit Oct 26: 21 live of 28 canon values).
 * Dead canon units (pint/quart/gallon/dsp/oz/lb/dessertspoon) still decode
 * from pasted text and show an honest unpriced line, but they no longer
 * appear in the editor dropdowns. The engine audit test keeps this list
 * exactly in sync with qtyInPackBasis/canonBasis branches.
 */
// P-613: 'packet','tub','bar','tube' were missing while 19 registry rows use them
// as their purchase form, so those items could not be declared in their own unit.
export const PRICED_UNITS = [
  "g",
  "kg",
  "mg",
  "ml",
  "l",
  "tsp",
  "tbsp",
  "cup",
  "clove",
  "slice",
  "sachet",
  "stick",
  "unit",
  "bunch",
  "can",
  "tin",
  "pack",
  "packet",
  "jar",
  "box",
  "bottle",
  "brick",
  "tub",
  "bar",
  "tube",
];

export function spoonGrams(id, unit) {
  if (id == null) return null;
  const t = TBSP_WEIGHTS_G[id];
  if (t === undefined) return null;
  if (unit === "tbsp") return t;
  if (unit === "tsp") return t / 3;
  return null;
}

/** P-545 currency display preference: 'R' (default sticker style) or 'ZAR'.
 *  Same digits either way — only the prefix changes. Never alters the maths. */
const CURRENCY_PREFIX =
  "R"; /* P-546: currency pref removed from Settings — RandPlates is ZAR-native */
export function currencyPrefix() {
  return CURRENCY_PREFIX;
}

/** Format integer cents as a rands string: 17340 → "R173.40", 599 → "R5.99".
 *  Deterministic: no locale-dependent formatting (money rendering must never vary
 *  by environment). SA-style thin-space thousands grouping: R1 250.00. */
export function formatRands(cents) {
  const n = Math.round(cents);
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const rands = String(Math.floor(abs / 100)).replace(
    /\B(?=(\d{3})+(?!\d))/g,
    " ",
  );
  const centsPart = String(abs % 100).padStart(2, "0");
  return `${sign}${CURRENCY_PREFIX}${rands}.${centsPart}`;
}

/** Default price for an ingredient: median across stores (PRD prices.SCHEMA.md).
 *  Returns null when the ingredient isn't priced (must never crash the matcher). */
/**
 * P-509 PACK BANDS — the fix the P-414 finding forced. Per-unit comparisons are
 * only honest between same-normal-form packs: a 500g "win" over a 2kg row is a
 * real win only if 500g is a genuine purchase option in that aisle. Model:
 * per aisle + pack_unit, tercile split of the qty distribution -> small /
 * medium / large. A comparison group is (aisle, unit, band) — wins only count
 * inside it. Rows with an unknown distribution fall in a single comparable band.
 */
export function packBandTable(rows) {
  const dist = {};
  for (const r of rows || []) {
    if (!r || !r.qty) continue;
    const k = r.aisle + "|" + r.unit;
    (dist[k] ||= []).push(r.qty);
  }
  const cut = {};
  for (const k of Object.keys(dist)) {
    const s = [...dist[k]].sort((a, b) => a - b);
    cut[k] = {
      small: s[Math.floor(s.length / 3)],
      large: s[Math.floor((2 * s.length) / 3)],
    };
  }
  return (aisle, unit, qty) => {
    const c = cut[aisle + "|" + unit];
    if (!c) return "medium";
    return qty <= c.small ? "small" : qty <= c.large ? "medium" : "large";
  };
}

export function defaultPrice(ingredientId, priceEntries) {
  const forItem = priceEntries.filter((e) => e.ingredient_id === ingredientId);
  if (!forItem.length) return null;
  const sorted = [...forItem].sort((a, b) => a.price_cents - b.price_cents);
  const mid = Math.floor(sorted.length / 2);
  // lower of the two middles for even counts → conservative (budget-first) median
  const entry = sorted.length % 2 ? sorted[mid] : sorted[mid - 1];
  // P-538: carry the honesty fields through — 'source' (verified/estimate, the
  // P-519 tier split) and 'brand' (the till slip shows the exact product).
  // Stripping them here made every downstream surface show a naked number.
  return {
    price_cents: entry.price_cents,
    pack_qty: entry.pack_qty,
    pack_unit: entry.pack_unit,
    store: entry.store,
    brand: entry.brand ?? null,
    source: entry.source ?? "estimated",
    last_verified: entry.last_verified,
  };
}

/** Convert a recipe quantity into the ingredient's priced-pack basis.
 *  Returns the equivalent quantity in pack-basis units (fractional), or null when
 *  the conversion is impossible (unpriced / incompatible units).
 *
 *  opts.id      — ingredient id, enables the PIECE_WEIGHTS_G table (P-104R).
 *  opts.packQty — the priced pack size, enables the tin/can rule:
 *                 "1 tin of baked beans" against a 410 g tin-priced pack means
 *                 exactly one priced pack — the price literally IS a tin, so this
 *                 is price semantics, not a guess.
 */
export function qtyInPackBasis(qty, unit, packUnit, opts = {}) {
  const { id = null, packQty = 0 } = opts;
  if (unit === packUnit) return qty;
  // volume/mass conversions for pantry pack bases
  if (packUnit === "g" || packUnit === "ml") {
    if (unit === "g" && packUnit === "ml") return qty; // P-509c: 500 g of milk ~ 500 ml — same 1 g ~ 1 ml draft as below
    // P-567c: dry-goods cup lines bridge via the verified per-ingredient
    // densities; unmapped dry ids REFUSE (never the 125 g flour draft).
    if (unit === "cup" && packUnit === "g") {
      const cg = id !== null ? CUP_WEIGHTS_G[id] : undefined;
      return cg !== undefined ? qty * cg : null;
    }
    if (unit === "cup" && packUnit === "ml") return qty * 250; // liquids: the volume draft is exact
    if (unit === "ml") return qty; // 1 ml ≈ 1 g rough draft
    if (unit === "l" || unit === "kg") return qty * 1000;
    if ((unit === "tin" || unit === "can") && packQty > 0) return qty * packQty; // 1 tin/can = 1 priced pack
    if (unit === "slice") return qty * SLICE_TO_G;
    if (unit === "mg") return qty / 1000;
    // P-449: the decoder's everyday units - each was returning null (R0!)
    if (unit === "cup") {
      const cw = id !== null ? CUP_WEIGHTS_G[id] : undefined;
      return cw !== undefined ? qty * cw : null; // density-dependent, per ingredient
    }
    if (unit === "pack" && packQty > 0) return qty * packQty; // 1 packet = 1 priced pack
    if (unit === "sachet") {
      const sw = id !== null ? PIECE_WEIGHTS_G[id] : undefined;
      if (sw !== undefined) return qty * sw;
      return packQty > 0 ? qty * packQty : null;
    }
    if ((unit === "box" || unit === "bottle") && packQty > 0)
      return qty * packQty; // stick moved to UNIT_TO_GRAMS (P-425)
    // P-567b T4: the registry's canonical purchase forms — one jar/tub/bar/
    // tube/packet = one priced pack, same semantics as box/bottle.
    if (
      (unit === "jar" ||
        unit === "tub" ||
        unit === "bar" ||
        unit === "tube" ||
        unit === "packet") &&
      packQty > 0
    )
      return qty * packQty;
    if (unit === "unit") {
      const w = id !== null ? PIECE_WEIGHTS_G[id] : undefined;
      if (w !== undefined) return qty * w;
      // P-567a: "2 unit" of tinned tomatoes = 2 tins = 2 packs — the decoded
      // 'unit' line that used to silently vanish from the recipe cost.
      if (id !== null && UNIT_SEMANTICS_PACK.has(id) && packQty > 0)
        return qty * packQty;
      return null;
    }
    // P-538: spoons against a WEIGHT-priced pack need the ingredient's real
    // density (1 tbsp cocoa ≈ 6 g, not 15 g of water). Unknown id → the
    // documented water-draft fallback below (P-430: never un-price).
    const sg =
      packUnit === "g" && (unit === "tbsp" || unit === "tsp")
        ? spoonGrams(id, unit)
        : null;
    if (sg !== null) return qty * sg;
    const g = UNIT_TO_GRAMS[unit];
    if (g !== undefined) return qty * g;
    return null;
  }
  // (the ml-pack branch above keeps spoons as VOLUMES — 15 ml/tbsp — which is
  //  exact against a per-ml price; no density needed there)
  // pack is unit basis: counts, or grams of a known piece (head of cabbage)
  if (packUnit === "unit") {
    if (unit === "unit") return qty;
    // P-567d #4: the count-word fall-through was a denylist — 'mg', 'cup',
    // 'oz', 'litre' all counted as units (500 mg = 500 packs). ALLOWLIST of
    // real count nouns only; anything else honestly nulls.
    const COUNT_NOUNS = new Set([
      "egg",
      "eggs",
      "sprig",
      "sprigs",
      "stalk",
      "stalks",
      "head",
      "heads",
      "piece",
      "pieces",
      "fillet",
      "fillets",
      "rasher",
      "rashers",
      "fruit",
      "unit",
      "bunch",
      "bunches",
    ]); // P-517: bunch = 1 unit (morogo vs unit-priced row)
    if (unit && COUNT_NOUNS.has(unit)) return qty;
    if (unit === "pack" && packQty > 0) return qty * packQty; // P-449
    if ((unit === "can" || unit === "tin") && packQty > 0) return qty * packQty; // P-517: 1 can = 1 priced pack (vienna 5-pack is the purchase form)
    if (unit === "slice") return qty / SLICES_PER_LOAF; // buy a whole loaf
    // P-509c: clove lines vs a piece-priced pack (garlic: 124 corpus lines
    // were silently null). Cloves -> grams -> bulbs via the piece weight.
    if (unit === "clove" && id !== null && PIECE_WEIGHTS_G[id] !== undefined) {
      return (qty * UNIT_TO_GRAMS.clove) / PIECE_WEIGHTS_G[id];
    }
    if (unit === "g" && id !== null && PIECE_WEIGHTS_G[id] !== undefined) {
      return qty / PIECE_WEIGHTS_G[id];
    }
    return null;
  }
  if (packUnit === "can" && (unit === "can" || unit === "tin")) return qty;
  if (packUnit === "bunch" && unit === "bunch") return qty;
  // P-509c: mass/handful lines against a 1-bunch price pack (100 g spinach,
  // a handful of coriander): grams -> bunches via the bunch weight above.
  if (
    packUnit === "bunch" &&
    id !== null &&
    PIECE_WEIGHTS_G[id] !== undefined
  ) {
    if (unit === "g" || unit === "kg")
      return unit === "kg"
        ? (qty * 1000) / PIECE_WEIGHTS_G[id]
        : qty / PIECE_WEIGHTS_G[id];
    if (unit === "handful")
      return (qty * UNIT_TO_GRAMS.handful) / PIECE_WEIGHTS_G[id];
  }
  return null;
}

/** Back-conversion (P-204): grams → the pantry item's own unit.
 *  The inverse of qtyInPackBasis for the families that engine supports, using the
 *  SAME constants (PIECE_WEIGHTS_G, UNIT_TO_GRAMS, SLICE_TO_G, pack_qty). Cooking
 *  deducts in a common gram basis, then stores the remainder back in the unit the
 *  pantry row already shows — so "1 onion" (150 g) leaves 850 g of a 1000 g bag,
 *  instead of the old raw subtraction leaving 999 g. Unknown family → null
 *  (never guessed); the caller falls back to storing grams. */
export function qtyFromGrams(grams, unit, opts = {}) {
  const { id = null, packQty = 0 } = opts;
  if (unit === "g" || unit === "ml") return grams; // 1 ml ≈ 1 g rough draft
  if (unit === "kg" || unit === "l") return grams / 1000;
  if (unit === "slice") return grams / SLICE_TO_G;
  if (unit === "tin" || unit === "can")
    return packQty > 0 ? grams / packQty : null;
  if (unit === "unit") {
    const w = id !== null ? PIECE_WEIGHTS_G[id] : undefined;
    return w !== undefined && w > 0 ? grams / w : null;
  }
  // P-538: reverse direction uses the SAME per-ingredient spoon densities
  // (60 g of cocoa is 10 tbsp, not 4) — pack-basis consistency.
  const sg = unit === "tbsp" || unit === "tsp" ? spoonGrams(id, unit) : null;
  if (sg !== null) return grams / sg;
  const g = UNIT_TO_GRAMS[unit];
  return g !== undefined && g > 0 ? grams / g : null;
}

/** Cost in CENTS of a recipe ingredient line, given its price entry (default or store).
 *  Proportional pack math: R32.99 per 2.5 kg → 400 g costs 5278.4 → 5278 (rounded).
 *  Returns null when unpriceable. */
/**
 * P-442 bridge: canonical basis from the decoder's dual fields. ADDITIVE-ONLY
 * by design — the legacy path is tried FIRST and canon fills only the gaps it
 * cannot price. That honours the P-430 hard rule (existing recipes must not
 * change one cent: a working conversion like stick=113.4 g is never overridden
 * by its canon sibling) while un-pricing nothing that was priced before.
 * 'ml' canon keeps the density authority: CUP_WEIGHTS_G per 250 ml (1 SA cup),
 * else the engine's existing 1 ml ≈ 1 g draft rule.
 */

/** P-567d #6: float noise at pack boundaries — 0.07 kg x 1000 lands at
 *  70.00000000000001 and ceils one pack too many. Snap to 1e-6 first. */
const round6 = (x) => Math.round(x * 1e6) / 1e6;

export function canonBasis(line, priceEntry) {
  if (!line || line.qty_canon == null || !priceEntry) return null;
  const qc = line.qty_canon;
  // P-567d #3 (dimension bleed): a canon g/ml quantity is only meaningful
  // against a g/ml pack — returning grams against a unit/bunch/can pack
  // billed 30 packs of basil. Everything else must honestly null.
  if (line.unit_canon === "g")
    return ["g", "ml"].includes(priceEntry.pack_unit) ? qc : null;
  if (line.unit_canon === "ml") {
    if (!["g", "ml"].includes(priceEntry.pack_unit)) return null;
    // P-538: canon ml that came from a SPOON ("4 tbsp cocoa" → 60 ml canon)
    // is a water-density volume. Against a weight-priced pack, scale it by
    // the ingredient's true spoon density (60 ml x 6/15 = 24 g ✓). Cups keep
    // their own P-449 line below. Direct-ml lines (a true "250 ml milk")
    // fall through unchanged — the original unit tells them apart.
    if (line.unit === "tbsp" || line.unit === "tsp") {
      const t = line.id != null ? TBSP_WEIGHTS_G[line.id] : undefined;
      if (t !== undefined && priceEntry.pack_unit === "g") return (qc * t) / 15;
    }
    const cw = line.id != null ? CUP_WEIGHTS_G[line.id] : undefined;
    return cw !== undefined ? (cw * qc) / 250 : qc;
  }
  if (line.unit_canon === "pack")
    return priceEntry.pack_qty > 0 ? qc * priceEntry.pack_qty : null;
  return null; // 'unit' canon carries qty_canon null by contract
}

export function ingredientCostCents(line, priceEntry) {
  // P-567d #5: NaN/zero guards — a non-finite qty or row poisons a whole plan
  // via ceil(x/0) = Infinity or formatRands(NaN). qty exactly 0 is a real
  // zero-cost line, never unpriced.
  if (
    !priceEntry ||
    !Number.isFinite(priceEntry.pack_qty) ||
    priceEntry.pack_qty <= 0 ||
    !Number.isFinite(priceEntry.price_cents) ||
    priceEntry.price_cents < 0
  )
    return null;
  if (line.qty === 0) return 0;
  if (!Number.isFinite(line.qty) || line.qty < 0) return null;
  const basis =
    qtyInPackBasis(line.qty, line.unit, priceEntry.pack_unit, {
      id: line.id,
      packQty: priceEntry.pack_qty,
    }) ?? canonBasis(line, priceEntry); // P-442 additive bridge
  if (basis === null || !Number.isFinite(basis) || basis <= 0) return null;
  // P-567d d1 RULING (owner model preserved, Oct 26): the recipe-card sticker
  // stays MARGINAL — proportional below one pack (the owner's P-538 founding
  // bug report: "4 tbsp cocoa ≈ 21 g, not R43.20"; whole-pack billing would
  // recreate that bug at pack scale, R59.99 for one spoon). The BUDGET
  // VERDICT does NOT live here: the planner's weekly verdict already comes
  // from the consolidated whole-pack shopping sheet (P-113b #12/#13,
  // planner.js line 229), so the SHIP-BLOCKER surface is honest. Two
  // authorities, two clearly-labelled surfaces: sticker = marginal cost of
  // the ingredients you use; till slip + week verdict = whole-pack reality.
  if (round6(basis) <= priceEntry.pack_qty) {
    // P-567d #6: snap before the boundary
    return Math.round((priceEntry.price_cents * basis) / priceEntry.pack_qty);
  }
  // need more than one pack → pay whole packs (you can't buy 0.4 of a pack at the till)
  const packs = Math.ceil(round6(basis) / priceEntry.pack_qty); // P-567d #6
  return packs * priceEntry.price_cents;
}

/**
 * Top-up cost: what you'd actually pay at the till for a missing line —
 * WHOLE PACKS, always (P-113b red-team #12/#13): ceil(needed / pack) × pack
 * price. The old proportional version could greenlight a meal whose real shop
 * busts the budget (600 g of rice from 500 g packs is 2 packs, not 1.2 × R20)
 * and disagreed with the planner's whole-pack shopping list. Now the same
 * authority as ingredientCostCents and the planner's till slip.
 */
export function topUpCostCents(line, priceEntry, ownedBasis = 0) {
  if (!priceEntry) return null;
  if (!Number.isFinite(priceEntry.pack_qty) || priceEntry.pack_qty <= 0)
    return null;
  const basis =
    qtyInPackBasis(line.qty, line.unit, priceEntry.pack_unit, {
      id: line.id,
      packQty: priceEntry.pack_qty,
    }) ?? canonBasis(line, priceEntry); // P-442 additive bridge
  if (basis === null || !Number.isFinite(basis) || basis <= 0) return null;
  // P-113b red-team #13: charge only the GAP. 600 g needed with 400 g in the
  // pantry means buying ONE 500 g pack, not pricing the whole 600 g line.
  // ownedBasis = what the pantry already holds in pack-basis units (0 by
  // default; callers without pantry context keep the full-line behaviour).
  const gap = Math.max(0, basis - (ownedBasis || 0));
  if (gap <= 0) return 0;
  if (round6(gap) <= priceEntry.pack_qty) return priceEntry.price_cents; // P-567d #6: snap the boundary
  return Math.ceil(round6(gap) / priceEntry.pack_qty) * priceEntry.price_cents; // whole packs only (P-567d #6 snap)
}

/**
 * P-571 USAGE COST — the evaluation model for per-plate surfaces (card chip,
 * detail stepper, decoder chip). Fully proportional: price x (basis / pack),
 * NEVER ceiled — the P-567d #6 above-one-pack ceil ("you can't buy 0.4 of a
 * pack at the till") belongs to the SHOPPING surfaces only (Still-to-buy,
 * till slip, hero buy-everything). Owner ruling Oct 27: scaling 6 -> 7 plates
 * on 1 tin of condensed milk must cost 1.17 tins' worth (R38.83), not a
 * snapped 2-tin jump (R65.98) — the whole tin is not used in that cook.
 */
export function usageCostCents(line, priceEntry) {
  if (
    !priceEntry ||
    !Number.isFinite(priceEntry.pack_qty) ||
    priceEntry.pack_qty <= 0 ||
    !Number.isFinite(priceEntry.price_cents) ||
    priceEntry.price_cents < 0
  )
    return null;
  if (line.qty === 0) return 0;
  if (!Number.isFinite(line.qty) || line.qty < 0) return null;
  const basis =
    qtyInPackBasis(line.qty, line.unit, priceEntry.pack_unit, {
      id: line.id,
      packQty: priceEntry.pack_qty,
    }) ?? canonBasis(line, priceEntry);
  if (basis === null || !Number.isFinite(basis) || basis <= 0) return null;
  return Math.round((priceEntry.price_cents * basis) / priceEntry.pack_qty);
}

/** Total recipe cost in cents at its baseline servings, plus per-ingredient breakdown.
 *  Lines: [{ line, priceEntry, costCents|null }]. */

/**
 * P-567d #2 — THE LINE-AWARE PICKER. defaultPrice sorts raw cents across mixed
 * pack forms, so butter's 250 g web row beat the owner-verified 500 g row on a
 * 500 g need, and an unconvertible '1 unit' row could null a line that had a
 * convertible twin. Rules (budget-first):
 *   1. keep only rows that can convert to THIS line's basis;
 *   2. within one (store, pack_qty, pack_unit) format, a verified row replaces
 *      an estimated one regardless of price (tier outranks price, same format);
 *   3. per store, the minimum whole-pack line cost across that store's
 *      formats (what a shopper at that store actually pays);
 *   4. across stores, the UPPER middle (true median for odd n, higher of the
 *      two for even n) — never the cheaper-middle understatement;
 *   5. tie-break on tier, then input order never changes the output.
 */
/**
 * P-571 — THE USAGE PICKER. Ranking the usage cost by the TOP-UP pick lets a
 * pack-band switch move the evaluation price UP (yoghurt bowl +40c at plate 6).
 * Usage rows are rays from the origin (price x basis/pack_qty), so the
 * per-store minimum is the single cheapest-per-gram ray — constant at every
 * quantity, which makes per-plate EXACTLY invariant under serving scaling.
 * Same format/tier/median-store discipline as bestLineCostCents.
 */
export function bestUsageRow(line, rows) {
  if (!rows || !rows.length) return null;
  const convertible = rows.filter(
    (r) =>
      r &&
      Number.isFinite(r.pack_qty) &&
      r.pack_qty > 0 &&
      Number.isFinite(r.price_cents) &&
      r.price_cents >= 0 &&
      usageCostCents(line, r) !== null,
  );
  if (!convertible.length) return null;
  const byFmt = {};
  for (const r of convertible) {
    const k = (r.store || "") + "|" + r.pack_qty + "|" + r.pack_unit;
    const prev = byFmt[k];
    if (!prev || (prev.source !== "verified" && r.source === "verified"))
      byFmt[k] = r;
  }
  const perStore = {};
  for (const r of Object.values(byFmt)) {
    const c = usageCostCents(line, r);
    if (c === null) continue;
    const st = r.store || "";
    if (perStore[st] === undefined || c < perStore[st].cost)
      perStore[st] = { cost: c, row: r };
  }
  const picks = Object.values(perStore).sort((a, b) => a.cost - b.cost);
  if (!picks.length) return null;
  return picks[Math.floor(picks.length / 2)];
}

export function bestLineCostCents(line, rows) {
  if (!rows || !rows.length) return null;
  const convertible = rows.filter(
    (r) =>
      r &&
      Number.isFinite(r.pack_qty) &&
      r.pack_qty > 0 &&
      Number.isFinite(r.price_cents) &&
      r.price_cents >= 0 &&
      (qtyInPackBasis(line.qty, line.unit, r.pack_unit, {
        id: line.id,
        packQty: r.pack_qty,
      }) !== null ||
        canonBasis(line, r) !== null),
  );
  if (!convertible.length) return null;
  const byFmt = {};
  for (const r of convertible) {
    const k = (r.store || "") + "|" + r.pack_qty + "|" + r.pack_unit;
    const prev = byFmt[k];
    if (!prev || (prev.source !== "verified" && r.source === "verified"))
      byFmt[k] = r;
  }
  const perStore = {};
  for (const r of Object.values(byFmt)) {
    const c = topUpCostCents(line, r, 0);
    if (c === null) continue;
    const st = r.store || "";
    if (perStore[st] === undefined || c < perStore[st].cost)
      perStore[st] = { cost: c, row: r };
  }
  const picks = Object.values(perStore).sort((a, b) => a.cost - b.cost);
  if (!picks.length) return null;
  return picks[Math.floor(picks.length / 2)];
}

export function costRecipe(recipe, priceOf, rowsOf = null) {
  const lines = [];
  let total = 0;
  let usage = 0; // P-571: proportional usage total — the per-plate evaluation basis
  let unpriced = 0;
  for (const line of recipe.ingredients) {
    const rows = rowsOf ? rowsOf(line.id) : null;
    // P-567d #2: with the full row pool available, the line-aware picker
    // replaces the single pre-picked row (mixed-format cents sort lies).
    // P-571: ONE pick per line — the top-up model ranks the row, and BOTH
    // costs (till top-up + proportional usage) derive from that same row,
    // so the chip, the stepper and the shopping sheet can never disagree
    // about which price row a line is quoted on.
    const pick = rows && rows.length ? bestLineCostCents(line, rows) : null;
    const priceEntry = pick ? pick.row : priceOf(line.id);
    const cost = pick ? pick.cost : ingredientCostCents(line, priceOf(line.id));
    // P-571: the usage cost carries its OWN row pick (cheapest-per-gram ray),
    // so evaluation surfaces are exactly invariant under serving scaling.
    const uPick = rows && rows.length ? bestUsageRow(line, rows) : null;
    const uc = uPick
      ? usageCostCents(line, uPick.row)
      : usageCostCents(line, priceEntry);
    lines.push({ line, priceEntry, costCents: cost, usageCents: uc });
    if (cost === null) unpriced++;
    else total += cost;
    if (uc !== null) usage += uc;
  }
  return { totalCents: total, totalUsageCents: usage, lines, unpriced };
}

/** Per-plate cost in cents: total / servings, rounded to the nearest cent. */
export function perPlateCents(totalCents, servings) {
  const s = servings > 0 ? servings : 1;
  return Math.ceil(totalCents / s); // P-567d #7: ceil — per-plate x servings >= total, budget-first;
}

/** Rescale a recipe to a new serving count: quantities AND derived re-cost.
 *  Scaling is linear on quantities (the documented rough-draft rule). */
export function rescaleRecipe(recipe, newServings) {
  const factor = newServings / (recipe.servings > 0 ? recipe.servings : 1);
  return {
    ...recipe,
    servings: newServings,
    ingredients: recipe.ingredients.map((ing) => ({
      ...ing,
      qty: ing.qty * factor,
    })), // P-567d #7: exact — no 2dp drift, non-idempotent rescale fixed
  };
}
