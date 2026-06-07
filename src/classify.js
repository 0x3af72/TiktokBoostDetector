/*
 * classify.js — Binary Boost Detector (ORGANIC vs BOOSTED) + confidence %.
 *
 * Pure, dependency-free, shared verbatim by the content script (browser) and the
 * Node test harness. No identity checks — pure engagement math. Works for videos
 * and slideshows.
 *
 *   Why it points the way it does:
 *     1. Paid impressions are shown, not chosen → they dilute every per-view ratio.
 *        Above-baseline ratios can't be bought; below-baseline at scale = paid reach.
 *     2. Saves are the most trustworthy signal (unfilterable, not cheaply faked) →
 *        S2 + S3 carry 5 of 10 weight points. Comments are the least trustworthy.
 *     3. Low-view posts get full analysis but shrunken confidence (small samples
 *        swing on noise).
 *
 *   Hard override: promo_label (TikTok "Promotional content" tag / isAd) -> BOOSTED 99%.
 *
 *   Signals each score -2 (strongly organic) .. +2 (strongly boosted):
 *     S1 likes/views  ×3      S2 saves/views ×3 (video/slideshow bands)
 *     S3 saves/likes  ×2      S4 likes/comments ×1     S5 comments_alive ×1 (optional)
 *
 *   S = 3·S1 + 3·S2 + 2·S3 + 1·S4 + 1·S5 (when views are hidden, S1/S2 can't be
 *   computed and simply drop out → S = 2·S3 + S4 + S5).
 *   Verdict: S>0 BOOSTED · S<0 ORGANIC · S=0 ORGANIC@50% (undetermined).
 *   confidence = min(95, 50 + 4·|S|)%
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.TBD = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Band tables: pick the score of the first row whose threshold the value meets.
  // Each is [minValue, score] sorted high→low; the last [0, …] is the floor.
  // Recalibrated 2026 against Rival IQ / 2M-post data (see CLAUDE.md):
  //   likes/views average ~3–3.5%, neutral 2.5–4.5%, viral tier ~9% (top 6%).
  //   saves/views average ~0.3–0.6% — neutral video 0.4–0.9%, slideshow 1–2%.
  const BANDS = {
    s1: [[0.09, -2], [0.045, -1], [0.025, 0], [0.01, 1], [0, 2]], // likes/views
    s2_video: [[0.018, -2], [0.009, -1], [0.004, 0], [0.002, 1], [0, 2]], // saves/views
    s2_slideshow: [[0.04, -2], [0.02, -1], [0.01, 0], [0.005, 1], [0, 2]],
    s3_video: [[0.25, -2], [0.12, -1], [0.06, 0], [0.03, 1], [0, 2]], // saves/likes (unchanged)
    s3_slideshow: [[0.3, -2], [0.15, -1], [0.08, 0], [0.04, 1], [0, 2]],
  };
  const WEIGHTS = { s1: 3, s2: 3, s3: 2, s4: 1, s5: 1 };

  const META = {
    ORGANIC: { verdict: "ORGANIC", label: "Organic", short: "ORG", color: "#16a34a",
      action: "Engagement looks chosen, not bought — usable as format evidence." },
    BOOSTED: { verdict: "BOOSTED", label: "Boosted", short: "BST", color: "#dc2626",
      action: "Distribution you can't trust as format evidence — don't copy this format for organic testing." },
    UNKNOWN: { verdict: "UNKNOWN", label: "No data", short: "?", color: "#64748b",
      action: "No engagement data available for this post yet." },
  };

  // ---- count parsing: "18.8K" -> 18800, "2.8M" -> 2800000, "1,234" -> 1234 ----
  function parseCount(v) {
    if (v == null) return null;
    if (typeof v === "number") return isFinite(v) ? v : null;
    const s = String(v).trim().toLowerCase().replace(/,/g, "");
    if (!s || s === "-") return null;
    const m = s.match(/^([\d.]+)\s*([kmbg])?/);
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (!isFinite(n)) return null;
    return Math.round(n * ({ k: 1e3, m: 1e6, b: 1e9, g: 1e9 }[m[2]] || 1));
  }
  const num = (v) => { const n = parseCount(v); return n == null || !isFinite(n) ? null : n; };
  const pct = (x) => (x == null ? null : Math.round(x * 1000) / 10);
  const pctStr = (x) => {
    if (x == null) return "—";
    const p = x * 100;
    if (p === 0) return "0%";
    if (p >= 1) return Math.round(p * 10) / 10 + "%";
    if (p >= 0.1) return Math.round(p * 100) / 100 + "%";
    return Number(p.toPrecision(2)) + "%";
  };
  const ratioStr = (x) => (x == null ? "—" : !isFinite(x) ? "∞:1" : Math.round(x) + ":1");

  function band(value, table) {
    if (value == null) return null;
    for (const [min, score] of table) if (value >= min) return score;
    return table[table.length - 1][1];
  }
  // likes:comments — hard data: brand tiers run 40–80:1; red flag tightened to >250:1.
  function scoreS4(r) {
    if (r == null) return null;
    if (r <= 80) return -1;
    if (r <= 150) return 0;
    if (r <= 250) return 1;
    return 2;
  }
  // comments_alive is an EXPLICIT optional input (spec: "omit if unchecked").
  // We do NOT proxy it from likes:comments — that would double-count S4. So S5 is
  // only scored when caller passes commentsAlive, or when we have real top-comment
  // data (topCommentLikes ≥ 1% of post likes). Otherwise null -> skip S5.
  function deriveAlive(raw, likes) {
    if (typeof raw.commentsAlive === "boolean") return raw.commentsAlive;
    if (raw.topCommentLikes != null && likes > 0) return raw.topCommentLikes >= 0.01 * likes;
    return null;
  }

  // ---- the classifier ----
  // raw: { likes, saves, comments, views?, format|isSlideshow, promoLabel|isAd,
  //        commentsAlive?, topCommentLikes? }
  // opts.promoOverride (default true): when false, the isAd/promo_label hard
  // override is disabled and the post is judged purely on the S1–S5 engagement math.
  function classify(raw, opts) {
    raw = raw || {};
    opts = opts || {};
    const applyOverride = opts.promoOverride !== false;
    const likes = num(raw.likes), saves = num(raw.saves), comments = num(raw.comments);
    const views = num(raw.views);
    const format = raw.format || (raw.isSlideshow ? "slideshow" : "video");
    const promoLabel = raw.promoLabel === true || raw.isAd === true;
    const overrideSuppressed = promoLabel && !applyOverride;
    const viewsHidden = views == null || views <= 0;

    const lpv = !viewsHidden ? likes / views : null;
    const spv = !viewsHidden && saves != null ? saves / views : null;
    const s2l = likes > 0 && saves != null ? saves / likes : null;
    const l2c = comments > 0 ? likes / comments : likes > 0 ? Infinity : null;

    const metrics = { likes, saves, comments, views, format,
      likesPerView: lpv, savesPerView: spv, savesToLikes: s2l, likesToComments: l2c };

    const pack = (verdict, confidence, extra) =>
      Object.assign({ confidence, format, promoLabel, metrics }, META[verdict], extra || {});

    // ---- hard override (skippable via opts.promoOverride = false) ----
    if (promoLabel && applyOverride) {
      return pack("BOOSTED", 99, { score: null, override: true, signals: [], overrideSuppressed: false,
        tagline: 'Platform-disclosed paid distribution ("Promotional content" / isAd). Boosted by definition.' });
    }

    // No usable data at all
    if (likes == null && saves == null && views == null && comments == null) return pack("UNKNOWN", 0, { score: 0, signals: [] });

    // ---- signal scores ----
    const s1 = band(lpv, BANDS.s1);
    const s2 = band(spv, format === "slideshow" ? BANDS.s2_slideshow : BANDS.s2_video);
    const s3 = band(s2l, format === "slideshow" ? BANDS.s3_slideshow : BANDS.s3_video);
    const s4 = scoreS4(l2c);
    const alive = deriveAlive(raw, likes);
    const s5 = alive == null ? null : alive ? -1 : 1;

    // S1/S2 are per-view, so they only count when views are visible.
    const useS1S2 = !viewsHidden;

    const rows = [];
    const add = (key, label, score, weight, valueStr, baseline, included) =>
      rows.push({ key, label, score, weight, valueStr, baseline, included,
        contribution: included && score != null ? weight * score : 0, na: score == null });

    // baseline = where each signal crosses organic ↔ boosted (from the band tables).
    const slide = format === "slideshow";
    add("S1", "Likes / views", s1, WEIGHTS.s1, pctStr(lpv), "organic ≥4.5% · boosted <2.5%", useS1S2);
    add("S2", "Saves / views", s2, WEIGHTS.s2, pctStr(spv),
      slide ? "organic ≥2% · boosted <1%" : "organic ≥0.9% · boosted <0.4%", useS1S2);
    add("S3", "Saves / likes", s3, WEIGHTS.s3, pctStr(s2l),
      slide ? "organic ≥15% · boosted <8%" : "organic ≥12% · boosted <6%", true);
    add("S4", "Likes / comments", s4, WEIGHTS.s4, ratioStr(l2c), "organic ≤80:1 · red flag >250:1", true);
    add("S5", "Comments alive", s5, WEIGHTS.s5, alive == null ? "unchecked" : alive ? "alive" : "dead",
      "organic alive · boosted dead", s5 != null);

    let S = 0;
    for (const r of rows) S += r.contribution;
    S = Math.round(S * 10) / 10; // one decimal

    let verdict;
    if (S > 0) verdict = "BOOSTED";
    else if (S < 0) verdict = "ORGANIC";
    else verdict = "ORGANIC"; // S === 0 -> undetermined, reported at 50%

    let confidence = Math.min(95, Math.round(50 + 4 * Math.abs(S)));
    if (S === 0) confidence = 50;

    const undetermined = confidence < 60;
    // Describe the call + why. (The "act on it / lean / guess" reading guide lives
    // in the popup; don't jam it next to the verdict where it reads as advice.)
    const why = verdict === "BOOSTED"
      ? "engagement is below organic baselines for this reach"
      : "engagement clears organic baselines";
    const strength = undetermined ? "Undetermined" : confidence < 75 ? `Leans ${verdict.toLowerCase()}` : `Confidently ${verdict.toLowerCase()}`;
    const tagline = undetermined
      ? `Undetermined (${confidence}%) — too close to call; treat as a guess.`
      : `${strength} (${confidence}%) — ${why}.`;

    return pack(verdict, confidence, {
      score: S, override: false, overrideSuppressed,
      signals: rows, viewsHidden, undetermined, commentsAlive: alive, tagline,
    });
  }

  return { classify, parseCount, num, pct, pctStr, ratioStr, BANDS, WEIGHTS, META };
});
