const $ = (id) => document.getElementById(id);

let items = {};
let undoStack = [];
let config = { ...StashStorage.DEFAULT_CONFIG };
let playlists = []; // [{id,name}]
let busy = false;
let flashTimer = null;

function currentList() {
  return StashStorage.uncategorizedList(items);
}

function currentItem() {
  return currentList()[0] || null;
}

function setStatus(msg) {
  $("status").textContent = msg || "";
}

function flash(kind) {
  const el = $("flash");
  const label = $("swipe-label");
  el.className = "flash show-" + kind;
  if (label) {
    label.textContent = kind === "no" ? "NO" : kind === "maybe" ? "MAYBE" : "YES";
    label.className = "swipe-label show-" + kind;
  }
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    el.className = "flash";
    if (label) {
      label.textContent = "";
      label.className = "swipe-label";
    }
  }, 220);
}

function renderTimeBudget() {
  const stats = StashStorage.timeBudgetStats(items, config);
  const fmt = StashStorage.fmtDurationLong;
  const section = $("time-budget");
  const bar = $("tb-bar");
  const fill = $("tb-fill");
  const marker = $("tb-marker");
  const caption = $("tb-caption");
  const input = $("tb-budget-input");

  if (input && document.activeElement !== input) {
    input.value = String(stats.budgetMinutes);
  }
  if (fill) fill.style.width = `${stats.yesPct}%`;
  if (marker) marker.style.left = `${stats.budgetPct}%`;
  if (bar) {
    bar.classList.remove("tone-ok", "tone-warm", "tone-over");
    bar.classList.add(`tone-${stats.tone}`);
  }
  if (section) {
    section.classList.remove("tone-ok", "tone-warm", "tone-over");
    section.classList.add(`tone-${stats.tone}`);
  }
  if (caption) {
    caption.textContent =
      `yeses ${fmt(stats.yesSec)} / budget ${fmt(stats.budgetSec)} · total ${fmt(stats.totalSec)}`;
  }
}

function render() {
  const list = currentList();
  const it = list[0];
  const card = $("card");
  const empty = $("empty");
  const totalUnc = list.length;
  const c = StashStorage.counts(items);
  const decided = c.no + c.maybe + c.yes;
  const pile = decided + totalUnc;
  const left = totalUnc;

  renderTimeBudget();

  if (!it) {
    card.hidden = true;
    empty.hidden = false;
    $("progress").textContent = `0 / ${pile || 0}`;
    return;
  }

  empty.hidden = true;
  card.hidden = false;
  card.className = "card";

  $("pub-date").textContent = it.publishedText || "—";
  $("pub-views").textContent = it.viewsText || (it.viewsCount != null ? fmtViews(it.viewsCount) : "—");

  const thumb = $("thumb");
  if (it.thumbnailUrl) {
    thumb.src = it.thumbnailUrl;
    thumb.hidden = false;
  } else if (it.videoId) {
    thumb.src = `https://i.ytimg.com/vi/${it.videoId}/hqdefault.jpg`;
    thumb.hidden = false;
  } else {
    thumb.removeAttribute("src");
    thumb.hidden = true;
  }

  const av = $("ch-avatar");
  if (it.channelThumbUrl) {
    av.src = it.channelThumbUrl;
    av.hidden = false;
  } else {
    av.hidden = true;
  }
  $("ch-name").textContent = it.channel || "Unknown channel";
  const display = displayTitleAndDuration(it);
  $("title").textContent = display.title;
  $("duration").textContent = display.duration;
  $("progress").textContent = `${left} / ${pile || left} left`;
}

/** True for pure timestamps / spoken length labels that were mis-scraped as titles. */
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

function displayTitleAndDuration(it) {
  let title = (it?.title || "").trim() || "(untitled)";
  let duration = it?.durationText || fmtDuration(it?.durationSec);
  if (isDurationLikeTitle(title)) {
    if (!duration || duration === "—") duration = title;
    title = "(untitled)";
  }
  return { title, duration };
}

