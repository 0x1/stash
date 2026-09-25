/** Apply triage decisions to YouTube via content-script DOM automation. */
(function (root) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function findYoutubeWlTab() {
    if (root.StashTabs?.findYoutubeWlTab) return root.StashTabs.findYoutubeWlTab();
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

  async function findYoutubeTab() {
    if (root.StashTabs?.findYoutubeTab) return root.StashTabs.findYoutubeTab();
    const wlOrYt = await findYoutubeWlTab();
    if (wlOrYt) return wlOrYt;
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    return active || null;
  }

  async function ensureContentScript(tabId) {
    try {
      const ping = await chrome.tabs.sendMessage(tabId, { type: "STASH_PING" });
      if (ping?.ok) return true;
    } catch {
      /* inject */
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content/youtube.js"],
      });
      await sleep(200);
      const ping2 = await chrome.tabs.sendMessage(tabId, { type: "STASH_PING" });
      return !!ping2?.ok;
    } catch {
      return false;
    }
  }

  async function sendAction(tabId, type, payload) {
    try {
      return await chrome.tabs.sendMessage(tabId, { type, ...payload });
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  async function addThenRemove(tabId, videoId, playlistId, playlistName) {
    const add = await sendAction(tabId, "STASH_ADD_TO_PLAYLIST", {
      videoId,
      playlistId: playlistId || undefined,
      playlistName: playlistName || undefined,
    });
    if (!add?.ok) return { ok: false, stage: "add", error: add?.error, needsApi: add?.needsApi };
    await sleep(400);
    const rm = await sendAction(tabId, "STASH_REMOVE_FROM_WL", { videoId });
    if (!rm?.ok) return { ok: false, stage: "remove", error: rm?.error, added: true };
    return { ok: true };
  }

  /**
   * @param {{ onProgress?: (msg: string) => void }} opts
   * @returns {Promise<{ok:boolean, removed:number, maybeAdded:number, maybeMoved:number, yesMoved:number, failed:string[], needWlTab?:boolean, error?:string}>}
   */
  async function applyDecisions(opts = {}) {
    const progress = opts.onProgress || (() => {});
    const { stashItems, stashConfig } = await root.StashStorage.getAll();
    const cfg = stashConfig;
    const all = Object.values(stashItems);

    const nos = cfg.applyRemovesNo ? all.filter((i) => i.status === "no" && i.source === "youtube" && i.videoId) : [];
    const maybes = cfg.applyAddsMaybe
      ? all.filter((i) => i.status === "maybe" && i.source === "youtube" && i.videoId)
      : [];
    const yesMode = cfg.yesMode === "playlist" || cfg.yesMode === "move_playlist" ? "playlist" : "keep_wl";
    const yeses =
      cfg.applyHandlesYes && yesMode === "playlist"
        ? all.filter((i) => i.status === "yes" && i.source === "youtube" && i.videoId)
        : [];

    const noMode = cfg.noMode === "playlist" ? "playlist" : "remove";
    const nosNeedAction = nos.length > 0;
    const maybesNeedAction = maybes.length > 0;
    const yesesNeedAction = yeses.length > 0;

    if (!nosNeedAction && !maybesNeedAction && !yesesNeedAction) {
      return {
        ok: true,
        removed: 0,
        maybeAdded: 0,
        maybeMoved: 0,
        yesMoved: 0,
        failed: [],
        error: "nothing to apply",
      };
    }

    let tab = await findYoutubeWlTab();
    if (!tab?.id) {
      return {
        ok: false,
        removed: 0,
        maybeAdded: 0,
        maybeMoved: 0,
        yesMoved: 0,
        failed: [],
        needWlTab: true,
        error: "Open youtube.com/playlist?list=WL in a tab, then Apply again",
      };
    }

    try {
      await chrome.tabs.update(tab.id, { active: true });
      if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
    } catch {
      /* ignore */
    }

    const ready = await ensureContentScript(tab.id);
    if (!ready) {
      return {
        ok: false,
        removed: 0,
        maybeAdded: 0,
        maybeMoved: 0,
        yesMoved: 0,
        failed: [],
        error: "Content script unavailable — reload the YouTube tab",
      };
    }

    const failed = [];
    let removed = 0;
    let maybeAdded = 0;
    let maybeMoved = 0;
    let yesMoved = 0;

    if (nos.length) {
      if (noMode === "playlist" && (cfg.noPlaylistId || cfg.noPlaylistName)) {
        const dest = cfg.noPlaylistName || cfg.noPlaylistId;
        progress(`Moving ${nos.length} no → "${dest}" then off WL…`);
        for (const it of nos) {
          const res = await addThenRemove(tab.id, it.videoId, cfg.noPlaylistId, cfg.noPlaylistName);
          if (!res.ok) {
            const hint = res.needsApi ? " (create playlist first / DOM save menu)" : "";
            failed.push(`no-${res.stage} ${it.videoId}: ${res.error || "fail"}${hint}`);
          } else {
            removed += 1;
          }
          await sleep(550);
        }
      } else {
        progress(`Removing ${nos.length} no…`);
        for (const it of nos) {
          const res = await sendAction(tab.id, "STASH_REMOVE_FROM_WL", { videoId: it.videoId });
          if (res?.ok) removed += 1;
          else failed.push(`no ${it.videoId}: ${res?.error || "fail"}`);
          await sleep(450);
        }
      }
    }

    const maybeName = cfg.maybePlaylistName || "Maybe Watch Later";
    const maybeId = cfg.maybePlaylistId || "";
    if (maybes.length) {
      progress(`Moving ${maybes.length} maybe → "${maybeName}" then off WL…`);
      for (const it of maybes) {
        const res = await addThenRemove(tab.id, it.videoId, maybeId, maybeName);
        if (!res.ok) {
          const hint = res.needsApi ? " (create playlist first / DOM save menu)" : "";
          failed.push(`maybe-${res.stage} ${it.videoId}: ${res.error || "fail"}${hint}`);
          if (res.added) maybeAdded += 1;
          await sleep(550);
          continue;
        }
        maybeAdded += 1;
        maybeMoved += 1;
        removed += 1;
        await sleep(550);
      }
    }

    if (yeses.length) {
      const yesName = cfg.yesPlaylistName || "Stash Yes";
      const yesId = cfg.yesPlaylistId || "";
      progress(`Moving ${yeses.length} yes → "${yesName}"…`);
      for (const it of yeses) {
        const res = await addThenRemove(tab.id, it.videoId, yesId, yesName);
        if (!res.ok) {
          failed.push(`yes-${res.stage} ${it.videoId}: ${res.error || "fail"}`);
          await sleep(450);
          continue;
        }
        yesMoved += 1;
        await sleep(550);
      }
    }

    progress("done");
    return { ok: true, removed, maybeAdded, maybeMoved, yesMoved, failed };
  }

  root.StashApply = { applyDecisions, findYoutubeWlTab, findYoutubeTab };
})(typeof globalThis !== "undefined" ? globalThis : window);
