# DATA-MAINTENANCE.md — weekly price protocol (the moat's upkeep)

**Standing cost:** ~2h/week after launch. The price file is the defensible asset (PRD §4/§12); a stale file is trust collapse (PRD §15, risk 1).

## Current status: SCAFFOLD

All prices in `prices.json` are **placeholder typicals, NOT verified receipts**. Before any public launch:

1. Replace every entry with real captured prices (Phase 0 — capture receipts Oct/Nov 2026).
2. Update each entry's `last_verified` to the actual capture date.
3. Bump `prices.json` version to 1.0.0 and `last_verified` at the top level.

## Weekly protocol (post-launch)

| Day | Task |
|---|---|
| Fri/Sat | Visit 1-2 stores (rotate Shoprite/Checkers/PnP/Boxer weekly); photograph shelf prices for tracked items |
| Sun (30 min) | Transcribe into prices.json: update `price_cents`, set that entry's `last_verified` to today |
| Sun (15 min) | Spot-check: run `tests/tests.html` (algorithm suite must stay green); sanity-check 3 recipes' per-plate costs moved in the right direction |
| Sun (15 min) | Commit + push. The "last verified" stamp in the app UI updates automatically |

## Rules

- One entry change per line = easy git diff review.
- Prices are **integer cents**. R32.99 → 3299. No exceptions.
- If an item is unavailable at a store, delete that store's entry for the week (don't leave stale).
- Median-across-stores is the matcher's default price — adding a store entry can shift costs, so note big changes in the commit message.
- Track ~60 staples at launch (the ones recipes depend on most); grow by demand.