function fmtDuration(sec) {
  if (sec == null || Number.isNaN(sec)) return "—";
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtViews(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B views";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M views";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K views";
  return `${n} views`;
}

async function persist() {
  await StashStorage.setItems(items);
  await StashStorage.setUndo(undoStack);
}

async function mark(status) {
  if (busy) return;
  const it = currentItem();
  if (!it) return;
  busy = true;
  const prevStatus = it.status || "uncategorized";
  flash(status);
  $("card").classList.add("exit-" + status);
  await sleep(180);
  items[it.id] = { ...items[it.id], status };
  undoStack.push({ id: it.id, prevStatus });
  if (undoStack.length > 200) undoStack = undoStack.slice(-200);
  await persist();
  busy = false;
  render();
}

async function undo() {
  if (busy) return;
  const last = undoStack.pop();
  if (!last) {
    setStatus("nothing to undo");
    return;
  }
  if (items[last.id]) {
    items[last.id] = { ...items[last.id], status: last.prevStatus || "uncategorized" };
    await persist();
    setStatus("undid → " + (items[last.id].title || last.id).slice(0, 48));
    render();
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function optionValueForPlaylist(id) {
  return `playlist:${id}`;
}

function parseSelectValue(val) {
  if (!val) return { kind: "none" };
  if (val === "remove") return { kind: "remove" };
  if (val === "keep_wl") return { kind: "keep_wl" };
  if (val === "other") return { kind: "other" };
  if (val.startsWith("playlist:")) {
    return { kind: "playlist", id: val.slice("playlist:".length) };
  }
  return { kind: "none" };
}

function findPlaylistById(id) {
  return playlists.find((p) => p.id === id) || null;
}

function findPlaylistByName(name) {
  if (!name) return null;
  const exact = playlists.find((p) => p.name === name);
  if (exact) return exact;
  const lower = name.toLowerCase();
  return playlists.find((p) => p.name.toLowerCase() === lower) || null;
}

function fillSelect(selectEl, { special, preferredId, preferredName }) {
  const prev = selectEl.value;
  selectEl.innerHTML = "";
  for (const s of special || []) {
    const opt = document.createElement("option");
    opt.value = s.value;
    opt.textContent = s.label;
    selectEl.appendChild(opt);
  }
  for (const p of playlists) {
    const opt = document.createElement("option");
    opt.value = optionValueForPlaylist(p.id);
    opt.textContent = p.name;
    selectEl.appendChild(opt);
  }
  const other = document.createElement("option");
  other.value = "other";
  other.textContent = "Other…";
  selectEl.appendChild(other);

  // Choose selection
  let chosen = null;
  if (preferredId && findPlaylistById(preferredId)) {
    chosen = optionValueForPlaylist(preferredId);
  } else if (preferredName) {
    const byName = findPlaylistByName(preferredName);
    if (byName) chosen = optionValueForPlaylist(byName.id);
  }
  if (!chosen && special?.length) {
    // For maybe: prefer matching default name, else first playlist, else other
    if (special[0].value === "remove" || special[0].value === "keep_wl") {
      chosen = special[0].value;
    }
  }
  if (!chosen && preferredName && !findPlaylistByName(preferredName)) {
    chosen = "other";
  }
  if (!chosen && playlists.length && !special?.some((s) => s.value === "remove" || s.value === "keep_wl")) {
    // maybe with no preferred: try "Maybe Watch Later", else first
    const maybeDef = findPlaylistByName("Maybe Watch Later");
    chosen = maybeDef ? optionValueForPlaylist(maybeDef.id) : optionValueForPlaylist(playlists[0].id);
  }
  if (!chosen) chosen = special?.[0]?.value || (playlists[0] ? optionValueForPlaylist(playlists[0].id) : "other");

  // Restore previous if still valid
  if (prev && [...selectEl.options].some((o) => o.value === prev)) {
    selectEl.value = prev;
  } else {
    selectEl.value = chosen;
  }
}

function syncOtherVisibility() {
  const pairs = [
    ["cfg-no", "cfg-no-other-wrap"],
    ["cfg-maybe", "cfg-maybe-other-wrap"],
    ["cfg-yes", "cfg-yes-other-wrap"],
  ];
  for (const [selId, wrapId] of pairs) {
    const wrap = $(wrapId);
    if (!wrap) continue;
    wrap.hidden = $(selId).value !== "other";
  }
}

function populatePlaylistSelects() {
  fillSelect($("cfg-no"), {
    special: [{ value: "remove", label: "Fully remove" }],
    preferredId: config.noMode === "playlist" ? config.noPlaylistId : "",
    preferredName: config.noMode === "playlist" ? config.noPlaylistName : "",
  });
  if (config.noMode === "playlist" && config.noPlaylistName && !findPlaylistById(config.noPlaylistId) && !findPlaylistByName(config.noPlaylistName)) {
    $("cfg-no").value = "other";
    $("cfg-no-other").value = config.noPlaylistName || "";
  } else if (config.noMode !== "playlist") {
    $("cfg-no").value = "remove";
  }

  // Maybe: no "special" remove/keep — only playlists + other
  const maybePreferredId = config.maybePlaylistId || "";
  const maybePreferredName = config.maybePlaylistName || "Maybe Watch Later";
  fillSelect($("cfg-maybe"), {
    special: [],
    preferredId: maybePreferredId,
    preferredName: maybePreferredName,
  });
  // Default keep "Maybe Watch Later" if in list
  if (!maybePreferredId) {
    const byName = findPlaylistByName(maybePreferredName);
    if (byName) $("cfg-maybe").value = optionValueForPlaylist(byName.id);
    else if (!playlists.length) {
      $("cfg-maybe").value = "other";
      $("cfg-maybe-other").value = maybePreferredName;
    } else if (!findPlaylistByName(maybePreferredName)) {
      // name not in list → other with that name, or first playlist if empty name
      $("cfg-maybe").value = "other";
      $("cfg-maybe-other").value = maybePreferredName;
    }
  } else if (!findPlaylistById(maybePreferredId) && maybePreferredName) {
    $("cfg-maybe").value = "other";
    $("cfg-maybe-other").value = maybePreferredName;
  }
  if ($("cfg-maybe").value === "other") {
    $("cfg-maybe-other").value = $("cfg-maybe-other").value || maybePreferredName;
  }

  fillSelect($("cfg-yes"), {
    special: [{ value: "keep_wl", label: "Keep in Watch Later" }],
    preferredId: config.yesMode === "playlist" ? config.yesPlaylistId : "",
    preferredName: config.yesMode === "playlist" ? config.yesPlaylistName : "",
  });
  if (config.yesMode === "playlist" && config.yesPlaylistName && !findPlaylistById(config.yesPlaylistId) && !findPlaylistByName(config.yesPlaylistName)) {
    $("cfg-yes").value = "other";
    $("cfg-yes-other").value = config.yesPlaylistName || "";
  } else if (config.yesMode !== "playlist") {
    $("cfg-yes").value = "keep_wl";
  }

  syncOtherVisibility();
  updatePlaylistStatus();
}

function updatePlaylistStatus(extra) {
  const n = playlists.length;
  const base = n ? `Playlists: ${n} cached` : "Playlists: not loaded yet";
  $("cfg-playlist-status").textContent = extra ? `${base} · ${extra}` : base;
}

function destinationFromSelect(selId, otherId, { removeValue, keepValue } = {}) {
  const parsed = parseSelectValue($(selId).value);
  if (parsed.kind === "remove" || (removeValue && $(selId).value === removeValue)) {
    return { mode: "remove", playlistId: "", playlistName: "" };
  }
  if (parsed.kind === "keep_wl" || (keepValue && $(selId).value === keepValue)) {
    return { mode: "keep_wl", playlistId: "", playlistName: "" };
  }
  if (parsed.kind === "playlist") {
    const p = findPlaylistById(parsed.id);
    return {
      mode: "playlist",
      playlistId: parsed.id,
      playlistName: p?.name || "",
    };
  }
  // other
  const name = ($(otherId)?.value || "").trim();
  return { mode: "playlist", playlistId: "", playlistName: name };
}

function fillConfigForm() {
  populatePlaylistSelects();
  if (config.noMode === "playlist" && config.noPlaylistName && $("cfg-no").value === "other") {
    $("cfg-no-other").value = config.noPlaylistName;
  }
  if ($("cfg-maybe").value === "other") {
    $("cfg-maybe-other").value = config.maybePlaylistName || "Maybe Watch Later";
  }
  if (config.yesMode === "playlist" && $("cfg-yes").value === "other") {
    $("cfg-yes-other").value = config.yesPlaylistName || "";
  }
  syncOtherVisibility();
}

async function saveConfig() {
  const noDest = destinationFromSelect("cfg-no", "cfg-no-other", { removeValue: "remove" });
  const maybeDest = destinationFromSelect("cfg-maybe", "cfg-maybe-other");
  const yesDest = destinationFromSelect("cfg-yes", "cfg-yes-other", { keepValue: "keep_wl" });

  if (maybeDest.mode === "playlist" && !maybeDest.playlistId && !maybeDest.playlistName) {
    setStatus("Maybe needs a playlist — pick one or enter a name");
    return;
  }
  if (noDest.mode === "playlist" && !noDest.playlistId && !noDest.playlistName) {
    setStatus("No destination: pick a playlist or Fully remove");
    return;
  }
  if (yesDest.mode === "playlist" && !yesDest.playlistId && !yesDest.playlistName) {
    setStatus("Yes destination: pick a playlist or Keep in Watch Later");
    return;
  }

  config = {
    ...config,
    noMode: noDest.mode === "playlist" ? "playlist" : "remove",
    noPlaylistId: noDest.playlistId || "",
    noPlaylistName: noDest.playlistName || "",
    maybePlaylistId: maybeDest.playlistId || "",
    maybePlaylistName: maybeDest.playlistName || "Maybe Watch Later",
    yesMode: yesDest.mode === "playlist" ? "playlist" : "keep_wl",
    yesPlaylistId: yesDest.playlistId || "",
    yesPlaylistName: yesDest.playlistName || "Stash Yes",
  };
  await StashStorage.setConfig(config);
  setStatus("config saved");
  $("config-panel").hidden = true;
}

async function ensureScript(tab) {
  const url = tab.url || "";
  let ponged = false;
  try {
    const ping = await chrome.tabs.sendMessage(tab.id, { type: "STASH_PING" });
    ponged = !!ping?.ok;
    if (ponged) return { ponged };
  } catch {
    /* inject */
  }
  try {
    const file = /youtube\.com|youtu\.be/.test(url)
      ? "content/youtube.js"
      : /x\.com|twitter\.com/.test(url)
        ? "content/twitter.js"
        : null;
    if (!file) return { ponged: false };
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [file] });
    await sleep(200);
    const ping2 = await chrome.tabs.sendMessage(tab.id, { type: "STASH_PING" });
    ponged = !!ping2?.ok;
    return { ponged };
  } catch {
    return { ponged: false };
  }
}

async function refreshPlaylists({ silent } = {}) {
  if (!silent) updatePlaylistStatus("refreshing…");
  const findTab = StashTabs?.findYoutubeTab || StashApply?.findYoutubeTab;
  const tab = findTab ? await findTab() : null;
  if (!tab?.id || !/youtube\.com/i.test(tab.url || "")) {
    updatePlaylistStatus("open a YouTube tab first");
    if (!silent) setStatus("Refresh playlists: open a YouTube tab");
    return false;
  }
  const { ponged } = await ensureScript(tab);
  if (!ponged) {
    updatePlaylistStatus("content script unavailable — hard-refresh YT");
    return false;
  }
  let res;
  try {
    res = await chrome.tabs.sendMessage(tab.id, { type: "STASH_LIST_PLAYLISTS" });
  } catch (err) {
    updatePlaylistStatus(String(err));
    return false;
  }
  if (!res?.ok) {
    updatePlaylistStatus(res?.error || "list failed");
    return false;
  }
  playlists = Array.isArray(res.playlists) ? res.playlists : [];
  await StashStorage.setPlaylists(playlists);
  populatePlaylistSelects();
  updatePlaylistStatus(`last refresh ${playlists.length} via ${res.method || "?"}`);
  if (!silent) setStatus(`playlists: ${playlists.length}`);
  return true;
}

async function load() {
  const data = await StashStorage.getAll();
  items = data.stashItems;
  undoStack = data.stashUndo;
  config = data.stashConfig;
  playlists = data.stashPlaylists || [];
  fillConfigForm();
  render();
}

function zeroScrapeStatus(tab, ponged, res) {
  const url = tab?.url || res?.pageUrl || "(unknown url)";
  const pingBit = ponged ? "content script: pong ok" : "content script: no pong";
  return (
    `0 items · ${url} · ${pingBit}. ` +
    `Hard-refresh the Watch Later tab (playlist?list=WL), scroll the list, then Scan again.`
  );
}

function playlistContextFromTitle(title, url) {
  const u = url || "";
  if (/list=WL/i.test(u) || /watch_later/i.test(u)) return "Watch Later";
  const cleaned = (title || "")
    .replace(/\s*-\s*YouTube\s*$/i, "")
    .replace(/^\(\d+\)\s*/, "")
    .trim();
  if (/\bwatch later\b/i.test(cleaned)) return "Watch Later";
  return cleaned;
}


/**
 * Safe prune after a Watch Later scrape.
 * Completeness rule:
 * - Prefer res.playlistVideoCount (playlist header / ytInitialData reported size).
 * - Prune only when: isWatchLater AND scraped count > 0 AND
 *   (playlistVideoCount != null
 *     ? scraped >= playlistVideoCount * 0.95 OR scraped === playlistVideoCount
 *     : scrapeMethod === "ytInitialData"  // full contents dump heuristic)
 * - Never prunes twitter/x items (pruneYoutubeNotIn youtube-source only).
 */
function shouldPruneWatchLater(res) {
  if (!res?.isWatchLater) return false;
  const scraped = Number(res.count) || (Array.isArray(res.items) ? res.items.length : 0);
  if (scraped <= 0) return false;
  if (res.loadedFully === true) return true;
  const plc = res.playlistVideoCount;
  if (plc != null && Number.isFinite(Number(plc))) {
    const n = Number(plc);
    return scraped >= n * 0.95 || scraped === n;
  }
  return res.scrapeMethod === "ytInitialData";
}

function applyWatchLaterPrune(items, res) {
  if (!shouldPruneWatchLater(res) || !StashStorage.pruneYoutubeNotIn) {
    return { items, pruned: 0, skipped: !!res?.isWatchLater };
  }
  const out = StashStorage.pruneYoutubeNotIn(items, res.items || []);
  return { items: out.items, pruned: out.pruned, skipped: false };
}

async function scan() {
  if (typeof StashScanProgress !== "undefined") {
    StashScanProgress.setScanning("scanning…");
  } else {
    setStatus("scanning…");
  }
  const findTab = StashTabs?.findYoutubeTab || StashApply?.findYoutubeTab;
  const tab = findTab ? await findTab() : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab?.id) {
    if (typeof StashScanProgress !== "undefined") StashScanProgress.hide();
    setStatus("no suitable tab — open youtube.com/playlist?list=WL");
    return;
  }
  if (typeof StashScanProgress !== "undefined") {
    StashScanProgress.setContext(playlistContextFromTitle(tab.title, tab.url));
  }
  const url = tab.url || "";
  if (!/youtube\.com|youtu\.be|x\.com|twitter\.com/.test(url)) {
    if (typeof StashScanProgress !== "undefined") StashScanProgress.hide();
    setStatus(`no YT/X tab found (active: ${(url || "none").slice(0, 60)}). Open Watch Later first.`);
    return;
  }

  const { ponged } = await ensureScript(tab);
  if (!ponged) {
    if (typeof StashScanProgress !== "undefined") StashScanProgress.hide();
    setStatus(`content script did not pong · ${url}. Hard-refresh that tab, then Scan again.`);
    return;
  }

  let res;
  try {
    res = await chrome.tabs.sendMessage(tab.id, { type: "STASH_SCRAPE" });
  } catch (err) {
    if (typeof StashScanProgress !== "undefined") StashScanProgress.hide();
    setStatus(`scrape failed · ${url} · ${String(err)}`);
    return;
  }

  if (!res?.ok) {
    if (typeof StashScanProgress !== "undefined") StashScanProgress.hide();
    setStatus(res?.error || "scrape failed");
    return;
  }

  if (!res.count) {
    if (typeof StashScanProgress !== "undefined") StashScanProgress.setDone({ brief: true });
    setStatus(zeroScrapeStatus(tab, ponged, res));
    render();
    return;
  }

  const merged = StashStorage.mergeScraped(items, res.items);
  items = merged.items;
  const pruneResult = applyWatchLaterPrune(items, res);
  items = pruneResult.items;
  await StashStorage.setItems(items);
  render();
  const method = res.scrapeMethod ? ` · via ${res.scrapeMethod}` : "";
  const enrichBits = [];
  if (res.viewsEnriched > 0) enrichBits.push(`+${res.viewsEnriched} views`);
  if (res.channelsEnriched > 0) enrichBits.push(`+${res.channelsEnriched} channels`);
  if (res.datesEnriched > 0) enrichBits.push(`+${res.datesEnriched} dates`);
  if (res.titlesEnriched > 0) enrichBits.push(`+${res.titlesEnriched} titles`);
  const enrichBit = enrichBits.length ? ` · ${enrichBits.join(" · ")} filled` : "";
  let pruneBit = "";
  if (res.isWatchLater) {
    if (pruneResult.pruned > 0) pruneBit = ` · pruned ${pruneResult.pruned} gone from WL`;
    else if (pruneResult.skipped) pruneBit = " · kept stale (partial load)";
  }
  let loadBit = "";
  if (res.source === "youtube" && (res.playlistVideoCount != null || res.loadedFully != null)) {
    const got = res.loadedCount ?? res.count ?? 0;
    const want = res.playlistVideoCount;
    if (res.loadedFully || (want != null && got >= want)) {
      loadBit = want != null ? ` · loaded ${got} / ${want}` : ` · loaded ${got}`;
    } else if (want != null) {
      loadBit = ` · partial ${got} / ${want} — scroll stalled`;
    } else {
      loadBit = ` · loaded ${got}`;
    }
  }
  // Honesty: how many videos went through meta enrich this scan.
  const metaN = res.metaQueued ?? res.metaNeedTotal;
  if (metaN != null && Number(metaN) > 0) {
    loadBit += ` · meta ${metaN}`;
  }
  if (typeof StashScanProgress !== "undefined") {
    if (res.isWatchLater) StashScanProgress.setContext("Watch Later");
    else if (res.playlistTitle) StashScanProgress.setContext(res.playlistTitle);
    StashScanProgress.setDone({ brief: true });
  }
  setStatus(`+${merged.added} new · ${res.count} on page${method}${enrichBit}${pruneBit}${loadBit}`);
}

