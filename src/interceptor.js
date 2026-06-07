/*
 * interceptor.js — runs in the page's MAIN world at document_start.
 *
 * Why this exists: on profile/grid pages TikTok does NOT put per-video stats in
 * the DOM (thumbnails show only a view count) or in the embedded page JSON. The
 * full stats (likes/comments/saves/views + isAd) arrive lazily via fetch/XHR
 * calls to endpoints like /api/post/item_list/. We must observe those calls.
 *
 * Strategy: patch fetch + XHR before TikTok's bundle runs, then *generically*
 * walk every JSON response harvesting any object that carries a stats block
 * (diggCount/playCount...). This is endpoint-agnostic so it survives TikTok
 * renaming routes. We also scrape the embedded universal-data blob for the
 * first paint. Everything is forwarded to the isolated content script via
 * window.postMessage — the only channel between MAIN and ISOLATED worlds.
 */
(function () {
  "use strict";
  if (window.__TBD_INTERCEPTOR__) return;
  window.__TBD_INTERCEPTOR__ = true;

  const CHANNEL = "TBD_STATS";

  function send(items) {
    if (!items || !items.length) return;
    try {
      window.postMessage({ source: CHANNEL, items }, window.location.origin);
    } catch (_) {}
  }

  // Normalize one TikTok item-struct-ish node into our flat record.
  function toRecord(node) {
    if (!node || typeof node !== "object") return null;
    const stats = node.stats || node.statsV2;
    if (!stats) return null;
    const id = node.id || node.itemId || (node.video && node.video.id);
    if (!id) return null;
    const n = (v) => (v == null ? null : Number(String(v).replace(/,/g, "")) || 0);
    const rec = {
      id: String(id),
      views: n(stats.playCount),
      likes: n(stats.diggCount),
      comments: n(stats.commentCount),
      saves: n(stats.collectCount),
      shares: n(stats.shareCount),
    };
    if (typeof node.isAd === "boolean") rec.isAd = node.isAd;
    if (node.imagePost) rec.isSlideshow = true; // photo carousel (different thresholds)
    if (typeof node.desc === "string") rec.desc = node.desc.slice(0, 300);
    if (node.author && typeof node.author === "object") {
      rec.author = node.author.uniqueId || node.author.nickname || null;
      rec.authorVerified = !!node.author.verified;
    }
    // Need at least likes or views to be useful.
    if (rec.likes == null && rec.views == null) return null;
    return rec;
  }

  // Recursively harvest records from an arbitrary JSON value (bounded depth).
  function harvest(value, out, depth) {
    if (depth > 8 || value == null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const v of value) harvest(v, out, depth + 1);
      return;
    }
    if (value.stats || value.statsV2) {
      const rec = toRecord(value);
      if (rec) out.push(rec);
    }
    for (const k in value) {
      const v = value[k];
      if (v && typeof v === "object") harvest(v, out, depth + 1);
    }
  }

  function harvestText(text) {
    if (!text || text.length > 8_000_000) return; // skip absurd payloads
    let json;
    try { json = JSON.parse(text); } catch (_) { return; }
    const out = [];
    harvest(json, out, 0);
    // de-dupe within this payload by id (keep last = most complete)
    const map = new Map();
    for (const r of out) map.set(r.id, r);
    send([...map.values()]);
  }

  // ---- patch fetch ----
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (...args) {
      return origFetch.apply(this, args).then((res) => {
        try {
          const url = typeof args[0] === "string" ? args[0] : args[0] && args[0].url;
          if (url && /\/api\/(post|item|recommend|search|explore|related)/.test(url)) {
            res.clone().text().then(harvestText).catch(() => {});
          }
        } catch (_) {}
        return res;
      });
    };
  }

  // ---- patch XHR ----
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const open = XHR.prototype.open;
    const sendX = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      this.__tbdUrl = url;
      return open.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      this.addEventListener("load", function () {
        try {
          const url = this.__tbdUrl || "";
          if (/\/api\/(post|item|recommend|search|explore|related)/.test(url)) {
            const ct = this.getResponseHeader && this.getResponseHeader("content-type");
            if (!ct || ct.includes("json") || ct.includes("text")) harvestText(this.responseText);
          }
        } catch (_) {}
      });
      return sendX.apply(this, arguments);
    };
  }

  // ---- scrape embedded universal data for the first paint ----
  function scrapeEmbedded() {
    try {
      const el = document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
      if (!el) return;
      const data = JSON.parse(el.textContent);
      const out = [];
      harvest(data && data.__DEFAULT_SCOPE__, out, 0);
      const map = new Map();
      for (const r of out) map.set(r.id, r);
      send([...map.values()]);
    } catch (_) {}
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scrapeEmbedded);
  } else {
    scrapeEmbedded();
  }

  // Replay on demand: content script asks for everything it might have missed
  // (e.g. it loaded after the embedded blob was parsed).
  window.addEventListener("message", (e) => {
    if (e.source === window && e.data && e.data.source === "TBD_REQUEST_REPLAY") scrapeEmbedded();
  });
})();
