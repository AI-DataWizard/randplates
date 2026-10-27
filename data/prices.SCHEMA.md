# prices.json — Schema

The moat. Item × store → price per pack basis, with a visible `last_verified` stamp on every entry. Recipe costs derive from this file at runtime (never stored).

```jsonc
{
  "version": "semver",
  "currency": "ZAR",
  "last_verified": "YYYY-MM-DD",        // freshness stamp surfaced in UI (PRD §7.9)
  "stores": ["Shoprite", "Checkers", "Pick n Pay", "Boxer", "spaza (typical)"],
  "entries": [
    {
      "ingredient_id": "maize-meal",     // must exist in ingredients.json
      "store": "Shoprite",
      "price_cents": 3299,               // INTEGER CENTS — R32.99. No floats, ever (PRD rule 3)
      "pack_qty": 2500,
      "pack_unit": "g",                 // matches the ingredient's unit_basis family
      "last_verified": "YYYY-MM-DD"     // per-entry: updated whenever a price is re-checked
    }
  ]
}
```

Rules:
- `price_cents` is integer cents. R173.40 → 17340.
- Cost basis: the priced pack. costing.js converts recipe quantities to packs (e.g. R/2.5 kg → R for 400 g).
- Default price used by the matcher = median across stores for that ingredient (costing.defaultPrice).
- A price with `last_verified` older than 7 days is "stale" — the UI must show the stamp; the maintenance protocol (DATA-MAINTENANCE.md) keeps freshness ≤ 7 days.
- Store-specific toggle (which store's prices to use) is a v2 feature (PRD §16) — v1 uses the median.