async function apply() {
  const { stashItems, stashConfig } = await StashStorage.getAll();
  const work = StashApply.countApplyWork(stashItems, stashConfig);
  if (work.hasWork) {
    const ok = confirm(
      `Apply ${work.nos} no + ${work.maybes} maybe + ${work.yeses} yes to YouTube?`
    );
    if (!ok) {
      setStatus("apply cancelled");
      return;
    }
  }

  $("btn-apply").disabled = true;
  setStatus("applying…");
  const total = work.nos + work.maybes + work.yeses;
  if (typeof StashApplyProgress !== "undefined") {
    StashApplyProgress.start({ total });
  }
  try {
    const result = await StashApply.applyDecisions({
      onProgress: (payload) => {
        if (typeof StashApplyProgress !== "undefined") {
          StashApplyProgress.update(payload);
        } else if (typeof payload === "string") {
          setStatus(payload);
        } else if (payload?.message) {
          setStatus(payload.message);
        }
      },
    });
    setStatus(StashApply.formatApplyStatus(result));
    if (typeof StashApplyProgress !== "undefined") {
      if (result.nothingToApply || result.needWlTab) {
        StashApplyProgress.hide();
      } else {
        StashApplyProgress.finish({
          ...result,
          done: total,
          total,
        });
      }
    }
    if (result.failed?.length) console.warn(result.failed);
  } catch (err) {
    setStatus(String(err));
    if (typeof StashApplyProgress !== "undefined") {
      StashApplyProgress.finish({
        ok: false,
        removed: 0,
        maybeMoved: 0,
        yesMoved: 0,
        failed: [String(err)],
        done: 0,
        total,
      });
    }
  } finally {
    $("btn-apply").disabled = false;
  }
}

