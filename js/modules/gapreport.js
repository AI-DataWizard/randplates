// gapreport.js — P-441 REGISTRY GAP REPORT (P-428 DeepSeek findings, absorbed Oct 21).
// The review queue becomes a RESEARCH QUEUE: every item the decoder cannot
// resolve is logged, head-noun extracted, classified against the registry,
// scored and tiered — a ranked list of what the ingredient registry and price
// table are missing.
//
// DOCTRINE (governs every function): the report PROPOSES, the owner VERIFIES.
// Nothing here writes to the registry or price table. Every output is a card.
//
// PURE MODULE: no DOM, no fetch, no IndexedDB, no Date, no locale APIs.
// Timestamps are passed in by the caller for expiry ONLY — they never enter
// a score. Same inputs → same report, byte-identical, always.

// ---------------------------------------------------------------- sets ----

// Step 0 normalization is applied to raw lines AND registry names/aliases.
export function normalizeText(s) {
  return String(s ?? "")
    .split(",")[0]
    .split(";")[0]
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // é → e
    .replace(
      /[\u00bd\u00bc\u00be\u2153\u2154\u215b]/g,
      (m) =>
        ({
          "\u00bd": "0.5",
          "\u00bc": "0.25",
          "\u00be": "0.75",
          "\u2153": "0.333",
          "\u2154": "0.667",
          "\u215b": "0.125",
        })[m],
    )
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u200b-\u200f\ufeff]/g, "")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/#[\w-]+/g, " ")
    .replace(/@[\w.-]+/g, " ")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u2B00-\u2BFF}]/gu, " ")
    .toLowerCase()
    .replace(/[,;\u2013\u2014]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const NUM_WORDS = String.raw`(?:\d+(?:[.,]\d+)?|\d+\s*\/\s*\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|half|quarter)`;
const LEAD_QTY = new RegExp(
  `^\\s*${NUM_WORDS}(?:\\s*(?:-|to)\\s*${NUM_WORDS})?\\s*`,
  "i",
);

// Whole-token units, longest-first (step 2)
const UNIT_SET = [
  "tablespoons",
  "tablespoon",
  "tbsp",
  "teaspoons",
  "teaspoon",
  "tsp",
  "handfuls",
  "handful",
  "punnets",
  "punnet",
  "packets",
  "packet",
  "sachets",
  "sachet",
  "bunches",
  "bunch",
  "slices",
  "slice",
  "cloves",
  "clove",
  "sprigs",
  "sprig",
  "sticks",
  "stick",
  "pieces",
  "piece",
  "heads",
  "head",
  "pinches",
  "pinch",
  "dashes",
  "dash",
  "bottles",
  "bottle",
  "boxes",
  "box",
  "tubs",
  "tub",
  "kilogram",
  "kgs",
  "litres",
  "liters",
  "grams",
  "gram",
  "litre",
  "liter",
  "packets",
  "pkts",
  "pkt",
  "cups",
  "cup",
  "mugs",
  "mug",
  "tins",
  "tin",
  "cans",
  "can",
  "kgs",
  "kg",
  "g",
  "ml",
  "l",
  "knoppie",
  "mespunt",
  "knob",
  "whole",
  "x",
];

const FILLER = new Set([
  "a",
  "an",
  "the",
  "some",
  "of",
  "about",
  "roughly",
  "plus",
  "extra",
  "for",
  "to",
  "with",
  "and",
  "or",
  "optional",
  "to-taste",
  "taste",
  "good",
  "nice",
  "lovely",
  "little",
  "bit",
  "lot",
  "few",
  "that",
  "this",
  "those",
  "lekker",
]);

// Step 5 — SA grocery brands, longest token-sequence first
const BRAND_LIST = [
  "crosse & blackwell",
  "white star",
  "lucky star",
  "blue ribbon",
  "golden cloud",
  "wellingtons",
  "futurelife",
  "snowflake",
  "black cat",
  "all gold",
  "niknaks",
  "bokomo",
  "jungle",
  "huletts",
  "selati",
  "sasko",
  "tastic",
  "bisto",
  "knorr",
  "royco",
  "maggi",
  "nandos",
  "imbo",
  "rhodes",
  "koo",
  "oxo",
  "oros",
  "i&j",
].map((b) => b.replace(/['.]/g, ""));

const PLURAL_EXCEPT = new Set([
  "couscous",
  "hummus",
  "asparagus",
  "molasses",
  "oats",
  "grits",
  "greens",
  "means",
  "series",
  "species",
]);

export const STOP_SET = new Set([
  "it",
  "them",
  "they",
  "stuff",
  "things",
  "thing",
  "etc",
  "more",
  "less",
  "same",
  "other",
  "rest",
  "whatever",
]);

export const GENERIC_HEAD_SET = new Set([
  "meal",
  "flour",
  "oil",
  "spice",
  "mix",
  "powder",
  "sauce",
  "soup",
  "stock",
  "water",
  "salt",
  "sugar",
  "rice",
  "bread",
  "milk",
  "butter",
  "cheese",
  "chicken",
  "beef",
  "mince",
  "gravy",
  "marinade",
  "dressing",
]);

// Step 8 — single-token vernacular fold, whole-word, applied once
export const SA_LEXICON = {
  botter: "butter",
  kaas: "cheese",
  melk: "milk",
  suiker: "sugar",
  sout: "salt",
  meel: "flour",
  rys: "rice",
  aartappel: "potato",
  ui: "onion",
  tamatie: "tomato",
  knoffel: "garlic",
  hoender: "chicken",
  beesvleis: "beef",
  brood: "bread",
  eier: "egg",
  olie: "oil",
  asyn: "vinegar",
  peper: "pepper",
  mielie: "maize",
  boontjie: "bean",
  spinasie: "spinach",
  wortel: "carrot",
  pampoen: "pumpkin",
  kool: "cabbage",
  piesang: "banana",
  lemoen: "orange",
  appels: "apple",
};

const MARKETING_RE =
  /\b(promo|special|now only|save r\s?\d|buy \d+ get|% off|valid until|while stocks|limited|combo|bundle|free|deal|hurry|only r)\b/;
const SERVING_RE =
  /\b(serve with|serving suggestion|best enjoyed|great with|perfect with|pair with|goes well)\b/;

// ------------------------------------------------- head-noun extraction ----

function pluralFold(tok) {
  if (PLURAL_EXCEPT.has(tok) || tok.length < 3) return tok;
  // Engine-truth ruling (the findings' own pair 4 requires it): "-ies" nouns
  // built on "-ie" stems fold by dropping the s (walkies → walkie, brownies →
  // brownie); regular "-ies" → "-y" (cherries → cherry).
  if (/kies$/.test(tok) && tok.length >= 5) return tok.replace(/ies$/, "ie");
  if (/ies$/.test(tok) && tok.length >= 5) return tok.replace(/ies$/, "y");
  if (/(s|x|z|ch|sh)es$/.test(tok)) return tok.replace(/es$/, "");
  if (/[^s]s$/.test(tok) && !/(ss|us|is)$/.test(tok))
    return tok.replace(/s$/, "");
  return tok;
}

/**
 * Reduce a raw unresolved line to its candidate ingredient term.
 * Pure; returns { candidate, brandOnly, viaLexicon }. Empty candidate = the
 * line yielded nothing researchable.
 */
export function extractCandidate(rawLine) {
  let s = normalizeText(rawLine).slice(0, 240);
  if (!s)
    return {
      candidate: "",
      brandOnly: false,
      viaLexicon: false,
      lexiconFrom: null,
    };

  // Step 1 — leading quantity: numeric/word passes, then an ARTICLE pass.
  // Engine-truth rulings: (a) "a|an" strips ONLY as a standalone token —
  // "amadumbe" keeps its 'a' (RGR4), "a handful of" loses it; (b) only digits
  // strip twice, so "all gold" never becomes "ll gold".
  s = s.replace(LEAD_QTY, "").trim();
  s = s.replace(/^\s*(?:\d+(?:[.,]\d+)?|\d+\s*\/\s*\d+)\s*/i, "").trim();
  s = s.replace(/^\s*(?:a|an)\s+/i, "").trim();
  // Step 2 — leading unit, up to 2×, only if a ≥3-char remainder survives
  for (let i = 0; i < 2; i++) {
    const toks = s.split(" ");
    if (
      toks.length > 1 &&
      UNIT_SET.includes(toks[0]) &&
      toks.slice(1).join(" ").trim().length >= 3
    ) {
      s = toks.slice(1).join(" ").trim();
    }
  }
  // Step 3 — packaging parentheticals ("(400 g tin)", "2 x 400 g")
  s = s
    .replace(/\s*\([^)]*\d+\s*(?:g|kg|ml|l)\b[^)]*\)\s*/gi, " ")
    .replace(/\b\d+\s*x\s*\d+\s*(?:g|kg|ml|l)\b/gi, " ");
  // Step 4 — leading filler loop
  let toks = s.split(" ").filter(Boolean);
  while (toks.length && FILLER.has(toks[0])) toks.shift();
  s = toks.join(" ");

  // Step 5 — brand suffix rule (longest sequence anywhere in the candidate)
  let brandOnly = false;
  for (const brand of BRAND_LIST) {
    const re = new RegExp(`(^|\\s)${brand.replace(/[&]/g, "\\&")}(\\s|$)`);
    const m = s.match(re);
    if (m) {
      const before = s.slice(0, m.index).trim();
      const after = s.slice(m.index + m[0].length).trim();
      const remainder = `${before} ${after}`.replace(/\s+/g, " ").trim();
      if (remainder.length >= 3) s = remainder;
      else {
        s = brand;
        brandOnly = true;
      }
      break;
    }
  }

  // Step 5b — trailing prep descriptors leave the head noun
  // ("walkie talkies cleaned" → "walkie talkie"; engine-truth ruling — the
  // findings' pair 4 and test RGR2 both require it).
  toks = s.split(" ").filter(Boolean);
  const DESCRIPTORS = new Set([
    "cleaned",
    "chopped",
    "diced",
    "sliced",
    "peeled",
    "washed",
    "cooked",
    "cubed",
    "grated",
    "minced",
    "deboned",
    "de-boned",
    "fresh",
    "ripe",
    "raw",
    "finely",
  ]);
  while (toks.length > 1 && DESCRIPTORS.has(toks[toks.length - 1])) toks.pop();

  // Step 5c — trailing pack word leaves the head noun ("3 All Gold tomato
  // sauce sachets" → "tomato sauce"; engine-truth ruling — pair 6 requires it).
  while (toks.length > 1 && UNIT_SET.includes(toks[toks.length - 1]))
    toks.pop();

  // Step 6 — plural-fold final token, strip possessive
  s = toks.join(" ");
  toks = s.split(" ").filter(Boolean);
  if (toks.length && /'s$/.test(toks[toks.length - 1]))
    toks[toks.length - 1] = toks[toks.length - 1].replace(/'s$/, "");
  if (toks.length && !brandOnly)
    toks[toks.length - 1] = pluralFold(toks[toks.length - 1]);
  s = toks.join(" ");

  // Step 7 — reject
  const single = toks.length === 1 ? toks[0] : null;
  if (
    !s ||
    s.length < 3 ||
    (single && STOP_SET.has(single)) ||
    STOP_SET.has(s)
  ) {
    return {
      candidate: "",
      brandOnly: false,
      viaLexicon: false,
      lexiconFrom: null,
    };
  }

  // Step 8 — SA lexicon, whole-token, applied once
  let viaLexicon = false;
  let lexiconFrom = null;
  if (toks.length === 1 && SA_LEXICON[toks[0]]) {
    lexiconFrom = toks[0];
    toks[0] = SA_LEXICON[toks[0]];
    viaLexicon = true;
    s = toks.join(" ");
  }

  // Step 9 — collapse + trim trailing punctuation
  s = s
    .replace(/[\s.,;:!?]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s || s.length < 3 || STOP_SET.has(s))
    return {
      candidate: "",
      brandOnly: false,
      viaLexicon: false,
      lexiconFrom: null,
    };
  return { candidate: s, brandOnly, viaLexicon, lexiconFrom };
}

// -------------------------------------------------------- classification ----

const normalizeTokens = (s) =>
  normalizeText(s).split(" ").filter(Boolean).map(pluralFold);
const normalizeName = (s) => {
  let t = normalizeTokens(s);
  let out = t.join(" ");
  for (const brand of BRAND_LIST) {
    const re = new RegExp(`(^|\\s)${brand.replace(/[&]/g, "\\&")}(\\s|$)`);
    const m = out.match(re);
    if (m) {
      const remainder =
        `${out.slice(0, m.index)} ${out.slice(m.index + m[0].length)}`
          .replace(/\s+/g, " ")
          .trim();
      if (remainder.length >= 3) out = remainder;
      break;
    }
  }
  return out;
};

/**
 * Classify one aggregated group against the registry.
 * registry: [{ id, name, aliases: [], priced: bool }]
 * Pure function of (candidate, registry, group facts) — nothing else.
 */
export function classifyGap(
  { candidate, brandOnly, outcome, resolvedId, viaLexicon },
  registry,
) {
  const regs = registry.map((r) => ({
    id: r.id,
    name: normalizeName(r.name),
    aliases: (r.aliases || []).map(normalizeName),
    priced: !!r.priced,
  }));

  // 3.0 step 1 — registry resolution first.
  // ADJUDICATION (the findings' RGR5 and RGR10 conflict with a literal reading
  // of 3.0.1, which would CLOSE both): an exact resolution reached through the
  // PICKER (the user found the item the decoder missed) or through the SA
  // LEXICON (the vernacular word is not in the alias table) is an ALIAS gap —
  // the registry KNOWS the item; only the alias is missing. CLOSED is reserved
  // for records whose term resolves exactly with neither of those signals,
  // i.e. the registry genuinely moved on since the record was logged.
  const exact = regs.find(
    (r) => r.name === candidate || r.aliases.includes(candidate),
  );
  if (exact) {
    if (!exact.priced)
      return {
        category: "MISSING_PRICE",
        autoAccept: false,
        ambiguous: false,
        matches: [exact.id],
      };
    if (viaLexicon)
      return {
        category: "MISSING_ALIAS",
        autoAccept: true,
        ambiguous: false,
        matches: [exact.id],
        via: "lexicon",
      };
    if (resolvedId && resolvedId === exact.id) {
      return {
        category: "MISSING_ALIAS",
        autoAccept: true,
        ambiguous: false,
        matches: [exact.id],
        via: "picker",
      };
    }
    return {
      category: "CLOSED",
      autoAccept: false,
      ambiguous: false,
      matches: [],
    };
  }

  // 3.0 step 2 — resolvedId present
  if (resolvedId) {
    const item = regs.find((r) => r.id === resolvedId);
    if (item)
      return item.priced
        ? {
            category: "MISSING_ALIAS",
            autoAccept: true,
            ambiguous: false,
            matches: [item.id],
            via: "picker",
          }
        : {
            category: "MISSING_PRICE",
            autoAccept: false,
            ambiguous: false,
            matches: [item.id],
          };
  }

  // 3.0 step 3 — NOISE guard (a real food word is never noise; checked before
  // MISSING_INGREDIENT but after resolution)
  // (generic-head / marketing / brand-only / drops are group facts — the
  //  marketing+stop checks that are pure per-candidate live here)
  if (!candidate)
    return {
      category: "NOISE",
      autoAccept: false,
      ambiguous: false,
      matches: [],
    };
  if (MARKETING_RE.test(candidate) || SERVING_RE.test(candidate)) {
    return {
      category: "NOISE",
      autoAccept: false,
      ambiguous: false,
      matches: [],
    };
  }
  const singleTok = !candidate.includes(" ");
  if (singleTok && (candidate.length < 5 || GENERIC_HEAD_SET.has(candidate))) {
    return {
      category: "NOISE",
      autoAccept: false,
      ambiguous: false,
      matches: [],
    };
  }

  // 3.0 step 4 — containment match
  const candTokens = candidate.split(" ");
  const raw = [];
  for (const r of regs) {
    for (const alias of [r.name, ...r.aliases]) {
      if (!alias) continue;
      const aToks = alias.split(" ").filter(Boolean);
      const shortSide = Math.min(candTokens.length, aToks.length);
      const shortChars = Math.min(candidate.length, alias.length);
      if (shortChars < 3 && shortSide < 2) continue;
      const sub =
        aToks.every((t) => candTokens.includes(t)) ||
        candTokens.every((t) => aToks.includes(t));
      if (sub)
        raw.push({
          id: r.id,
          alias,
          finalTok: aToks[aToks.length - 1],
          priced: r.priced,
        });
    }
  }
  if (!raw.length)
    return {
      category: "MISSING_INGREDIENT",
      autoAccept: false,
      ambiguous: false,
      matches: [],
    };
  // 3.1(a) — head-final filter: keep matches sharing the candidate's final
  // token; if none do, keep all matches
  const candFinal = candTokens[candTokens.length - 1];
  const head = raw.filter((m) => m.finalTok === candFinal);
  const kept = head.length ? head : raw;
  const uniq = [...new Map(kept.map((m) => [m.id, m])).values()];
  if (uniq.length === 1) {
    return uniq[0].priced
      ? {
          category: "MISSING_ALIAS",
          autoAccept: true,
          ambiguous: false,
          matches: [uniq[0].id],
          via: viaLexicon ? "lexicon" : "token",
        }
      : {
          category: "MISSING_PRICE",
          autoAccept: false,
          ambiguous: false,
          matches: [uniq[0].id],
        };
  }
  return {
    category: "MISSING_ALIAS",
    autoAccept: false,
    ambiguous: true,
    matches: uniq.map((m) => m.id),
  };
}

// --------------------------------------------------------------- scoring ----

const BASE = {
  MISSING_INGREDIENT: 300,
  MISSING_ALIAS: 200,
  MISSING_PRICE: 100,
};
const SESSION_W = 120,
  SESSION_CAP = 25;
const HIT_W = 40,
  HIT_CAP = 60;
const PICK_W = 90,
  PICK_CAP = 10;
const ALIAS_PICK_W = 25,
  ALIAS_PICK_CAP = 10;
const AMBIGUITY_PENALTY = 150;
const CATEGORY_RANK = {
  MISSING_INGREDIENT: 3,
  MISSING_ALIAS: 2,
  MISSING_PRICE: 1,
};

export function scoreGroup(g) {
  if (g.category === "NOISE" || g.category === "CLOSED") return null;
  const s =
    BASE[g.category] +
    SESSION_W * Math.min(g.sessions, SESSION_CAP) +
    HIT_W * Math.min(Math.max(g.hits - g.sessions, 0), HIT_CAP) +
    PICK_W * Math.min(g.picks, PICK_CAP) +
    ALIAS_PICK_W * Math.min(g.resolvedPicks, ALIAS_PICK_CAP) -
    (g.ambiguous ? AMBIGUITY_PENALTY : 0);
  return Math.max(0, s);
}

const codeUnitCmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Build the full report. records: gap_log rows (candidate may be precomputed
 * at log time via extractCandidate; recomputed if absent). registry as in
 * classifyGap. opts.now (epoch ms) enables expiry (180d scored / 90d noise);
 * omit it to disable expiry. Pure for constant opts.
 */
export function buildReport(records, registry, opts = {}) {
  const now = opts.now ?? null;
  const live = records.filter((r) => {
    if (now === null || !r.loggedAt) return true;
    const ageDays = (now - r.loggedAt) / 86400000;
    return ageDays <= 180;
  });

  // group by normalized candidate
  const groups = new Map();
  for (const r of live) {
    let ex =
      r.candidate !== undefined && r.candidate !== null && r.candidate !== ""
        ? {
            candidate: r.candidate,
            brandOnly: !!r.brandOnly,
            viaLexicon: !!r.viaLexicon,
            lexiconFrom: r.lexiconFrom || null,
          }
        : extractCandidate(r.rawLine || "");
    // engine-truth ruling (RGR7): a record the user RESOLVED belongs to the
    // resolved item's group — the picker pick, not the raw phrasing, is the
    // identity ("samp and beans" → resolvedId samp → group "samp").
    let key = ex.candidate || "(none)";
    if (r.resolvedId) {
      const item = registry.find((x) => x.id === r.resolvedId);
      if (item) {
        key = normalizeName(item.name);
        ex = { ...ex, candidate: key };
      }
    }
    if (!groups.has(key))
      groups.set(key, {
        candidate: ex.candidate,
        brandOnly: ex.brandOnly,
        viaLexicon: ex.viaLexicon,
        lexiconFrom: ex.lexiconFrom || null,
        hits: 0,
        sessions: new Set(),
        picks: 0,
        resolvedPicks: 0,
        drops: 0,
        resolvedId: null,
        outcome: null,
      });
    const g = groups.get(key);
    if (r.outcome === "dropped_by_user") {
      g.drops++;
      continue;
    }
    g.hits++;
    if (r.sessionId) g.sessions.add(r.sessionId);
    if (r.outcome === "unresolved_after_pick") g.picks++;
    if (r.outcome === "resolved_by_picker") {
      g.resolvedPicks++;
      g.resolvedId = r.resolvedId || g.resolvedId;
    }
    if (r.outcome) g.outcome = r.outcome;
  }

  const noise = [];
  const cards = [];
  let closedCount = 0;
  for (const g of groups.values()) {
    g.sessions = g.sessions.size;
    const cls = classifyGap(
      {
        candidate: g.candidate,
        brandOnly: g.brandOnly,
        outcome: g.outcome,
        resolvedId: g.resolvedId,
        viaLexicon: g.viaLexicon,
      },
      registry,
    );
    g.category = cls.category;
    g.ambiguous = cls.ambiguous;
    g.autoAccept = cls.autoAccept;
    g.matches = cls.matches || [];
    g.via = cls.via || null;
    if (cls.category === "NOISE" || g.drops >= g.hits) {
      noise.push(g);
      continue;
    }
    if (cls.category === "CLOSED") {
      closedCount++;
      continue;
    }
    g.score = scoreGroup(g);
    cards.push(g);
  }

  // 3.3 — synthetic price scan: every unpriced registry item is surfaced even
  // at zero demand (MISSING_PRICE floor keeps them all in TIER NEXT)
  for (const r of registry) {
    if (r.priced) continue;
    const key = normalizeName(r.name);
    if (
      cards.some(
        (c) => c.category === "MISSING_PRICE" && c.matches.includes(r.id),
      )
    )
      continue;
    if (cards.some((c) => c.candidate === key)) continue;
    const g = {
      candidate: key,
      brandOnly: false,
      viaLexicon: false,
      hits: 0,
      sessions: 0,
      picks: 0,
      resolvedPicks: 0,
      drops: 0,
      resolvedId: null,
      outcome: null,
      category: "MISSING_PRICE",
      ambiguous: false,
      autoAccept: false,
      matches: [r.id],
      via: null,
      score: BASE.MISSING_PRICE,
    };
    cards.push(g);
  }

  // 4.2 — deterministic sort: score desc, category rank desc, code-unit asc
  cards.sort(
    (a, b) =>
      b.score - a.score ||
      CATEGORY_RANK[b.category] - CATEGORY_RANK[a.category] ||
      codeUnitCmp(a.candidate, b.candidate),
  );

  // 5 — tiers (NOW capped at 20; overflow rolls into NEXT)
  const NOW_CAP = 20;
  let nowCount = 0;
  for (const c of cards) {
    if (c.score >= 900 && !c.ambiguous && c.category !== "MISSING_PRICE") {
      if (nowCount < NOW_CAP) {
        c.tier = "NOW";
        nowCount++;
        continue;
      }
      c.tier = "NEXT";
      c.tierNote = "till list full — these move up next week";
      continue;
    }
    c.tier =
      c.score >= 300 || c.category === "MISSING_PRICE" ? "NEXT" : "WATCH";
  }

  return { cards, noise: noise.length, closedCount };
}

// ------------------------------------------------------ dismissal (P-454) ----

/**
 * Apply the owner's handled/dismissed keys to report cards.
 * Unambiguous cards dismiss by candidate; AMBIGUOUS cards dismiss by
 * `candidate::matchId` — one suggestion handled never kills the others,
 * and the card survives until every suggestion is verified.
 * Pure: same report + same keys → same result.
 */
export function applyHandled(cards, handled) {
  const done = new Set(handled || []);
  const out = [];
  for (const c of cards) {
    if (c.ambiguous && Array.isArray(c.matches) && c.matches.length) {
      const rest = {
        ...c,
        matches: c.matches.filter((m) => !done.has(`${c.candidate}::${m}`)),
      };
      if (rest.matches.length) out.push(rest);
    } else if (!done.has(c.candidate)) {
      out.push(c);
    }
  }
  return out;
}
