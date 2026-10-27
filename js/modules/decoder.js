// decoder.js — paste-text → structured recipe (PRD §7.7).
// Regex + heuristic parser. RUNTIME IS DETERMINISTIC — no API calls in the live engine;
// AI is used at build/authoring time only. Low-confidence output goes to a review queue
// (the Pitch26 audit workflow applied to recipes).
// PURE FUNCTIONS: no DOM, no fetch, no IndexedDB.
//
// P-419 RED-TEAM HARDENING (fixture: tests/fixtures/red-team-decoder-tests.txt):
//   Layer 1  pre-processing (zero-width/NBSP, unicode fractions, emoji/hashtag/URL/markdown/TikTok meta)
//   Layer 2  quantity engine (fractions, spelled numbers, ranges, compact units, SA units, packaging parens, vague-quantity guard)
//   Layer 3  classifier (cooking verbs → steps, subjective cues/meta/equipment/CTA → review or ignored)
//   Layer 4  conservative review queue with REASONS (over-queue, never hallucinate)
//   Layer 5  multi-recipe detection (parse first, flag the rest)

import { normalize } from "./search.js";

// ---------------------------------------------------------------------------
// Layer 1 — preprocessing tables
// ---------------------------------------------------------------------------
// zero-width + BOM characters and non-breaking spaces (F01)
const ZERO_WIDTH_RE = /[\u200b-\u200d\ufeff]/g;
const NBSP_RE = /[\u00a0\t]/g; // P-461 iter 23: tabs normalize to spaces too (copy-paste tables)
// unicode fraction glyphs → ASCII fractions; a leading digit gets a space ("1⅓" → "1 1/3")
const UNICODE_FRACS = {
  "½": "1/2",
  "¼": "1/4",
  "¾": "3/4",
  "⅓": "1/3",
  "⅔": "2/3",
  "⅛": "1/8",
  "⅜": "3/8",
  "⅝": "5/8",
  "⅞": "7/8",
  "⅕": "1/5",
  "⅖": "2/5",
  "⅗": "3/5",
  "⅘": "4/5",
  "⅙": "1/6",
  "⅚": "5/6",
};
const FRAC_GLYPH_RE = /[½¼¾⅓⅔⅛⅜⅝⅞⅕⅖⅗⅘⅙⅚]/;
// TikTok/social meta prefixes (B04, H6-H9)
const TIKTOK_META_RE =
  /^(?:dc\s*:|ib\s*:|pov\s*:|storytime\s*:|anyway\b.*here'?s|link in bio|recipe in (?:the\s+)?comments|follow for|like\s*\+\s*save|part\s+\d+|full recipe on my|dm me|like and save)/i;
// pure CTA tails that can appear mid-text too
const CTA_RE =
  /\b(follow for more|link in bio|dm me for|recipe in (?:the\s+)?comments|save for later)\b/i;
const HASHTAG_RE = /#[a-z][\w-]*/gi; // P-461 iter 29: a hashtag starts with a LETTER — '#500g macaroni' is a list marker glued to a qty, not a hashtag
const URL_RE = /https?:\/\/\S+/gi;
// emoji + variation selectors (B01); broad Unicode emoji planes, safe on text
const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu;
// markdown bullets, checkboxes, blockquotes, headings (C06) + caption artifacts (B06)
const MD_BULLET_RE = /^(?:#{1,6}\s*)?(?:[-*+•>●◆▪‣⁃]+|\[\s*[xX]?\s*\]|>>)\s*/;
// "*adds sugar*" style stage directions — action, not instruction or ingredient (B06)
const STAGE_DIR_RE = /^\*[^*]+\*$|^\[[^\]]*\]$/; // *adds sugar* AND [Music]
// "Ingredients:" / "### Instructions" headers
const ING_HEADER_RE =
  /^(?:ingredients?|you will need|what you need(?:\s+is)?)\s*[:\s-]*$/i;
const ING_HEADER_PREFIX_RE = /^(?:ingredients?|ing|what you need)\s*[:：]\s*/i;

// ---------------------------------------------------------------------------
// Layer 2 — quantity engine
// ---------------------------------------------------------------------------
// canonical units; misspellings/synonyms normalize to these (koppie = Afrikaans cup, E02)
export const UNIT_CANON = {
  g: "g",
  gram: "g",
  grams: "g",
  gramme: "g",
  grammes: "g",
  kg: "kg",
  kilo: "kg",
  kilos: "kg",
  kilogram: "kg",
  kilograms: "kg",
  mg: "mg",
  ml: "ml",
  millilitre: "ml",
  millilitres: "ml",
  milliliter: "ml",
  milliliters: "ml",
  l: "l",
  litre: "l",
  litres: "l",
  liter: "l",
  liters: "l",
  tsp: "tsp",
  teaspoon: "tsp",
  teaspoons: "tsp",
  teelepel: "tsp",
  teelepels: "tsp",
  tbsp: "tbsp",
  tablespoon: "tbsp",
  tablespoons: "tbsp",
  eetlepel: "tbsp",
  eetlepels: "tbsp",
  cup: "cup",
  cups: "cup",
  koppie: "cup",
  koppies: "cup",
  // P-442: imperial + dessertspoon are canon tokens in their own right — the
  // display keeps them AS ENTERED, the conversion table canonicalises them.
  packets: "pack",
  jars: "jar",
  jar: "jar",
  tablespoonfuls: "tbsp",
  tablespoonful: "tbsp",
  teaspoonfuls: "tsp",
  teaspoonful: "tsp", // P-461 iter 25: determinable, not vague                      // P-442b: plural pack forms
  // P-458 CANON-V3-UNITS: US/UK volumes, dessertspoon abbrev, misspellings, Afrikaans slice
  pint: "pint",
  pints: "pint",
  quart: "quart",
  quarts: "quart",
  gallon: "gallon",
  gallons: "gallon",
  dsp: "dsp",
  dsps: "dsp",
  tspn: "tsp",
  tblsp: "tbsp",
  tbls: "tbsp",
  snye: "slice",
  oz: "oz",
  ozs: "oz",
  ounce: "oz",
  ounces: "oz",
  lb: "lb",
  lbs: "lb",
  pound: "lb",
  pounds: "lb",
  dessertspoon: "dessertspoon",
  dessertspoons: "dessertspoon",
  dessertlepel: "dessertspoon",
  dessertlepels: "dessertspoon",
  clove: "clove",
  cloves: "clove",
  glove: "clove",
  knoffel: "clove",
  can: "can",
  cans: "can",
  tin: "tin",
  tins: "tin",
  slice: "slice",
  slices: "slice",
  sachet: "sachet",
  stick: "stick",
  sticks: "stick",
  box: "box",
  bottle: "bottle",
  packet: "pack",
  pack: "pack",
  punnet: "pack",
  brick: "brick",
  bricks: "brick", // P-425: SA butter brick = 500g
  loaf: "unit",
  loaves: "unit",
  head: "unit",
  heads: "unit", // P-425: whole-item purchases
  bunch: "bunch",
  bunches: "bunch",
  sprig: "bunch",
  sprigs: "bunch",
  unit: "unit",
  piece: "unit",
  pieces: "unit",
  breast: "unit",
  breasts: "unit",
  egg: "unit",
  eggs: "unit",
  eier: "unit",
  eiers: "unit",
};
// ---------------- P-442: unit conversion + preservation contract (P-430) ---------
// Canonical units: 'g' | 'ml' | 'pack' | 'unit'. factor is exact; rounding
// happens ONLY in canonicaliseUnit (round-half-up, nearest g/ml).
// DOCTRINE: the user's unit is NEVER rewritten on display — qty/unit are what
// they typed (SA decimal commas and ranges resolved to a number); qty_canon/
// unit_canon feed costing only and are never shown as "their" measurement.
export const UNIT_CONVERSIONS = Object.freeze({
  // SA VOLUME — standard SA cup is 250 ml (NOT the US 237/240 ml), SA spoon
  // sets graduate 5 ml / 10 ml / 15 ml.
  cup: { unit_canon: "ml", factor: 250 },
  koppie: { unit_canon: "ml", factor: 250 },
  tbsp: { unit_canon: "ml", factor: 15 },
  eetlepel: { unit_canon: "ml", factor: 15 },
  tsp: { unit_canon: "ml", factor: 5 },
  teelepel: { unit_canon: "ml", factor: 5 },
  dessertspoon: { unit_canon: "ml", factor: 10 },
  // P-458 CANON-V3-UNITS: exact US customary volumes (rounded once at canon)
  "fl oz": { unit_canon: "ml", factor: 29.5735295625 },
  pint: { unit_canon: "ml", factor: 473.176473 },
  quart: { unit_canon: "ml", factor: 946.352946 },
  gallon: { unit_canon: "ml", factor: 3785.411784 },
  dsp: { unit_canon: "ml", factor: 10 },
  ml: { unit_canon: "ml", factor: 1 },
  l: { unit_canon: "ml", factor: 1000 },
  litre: { unit_canon: "ml", factor: 1000 },
  liter: { unit_canon: "ml", factor: 1000 },
  // MASS — exact avoirdupois; SA tables round to 28.35 g / 453.592 g, we store
  // exact and round once at canonicalisation.
  oz: { unit_canon: "g", factor: 28.349523125 },
  ounce: { unit_canon: "g", factor: 28.349523125 },
  lb: { unit_canon: "g", factor: 453.59237 },
  pound: { unit_canon: "g", factor: 453.59237 },
  g: { unit_canon: "g", factor: 1 },
  gram: { unit_canon: "g", factor: 1 },
  kg: { unit_canon: "g", factor: 1000 },
  // BUTTER — US stick = 113 g (½ cup = 8 tbsp); display keeps "1 stick".
  // appliesTo is honored: a stick of anything else converts to nothing.
  stick: { unit_canon: "g", factor: 113, appliesTo: /\b(?:butter|botter)\b/i },
  // PACK — no mass/volume without a parenthetical; qty_canon = number of packs
  // and costing uses the registry pack price (the null-safe whole-pack math).
  can: { unit_canon: "pack", factor: null },
  tin: { unit_canon: "pack", factor: null },
  jar: { unit_canon: "pack", factor: null },
  packet: { unit_canon: "pack", factor: null },
  sachet: { unit_canon: "pack", factor: null },
  box: { unit_canon: "pack", factor: null },
  bottle: { unit_canon: "pack", factor: null },
  jar: { unit_canon: "pack", factor: null },
  pack: { unit_canon: "pack", factor: null },
  // COUNT — no mass without a piece-weight or parenthetical.
  each: { unit_canon: "unit", factor: null },
  piece: { unit_canon: "unit", factor: null },
  slice: { unit_canon: "unit", factor: null },
  clove: { unit_canon: "unit", factor: null },
  bunch: { unit_canon: "unit", factor: null },
  handful: { unit_canon: "unit", factor: null },
  pinch: { unit_canon: "unit", factor: null },
});

const roundHalfUp = (x) => Math.floor(x + 0.5);
// liquids never take a mass parenthetical on a volume unit (P-430 Rule 4)
const LIQUID_RE =
  /\b(milk|water|oil|juice|cream|stock|syrup|wine|beer|amasi|buttermilk|cola|melk|water|olie|sap|room|sous|wyn|bier)\b/i; // EN + AF liquids

/**
 * P-442 canonicaliser. Pure. Precedence (P-430 §3):
 *  R1  parenthetical of the SAME dimension overrides the table (the author's
 *      own number beats the standard);
 *  R2  pack unit + mass/volume parenthetical -> the parenthetical is the canon;
 *  R3  no parenthetical -> the table (pack -> pack count; unit -> count, null);
 *  R4  volume unit + mass parenthetical -> used only for dry solids; liquids
 *      and anything unverifiable yield null (the decoder refuses to lie).
 * A volume parenthetical on a MASS unit has no dimension authority -> null.
 */
export function canonicaliseUnit(qty, unitRaw, opts = {}) {
  // P-461 iter 35 (T078): the display unit is AS ENTERED ("tablespoon",
  // "koppie") — the conversion lookup must normalise through UNIT_CANON
  // first or the canon pair silently comes back null and costing breaks.
  const canonKey = UNIT_CANON[(unitRaw || "").toLowerCase()] || unitRaw;
  const u = (canonKey || "unit")
    .toLowerCase()
    .replace(/s$/, (m, off, s) =>
      off > 0 && UNIT_CONVERSIONS[s.slice(0, off)] ? "" : m,
    ); // crude singular fold for lookup
  const conv = UNIT_CONVERSIONS[u];
  if (
    conv &&
    conv.appliesTo &&
    !(opts.raw || opts.name || "").match(conv.appliesTo)
  ) {
    return { qty_canon: null, unit_canon: null }; // "1 stick margarine" — not butter
  }
  // parenthetical measurement, e.g. "(400g)", "(2kg)", "(250ml)"
  let pQty = null,
    pDim = null;
  // P-461 iter 26: imperial parentheticals override too — "1 can (15 oz)"
  // costs by its 425 g of content, not as a mystery pack.
  const pm = String(opts.note || "").match(
    /([\d.,]+)\s*(kg|g|ml|l|litre|liter|oz|ounce|ounces|lb|lbs|pound|pounds)\b/i,
  );
  if (pm) {
    if (/^(?:oz|ounce|ounces)$/i.test(pm[2])) {
      const g = parseFloat(pm[1].replace(",", ".")) * 28.349523125;
      if (Number.isFinite(g))
        return { qty_canon: Math.round(g), unit_canon: "g" };
    }
    if (/^(?:lb|lbs|pound|pounds)$/i.test(pm[2])) {
      const g = parseFloat(pm[1].replace(",", ".")) * 453.59237;
      if (Number.isFinite(g))
        return { qty_canon: Math.round(g), unit_canon: "g" };
    }
  }
  if (pm) {
    pQty = parseFloat(pm[1].replace(",", "."));
    const pu = pm[2].toLowerCase();
    if (pu === "kg") {
      pQty *= 1000;
      pDim = "g";
    } else if (pu === "g") pDim = "g";
    else if (pu === "l" || pu === "litre" || pu === "liter") {
      pQty *= 1000;
      pDim = "ml";
    } else pDim = "ml";
  }
  const qtyOk = Number.isFinite(pQty) && pQty > 0;
  // R2: pack unit + parenthetical -> parenthetical IS the canon
  if (conv && conv.unit_canon === "pack" && qtyOk) {
    return { qty_canon: roundHalfUp(pQty), unit_canon: pDim };
  }
  // R1: same-dimension parenthetical overrides the table
  if (
    conv &&
    (conv.unit_canon === "ml" || conv.unit_canon === "g") &&
    qtyOk &&
    pDim === conv.unit_canon
  ) {
    return { qty_canon: roundHalfUp(pQty), unit_canon: pDim };
  }
  // R4: volume unit + mass parenthetical — dry solids only, never liquids
  if (conv && conv.unit_canon === "ml" && qtyOk && pDim === "g") {
    if (LIQUID_RE.test(opts.raw || opts.name || ""))
      return { qty_canon: null, unit_canon: null };
    return { qty_canon: roundHalfUp(pQty), unit_canon: "g" };
  }
  // volume parenthetical on a mass unit — no authority to fabricate density
  if (conv && conv.unit_canon === "g" && qtyOk && pDim === "ml") {
    return { qty_canon: null, unit_canon: null };
  }
  // R3: the table
  if (conv) {
    if (conv.unit_canon === "pack")
      return { qty_canon: qty, unit_canon: "pack" };
    if (conv.unit_canon === "unit")
      return { qty_canon: null, unit_canon: "unit" };
    return {
      qty_canon: roundHalfUp(qty * conv.factor),
      unit_canon: conv.unit_canon,
    };
  }
  // unknown unit word ("block", "punnet", …) — never guess
  return { qty_canon: null, unit_canon: null };
}

// VAGUE quantities never auto-save (A05, E02 knippie, H) — review with a reason
const VAGUE_UNIT_RE =
  /^(?:a\s+|an\s+)?(?:(?:good|generous|small|large|big|tiny|little|heaping)\s+)?(?:pinch|pinches|handful|handfuls|splash|splashes|knob|knobs|drizzle|dash|dashes|knippie|scoop|scoops|glug|glugs|slosh|sloshes|slug|heap|heaps|nk|sprinkle|dollop|spoonful|spoonfuls|scant|generous amount|little bit of|mespunt|mespunte|smidge|smidges|smidgen|smidgens|drop|drops|couple of|generous pour|tiny bit of|a touch of|touch of|capful|capfuls)\b/i;
const VAGUE_UNIT_WORD_RE =
  /\b(?:pinch(?:es)?|handfuls?|splash(?:es)?|knobs?|dashes?|knippie(?:s)?|drizzle|sprinkle|dollop(?:s)?|spoonful(?:s)?|smidges?|smidgens?|scoops?|drops?|heaps?|capfuls?)\b/i; // P-458 iter 8 anywhere; smidgen/capful added P-461 iter 25
const VAGUE_LINE_RE =
  /\b(?:to taste|generously|liberally|sparingly|some\b|as needed|as required|as much as|as much [a-z ]{1,20} as|to perfection|eyeball it|didn'?t measure|just eyeball|to your liking|a little|little bit|a bit|generous (?:amount|splash|handful)|with love|add love|secret ingredient)\b/i;
// spelled numbers (A02)
const NUM_WORDS = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  dozen: 12,
  half: 0.5,
  couple: 2,
};
// time/duration words — qty followed by these is a TIME, never an ingredient (D01, G04)
const TIME_UNIT_RE =
  /^(?:min|mins|minute|minutes|sec|secs|second|seconds|hour|hours|hr|hrs|h)\b/i;
// leading quantity: "1 1/2", "1/2", "1.5", "1,5", "3-4", "3 to 4", "one", "half a", "a dozen"
// alternatives (ORDER MATTERS): pure fraction | number(+fraction) | range | x-to-y | spelled word
// P-442: ranges are tried BEFORE the bare number (else "2-3" parses as qty 2
// and the tail becomes garbage); range quantities resolve to the MIDPOINT.
const QTY_LEAD_RE =
  /^(?:(\d+)\/(\d+)|(\d+(?:[.,]\d+)?)[-–](\d+(?:[.,]\d+)?)|(\d+(?:[.,]\d+)?)\s+to\s+(\d+(?:[.,]\d+)?)|(\d+(?:[.,]\d+)?)(?:\s+(\d+)\/(\d+))?|([a-z]+))\s*/i;
// mid-line qty for verb-first lines + reverse order (C02, D01, B02, D05)
const QTY_MID_RE =
  /(\d+(?:[.,]\d+)?(?:\s+\d+\/\d+)?)\s*([a-zA-Z]+)\s*((?:[a-z][\w'-]*\s*){0,3})/;
const QTY_TAIL_RE =
  /^(.*?)\s*(?:[-–~±]?\s*)?(\d+(?:[.,]\d+)?(?:\s+\d+\/\d+)?)\s*(g|kg|mg|ml|l|tsp|tbsp|tablespoons?|teaspoons?|cups?|koppies?|koppie|tins?|cans?)\b/i;
// anaphora markers: instructions referencing earlier state, never ingredients (D01)
const ANAPHORA_RE =
  /\b(?:the remaining|remaining|the rest|rest of|the batter|the dough|the mixture|later|again|more of|the other)\b/i;
// meta info lines (D04, H18, J04, E04)
const META_RE =
  /^(?:time\s*:|prep(?:aration)?\s+time\s*:?|cook(?:ing)?\s+time\s*:?|w\/m\s*:|calories|kcal|macros?\s*:|cost\s*:|costs about|~\d+\s*calories|nutri)/i; // NOTE: no "serves" — the serves parser owns it
const PRICE_TALK_RE =
  /\b(?:pick n pay|woolies|woolworths|checkers|shoprite|spar|pnp)\b.*\b(?:r\d+|2 for 1|special)|\b\d+\s*for\s*r\d|\bbuy\s+\d+\s+get\s+\d+|\bsave\s+r\d|\br\d+(?:\.\d{1,2})?\s*(?:only|each|per\s*pack)\b|^r\d+(?:\.\d{1,2})?\b|\btoday\s+only\b|\bspecial\s*[:\d]|\bspecial\s+at\b/i;
// equipment nouns — never ingredients (D03)
const EQUIP_RE =
  /\b(?:bowl|whisk|pan\b|pans\b|pot\b|knife|fork|spatula|airfryer|air fryer|oven|parchment|baking sheet|tray|blender|mixer|plate|platter|wooden spoon|spoon\b|ladle|tongs|colander|sieve|grater|peeler|measuring cup|rolling pin|slow cooker|slow-cooker|crockpot|rice cooker|pressure cooker|bread machine|food processor|baking dish|casserole dish|ceramic dish|glass dish|roasting dish|pie dish|dish\b)\b/i;
// optional/garnish/service prefixes — keep OUT of auto-save (H14-16)
const OPT_PREFIX_RE =
  /^(?:optional|for garnish|garnish|to serve|for serving|topping|for topping)\b/i;
// subjective doneness cues — review even inside steps (D02)
const SUBJECTIVE_RE =
  /\b(?:until (?:golden|fragrant|done|doubled|just combined|your kitchen|it smells|smells amazing)|to perfection|just eyeball|until ancestors)\b/i;
// instruction verbs — a line LEADING with one of these is a step (P-404), or a
// subjective review line if it also matches SUBJECTIVE_RE (D02)
const VERB_STEP_RE =
  /^(?:preheat|sear|rub|coat|brown|toss|brush|glaze|combine|scoop|drop|baste|fry|add|chop|cook|mix|boil|simmer|season|stir|whisk|pour|knead|marinate|serve|garnish|braise|roast|steam|bake|grill|heat|sprinkle|drizzle|transfer|reduce|beat|fold|take|now|then|rest|combine|microwave|airfry|frost|dust|line|roll|shape|place|spread|top with|cover|remove|strain|blend|melt|toast|saute|sauté|brush|glaze|pinch off|whip|cream)\b/i;
// multi-recipe markers (C03, I)
const MULTI_NUM_RE = /(?:^|\n)\s*\d{1,2}\)\s/;
const RECIPE_HEADER_RE =
  /^(.{0,40}?)\s*(?:recipe|frosting|steps|instructions|marinade|dough|sauce|glaze|icing|batter)\s*[:：]/i;

const METHODS_RE =
  /^(?:method|instructions?|steps?|how to|preparation|directions)\b/i;
const SERVES_RE =
  /(?:servings?\s*(?:size)?|serves?|feeds?|makes?)\s*:?\s*(\d+)(?:\s*[-–]\s*\d+)?/i;
const SERVES_RANGE_RE =
  /(?:servings?|serves?|makes?)\s*:?\s*(\d+)\s*[-–]\s*(\d+)(?!\s*(?:min|hour|hr))/i; // "Serves 4 – 30 min" is servings+TIME, not a range
const TIME_RE = /(\d+)\s*(?:-|to\s+)?(\d+)?\s*min/i;

function evalFraction(str) {
  const [a, b] = String(str).split("/").map(Number);
  return b ? a / b : a;
}
// apply the leading-quantity grammar; returns {qty, unitWord, rest} | null
function parseQtyLead(line) {
  if (/^a\s+dozen\b/i.test(line))
    return { qty: 12, rest: line.replace(/^a\s+dozen\s*/i, "") };
  const m = QTY_LEAD_RE.exec(line);
  if (!m) return null;
  let qty = null,
    rest = line.slice(m[0].length);
  // P-438: a spelled quantity eats a following article — "half a brick",
  // "half 'n brick" (SA idiom) must keep the unit word intact
  if (m[10] !== undefined && /^(?:a|an|'n)\s+/i.test(rest))
    rest = rest.replace(/^(?:a|an|'n)\s+/i, ""); // P-438 (group renumbered by P-442)
  if (m[1] !== undefined) {
    // pure fraction "1/2"
    qty = Number(m[1]) / Number(m[2]);
  } else if (m[3] !== undefined) {
    // range "2-3" → midpoint (P-442)
    qty =
      (parseFloat(m[3].replace(",", ".")) +
        parseFloat(m[4].replace(",", "."))) /
      2;
  } else if (m[5] !== undefined) {
    // range "2 to 3" → midpoint (P-442)
    qty =
      (parseFloat(m[5].replace(",", ".")) +
        parseFloat(m[6].replace(",", "."))) /
      2;
  } else if (m[7] !== undefined) {
    // number, possibly with fraction "1 1/2"
    qty = parseFloat(m[7].replace(",", "."));
    if (m[8] !== undefined) qty += Number(m[8]) / Number(m[9]);
  } else if (m[10] !== undefined) {
    // spelled word "one", "half", "two"
    qty = NUM_WORDS[m[10].toLowerCase()] ?? null;
  }
  if (qty === null || Number.isNaN(qty)) return null;
  return { qty, rest };
}

// food-words that double as units ("2 eggs", "2 breasts", "1 eier") — when the
// name part is empty, the unit IS the food (B01, C02)
const FOOD_UNIT_RE =
  /^(?:eggs?|eier|eiers?|breasts?|fillets?|bananas?|tomatoes?|onions?|potatoes?|carrots?|lemons?|cloves?)$/i;

// P-442: the DISPLAY unit is the user's own word, singular-folded — "koppie"
// stays "koppie", "eetlepels" shows as "eetlepel"; recipes still canonicalise
// via UNIT_CANON at draftToRecipe time.
const displayUnit = (lower) => {
  if (UNIT_CANON[lower])
    return lower.endsWith("s") && UNIT_CANON[lower.replace(/s$/, "")]
      ? lower.replace(/s$/, "")
      : lower;
  return UNIT_CANON[lower.replace(/s$/, "")] ? lower.replace(/s$/, "") : lower;
};

/** full ingredient-line attempt: qty (lead) + unit + name; returns entry or null */
function parseIngredientLine(line, resolve) {
  const lead = parseQtyLead(line);
  if (!lead) return null;
  let { qty, rest } = lead;
  rest = rest.trim();
  // unit word (incl. compact "200g" handled by the qty regex boundary below)
  let unit = "unit";
  const um = rest.match(/^([a-zA-Z]+)(?:\s+|(?=[\d(]))?/);
  let unitRaw = um ? um[1] : "";
  // P-458 CANON-V3-UNITS: two-token US volume ("4 fl oz milk", "4 fl. oz. milk")
  const flm = rest.match(/^fl\.?\s+oz\.?\s*(?=[a-zA-Z])/i);
  if (flm) {
    unit = "fl oz";
    rest = rest.slice(flm[0].length).trim();
  } else {
    const lower = unitRaw.toLowerCase();
    const canon = UNIT_CANON[lower];
    if (canon) {
      // P-461 iter 32 (W300): a FOOD word that is ALSO a count-unit ("2 eggs,
      // beaten") keeps its food meaning when only a comma-descriptor follows —
      // the count-unit path would strand "beaten" as the name and lose the eggs.
      const restAfter = rest.slice(unitRaw.length).trim();
      const onlyModifiers = restAfter
        .replace(/^[,\s]+/, "")
        .split(/\s+/)
        .every((w) => !w || MODIFIER_WORD_RE.test(w));
      if (
        FOOD_UNIT_RE.test(unitRaw) &&
        (restAfter === "" || restAfter.startsWith(",") || onlyModifiers)
      ) {
        rest = unitRaw;
        unit = canon ? displayUnit(lower) : "unit"; // P6: count-unit display stays as entered
      } else {
        unit = displayUnit(lower);
        rest = restAfter;
      } // P-442: unit AS ENTERED
    } else if (resolve) {
      // @rule: GLUE-SPLIT-V3 (P-461 iter 28): the qty regex eats "500" and leaves
      // "gOATS"/"LMILK"/"TBSPHONEY" as a non-unit word. Split the glued unit off
      // unitRaw ONLY when the name part resolves — resolve-gated so a false
      // split ("1 loaf", "2 lemons" -> L+"oaf/emons") can never fabricate.
      const gm =
        /^(TBSP|TBL|TSP|CUPS?|TINS?|CANS?|KG|G|ML|LB|L|OZ|PACKS?|JARS?|SLICES?|BUNCHES?|SPRIGS?)(.+)$/i.exec(
          unitRaw,
        );
      if (gm) {
        const name = gm[2].replace(/\s+/g, " ").trim();
        if (name && resolve(name)) {
          unit = displayUnit(gm[1].toLowerCase());
          rest = name;
        }
      }
    }
  }
  // @rule: PAREN-NOISE (P-461 loop iter 23): decorative multi-bracket runs
  // ("(((peeled and chopped)))") collapse to a single pair BEFORE extraction,
  // so the note captures "peeled and chopped" and the name keeps "potatoes".
  rest = rest
    .replace(/\(+/g, "(")
    .replace(/\)+/g, ")")
    .replace(/\[+/g, "[")
    .replace(/\]+/g, "]")
    .trim();
  // packaging parenthetical: keep as note, never part of the name (A06, E01)
  const paren = rest.match(/\(([^)]+)\)/);
  let note = null;
  rest = rest
    .replace(/\(([^)]+)\)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  // secondary qty after "=" or "+": "1 stick butter = 113g" (A04) — note only
  const eq = rest.match(/\s*[=+]\s*\d+\s*[a-zA-Z]*\s*$/);
  if (eq) {
    rest = rest.slice(0, eq.index).trim();
  }
  rest = rest
    .replace(/^(?:of\s+|a\s+|an\s+|the\s+)/i, "")
    .replace(/[.,;]+$/, "")
    .trim();
  // P-461 iter 35 (T082): prose-run glue tails — "two cups of maize meal to"
  // / "four cups of boiling water with" keep the ingredient; the trailing
  // connector burns off.
  rest = rest.replace(/\s+(?:to|with|and|for|until|then)$/i, "").trim();
  rest = rest.split(/\s*;\s*/)[0].trim(); // "1 cup; DROP TABLE recipes; -- flour" (J02)
  if (!rest) {
    if (FOOD_UNIT_RE.test(unitRaw)) {
      rest = unitRaw;
      unit = "unit";
    } // "2 eggs"
    else return null;
  }
  // @rule: TIN-BIAS (P-461 loop iter 19): a tin/can/jar line means the TINNED
  // family — "1 tin chopped tomatoes" is whole-peeled-tomatoes territory, not
  // fresh tomatoes. Try the tinned-qualified name first; the fresh hit only
  // wins when no tinned sibling earns.
  let resolved = null;
  if (resolve) {
    // P-461 iter 26 FUZZ_REFUSE, amended iter 27 (STAPLES-V3): black beans and
    // kidney beans now have REAL registry items, so they resolve; red beans and
    // white beans still fuzz into different products (speckled/butter) and stay
    // refused until verified products exist. Refusal over guess.
    const FUZZ_REFUSE_RE =
      /^(?:red beans|white beans|apple cider(?!\s+vinegar)|chocolate (?:sauce|syrup)|maple syrup)\b/i;
    resolved = FUZZ_REFUSE_RE.test(rest.trim()) ? null : resolve(rest);
    // only re-route when the first hit is NOT already an exact name/alias match
    // for what the user wrote ("tomato sauce" exact -> tomato-sauce must stay).
    const exactHit =
      resolved &&
      (String(resolved.name || "").toLowerCase() ===
        String(rest).toLowerCase() ||
        (resolved.aliases || []).some(
          (a) => String(a).toLowerCase() === String(rest).toLowerCase(),
        ));
    if (resolved && !exactHit && /^(?:tins?|cans?)\b/i.test(unit || "")) {
      const tinned =
        resolve(
          "tin " +
            String(rest).replace(
              /^(?:chopped|diced|peeled|grated|crushed|whole)\s+/i,
              "",
            ),
        ) ||
        resolve(
          "tinned " +
            String(rest).replace(
              /^(?:chopped|diced|peeled|grated|crushed|whole)\s+/i,
              "",
            ),
        );
      if (tinned && tinned.id !== resolved.id) resolved = tinned;
    }
  }
  const keptNote = note || (paren ? paren[1] : null);
  // P-442: dual-field — as-entered qty/unit for display, canon pair for costing
  const { qty_canon, unit_canon } = canonicaliseUnit(qty, unit, {
    note: keptNote,
    raw: line,
    name: rest,
  });
  return {
    raw: line,
    qty,
    unit,
    qty_canon,
    unit_canon,
    note: keptNote,
    resolvedId: resolved?.id ?? null,
    resolvedName: resolved?.name ?? null,
  };
}

/** mid-line extraction from an instruction verb line (C02, D01, J01):
 *  captures qty+unit+name ONLY when it is a direct, anaphora-free ingredient
 *  mention with a real unit (never "3 mins"). */
function extractInlineIngredient(line, resolve) {
  if (ANAPHORA_RE.test(line)) return null;
  const m = QTY_MID_RE.exec(line);
  if (!m) return null;
  const unitCanon = UNIT_CANON[m[2].toLowerCase()];
  if (!unitCanon) return null;
  if (TIME_UNIT_RE.test(m[2])) return null;
  let name = (m[3] || "")
    .replace(
      /\b(and|then|plus|with|until|to|into|onto|over|across|-|–|,).*$/i,
      "",
    )
    .replace(/[.,;]+$/, "")
    .trim();
  if ((!name || name.length < 2) && FOOD_UNIT_RE.test(m[2])) name = m[2]; // "2 eggs and beat them"
  // strip parenthetical + slash alternatives from the name
  name = name
    .replace(/\([^)]*\)/g, "")
    .replace(/\s*\/\s*.*$/, "")
    .trim();
  if (!name || name.length < 2) return null;
  const resolved = resolve ? resolve(name) : null;
  const dispUnit = displayUnit(m[2].toLowerCase()); // P-442: AS ENTERED
  const qty = parseFloat(m[1].replace(",", ".")) || evalFraction(m[1]);
  const { qty_canon, unit_canon } = canonicaliseUnit(qty, dispUnit, {
    raw: line,
    name,
  }); // P-442
  return {
    raw: line,
    qty,
    unit: dispUnit,
    qty_canon,
    unit_canon,
    note: null,
    resolvedId: resolved?.id ?? null,
    resolvedName: resolved?.name ?? null,
  };
}

/** reverse order: name first, qty at the tail (B02 "flour ... 2 cups", D05, J04). */
function parseReverseLine(line, resolve) {
  const m = QTY_TAIL_RE.exec(line);
  if (!m) return null;
  let name = m[1]
    .replace(/\([^)]*\)/g, "")
    .replace(/\s*\/.*$/, "")
    .replace(/[-–]\s*$/, "")
    .replace(/^(?:of\s+)/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!name || name.length < 2 || EQUIP_RE.test(name)) return null;
  const unit = displayUnit(
    UNIT_CANON[m[3].toLowerCase()] ? m[3].toLowerCase() : m[3].toLowerCase(),
  ); // P-442: AS ENTERED
  const resolved = resolve ? resolve(name) : null;
  const qtyRaw = m[2].includes("/") ? m[2].trim() : m[2].replace(",", ".");
  const qty = qtyRaw.includes("/")
    ? evalFraction(qtyRaw.replace(/\s+/g, ""))
    : parseFloat(qtyRaw);
  if (!isFinite(qty)) return null;
  const { qty_canon, unit_canon } = canonicaliseUnit(qty, unit, {
    raw: line,
    name,
  }); // P-442
  return {
    raw: line,
    qty,
    unit,
    qty_canon,
    unit_canon,
    note: null,
    resolvedId: resolved?.id ?? null,
    resolvedName: resolved?.name ?? null,
  };
}

// ---------------------------------------------------------------------------
// main parser
// ---------------------------------------------------------------------------
// ---------------- P-437: step-quality pipeline (DeepSeek P-424 findings) ----------------
const COOKING_VERB_STR =
  "cook fry bake grill braise boil simmer steam roast saute saut\u00e9 stir mix whisk beat fold knead chop dice slice mince grate peel cut add pour heat melt brown sear deglaze drain rinse soak marinate season taste blend pulse crush squeeze measure combine toss arrange layer stuff wrap score prick transfer remove preheat rest cool chill freeze roll press shape";
const COOKING_VERB_SET = new Set(COOKING_VERB_STR.split(" "));
const SERVE_STRIP_RE =
  /^(?:serve|enjoy|dish\s+up|plate\s+up|garnish|top|finish|sprinkle|accompany|best\s+served|goes\s+well|pair|eat|have|side)(?:\s+(?:with|and))?\s*/i;
const SERVE_META_RE =
  /\b(?:serve|enjoy|garnish)\s+with\s+([a-z'\u00C0-\u024F][^.,;]*)/i;
const LEAD_FILLER_RE =
  /^(?:okay|ok|so|now|then|next|alright|right|and\s+then|and|after\s+that|afterwards)[\s,]+/i;
const PROMO_TAIL_RE =
  /\s*(?:follow(?:\s+(?:me|us|for\s+more))?.*|like\s+(?:and|&)\s+subscribe.*|subscribe.*|part\s+\d+\s+coming.*|full\s+recipe\s+(?:on|in)\s+.*|link\s+in\sbio.*|check\s+(?:out\s+)?(?:my|the)\s+(?:page|bio|link).*|dm\s+(?:me|for).*|comment\s+.*\s+for\s+.*)$/i;
const GAS_MARK_C = {
  1: 140,
  2: 150,
  3: 170,
  4: 180,
  5: 190,
  6: 200,
  7: 220,
  8: 230,
  9: 240,
};
const ACRONYM_MAP = {
  bbq: "BBQ",
  sa: "SA",
  rsa: "RSA",
  msg: "MSG",
  tvp: "TVP",
};
const MARKETING_SET = new Set(
  "you your you'll you're won't can't believe amazing incredible delicious tasty best viral trending must-try drool obsessed literally guys fam".split(
    " ",
  ),
);

const round5 = (n) => Math.round(n / 5) * 5;
function stepTokens(s) {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\b\d+(?:[.,]\d+)?\b/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .filter(Boolean),
  );
}
const jaccard = (X, Y) => {
  let i = 0;
  for (const t of X) if (Y.has(t)) i++;
  return i / (X.size + Y.size - i);
};
const strictSubset = (X, Y) => X.size < Y.size && [...X].every((t) => Y.has(t));

/** Whole-word ingredient test (P-437): "season" must NOT count as an object
 *  because "Aromat Seasoning" merely CONTAINS it. Word boundaries required. */
function isWholeWordIngredient(word, resolve) {
  const hit = resolve(word);
  if (!hit) return false;
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("\\b" + esc + "\\b", "i");
  return re.test(hit.name) || (hit.aliases || []).some((a) => re.test(a));
}

/** P-437 ruling on the findings' rule 3: a serve-lead line only LEAVES the steps
 *  when every object piece resolves (or the whole remainder resolves). A line
 *  like "Top with onion and atchar, close sandwich." keeps its cooking action —
 *  the findings' letter would have deleted "close sandwich", violating their
 *  own never-lose-cooking-information law. */
function serveWithObject(line, resolve) {
  const m = SERVE_STRIP_RE.exec(line);
  if (!m) return null;
  const rest = line.slice(m[0].length);
  const after = line.slice(m[0].length).toLowerCase();
  // veto: a cooking verb after the lead means real action remains
  for (const t of after.split(/[^a-z]+/))
    if (COOKING_VERB_SET.has(t)) return null;
  const pieces = rest
    .split(/\s*(?:,|&|\band\b)\s*/i)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!pieces.length) return null;
  const resolved = [];
  for (const p of pieces) {
    const hit = resolve(p);
    if (!hit) return null; // unresolved piece -> keep the line as a step
    resolved.push({ resolvedId: hit.id, resolvedName: hit.name });
  }
  return resolved;
}

/** Canonical oven temperature from one step (P-424 ss1, priority order). */
function extractOvenTempC(step) {
  let m;
  if (
    (m =
      /\b(\d{2,3})\s*[-\u2013]\s*(\d{2,3})\s*(?:\u00B0|\u00BA|deg(?:rees)?\.?\s*)?C(?:elsius)?\b/i.exec(
        step,
      )) &&
    +m[1] >= 50 &&
    +m[2] <= 300
  )
    return round5((+m[1] + +m[2]) / 2);
  if (
    (m =
      /\b(\d{2,3})\s*(?:\u00B0|\u00BA|deg(?:rees)?\.?\s*)?C(?:elsius)?\b/i.exec(
        step,
      )) &&
    +m[1] >= 50 &&
    +m[1] <= 300
  ) {
    const fan = /\bfan/i.test(step);
    return round5(fan ? +m[1] - 20 : +m[1]);
  }
  if (
    (m = /\bfan(?:\s*(?:assisted|oven))?\s*(?:at\s*)?(\d{2,3})\b/i.exec(
      step,
    )) &&
    +m[1] >= 50 &&
    +m[1] <= 300
  )
    return round5(+m[1] - 20);
  if ((m = /\bgas\s*(?:mark\s*)?(\d{1,2})\b/i.exec(step)) && GAS_MARK_C[+m[1]])
    return GAS_MARK_C[+m[1]];
  if (
    (m =
      /\b(\d{3})\s*(?:\u00B0|\u00BA|deg(?:rees)?\.?\s*)?F(?:ahrenheit)?\b/i.exec(
        step,
      )) &&
    +m[1] >= 200 &&
    +m[1] <= 600
  )
    return round5(((+m[1] - 32) * 5) / 9);
  if (
    (m = /\b(\d{2,3})\s*(?:\u00B0|\u00BA|deg(?:rees)?)\b/i.exec(step)) &&
    +m[1] >= 100 &&
    +m[1] <= 260
  )
    return round5(+m[1]);
  return null;
}

const MODIFIER_WORD_RE =
  /^(?:sliced?|diced?|chopped|chopped finely|finally|finely|fried|boiled|boiling|grilled|baked|fresh|frozen|large|small|medium|thick|thin|cut|peeled|grated|minced|washed|raw|cooked|hollowed|out|slices|halved|quartered|toasted|warm|cold|deboned|skinless|mashed|melted|softened|beaten|crushed|shredded|drained|crumbled|zested)$/i;
// P-461: ENGLISH quality/brand qualifiers that may be dropped from the FRONT of
// an ingredient name under the normal (non-strict) earned() rules. Any other
// dropped word is treated as possibly-vernacular and goes strict (exact alias
// only) per the owner's refuse-over-guess ruling.
const ENGLISH_QUALIFIER_RE =
  /^(?:all|purpose|all-purpose|allpurpose|organic|plain|whole|full|cream|extra|virgin|light|dark|white|brown|black|red|green|yellow|self|raising|self-raising|cake|bread|strong|fine|coarse|ripe|fresh|frozen|boiling|warm|hot|cold|large|small|medium|free|range|free-range|premium|grade|quality|best|sharp|mature|mild|instant|dry|dried|unsalted|salted|sweet|low|fat|low-fat|reduced)$/i;
const STOP_WORD_RE =
  /^(?:was|is|the|a|an|and|or|of|to|in|on|with|for|some|my|your)$/i;
/** P-429 strength floor + token cascade for auto-resolution.
 * THE GATE: a hit must EARN auto-save — exact name/alias (any length),
 * substring of name/alias at >=5 chars, or fuzzy-ASR trust at >=8 chars.
 * Kills false positives ("pop" -> popcorn). Cascade: if the full name fails,
 * try leading prefixes (prep-note tails: "onion diced"), then suffixes
 * ("braaiboordjie wors" -> "wors"). Conservative: no hit, no save. */
function makeStrongResolver(resolve) {
  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9 ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  // @rule: STRENGTH-FLOOR-V3 (P-458 loop iter 3): earned matches must be
  // word-boundary-contained (kills "water" -> "Watermelon" in-word substrings)
  // and ASR trust needs real similarity (Dice bigrams >= 0.45 — keeps
  // chakalala -> chakalaka, kills "ta mavele" -> Maltabella).
  const bigrams = (s) => {
    const r = [];
    for (let i = 0; i < s.length - 1; i++) r.push(s.slice(i, i + 2));
    return r;
  };
  const dice = (a, b) => {
    const A = bigrams(a),
      B = bigrams(b);
    if (!A.length || !B.length) return 0;
    let hits = 0;
    for (const g of A) {
      const j = B.indexOf(g);
      if (j >= 0) {
        B.splice(j, 1);
        hits++;
      }
    }
    return (2 * hits) / (A.length + bigrams(b).length);
  };
  const wbHit = (hay, needle) => {
    if (!hay.includes(needle)) return false;
    const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp("(?:^| )" + esc + "(?: |$)").test(hay);
  };
  const earned = (sub, hit, strict = false) => {
    if (!hit) return null;
    const n = norm(sub);
    const hn = norm(hit.name);
    if (n === hn) return hit;
    if ((hit.aliases || []).some((a) => norm(a) === n)) return hit;
    if (strict) return null; // @rule: VERN-GUARD-V3 (P-461 iter 15, owner ruling refuse-over-guess): word-dropped sub-queries earn ONLY exact name/alias — "kgomo" tail-matching alias "sebete sa kgomo" must refuse, never guess ox-liver
    if (
      n.length >= 8 &&
      (dice(n, hn) >= 0.45 ||
        (hit.aliases || []).some((a) => dice(n, norm(a)) >= 0.45))
    )
      return hit; // fuzzy-ASR trust (chakalala -> chakalaka)
    if (
      n.length >= 5 &&
      (wbHit(hn, n) || (hit.aliases || []).some((a) => wbHit(norm(a), n)))
    )
      return hit;
    return null;
  };
  // P-461 iter 31: product-distinct word pairs refuse-over-guess — "dried
  // thyme" is NOT Fresh Thyme, "vanilla extract" is NOT vanilla essence, and
  // "fresh lentils" is NOT the dry pack. The clash is judged on the FULL
  // effective query (dropped qualifiers included), never on the residue.
  const clashOK = (query, hit) => {
    if (!hit) return false;
    const q = String(query).toLowerCase();
    const hay = (hit.name + " " + (hit.aliases || []).join(" ")).toLowerCase();
    if (/\b(?:dried|dry)\b/.test(q) && /(^|\s)fresh\s/.test(hay)) return false;
    if (/\bfresh\b/.test(q) && /(^|\s)(?:dry|dried)\s/.test(hay)) return false;
    if (/extract/.test(q) && /essence/.test(hay)) return false;
    return true;
  };
  return (name) => {
    if (!name) return null;
    // P-461 iter 32: a comma is PREPARATION by doctrine — resolve the head
    // first ("spinach, chopped" -> spinach exact) so a fuzzy full-string hit
    // ("spinach, chopped" -> Frozen Chopped Spinach) can never outrank it.
    const ci0 = name.indexOf(",");
    if (ci0 > 0) {
      const head0 = name.slice(0, ci0).trim();
      if (head0) {
        const h0 = earned(head0, resolve(head0));
        if (h0 && clashOK(head0, h0)) return h0;
      }
    }
    const hit = resolve(name);
    const good = earned(name, hit);
    if (good && clashOK(name, good)) return good;
    // P-461 iter 34 (S505): caps-glued pastes deleted the SPACE, not the
    // letters ("BEEFMINCE"). Try single-space re-insertions on letter-only
    // queries; resolve-gated so nothing is ever fabricated.
    if (!name.includes(" ") && name.length >= 6 && /^[a-zA-Z]+$/.test(name)) {
      const q = name.toLowerCase();
      for (let i = 3; i < q.length - 2; i++) {
        const h = resolve(q.slice(0, i) + " " + q.slice(i));
        if (h) {
          const e = earned(name, h);
          if (e && clashOK(name, e)) return e;
        }
      }
    }
    // P-461 iter 32: a compound "X and Y" names TWO products — refuse the
    // whole line to review instead of resolving either half ("frozen peas and
    // carrots" must never become Carrots). Only when BOTH halves independently
    // resolve to DIFFERENT items is the compound a genuine multi-product.
    const am = name.match(/^(.{2,40}?)\s+and\s+(.{2,40})$/i);
    if (am && !/^(?:salt|pepper|spice)s? and /i.test(name)) {
      const h1 = earned(am[1], resolve(am[1]), true);
      const h2 = earned(am[2], resolve(am[2]), true);
      if (h1 && h2 && h1.id !== h2.id) return null;
    }
    // comma-cut head gets the SAME qualifier-drop rights as a top-level name
    // ("3 ripe bananas, mashed" -> head "ripe bananas" -> drop "ripe" -> bananas)
    const dropCascade = (nm) => {
      const ws = nm.split(/\s+/);
      for (let s = 1; s < ws.length; s++) {
        if (STOP_WORD_RE.test(ws[0])) break;
        const sub = ws.slice(s).join(" ");
        const dr = ws.slice(0, s);
        const h = earned(
          sub,
          resolve(sub),
          !dr.every((w) => ENGLISH_QUALIFIER_RE.test(w)),
        );
        if (h && clashOK(dr.join(" ") + " " + sub, h)) return h;
      }
      return null;
    };
    // @rule: COMMA-CUT-V3 (P-458 loop iter 7): a trailing comma descriptor is
    // preparation, never part of the ingredient name ("2 potatoes, cubed" ->
    // "potatoes"; "1/2 cup butter, melted" -> "butter"; "bananas, mashed" ->
    // bananas, NOT instant-mash). Resolve the comma-head before word-drops.
    const ci = name.indexOf(",");
    if (ci > 0) {
      const head = name.slice(0, ci).trim();
      if (head) {
        const h = earned(head, resolve(head));
        if (h && clashOK(head, h)) return h;
        // P-461 iter 31b: qualifier-drops inside a comma-head are for SHORT
        // heads ("ripe bananas") only — long prose heads ("Sauté onions in
        // oil. Add mutton") must never deep-drop into a stray word.
        const dh = head.split(/\s+/).length <= 3 ? dropCascade(head) : null;
        if (dh) return dh;
      }
    }
    const words = name.split(/\s+/);
    // prefix-drop: only recognized prep-modifier tails ("onion diced",
    // "vienna sausages fried") — never drop arbitrary words ("braai was")
    for (let end = words.length - 1; end >= 1; end--) {
      if (!words.slice(end).every((w) => MODIFIER_WORD_RE.test(w))) break;
      const sub = words.slice(0, end).join(" ");
      const h = earned(sub, resolve(sub), true);
      if (h) return h;
    }
    // suffix-drop: drop a leading qualifier only when it is NOT a stopword
    // ("braaiboordjie wors" -> "wors" ok; "braai was" -> "braai" NOT ok)
    for (let start = 1; start < words.length; start++) {
      if (STOP_WORD_RE.test(words[0])) break;
      const sub = words.slice(start).join(" ");
      const dropped = words.slice(0, start);
      const allEnglish = dropped.every((w) => ENGLISH_QUALIFIER_RE.test(w));
      const h = earned(sub, resolve(sub), !allEnglish);
      if (h && clashOK(dropped.join(" ") + " " + sub, h)) return h;
    }
    return null;
  };
}

// P-461 iter 31 — @rule: CAPS-WALL-V3: a single-line ALL-CAPS wall
// ("500G BEEF MINCE 1 ONION CHOPPED 2 TBSP CURRY POWDER ... FRY ONION ...")
// is multiple glued records. Split before every qty-led token UNLESS the
// current segment already contains a cooking verb (then it's a step and its
// own "SIMMER 15 MINS" must stay glued). Verb-led tokens after a completed
// ingredient segment start the step segment.
const CAPS_VERB_RE =
  /^(?:FRY|BAKE|BOIL|SIMMER|COOK|HEAT|STIR|MIX|ADD|SEASON|WHISK|KNEAD|MARINATE|SERVE|GARNISH|BRAISE|ROAST|STEAM|GRILL|SPRINKLE|DRIZZLE|TRANSFER|REDUCE|BEAT|FOLD|COVER|REMOVE|STRAIN|BLEND|MELT|TOAST|SAUTE|BRAAI|PREHEAT|DRAIN|POUR|RUB|CUT|TOSS|BRUSH|GLAZE|COMBINE|SCOOP|DROP|BASTE|BROWN|SEAR|CHOP|PEEL|LINE|DUST|SHAPE|PLACE|SPREAD|REST)\b/i;
function splitCapsWall(line) {
  const toks = line.split(/\s+/).filter(Boolean);
  const segs = [];
  let cur = [];
  for (const tk of toks) {
    const qtyLead = /^\d+(?:[.,]\d+)?/.test(tk);
    const verb = CAPS_VERB_RE.test(tk);
    const curHasVerb = cur.some((w) => CAPS_VERB_RE.test(w));
    if (
      cur.length &&
      ((qtyLead && !curHasVerb) ||
        (verb && cur.length && !qtyLead && !curHasVerb))
    ) {
      segs.push(cur.join(" "));
      cur = [];
    }
    cur.push(tk);
  }
  if (cur.length) segs.push(cur.join(" "));
  return segs.filter((s) => s.trim()).join("\n");
}

export function decodeRecipeText(text, resolve) {
  resolve = makeStrongResolver(resolve);
  // ---- Layer 1: preprocessing of the whole paste ----
  let t = String(text || "")
    .replace(ZERO_WIDTH_RE, "")
    .replace(NBSP_RE, " ");
  // P-461 iter 32 (S218/S222): percentage-encoded spaces (%20) and fullwidth
  // unicode digits/punctuation (２,，) normalise to ASCII before anything else.
  t = t.replace(/%20/gi, " ").replace(/%2C/gi, ",");
  t = t
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/[Ａ-Ｚａ-ｚ]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xfee0),
    )
    .replace(/，/g, ",")
    .replace(/．/g, ".")
    .replace(/（/g, "(")
    .replace(/）/g, ")");
  // P-461 iter 32 (S221): a line FULLY wrapped in one paren pair is a shell —
  // "(500g beef mince)" is the line, not a parenthetical note.
  t = t
    .split("\n")
    .map((l) => {
      const m = l.trim().match(/^\(([^()]+)\)$/);
      return m && m[1].trim() ? m[1].trim() : l;
    })
    .join("\n");
  t = t.replace(
    new RegExp(FRAC_GLYPH_RE.source, "g"),
    (g) => UNICODE_FRACS[g] || g,
  );
  // "1⅓" became "11/3" without the space fix — re-insert: digit directly followed by "n/d"
  t = t.replace(/(\d)(\d\/\d)/g, "$1 $2");
  // P-461 iter 33 (S367): a hashtag marking an ingredient ("500g #beef mince")
  // keeps its WORD — only a line consisting of nothing but hashtags is noise.
  t = t.replace(URL_RE, " ").replace(EMOJI_RE, "");
  t = t
    .split("\n")
    .map((l) => {
      const HT_ONLY_RE = /^(?:#[a-z\u00c0-\u024f][\w-]*\s*)+$/i;
      if (HT_ONLY_RE.test(l.trim())) return "";
      if (!l.includes("#")) return l;
      // P-461 iter 33b: the tagged word is KEPT only when the hashtag opens the
      // post-quantity name ("500g #beef mince", "1 #onion") — trailing social
      // decoration ("1 kg potatoes #pap #lekker") still removes the tags.
      const before = l.slice(0, l.indexOf("#"));
      const QTY_ONLY =
        /^[\s\d.,\u2044/]*(?:g|kg|ml|l|tbsp|tsp|tblsp|dsp|tspn|cups?|koppies?|oz|lb|tins?|cans?|packets?|pinch|sticks?|cloves?|sheets?|slices?)?\s*$/i;
      return QTY_ONLY.test(before)
        ? l.replace(/#(?=[a-z\u00c0-\u024f])/gi, " ")
        : l.replace(/#[a-z\u00c0-\u024f][\w-]*/gi, " ");
    })
    .join("\n");

  // @rule: CAPS-WALL-V3 (S201): a line that is >=80% uppercase with >=2 qty-led
  // tokens is a glued wall — split it before the standard pipeline runs.
  t = t
    .split("\n")
    .map((line) => {
      const letters = line.replace(/[^A-Za-z]/g, "");
      const capsShare =
        letters.length >= 10
          ? line.replace(/[^A-Z]/g, "").length / letters.length
          : 0;
      const qtyToks = line
        .split(/\s+/)
        .filter((w) => /^\d+(?:[.,]\d+)?/.test(w)).length;
      return capsShare >= 0.8 && qtyToks >= 2 ? splitCapsWall(line) : line;
    })
    .join("\n");

  // @rule: WORD-REJOIN-V3 (P-461 loop iter 17): sharded pastes (one or two
  // words per line, "500g\nbeef\nmince\n1\nonion") are one recipe exploded
  // across lines. If >=5 non-empty lines and the median line is <=2 tokens,
  // rejoin with spaces and let the standard pipeline (incl. LINE-SPLIT-V3)
  // re-segment at quantity boundaries. Multi-line normal pastes never match.
  {
    const lns = t.split("\n").filter((s) => s.trim());
    if (lns.length >= 5) {
      // sharding signature: >=25% of lines are a bare number ("1", "2", "1/2") or a
      // bare unit word ("tbsp", "cup") — a real recipe line never IS just a
      // number/unit. (B01/B06 short emoji/caption lines have none of these.)
      const BARE_RE =
        /^(?:\d+(?:[.,]\d+)?(?:\/\d+)?|tbsp|tsp|cups?|g|kg|ml|l|oz|lb|tins?|cans?|packets?|pinch)$/i;
      // P-461 iter 31 (S216): a qty-glued one-token line ("500g") is as much a
      // shard as a bare "1" — real recipe lines are never JUST a quantity.
      const QTY_ONLY_RE =
        /^\d+(?:[.,]\d+)?(?:\/\d+)?\s*(?:g|kg|ml|l|tbsp|tsp|cups?)?$/i;
      const bare = lns.filter(
        (s) => BARE_RE.test(s.trim()) || QTY_ONLY_RE.test(s.trim()),
      ).length;
      // A real recipe line is never JUST a number or JUST a unit word — two or
      // more such lines anywhere in the paste is sharding, full stop. (Numbered
      // step lists carry text: "1." doesn't match BARE_RE.)
      if (bare >= 2) {
        // Rejoin INTO SEGMENTS, not one blob: a bare-number line ("1", "2")
        // starts a new ingredient segment; a cooking-verb-led line ("Fry",
        // "Boil") starts a step segment. Word fragments glue into the current
        // segment ("500g|beef|mince" -> "500g beef mince").
        const segs = [];
        let cur = [];
        const NUM_RE = /^\d+(?:[.,]\d+)?(?:\/\d+)?$/;
        // instruction-verb leads only — verbs that are ALSO food nouns
        // ("beef mince", "pork chops", "mashed potato") must NOT start a
        // segment, or "500g beef mince" shatters.
        const INSTR_VERB_LEAD =
          /^(?:fry|bakes?|boil|simmer|cooks?|heats?|stirs?|mix|adds?|season|whisks?|knead|creams?|braai|serves?|saute|saut|bastes?|marinate|pour|cover|reduce|drain|garnish|whips?|folds?|spread|toast|rub|brown|coat|toss|brush|glaze|sear|preheat|chop)$/i;
        for (const s of lns) {
          const w = s.trim();
          const w1 = w
            .split(/\s+/)[0]
            .toLowerCase()
            .replace(/[^a-z]/g, "");
          const GLUED_QTY_RE =
            /^\d+(?:[.,]\d+)?(?:\s*(?:g|kg|ml|l|tbsp|tsp|tspn|tblsp|cups?|koppies?|oz|lb|tins?|cans?|packets?|sticks?|dsp)\b|[.,]\d+)/i;
          const startsSeg =
            (NUM_RE.test(w) ||
              GLUED_QTY_RE.test(w) ||
              INSTR_VERB_LEAD.test(w1)) &&
            cur.length;
          if (startsSeg) {
            segs.push(cur.join(" "));
            cur = [];
          }
          cur.push(w);
        }
        if (cur.length) segs.push(cur.join(" "));
        t = segs.join("\n");
      }
    }
  }
  // @rule: NUMBERED-SEQ-V3 (P-461 loop iter 22): a paste whose lines carry
  // SEQUENTIAL list numbers ("1) 500g chicken / 2) 1 tbsp curry powder") is a
  // numbered list, not several recipes and not decimal quantities ("2.1 tbsp"
  // in such a paste is item 2 + 1 tbsp). If >=2 lines begin with N. or N) and
  // the leading numbers ascend by 1, strip every such prefix. Isolated
  // "1.5 kg" decimals (no sequence) are untouched.
  {
    const lns = t.split("\n");
    const nums = lns.map((l) => {
      const m = l.trim().match(/^(\d{1,2})[.)]/);
      return m ? parseInt(m[1], 10) : null;
    });
    const hits = nums.filter((n) => n !== null);
    if (hits.length >= 2) {
      let seq = true;
      for (let i = 1; i < nums.length; i++) {
        if (nums[i] === null) continue;
        let prev = null;
        for (let j = i - 1; j >= 0; j--) {
          if (nums[j] !== null) {
            prev = nums[j];
            break;
          }
        }
        if (prev !== null && nums[i] !== prev + 1) seq = false;
      }
      if (seq)
        t = lns
          .map((l, i) => {
            if (nums[i] === null) return l;
            const rest = l.trim().replace(/^\d{1,2}[.)]\s*/, "");
            // strip ONLY qty-led lines — numbered STEP lines ("3) Fry the chicken")
            // keep their numbering; it is content there.
            return /^\d/.test(rest) ? rest : l;
          })
          .join("\n");
    }
  }
  // @rule: PROSE-WORDNUM-V3 (P-461 iter 35): spoken-style one-liners spell
  // their quantities out ("you will need one tin chakalaka one onion chopped
  // and two tablespoons oil") — insert line breaks before every
  // word-number+unit (and word-number+food) token so the standard grammars
  // can parse them. Only for single-line prose with >=2 such tokens.
  {
    const nonEmpty = t.split("\n").filter((l) => l.trim());
    if (nonEmpty.length === 1 && nonEmpty[0].length > 40) {
      const WORDNUM_UNIT =
        /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|half a|a couple of)\s+(?:\d+\s+)?(?:tins?|cans?|packets?|packs?|tablespoons?|teaspoons?|cups?|koppies?|kgs?|gs?|mls?|ls?|tbsps?|tsps?|pinch(?:es)?|sprigs?|slices?|cloves?|eggs?|onions?|tomatoes?|potatoes?|carrots?|lemons?|bananas?|apples?|blocks?|sticks?|bunches?|heads?)\b/gi;
      const hits = nonEmpty[0].match(WORDNUM_UNIT) || [];
      if (hits.length >= 2) {
        let one = nonEmpty[0].replace(WORDNUM_UNIT, "\n" + "$&");
        // the trailing instruction run: first cooking verb after the last
        // ingredient fragment becomes its own line (the ONE-LINE splitter
        // never runs again — the paste is multi-line now).
        one = one
          .split("\n")
          .map((seg) => {
            const vm = seg.match(
              /^(.*?)\s+((?:first|then|next|finally)?\s*(?:fry|boil|add|pour|simmer|stir|mix|heat|cook|serve|sear|brown|braai)\b.*)$/i,
            );
            return vm &&
              vm[1] &&
              /^\d|\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\b/i.test(
                vm[1],
              )
              ? vm[1].trim() + "\n" + vm[2].trim()
              : seg;
          })
          .join("\n");
        t = one;
      }
    }
  }
  // @rule: LINE-SPLIT-V3 (P-460 loop iter 12): a recipe pasted as ONE line
  // (all-caps wall, pipe/slash/semicolon-separated, no breaks at all) has no
  // structure for the line classifier. Deterministic re-segmentation: ONLY
  // when the paste is a single non-empty line, split at explicit separators
  // (" | ", " / ", ";"), then at every quantity+unit boundary. Multi-line
  // pastes are never touched, so nothing already green can move.
  {
    const nonEmpty = t.split("\n").filter((l) => l.trim());
    if (nonEmpty.length === 1 && nonEmpty[0].length > 40) {
      let one = nonEmpty[0];
      one = one.replace(
        /\s+[|\/]\s+|\s*;\s*|\s+\\+\s+|\s*::\s*|\s*->\s*|\s*→\s*|\s+@\s+|\s*\?+\s+|\s*=+\s+|\s*-{2,}\s*|\s*:\s*/g,
        "\n",
      );
      const QTY_BOUNDARY =
        /\s+(?=\d+(?:[.,]\d+)?\s*(?:kg|g|ml|l|cups?|koppies|koppie|tbsp|tsp|tablespoons?|teaspoons?|oz|lb|tins?|cans?|packets?|sticks?|pinch)\b)/gi;
      one = one.replace(QTY_BOUNDARY, "\n");
      // the trailing instruction run: first all-caps/lowercase cooking verb after
      // the last ingredient line becomes its own line
      // @rule: CAPS-VERB-SPLIT (P-461 loop iter 24): an instruction verb INSIDE
      // a qty-led segment ("2 TBSP SUGAR RUB BUTTER INTO FLOUR") ends the
      // ingredient at that verb — the segment keeps its ingredient head, the
      // verb tail joins the step run. Only INSTR verbs that are never food
      // nouns fire (rub/beat ok; mince/chop/baked excluded — "beef mince",
      // "pork chops", "baked beans" must stay intact).
      const VERB_TAIL_RE = new RegExp(
        "^(\\d[^;]*?)\\s+((?:rub|beat|fry|boil|bakes?|simmer|cooks?|heats?|stirs?|mix|adds?|season|whisks?|knead|creams?|braai|saute|saut|bastes?|marinate|pour|cover|reduce|drain|garnish|whips?|folds?|drizzle|brush|glaze)\\b.*)$",
        "i",
      );
      one = one
        .split("\n")
        .map((seg) => {
          if (!/^\d/.test(seg)) return seg;
          const m = seg.match(VERB_TAIL_RE);
          return m ? m[1] + "\n" + m[2] : seg;
        })
        .join("\n");
      const parts = one.split("\n");
      if (parts.length >= 3) {
        const last = parts[parts.length - 1];
        const vm = last.match(
          /^(.*?\S)\s+((?:boil|heat|add|mix|stir|fry|bake|cook|simmer|steam|combine|whisk|pour|chop|peel|season|serve|braai|roast|knead|rise|dissolve|cream|melt|brown|saute)\b.*)$/i,
        );
        if (vm && /^\d/.test(last)) {
          parts[parts.length - 1] = vm[1];
          parts.push(vm[2]);
        }
        t = parts.join("\n");
      }
    }
  }

  // ---- Layer 5: multi-recipe split (C03, I) ----
  let multi = false;
  // named sub-recipes ("COOKIE RECIPE:", "FROSTING:") count per LINE (C03)
  const headerLines = t
    .split("\n")
    .filter((l) => RECIPE_HEADER_RE.test(l.trim()));
  const marks = [...t.matchAll(/(?:^|\n)\s*\d{1,2}\)\s/g)];
  // P-461 iter 30 (S059): "1) 500g chicken / 2) 1 tbsp curry powder" is a
  // numbered LIST — every marked line qty-led or verb-led means no sub-recipes.
  const markedLines = [...t.matchAll(/(?:^|\n)\s*(\d{1,2})\)\s*([^\n]*)/g)];
  const isListItemShape = (ln) => {
    const l = ln.trim();
    return (
      /^\d/.test(l) ||
      VERB_STEP_RE.test(l) ||
      /^(?:fry|boil|bake|mix|add|heat|cook|simmer|stir|chop|season|serve|garnish|preheat)\b/i.test(
        l,
      )
    );
  };
  const allListItems =
    markedLines.length >= 2 && markedLines.every((m) => isListItemShape(m[2]));
  // P-461 iter 30b: a single residual "N)" marker (sequential strips already
  // consumed the numbered ingredient lines) is never multi — need >= 2.
  if ((marks.length >= 2 && !allListItems) || headerLines.length >= 2) {
    multi = true;
    if (marks.length >= 2) {
      // numbered "N)" markers win (I): "1) Pancakes ..." — keep recipe 1 and
      // strip its marker so the numbered-step rule can't eat it
      t = t.slice(0, marks[1].index + 1);
      t = t.replace(/(^|\n)\s*\d{1,2}\)\s/, "\n");
    } else {
      // named sub-recipes (C03: "COOKIE RECIPE:" ... "FROSTING:") — parse the
      // FIRST named recipe only; the rest is flagged, never silently merged
      const lines = t.split("\n");
      const firstHeader = lines.findIndex((l) =>
        RECIPE_HEADER_RE.test(l.trim()),
      );
      const secondHeader = lines.findIndex(
        (l, i) => i > firstHeader && RECIPE_HEADER_RE.test(l.trim()),
      );
      if (secondHeader >= 0) t = lines.slice(0, secondHeader).join("\n");
    }
  }

  const work = t
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const unresolved = []; // [{line, reason}] — Layer 4 (conservative)
  const ignored = []; // social noise, stripped artifacts
  let servings = null,
    timeMinutes = null;
  let prepCookMinutes = 0;
  const serveWith = []; // P-437: serve-with suggestions (metadata, informational)
  let title = null,
    titleCandidate = null,
    steps = [],
    ingredients = [];
  let inSteps = false,
    inIngredients = false;

  const queue = (line, reason) => unresolved.push({ line, reason });

  while (work.length) {
    const rawLine = work.shift();
    // P-461 iter 34 (S670/S520/S820): a quantity fully wrapped in brackets
    // ("[1 kg] potatoes", "(1 kg) potatoes", "<1 kg> potatoes") is an UNCERTAIN
    // quantity — the author bracketed it for a reason. Conservative: review.
    // NOTE: the bracket must carry a UNIT ("[1 kg] potatoes") — a bare bracketed
    // number ("[1] 500g macaroni") is list NUMBERING, handled by the marker strip.
    if (
      /^[\[(<]\s*\d+(?:[.,]\d+)?(?:\/\d+)?\s*(?:kg|g|ml|l|tbsp|tsp|cups?|tins?|packets?|oz|lb)\s*[\])>]/i.test(
        rawLine.trim(),
      ) &&
      /\S/.test(rawLine.trim().replace(/^[\[(<][^\])>]*[\])>]/, ""))
    ) {
      queue(rawLine.trim(), "vague_quantity");
      continue;
    }
    {
      let line = rawLine
        .replace(MD_BULLET_RE, "")
        .replace(MD_BULLET_RE, "")
        .trim(); // bullets stack: "- [ ] 2 cups flour"
      // @rule: NOISE-SHELL-V3 (P-461 iter 29): pastes arrive wrapped in decorative
      // shells that are never content — HTML list/para tags, markdown bold/italic
      // asterisks, "{...}"/"!!!...!!!" enclosures, "#"/"=" line markers, JSON
      // quoted keys, literal "\r\n" escapes and "&nbsp;" entities. All stripped
      // BEFORE classification so the ingredient text underneath parses normally.
      // literal escape sequences are LINE BREAKS the author pasted from a text
      // export: split them back into real lines instead of gluing them.
      if (/\\[rn]/i.test(line)) {
        const parts = line
          .split(/(?:\\r\\n|\\n|\\r)+/i)
          .map((s) => s.trim())
          .filter(Boolean);
        if (parts.length > 1) {
          work.unshift(...parts);
          continue;
        }
        line = parts[0] || "";
      }
      line = line
        .replace(/&nbsp;|&amp;/gi, " ")
        .replace(/<\/?[a-z][a-z0-9-]*\b[^>]*>/gi, " ")
        // P-461 iter 34b (B06): only LABEL tags strip ([ING], {ing}, [/STEP]) —
        // caption artifacts like [Music] survive to the STAGE-DIR ignore path.
        .replace(
          /\[\/?\s*(?:ING|INGREDIENTS?|ITEMS?|STEPS?|RECIPES?|QTY|METHOD|INSTRUCTIONS?)\s*\]/gi,
          " ",
        )
        .replace(
          /\{\/?\s*(?:ING|INGREDIENTS?|ITEMS?|STEPS?|RECIPES?|QTY|METHOD|INSTRUCTIONS?)\s*\}/gi,
          " ",
        )
        // bold "**runs**" strip; a single trailing "*" is the author's punctuation
        // and STAYS in the display raw (recorded contract, markdown-italic lines)
        .replace(/\*\*+/g, "")
        .replace(/^[\s{}!#+\-]+/, "")
        // "=" markers ("= 2 cups flour") strip ONE lead equals — "===" section
        // banners are structural decoration and queue intact (recorded raw).
        .replace(/^=(?!=)/, "")
        .replace(/^~(?=\s*\d)/, (m, off, s) =>
          /^~?\s*\d+\s*(?:calories?|kcal|kj)s?\b/i.test(s) ? "~" : "",
        )
        // "!!!"/"-=~" shell RUNS strip at line end; a single "!" stays (the
        // exclamation-joined fixture records "500g chicken thighs!" as the raw)
        .replace(/(?:!{2,}|[{}~+?\s])[{}!~+?\s]*$/, "")
        // NOTE: section headers ("Method:", "=== INGREDIENTS ===") must SURVIVE
        // this chain — they set inSteps/inIngredients later in the loop. Only
        // QUOTED JSON keys and the "Ing:"/"Ingred:" abbreviations strip here.
        .replace(
          /^["'](?:ingredients?|ingreds?|ingr?|steps?|instructions?|method)(?:[_\s-]?\d+)?["']\s*[:=]\s*["']?/i,
          "",
        )
        .replace(/^ing(?:red)?\s*\d*\s*[:=]\s*/i, "")
        .replace(/^["']|["'],?$/g, "")
        .trim();
      // @rule: PREFIX-STRIP-V3 (P-460 loop iter 13): structural line prefixes are
      // scaffolding, never content — "[Ingredient] 500g macaroni", "[Step] Boil",
      // "ingredient_1 = 2 cups flour", "instruction = Mix", and list numbering
      // glued to a quantity ("1.500g chicken" is item 1 + 500 g, NOT 1.5 kg —
      // that misread would price 3x the real mass with no review).
      // P-461 iter 31 (S217): "Step:"/"Step 2:" prefix — the content is a STEP
      // by construction, verb or not ("Step: Coat chicken in spice"). The generic
      // word-prefix strip below would eat the marker and leave a verb-less
      // instruction to be mis-titled.
      {
        const sm = line.match(/^steps?(?:[_\s-]?\d+)?\s*[=:]\s*(.*)$/i);
        if (sm) {
          inSteps = true;
          inIngredients = false;
          const content = sm[1].trim();
          if (content.length > 2) steps.push(content);
          continue;
        }
      }
      line = line
        .replace(
          /^\[(?:ingredients?|step|steps|method|instruction|instructions)\]\s*/i,
          "",
        )
        .replace(
          /^(?:ingredient|step|instruction)s?(?:[_\s-]?\d+)?\s*[=:]\s*/i,
          "",
        )
        // list-numbering glued to a qty: ONLY when the "decimal" part is 3+ digits
        // directly followed by a metric unit ("1.500g", "2.250ml") — a real
        // decimal ("2.5 sticks", "1.5 cups", "0.5 lb") has 1-2 digits.
        .replace(/^(\d{1,2})\.(?=\d{3,}\s*(?:kg|g|ml|l)\b)/i, "");
      // P-429 N1: TikTok chapter timestamps ("00:01 ...") and "Step N:" markers
      // @rule: KEYCAP-STRIP-V3 (P-461 iter 28): emoji list markers "1⃣ 1 kg beef"
      // are digit + U+20E3; strip the combining keycap so the digit returns to
      // being a plain numbered-list marker.
      line = line.replace(/\u20E3/gu, "");
      line = line
        .replace(/^\d{1,2}:\d{2}(?::\d{2})?\s*/, "")
        .replace(/^step\s*\d+\s*[:.)-]\s*/i, "")
        .trim();
      // @rule: DASH-PREFIX-V3 (P-461 iter 28): "1- 4 cups flour" is list numbering,
      // NOT a range — dash glued to the digit with a space after it. Real ranges
      // ("2-3 cups", "1 - 4 cups") have no space right after the dash.
      line = line
        .replace(/^\d{1,2}[-–]\s+(?=\d)/, "")
        .replace(/^\.\s+/, "")
        .replace(/\s+and$/i, "");
      // P-461 iter 34 (S524): ".500g beef" / ".1 onion" is a glued dot bullet —
      // strip the dot unless the digits are a real decimal fraction (.5 .25 .75 .125).
      {
        const dm = line.match(/^\.(\d{1,3})(?=[^\d])/);
        if (dm && !/^(?:5|25|75|125|05|025|075)$/.test(dm[1]))
          line = line.slice(1);
      }
      // P-461 iter 33: __underline__ wrappers and ~~strikethrough~~ content
      // (S223/S360 — struck text is removed by the author, not an ingredient).
      line = line
        .replace(/~~[^~]*~~/g, " ")
        .replace(/__+/g, " ")
        .trim();
      line = line
        .replace(/^\[\d+\]\s*/, "")
        .replace(/^items?\s*\d*\s*[:：]\s*/i, "");
      // keycap-stripped markers ("1⃣ 1 kg beef" -> "1 1 kg beef") leave a bare
      // numbered marker: strip it ONLY when the remainder is a clean qty+unit
      // lead — mixed numbers ("1 1/2 cups") don't satisfy the unit lookahead.
      line = line.replace(
        /^\d{1,2}\s+(?=\d(?:[.,]\d+)?\s*(?:kg|g|ml|l|lb|oz|tsp|tbsp|cups?)\b)/i,
        "",
      );
      if (!line) continue;

      // ---- inline list splitting (C01 comma line, F05 buried recipe) ----
      // a line carrying >=2 quantity-led comma segments is a LIST: split it.
      if (!inSteps && /,/.test(line)) {
        // P-442: a comma BETWEEN DIGITS is SA decimal notation ("1,5 cups"), never
        // a list separator — splitting it produced a phantom "5 cups" line.
        // P-410 Safari pass: a lookbehind regex literal throws SyntaxError at
        // MODULE LOAD on iOS Safari <16.4 (kills the whole decoder). Sentinel-
        // protect digit-adjacent commas instead — same semantics, parses anywhere.
        const guard = line
          .replace(/(\d),/g, "$1\u0001")
          .replace(/,(\d)/g, "\u0001$2");
        const segs = guard
          .split(",")
          .map((s) => s.replace(/\u0001/g, ",").trim())
          .filter(Boolean);
        if (
          segs.length >= 2 &&
          segs.filter((s) => parseQtyLead(s)).length >= 2
        ) {
          work.unshift(...segs);
          continue;
        }
      }
      // NOISE-SHELL-V3 (cont.): "~"/"+" joined one-liners ("2 cups oats ~ 1 cup
      // milk ~ ..."). Gate: >=2 segments that are qty-lead AND carry a name —
      // so "1 + 1/2 cups flour" (bare number fragments) can never split.
      if (!inSteps && /[~+]/.test(line)) {
        const segs = line
          .split(/\s*[~+]\s*/)
          .map((s) => s.trim())
          .filter(Boolean);
        const qtyNamed = segs.filter((s) => {
          const l = parseQtyLead(s);
          return l && l.rest.trim().length > 2;
        });
        // P-461 iter 29b (A04): a SINGLE "+" inside a line ("1 lb mince + 500ml
        // water") is a secondary-quantity note, not a list — require 2+ delimiters.
        if (segs.length >= 3 && qtyNamed.length >= 2) {
          work.unshift(...segs);
          continue;
        }
      }
      // prose with embedded ": ..." segments (F05 "here is what you need: 2 cups flour, ...")
      if (line.length > 100 && /[:：]/.test(line)) {
        const parts = line
          .split(/[:：]\s*/)
          .map((s) => s.trim())
          .filter(Boolean);
        if (parts.length >= 2) {
          work.unshift(...parts);
          continue;
        }
      }
      // qty+unit with NO name + a bare word next line = one split ingredient (F02)
      if (
        /^\d+(?:[.,]\d+)?\s*(?:\d+\/\d+)?\s*[a-zA-Z]+$/.test(line) &&
        work.length
      ) {
        const tailWord = line.split(/\s+/).pop();
        if (
          UNIT_CANON[tailWord.toLowerCase()] &&
          !FOOD_UNIT_RE.test(tailWord) &&
          /^[A-Za-z'\u00C0-\u024F -]{2,30}$/.test(work[0]) &&
          !/\d/.test(work[0])
        ) {
          line = line + " " + work.shift(); // "1 cup" + "flour" (F02)
        }
      }

      // P-437 ss4: a promo tail on a line with real cooking content is STRIPPED,
      // not nuked (SQ11: "...fry until golden. Follow for more!")
      const tailStripped = line.replace(PROMO_TAIL_RE, "").trim();
      if (tailStripped && tailStripped !== line) line = tailStripped;
      // social/CTA noise → ignored (B04, H6-H9)
      if (TIKTOK_META_RE.test(line) || CTA_RE.test(line)) {
        ignored.push(rawLine);
        continue;
      }
      if (STAGE_DIR_RE.test(line)) {
        ignored.push(rawLine);
        continue;
      }
      // P-429 N/J: "Time: 45 mins" is a PARSED header, not meta noise
      const tmHdr =
        /^(?:total\s+)?(?:time|duration)\s*:?\s*(\d{1,3})\s*(min(?:s|utes?)?|hours?|hrs?|h)\b/i.exec(
          line,
        );
      if (tmHdr && timeMinutes === null) {
        timeMinutes = parseInt(tmHdr[1], 10) * (/h/i.test(tmHdr[2]) ? 60 : 1);
        continue;
      }
      // P-445: prep/cook accumulate into a total when no explicit Time/Total given
      const pcHdr =
        /^(?:prep(?:aration)?|cook(?:ing)?)\s+time\s*:?\s*(\d{1,3})\s*(min(?:s|utes?)?|hours?|hrs?|h)\b/i.exec(
          line,
        );
      if (pcHdr) {
        prepCookMinutes +=
          parseInt(pcHdr[1], 10) * (/h/i.test(pcHdr[2]) ? 60 : 1);
        continue;
      }
      if (META_RE.test(line)) {
        queue(line, "meta_info");
        continue;
      } // D04, J04
      if (PRICE_TALK_RE.test(line)) {
        queue(line, "price_talk");
        continue;
      } // E04
      if (OPT_PREFIX_RE.test(line)) {
        queue(line, "optional_or_garnish");
        continue;
      } // H14-16
      // P-429 P1: doneness language inside a NUMBERED step or a Steps section is
      // normal cooking ("2. Grill until golden brown"), not a review line.
      const stepShaped = inSteps || /^\d+[.)]\s/.test(line);
      // P-437 ruling: doneness language queues only when the cue FOLLOWS the verb
      // directly ("Bake until golden" = D02 review). A verb with an object before
      // the cue ("Add the onions and fry until golden" = SQ9) is a real step.
      // P-437 ruling: a subjective/vague line is a REVIEW only when nothing
      // concrete remains after the matched phrase. "Season to perfection" has no
      // object -> review (H1). "Add the onions and fry until golden" has onions ->
      // real step (SQ9). "Bake in a preheated oven until golden" has oven (EQUIP)
      // -> real step (SQ5). Deterministic: strip the matched phrase, look for a
      // registry word or equipment word in what's left.
      // P-458 iter 8: "a good pinch of salt" never auto-saves. But a line with a
      // real digit-led segment ("Then add 1 tbsp sugar and a pinch of salt", C02)
      // still goes to the inline extractor so its measured half survives.
      if (!stepShaped && !/\d/.test(line) && VAGUE_UNIT_WORD_RE.test(line)) {
        queue(line, "vague_quantity");
        continue;
      }
      if (
        !stepShaped &&
        (SUBJECTIVE_RE.test(line) || VAGUE_LINE_RE.test(line))
      ) {
        const subjHit = SUBJECTIVE_RE.exec(line) || VAGUE_LINE_RE.exec(line);
        // object region = words BEFORE the subjective cue; a whole-word registry
        // or equipment hit there means real cooking content ("the onions", "oven").
        const objRegion = line.slice(0, subjHit ? subjHit.index : 0);
        // concrete = whole-word ingredient, equipment, OR any digit (P-437:
        // "bake at 180C fan for 35 mins until golden" is a real step - temps and
        // durations are cooking content; "Season to perfection" has neither)
        const hasConcreteObject =
          /\d/.test(objRegion) ||
          objRegion
            .split(/[^a-zA-Z'\u00C0-\u024F]+/)
            .filter((w) => w.length >= 2)
            .some((w) => EQUIP_RE.test(w) || isWholeWordIngredient(w, resolve));
        if (!hasConcreteObject) {
          // v3-V121/V128: "Some salt" / "salt to taste" are QUANTITY problems —
          // they must BLOCK save (vague_quantity), not vanish as benign style.
          const VAGUE_QTY_CUE_RE =
            /\b(?:to taste|some|as much as|as much [a-z ]{1,20} as|a bit|a little|little bit|generous amount|as needed|as required)\b/i;
          queue(
            line,
            VAGUE_QTY_CUE_RE.test(line)
              ? "vague_quantity"
              : "subjective_or_vague",
          );
          continue; // D02, H1, H2
        }
      }
      if (/^(?:sorry|i didn'?t)\b.*(?:measure|eyeball)/i.test(line)) {
        queue(line, "unmeasured");
        continue;
      }

      // serves / makes
      const srR = /^(\d{1,2})\s+servings?\b/i.exec(line); // P-445: reversed "6 servings" (explicit word - safe despite leading digit)
      const sr = SERVES_RANGE_RE.exec(line) || SERVES_RE.exec(line) || srR;
      if (sr && servings === null && (srR || !ING_LINE_RE_safe(line))) {
        // P-568: "Beef Mince Curry – serves 6" — the prefix before the serves
        // match is the dish name. The hint is consumed below, but the title
        // must not die with it (these pastes used to decode as "Untitled
        // recipe"). Same shape gates as TITLE-FIRST-V3, applied to the prefix.
        const prefix = line
          .slice(0, sr.index)
          .replace(/[\s\-–—,:;(]+$/, "")
          .replace(/^[(*_~`]+/, "")
          .trim();
        if (
          prefix &&
          !titleCandidate &&
          prefix.split(/\s+/).length <= 6 &&
          !/\d/.test(prefix) &&
          !/[.,;:!?]$/.test(prefix) &&
          (prefix === prefix.toUpperCase() || /^[A-Z]/.test(prefix))
        ) {
          titleCandidate = prefix.replace(/\s+/g, " ");
        }
        servings = Number(sr[1]); // ranges: lower bound
        const tmIn = TIME_RE.exec(line); // "Serves 4 – 30 min" carries both
        if (tmIn && timeMinutes === null) timeMinutes = parseInt(tmIn[1], 10);
        if (sr[2]) queue(line, "serving_range_needs_review"); // H20: "Serves 2-4 people" is ambiguous — capture AND flag
        continue; // a serves line is never an ingredient, step, or title
      }
      // method header flips to steps
      // P-461 iter 35 (T832): "How to make fluffy pap every time!" is a TITLE,
      // not a method header — the 'how to' variant only fires on SHORT bare
      // headers ("How to make pap"), never on a sentence with an ending bang.
      const isHowToSentence =
        /^how\s+to\b/i.test(line) &&
        (line.split(/\s+/).length > 5 || /[.!]$/.test(line.trim()));
      if (
        METHODS_RE.test(line) &&
        !isHowToSentence &&
        line.length < 60 &&
        !/\d/.test(line)
      ) {
        inSteps = true;
        inIngredients = false;
        // P-461 iter 31 (S217): "Step: Coat chicken in spice" carries its FIRST
        // step after the colon — a header with a tail pushes the tail as step 1.
        const mTail = line.match(/^[a-z]+\s*[:：]\s*(.+)$/i);
        if (mTail && mTail[1].trim().length > 3) steps.push(mTail[1].trim());
        continue;
      }
      if (ING_HEADER_RE.test(line)) {
        // P-461 iter 30 (W136): a whole-line header is consumed here — it must never fall through to the title catch
        inIngredients = true;
        inSteps = false;
        continue;
      }
      if (ING_HEADER_PREFIX_RE.test(line)) {
        const tail = line.replace(ING_HEADER_PREFIX_RE, "").trim();
        inIngredients = true;
        inSteps = false;
        if (!tail) continue;
        line = tail;
      }
      if (inSteps) {
        steps.push(line.replace(/^\d+[.)]\s*/, ""));
        continue;
      }
      if (/^\d+[.)]\s/.test(line)) {
        steps.push(line.replace(/^\d+[.)]\s*/, ""));
        inSteps = true;
        continue;
      }
      // standalone time line
      const tm = TIME_RE.exec(line);
      // only a line that LEADS with its duration is a pure time line —
      // "Bake 180C 12 mins" is a step, not a time header (B01, G01)
      if (
        tm &&
        timeMinutes === null &&
        /^~?\s*\d/.test(line.replace(/^[^\d\w~]+/, ""))
      ) {
        timeMinutes = parseInt(tm[1], 10);
        continue;
      }

      // P-429 P4: digit-led TITLES ("7-Day Family Meal Prep Dump") claim candidacy
      // BEFORE the qty grammar can eat them ("7-Day" -> qty 7). Candidate still has
      // to survive the recipe-shape test below, so this can't fabricate titles.
      if (
        !titleCandidate &&
        /^\d+\s*[-–]\s*(?:day|week|min(?:ute)?s?|dinner|plate|meal|course|star)s?\b/i.test(
          line,
        ) &&
        line.length <= 70
      ) {
        titleCandidate = line;
        continue;
      }
      // ---- Layer 2/3: try the three ingredient grammars ----
      let entry = null;
      // vague quantity guard BEFORE auto-save (A05, E02 knippie)
      const vagueLead = line.match(/^(?:[aA]?\s*)([a-zA-Z]+)\b/);
      // P-429 O1-O3: nested/compound quantities never half-parse — queue whole
      if (
        /\b(?:half|quarter|third|\d\/\d)\s+of\s+(?:a\s+)?(?:half|quarter|third|three[\s-]quarters)\b/i.test(
          line,
        ) ||
        /\band\s+a\s+half\s+(?:dozen|doz)\b/i.test(line)
      ) {
        queue(line, "vague_quantity");
        continue;
      }
      // P-438: also test the post-quantity remainder — "1 mespunt sout",
      // "2 drops essence" must reach review like their bare-token forms
      const leadQtyForVague = parseQtyLead(line);
      if (
        VAGUE_UNIT_RE.test(line) ||
        (leadQtyForVague && VAGUE_UNIT_RE.test(leadQtyForVague.rest))
      ) {
        queue(line, "vague_quantity");
        continue;
      }
      // @rule: TITLE-FIRST-V3 (P-461 iter 30): a paste that OPENS with a short
      // Title-Case/ALL-CAPS dish name ("Steam Bread\n4 cups cake flour") has a
      // title, not a step. Gates: still before any content, <=5 words, no
      // digits, no sentence punctuation, first word NOT a cooking verb, and the
      // next content line is qty-led ("Steam" is a verb, but "Steam Bread" as a
      // 2-word Title-Case line followed by ingredients is a dish name).
      if (
        !titleCandidate &&
        !ingredients.length &&
        !steps.length &&
        !inSteps &&
        !inIngredients
      ) {
        // P-568: real forwards open with "Beef Mince Curry – serves 6" — the
        // servings hint used to kill the title gates (digits, punctuation) and
        // the paste fell back to "Untitled recipe". Strip the trailing hint
        // segment FIRST; the clean dish name is the honest title.
        const titleLine = line
          .trim()
          .replace(/\s*[-–—(]\s*(?:serves|for)\s+\d+\s*\)?\s*$/i, "")
          .replace(/\s*\(\s*(?:serves|for)\s+\d+\s*\)\s*$/i, "")
          .trim();
        const wds = titleLine.split(/\s+/);
        const titleShaped =
          titleLine &&
          wds.length <= 5 &&
          !/\d/.test(titleLine) &&
          !/[.,;:!?]$/.test(titleLine) &&
          /^[A-Z]/.test(titleLine) &&
          (titleLine === titleLine.toUpperCase() ||
            /^[A-Z][a-z'’]*(?:\s[A-Z][a-z'’!]*)*$/.test(titleLine));
        const nextC = (work[0] || "").trim();
        if (titleShaped && parseQtyLead(nextC)) {
          titleCandidate = titleLine.replace(/\s+/g, " ");
          continue;
        }
      }
      // 1) leading qty ("2 cups flour", "½ cup", "one cup", "200g")
      entry = parseIngredientLine(line, resolve);
      // 1b) equipment check on the parsed name (D03: "1 large bowl")
      if (entry && EQUIP_RE.test(entry.raw)) {
        queue(line, "equipment");
        continue;
      }
      // P-461 iter 31: the verb test must run on the ACCENT-FOLDED line —
      // "Sauté" (NFD-composed in pastes) vs the pattern's dé form otherwise
      // mismatches and the reverse-qty grammar hijacks a real instruction.
      const lineVerbD = line.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      if (!entry && !VERB_STEP_RE.test(lineVerbD)) {
        // 2) reverse: name ... qty unit (B02, D05, J04 "Ingredients: flour 2 cups")
        // verb-first lines NEVER hit this branch — they're instructions (D01/C02)
        const bare = line.replace(ING_HEADER_PREFIX_RE, "");
        entry = parseReverseLine(bare, resolve);
        if (entry) entry.raw = line;
      }
      if (entry) {
        // safety: time units never ingredients ("10-12 minutes bake time" slips past)
        if (TIME_UNIT_RE.test(entry.unit)) {
          queue(line, "time_expression");
          continue;
        }
        ingredients.push(entry);
        if (!entry.resolvedName) queue(line, "unresolved_ingredient");
        continue;
      }
      // 3) verb-first: step (P-404), possibly carrying a real inline ingredient (C02 vs D01)
      // P-437 ss4: "Okay so now, add the onions..." - filler hides a real verb step
      let leadStripped = line;
      for (let i = 0; i < 5; i++)
        leadStripped = leadStripped.replace(LEAD_FILLER_RE, "");
      leadStripped = leadStripped.trim();
      if (
        leadStripped &&
        leadStripped !== line &&
        VERB_STEP_RE.test(leadStripped)
      )
        line = leadStripped;
      // P-437 ss2: pure serve-with line -> serveWith[] (never a step)
      if (SERVE_STRIP_RE.test(line)) {
        const served = serveWithObject(line, resolve);
        if (served) {
          serveWith.push(...served);
          continue;
        }
      }
      // P-461 iter 26: accent-normalised copy for classification tests only —
      // the pushed step/raw keeps the author's original text ("Sauté" stays).
      const lineD = line.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      if (VERB_STEP_RE.test(lineD)) {
        // P-461 iter 30 (W143/Q003/Q017/Q303/Q453 family contract): an
        // instruction sentence carrying an oven-temp/duration cue is KEPT as a
        // step AND flagged temperature_or_duration — the temp/duration must be
        // human-confirmed before save; flag-without-step loses the instruction.
        if (
          /\d+\s*(?:°?c|°?f|gas mark)/i.test(lineD) ||
          /\bfreezer?\s*[:：]?\s*-?\d+/i.test(lineD)
        ) {
          const inline0 = extractInlineIngredient(line, resolve);
          if (inline0 && inline0.resolvedName) ingredients.push(inline0);
          steps.push(line);
          queue(line, "temperature_or_duration");
          continue;
        }
        const inline = extractInlineIngredient(line, resolve);
        if (inline && inline.resolvedName) ingredients.push(inline);
        // P-437 ss2 metadata: a surviving step can still mention "serve with X"
        const sm = SERVE_META_RE.exec(line);
        if (sm) {
          for (const p of sm[1]
            .split(/\s*(?:,|&|\band\b)\s*/i)
            .map((p2) => p2.trim())
            .filter(Boolean)) {
            const hit = resolve(p);
            if (hit)
              serveWith.push({ resolvedId: hit.id, resolvedName: hit.name });
          }
        }
        steps.push(line.replace(/^\d+[.)]\s*/, ""));
        continue;
      }
      // temperatures / durations (G04) — AFTER verbs so "Mix... Bake 180C 10 mins" stays a step
      if (
        /\d+\s*(?:°?c|°?f|gas mark)/i.test(lineD) ||
        /\bfreezer?\s*[:：]?\s*-?\d+/i.test(lineD)
      ) {
        // P-461 iter 30 (W143): an instruction sentence carrying temp/duration
        // keeps its step (verbs still needed downstream) AND gets the flag —
        // flag-without-step loses the cooking instruction entirely.
        const words = line
          .toLowerCase()
          .replace(/[^a-z\s]/g, " ")
          .split(/\s+/)
          .filter(Boolean);
        if (
          words.some(
            (w) => COOKING_VERB_SET.has(w) || VERB_STEP_RE.test(w + " "),
          )
        )
          steps.push(line);
        queue(line, "temperature_or_duration");
        continue;
      }
      // P-437 ss5: marketing lines are never steps OR titles ("You won't
      // believe how good this is!!" must not become the recipe title)
      if (/[a-z]/.test(line)) {
        const mWords = line
          .toLowerCase()
          .replace(/[^a-z'\s]/g, " ")
          .split(/\s+/)
          .filter(Boolean);
        const mHits = mWords.filter((w) => MARKETING_SET.has(w)).length;
        if (
          mHits >= 2 &&
          !mWords.some((w) => COOKING_VERB_SET.has(w)) &&
          !mWords.some((w) => resolve(w))
        ) {
          ignored.push(line);
          continue;
        }
      }
      // @rule: TITLE-GUARD-V3 — vague/quantity lines never claim the title: they queue
      if (
        !titleCandidate &&
        (VAGUE_LINE_RE.test(line) ||
          VAGUE_UNIT_RE.test(line.replace(/^[\d.,\s]+/, "")))
      ) {
        queue(line, "vague_quantity");
        continue;
      }
      // title: first short non-qty line — DEFERRED (H3): a lone prose line in a
      // paste with no ingredients/steps is unparsed, not a title.
      if (
        !titleCandidate &&
        line.length <= 70 &&
        (!/^[\d]/.test(line) || /^\d+\s*[-\u2013]\s*\D/.test(line))
      ) {
        titleCandidate = line
          .replace(/^(?:recipe|how to make|how to)\s*[:\-]?\s*/i, "")
          .replace(/^["'!A-Z0-9 ]{2,}!\s*/, "") // P-429 P1: drop shouty leads ("HEIT MK! ")
          .replace(/[!\s]+$/, "")
          .trim();
        continue;
      }
      // leftover: CONSERVATIVE (Layer 4) — short lines queue, long prose is noise
      if (line.length > 120) {
        ignored.push(rawLine);
        continue;
      }
      queue(line, "unparsed_line");
    }
  }

  // ---- P-437 step-quality pipeline (P-424 findings ss4->ss1->ss3->ss5) ----
  steps = steps
    .map((s) => {
      let t = s;
      for (let i = 0; i < 5; i++) t = t.replace(LEAD_FILLER_RE, "");
      t = t.replace(PROMO_TAIL_RE, "");
      t = t.trim();
      const letters = t.replace(/[^A-Za-z]/g, "");
      const wordCount = t.split(/\s+/).filter(Boolean).length;
      if (
        wordCount >= 4 &&
        letters.length &&
        (letters.match(/[A-Z]/g) || []).length / letters.length >= 0.85
      ) {
        t =
          t.charAt(0).toUpperCase() +
          t
            .slice(1)
            .toLowerCase()
            .replace(
              /\b(bbq|sa|rsa|msg|tvp)\b/gi,
              (w2) => ACRONYM_MAP[w2.toLowerCase()] || w2,
            );
      }
      if (t) t = t.charAt(0).toUpperCase() + t.slice(1);
      return t;
    })
    .filter(Boolean);
  // ss1: oven temps (additive only, text untouched)
  const stepTemps = [];
  for (const [i, s] of steps.entries()) {
    const c = extractOvenTempC(s);
    if (c !== null) stepTemps.push({ stepIndex: i, raw: s, canonicalC: c });
  }
  const ovenTempC = stepTemps.length ? stepTemps[0].canonicalC : null;
  // ss3: deduplication (min 4 tokens; Jaccard .85 or strict subset)
  const keep = [];
  const keptTokens = [];
  for (const s of steps) {
    const tk = stepTokens(s);
    const dup =
      tk.size >= 4 &&
      keptTokens.some(
        (k2) =>
          k2.size >= 4 &&
          (jaccard(tk, k2) >= 0.85 ||
            strictSubset(tk, k2) ||
            strictSubset(k2, tk)),
      );
    if (!dup) {
      keep.push(s);
      keptTokens.push(tk);
    }
  }
  steps = keep;
  // ss5: quality gates
  const gatedSteps = [];
  for (const s of steps) {
    const tk = stepTokens(s);
    if (!tk.size) continue; // empty after trim: drop silently
    if (tk.size === 1) {
      const w = [...tk][0];
      if (COOKING_VERB_SET.has(w)) {
        gatedSteps.push(s);
        continue;
      } // "Season." stays
      if (resolve(w)) {
        gatedSteps.push(s);
        continue;
      } // a bare ingredient word stays
      ignored.push(s); // 1-token noise -> ignored
      continue;
    }
    const words = s
      .toLowerCase()
      .replace(/[^a-z'\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
    const marketingHits = words.filter((w) =>
      MARKETING_SET.has(w.replace(/'/g, "'")),
    ).length;
    const hasCookVerb = words.some((w) => COOKING_VERB_SET.has(w));
    const hasIngredient = words.some((w) => resolve(w));
    if (marketingHits >= 2 && !hasCookVerb && !hasIngredient) {
      ignored.push(s);
      continue;
    } // ss5: marketing -> ignored
    gatedSteps.push(s);
  }
  steps = gatedSteps;

  // title resolution: candidate survives only in recipe-shaped pastes
  // P-461 iter 31: markdown emphasis wrappers must not survive into the
  // saved title ("*Aunty's Curry*" -> "Aunty's Curry")
  if (titleCandidate && (ingredients.length || steps.length))
    title = titleCandidate
      .trim()
      .replace(/^[*_~`]+/, "")
      .replace(/[*_~`]+$/, "")
      .trim();
  else if (titleCandidate) queue(titleCandidate, "unparsed_line");
  if (!title)
    title = ingredients.length ? "Untitled recipe" : "Paste a recipe…";
  const total = ingredients.length;
  const matched = ingredients.filter((i) => i.resolvedName).length;
  if (timeMinutes === null && prepCookMinutes > 0)
    timeMinutes = prepCookMinutes; // P-445
  const confidence = confidenceV2(ingredients, unresolved, steps.length, multi);
  // @rule: TITLE-GUARD-V3 (cont.): a queued BLOCKING reason (vague_quantity,
  // unresolved_ingredient, unmeasured) flips reviewRequired even when every
  // ingredient row matched — name-led vague lines ("Some salt", "salt to
  // taste") must block the save so the user resolves them, not vanish.
  const BLOCKING_REVIEW_REASONS = new Set([
    "vague_quantity",
    "unresolved_ingredient",
    "unmeasured",
  ]);
  const hasBlockingQueue = unresolved.some((u) =>
    BLOCKING_REVIEW_REASONS.has(u.reason),
  );
  const reviewRequired =
    total === 0 ||
    matched < total ||
    steps.length === 0 ||
    multi ||
    hasBlockingQueue;
  if (multi)
    queue(
      `(+ more recipes detected in this paste)`,
      "multiple_recipes_detected",
    );

  const seenIds = new Set();
  const serveWithDeduped = serveWith.filter(
    (s) => !seenIds.has(s.resolvedId) && seenIds.add(s.resolvedId),
  );
  return {
    title,
    servings,
    timeMinutes,
    ingredients,
    steps,
    serveWith: serveWithDeduped,
    ovenTempC, // P-437 ss1/ss2 (metadata, informational)
    unresolved,
    ignored,
    confidence,
    reviewRequired,
    meta: { isMultiRecipe: multi, stepTemps },
  };
}

/**
 * P-439 (P-426 DeepSeek findings): deterministic decode-quality score v2.
 * Pure function: 0.0-1.0, monotonic (resolving a line never lowers it).
 * THE LAW: this is ADVICE — reviewRequired is NEVER derived from it.
 *   raw = .50R + .12U + .08S + .08P + .22(1-V) - .20N - .15C - .10M, clamped.
 *   R = resolved/T, U = unit-bearing/T (a bare count IS a line, but not a
 *   measured one), S = min(1, steps/5), P = packaging-note coverage (1 if
 *   no packaging-sensitive lines), V = vague/(T+vague), N = unresolved/T,
 *   C = unresolved-core/core-total, M = unsplit multi-recipe flag.
 */
export const CONF_TIERS = {
  high: { min: 0.9, copy: "High confidence – this parsed cleanly." },
  good: { min: 0.7, copy: "Good – but check the flagged lines." },
  low: { min: 0, copy: "Needs your eyes – review before saving." },
};
export function confBand(score) {
  if (score >= CONF_TIERS.high.min) return "high";
  if (score >= CONF_TIERS.good.min) return "good";
  return "low";
}
const PACKAGING_UNIT_SET = new Set([
  "can",
  "tin",
  "sachet",
  "box",
  "bottle",
  "pack",
  "bunch",
  "punnet",
  "brick",
]);
const NON_CORE_RE =
  /^(?:optional|for garnish|garnish|to serve|for serving|topping|for topping)\b|\bto taste\b/i;
export function confidenceV2(resolvedLines, queue, stepCount, multi) {
  // only RESOLVED lines count toward r/u — an entry with no resolvedId is
  // unresolved burden (it may sit in draft.ingredients pre-resolution)
  const res = resolvedLines.filter((i) => i.resolvedId || i.resolvedName);
  const r = res.length;
  const unres = queue.filter((u) => u.reason === "unresolved_ingredient");
  const n = unres.length;
  const T = r + n;
  if (T === 0) return 0; // no ingredient lines = not a recipe draft
  const u = res.filter((i) => i.unit && i.unit !== "unit").length;
  const packLines = res.filter((i) => PACKAGING_UNIT_SET.has(i.unit));
  const q = packLines.length;
  const p = packLines.filter((i) => i.note).length;
  const v = queue.filter((x) => x.reason === "vague_quantity").length;
  const coreLines = [
    ...res.filter((i) => !NON_CORE_RE.test(i.raw || "")),
    ...unres.filter((x) => !NON_CORE_RE.test(x.line || "")),
  ];
  const K = coreLines.length;
  const c = unres.filter((x) => !NON_CORE_RE.test(x.line || "")).length;
  const R = r / T,
    U = u / T,
    S = Math.min(1, stepCount / 5);
  const P = q === 0 ? 1 : Math.min(1, p / q);
  const V = v / (T + v),
    N = n / T,
    C = K === 0 ? 0 : c / K;
  const raw =
    0.5 * R +
    0.12 * U +
    0.08 * S +
    0.08 * P +
    0.22 * (1 - V) -
    0.2 * N -
    0.15 * C -
    0.1 * (multi ? 1 : 0);
  return Math.max(0, Math.min(1, raw));
}

// serves lines like "Serves 4 people" must not be treated as qty lines; guard helper
function ING_LINE_RE_safe(line) {
  return /^[\d]/.test(line);
}

export function draftToRecipe(draft, { id, tags = [], servings }) {
  if (draft.reviewRequired) throw new Error("Draft needs review before saving");
  // P-446: users edit the draft before saving — their values are UNTRUSTED.
  // Same contract as engine-parsed values, enforced at the gate.
  const title = String(draft.title || "")
    .trim()
    .slice(0, 80);
  if (!title) throw new Error("Recipe needs a title");
  const sv = servings || draft.servings;
  if (
    sv !== null &&
    sv !== undefined &&
    (!Number.isInteger(sv) || sv < 1 || sv > 99)
  ) {
    throw new Error("Servings must be a whole number between 1 and 99");
  }
  const tm = draft.timeMinutes;
  if (
    tm !== null &&
    tm !== undefined &&
    (!Number.isInteger(tm) || tm < 1 || tm > 9999)
  ) {
    throw new Error("Cook time must be a whole number of minutes");
  }
  if (!draft.ingredients.length)
    throw new Error("Recipe needs at least one ingredient");
  for (const [i, ing] of draft.ingredients.entries()) {
    if (!ing.resolvedId) throw new Error(`Ingredient ${i + 1} is unresolved`);
    if (
      typeof ing.qty !== "number" ||
      !Number.isFinite(ing.qty) ||
      ing.qty <= 0
    ) {
      throw new Error(`Ingredient ${i + 1} needs a positive quantity`);
    }
    if (!UNIT_CANON[ing.unit])
      throw new Error(`Ingredient ${i + 1} has an unknown unit`);
  }
  const steps = (draft.steps || [])
    .map((s) => String(s).trim())
    .filter(Boolean);
  if (!steps.length) throw new Error("Recipe needs at least one step");
  return {
    id: id || `decoded-${Date.now()}`,
    title,
    servings: sv || 1,
    time_minutes: tm || null,
    tags: [...new Set(["decoded", ...tags])],
    source: { platform: "decoder-lab", creator: "user import" },
    ingredients: draft.ingredients.map((i) => ({
      id: i.resolvedId,
      qty: i.qty,
      unit: UNIT_CANON[i.unit] === i.unit ? i.unit : UNIT_CANON[i.unit],
    })),
    steps,
    serveWith: draft.serveWith || [],
    ovenTempC: draft.ovenTempC ?? null,
  };
}