async function openConfig() {
  const panel = $("config-panel");
  const opening = panel.hidden;
  panel.hidden = !opening;
  if (opening) {
    fillConfigForm();
    if (!playlists.length) {
      await refreshPlaylists({ silent: true });
    }
  }
}

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea, select")) return;
  const key = e.key;
  if (key === "ArrowLeft" || key === "n" || key === "j") {
    e.preventDefault();
    mark("no");
  } else if (key === "ArrowRight" || key === "y" || key === "k") {
    e.preventDefault();
    mark("maybe");
  } else if (key === "ArrowUp" || key === " ") {
    e.preventDefault();
    mark("yes");
  } else if (key === "Escape" || key === "Backspace") {
    e.preventDefault();
    undo();
  }
});


async function resetTriage() {
  if (!confirm("Reset marks only (does not delete videos from stash)?")) return;
  let n = 0;
  for (const id of Object.keys(items)) {
    const st = items[id]?.status;
    if (st === "no" || st === "maybe" || st === "yes") {
      items[id] = { ...items[id], status: "uncategorized" };
      n += 1;
    }
  }
  undoStack = [];
  await StashStorage.setItems(items);
  await StashStorage.setUndo([]);
  render();
  setStatus(n ? `reset ${n} marks → uncategorized` : "nothing to reset");
}

