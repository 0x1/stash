/** Shared storage helpers for Stash deck. */
(function (root) {
  const DEFAULT_CONFIG = {
    noMode: "remove", // remove | playlist
    noPlaylistId: "",
    noPlaylistName: "",
    maybePlaylistId: "",
    maybePlaylistName: "Maybe Watch Later",
    yesMode: "keep_wl", // keep_wl | playlist  (legacy: move_playlist → playlist)
    yesPlaylistId: "",
    yesPlaylistName: "Stash Yes",
    applyRemovesNo: true,
    applyAddsMaybe: true,
    applyHandlesYes: true,
    timeBudgetMinutes: 120,
  };

  function isUncategorizedStatus(status) {
    return status === "uncategorized" || status === "inbox" || !status;
  }

  function migrateInbox(stashItems) {
    const items = { ...(stashItems || {}) };
    let changed = false;
    for (const id of Object.keys(items)) {
      if (items[id]?.status === "inbox") {
        items[id] = { ...items[id], status: "uncategorized" };
        changed = true;
      }
    }
    return { items, changed };
  }

  function migrateConfig(raw) {
    const cfg = { ...DEFAULT_CONFIG, ...(raw || {}) };
    if (cfg.yesMode === "move_playlist") cfg.yesMode = "playlist";
    if (cfg.noMode !== "playlist") cfg.noMode = "remove";
    if (cfg.yesMode !== "playlist") cfg.yesMode = "keep_wl";
    const mins = Number(cfg.timeBudgetMinutes);
    cfg.timeBudgetMinutes =
      Number.isFinite(mins) && mins >= 0 ? Math.round(mins) : DEFAULT_CONFIG.timeBudgetMinutes;
    return cfg;
  }

  async function getAll() {
    const data = await chrome.storage.local.get({
      stashItems: {},
      stashConfig: DEFAULT_CONFIG,
      stashUndo: [],
      stashPlaylists: [],
    });
    let stashItems = data.stashItems || {};
    const { items, changed } = migrateInbox(stashItems);
    if (changed) {
      stashItems = items;
      await chrome.storage.local.set({ stashItems });
    }
    const stashConfig = migrateConfig(data.stashConfig);
    // Persist yesMode migration if needed
    if (data.stashConfig?.yesMode === "move_playlist") {
      await chrome.storage.local.set({ stashConfig });
    }
    return {
      stashItems,
      stashConfig,
      stashUndo: Array.isArray(data.stashUndo) ? data.stashUndo : [],
      stashPlaylists: Array.isArray(data.stashPlaylists) ? data.stashPlaylists : [],
    };
  }

  async function setItems(stashItems) {
    await chrome.storage.local.set({ stashItems });
  }

  async function setConfig(stashConfig) {
    await chrome.storage.local.set({ stashConfig: migrateConfig(stashConfig) });
  }

  async function setUndo(stashUndo) {
    await chrome.storage.local.set({ stashUndo });
  }

  async function getPlaylists() {
    const data = await chrome.storage.local.get({ stashPlaylists: [] });
    return Array.isArray(data.stashPlaylists) ? data.stashPlaylists : [];
  }

  async function setPlaylists(stashPlaylists) {
    const list = Array.isArray(stashPlaylists) ? stashPlaylists : [];
    await chrome.storage.local.set({ stashPlaylists: list });
  }

  function isDurationLikeTitle(text) {
    if (text == null) return false;
    const t = String(text).replace(/\s+/g, " ").trim();
    if (!t) return false;
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(t)) return true;
    if (/^\d+\s*(hours?|minutes?|seconds?)(\s+\d+\s*(hours?|minutes?|seconds?))*\.?$/i.test(t)) {
      return true;
    }
    return false;
  }

  function isWeakStoredTitle(text) {
    if (text == null) return true;
    const t = String(text).trim();
    if (!t || t === "(untitled)") return true;
    if (isDurationLikeTitle(t)) return true;
    if (/^\d+\s+videos?$/i.test(t)) return true;
    return false;
  }

  function parseDurationText(text) {
    if (!text) return null;
    const parts = String(text).trim().split(":").map((p) => parseInt(p, 10));
    if (parts.some((n) => Number.isNaN(n))) return null;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 1) return parts[0];
    return null;
  }

  function pickMergedTitle(rawTitle, prevTitle) {
    const rawWeak = isWeakStoredTitle(rawTitle);
    const prevWeak = isWeakStoredTitle(prevTitle);
    if (!rawWeak && prevWeak) return String(rawTitle).trim();
    if (!rawWeak) return String(rawTitle).trim();
    if (!prevWeak) return prevTitle;
    return (rawTitle && String(rawTitle).trim()) || prevTitle || "(untitled)";
  }

  function mergeScraped(existing, scrapedItems) {
    const { items: base } = migrateInbox(existing);
    const items = { ...base };
    let added = 0;
    const now = Date.now();
    for (const raw of scrapedItems || []) {
      if (!raw?.id) continue;
      const prev = items[raw.id];
      if (prev) {
        const prevStatus = isUncategorizedStatus(prev.status) ? "uncategorized" : prev.status;
        let durationText = raw.durationText || prev.durationText || null;
        let durationSec = raw.durationSec ?? prev.durationSec ?? null;
        // If prev title was a mis-parsed duration and incoming has a real title, recover duration
        if (
          !durationText &&
          isDurationLikeTitle(prev.title) &&
          raw.title &&
          !isDurationLikeTitle(raw.title)
        ) {
          durationText = String(prev.title).trim();
          durationSec = parseDurationText(durationText) ?? durationSec;
        }
        if (!durationText && isDurationLikeTitle(raw.title) && !isWeakStoredTitle(prev.title)) {
          durationText = String(raw.title).trim();
          durationSec = parseDurationText(durationText) ?? durationSec;
        }
        if (durationSec == null && durationText) {
          durationSec = parseDurationText(durationText);
        }
        const title = pickMergedTitle(raw.title, prev.title);
        items[raw.id] = {
          ...prev,
          status: prevStatus,
          title,
          url: raw.url || prev.url,
          videoId: raw.videoId || prev.videoId,
          durationSec,
          durationText,
          thumbnailUrl: raw.thumbnailUrl || prev.thumbnailUrl,
          channel: raw.channel || prev.channel,
          channelUrl: raw.channelUrl || prev.channelUrl,
          channelThumbUrl: raw.channelThumbUrl || prev.channelThumbUrl,
          publishedText: raw.publishedText || prev.publishedText,
          publishedAt: raw.publishedAt || prev.publishedAt,
          viewsText: raw.viewsText || prev.viewsText,
          viewsCount: raw.viewsCount ?? prev.viewsCount,
          lastSeenAt: now,
        };
      } else {
        let title = raw.title || "(untitled)";
        let durationText = raw.durationText || null;
        let durationSec = raw.durationSec ?? null;
        if (isDurationLikeTitle(title)) {
          if (!durationText) {
            durationText = String(title).trim();
            durationSec = parseDurationText(durationText) ?? durationSec;
          }
          title = "(untitled)";
        }
        items[raw.id] = {
          id: raw.id,
          source: raw.source || "youtube",
          title,
          url: raw.url || "",
          videoId: raw.videoId || null,
          durationSec,
          durationText,
          thumbnailUrl: raw.thumbnailUrl || null,
          channel: raw.channel || null,
          channelUrl: raw.channelUrl || null,
          channelThumbUrl: raw.channelThumbUrl || null,
          publishedText: raw.publishedText || null,
          publishedAt: raw.publishedAt || null,
          viewsText: raw.viewsText || null,
          viewsCount: raw.viewsCount ?? null,
          status: "uncategorized",
          scrapedAt: raw.scrapedAt || now,
          lastSeenAt: now,
        };
        added += 1;
      }
    }
    return { items, added };
  }

  function counts(stashItems) {
    const all = Object.values(stashItems || {});
    return {
      total: all.length,
      uncategorized: all.filter((i) => isUncategorizedStatus(i.status)).length,
      no: all.filter((i) => i.status === "no").length,
      maybe: all.filter((i) => i.status === "maybe").length,
      yes: all.filter((i) => i.status === "yes").length,
    };
  }

  function uncategorizedList(stashItems) {
    return Object.values(stashItems || {})
      .filter((i) => isUncategorizedStatus(i.status))
      .sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
  }


  function sumDuration(stashItems, filterFn) {
    const all = Object.values(stashItems || {});
    const list = typeof filterFn === "function" ? all.filter(filterFn) : all;
    let sec = 0;
    let known = 0;
    let missing = 0;
    for (const it of list) {
      const d = it?.durationSec;
      if (d != null && Number.isFinite(d) && d >= 0) {
        sec += d;
        known += 1;
      } else {
        missing += 1;
      }
    }
    return { sec, known, missing, count: list.length };
  }

  /** Exact hours+minutes for tooltips: "970h 17m", "3h 42m", "42m", "0m". */
  function fmtDurationExact(sec) {
    if (sec == null || !Number.isFinite(sec) || sec < 0) return "—";
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (h > 0 && m > 0) return `${h}h ${m}m`;
    if (h > 0) return `${h}h`;
    return `${m}m`;
  }

  /**
   * Compact duration for UI totals.
   * <1h: Nm · <24h: Xh Ym (omit 0m) · ≥24h: Nw Nd Nh (omit zero units;
   * minutes only when total < 48h).
   */
  function fmtDurationLong(sec) {
    if (sec == null || !Number.isFinite(sec) || sec < 0) return "—";
    sec = Math.round(sec);
    const totalH = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (totalH < 1) return `${m}m`;
    if (totalH < 24) {
      return m > 0 ? `${totalH}h ${m}m` : `${totalH}h`;
    }
    const w = Math.floor(totalH / 168);
    const d = Math.floor((totalH % 168) / 24);
    const h = totalH % 24;
    const parts = [];
    if (w > 0) parts.push(`${w}w`);
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    // Keep minutes under 48h so short multi-day totals stay precise
    if (totalH < 48 && m > 0) parts.push(`${m}m`);
    return parts.length ? parts.join(" ") : "0m";
  }

  /**
   * Budget bar stats for UI.
   * scaleMax = max(total, budget, yeses) so marker + fill share one track.
   * tone: ok | warm | over based on yesSec vs budgetSec (~80% warm).
   */
  function timeBudgetStats(stashItems, stashConfig) {
    const total = sumDuration(stashItems);
    const yes = sumDuration(stashItems, (i) => i.status === "yes");
    const budgetMinutes =
      stashConfig?.timeBudgetMinutes ?? DEFAULT_CONFIG.timeBudgetMinutes;
    const budgetSec = Math.max(0, Number(budgetMinutes) || 0) * 60;
    const totalSec = total.sec;
    const yesSec = yes.sec;
    const scaleMax = Math.max(totalSec, budgetSec, yesSec, 1);
    const yesPct = Math.min(100, (yesSec / scaleMax) * 100);
    const budgetPct = Math.min(100, (budgetSec / scaleMax) * 100);
    let tone = "ok";
    if (budgetSec > 0) {
      const ratio = yesSec / budgetSec;
      if (ratio > 1) tone = "over";
      else if (ratio >= 0.8) tone = "warm";
    } else if (yesSec > 0) {
      tone = "over";
    }
    return {
      totalSec,
      yesSec,
      budgetSec,
      budgetMinutes: Math.round(budgetSec / 60),
      known: total.known,
      missing: total.missing,
      count: total.count,
      yesKnown: yes.known,
      scaleMax,
      yesPct,
      budgetPct,
      tone,
    };
  }


  /**
   * Remove youtube-source stash items whose videoId (or id) is not in scrapedItems.
   * Never touches twitter/x (or any non-youtube) items.
   * @returns {{ items: object, pruned: number }}
   */
  function pruneYoutubeNotIn(existing, scrapedItems) {
    const { items: base } = migrateInbox(existing);
    const keep = new Set();
    for (const raw of scrapedItems || []) {
      if (!raw) continue;
      if (raw.videoId) keep.add(String(raw.videoId));
      if (raw.id) {
        keep.add(String(raw.id));
        const m = String(raw.id).match(/^yt:(.+)$/);
        if (m) keep.add(m[1]);
      }
    }
    const items = {};
    let pruned = 0;
    for (const [id, it] of Object.entries(base || {})) {
      const src = (it?.source || "youtube").toLowerCase();
      if (src !== "youtube" && src !== "yt") {
        items[id] = it;
        continue;
      }
      const vid = it?.videoId != null ? String(it.videoId) : null;
      const inScraped =
        (vid && keep.has(vid)) ||
        keep.has(String(id)) ||
        (vid && keep.has(`yt:${vid}`));
      if (inScraped) {
        items[id] = it;
      } else {
        pruned += 1;
      }
    }
    return { items, pruned };
  }

  /**
   * Delete stash items by id (and by yt:videoId / bare videoId aliases).
   * @returns {{ items: object, removed: number }}
   */
  function removeIds(existing, ids) {
    const { items: base } = migrateInbox(existing);
    const drop = new Set();
    for (const raw of ids || []) {
      if (raw == null || raw === "") continue;
      const s = String(raw);
      drop.add(s);
      const m = s.match(/^yt:(.+)$/);
      if (m) drop.add(m[1]);
      else drop.add(`yt:${s}`);
    }
    if (!drop.size) return { items: { ...base }, removed: 0 };
    const items = {};
    let removed = 0;
    for (const [id, it] of Object.entries(base || {})) {
      const vid = it?.videoId != null ? String(it.videoId) : null;
      if (drop.has(String(id)) || (vid && drop.has(vid)) || (vid && drop.has(`yt:${vid}`))) {
        removed += 1;
        continue;
      }
      items[id] = it;
    }
    return { items, removed };
  }

  root.StashStorage = {
    DEFAULT_CONFIG,
    getAll,
    setItems,
    setConfig,
    setUndo,
    getPlaylists,
    setPlaylists,
    mergeScraped,
    pruneYoutubeNotIn,
    removeIds,
    counts,
    uncategorizedList,
    isUncategorizedStatus,
    migrateConfig,
    sumDuration,
    fmtDurationLong,
    fmtDurationExact,
    timeBudgetStats,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
