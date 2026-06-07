/*
 * Tests for the binary ORGANIC/BOOSTED classifier — the spec's worked examples
 * plus signal/scale/override coverage. Run: node test/classify.test.js
 *
 * Note: the spec's worked-example arithmetic has two minor slips vs its own
 * formula+tables (kittyweight S=-10 computes to -12; myjourney S3 at 3.07% is +1
 * by the table, the example shows +2 → S=8 not 10). We assert the VERDICT for
 * every case (all match) and the formula-exact confidence.
 */
const { classify } = require("../src/classify.js");

let pass = 0, fail = 0;
function check(name, raw, expVerdict, expConfApprox) {
  const r = classify(raw);
  let ok = r.verdict === expVerdict;
  if (ok && expConfApprox != null) ok = Math.abs(r.confidence - expConfApprox) <= 1;
  ok ? pass++ : fail++;
  console.log(`${ok ? "✓" : "✗"} ${name.padEnd(26)} ${(r.verdict + " " + r.confidence + "%").padEnd(16)} (exp ${expVerdict}${expConfApprox != null ? " ~" + expConfApprox + "%" : ""})  S=${r.score}${r.override ? " [override]" : ""} [${r.format}]`);
  if (!ok) console.log("    signals:", (r.signals || []).map(s => `${s.key}=${s.score}${s.included ? "" : "(skip)"}`).join(" "));
}

console.log("\n— Spec worked examples (verdict must match; confidence per formula) —");
// kittyweight 4M slideshow: L 12.1%, Sv 4.3%, Sv/L 35%, 300:1 -> ORGANIC (S=-12 -> 95%)
check("kittyweight", { views: 4e6, likes: 480000, saves: 172000, comments: 1600, isSlideshow: true }, "ORGANIC", 95);
// looksteacher 1.1M video: L 4.0% (now neutral 0), Sv 0.87% (neutral 0), Sv/L 22% (-1), 82:1 (0) -> S=-2 -> ORGANIC 58% (recalibrated: 4% likes is just average now)
check("looksteacher", { views: 1.1e6, likes: 44000, saves: 9570, comments: 537 }, "ORGANIC", 58);
// glowupcat 2.2M slideshow: promo label -> BOOSTED 99% (override)
check("glowupcat (promo)", { views: 2.2e6, likes: 200000, saves: 60000, comments: 500, isSlideshow: true, promoLabel: true }, "BOOSTED", 99);
// thefabstory 3.7M video: L 0.51%, Sv 0.06%, Sv/L 12%, 33:1, alive -> BOOSTED (S=8 -> 82%)
check("thefabstory", { views: 3.7e6, likes: 18800, saves: 2275, comments: 571, commentsAlive: true }, "BOOSTED", 82);
// myjourney 10M video: L 3.68% (neutral 0), Sv 0.11% (+2), Sv/L 3.07% (+1), 407:1 (+2), dead (+1) -> S=11 -> BOOSTED 94%
check("myjourney.app", { views: 10e6, likes: 367800, saves: 11300, comments: 903, commentsAlive: false }, "BOOSTED", 94);

console.log("\n— Hard override —");
check("promo override beats organic", { views: 4e6, likes: 484000, saves: 172000, comments: 1613, isSlideshow: true, promoLabel: true }, "BOOSTED", 99);
check("isAd maps to promo label", { views: 3.7e6, likes: 18800, saves: 2275, comments: 571, isAd: true }, "BOOSTED", 99);

console.log("\n— Views hidden (S1/S2 drop out; S = 2·S3 + S4 + S5, no view-scaling) —");
check("hidden, strong saves", { likes: 10000, saves: 3500, comments: 200 }, "ORGANIC"); // S3 35% -> -2
check("hidden, hollow saves", { likes: 10000, saves: 200, comments: 25 }, "BOOSTED"); // S3 2% -> +2

console.log("\n— Video vs slideshow saves bands —");
// saves/views 3% : video S2=-2 (≥2.5), slideshow S2=-1 (2.5–4.5)
check("3% saves video", { views: 1e6, likes: 50000, saves: 30000, comments: 800 }, "ORGANIC");
check("3% saves slideshow", { views: 1e6, likes: 50000, saves: 30000, comments: 800, isSlideshow: true }, "ORGANIC");

console.log("\n— Promo override toggle (opts.promoOverride) —");
// default ON: isAd -> override BOOSTED 99
function checkOpt(name, raw, opt, expVerdict, expConf) {
  const r = classify(raw, opt);
  let ok = r.verdict === expVerdict; if (ok && expConf != null) ok = Math.abs(r.confidence - expConf) <= 1;
  ok ? pass++ : fail++;
  console.log(`${ok ? "✓" : "✗"} ${name.padEnd(34)} ${(r.verdict + " " + r.confidence + "%").padEnd(14)} (exp ${expVerdict}${expConf != null ? " ~" + expConf + "%" : ""}) override=${r.override} suppressed=${r.overrideSuppressed}`);
}
// isAd post that is engagement-organic: override ON -> BOOSTED 99; OFF -> ORGANIC by math
checkOpt("isAd+organic, override ON", { views: 4e6, likes: 480000, saves: 172000, comments: 1600, isSlideshow: true, isAd: true }, { promoOverride: true }, "BOOSTED", 99);
checkOpt("isAd+organic, override OFF", { views: 4e6, likes: 480000, saves: 172000, comments: 1600, isSlideshow: true, isAd: true }, { promoOverride: false }, "ORGANIC", 95);
// isAd post that is also boosted by math: OFF still BOOSTED (via signals), not 99
checkOpt("isAd+boosted, override OFF", { views: 3.7e6, likes: 18800, saves: 2275, comments: 571, isAd: true }, { promoOverride: false }, "BOOSTED");
// suppressed flag set when override off + isAd present
(() => { const r = classify({ views: 4e6, likes: 480000, saves: 172000, comments: 1600, isAd: true }, { promoOverride: false });
  const ok = r.overrideSuppressed === true && r.override === false; ok ? pass++ : fail++;
  console.log(`${ok ? "✓" : "✗"} overrideSuppressed flag set when off+isAd`); })();

console.log("\n— Guards —");
check("no data", {}, "UNKNOWN", 0);

// Detailed score assertions for the two clean examples
const fab = classify({ views: 3.7e6, likes: 18800, saves: 2275, comments: 571, commentsAlive: true });
const look = classify({ views: 1.1e6, likes: 44000, saves: 9570, comments: 537 });
console.log("\n— Exact score checks —");
function eq(name, got, want) { const ok = got === want; ok ? pass++ : fail++; console.log(`${ok ? "✓" : "✗"} ${name}: ${got} (want ${want})`); }
eq("thefabstory S", fab.score, 8);
eq("thefabstory confidence", fab.confidence, 82);
eq("looksteacher S", look.score, -2);
eq("looksteacher confidence", look.confidence, 58);

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
