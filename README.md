# TikTok Boost Detector

A Chrome extension that classifies every TikTok post **ORGANIC** or **BOOSTED**
with a **confidence %**, from pure engagement math (no identity checks). Works on
**videos and slideshows** (`/photo/`), on individual posts and across profile
grids — so you never burn a 5–8-video format-judgment cycle on numbers that were
never organically viable.

- On a **post page** (video or slideshow) it shows a small corner widget you can
  **expand** into a full, color-coded breakdown of *why* it reached its verdict.
- On a **profile grid** it badges **every post before you click in** — click any
  badge for the same breakdown in a popover.

![icon](icons/icon128.png)

## The mechanisms (why the rules point the way they do)

1. **Paid views dilute every per-view ratio** — bought impressions are shown, not
   chosen. Rates far below baseline at scale → paid. Ratios *above* baseline can't
   be produced by buying views (paid reach only pushes ratios down).
2. **Saves are the most trustworthy signal** — can't be hidden/filtered, ad
   viewers rarely save, save-botting is rare.
3. **Comments are the least trustworthy count** — but comment *quality*
   (`comments_alive`) can't be faked at scale.
4. **Identity priors** — brand accounts posting pitch copy Spark-boost; their view
   count is budget, not viability.

## Verdicts

| Badge | Verdict | Meaning |
|---|---|---|
| 🟢 `ORG n%` | Organic | Engagement looks chosen, not bought — usable as format evidence |
| 🔴 `BST n%` | Boosted | Distribution you can't trust as format evidence — don't clone for organic |
| ⚪ `?` | No data / undetermined | Nothing loaded, or score ≈ 0 (50–60% = a guess) |

Read the confidence: **50–60%** ≈ a guess (undetermined, shown grey) · **60–75%**
lean · **75%+** act on it.

## How it scores

**Hard override:** a "Promotional content" tag / `isAd` → **BOOSTED 99%** (platform-disclosed paid). This override is **toggleable** in the popup ("Trust isAd / promo label as override"); turn it off to judge `isAd` posts on the engagement math alone (useful given `isAd`'s uncertain semantics — see Limitations).

Otherwise five signals each score **−2 (organic) … +2 (boosted)**:

| Signal | Weight | Notes |
|---|---|---|
| S1 likes / views | ×3 | per-view dilution |
| **S2 saves / views** | **×3** | video vs slideshow bands |
| **S3 saves / likes** | **×2** | works even with views hidden |
| S4 likes / comments | ×1 | |
| S5 comments alive | ×1 | optional; skipped if unchecked |

`S = 3·S1 + 3·S2 + 2·S3 + 1·S4 + 1·S5`, then a **view-scale multiplier**
(≥100K ×1.0 · 10–100K ×0.7 · <10K ×0.4 · hidden: drop S1/S2, use `2·S3 + S4 + S5`
×0.8). **S > 0 → Boosted, S < 0 → Organic.**
`confidence = min(95, 50 + 4·|S|)%` (capped 80% when views are hidden).

Saves carry **half the total weight** (S2 + S3) because they're the hardest signal
to fake — unfilterable by the account, rarely botted, not produced by passive ad
viewers. `comments_alive` (S5) is an explicit optional input; without real
top-comment data it's skipped (we don't proxy it from likes:comments — that would
double-count S4). Bands/weights are provisional — see `CLAUDE.md` to recalibrate.

## Install (unpacked)

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Open any TikTok profile or video. Badges and the widget appear automatically.
4. Click the toolbar icon for the legend and an on/off toggle.

Icons are committed; to regenerate them: `node scripts/gen-icons.js`.

## How it works

TikTok does **not** put per-post stats in the DOM on profile grids (thumbnails
show only a view count). The full stats arrive lazily over `fetch`/XHR.

- `src/interceptor.js` (MAIN world, `document_start`) patches `fetch`/XHR and
  generically harvests `{id, stats, isAd, imagePost→slideshow, desc, author}`
  from any TikTok JSON response, plus the embedded
  `__UNIVERSAL_DATA_FOR_REHYDRATION__` blob. It forwards records to the content
  script via `window.postMessage`.
- `src/content.js` (ISOLATED world) keeps a `Map<postId, record>`, classifies
  with `TBD.classify`, renders the grid badges (clickable → popover) and the
  expandable post widget, and re-runs on SPA navigation + infinite scroll.
  Handles both `/video/` and `/photo/` (slideshow) URLs.
- `src/classify.js` is the pure, spec-encoding brain — shared verbatim by the
  browser and the Node tests.

## Tests

```bash
node test/classify.test.js
```

Covers the spec's worked examples (kittyweight, looksteacher, thefabstory,
myjourney.app, glowupcat) with formula-exact scores/confidence, plus the
promo-label override, the view-scale tiers, the hidden-views path, the
video↔slideshow saves bands, and parsing guards.

## Limitations

- **"BOOSTED" means "distribution you can't trust as format evidence"** — it can't
  distinguish Spark spend from bot engagement from (at low views) plain mediocre
  content. For the copy-this-format decision, all three mean *no*.
- Confidence %s are deterministic rank scores from this formula, **not calibrated
  probabilities**. Bands/weights are provisional — recalibrate on 30–50 labeled
  posts (promo-tagged/ad-library vs clearly organic, in-niche). See `CLAUDE.md`.
- `comments_alive` (S5) is an explicit optional input; without real top-comment
  data the extension skips it rather than proxying from likes:comments (would
  double-count S4). `promo_label` is mapped from `isAd`.
- Slideshow detail (`/photo/`) pages keep stats in the DOM action bar with **no
  views**, so a directly-opened slideshow uses the hidden-views path (S3+S4+S5,
  confidence ≤80%) unless the grid/API already supplied its view count.
- TikTok's DOM/API are unofficial and can change; selectors and the JSON harvest
  are written defensively but may need updates. See `CLAUDE.md`.
