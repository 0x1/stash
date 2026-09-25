const $ = (id) => document.getElementById(id);

function renderTimeBudget(stashItems, stashConfig) {
  const stats = StashStorage.timeBudgetStats(stashItems, stashConfig);
  const fmt = StashStorage.fmtDurationLong;
  const section = $("time-budget");
  const bar = $("tb-bar");
  const fill = $("tb-fill");
  const marker = $("tb-marker");
  const caption = $("tb-caption");
  const totalEl = $("tb-total");
  const input = $("tb-budget-input");

  if (totalEl) {
    const miss =
      stats.missing > 0
        ? ` (${stats.known} with duration · ${stats.missing} unknown)`
        : stats.count
          ? ` (${stats.known} videos)`
          : "";
    const full = `${fmt(stats.totalSec)}${miss}`;
    totalEl.textContent = full;
    totalEl.title = full;
  }

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

function renderPie(stashItems, stashConfig) {
  const c = StashStorage.counts(stashItems);
  const totalDur = StashStorage.sumDuration(stashItems);
  const fmt = StashStorage.fmtDurationLong;
  const empty = $("pie-empty");
  const body = $("pie-body");
  const budgetLine = $("pie-budget-line");
  const wrap = document.querySelector(".pie-wrap");

  if (!c.total) {
    if (empty) {
      empty.hidden = false;
      empty.textContent = "scan Watch Later → open deck";
    }
    if (body) body.hidden = true;
    if (budgetLine) budgetLine.hidden = true;
    if (wrap) wrap.classList.remove("tone-ok", "tone-warm", "tone-over");
    return;
  }

  if (empty) empty.hidden = true;
  if (body) body.hidden = false;

  const segments = [
    { key: "uncategorized", label: "left", n: c.uncategorized },
    { key: "no", label: "no", n: c.no },
    { key: "maybe", label: "maybe", n: c.maybe },
    { key: "yes", label: "yes", n: c.yes },
  ];
  const total = Math.max(1, c.total);
  const R = 45;
  const C = 2 * Math.PI * R;

  const svg = $("pie-svg");
  if (svg) {
    let offset = 0;
    const parts = [
      `<circle class="pie-track" cx="60" cy="60" r="${R}" />`,
    ];
    for (const seg of segments) {
      if (!seg.n) continue;
      const len = (seg.n / total) * C;
      // rotate so first segment starts at 12 o'clock
      const dashoffset = C * 0.25 - offset;
      parts.push(
        `<circle class="pie-seg seg-${seg.key}" cx="60" cy="60" r="${R}" ` +
          `stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${dashoffset}" />`
      );
      offset += len;
    }
    svg.innerHTML = parts.join("");
  }

  if ($("pie-total")) $("pie-total").textContent = String(c.total);
  if ($("pie-duration")) $("pie-duration").textContent = fmt(totalDur.sec);

  const legend = $("pie-legend");
  if (legend) {
    legend.innerHTML = segments
      .map(
        (seg) =>
          `<li><span class="swatch sw-${seg.key}"></span>` +
          `<span class="lab">${seg.label}</span>` +
          `<span class="num">${seg.n}</span></li>`
      )
      .join("");
  }

  const stats = StashStorage.timeBudgetStats(stashItems, stashConfig);
  if (budgetLine) {
    budgetLine.hidden = false;
    budgetLine.innerHTML =
      `<span class="yes-bit">yes ${fmt(stats.yesSec)}</span>` +
      ` / budget ${fmt(stats.budgetSec)}`;
  }
  if (wrap) {
    wrap.classList.remove("tone-ok", "tone-warm", "tone-over");
    wrap.classList.add(`tone-${stats.tone}`);
  }
}

async function refresh() {
  const { stashItems, stashConfig } = await StashStorage.getAll();
  const c = StashStorage.counts(stashItems);

  $("counts").innerHTML =
    `<strong>${c.uncategorized}</strong> left · ` +
    `<span class="c-no">${c.no} no</span> · ` +
    `<span class="c-maybe">${c.maybe} maybe</span> · ` +
    `<span class="c-yes">${c.yes} yes</span> · ${c.total} total`;

  renderTimeBudget(stashItems, stashConfig);
  renderPie(stashItems, stashConfig);
}

function zeroScrapeStatus(tab, ponged, res) {
  const url = tab?.url || res?.pageUrl || "(unknown url)";
  const pingBit = ponged ? "content script: pong ok" : "content script: no pong";
  return (
    `0 items · ${url} · ${pingBit}. ` +
    `Hard-refresh the Watch Later tab (playlist?list=WL), scroll the list, then Scan again.`
  );
}

async function ensureScript(tab) {
  const url = tab.url || "";
  let ponged = false;
  try {
    const ping = await chrome.tabs.sendMessage(tab.id, { type: "STASH_PING" });
    ponged = !!ping?.ok;
    if (ponged) return { ponged, injected: false };
  } catch {
    /* inject */
  }
  try {
    const file = /youtube\.com|youtu\.be/.test(url)
      ? "content/youtube.js"
      : /x\.com|twitter\.com/.test(url)
        ? "content/twitter.js"
        : null;
    if (!file) return { ponged: false, injected: false };
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [file] });
    await new Promise((r) => setTimeout(r, 200));
    const ping2 = await chrome.tabs.sendMessage(tab.id, { type: "STASH_PING" });
    ponged = !!ping2?.ok;
    return { ponged, injected: true };
  } catch {
    return { ponged: false, injected: false };
  }
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
    $("status").textContent = "scanning…";
  }
  const findTab = StashTabs?.findYoutubeTab || StashApply?.findYoutubeTab;
  const tab = findTab ? await findTab() : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab?.id) {
    if (typeof StashScanProgress !== "undefined") StashScanProgress.hide();
    $("status").textContent = "no suitable tab — open youtube.com/playlist?list=WL";
    return;
  }
  if (typeof StashScanProgress !== "undefined") {
    StashScanProgress.setContext(playlistContextFromTitle(tab.title, tab.url));
  }
  const url = tab.url || "";
  if (!/youtube\.com|youtu\.be|x\.com|twitter\.com/.test(url)) {
    if (typeof StashScanProgress !== "undefined") StashScanProgress.hide();
    $("status").textContent = `no YT/X tab found (active: ${url.slice(0, 60) || "none"}). Open Watch Later first.`;
    return;
  }

  const { ponged } = await ensureScript(tab);
  if (!ponged) {
    if (typeof StashScanProgress !== "undefined") StashScanProgress.hide();
    $("status").textContent =
      `content script did not pong · ${url}. Hard-refresh that tab, then Scan again.`;
    return;
  }

  let res;
  try {
    res = await chrome.tabs.sendMessage(tab.id, { type: "STASH_SCRAPE" });
  } catch (err) {
    if (typeof StashScanProgress !== "undefined") StashScanProgress.hide();
    $("status").textContent = `scrape failed · ${url} · ${String(err)}`;
    return;
  }

  if (!res?.ok) {
    if (typeof StashScanProgress !== "undefined") StashScanProgress.hide();
    $("status").textContent = res?.error || "scrape failed";
    return;
  }

  if (!res.count) {
    if (typeof StashScanProgress !== "undefined") StashScanProgress.setDone({ brief: true });
    $("status").textContent = zeroScrapeStatus(tab, ponged, res);
    return;
  }

  const { stashItems } = await StashStorage.getAll();
  let { items, added } = StashStorage.mergeScraped(stashItems, res.items);
  const pruneResult = applyWatchLaterPrune(items, res);
  items = pruneResult.items;
  await StashStorage.setItems(items);
  await refresh();

  const hint =
    res.source === "youtube"
      ? res.isWatchLater
        ? "watch later"
        : "yt playlist (scroll for more)"
      : res.isBookmarks
        ? "bookmarks"
        : "x page";
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
    else if (pruneResult.skipped) {
      pruneBit = " · kept stale (scroll fully then Scan)";
    }
  }
  if (typeof StashScanProgress !== "undefined") {
    if (res.isWatchLater) StashScanProgress.setContext("Watch Later");
    else if (res.playlistTitle) StashScanProgress.setContext(res.playlistTitle);
    StashScanProgress.setDone({ brief: true });
  }
  $("status").textContent = `+${added} new · ${res.count} on page · ${hint}${method}${enrichBit}${pruneBit}`;
}

