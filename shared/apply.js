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
    if (!add?.ok) {
      // Row already gone from WL — nothing to add/remove; drop the stash mark
      if (/row not found/i.test(String(add?.error || ""))) {
        return { ok: true, alreadyGone: true, added: false };
      }
      return { ok: false, stage: "add", error: add?.error, needsApi: add?.needsApi };
    }
    await sleep(400);
    const rm = await sendAction(tabId, "STASH_REMOVE_FROM_WL", { videoId });
    // Remove stage: alreadyGone counts as success for dropping the stash mark
    if (rm?.alreadyGone) {
      return { ok: true, alreadyGone: true, added: true };
    }
    if (!rm?.ok) return { ok: false, stage: "remove", error: rm?.error, added: true };
    return { ok: true, alreadyGone: false };
  }

  function ytMarked(all, status) {
    return all.filter((i) => i.status === status && i.source === "youtube" && i.videoId);
  }

  function normalizePlaylistName(s) {
    return String(s || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  /** Prefer id; else case-insensitive trimmed name match in cached playlists. */
  function findCachedPlaylist(playlists, playlistId, playlistName) {
    const list = Array.isArray(playlists) ? playlists : [];
    if (playlistId) {
      const byId = list.find((p) => p && p.id === playlistId);
      if (byId) return byId;
    }
    if (playlistName) {
      const n = normalizePlaylistName(playlistName);
      if (n) {
        const byName = list.find((p) => normalizePlaylistName(p?.name) === n);
        if (byName) return byName;
      }
    }
    return null;
  }

  function resolvePlaylistDest(playlists, playlistId, playlistName, fallbackName) {
    const name = (playlistName || fallbackName || "").trim();
    const id = playlistId || "";
    const hit = findCachedPlaylist(playlists, id, name);
    if (hit) {
      return {
        playlistId: hit.id || id || "",
        playlistName: (hit.name || name || "").trim(),
      };
    }
    return { playlistId: id, playlistName: name };
  }

  /** Quiet STASH_LIST_PLAYLISTS + cache write. Returns playlists array (maybe empty). */
  async function listPlaylistsQuiet() {
    const existing = root.StashStorage?.getPlaylists
      ? await root.StashStorage.getPlaylists()
      : [];
    const tab = await findYoutubeTab();
    if (!tab?.id) return Array.isArray(existing) ? existing : [];
    const ready = await ensureContentScript(tab.id);
    if (!ready) return Array.isArray(existing) ? existing : [];
    const res = await sendAction(tab.id, "STASH_LIST_PLAYLISTS", {});
    if (res?.ok && Array.isArray(res.playlists)) {
      if (root.StashStorage?.setPlaylists) {
        try {
          await root.StashStorage.setPlaylists(res.playlists);
        } catch {
          /* ignore */
        }
      }
      return res.playlists;
    }
    return Array.isArray(existing) ? existing : [];
  }

  /**
   * Soft preflight for maybe destination.
   * @returns {Promise<null | string>} confirm message when cache misses; null to skip confirm.
   */
  async function maybePlaylistPreflightMessage(stashConfig, work) {
    const cfg = stashConfig || {};
    if (!work || !(work.maybes > 0) || cfg.applyAddsMaybe === false) return null;
    let playlists = root.StashStorage?.getPlaylists
      ? await root.StashStorage.getPlaylists()
      : [];
    if (!Array.isArray(playlists) || !playlists.length) {
      playlists = await listPlaylistsQuiet();
    }
    const name = (cfg.maybePlaylistName || "Maybe Watch Later").trim();
    const id = cfg.maybePlaylistId || "";
    if (findCachedPlaylist(playlists, id, name)) return null;
    return (
      `No playlist "${name}" in cache. Apply will search/scroll the Save menu ` +
      `(or pick one in deck ⚙). Continue anyway?`
    );
  }

  function resolveYesMode(cfg) {
    return cfg.yesMode === "playlist" || cfg.yesMode === "move_playlist" ? "playlist" : "keep_wl";
  }

  /**
   * Count marked items vs items that Apply will actually act on.
   * @returns {{ nos:number, maybes:number, yeses:number, markedNo:number, markedMaybe:number, markedYes:number, yesMode:string, hasWork:boolean }}
   */
  function countApplyWork(stashItems, stashConfig) {
    const cfg = stashConfig || {};
    const all = Object.values(stashItems || {});
    const markedNo = ytMarked(all, "no");
    const markedMaybe = ytMarked(all, "maybe");
    const markedYes = ytMarked(all, "yes");
    const yesMode = resolveYesMode(cfg);
    const nos = cfg.applyRemovesNo !== false ? markedNo : [];
    const maybes = cfg.applyAddsMaybe !== false ? markedMaybe : [];
    const yeses =
      cfg.applyHandlesYes !== false && yesMode === "playlist" ? markedYes : [];
    return {
      nos: nos.length,
      maybes: maybes.length,
      yeses: yeses.length,
      markedNo: markedNo.length,
      markedMaybe: markedMaybe.length,
      markedYes: markedYes.length,
      yesMode,
      hasWork: nos.length + maybes.length + yeses.length > 0,
    };
  }

  /** Human-readable status line for Apply result (deck + sidepanel). */
  function formatApplyStatus(result) {
    if (!result) return "apply failed";

    if (result.needWlTab) {
      return result.error || "Open youtube.com/playlist?list=WL in a tab, then Apply again";
    }

    if (result.nothingToApply) {
      const n = result.markedNo ?? 0;
      const m = result.markedMaybe ?? 0;
      const y = result.markedYes ?? 0;
      const counts = `${n} no · ${m} maybe · ${y} yes in stash`;
      if (n === 0 && m === 0 && y > 0 && result.yesMode === "keep_wl") {
        return `nothing to apply — yes stays on Watch Later (set Yes destination in ⚙ config to move) (${counts})`;
      }
      return `nothing to apply — mark some videos no / maybe / yes first (${counts})`;
    }

    if (!result.ok && result.error) {
      return result.error;
    }

    const removed = result.removed ?? 0;
    const maybeMoved = result.maybeMoved ?? 0;
    const yesMoved = result.yesMoved ?? 0;
    const alreadyGone = result.alreadyGone ?? 0;
    const stashDropped = result.stashDropped ?? 0;

    // Apply only cleared stale marks (already off Watch Later)
    if (
      result.staleOnly ||
      (alreadyGone > 0 &&
        removed === 0 &&
        maybeMoved === 0 &&
        yesMoved === 0 &&
        !(result.failed && result.failed.length))
    ) {
      const n = alreadyGone || stashDropped;
      return `cleared ${n} stale mark${n === 1 ? "" : "s"} (already off Watch Later)`;
    }

    let msg = `removed ${removed} · maybe moved ${maybeMoved} · yes moved ${yesMoved}`;
    if (alreadyGone > 0) {
      msg += ` · skipped ${alreadyGone} already gone`;
    }

    if (removed === 0 && maybeMoved === 0 && yesMoved === 0 && alreadyGone === 0 && !result.error) {
      msg += " · nothing changed";
    }

    if (result.failed?.length) {
      msg += ` · fails: ${result.failed.slice(0, 3).join("; ")}`;
    }

    if (result.error) {
      msg += ` · ${result.error}`;
    }

    return msg;
  }

  function itemLabel(it) {
    const title = (it?.title || "").replace(/\s+/g, " ").trim();
    if (title) return title.length > 42 ? title.slice(0, 41) + "…" : title;
    return it?.videoId || "?";
  }

  const APPLY_PROGRESS_KEY = "stashApplyProgress";

  function broadcastProgress(payload) {
    if (!chrome?.storage?.local) return;
    try {
      if (payload == null) {
        chrome.storage.local.remove(APPLY_PROGRESS_KEY).catch(() => {});
        return;
      }
      const data = {};
      data[APPLY_PROGRESS_KEY] = { ...payload, ts: Date.now() };
      chrome.storage.local.set(data).catch(() => {});
    } catch {
      /* ignore */
    }
  }

  async function tryOpenSidePanel(tab) {
    try {
      if (!chrome?.sidePanel?.open || !tab) return;
      if (tab.windowId != null) {
        await chrome.sidePanel.open({ windowId: tab.windowId });
        return;
      }
      if (tab.id != null) {
        await chrome.sidePanel.open({ tabId: tab.id });
      }
    } catch {
      /* ignore — side panel may already be open or API restricted */
    }
  }

  /**
   * @param {{ onProgress?: (msg: string | object) => void }} opts
   * @returns {Promise<{ok:boolean, removed:number, maybeAdded:number, maybeMoved:number, yesMoved:number, failed:string[], needWlTab?:boolean, nothingToApply?:boolean, markedNo?:number, markedMaybe?:number, markedYes?:number, yesMode?:string, error?:string}>}
   */
  async function applyDecisions(opts = {}) {
    const onProgress = opts.onProgress || (() => {});
    const { stashItems, stashConfig } = await root.StashStorage.getAll();
    const cfg = stashConfig;
    const all = Object.values(stashItems);
    const work = countApplyWork(stashItems, cfg);

    const nos = cfg.applyRemovesNo ? ytMarked(all, "no") : [];
    const maybes = cfg.applyAddsMaybe ? ytMarked(all, "maybe") : [];
    const yesMode = work.yesMode;
    const yeses =
      cfg.applyHandlesYes && yesMode === "playlist" ? ytMarked(all, "yes") : [];

    const total = nos.length + maybes.length + yeses.length;
    const failed = [];
    let removed = 0;
    let maybeAdded = 0;
    let maybeMoved = 0;
    let yesMoved = 0;
    let alreadyGone = 0;
    let done = 0;

    function emit(partial) {
      const payload = {
        phase: partial.phase || "running",
        message: partial.message || "",
        done: partial.done != null ? partial.done : done,
        total: partial.total != null ? partial.total : total,
        currentTitle: partial.currentTitle || "",
        currentVideoId: partial.currentVideoId || "",
        removed,
        maybeMoved,
        yesMoved,
        alreadyGone,
        failed: failed.slice(),
      };
      if (partial.nothingToApply) payload.nothingToApply = true;
      if (partial.needWlTab) payload.needWlTab = true;
      try {
        onProgress(payload);
      } catch {
        /* ignore UI errors */
      }
      broadcastProgress(payload);
    }

    const nosNeedAction = nos.length > 0;
    const maybesNeedAction = maybes.length > 0;
    const yesesNeedAction = yeses.length > 0;

    if (!nosNeedAction && !maybesNeedAction && !yesesNeedAction) {
      const result = {
        ok: true,
        removed: 0,
        maybeAdded: 0,
        maybeMoved: 0,
        yesMoved: 0,
        failed: [],
        nothingToApply: true,
        markedNo: work.markedNo,
        markedMaybe: work.markedMaybe,
        markedYes: work.markedYes,
        yesMode,
        error: "nothing to apply",
      };
      emit({
        phase: "done",
        message: formatApplyStatus(result),
        done: 0,
        total: 0,
        nothingToApply: true,
      });
      return result;
    }

    // Clear prior run so the other surface (side panel / deck) resets
    broadcastProgress(null);

    let tab = await findYoutubeWlTab();
    if (!tab?.id) {
      const result = {
        ok: false,
        removed: 0,
        maybeAdded: 0,
        maybeMoved: 0,
        yesMoved: 0,
        failed: [],
        needWlTab: true,
        error: "Open youtube.com/playlist?list=WL in a tab, then Apply again",
      };
      emit({
        phase: "failed",
        message: result.error,
        done: 0,
        total,
        needWlTab: true,
      });
      return result;
    }

    try {
      await chrome.tabs.update(tab.id, { active: true });
      if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
    } catch {
      /* ignore */
    }

    // Keep/open side panel so user can watch progress while WL tab is focused
    await tryOpenSidePanel(tab);

    const ready = await ensureContentScript(tab.id);
    if (!ready) {
      const result = {
        ok: false,
        removed: 0,
        maybeAdded: 0,
        maybeMoved: 0,
        yesMoved: 0,
        failed: [],
        error: "Content script unavailable — reload the YouTube tab",
      };
      emit({
        phase: "failed",
        message: result.error,
        done: 0,
        total,
      });
      return result;
    }

    const stashIdsToDrop = [];
    const noMode = cfg.noMode === "playlist" ? "playlist" : "remove";

    emit({
      phase: "start",
      message: `Applying ${total}…`,
      done: 0,
      total,
    });

    if (nos.length) {
      if (noMode === "playlist" && (cfg.noPlaylistId || cfg.noPlaylistName)) {
        const dest = cfg.noPlaylistName || cfg.noPlaylistId;
        for (const it of nos) {
          emit({
            phase: "no",
            message: `${done} / ${total} · moving no · ${itemLabel(it)}`,
            done,
            currentTitle: itemLabel(it),
            currentVideoId: it.videoId || "",
          });
          const res = await addThenRemove(tab.id, it.videoId, cfg.noPlaylistId, cfg.noPlaylistName);
          if (res.ok || res.alreadyGone) {
            if (res.alreadyGone) alreadyGone += 1;
            else removed += 1;
            if (it.id) stashIdsToDrop.push(it.id);
          } else {
            const hint = res.needsApi ? " (create playlist first / DOM save menu)" : "";
            failed.push(`no-${res.stage} ${it.videoId}: ${res.error || "fail"}${hint}`);
            // add succeeded but remove alreadyGone should not reach here (ok:true);
            // still drop if remove-stage alreadyGone leaked as fail
            if (res.stage === "remove" && res.alreadyGone && it.id) {
              alreadyGone += 1;
              stashIdsToDrop.push(it.id);
            }
          }
          done += 1;
          emit({
            phase: "no",
            message: `${done} / ${total} · moving no · ${itemLabel(it)}`,
            done,
            currentTitle: itemLabel(it),
            currentVideoId: it.videoId || "",
          });
          await sleep(550);
        }
      } else {
        for (const it of nos) {
          emit({
            phase: "no",
            message: `${done} / ${total} · removing no · ${itemLabel(it)}`,
            done,
            currentTitle: itemLabel(it),
            currentVideoId: it.videoId || "",
          });
          const res = await sendAction(tab.id, "STASH_REMOVE_FROM_WL", { videoId: it.videoId });
          if (res?.ok || res?.alreadyGone) {
            if (res?.alreadyGone) alreadyGone += 1;
            else removed += 1;
            if (it.id) stashIdsToDrop.push(it.id);
          } else failed.push(`no ${it.videoId}: ${res?.error || "fail"}`);
          done += 1;
          emit({
            phase: "no",
            message: `${done} / ${total} · removing no · ${itemLabel(it)}`,
            done,
            currentTitle: itemLabel(it),
            currentVideoId: it.videoId || "",
          });
          await sleep(450);
        }
      }
    }

    let playlistsCache = [];
    try {
      playlistsCache = root.StashStorage?.getPlaylists
        ? await root.StashStorage.getPlaylists()
        : [];
    } catch {
      playlistsCache = [];
    }
    if (!Array.isArray(playlistsCache)) playlistsCache = [];

    const maybeResolved = resolvePlaylistDest(
      playlistsCache,
      cfg.maybePlaylistId || "",
      cfg.maybePlaylistName || "",
      "Maybe Watch Later"
    );
    const maybeName = maybeResolved.playlistName || "Maybe Watch Later";
    const maybeId = maybeResolved.playlistId || "";
    if (maybes.length) {
      for (const it of maybes) {
        emit({
          phase: "maybe",
          message: `${done} / ${total} · moving maybe · ${itemLabel(it)}`,
          done,
          currentTitle: itemLabel(it),
          currentVideoId: it.videoId || "",
        });
        const res = await addThenRemove(tab.id, it.videoId, maybeId, maybeName);
        if (!res.ok && !res.alreadyGone) {
          const hint = res.needsApi ? " (create playlist first / DOM save menu)" : "";
          failed.push(`maybe-${res.stage} ${it.videoId}: ${res.error || "fail"}${hint}`);
          if (res.added) maybeAdded += 1;
          // add ok + remove alreadyGone should be ok:true; belt-and-suspenders drop
          if (res.stage === "remove" && res.alreadyGone && it.id) {
            alreadyGone += 1;
            stashIdsToDrop.push(it.id);
          }
          done += 1;
          emit({
            phase: "maybe",
            message: `${done} / ${total} · moving maybe · ${itemLabel(it)}`,
            done,
            currentTitle: itemLabel(it),
            currentVideoId: it.videoId || "",
          });
          await sleep(550);
          continue;
        }
        maybeAdded += 1;
        if (res.alreadyGone) {
          alreadyGone += 1;
        } else {
          maybeMoved += 1;
          removed += 1;
        }
        if (it.id) stashIdsToDrop.push(it.id);
        done += 1;
        emit({
          phase: "maybe",
          message: `${done} / ${total} · moving maybe · ${itemLabel(it)}`,
          done,
          currentTitle: itemLabel(it),
          currentVideoId: it.videoId || "",
        });
        await sleep(550);
      }
    }

    if (yeses.length) {
      const yesResolved = resolvePlaylistDest(
        playlistsCache,
        cfg.yesPlaylistId || "",
        cfg.yesPlaylistName || "",
        "Stash Yes"
      );
      const yesName = yesResolved.playlistName || "Stash Yes";
      const yesId = yesResolved.playlistId || "";
      for (const it of yeses) {
        emit({
          phase: "yes",
          message: `${done} / ${total} · moving yes · ${itemLabel(it)}`,
          done,
          currentTitle: itemLabel(it),
          currentVideoId: it.videoId || "",
        });
        const res = await addThenRemove(tab.id, it.videoId, yesId, yesName);
        if (!res.ok && !res.alreadyGone) {
          failed.push(`yes-${res.stage} ${it.videoId}: ${res.error || "fail"}`);
          if (res.stage === "remove" && res.alreadyGone && it.id) {
            alreadyGone += 1;
            stashIdsToDrop.push(it.id);
          }
          done += 1;
          emit({
            phase: "yes",
            message: `${done} / ${total} · moving yes · ${itemLabel(it)}`,
            done,
            currentTitle: itemLabel(it),
            currentVideoId: it.videoId || "",
          });
          await sleep(450);
          continue;
        }
        if (res.alreadyGone) alreadyGone += 1;
        else yesMoved += 1;
        // Yes moved off WL (or already gone) → drop from stash so pie totals match live WL
        if (it.id) stashIdsToDrop.push(it.id);
        done += 1;
        emit({
          phase: "yes",
          message: `${done} / ${total} · moving yes · ${itemLabel(it)}`,
          done,
          currentTitle: itemLabel(it),
          currentVideoId: it.videoId || "",
        });
        await sleep(550);
      }
    }

    if (stashIdsToDrop.length && root.StashStorage?.removeIds) {
      const latest = await root.StashStorage.getAll();
      const cleaned = root.StashStorage.removeIds(latest.stashItems, stashIdsToDrop);
      await root.StashStorage.setItems(cleaned.items);
    }

    const result = {
      ok: true,
      removed,
      maybeAdded,
      maybeMoved,
      yesMoved,
      alreadyGone,
      failed,
      stashDropped: stashIdsToDrop.length,
      staleOnly:
        alreadyGone > 0 &&
        removed === 0 &&
        maybeMoved === 0 &&
        yesMoved === 0 &&
        failed.length === 0,
    };
    const anyOk = removed > 0 || maybeMoved > 0 || yesMoved > 0 || alreadyGone > 0;
    const endPhase = failed.length && !anyOk ? "failed" : "done";
    emit({
      phase: endPhase,
      message:
        endPhase === "failed"
          ? "Failed"
          : result.staleOnly
            ? formatApplyStatus(result)
            : "Done",
      done: total,
      total,
      currentTitle: "",
      currentVideoId: "",
    });
    return result;
  }

  root.StashApply = {
    applyDecisions,
    findYoutubeWlTab,
    findYoutubeTab,
    countApplyWork,
    formatApplyStatus,
    findCachedPlaylist,
    resolvePlaylistDest,
    listPlaylistsQuiet,
    maybePlaylistPreflightMessage,
    normalizePlaylistName,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
