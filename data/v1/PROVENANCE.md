# PROVENANCE.md — the v1 data moat: how it was built (diligence asset)

This document is the evidence trail for RandPlates' data layer (PRD §4, §12).
Kept for diligence/sellability: every number in the engine traces to a
validated source row, and every pipeline stage is repeatable from the
description below. Raw batch/quarantine files were removed after merge;
this report + the validators in scripts/ are the permanent record.

Final v1 state: 208 ingredients | 1,494 search aliases | 197 verified price
rows (83% coverage) | 179 encoded recipes (153 fully green) | median ~R16.46
per plate (rough). Source tiers: Checkers direct > PnP via Mr D partner
channel > Shoprite direct; in-store till verification is the top tier.

Pipeline (Sep-Oct 2026): registry batches (Meta AI) -> validate-registry;
vernacular aliases (Qwen) + misspellings (Groq) -> validate-aliases; prices
in 14 batches (DeepSeek live research, honest-missing rule) ->
validate-prices (provenance: domain checks, product-path, shared-code,
per-unit spread advisories); recipe shortlists (DeepSeek) + owner curation
(179 survivors, PRD Amendment A3) -> encoding (Meta AI, 18 batches) ->
validate-recipes (zero quarantines).

---
## Registry & aliases report
# RandPlates registry — 2026-10-06 (Meta AI P-104/P-106 run)

175 items in, 175 staged (zero quarantine), all schema-valid per CP-2.
Flagged '?' vernacular aliases awaiting P-105 review: 23.

| aisle | items | with staged price |
|---|---|---|
| dairy | 25 | 10 |
| frozen | 8 | 5 |
| fruit | 7 | 1 |
| pantry | 38 | 18 |
| protein-fresh | 17 | 6 |
| protein-tinned | 25 | 2 |
| spices | 12 | 8 |
| starches | 25 | 5 |
| veg | 18 | 6 |

## P-105 review inputs — 23 flagged aliases

- maize-meal: impuphu?
- samp: isamp?
- sorghum-meal: amabele?
- chicken-livers: isibindi?
- chicken-giblets: amalas?
- frozen-chopped-spinach: frozen morogo?
- eggs: amaqanda?
- onions: uie?
- tomatoes: tamatie?
- potatoes: aartappels?
- sweet-potatoes: bhatata?
- cabbage: khabichi?
- carrots: wortels?
- spinach: imifino?
- green-beans: sugar beans green?
- table-salt: sout?
- curry-powder: rajah mild & spicy?
- turmeric: borrie?
- ground-cinnamon: kaneel?
- instant-coffee: douwe egberts?
- desiccated-coconut: coconut powder?
- soy-sauce: kikkoman soy?
- atchar: achar?

## Price alignment
- 130 distinct priced ingredients from the Oct 5 DeepSeek run
- matched to registry ids: 61
- orphan price ids (need alias fixes or new registry items): all-purpose-flour, apricot-jam, babycorn, baked-beans-in-tomato-sauce, bicarbonate-of-soda-premium, brinjal-eggplant, broccoli, brown-onion-soup-powder, butternut-whole-per-kg, cauliflower, chicken-breast-fillets, chicken-spice, chicken-stock-cubes, chickpeas-400g, cinnamon, cream-style-sweetcorn-410g, cucumber, dark-baking-chocolate, desiccated-coconut-premium, drinking-chocolate, dry-red-lentils, dry-soup-mix, dry-whole-chickpeas, egg-noodles-premium, feta, firm-tofu, fish-fingers-frozen, flavoured-yoghurt-6, fresh-thyme, frozen-margherita-pizza, fruit-squash-concentrate, full-cream-milk, gem-squash, glace-cherries, gouda, green-curry-paste, green-curry-paste-premium, green-peppers-per-kg, hake-fillets-frozen, lamb-stew-pieces, lemons-2, lemons-per-kg, lemons-seedless, lettuce-head-iceberg, long-life-full-cream-milk, mixed-chicken-braai, mozzarella, mushrooms, naan-bread-premium, ox-liver, packet-jelly, pilchards-in-chilli-sauce-400g, processed-cheese-slices-10, pumpkin-whole-per-kg, rooibos-tea-bags, russian-sausages, sardines-in-tomato-sauce, sesame-oil-premium, spinach-marogo, streaky-bacon, sultanas-raisins, sweet-chilli-sauce-premium, tea-bags, tennis-biscuits, teriyaki-marinade, tuna-in-brine-170g, vanilla-essence-premium, watermelon-whole, yeast-spread-marmite-style