async function clearStashData() {
  if (!confirm("Clear entire stash? This deletes all scraped videos from Stash (not from YouTube).")) return;
  items = {};
  undoStack = [];
  await StashStorage.setItems({});
  await StashStorage.setUndo([]);
  render();
  setStatus("stash cleared — Scan Watch Later to refill");
}

$("btn-scan").addEventListener("click", scan);
$("btn-apply").addEventListener("click", apply);
$("btn-config").addEventListener("click", () => {
  openConfig();
});
$("cfg-save").addEventListener("click", saveConfig);
$("cfg-close").addEventListener("click", () => {
  $("config-panel").hidden = true;
});
$("cfg-refresh-playlists").addEventListener("click", () => refreshPlaylists());
$("btn-reset-triage").addEventListener("click", resetTriage);
$("cfg-reset-triage").addEventListener("click", resetTriage);
$("cfg-clear-stash").addEventListener("click", clearStashData);
$("cfg-no").addEventListener("change", syncOtherVisibility);
$("cfg-maybe").addEventListener("change", syncOtherVisibility);
$("cfg-yes").addEventListener("change", syncOtherVisibility);

async function saveTimeBudgetFromInput() {
  const input = $("tb-budget-input");
  if (!input) return;
  let mins = Number(input.value);
  if (!Number.isFinite(mins) || mins < 0) mins = 0;
  mins = Math.round(mins);
  input.value = String(mins);
  if (config.timeBudgetMinutes === mins) {
    renderTimeBudget();
    return;
  }
  config = { ...config, timeBudgetMinutes: mins };
  await StashStorage.setConfig(config);
  setStatus(`budget set to ${mins} min`);
  renderTimeBudget();
}

