# RandPlates

> Tell us your kitchen. We'll tell you dinner.

**Live at [randplates.co.za](https://randplates.co.za)** — free, no accounts, works offline.

RandPlates plans a week of dinners around what's already in your kitchen and what it actually costs on South African shelves. You fill a pantry, set a weekly budget, and the engine matches 437 recipes to your ingredients, prices every plate in rands, and prints a shopping list styled like a real till slip — the pack sizes, brands and prices come from real grocery research (Checkers, Pick n Pay via Mr D, Shoprite), not guesses.

Built in South Africa, in public, by [Tadiwanashe Chopamba](https://www.linkedin.com/in/tadiwanashe-chopamba-9b80b5289/).

## What makes it different

- **Real prices, honestly sourced.** 507 priced grocery rows; each one is either _verified_ against a live store page or flagged as an _estimate_. Nothing silently pretends to be accurate — every price row shows its source and the date it was checked.
- **Offline-first.** A service worker ships the whole app to your phone on first visit. After that it works in airplane mode — pantry, matcher, planner, cook log, even the PDF export.
- **Zero dependencies.** No frameworks, no build step, no npm, no tracking scripts. Vanilla ES modules, integer-cent money math, and a ~525 KB (gzipped) install.
- **Your data stays yours.** No accounts, no servers holding your data. Pantry, cook log and plans live in IndexedDB on your device, and export/backup is one tap in Settings.
- **Proudly local.** 1,500+ vernacular search aliases (isiZulu, isiXhosa, Sesotho, Setswana, Afrikaans, street names), mogodu and morogo alongside macaroni, prices in rands and cents.

## Run it locally

```bash
git clone <this repo>
cd randplates
python3 -m http.server 8899
# → http://localhost:8899
```

No build step. ES modules need the http server — opening `index.html` via `file://` won't work. On first load the app registers the service worker (on `127.0.0.1`/`localhost` it stays off, for dev sanity — use `127.0.0.2` if you want to test the offline install locally).

## What's in this repo

```
index.html, prices.html     the two screens of record (app + public price explorer)
manifest.json, sw.js       PWA install + offline service worker
robots.txt, sitemap.xml    crawl directives
CNAME, .nojekyll           GitHub Pages wiring (custom domain, no Jekyll)
css/                       tokens, layout, views, 12 theme identities, self-hosted fonts
js/                        main.js + 19 pure-ish modules (engines are DOM-free) + worker
assets/                    icons, fonts, social card image
data/                      ingredients.json, prices.json, recipes.json (the whole corpus ships)
```

The engines are deliberately pure: `matcher`, `costing`, `planner` and `decoder` take data in as arguments and return results — no DOM, no fetch, no IndexedDB inside them. All money is integer cents end to end; formatting to `R12.50` happens only at render, so no float ever touches a price.

## Data honesty

The data freeze (v1.0.0) carries 437 recipes, 499 ingredients and 507 priced rows — 380 verified against live store pages, 126 honest estimates, one free item (tap water). Estimated rows are excluded from nothing but marked everywhere they appear; verified rows carry a check date. Prices move; the plan is weekly spot-checks of the cost-driving staples, and the in-app explorer shows each row's age so nothing stale hides.

## License

Copyright 2026 Tadiwanashe Chopamba. The app, its code and its data corpus are shared here for review and reuse with attribution. The recipe corpus was written for this project (no scraped content), and the price data reflects public retail shelf prices at capture time.