## Alias-map alignment (auto-generated)
- 85/130 priced ids now resolve to registry items via `price-id-aliases.json` (name-variant mapping, ids untouched)
- Genuinely unresolved: 45 (apricot-jam, babycorn, brinjal-eggplant, broccoli, butternut-whole-per-kg, cauliflower, chicken-spice, chickpeas-400g, cinnamon, cream-style-sweetcorn-410g, cucumber, drinking-chocolate, dry-red-lentils, dry-whole-chickpeas, egg-noodles-premium, feta, firm-tofu, fish-fingers-frozen, flavoured-yoghurt-6, fresh-thyme, fruit-squash-concentrate, gem-squash, glace-cherries, gouda, lemons-2, lemons-per-kg, lemons-seedless, lettuce-head-iceberg, mixed-chicken-braai, mozzarella, mushrooms, naan-bread-premium, ox-liver, packet-jelly, pumpkin-whole-per-kg, russian-sausages, sesame-oil-premium, spinach-marogo, sultanas-raisins, tennis-biscuits, teriyaki-marinade, tuna-in-brine-170g, vanilla-essence-premium, watermelon-whole, yeast-spread-marmite-style)

## Final state (after batch-8 top-up + curated alias map)
- Registry: **200 items** (175 Meta AI + 25 integration top-up: apricot-jam, babycorn, brinjal, broccoli, cauliflower, chicken-spice, cucumber, drinking-chocolate, dry-red-lentils, firm-tofu, fresh-basil, fresh-thyme, fruit-squash-concentrate, gem-squash, glace-cherries, lettuce, mixed-chicken-braai, mushrooms, ox-liver, pumpkin, russian-sausages, sweetcorn, tennis-biscuits, teriyaki-marinade, yeast-spread)
- Price<->registry join: **130/130 priced ingredients resolve** via exact id + `price-id-aliases.json` (final overrides: all-purpose-flour→cake-flour, chicken-breast-fillets→chicken-breasts, lettuce-head-iceberg→lettuce, rooibos-tea-bags→rooibos)
- REVIEW FLAG: "tea-bags" price rows were mapped to rooibos (ambiguous — Checkers "tea bags" is usually black tea; registry lacks a black-tea item. Decide: add "black-tea" registry item at build time.)


## P-105 vernacular merge — completed 2026-10-07
- Qwen batches 1-5: 1,082 clean terms (batch 5 arrived as markdown table, converted; 1 junk term quarantined).
- Review block: 20 confirms, 1 reject (chicken-giblets 'amalas' -> 'izingingila'), corrections absorbed.
- Merge: 197/200 registry items enriched, +547 net new aliases, registry now 1,425 aliases.
- Merged registry: data/pending/registry-merged.json (build artifact).
- Native-speaker spot-check recommended before alias freeze: data/pending/alias-review-list.md.


## P-110 misspelling merge — 2026-10-07
- Groq (GPT OSS 120B): 135 terms across 9 aisles.
- 32 already covered by existing aliases; 34 attached via edit-distance (deterministic); 10 hand-curated safe attaches; rest parked in misspellings-report.json as a query-expansion dictionary for the search layer (P-111).
- Registry alias total: 1,470 (1,082 Qwen terms merged Oct 7 + 49 typo variants attached or curated).

