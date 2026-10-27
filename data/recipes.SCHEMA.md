# recipes.json — Schema

The recipe substrate. 40–60 recipes at v1 launch (scaffold ships 12). Recipes are input to the engine — the decision engine is the product (PRD §1).

```jsonc
{
  "version": "semver",
  "last_updated": "YYYY-MM-DD",
  "recipes": [
    {
      "id": "kebab-case-unique",
      "title": "Pap, wors & tomato gravy",
      "servings": 4,                      // baseline; servings slider rescales + re-costs (PRD §7.4)
      "time_minutes": 35,                 // feeds timeBonus + maxTime constraint
      "tags": ["classic", "budget", "braai"],   // matched by dietary constraints; braai feeds badges
      "source": { "platform": "tiktok", "creator": "@handle", "url": "..." },  // credit always
      "ingredients": [
        {
          "id": "maize-meal",            // must exist in ingredients.json
          "qty": 400,
          "unit": "g",                   // g|ml|unit|can|bunch|slice|tsp|tbsp|clove|pinch
          "optional": false,             // optional items are excluded from missingCost (PRD §9.1)
          "note": "for the gravy"        // optional step-note
        }
      ],
      "steps": ["Bring 1 litre of water to the boil...", "..."]
    }
  ]
}
```

Rules:
- NO stored cost fields — per-plate cost is derived from prices.json at runtime so a price update re-costs every recipe instantly (PRD §8).
- Steps are clean text decoded/reviewed via the Decoder Lab (PRD §7.7); never paste raw social captions into `steps`.
- `source` credit is mandatory when a recipe is decoded from a creator (PRD §7.7 review queue).
- Units are the costing contract: costing.js converts tsp/tbsp/slice/clove to gram approximations (documented constants); g/ml/unit/can/bunch map to the price pack directly.
