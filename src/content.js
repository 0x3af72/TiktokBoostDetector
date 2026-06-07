/*
 * content.js — isolated world. The UI + orchestration layer.
 *
 * Sources of truth (most → least complete):
 *   1. records pushed by interceptor.js via postMessage (covers grid lazy-loads)
 *   2. the embedded __UNIVERSAL_DATA_FOR_REHYDRATION__ blob (first paint)
 *   3. DOM action-bar counts on a video page (last-resort, no views)
 *
 * It keeps a Map<videoId, record>, classifies on demand with TBD.classify, and
 * renders: an expandable verdict widget on a single-video page, and a corner
 * badge on every thumbnail of a profile/grid page. Re-runs on SPA navigation
 * and on DOM mutations (infinite scroll).
 */
(function () {
  "use strict";
  const TBD = globalThis.TBD;
  if (!TBD) return;

  const stats = new Map(); // id -> record
  let enabled = true;
  let promoOverride = true; // trust isAd / "Promotional content" as a hard BOOSTED override
  let scanQueued = false;
  const opts = () => ({ promoOverride });

  // ---- settings ----
  try {
    chrome.storage &&
      chrome.storage.sync.get({ enabled: true, promoOverride: true }, (s) => {
        enabled = s.enabled !== false;
        promoOverride = s.promoOverride !== false;
        if (!enabled) removeAll();
        else scan();
      });
    chrome.storage &&
      chrome.storage.onChanged.addListener((c) => {
        if (c.enabled) enabled = c.enabled.newValue !== false;
        if (c.promoOverride) promoOverride = c.promoOverride.newValue !== false;
        if (c.enabled || c.promoOverride) {
          if (!enabled) removeAll();
          else { invalidateBadges(); scan(); }
        }
      });
  } catch (_) {}

  // force grid badges + widget to recompute (their caches key on verdict/confidence)
  function invalidateBadges() {
    document.querySelectorAll("[data-tbd-id]").forEach((h) => { delete h.dataset.tbdVerdict; });
    widgetSig = null;
  }

  // ---- ingest records ----
  function ingest(items) {
    let added = false;
    for (const r of items || []) {
      if (!r || !r.id) continue;
      const prev = stats.get(r.id) || {};
      // merge, preferring defined values (later/more-complete wins)
      const merged = Object.assign({}, prev, r);
      stats.set(r.id, merged);
      added = true;
    }
    if (added) queueScan();
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.source === "TBD_STATS") ingest(e.data.items);
  });

  // popup asks how many posts we've badged on this page
  try {
    chrome.runtime &&
      chrome.runtime.onMessage.addListener((msg, _s, reply) => {
        if (msg && msg.type === "TBD_COUNT") {
          reply({ count: document.querySelectorAll(".tbd-badge").length });
          return true;
        }
      });
  } catch (_) {}

  // Also read the embedded blob directly (covers the case where we loaded after
  // the interceptor's first scrape, or interceptor is blocked).
  function scrapeEmbedded() {
    try {
      const el = document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
      if (!el) return;
      const data = JSON.parse(el.textContent);
      const out = [];
      harvest(data && data.__DEFAULT_SCOPE__, out, 0);
      ingest(out);
    } catch (_) {}
  }
  function harvest(v, out, d) {
    if (d > 8 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach((x) => harvest(x, out, d + 1));
    const st = v.stats || v.statsV2;
    if (st && (v.id || v.itemId)) {
      const n = (x) => (x == null ? null : Number(String(x).replace(/,/g, "")) || 0);
      out.push({
        id: String(v.id || v.itemId),
        views: n(st.playCount), likes: n(st.diggCount), comments: n(st.commentCount),
        saves: n(st.collectCount), shares: n(st.shareCount),
        isAd: typeof v.isAd === "boolean" ? v.isAd : undefined,
        isSlideshow: v.imagePost ? true : undefined,
        desc: typeof v.desc === "string" ? v.desc.slice(0, 300) : undefined,
        author: v.author && (v.author.uniqueId || v.author.nickname),
        authorVerified: !!(v.author && v.author.verified),
      });
    }
    for (const k in v) if (v[k] && typeof v[k] === "object") harvest(v[k], out, d + 1);
  }

  // ---- helpers ----
  // Posts are either videos (/video/ID) or slideshows (/photo/ID). Match both.
  const POST_RE = /\/(?:video|photo)\/(\d{6,})/;
  const POST_LINK_SEL = 'a[href*="/video/"], a[href*="/photo/"]';
  const idFromHref = (href) => {
    const m = href && href.match(POST_RE);
    return m ? m[1] : null;
  };
  function pagePostId() {
    const m = location.pathname.match(POST_RE);
    return m ? m[1] : null;
  }
  function isPostPage() {
    return !!pagePostId();
  }
  // A /photo/ URL is a slideshow.
  function pageIsSlideshow() {
    return /\/photo\/\d/.test(location.pathname);
  }

  // Read action-bar counts on a post page (fallback; no view count exists here).
  // Works for both video and photo (slideshow) detail pages.
  function domStatsForPost() {
    const g = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.textContent : null;
    };
    const likes = g('[data-e2e="like-count"], [data-e2e="browse-like-count"]');
    const comments = g('[data-e2e="comment-count"], [data-e2e="browse-comment-count"]');
    const saves = g('[data-e2e="favorite-count"], [data-e2e="undefined-count"]');
    if (likes == null && saves == null) return null;
    return { likes, comments, saves, isSlideshow: pageIsSlideshow() };
  }

  function statsForPost(id) {
    const rec = id && stats.get(id);
    if (rec && (rec.views != null || rec.likes != null)) {
      // ensure format is known even if the record didn't carry imagePost
      if (rec.isSlideshow == null && pageIsSlideshow()) return Object.assign({}, rec, { isSlideshow: true });
      return rec;
    }
    return domStatsForPost(); // may be null
  }

  function fmt(n) {
    if (n == null) return "—";
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "K";
    return String(n);
  }
  const pctStr = (x) => (x == null ? "—" : TBD.pct(x) + "%");
  const ratioStr = (x) => (x == null ? "—" : !isFinite(x) ? "∞:1" : Math.round(x) + ":1");

  // ============================ profile / grid badges ============================
  function scanGrid() {
    const anchors = document.querySelectorAll(POST_LINK_SEL);
    anchors.forEach((a) => {
      const id = idFromHref(a.getAttribute("href") || a.href);
      if (!id) return;
      const rec = stats.get(id);
      if (!rec) return; // no data yet — will badge when it arrives
      const host = a.closest('[data-e2e="user-post-item"]') || a.parentElement || a;
      if (!host) return;
      const res = TBD.classify(rec, opts());
      const key = res.verdict + ":" + res.confidence;
      let badge = host.querySelector(":scope > .tbd-badge");
      if (host.dataset.tbdId === id && badge && host.dataset.tbdVerdict === key) return;
      if (!badge) {
        badge = document.createElement("div");
        badge.className = "tbd-badge";
        const cs = getComputedStyle(host);
        if (cs.position === "static") host.style.position = "relative";
        host.appendChild(badge);
        // click a badge to expand the full analytics for that post (don't open the video)
        badge.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const r = stats.get(badge.dataset.tbdId);
          if (r) openPopover(badge, r);
        }, true);
      }
      badge.dataset.tbdId = id;
      badge.style.background = badgeColor(res);
      badge.textContent = res.verdict === "UNKNOWN" ? "?" : `${res.short} ${res.confidence}%`;
      badge.title =
        `${res.label}${res.verdict !== "UNKNOWN" ? " · " + res.confidence + "%" : ""}  [${res.format}]\n` +
        `views ${fmt(rec.views)} · likes ${fmt(rec.likes)} · saves ${fmt(rec.saves)} · comments ${fmt(rec.comments)}\n` +
        `likes/views ${pctStr(res.metrics.likesPerView)} · saves/views ${pctStr(res.metrics.savesPerView)} · saves/likes ${pctStr(res.metrics.savesToLikes)}` +
        (res.score != null ? ` · S=${res.score}` : "") +
        (res.promoLabel ? " · promo label" : "") +
        `\n${res.tagline || res.action}\nClick for the full breakdown`;
      host.dataset.tbdId = id;
      host.dataset.tbdVerdict = res.verdict + ":" + res.confidence;
    });
  }

  // grey out an undetermined verdict (50–60%) so it reads as "barely a guess"
  function badgeColor(res) {
    return res.verdict !== "UNKNOWN" && res.undetermined ? "#64748b" : res.color;
  }

  // ---- shared breakdown body (used by the video widget AND the grid popover) ----
  function buildBody(res, known) {
    const m = res.metrics;
    // color by signal direction: negative = organic (green), positive = boosted (red)
    const sigCls = (s) => (s == null ? "tbd-na" : s < 0 ? "tbd-pass" : s > 0 ? "tbd-fail" : "tbd-zero");
    const signed = (n) => (n > 0 ? "+" + n : String(n));

    const counts =
      `<div class="tbd-counts">` +
        countCell("Views", fmt(m.views)) + countCell("Likes", fmt(m.likes)) +
        countCell("Saves", fmt(m.saves)) + countCell("Comments", fmt(m.comments)) +
      `</div>`;

    const confColor = res.verdict === "UNKNOWN" ? "#64748b" : badgeColor(res);
    const header =
      `<div class="tbd-score">` +
        `<span>Verdict</span>` +
        `<b style="color:${confColor}">${escapeHtml(res.label)}</b>` +
        (res.verdict !== "UNKNOWN" ? `<span class="tbd-conf" style="color:${confColor}">${res.confidence}%</span>` : "") +
      `</div>`;

    if (res.override) {
      return (
        header +
        `<p class="tbd-tagline">${escapeHtml(res.tagline)}</p>` +
        counts +
        `<div class="tbd-action"><b>Why:</b> Platform-disclosed paid distribution overrides the engagement math.</div>` +
        `<div class="tbd-foot">Binary Boost Detector</div>`
      );
    }

    // signal table: value · score (−2..+2) · weighted contribution
    const sigRows = (res.signals || []).map((s) => {
      const stateCls = s.included ? sigCls(s.score) : "tbd-na";
      const scoreCell = s.na || !s.included ? "—" : signed(s.score) + ` ×${s.weight}`;
      const contrib = s.included && !s.na ? signed(s.contribution) : "skip";
      const main = `<tr class="${stateCls} tbd-sigtop"><td>${s.key} ${s.label}</td><td class="tbd-v">${s.valueStr}</td>` +
        `<td class="tbd-note">${scoreCell}</td><td class="tbd-mark">${contrib}</td></tr>`;
      const base = s.baseline ? `<tr class="tbd-subrow"><td colspan="4" class="tbd-baseline">${escapeHtml(s.baseline)}</td></tr>` : "";
      return main + base;
    }).join("");

    const scaleNote = `<tr class="tbd-na"><td>View scale</td><td class="tbd-v"></td><td class="tbd-note">${escapeHtml(res.viewScaleLabel)}</td><td class="tbd-mark">×${res.viewScale}</td></tr>`;
    const totalRow = `<tr class="${res.score > 0 ? "tbd-fail" : res.score < 0 ? "tbd-pass" : "tbd-zero"}"><td><b>Score S</b></td><td></td><td></td><td class="tbd-mark"><b>${signed(res.score)}</b></td></tr>`;

    return (
      (known ? "" : `<p class="tbd-warn">Stats not loaded yet — scroll or reload if this persists.</p>`) +
      (res.overrideSuppressed ? `<p class="tbd-warn">⚐ isAd flagged, but promo override is OFF — scored on engagement only.</p>` : "") +
      (res.viewsHidden ? `<p class="tbd-warn">⚠ Views hidden — S1/S2 dropped, confidence capped at 80%.</p>` : "") +
      header +
      `<p class="tbd-tagline">${escapeHtml(res.tagline)}</p>` +
      counts +
      sect("Signals (− organic · + boosted)",
        `<table class="tbd-tbl tbd-steps">${sigRows}${scaleNote}${totalRow}</table>`) +
      `<div class="tbd-action"><b>Action:</b> ${escapeHtml(res.action)}</div>` +
      `<div class="tbd-foot">Binary Boost Detector · saves carry the heaviest weight</div>`
    );
  }

  // ============================ video-page widget ============================
  // Rebuilt only when the underlying data changes (sig cache) so the header node
  // isn't destroyed under the user's cursor; the toggle is delegated on the
  // persistent container so it survives any rebuild.
  let widgetSig = null;
  function renderWidget() {
    const id = pagePostId();
    if (!id) { removeWidget(); return; }
    const rec = statsForPost(id);
    const res = TBD.classify(rec || {}, opts());
    const known = !!(rec && (rec.views != null || rec.likes != null));

    let w = document.getElementById("tbd-widget");
    if (!w) {
      w = document.createElement("div");
      w.id = "tbd-widget";
      w.className = "tbd-panel";
      w.addEventListener("click", (e) => { if (e.target.closest(".tbd-head")) toggleWidget(w); });
      w.addEventListener("keydown", (e) => {
        if ((e.key === "Enter" || e.key === " ") && e.target.closest(".tbd-head")) { e.preventDefault(); toggleWidget(w); }
      });
      document.body.appendChild(w);
      widgetSig = null;
    }

    const sig = [id, res.verdict, res.confidence, res.score, known,
      rec && rec.views, rec && rec.likes, rec && rec.comments, rec && rec.saves].join("|");
    if (sig === widgetSig && w.querySelector(".tbd-head")) return; // nothing changed
    widgetSig = sig;

    const expanded = w.classList.contains("tbd-expanded");
    w.dataset.verdict = res.verdict;
    w.style.setProperty("--tbd-color", res.color);
    w.innerHTML =
      `<div class="tbd-head" role="button" tabindex="0" aria-expanded="${expanded}">` +
        `<span class="tbd-dot"></span>` +
        `<span class="tbd-label">${res.label}${res.verdict!=="UNKNOWN"?" · "+res.confidence+"%":""}</span>` +
        `<span class="tbd-type">${res.format}</span>` +
        `<span class="tbd-chevron">${expanded ? "▾" : "▸"}</span>` +
      `</div>` +
      `<div class="tbd-body">${buildBody(res, known)}</div>`;
  }
  function toggleWidget(w) {
    const open = !w.classList.contains("tbd-expanded");
    w.classList.toggle("tbd-expanded", open);
    const ch = w.querySelector(".tbd-chevron"); if (ch) ch.textContent = open ? "▾" : "▸";
    const h = w.querySelector(".tbd-head"); if (h) h.setAttribute("aria-expanded", open);
  }

  // ============================ grid popover (per-post breakdown) ============================
  function openPopover(anchor, rec) {
    closePopover();
    const res = TBD.classify(rec, opts());
    const p = document.createElement("div");
    p.id = "tbd-popover";
    p.className = "tbd-panel tbd-expanded";
    p.style.setProperty("--tbd-color", res.color);
    p.innerHTML =
      `<div class="tbd-head">` +
        `<span class="tbd-dot"></span>` +
        `<span class="tbd-label">${res.label}${res.verdict!=="UNKNOWN"?" · "+res.confidence+"%":""}</span>` +
        `<span class="tbd-type">${res.format}</span>` +
        `<button class="tbd-close" aria-label="Close">×</button>` +
      `</div>` +
      `<div class="tbd-body">${buildBody(res, true)}</div>`;
    document.body.appendChild(p);
    // position near the badge, clamped to the viewport
    const r = anchor.getBoundingClientRect();
    const pw = p.offsetWidth || 260, ph = p.offsetHeight || 300;
    let left = r.left, top = r.bottom + 6;
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);
    p.style.left = Math.max(8, left) + "px";
    p.style.top = Math.max(8, top) + "px";
    p.querySelector(".tbd-close").addEventListener("click", closePopover);
  }
  function closePopover() {
    const p = document.getElementById("tbd-popover");
    if (p) p.remove();
  }
  document.addEventListener("click", (e) => {
    const p = document.getElementById("tbd-popover");
    if (p && !p.contains(e.target) && !(e.target.classList && e.target.classList.contains("tbd-badge"))) closePopover();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePopover(); });

  function countCell(k, v) {
    return `<div class="tbd-cc"><span>${v}</span><label>${k}</label></div>`;
  }
  function sect(title, inner) {
    return `<div class="tbd-sect"><div class="tbd-sect-t">${title}</div>${inner}</div>`;
  }
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  }

  // ---- lifecycle ----
  function removeWidget() {
    const w = document.getElementById("tbd-widget");
    if (w) w.remove();
    widgetSig = null;
  }
  function removeAll() {
    removeWidget();
    document.querySelectorAll(".tbd-badge").forEach((b) => b.remove());
  }
  function scan() {
    if (!enabled) return;
    scrapeEmbedded();
    if (isPostPage()) {
      renderWidget();
      scanGrid(); // related-post rail also gets badges
    } else {
      removeWidget();
      scanGrid();
    }
  }
  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(() => {
      scanQueued = false;
      scan();
    });
  }

  // SPA navigation: TikTok swaps pages without a reload.
  let lastUrl = location.href;
  function onUrlMaybeChanged() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      // ask interceptor to re-scrape the (possibly new) embedded blob
      window.postMessage({ source: "TBD_REQUEST_REPLAY" }, location.origin);
      removeWidget();
      queueScan();
    }
  }
  ["pushState", "replaceState"].forEach((fn) => {
    const orig = history[fn];
    history[fn] = function () {
      const r = orig.apply(this, arguments);
      onUrlMaybeChanged();
      return r;
    };
  });
  window.addEventListener("popstate", onUrlMaybeChanged);

  // DOM mutations: infinite scroll adds thumbnails; action bar appears late.
  // Ignore mutations caused by our OWN UI, otherwise badge/widget writes retrigger
  // the scan in a loop that rebuilds the widget every frame (and eats clicks).
  const isOurs = (n) =>
    n && n.nodeType === 1 &&
    (n.id === "tbd-widget" || n.id === "tbd-popover" ||
      (n.classList && n.classList.contains("tbd-badge")) ||
      (n.closest && n.closest("#tbd-widget, #tbd-popover")));
  const mo = new MutationObserver((muts) => {
    let relevant = false;
    for (const m of muts) {
      if (isOurs(m.target)) continue;
      const added = Array.from(m.addedNodes);
      if (added.length && added.every(isOurs)) continue; // only our nodes were added
      relevant = true;
      break;
    }
    if (!relevant) return;
    onUrlMaybeChanged();
    queueScan();
  });
  function start() {
    mo.observe(document.documentElement, { childList: true, subtree: true });
    scan();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