const budgetInput = $("tb-budget-input");
if (budgetInput) {
  budgetInput.addEventListener("change", saveTimeBudgetFromInput);
  budgetInput.addEventListener("blur", saveTimeBudgetFromInput);
  budgetInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      budgetInput.blur();
    }
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.stashItems) {
    items = changes.stashItems.newValue || {};
    render();
  }
  if (changes.stashUndo) undoStack = changes.stashUndo.newValue || [];
  if (changes.stashConfig) {
    config = StashStorage.migrateConfig
      ? StashStorage.migrateConfig(changes.stashConfig.newValue)
      : { ...StashStorage.DEFAULT_CONFIG, ...(changes.stashConfig.newValue || {}) };
    fillConfigForm();
    renderTimeBudget();
  }
  if (changes.stashPlaylists) {
    playlists = changes.stashPlaylists.newValue || [];
    populatePlaylistSelects();
  }
});

StashTheme.load()
  .then(() => {
    StashTheme.wireButton();
    return load();
  })
  .catch(() => {
    StashTheme.wireButton();
    return load();
  })
  .then(() => {
    document.body.focus();
  });

if (typeof StashScanProgress !== "undefined") StashScanProgress.listen();
if (typeof StashApplyProgress !== "undefined") StashApplyProgress.listen();
