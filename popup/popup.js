// Popup: reflects + toggles settings, shows a live count of scored posts.
const box = document.getElementById("enabled");
const promo = document.getElementById("promoOverride");

chrome.storage.sync.get({ enabled: true, promoOverride: true }, (s) => {
  box.checked = s.enabled !== false;
  promo.checked = s.promoOverride !== false;
});
box.addEventListener("change", () => chrome.storage.sync.set({ enabled: box.checked }));
promo.addEventListener("change", () => chrome.storage.sync.set({ promoOverride: promo.checked }));

// Ask the active tab's content script how many posts it has badged.
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs[0];
  if (!tab || !/tiktok\.com/.test(tab.url || "")) return;
  chrome.tabs.sendMessage(tab.id, { type: "TBD_COUNT" }, (resp) => {
    if (chrome.runtime.lastError) return; // content script not ready
    if (resp && typeof resp.count === "number") {
      document.getElementById("count").textContent = resp.count;
    }
  });
});