## P-000c recipe shortlist — 2026-10-07
- DeepSeek returned 60 rows, all with source URLs, 0 flagged 'original needed'.
- URL spot-checks: foodandhome.co.za REAL (Pilchards & Egg Jaffles verified); citizen.co.za 404; iol.co.za ghost article. URL column = unverified reference; treat as unreliable.
- Staged: recipe-shortlist-staged.json (60 rows). OWNER CURATION required next (the playbook's human trust step).


## P-000c curation — 2026-10-07
- Owner cuts: #2 (creamy pap breakfast bowl), #13 (pilchard jaffles). 58 recipes survive.
- Owner feedback: shortlist skewed SA-traditional; everyday general variety missing.
- Resolution: P-000e everyday-variety wave (40 candidates) added to the plan; registry top-up follows its needs-ingredient flags.


## PRD Amendment A2 — 2026-10-07 (owner-approved)
- v1 recipe scope: 40-60 -> ~120-150, full meal-type grid via 3 waves.
- Encoding pulled into October; Phase 5 (Dec) becomes review + polish.
- Quality gates: owner curation per wave, price-coverage gate, deterministic validation, variations never fake density.


## P-000e + P-000f staged — 2026-10-07
- Wave 2 (everyday variety): 40 rows. Wave 3 (breakfast/dessert/snack): 119 rows (36/43/40).
- Total v1 candidate pool: 217 (58 W1 curated + 159 W2/W3 awaiting owner curation).
- Registry-mapping check: 12 rows contain off-registry ingredients; 8 distinct batch-9 candidates:
  ginger (x3), popcorn kernels (x3), salsa, peppermint crisp, peanuts, pumpkin seeds, biltong, crackers.
- Next: owner curation -> batch-9 registry top-up -> price batches for new items -> encoding (P-000d).


## v1 recipe curation FINAL — 2026-10-07 (owner-approved)
- Owner cuts: W3-017 (amasi banana smoothie), W2-37 (maize meal porridge with amasi).
- Dedup sweep: 36 duplicates/variants removed (incl. 6 wave-1 internal dupes caught late: W1-18, W1-28, W1-33, W1-43, W1-47, W1-48).
- FINAL v1 SET: 179 recipes (52 W1 + 35 W2 + 92 W3) -> data/pending/recipes-v1-final.json
- PRD Amendment A3 recorded: v1 recipe count 179 (supersedes A2's ~120-150).
- Batch-9 registry top-up: 8 items added (ginger, popcorn-kernels, salsa, peppermint-crisp, peanuts, pumpkin-seeds, biltong, crackers). Registry: 208 items, 1,494 aliases.
- Next: P-000g price top-up (8 items) + P-000d encoding (18 batches). v1 content closes after both.


## P-000d encoding COMPLETE — 2026-10-07
- 18/18 batches parsed clean; 179/179 recipes staged, ZERO quarantines, ZERO advisories (validate-recipes.mjs added to repo).
- Title cross-check: 179/179 matched curated set (8 trivial rewordings noted, e.g. 'Sardine pasta (Taste.co.za)' -> 'Sardine Pasta').
- Ingredient usage: 139/208 registry ids used; 69 unused (registry also serves pantry/search).
- PRICE GAP DISCOVERED (known-debt made urgent): 50 used ingredients lack staged prices (the September staples quarantine was never re-sourced). 17/179 recipes fully priced today; cooking-oil (85 recipes), eggs (48), tomatoes (40), potatoes (21) lead the gap.
- P-000h re-price prompts issued (3 batches, 50 items). After validation+merge: coverage ~187/208, green recipes ~170+/179.
- Engine swap of recipes.json: queued for build day 1 with test rerun (staged file: data/pending/recipes-encoded-staged.json).


## P-000h processed — 2026-10-07
- 39 rows converted (pack fixes: ice-cream 2L->2000ml, instant-noodles 8x60g->480g, mutton per-kg->1000g basis; bananas dropped - unspecified pack).
- Validator: 30 staged, 9 quarantined (wrong-domain: PnP items priced via mrd.com aggregator + 3 bare-domain URLs; duplicate-url on spices/ham).
- 10 honest-missing rows (garlic, sugar-beans, beef, buttermilk, ginger, polony, instant-pudding, green-chillies, baked-beans-with-sausage, soya-chunks).
- Price DB: 182 rows. FIRST LIGHT: 97/179 recipes fully priced, median R15.71/plate, cheapest R4.48 (cinnamon sugar toast). 45 recipes under R15.
- Outlier for review at build: 'Fish Fingers, Chips and Peas' ~R119/plate (rough count-unit heuristic inflated; costing.js will resolve).
- 20-item final gap run (P-000i) issued with strict retailer-domain rule.


## P-000h CORRECTION — Mr D partner-channel rule — 2026-10-07 (owner context)
- Owner correction: Mr D (mrd.com) is PnP's official delivery partner showing PnP in-store prices; pnp.co.za is blocked to the research tool.
- LIVE VERIFICATION: carrots page confirmed (Pnp Organic Carrots 1kg, "From R12.99" = exact match to DeepSeek's 1299). Bananas page showed R26.99 vs DeepSeek's reported R20.00 + no pack weight -> bananas row stays rejected.
- Validator amended: mrd.com accepted for store=PNP via FULL product pages (/delivery/groceries/products/...); bare mrd.com still rejected. Source-tier model updated: tier 2 PnP = via partner channel.
- Salvage: 6 rows staged (carrots, apples, custard-powder, corn-flour, tinned-lentils, tinned-mackerel-tomato). DB: 188 rows. Green recipes: 123/179.
- Remaining gap: 14 items -> P-000i v2 (partner-aware source rules).
- LESSON: partner channel legitimacy != blanket trust; live spot-checks caught a price mismatch on the same channel. All future price prompts name Mr D explicitly.


## P-000i v2 processed — v1 RESEARCH PHASE CLOSED — 2026-10-07
- 9 rows staged (4 Shoprite-direct: baked-beans-with-sausage, garlic, polony, turmeric; 5 PnP-via-MrD: beef-stewing-pieces, buttermilk, ginger, ham, instant-pudding).
- Live spot-checks: beef page verified ("From R79.99", max-weight 890g charge policy) -> price corrected 8069->7999, pack basis 890g.
- bananas REJECTED twice on evidence: reported R20.00 both runs vs live-verified R26.99 on the same page; pack "variable" unnormalizable. -> in-store list permanently.
- 4 honest-missing (garam-masala, green-chillies, soya-chunks, sugar-beans) -> in-store list.
- FINAL v1 DATA STATE: registry 208 items | 1,494 aliases | 197 verified price rows (173/208 = 83% coverage) | 179 encoded recipes (153 fully green, 26 yellow on 5 remaining items) | rough median R16.46/plate.
- IN-STORE VERIFICATION LIST (build-phase weekly routine, also serves as web-price drift check): capture missing: bananas (weighted pack), sugar-beans, garam-masala, green-chillies, soya-chunks. Drift-check: maize meal, cooking oil, eggs, potatoes, tomatoes, fresh milk, whole chicken.
- RESEARCH COMPLETE. Remaining: owner recipe spot-read, in-store pass, native-speaker alias review, owner checklist (P-001..P-004), then Nov 2 build opens with P-101.


---
## Price coverage report
# RandPlates price coverage — 2026-10-05 dataset

Source: 10 DeepSeek research batches (Oct 5 run, hardened provenance rules).
Validation: scripts/validate-prices.mjs (deterministic). Tier: all staged rows 'estimated'.

| batch | category | ingredients | with staged price | coverage |
|---|---|---|---|---|
| 1 | core staples & carbs | 20 | 10 | 50% |
| 2 | meat & poultry | 20 | 13 | 65% |
| 3 | fish, tinned & meatless | 20 | 14 | 70% |
| 4 | fresh vegetables | 20 | 14 | 70% |
| 5 | fruit, salad & herbs | 17 | 8 | 47% |
| 6 | dairy & chilled | 20 | 15 | 75% |
| 7 | baking & desserts | 23 | 10 | 43% |
| 8 | international aisle | 25 | 16 | 64% |
| 9 | spices & condiments | 20 | 17 | 85% |
| 10 | frozen, bakery & sweet | 18 | 13 | 72% |

**True coverage (normalized ids): 130/203 ingredients (64%) with at least one provenance-clean price row (145 rows total).**

## Gap list — 73 ingredients with zero staged prices (in-store verification candidates)

- amasi-maas
- bamboo-shoots
- bananas
- barbecue-braai-spice
- basmati-rice
- beef-stewing-chunks
- beetroot
- bicarbonate-of-soda
- bread-rolls
- butter-beans-in-tomato-sauce-400g
- buttermilk
- carrots
- celery
- chicken-giblets
- chicken-livers
- chocolate-chips
- cocoa-powder
- condensed-milk
- cooking-oil
- corn-flour
- crackers
- custard-powder
- desiccated-coconut
- dry-sugar-beans
- egg-noodles
- eggs
- food-colouring
- fresh-basil
- fresh-ginger
- fresh-mint
- fresh-parsley
- garam-masala
- garlic-bulb
- ginger-garlic-paste
- golden-syrup
- green-chillies
- green-mealies
- halloumi
- ham-off-the-bone
- honey
- instant-noodles
- instant-pudding
- instant-soya-mince
- kidney-beans-in-curry-sauce-410g
- lettuce-head-butter
- lettuce-head-cos
- macaroni
- mackerel-in-tomato-sauce
- maize-meal
- mango
- marie-biscuits
- mixed-fruit-peel
- naan-bread
- pawpaw
- peri-peri-sauce
- polony
- poppadums
- potatoes
- rice-noodles
- rusks
- salted-peanuts
- samp-and-beans
- self-raising-flour
- sour-cream
- sriracha-hot-sauce
- sweet-biscuits
- taco-shells
- tomatoes
- turmeric
- vanilla-essence
- vanilla-ice-cream
- vienna-sausages
- whole-chicken

## Advisories (passed provenance; pack-math flagged for review)
- green-peppers: Shoprite 500g punnet R34.99 vs Woolworths row with qty=1 unit — unit normalization ambiguity; verify pack basis.
- paprika / ground-coriander: 2.7x-3.2x per-unit spread across staged stores — plausible premium-vs-mainstream, but check pack sizes.

## Known data-quality notes
- Some ingredient ids embed pack sizes (carrots-1kg, halloumi-250g, amasi-maas-1l). Normalized here; registry aliases (P-104/P-106) will absorb them — a canonical-id clause has been added to the batch prompts.
- ~40 rows are honest nulls (item not found live); ~70 rows failed provenance (wrong domain, homepage URLs, shared product codes).
- All staged rows remain tier 'estimated' — promotion to 'verified' happens only via human spot-check.

## P-000g top-up — 2026-10-07
- Batch 11 staged: 7 rows (popcorn-kernels, salsa, peppermint-crisp, peanuts, pumpkin-seeds, biltong, crackers). All Checkers, source estimated, last_verified 2026-10-07.
- ginger: honestly reported missing by the model -> no row; shows explorer pricing until caught in-store. Added to the in-store verification list (now 8 items: maize meal, cooking oil, eggs, potatoes, tomatoes, whole chicken, milk, ginger).
- URL spot-checks: popcorn + crackers pages verified live; crackers price R19.99 matches price_cents exactly.
- Validator bug fixed: /p/<code> Checkers product paths now accepted (was quarantining valid rows).
- Price DB: 152 rows | 137/208 ingredients priced (65%).
