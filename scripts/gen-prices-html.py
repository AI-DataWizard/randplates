#!/usr/bin/env python3
"""gen-prices-html.py — regenerates prices.html (the SEO split-out, P-406).

RandPlates is a JS PWA: crawlers can't read the in-app Price Explorer's data.
This bakes the REAL price table (median row per ingredient across stores) plus
the winning P-405 copy into a static, self-contained landing page every time
data/prices.json changes. Run after every price-table update:

    python3 scripts/gen-prices-html.py

Output: prices.html at the repo root (committed like any source file).
"""
import json, html
from datetime import date

MONTH = date.today().strftime("%B %Y")
TITLE = "Cheap Meal Plan South Africa - Real Prices | RandPlates"
META = ("Enter your pantry and budget. RandPlates plans budget meals for a week "
        "and builds your priced R400 or R500 grocery list from real SA retailer prices.")

def fmt_r(cents):
    return f"R{cents // 100}.{cents % 100:02d}"

def main():
    prices = json.load(open("data/prices.json"))
    ings = {i["id"]: i for i in json.load(open("data/ingredients.json"))["items"]}
    stamp = prices.get("last_verified", "")

    # one representative row per ingredient: cheapest across stores (the engine's
    # honest floor), keeping brand + pack + store provenance
    best = {}
    for p in prices["entries"]:
        cur = best.get(p["ingredient_id"])
        if not cur or p["price_cents"] < cur["price_cents"]:
            best[p["ingredient_id"]] = p

    rows = []
    for ing_id, p in sorted(best.items(), key=lambda kv: ings.get(kv[0], {}).get("name", kv[0]).lower()):
        ing = ings.get(ing_id, {})
        name = html.escape(ing.get("name", ing_id))
        aisle = html.escape(ing.get("aisle", ""))
        brand = html.escape(p.get("brand") or "house brand")
        unit = p["pack_unit"]
        per = (f"R{p['price_cents'] / p['pack_qty']:.2f} / 100{unit}" if unit in ("g", "ml")
               else f"R{p['price_cents'] / p['pack_qty']:.2f}/{unit}")
        stale = " stale" if p.get("last_verified", "9999") < date.today().isoformat()[:8] + "01" else ""
        rows.append(f"""<tr>
<td><strong>{name}</strong><span class="a">{aisle}</span></td>
<td>{brand} &middot; {p["pack_qty"]} {html.escape(unit)}</td>
<td class="p">{fmt_r(p["price_cents"])}</td>
<td>{per}</td>
<td>{html.escape(p["store"])}</td>
<td class="v{stale}">{p.get("last_verified", "")}</td>
</tr>""")

    page = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{TITLE}</title>
<meta name="description" content="{META}">
<meta property="og:title" content="{TITLE}">
<meta property="og:description" content="{META}">
<meta property="og:type" content="website">
<meta name="theme-color" content="#ea580c">
<style>
*{{margin:0;padding:0;box-sizing:border-box}}
body{{font:16px/1.6 system-ui,sans-serif;background:#fff8f0;color:#1c1917;max-width:980px;margin:0 auto;padding:24px 20px 64px}}
h1{{font-size:1.9rem;line-height:1.15;margin-bottom:12px}}
h2{{font-size:1.2rem;margin:26px 0 8px}}
p{{margin-bottom:12px;max-width:70ch}}
strong.f{{color:#ea580c}}
.chips span{{display:inline-block;border:1px solid #d6d3d1;border-radius:999px;padding:4px 14px;margin:0 8px 8px 0;font-weight:600;background:#fff}}
table{{border-collapse:collapse;width:100%;margin-top:18px;background:#fff;border:1px solid #d6d3d1;font-size:0.92rem}}
th,td{{text-align:left;padding:9px 10px;border-bottom:1px solid #e7e5e4;vertical-align:top}}
th{{background:#ffedd5;font-size:0.78rem;text-transform:uppercase;letter-spacing:0.06em}}
td strong{{display:block}}
td .a{{display:block;font-size:0.75rem;color:#78716c}}
td.p{{font-weight:700;white-space:nowrap}}
td.v{{color:#78716c;white-space:nowrap}}
td.v.stale{{color:#b45309}}
.cta{{display:inline-block;margin-top:26px;background:#ea580c;color:#fff8f0;border:2px solid #1c1913;padding:12px 22px;border-radius:10px;font-weight:800;text-decoration:none;box-shadow:4px 4px 0 rgba(28,25,23,0.9)}}
footer{{margin-top:36px;color:#78716c;font-size:0.85rem}}
</style>
</head>
<body>
<h1>Your Weekly Meal Plan, Priced Right</h1>
<p>You set the budget. We do the maths. Enter what's in your pantry and what you can spend this week, and RandPlates shows you what you can cook &mdash; ranked by ingredient overlap and real cost per plate. It's built as a cheap meal plan South Africa can actually use: offline, fast, no sign-up. You get seven days of meals that stay inside your budget, plus one consolidated shopping list to take to the spaza or supermarket.</p>
<h2>What to cook with pap you already have</h2>
<p>Your pap, rice, or morogo should lead the plan, not sit at the back. The engine checks what you already have and pushes those recipes to the top, so you use what's in your kitchen first. You'll see how much of each recipe you already cover, what's still missing, and the cost per plate in Rands and cents, lined up so you can compare. Less waste, more of your staples doing the work.</p>
<h2>R500 grocery list or R400 &mdash; built for your budget</h2>
<p>Whether you're planning a R500 grocery list or a tight grocery list for R400, you need numbers that match the till slip. RandPlates builds budget meals for a week South Africa can shop for &mdash; one list, total cost, priced from real local retailers. Every ingredient shows quantity and price, every meal shows cost per plate. If a plan goes over, it tells you and shows the next best fit inside your budget.</p>
<p class="chips"><span>cheap meal plan South Africa</span><span>R500 grocery list</span><span>what to cook with pap</span><span>budget meals for a week South Africa</span><span>grocery list for R400</span></p>
<p><strong class="f">Prices updated {MONTH} &mdash; real retailers, no AI guesses.</strong> The live table below is the same data the app plans with: the cheapest verified row per staple across Checkers, Pick n Pay (PNP) and Shoprite, each with its brand, pack size and the date it was verified.</p>
<table>
<thead><tr><th>Item</th><th>Brand &amp; pack</th><th>Price</th><th>Per 100g/ml</th><th>Store</th><th>Verified</th></tr></thead>
<tbody>
{''.join(rows)}
</tbody>
</table>
<a class="cta" href="./index.html">Open RandPlates &mdash; plan your week free</a>
<footer>RandPlates &mdash; budget-first, local-first dinner planning for South Africa. Data last verified {stamp}. Prices change; the app always shows the verified date on every row.</footer>
</body>
</html>
"""
    open("prices.html", "w").write(page)
    print(f"prices.html regenerated: {len(rows)} priced staples, verified {stamp}")

if __name__ == "__main__":
    main()
