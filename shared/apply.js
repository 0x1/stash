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

  function ytMarked(all, status) {
    return all.filter((i) => i.status === status && i.source === "youtube" && i.videoId);
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
    let msg = `removed ${removed} · maybe moved ${maybeMoved} · yes moved ${yesMoved}`;

    if (removed === 0 && maybeMoved === 0 && yesMoved === 0 && !result.error) {
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
        failed: failed.slice(),
      };
      try {
        onProgress(payload);
      } catch {
        /* ignore UI errors */
      }
    }

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
        nothingToApply: true,
        markedNo: work.markedNo,
        markedMaybe: work.markedMaybe,
        markedYes: work.markedYes,
        yesMode,
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
          if (!res.ok) {
            const hint = res.needsApi ? " (create playlist first / DOM save menu)" : "";
            failed.push(`no-${res.stage} ${it.videoId}: ${res.error || "fail"}${hint}`);
          } else {
            removed += 1;
            if (it.id) stashIdsToDrop.push(it.id);
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
          if (res?.ok) {
            removed += 1;
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

    const maybeName = cfg.maybePlaylistName || "Maybe Watch Later";
    const maybeId = cfg.maybePlaylistId || "";
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
        if (!res.ok) {
          const hint = res.needsApi ? " (create playlist first / DOM save menu)" : "";
          failed.push(`maybe-${res.stage} ${it.videoId}: ${res.error || "fail"}${hint}`);
          if (res.added) maybeAdded += 1;
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
        maybeMoved += 1;
        removed += 1;
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
      const yesName = cfg.yesPlaylistName || "Stash Yes";
      const yesId = cfg.yesPlaylistId || "";
      for (const it of yeses) {
        emit({
          phase: "yes",
          message: `${done} / ${total} · moving yes · ${itemLabel(it)}`,
          done,
          currentTitle: itemLabel(it),
          currentVideoId: it.videoId || "",
        });
        const res = await addThenRemove(tab.id, it.videoId, yesId, yesName);
        if (!res.ok) {
          failed.push(`yes-${res.stage} ${it.videoId}: ${res.error || "fail"}`);
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
        yesMoved += 1;
        // Yes moved off WL → drop from stash so pie totals match live WL
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
      failed,
      stashDropped: stashIdsToDrop.length,
    };
    const anyOk = removed > 0 || maybeMoved > 0 || yesMoved > 0;
    const endPhase = failed.length && !anyOk ? "failed" : "done";
    emit({
      phase: endPhase,
      message: endPhase === "failed" ? "Failed" : "Done",
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
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
