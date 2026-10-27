# ingredients.json — Schema

Canonical ingredient registry. Single source of truth for ingredient identity. ~150 items at v1 launch (scaffold ships a 25-item sample).

```jsonc
{
  "version": "semver",
  "last_updated": "YYYY-MM-DD",
  "items": [
    {
      "id": "kebab-case-unique",          // stable, referenced by prices + recipes + pantry
      "name": "Display name",
      "aliases": ["pap", "mielie meal"],  // vernacular + spelling variants; matched accent-insensitively
      "aisle": "starches",                // starches|proteins|veg|tinned|dairy|spices|other
      "unit_basis": { "qty": 2500, "unit": "g" },  // the pack the price file prices against; g|ml|unit|can|bunch
      "tier": 2,                          // matcher weight per PRD §9.1: protein 3 / staple 2 / veg 1 / garnish 0.5
      "shelf_life_days": 180              // feeds freshness bonus + waste hints
    }
  ]
}
```

Rules:
- `id` is immutable once shipped — recipes, prices and user pantries reference it.
- Aliases must include the most common local vernacular (PRD §7.2: "pap" → maize meal).
- Never delete an ingredient; deprecate with `"deprecated": true` so old pantries keep resolving.