function openDeck() {
  const url = chrome.runtime.getURL("deck.html");
  chrome.tabs.create({ url });
}

async function apply() {
  $("btn-apply").disabled = true;
  $("status").textContent = "applying…";
  try {
    const result = await StashApply.applyDecisions({
      onProgress: (m) => {
        $("status").textContent = m;
      },
    });
    if (result.needWlTab) {
      $("status").textContent = result.error;
      return;
    }
    const failBit = result.failed?.length ? ` · ${result.failed.length} failed` : "";
    $("status").textContent =
      `removed ${result.removed} · maybe moved ${result.maybeMoved} · yes moved ${result.yesMoved}${failBit}` +
      (result.error && !result.ok ? ` · ${result.error}` : "");
    if (result.failed?.length) {
      console.warn("Stash apply failures", result.failed);
    }
  } catch (err) {
    $("status").textContent = String(err);
  } finally {
    $("btn-apply").disabled = false;
    await refresh();
  }
}

async function saveTimeBudgetFromInput() {
  const input = $("tb-budget-input");
  if (!input) return;
  let mins = Number(input.value);
  if (!Number.isFinite(mins) || mins < 0) mins = 0;
  mins = Math.round(mins);
  input.value = String(mins);
  const { stashConfig } = await StashStorage.getAll();
  if (stashConfig.timeBudgetMinutes === mins) return;
  await StashStorage.setConfig({ ...stashConfig, timeBudgetMinutes: mins });
  $("status").textContent = `budget set to ${mins} min`;
}

async function resetTriage() {
  if (!confirm("Reset marks only (does not delete videos from stash)?")) return;
  const { stashItems } = await StashStorage.getAll();
  const items = { ...stashItems };
  let n = 0;
  for (const id of Object.keys(items)) {
    const st = items[id]?.status;
    if (st === "no" || st === "maybe" || st === "yes") {
      items[id] = { ...items[id], status: "uncategorized" };
      n += 1;
    }
  }
  await StashStorage.setItems(items);
  await StashStorage.setUndo([]);
  await refresh();
  $("status").textContent = n ? `reset ${n} marks → uncategorized` : "nothing to reset";
}

async function clearStash() {
  if (!confirm("Clear entire stash? This deletes all scraped videos from Stash (not from YouTube).")) return;
  await StashStorage.setItems({});
  await StashStorage.setUndo([]);
  await refresh();
  $("status").textContent = "stash cleared — Scan Watch Later to refill";
}

$("btn-scan").addEventListener("click", scan);
$("btn-deck").addEventListener("click", openDeck);
$("btn-apply").addEventListener("click", apply);
$("btn-reset-triage").addEventListener("click", resetTriage);
const clearBtn = $("btn-clear-stash");
if (clearBtn) clearBtn.addEventListener("click", clearStash);

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
  if (area === "local" && (changes.stashItems || changes.stashConfig)) refresh();
});

StashTheme.load()
  .then(() => {
    StashTheme.wireButton();
    return refresh();
  })
  .catch(() => {
    StashTheme.wireButton();
    refresh();
  });

if (typeof StashScanProgress !== "undefined") StashScanProgress.listen();
