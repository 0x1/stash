/** Shared tab discovery for Stash scan / apply. */
(function (root) {
  /**
   * Prefer Watch Later (list=WL), else any YouTube tab, else the active tab.
   * @returns {Promise<chrome.tabs.Tab|null>}
   */
  async function findYoutubeTab() {
    const tabs = await chrome.tabs.query({});
    const wl = tabs.find(
      (t) =>
        t.url &&
        /youtube\.com/i.test(t.url) &&
        (/list=WL/i.test(t.url) || /watch_later/i.test(t.url))
    );
    if (wl) return wl;
    const anyYt = tabs.find((t) => t.url && /youtube\.com/i.test(t.url));
    if (anyYt) return anyYt;
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    return active || null;
  }

  /**
   * Prefer Watch Later; else any YouTube tab; null if none.
   * @returns {Promise<chrome.tabs.Tab|null>}
   */
  async function findYoutubeWlTab() {
    const tabs = await chrome.tabs.query({});
    const wl = tabs.find(
      (t) =>
        t.url &&
        /youtube\.com/i.test(t.url) &&
        (/list=WL/i.test(t.url) || /watch_later/i.test(t.url))
    );
    if (wl) return wl;
    const anyYt = tabs.find((t) => t.url && /youtube\.com/i.test(t.url));
    return anyYt || null;
  }

  root.StashTabs = { findYoutubeTab, findYoutubeWlTab };
})(typeof globalThis !== "undefined" ? globalThis : window);
