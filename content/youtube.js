(function () {
  const SOURCE = "youtube";
  const MENU_TIMEOUT_MS = 3000;

  function parseDuration(text) {
    if (!text) return null;
    const parts = String(text)
      .trim()
      .split(":")
      .map((p) => parseInt(p, 10));
    if (parts.some((n) => Number.isNaN(n))) return null;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 1) return parts[0];
    return null;
  }

  function parseViews(text) {
    if (!text) return { viewsText: null, viewsCount: null };
    const raw = String(text).trim();
    if (/^no\s+views?$/i.test(raw) || /\bno\s+views?\b/i.test(raw)) {
      return { viewsText: "No views", viewsCount: 0 };
    }
    const viewsText = /view/i.test(raw) ? raw : raw ? `${raw} views` : null;
    const m = raw.replace(/,/g, "").match(/([\d.]+)\s*([KMB])?/i);
    if (!m) return { viewsText, viewsCount: null };
    let n = parseFloat(m[1]);
    if (Number.isNaN(n)) return { viewsText, viewsCount: null };
    const suf = (m[2] || "").toUpperCase();
    if (suf === "K") n *= 1e3;
    else if (suf === "M") n *= 1e6;
    else if (suf === "B") n *= 1e9;
    return { viewsText, viewsCount: Math.round(n) };
  }

  function fmtViewsCount(n) {
    if (n == null || Number.isNaN(n)) return null;
    n = Math.round(Number(n));
    if (n <= 0) return "No views";
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B views";
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M views";
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K views";
    return `${n} views`;
  }

  /** Pull views/published from free-form labels (aria, accessibilityData). */
  function metaFromLabel(label) {
    let viewsText = null;
    let viewsCount = null;
    let publishedText = null;
    if (!label) return { viewsText, viewsCount, publishedText };
    const raw = String(label).replace(/\s+/g, " ").trim();
    // Patterns: "1,234 views", "1.2M views", "No views"
    const viewMatch =
      raw.match(/\b([\d,.]+\s*[KMB]?)\s*views?\b/i) ||
      raw.match(/\b(no)\s+views?\b/i);
    if (viewMatch) {
      const parsed = parseViews(viewMatch[0]);
      viewsText = parsed.viewsText;
      viewsCount = parsed.viewsCount;
    }
    const pubMatch = raw.match(
      /\b(\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago)\b/i
    ) || raw.match(/\b((?:Streamed|Premiered)\s+[^·•|]+)/i);
    if (pubMatch) publishedText = pubMatch[1].trim();
    return { viewsText, viewsCount, publishedText };
  }

  function firstAccessibilityLabel(...objs) {
    for (const o of objs) {
      if (!o) continue;
      if (typeof o === "string" && o.trim()) return o.trim();
      const label =
        o?.accessibility?.accessibilityData?.label ||
        o?.accessibilityData?.label ||
        o?.title?.accessibility?.accessibilityData?.label ||
        null;
      if (label) return String(label).trim();
    }
    return null;
  }

  function videoIdFromHref(href) {
    if (!href) return null;
    try {
      const u = new URL(href, location.origin);
      return u.searchParams.get("v") || null;
    } catch {
      const m = String(href).match(/[?&]v=([a-zA-Z0-9_-]{6,})/);
      return m ? m[1] : null;
    }
  }

  function upgradeThumb(src) {
    if (!src) return null;
    let s = src;
    s = s.replace(/\/(default|hqdefault|mqdefault|sddefault|maxresdefault)\./, "/hqdefault.");
    s = s.replace(/=s\d+(-[^=]*)?/g, "=s640$1");
    s = s.replace(/&w=\d+/g, "&w=640").replace(/&h=\d+/g, "&h=360");
    if (/i\.ytimg\.com/.test(s) && !/hqdefault|mqdefault|maxresdefault/.test(s)) {
      const idMatch = s.match(/\/vi\/([^/]+)\//);
      if (idMatch) return `https://i.ytimg.com/vi/${idMatch[1]}/hqdefault.jpg`;
    }
    return s;
  }

  function textFromRuns(obj) {
    if (!obj) return null;
    if (typeof obj === "string") return obj.trim() || null;
    if (obj.simpleText) return String(obj.simpleText).trim() || null;
    if (Array.isArray(obj.runs)) {
      return obj.runs
        .map((r) => r?.text || "")
        .join("")
        .trim() || null;
    }
    if (obj.content) return String(obj.content).trim() || null;
    return null;
  }

  function extractJsonObject(text, startIdx) {
    let i = startIdx;
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== "{") return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return text.slice(i, j + 1);
      }
    }
    return null;
  }

  function getYtInitialData() {
    try {
      if (typeof window.ytInitialData === "object" && window.ytInitialData) {
        return window.ytInitialData;
      }
    } catch {
      /* ignore */
    }
    for (const script of document.scripts) {
      const text = script.textContent || "";
      if (!text.includes("ytInitialData")) continue;
      const marker = text.match(/ytInitialData\s*=\s*/);
      if (!marker) continue;
      const start = marker.index + marker[0].length;
      const jsonStr = extractJsonObject(text, start);
      if (!jsonStr) continue;
      try {
        return JSON.parse(jsonStr);
      } catch {
        /* try next */
      }
    }
    return null;
  }

  function thumbFromRenderer(renderer, videoId) {
    const thumbs =
      renderer?.thumbnail?.thumbnails ||
      renderer?.thumbnailRenderer?.thumbnail?.thumbnails ||
      [];
    if (Array.isArray(thumbs) && thumbs.length) {
      const best = thumbs[thumbs.length - 1];
      return upgradeThumb(best?.url) || (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null);
    }
    return videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null;
  }

  function metaFromVideoInfo(renderer) {
    let viewsText = null;
    let viewsCount = null;
    let publishedText = null;

    function takeViews(t) {
      if (!t || viewsText != null) return;
      const parsed = parseViews(t);
      if (parsed.viewsText != null || parsed.viewsCount != null) {
        viewsText = parsed.viewsText;
        viewsCount = parsed.viewsCount;
      }
    }
    function takePub(t) {
      if (!t || publishedText) return;
      if (/(ago|Streamed|Premiered|\d{4})/i.test(t)) publishedText = t;
    }

    // Walk videoInfo.runs and sibling count/length texts
    const runs = renderer?.videoInfo?.runs;
    if (Array.isArray(runs)) {
      for (const r of runs) {
        const t = (r?.text || "").trim();
        if (!t || t === "•" || t === "·") continue;
        if (/view/i.test(t)) takeViews(t);
        else takePub(t);
      }
    }
    if (renderer?.viewCountText) takeViews(textFromRuns(renderer.viewCountText));
    if (renderer?.shortViewCountText) takeViews(textFromRuns(renderer.shortViewCountText));
    if (!publishedText && renderer?.publishedTimeText) {
      publishedText = textFromRuns(renderer.publishedTimeText);
    }
    // lengthText siblings sometimes carry accessibility labels with views
    const lengthLabel = firstAccessibilityLabel(renderer?.lengthText);
    if (lengthLabel && (!viewsText || !publishedText)) {
      const fromLen = metaFromLabel(lengthLabel);
      if (!viewsText && fromLen.viewsText != null) {
        viewsText = fromLen.viewsText;
        viewsCount = fromLen.viewsCount;
      }
      if (!publishedText && fromLen.publishedText) publishedText = fromLen.publishedText;
    }

    // Accessibility labels often: "Title by Channel 3 minutes … 1.2M views … ago"
    if (viewsText == null || publishedText == null) {
      const label = firstAccessibilityLabel(
        renderer,
        renderer?.title,
        renderer?.titleAccessibility,
        renderer?.accessibility
      );
      if (label) {
        const fromLabel = metaFromLabel(label);
        if (viewsText == null && fromLabel.viewsText != null) {
          viewsText = fromLabel.viewsText;
          viewsCount = fromLabel.viewsCount;
        }
        if (!publishedText && fromLabel.publishedText) publishedText = fromLabel.publishedText;
      }
    }

    return { viewsText, viewsCount, publishedText };
  }

  function itemFromPlaylistVideoRenderer(r, index) {
    const videoId = r.videoId || videoIdFromHref(r?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url);
    if (!videoId) return null;
    const title =
      textFromRuns(r.title) ||
      r?.title?.accessibility?.accessibilityData?.label ||
      null;
    if (!title) return null;
    const durationText =
      textFromRuns(r.lengthText) ||
      r?.lengthText?.accessibility?.accessibilityData?.label ||
      null;
    const channel =
      textFromRuns(r.shortBylineText) ||
      textFromRuns(r.ownerText) ||
      textFromRuns(r.longBylineText) ||
      null;
    let channelUrl = null;
    const bylineNav =
      r?.shortBylineText?.runs?.[0]?.navigationEndpoint ||
      r?.ownerText?.runs?.[0]?.navigationEndpoint;
    const chPath = bylineNav?.commandMetadata?.webCommandMetadata?.url;
    if (chPath) {
      try {
        channelUrl = new URL(chPath, location.origin).href;
      } catch {
        channelUrl = chPath;
      }
    }
    const meta = metaFromVideoInfo(r);
    return {
      id: `yt:${videoId}`,
      source: SOURCE,
      title,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      videoId,
      durationSec: parseDuration(durationText),
      durationText,
      thumbnailUrl: thumbFromRenderer(r, videoId),
      channel,
      channelUrl,
      channelThumbUrl: null,
      publishedText: meta.publishedText,
      publishedAt: null,
      viewsText: meta.viewsText,
      viewsCount: meta.viewsCount,
      scrapedAt: Date.now(),
      index,
    };
  }

  /** Pure clock timestamps or spoken length labels — never a video title. */
  function isDurationLike(text) {
    if (text == null) return false;
    const t = String(text).replace(/\s+/g, " ").trim();
    if (!t) return false;
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(t)) return true;
    // Accessibility length: "5 minutes 22 seconds", "1 hour 3 minutes", "45 seconds"
    if (/^\d+\s*(hours?|minutes?|seconds?)(\s+\d+\s*(hours?|minutes?|seconds?))*\.?$/i.test(t)) {
      return true;
    }
    if (/^\d+\s*(hours?|minutes?|seconds?)\b/i.test(t) && !/[a-z]/i.test(t.replace(/\d+\s*(hours?|minutes?|seconds?)/gi, "").replace(/\s+/g, ""))) {
      return true;
    }
    return false;
  }

  function isPlaylistJunkTitle(title) {
    if (!title) return false;
    const t = String(title).trim();
    if (/^\d+\s+videos?$/i.test(t)) return true;
    if (/^videos?$/i.test(t)) return true;
    if (/^\(video\b/i.test(t)) return true;
    return false;
  }

  function isWeakTitle(title) {
    if (!title) return true;
    const t = String(title).trim();
    if (!t) return true;
    if (isDurationLike(t)) return true;
    if (isPlaylistJunkTitle(t)) return true;
    return false;
  }

  function isPlaylistLockup(lockup) {
    if (!lockup || typeof lockup !== "object") return true;
    const ct = String(lockup.contentType || lockup?.contentType || "").toUpperCase();
    if (ct.includes("PLAYLIST")) return true;
    const contentId = lockup.contentId;
    if (contentId && /^(PL|LL|WL|DL|UU)/.test(String(contentId))) {
      // Playlist id as contentId — only OK if we also have a real watchEndpoint videoId
      const watchVid =
        lockup?.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint?.videoId ||
        lockup?.onTap?.innertubeCommand?.watchEndpoint?.videoId ||
        null;
      if (!watchVid) return true;
    }
    return false;
  }

  /** Prefer videoId only from watchEndpoint / watch?v= URLs — never nested playlist ids. */
  function videoIdFromLockup(lockup) {
    const direct =
      lockup?.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint?.videoId ||
      lockup?.onTap?.innertubeCommand?.watchEndpoint?.videoId ||
      null;
    if (direct && /^[a-zA-Z0-9_-]{6,}$/.test(direct) && !/^(PL|LL|WL|DL|UU)/.test(direct)) {
      return direct;
    }
    const stack = [lockup];
    const seenObj = new Set();
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || typeof cur !== "object" || seenObj.has(cur)) continue;
      seenObj.add(cur);
      if (cur.watchEndpoint?.videoId) {
        const vid = cur.watchEndpoint.videoId;
        if (/^[a-zA-Z0-9_-]{6,}$/.test(vid) && !/^(PL|LL|WL|DL|UU)/.test(vid)) return vid;
      }
      if (cur.url) {
        const fromUrl = videoIdFromHref(cur.url);
        if (fromUrl) return fromUrl;
      }
      const webUrl = cur?.commandMetadata?.webCommandMetadata?.url;
      if (webUrl) {
        const fromUrl = videoIdFromHref(webUrl);
        if (fromUrl) return fromUrl;
      }
      if (Array.isArray(cur)) {
        for (const x of cur) stack.push(x);
      } else {
        for (const [k, v] of Object.entries(cur)) {
          // Skip playlistId fields — never treat those as videoIds
          if (k === "playlistId" || k === "playlistVideoId") continue;
          if (v && typeof v === "object") stack.push(v);
        }
      }
    }
    // contentId only if it looks like an 11-char video id (not PL…)
    const contentId = lockup.contentId;
    if (
      contentId &&
      /^[a-zA-Z0-9_-]{11}$/.test(contentId) &&
      !/^(PL|LL|WL|DL|UU)/.test(contentId)
    ) {
      return contentId;
    }
    return null;
  }

  function itemFromLockup(lockup, index) {
    if (!lockup || typeof lockup !== "object") return null;
    if (isPlaylistLockup(lockup)) return null;

    const videoId = videoIdFromLockup(lockup);
    if (!videoId) return null;

    const metaRows =
      lockup?.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows ||
      lockup?.metadata?.contentMetadataViewModel?.metadataRows ||
      [];
    let durationText = null;
    const titleCandidates = [];
    const titleVm = lockup?.metadata?.lockupMetadataViewModel?.title || lockup?.metadata?.title;
    if (titleVm) {
      const tv = textFromRuns(titleVm) || titleVm?.content || null;
      if (tv && !isDurationLike(tv) && !isPlaylistJunkTitle(tv)) titleCandidates.push(tv);
      else if (tv && isDurationLike(tv) && !durationText) durationText = tv.trim();
    }
    // Also pull candidate titles from metadata rows (skip duration-like / views / dates)
    if (Array.isArray(metaRows)) {
      for (const row of metaRows) {
        const parts = row?.metadataParts || [];
        for (const p of parts) {
          const t = (textFromRuns(p?.text) || p?.text?.content || "").trim();
          if (!t) continue;
          if (isDurationLike(t)) {
            if (!durationText) durationText = t;
            continue;
          }
          if (/view/i.test(t) || /(ago|Streamed|Premiered|\d{4})/i.test(t)) continue;
          if (isPlaylistJunkTitle(t)) continue;
          if (t.length >= 2) titleCandidates.push(t);
        }
      }
    }
    let title = titleCandidates.find((t) => t && !isWeakTitle(t)) || null;
    // Playlist junk with no real title → drop; duration-only / empty title kept for enrich
    if (title && isPlaylistJunkTitle(title)) return null;
    if (!title && isPlaylistJunkTitle(titleCandidates[0])) return null;

    let channel = null;
    let publishedText = null;
    let viewsText = null;
    let viewsCount = null;
    if (Array.isArray(metaRows)) {
      for (const row of metaRows) {
        const parts = row?.metadataParts || [];
        for (const p of parts) {
          const t = textFromRuns(p?.text) || p?.text?.content || "";
          if (!t) continue;
          if (isDurationLike(t)) {
            if (!durationText) durationText = t.trim();
            continue;
          }
          if (/view/i.test(t) && !viewsText) {
            const parsed = parseViews(t);
            viewsText = parsed.viewsText;
            viewsCount = parsed.viewsCount;
          } else if (/(ago|Streamed|Premiered|\d{4})/i.test(t) && !publishedText) {
            publishedText = t;
          } else if (
            !channel &&
            !/view/i.test(t) &&
            !/(ago|Streamed)/i.test(t) &&
            !isPlaylistJunkTitle(t) &&
            t !== title
          ) {
            channel = t;
          }
        }
      }
    }
    const overlay =
      lockup?.contentImage?.thumbnailViewModel?.overlays ||
      lockup?.contentImage?.overlays;
    const stack2 = overlay ? [overlay] : [];
    while (stack2.length) {
      const cur = stack2.pop();
      if (!cur || typeof cur !== "object") continue;
      if (cur.text && /^\d+:\d+/.test(String(cur.text))) {
        durationText = String(cur.text).trim();
        break;
      }
      if (typeof cur === "object") {
        for (const v of Object.values(cur)) {
          if (v && typeof v === "object") stack2.push(v);
          else if (typeof v === "string" && /^\d{1,2}:\d{2}/.test(v) && !durationText) {
            durationText = v.trim();
          }
        }
      }
    }
    // Final guard: never ship a duration string as the title
    if (title && isDurationLike(title)) {
      if (!durationText) durationText = String(title).trim();
      title = null;
    }
    if (isPlaylistJunkTitle(title)) return null;

    return {
      id: `yt:${videoId}`,
      source: SOURCE,
      title: title || "",
      url: `https://www.youtube.com/watch?v=${videoId}`,
      videoId,
      durationSec: parseDuration(durationText),
      durationText,
      thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      channel,
      channelUrl: null,
      channelThumbUrl: null,
      publishedText,
      publishedAt: null,
      viewsText,
      viewsCount,
      scrapedAt: Date.now(),
      index,
    };
  }

  function isJunkTitleItem(it, { allowMissingTitle = false } = {}) {
    if (!it) return true;
    if (allowMissingTitle && it.videoId && (!it.title || isDurationLike(it.title))) {
      // Keep shells that still need title enrich (have a real video id)
      return isPlaylistJunkTitle(it.title);
    }
    return isWeakTitle(it.title) || isPlaylistJunkTitle(it.title);
  }

  /** Playlist lockup residue: no channel, no duration, no published. */
  function isJunkEmptyMetaItem(it) {
    if (!it) return true;
    return (
      !it.channel &&
      it.durationSec == null &&
      !it.durationText &&
      !it.publishedText
    );
  }

  function filterJunkItems(items, { afterEnrich = false } = {}) {
    return (items || []).filter((it) => {
      if (isJunkTitleItem(it, { allowMissingTitle: !afterEnrich })) return false;
      // After enrich: drop shells that still have no channel/duration/published
      if (afterEnrich && isJunkEmptyMetaItem(it)) return false;
      // Before enrich: also drop empty-meta shells that look like playlist cards
      // (no duration badge — real WL rows almost always have one). Keep items
      // that only lack channel/published so enrichMissingMeta can fill them.
      if (!afterEnrich && isJunkEmptyMetaItem(it) && !it.viewsText && it.viewsCount == null) {
        return false;
      }
      return true;
    });
  }

  function scrapeFromYtInitialData() {
    const data = getYtInitialData();
    if (!data) return [];
    const items = [];
    const seen = new Set();
    const stack = [data];
    const visited = new Set();
    let index = 0;

    while (stack.length) {
      const cur = stack.pop();
      if (!cur || typeof cur !== "object") continue;
      if (visited.has(cur)) continue;
      visited.add(cur);

      if (cur.playlistVideoRenderer) {
        const it = itemFromPlaylistVideoRenderer(cur.playlistVideoRenderer, index++);
        if (it && !seen.has(it.videoId)) {
          seen.add(it.videoId);
          items.push(it);
        }
      }
      if (cur.playlistPanelVideoRenderer) {
        const it = itemFromPlaylistVideoRenderer(cur.playlistPanelVideoRenderer, index++);
        if (it && !seen.has(it.videoId)) {
          seen.add(it.videoId);
          items.push(it);
        }
      }
      if (cur.lockupViewModel) {
        const it = itemFromLockup(cur.lockupViewModel, index++);
        if (it && !seen.has(it.videoId)) {
          seen.add(it.videoId);
          items.push(it);
        }
      }

      if (Array.isArray(cur)) {
        for (let i = cur.length - 1; i >= 0; i--) stack.push(cur[i]);
      } else {
        const vals = Object.values(cur);
        for (let i = vals.length - 1; i >= 0; i--) {
          const v = vals[i];
          if (v && typeof v === "object") stack.push(v);
        }
      }
    }
    return filterJunkItems(items);
  }

  function thumbFromRow(row, videoId) {
    const img =
      row.querySelector("img#img") ||
      row.querySelector("yt-image img") ||
      row.querySelector("#thumbnail img") ||
      row.querySelector("ytd-thumbnail img") ||
      row.querySelector("img");
    let src =
      img?.currentSrc ||
      img?.src ||
      img?.getAttribute("src") ||
      img?.getAttribute("data-thumb") ||
      img?.getAttribute("data-src") ||
      null;
    if ((!src || src.startsWith("data:")) && videoId) {
      src = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    }
    return upgradeThumb(src);
  }

  function channelThumbFromRow(row) {
    const img =
      row.querySelector("#avatar img") ||
      row.querySelector("yt-img-shadow#avatar img") ||
      row.querySelector("a#channel-thumbnail img") ||
      row.querySelector("[id*='avatar'] img");
    const src = img?.currentSrc || img?.src || img?.getAttribute("src") || null;
    if (!src || src.startsWith("data:")) return null;
    return upgradeThumb(src);
  }

  function metadataFromRow(row) {
    let viewsText = null;
    let publishedText = null;
    let viewsCount = null;

    function takeFromText(t) {
      if (!t) return;
      if (/view/i.test(t) && viewsText == null) {
        const parsed = parseViews(t);
        viewsText = parsed.viewsText;
        viewsCount = parsed.viewsCount;
      } else if (/(ago|Streamed|Premiered|\d{4})/i.test(t) && !publishedText) {
        publishedText = t;
      }
    }

    const info =
      row.querySelector("#video-info") ||
      row.querySelector("#metadata-line") ||
      row.querySelector("ytd-video-meta-block #metadata-line") ||
      row.querySelector(".metadata-line") ||
      row.querySelector("#metadata");

    const spans = info
      ? [...info.querySelectorAll("span, yt-formatted-string")]
      : [...row.querySelectorAll("#metadata-line span, #video-info span")];

    for (const el of spans) {
      takeFromText((el.textContent || "").trim());
      if (viewsText == null || !publishedText) {
        const aria = (el.getAttribute("aria-label") || "").trim();
        if (aria) {
          const fromAria = metaFromLabel(aria);
          if (viewsText == null && fromAria.viewsText != null) {
            viewsText = fromAria.viewsText;
            viewsCount = fromAria.viewsCount;
          }
          if (!publishedText && fromAria.publishedText) publishedText = fromAria.publishedText;
        }
      }
    }

    if ((!viewsText || !publishedText) && info) {
      const blob = (info.textContent || "").replace(/\s+/g, " ").trim();
      const parts = blob.split(/[•·|]/).map((p) => p.trim()).filter(Boolean);
      for (const p of parts) takeFromText(p);
    }

    // Row / title link aria-labels often include views when videoInfo is empty
    if (viewsText == null || !publishedText) {
      const labeled = [
        row,
        row.querySelector("#video-title"),
        row.querySelector("a#video-title-link"),
        row.querySelector("a[href*='watch?v=']"),
        ...row.querySelectorAll("[aria-label]"),
      ].filter(Boolean);
      for (const el of labeled) {
        const aria = (el.getAttribute?.("aria-label") || "").trim();
        if (!aria) continue;
        const fromAria = metaFromLabel(aria);
        if (viewsText == null && fromAria.viewsText != null) {
          viewsText = fromAria.viewsText;
          viewsCount = fromAria.viewsCount;
        }
        if (!publishedText && fromAria.publishedText) publishedText = fromAria.publishedText;
        if (viewsText != null && publishedText) break;
      }
    }

    return { viewsText, viewsCount, publishedText };
  }

  function titleFromLink(el) {
    if (!el) return "";
    const aria = (el.getAttribute("aria-label") || "").trim();
    // aria-label often: "Title by Channel 3 minutes 12 seconds 1.2M views"
    let fromAria = aria;
    if (fromAria) {
      fromAria = fromAria
        .replace(/\s+\d+\s+(minutes?|seconds?|hours?|days?|weeks?|months?|years?).*$/i, "")
        .replace(/\s+by\s+.+$/i, "")
        .trim();
    }
    const titleAttr = (el.getAttribute("title") || "").trim();
    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    const heading = el.closest("ytd-playlist-video-renderer, yt-lockup-view-model, ytd-rich-item-renderer")
      ?.querySelector("#video-title, h3, [id*='title']");
    const headingText = (heading?.textContent || "").replace(/\s+/g, " ").trim();
    const candidates = [titleAttr, text, fromAria, headingText, aria].filter(
      (t) => t && t.length >= 1 && !isDurationLike(t) && !isPlaylistJunkTitle(t)
    );
    return candidates[0] || "";
  }

  function scrapeFromDom() {
    const items = [];
    const seen = new Set();

    const rows = document.querySelectorAll(
      "ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer, yt-lockup-view-model, ytd-rich-item-renderer"
    );

    rows.forEach((row, index) => {
      const titleEl =
        row.querySelector("#video-title") ||
        row.querySelector("a#video-title-link") ||
        row.querySelector("a[href*='watch?v=']") ||
        row.querySelector("a[href*='/watch']");
      if (!titleEl) return;

      const href = titleEl.href || titleEl.getAttribute("href") || "";
      const videoId = videoIdFromHref(href);
      if (!videoId || seen.has(videoId)) return;
      seen.add(videoId);

      const title = titleFromLink(titleEl);
      if (!title || isWeakTitle(title)) return;

      const durEl =
        row.querySelector("span.ytd-thumbnail-overlay-time-status-renderer") ||
        row.querySelector("#text.ytd-thumbnail-overlay-time-status-renderer") ||
        row.querySelector("badge-shape .yt-badge-shape__text") ||
        row.querySelector("[class*='time-status'] #text") ||
        row.querySelector("ytd-thumbnail-overlay-time-status-renderer #text") ||
        row.querySelector(".yt-badge-shape__text");
      const durationText = (durEl?.textContent || "").trim() || null;
      const durationSec = parseDuration(durationText);

      const channelEl =
        row.querySelector("#channel-name a") ||
        row.querySelector("ytd-channel-name a") ||
        row.querySelector("#byline a") ||
        row.querySelector("a[href*='/@']") ||
        row.querySelector("a[href*='/channel/']");
      const channel = (channelEl?.textContent || "").trim() || null;
      let channelUrl = null;
      if (channelEl?.href) {
        try {
          channelUrl = new URL(channelEl.href, location.origin).href;
        } catch {
          channelUrl = channelEl.getAttribute("href");
        }
      }

      const meta = metadataFromRow(row);
      const thumbnailUrl = thumbFromRow(row, videoId);
      const channelThumbUrl = channelThumbFromRow(row);

      items.push({
        id: `yt:${videoId}`,
        source: SOURCE,
        title,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        videoId,
        durationSec,
        durationText,
        thumbnailUrl,
        channel,
        channelUrl,
        channelThumbUrl,
        publishedText: meta.publishedText,
        publishedAt: null,
        viewsText: meta.viewsText,
        viewsCount: meta.viewsCount,
        scrapedAt: Date.now(),
        index,
      });
    });

    // Fallback: any watch links
    if (items.length === 0) {
      document.querySelectorAll("a[href*='watch?v=']").forEach((a, index) => {
        const videoId = videoIdFromHref(a.href);
        if (!videoId || seen.has(videoId)) return;
        seen.add(videoId);
        const title = titleFromLink(a);
        if (!title || title.length < 1 || isWeakTitle(title)) return;
        // Skip pure nav chrome that has no meaningful label
        if (/^(watch later|youtube|home)$/i.test(title)) return;
        items.push({
          id: `yt:${videoId}`,
          source: SOURCE,
          title,
          url: `https://www.youtube.com/watch?v=${videoId}`,
          videoId,
          durationSec: null,
          durationText: null,
          thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
          channel: null,
          channelUrl: null,
          channelThumbUrl: null,
          publishedText: null,
          publishedAt: null,
          viewsText: null,
          viewsCount: null,
          scrapedAt: Date.now(),
          index,
        });
      });
    }

    return items;
  }

  function getInnertubeApiKey() {
    try {
      const fromCfg = window.ytcfg?.data_?.INNERTUBE_API_KEY;
      if (fromCfg) return String(fromCfg);
    } catch {
      /* ignore */
    }
    try {
      if (typeof ytcfg !== "undefined" && ytcfg?.data_?.INNERTUBE_API_KEY) {
        return String(ytcfg.data_.INNERTUBE_API_KEY);
      }
    } catch {
      /* ignore */
    }
    for (const script of document.scripts) {
      const text = script.textContent || "";
      if (!text.includes("INNERTUBE_API_KEY")) continue;
      const m = text.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
      if (m) return m[1];
    }
    return null;
  }

  function getInnertubeClientVersion() {
    try {
      const v =
        window.ytcfg?.data_?.INNERTUBE_CLIENT_VERSION ||
        window.ytcfg?.data_?.CLIENT_VERSION;
      if (v) return String(v);
    } catch {
      /* ignore */
    }
    try {
      if (typeof ytcfg !== "undefined") {
        const v = ytcfg?.data_?.INNERTUBE_CLIENT_VERSION || ytcfg?.data_?.CLIENT_VERSION;
        if (v) return String(v);
      }
    } catch {
      /* ignore */
    }
    for (const script of document.scripts) {
      const text = script.textContent || "";
      const m =
        text.match(/"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/) ||
        text.match(/"clientVersion"\s*:\s*"([^"]+)"/);
      if (m) return m[1];
    }
    return "2.20260924.00.00";
  }

  function getYtcfgVisitorData() {
    try {
      const v = window.ytcfg?.data_?.VISITOR_DATA || window.ytcfg?.data_?.visitorData;
      if (v) return String(v);
    } catch {
      /* ignore */
    }
    try {
      if (typeof ytcfg !== "undefined") {
        const v = ytcfg?.data_?.VISITOR_DATA || ytcfg?.data_?.visitorData;
        if (v) return String(v);
      }
    } catch {
      /* ignore */
    }
    for (const script of document.scripts) {
      const text = script.textContent || "";
      const m = text.match(/"VISITOR_DATA"\s*:\s*"([^"]+)"/) || text.match(/"visitorData"\s*:\s*"([^"]+)"/);
      if (m) return m[1];
    }
    return null;
  }

  function parseYtInitialPlayerResponse(html) {
    if (!html) return null;
    const marker = html.match(/ytInitialPlayerResponse\s*=\s*/);
    if (!marker) return null;
    const start = marker.index + marker[0].length;
    const jsonStr = extractJsonObject(html, start);
    if (!jsonStr) return null;
    try {
      return JSON.parse(jsonStr);
    } catch {
      return null;
    }
  }

  function formatPublishDate(isoOrRaw) {
    if (!isoOrRaw) return null;
    const s = String(isoOrRaw).trim();
    if (!s) return null;
    // Already relative
    if (/\bago\b/i.test(s) || /^(Streamed|Premiered)\b/i.test(s)) return s;
    // ISO date YYYY-MM-DD or full ISO
    const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
    return s;
  }

  function metaFromPlayerResponse(data) {
    if (!data || typeof data !== "object") return null;
    let viewsCount = null;
    let viewsText = null;
    let channel = null;
    let publishedText = null;
    let title = null;

    const vd = data?.videoDetails?.viewCount;
    if (vd != null && vd !== "") {
      const n = parseInt(String(vd).replace(/,/g, ""), 10);
      if (!Number.isNaN(n)) {
        viewsCount = n;
        viewsText = fmtViewsCount(n);
      }
    }
    const mf = data?.microformat?.playerMicroformatRenderer;
    if (viewsCount == null && mf?.viewCount != null) {
      const n = parseInt(String(mf.viewCount).replace(/,/g, ""), 10);
      if (!Number.isNaN(n)) {
        viewsCount = n;
        viewsText = fmtViewsCount(n);
      }
    }
    channel =
      data?.videoDetails?.author ||
      mf?.ownerChannelName ||
      null;
    if (channel) channel = String(channel).trim() || null;

    const rawTitle = data?.videoDetails?.title || mf?.title?.simpleText || textFromRuns(mf?.title);
    if (rawTitle) {
      const t = String(rawTitle).trim();
      if (t && !isDurationLike(t) && !isPlaylistJunkTitle(t)) title = t;
    }

    publishedText =
      formatPublishDate(mf?.publishDate) ||
      formatPublishDate(mf?.uploadDate) ||
      null;
    // relativeDateText sometimes on microformat / next
    if (!publishedText) {
      const rel =
        mf?.relativeDateText?.simpleText ||
        textFromRuns(mf?.relativeDateText) ||
        null;
      if (rel) publishedText = String(rel).trim();
    }

    if (viewsCount == null && channel == null && publishedText == null && title == null) return null;
    return { viewsCount, viewsText, channel, publishedText, title };
  }

  function metaFromWatchHtmlRegex(html) {
    let viewsCount = null;
    let viewsText = null;
    let channel = null;
    let publishedText = null;
    let title = null;

    const vc = html.match(/"viewCount"\s*:\s*"(\d+)"/);
    if (vc) {
      const n = parseInt(vc[1], 10);
      if (!Number.isNaN(n)) {
        viewsCount = n;
        viewsText = fmtViewsCount(n);
      }
    }
    const ch =
      html.match(/"ownerChannelName"\s*:\s*"((?:\\.|[^"\\])*)"/) ||
      html.match(/"author"\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (ch) {
      try {
        channel = JSON.parse(`"${ch[1]}"`);
      } catch {
        channel = ch[1].replace(/\\"/g, '"').replace(/\\u0026/g, "&");
      }
      channel = (channel || "").trim() || null;
    }
    const tit =
      html.match(/"videoDetails"\s*:\s*\{[\s\S]*?"title"\s*:\s*"((?:\\.|[^"\\])*)"/) ||
      html.match(/"title"\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (tit) {
      try {
        title = JSON.parse(`"${tit[1]}"`);
      } catch {
        title = tit[1].replace(/\\"/g, '"').replace(/\\u0026/g, "&");
      }
      title = (title || "").trim() || null;
      if (title && (isDurationLike(title) || isPlaylistJunkTitle(title))) title = null;
    }
    const pub =
      html.match(/"publishDate"\s*:\s*"([^"]+)"/) ||
      html.match(/"uploadDate"\s*:\s*"([^"]+)"/);
    if (pub) publishedText = formatPublishDate(pub[1]);
    if (!publishedText) {
      const rel = html.match(/"relativeDateText"\s*:\s*\{\s*"simpleText"\s*:\s*"((?:\\.|[^"\\])*)"/);
      if (rel) {
        try {
          publishedText = JSON.parse(`"${rel[1]}"`);
        } catch {
          publishedText = rel[1];
        }
      }
    }
    if (viewsCount == null && channel == null && publishedText == null && title == null) return null;
    return { viewsCount, viewsText, channel, publishedText, title };
  }

  async function fetchWatchPageMeta(videoId) {
    const res = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, {
      credentials: "include",
      headers: { Accept: "text/html" },
    });
    if (!res.ok) throw new Error(`watch ${res.status}`);
    const html = await res.text();
    const player = parseYtInitialPlayerResponse(html);
    let meta = metaFromPlayerResponse(player);
    if (!meta || (meta.viewsCount == null && !meta.channel && !meta.publishedText && !meta.title)) {
      const fromRe = metaFromWatchHtmlRegex(html);
      if (fromRe) {
        meta = {
          viewsCount: meta?.viewsCount ?? fromRe.viewsCount,
          viewsText: meta?.viewsText || fromRe.viewsText,
          channel: meta?.channel || fromRe.channel,
          publishedText: meta?.publishedText || fromRe.publishedText,
          title: meta?.title || fromRe.title,
        };
      }
    }
    return meta;
  }

  async function fetchPlayerMeta(videoId, apiKey, clientVersion, visitorData) {
    const url = `https://www.youtube.com/youtubei/v1/player?prettyPrint=false${
      apiKey ? `&key=${encodeURIComponent(apiKey)}` : ""
    }`;

    async function tryClient(client) {
      const body = {
        context: {
          client: {
            ...client,
            hl: "en",
            gl: "US",
          },
        },
        videoId,
      };
      if (visitorData) {
        body.context.client.visitorData = visitorData;
      }
      const res = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": navigator.userAgent || "",
          "X-Youtube-Client-Name": client.clientName === "ANDROID" ? "3" : "1",
          "X-Youtube-Client-Version": client.clientVersion || "",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`player ${res.status}`);
      return metaFromPlayerResponse(await res.json());
    }

    // WEB with richer context
    try {
      const web = await tryClient({
        clientName: "WEB",
        clientVersion: clientVersion || "2.20260924.00.00",
      });
      if (web && (web.viewsCount != null || web.channel || web.publishedText || web.title)) return web;
    } catch {
      /* try android */
    }
    // ANDROID fallback
    try {
      return await tryClient({
        clientName: "ANDROID",
        clientVersion: "19.29.37",
      });
    } catch {
      return null;
    }
  }

  function needsMetaEnrich(it) {
    if (!it?.videoId) return false;
    const missViews =
      (it.viewsText == null || it.viewsText === "") &&
      (it.viewsCount == null || it.viewsCount === "");
    const missChannel = !it.channel;
    const missPub = !it.publishedText;
    const missTitle = isWeakTitle(it.title);
    return missViews || missChannel || missPub || missTitle;
  }

  function applyMetaFill(it, meta) {
    if (!it || !meta) return { views: false, channel: false, date: false, title: false };
    let views = false;
    let channel = false;
    let date = false;
    let title = false;
    const missViews =
      (it.viewsText == null || it.viewsText === "") &&
      (it.viewsCount == null || it.viewsCount === "");
    if (missViews && meta.viewsCount != null) {
      it.viewsCount = meta.viewsCount;
      it.viewsText = meta.viewsText || fmtViewsCount(meta.viewsCount);
      views = true;
    }
    if (!it.channel && meta.channel) {
      it.channel = meta.channel;
      channel = true;
    }
    if (!it.publishedText && meta.publishedText) {
      it.publishedText = meta.publishedText;
      date = true;
    }
    if (meta.title && !isWeakTitle(meta.title) && isWeakTitle(it.title)) {
      // If previous "title" was actually a duration, park it in durationText
      if (it.title && isDurationLike(it.title) && !it.durationText) {
        it.durationText = String(it.title).trim();
        it.durationSec = parseDuration(it.durationText);
      }
      it.title = meta.title;
      title = true;
    }
    return { views, channel, date, title };
  }


  function emitScanProgress({ phase, done = 0, total = 0, label = "" } = {}) {
    try {
      chrome.runtime.sendMessage(
        { type: "STASH_SCAN_PROGRESS", phase, done, total, label },
        () => {
          void chrome.runtime.lastError;
        }
      );
    } catch {
      /* no listener / extension context gone */
    }
  }

  async function enrichMissingMeta(items, { cap = 100, concurrency = 4, onProgress = null } = {}) {
    if (!Array.isArray(items) || !items.length) {
      return { viewsEnriched: 0, channelsEnriched: 0, datesEnriched: 0, titlesEnriched: 0 };
    }
    const need = items.filter(needsMetaEnrich);
    if (!need.length) {
      return { viewsEnriched: 0, channelsEnriched: 0, datesEnriched: 0, titlesEnriched: 0 };
    }
    const apiKey = getInnertubeApiKey();
    const clientVersion = getInnertubeClientVersion();
    const visitorData = getYtcfgVisitorData();
    const queue = need.slice(0, cap);
    let viewsEnriched = 0;
    let channelsEnriched = 0;
    let datesEnriched = 0;
    let titlesEnriched = 0;
    let idx = 0;
    let completed = 0;

    function tickProgress() {
      if (typeof onProgress !== "function") return;
      try {
        onProgress(completed, queue.length);
      } catch {
        /* ignore UI errors */
      }
    }

    tickProgress();

    async function worker() {
      while (idx < queue.length) {
        const i = idx++;
        const it = queue[i];
        try {
          // Primary: watch-page parse (most reliable from YT page origin)
          let meta = null;
          try {
            meta = await fetchWatchPageMeta(it.videoId);
          } catch {
            meta = null;
          }
          // Secondary: innertube player WEB → ANDROID
          if (!meta || needsMetaEnrich({ ...it, ...{
            viewsText: it.viewsText || meta?.viewsText,
            viewsCount: it.viewsCount ?? meta?.viewsCount,
            channel: it.channel || meta?.channel,
            publishedText: it.publishedText || meta?.publishedText,
            title: (!isWeakTitle(it.title) ? it.title : null) || meta?.title || it.title,
          }})) {
            try {
              const fromPlayer = await fetchPlayerMeta(it.videoId, apiKey, clientVersion, visitorData);
              if (fromPlayer) {
                meta = {
                  viewsCount: meta?.viewsCount ?? fromPlayer.viewsCount,
                  viewsText: meta?.viewsText || fromPlayer.viewsText,
                  channel: meta?.channel || fromPlayer.channel,
                  publishedText: meta?.publishedText || fromPlayer.publishedText,
                  title: meta?.title || fromPlayer.title,
                };
              }
            } catch {
              /* swallow */
            }
          }
          const filled = applyMetaFill(it, meta);
          if (filled.views) viewsEnriched += 1;
          if (filled.channel) channelsEnriched += 1;
          if (filled.date) datesEnriched += 1;
          if (filled.title) titlesEnriched += 1;
        } catch {
          /* swallow per-video */
        }
        completed += 1;
        tickProgress();
        await sleep(40 + Math.floor(Math.random() * 60));
      }
    }

    const n = Math.max(1, Math.min(concurrency, queue.length));
    await Promise.all(Array.from({ length: n }, () => worker()));
    return { viewsEnriched, channelsEnriched, datesEnriched, titlesEnriched };
  }


  function parsePlaylistVideoCount() {
    // Prefer playlist header / sidebar "N videos" text, then ytInitialData fields.
    const candidates = [];
    const sel = [
      "ytd-playlist-sidebar-primary-info-renderer #stats yt-formatted-string",
      "ytd-playlist-header-renderer .metadata-stats",
      "ytd-playlist-header-renderer yt-formatted-string",
      "#page-header .yt-content-metadata-view-model__metadata-row",
      "yt-page-header-view-model .yt-content-metadata-view-model__metadata-text",
      "#publisher-container yt-formatted-string",
    ];
    for (const s of sel) {
      for (const el of document.querySelectorAll(s)) {
        const t = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (t) candidates.push(t);
      }
    }
    // Title often "(35) Watch Later - YouTube"
    if (document.title) candidates.push(document.title);
    for (const t of candidates) {
      const m =
        t.match(/([\d,]+)\s*videos?/i) ||
        t.match(/^\((\d+)\)/) ||
        t.match(/\b([\d,]+)\s*video\b/i);
      if (m) {
        const n = parseInt(m[1].replace(/,/g, ""), 10);
        if (Number.isFinite(n) && n >= 0) return n;
      }
    }
    try {
      const data = getYtInitialData();
      if (data) {
        const stack = [data];
        const seen = new Set();
        while (stack.length) {
          const cur = stack.pop();
          if (!cur || typeof cur !== "object" || seen.has(cur)) continue;
          seen.add(cur);
          const texts = [
            cur?.numVideosText,
            cur?.videoCountText,
            cur?.stats?.[0],
            cur?.stats,
          ];
          for (const raw of texts) {
            const t = textFromRuns(raw) || (typeof raw === "string" ? raw : null);
            if (!t) continue;
            const m = String(t).match(/([\d,]+)\s*videos?/i);
            if (m) {
              const n = parseInt(m[1].replace(/,/g, ""), 10);
              if (Number.isFinite(n) && n >= 0) return n;
            }
          }
          if (typeof cur.numVideos === "number" && cur.numVideos >= 0) return cur.numVideos;
          if (Array.isArray(cur)) {
            for (const x of cur) stack.push(x);
          } else {
            for (const v of Object.values(cur)) {
              if (v && typeof v === "object") stack.push(v);
            }
          }
          if (seen.size > 8000) break;
        }
      }
    } catch {
      /* ignore */
    }
    return null;
  }


  /** Unique videoIds currently present in DOM rows + ytInitialData (best-effort). */
  function countLoadedPlaylistVideoIds() {
    const ids = new Set();
    try {
      for (const it of scrapeFromYtInitialData()) {
        if (it?.videoId) ids.add(it.videoId);
      }
    } catch {
      /* ignore */
    }
    try {
      for (const it of scrapeFromDom()) {
        if (it?.videoId) ids.add(it.videoId);
      }
    } catch {
      /* ignore */
    }
    // Cheap DOM pass for ids even when title/filter would drop them
    document
      .querySelectorAll(
        "ytd-playlist-video-renderer a[href*='watch?v='], yt-lockup-view-model a[href*='watch?v='], ytd-playlist-panel-video-renderer a[href*='watch?v=']"
      )
      .forEach((a) => {
        const id = videoIdFromHref(a.href || a.getAttribute("href") || "");
        if (id) ids.add(id);
      });
    return ids;
  }

  function findPlaylistScrollParent() {
    const candidates = [
      document.querySelector("ytd-playlist-video-list-renderer #contents"),
      document.querySelector("#contents.ytd-playlist-video-list-renderer"),
      document.querySelector("ytd-playlist-video-list-renderer"),
      document.querySelector("ytd-two-column-browse-results-renderer #primary"),
      document.querySelector("ytd-two-column-browse-results-renderer"),
      document.querySelector("#primary ytd-section-list-renderer"),
      document.scrollingElement,
    ].filter(Boolean);
    for (const el of candidates) {
      try {
        const style = window.getComputedStyle(el);
        const oy = style?.overflowY || "";
        const scrollable =
          el.scrollHeight > el.clientHeight + 40 &&
          (oy === "auto" || oy === "scroll" || oy === "overlay" || el === document.scrollingElement);
        if (scrollable || el === document.scrollingElement) return el;
      } catch {
        /* try next */
      }
    }
    return document.scrollingElement || document.documentElement;
  }

  function scrollPlaylistToBottom() {
    const el = findPlaylistScrollParent();
    try {
      if (el && el !== document.scrollingElement && el !== document.documentElement && el !== document.body) {
        el.scrollTop = el.scrollHeight;
      }
    } catch {
      /* ignore */
    }
    try {
      window.scrollTo(0, document.documentElement.scrollHeight || document.body.scrollHeight || 0);
    } catch {
      /* ignore */
    }
  }

  /**
   * Auto-scroll a playlist / Watch Later page until rows are loaded (or stall / cap).
   * @returns {{ loadedFully: boolean, playlistVideoCount: number|null, scrollPasses: number, loadedCount: number }}
   */
  async function ensurePlaylistFullyLoaded() {
    const target = parsePlaylistVideoCount();
    let ids = countLoadedPlaylistVideoIds();
    let loaded = ids.size;
    let scrollPasses = 0;
    let stagnant = 0;
    const MAX_SCROLLS = 80;
    const STAGNANT_LIMIT = 4;
    const RATIO = 0.98;
    const started = Date.now();
    const MAX_MS = 45000;

    const isPlaylistPage =
      /[?&]list=/i.test(location.href) ||
      /playlist/i.test(location.pathname) ||
      /watch_later/i.test(location.href);

    if (!isPlaylistPage) {
      return {
        loadedFully: true,
        playlistVideoCount: target,
        scrollPasses: 0,
        loadedCount: loaded,
      };
    }

    emitScanProgress({
      phase: "loading",
      done: loaded,
      total: target || loaded || 0,
      label: target
        ? `loading playlist… ${loaded} / ${target}`
        : `loading playlist… ${loaded}`,
    });

    // Already complete?
    if (target != null && loaded >= target * RATIO) {
      return {
        loadedFully: loaded >= target * RATIO,
        playlistVideoCount: target,
        scrollPasses: 0,
        loadedCount: loaded,
      };
    }

    while (scrollPasses < MAX_SCROLLS && Date.now() - started < MAX_MS) {
      const prev = loaded;
      scrollPlaylistToBottom();
      scrollPasses += 1;
      await sleep(350 + Math.floor(Math.random() * 200)); // ~350–550ms
      ids = countLoadedPlaylistVideoIds();
      loaded = ids.size;

      emitScanProgress({
        phase: "loading",
        done: loaded,
        total: target || loaded || 0,
        label: target
          ? `loading playlist… ${loaded} / ${target}`
          : `loading playlist… ${loaded}`,
      });

      if (target != null && loaded >= Math.ceil(target * RATIO)) {
        return {
          loadedFully: true,
          playlistVideoCount: target,
          scrollPasses,
          loadedCount: loaded,
        };
      }

      if (loaded <= prev) {
        stagnant += 1;
        if (stagnant >= STAGNANT_LIMIT) break;
      } else {
        stagnant = 0;
      }
    }

    // No reported target: stall / cap is best-effort complete.
    // With a target: only claim full when we hit the 98% bar.
    let loadedFully;
    if (target == null) {
      loadedFully = true;
    } else {
      loadedFully = loaded >= Math.ceil(target * RATIO) || loaded === target;
    }

    return {
      loadedFully,
      playlistVideoCount: target,
      scrollPasses,
      loadedCount: loaded,
    };
  }

  async function scrape() {
    emitScanProgress({ phase: "page", done: 0, total: 0, label: "scanning…" });
    let loadMeta = {
      loadedFully: true,
      playlistVideoCount: null,
      scrollPasses: 0,
      loadedCount: 0,
    };
    try {
      loadMeta = await ensurePlaylistFullyLoaded();
    } catch {
      /* proceed with whatever is loaded */
    }
    emitScanProgress({ phase: "page", done: 0, total: 0, label: "scanning…" });
    let items = scrapeFromYtInitialData();
    const fromData = items.length;
    if (items.length === 0) {
      items = scrapeFromDom();
    } else {
      // Merge any DOM-only extras (lazy-loaded beyond initial data)
      const seen = new Set(items.map((i) => i.videoId));
      const domItems = scrapeFromDom();
      for (const it of domItems) {
        if (!seen.has(it.videoId)) {
          seen.add(it.videoId);
          items.push(it);
        } else {
          // Enrich missing fields from DOM
          const prev = items.find((x) => x.videoId === it.videoId);
          if (prev) {
            if (!prev.channelThumbUrl && it.channelThumbUrl) prev.channelThumbUrl = it.channelThumbUrl;
            if (!prev.viewsText && it.viewsText) {
              prev.viewsText = it.viewsText;
              prev.viewsCount = it.viewsCount;
            }
            if (!prev.publishedText && it.publishedText) prev.publishedText = it.publishedText;
            if (!prev.channel && it.channel) prev.channel = it.channel;
            if (!prev.durationText && it.durationText) {
              prev.durationText = it.durationText;
              prev.durationSec = it.durationSec;
            }
            // Prefer a real title over a duration-like / empty one
            if (it.title && !isWeakTitle(it.title) && isWeakTitle(prev.title)) {
              if (prev.title && isDurationLike(prev.title) && !prev.durationText) {
                prev.durationText = String(prev.title).trim();
                prev.durationSec = parseDuration(prev.durationText);
              }
              prev.title = it.title;
            }
            if (!prev.durationText && prev.title && isDurationLike(prev.title)) {
              prev.durationText = String(prev.title).trim();
              prev.durationSec = parseDuration(prev.durationText);
              if (it.title && !isWeakTitle(it.title)) prev.title = it.title;
              else prev.title = "";
            }
          }
        }
      }
    }

    items = filterJunkItems(items, { afterEnrich: false });

    let viewsEnriched = 0;
    let channelsEnriched = 0;
    let datesEnriched = 0;
    let titlesEnriched = 0;
    try {
      const needCount = Math.min(100, items.filter(needsMetaEnrich).length);
      if (needCount > 0) {
        emitScanProgress({
          phase: "meta",
          done: 0,
          total: needCount,
          label: `scanning… 0 / ${needCount}`,
        });
      }
      const er = await enrichMissingMeta(items, {
        cap: 100,
        concurrency: 4,
        onProgress: (done, total) => {
          emitScanProgress({
            phase: "meta",
            done,
            total,
            label: `scanning… ${done} / ${total}`,
          });
        },
      });
      viewsEnriched = er.viewsEnriched || 0;
      channelsEnriched = er.channelsEnriched || 0;
      datesEnriched = er.datesEnriched || 0;
      titlesEnriched = er.titlesEnriched || 0;
    } catch {
      /* keep scrape result even if enrichment fails */
    }

    items = filterJunkItems(items, { afterEnrich: true });
    emitScanProgress({ phase: "done", done: 1, total: 1, label: "" });

    const isWatchLater =
      /list=WL/i.test(location.href) ||
      /[?&]list=WL(?:&|$)/i.test(location.href) ||
      /watch_later/i.test(location.href) ||
      /\bwatch later\b/i.test(document.title || "");

    // Prefer the real product name for WL; strip "(86) … - YouTube" noise otherwise.
    let playlistTitle = null;
    if (isWatchLater) {
      playlistTitle = "Watch Later";
    } else {
      playlistTitle =
        (document.title || "")
          .replace(/\s*-\s*YouTube\s*$/i, "")
          .replace(/^\(\d+\)\s*/, "")
          .trim() || null;
    }

    const playlistVideoCount =
      loadMeta.playlistVideoCount != null
        ? loadMeta.playlistVideoCount
        : parsePlaylistVideoCount();
    const loadedFully =
      loadMeta.loadedFully === true ||
      (playlistVideoCount != null &&
        items.length >= Math.ceil(Number(playlistVideoCount) * 0.98));

    return {
      ok: true,
      source: SOURCE,
      pageUrl: location.href,
      isWatchLater,
      playlistTitle,
      playlistVideoCount,
      count: items.length,
      items,
      scrapeMethod: fromData > 0 ? "ytInitialData" : "dom",
      viewsEnriched,
      channelsEnriched,
      datesEnriched,
      titlesEnriched,
      loadedFully,
      scrollPasses: loadMeta.scrollPasses || 0,
      loadedCount: loadMeta.loadedCount || items.length,
    };
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function findRowByVideoId(videoId) {
    const rows = document.querySelectorAll(
      "ytd-playlist-video-renderer, yt-lockup-view-model, ytd-playlist-panel-video-renderer"
    );
    for (const row of rows) {
      const a =
        row.querySelector(`a[href*="v=${videoId}"]`) ||
        row.querySelector("#video-title") ||
        row.querySelector("a[href*='watch?v=']");
      const href = a?.href || a?.getAttribute("href") || "";
      if (href.includes(`v=${videoId}`) || videoIdFromHref(href) === videoId) return row;
    }
    return null;
  }

  function findLinkForVideoId(videoId) {
    const links = document.querySelectorAll(`a[href*="v=${videoId}"]`);
    for (const a of links) {
      const href = a.href || a.getAttribute("href") || "";
      if (href.includes(`v=${videoId}`) || videoIdFromHref(href) === videoId) return a;
    }
    return null;
  }

  function rowFromLink(link) {
    if (!link) return null;
    return (
      link.closest(
        "ytd-playlist-video-renderer, yt-lockup-view-model, ytd-playlist-panel-video-renderer, ytd-rich-item-renderer"
      ) || null
    );
  }

  async function scrollPlaylistTowardVideo(videoId) {
    const link = findLinkForVideoId(videoId);
    if (link) {
      link.scrollIntoView({ block: "center", inline: "nearest" });
      await sleep(220);
      return;
    }
    const list =
      document.querySelector("ytd-playlist-video-list-renderer #contents") ||
      document.querySelector("#contents.ytd-playlist-video-list-renderer") ||
      document.querySelector("ytd-playlist-video-list-renderer") ||
      null;
    const delta = Math.max(420, Math.floor(window.innerHeight * 0.85));
    if (list && typeof list.scrollTop === "number") {
      list.scrollTop = (list.scrollTop || 0) + delta;
    }
    window.scrollBy(0, delta);
    await sleep(350);
  }

  /** Find playlist row; scroll / search link and retry a couple times if virtualized out of view. */
  async function findRowByVideoIdResilient(videoId, attempts = 3) {
    let row = findRowByVideoId(videoId);
    if (row) return row;
    for (let i = 0; i < attempts; i++) {
      await scrollPlaylistTowardVideo(videoId);
      row = findRowByVideoId(videoId);
      if (row) return row;
      const link = findLinkForVideoId(videoId);
      const fromLink = rowFromLink(link);
      if (fromLink) {
        fromLink.scrollIntoView({ block: "center", inline: "nearest" });
        await sleep(180);
        return fromLink;
      }
    }
    return null;
  }

  function clickMenuButton(row) {
    const btn =
      row.querySelector("button#button[aria-label*='Action']") ||
      row.querySelector("yt-icon-button#button") ||
      row.querySelector("ytd-menu-renderer yt-icon-button") ||
      row.querySelector("#menu button") ||
      row.querySelector("button[aria-label*='More']") ||
      row.querySelector("button[aria-label*='action menu']");
    if (!btn) return false;
    btn.click();
    return true;
  }

  async function waitForMenuItems(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const items = [
        ...document.querySelectorAll(
          "ytd-menu-service-item-renderer, tp-yt-paper-item, ytd-menu-popup-renderer yt-formatted-string, [role='menuitem']"
        ),
      ].filter(visible);
      if (items.length) return items;
      await sleep(80);
    }
    return [];
  }

  function textOf(el) {
    return (el.textContent || "").replace(/\s+/g, " ").trim();
  }

  function pressEscape() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  }

  /** Score remove-menu labels; higher = more specific. */
  function removeMenuMatchScore(text) {
    const t = String(text || "");
    if (/remove from watch later/i.test(t)) return 3;
    if (/remove from playlist/i.test(t)) return 2;
    if (/remove video/i.test(t)) return 1;
    return 0;
  }

  function pickRemoveMenuItem(items) {
    let best = null;
    let bestScore = 0;
    for (const el of items) {
      const score = removeMenuMatchScore(textOf(el));
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  }

  function visibleMenuLabels(items, limit = 4) {
    const labels = [];
    const seen = new Set();
    for (const el of items) {
      const t = textOf(el);
      if (!t || seen.has(t)) continue;
      seen.add(t);
      labels.push(t);
      if (labels.length >= limit) break;
    }
    return labels;
  }

  async function closeStrayMenus() {
    const stillOpen = [
      ...document.querySelectorAll(
        "ytd-menu-popup-renderer, tp-yt-iron-dropdown:not([aria-hidden='true']), [role='menu']"
      ),
    ].some(visible);
    if (stillOpen) {
      pressEscape();
      await sleep(80);
    }
  }

  async function removeFromWatchLater(videoId) {
    if (!videoId) return { ok: false, error: "missing videoId" };
    const row = await findRowByVideoIdResilient(videoId);
    if (!row) {
      // Already off Watch Later (or never loaded) — treat as success so Apply drops the mark
      return { ok: true, alreadyGone: true };
    }
    row.scrollIntoView({ block: "center" });
    await sleep(150);
    if (!clickMenuButton(row)) return { ok: false, error: "menu button not found" };

    const items = await waitForMenuItems(MENU_TIMEOUT_MS);
    const target = pickRemoveMenuItem(items);
    if (!target) {
      pressEscape();
      const labels = visibleMenuLabels(items, 4);
      const listed = labels.length ? labels.join(" · ") : "(empty menu)";
      return {
        ok: false,
        error: `Remove item not in menu (saw: ${listed})`,
      };
    }
    const clickable =
      target.closest("ytd-menu-service-item-renderer") ||
      target.closest("[role='menuitem']") ||
      target.closest("tp-yt-paper-item") ||
      target;
    clickable.click();
    await sleep(220);
    await closeStrayMenus();
    return { ok: true };
  }

  function playlistIdFromEl(el) {
    if (!el) return null;
    const attrs = [
      el.getAttribute?.("data-playlist-id"),
      el.getAttribute?.("data-list-id"),
      el.dataset?.playlistId,
      el.dataset?.listId,
    ].filter(Boolean);
    for (const a of attrs) {
      if (/^(PL|LL|WL|DL|UU)[a-zA-Z0-9_-]+$/.test(a) || a === "WL" || a === "LL" || a === "DL") return a;
    }
    const hrefEls = [el, ...el.querySelectorAll?.("a[href]") || []];
    for (const a of hrefEls) {
      const href = a.href || a.getAttribute?.("href") || "";
      const m = String(href).match(/[?&]list=([a-zA-Z0-9_-]+)/);
      if (m) return m[1];
    }
    // Walk up for playlist id in nested data
    let cur = el;
    for (let i = 0; i < 6 && cur; i++) {
      const html = cur.outerHTML || "";
      const m = html.match(/list[=:]["']?(PL[a-zA-Z0-9_-]{10,})/);
      if (m) return m[1];
      cur = cur.parentElement;
    }
    return null;
  }

  function matchPlaylistCandidate(el, playlistId, playlistName) {
    const t = textOf(el);
    const id = playlistIdFromEl(el);
    if (playlistId && id && id === playlistId) return true;
    if (playlistName) {
      if (t === playlistName) return true;
      // Prefer exact label match over includes for short names
      const label =
        el.querySelector?.("#label") ||
        el.querySelector?.("yt-formatted-string") ||
        el.querySelector?.("[id*='title']");
      if (label && textOf(label) === playlistName) return true;
    }
    return false;
  }

  async function addToPlaylist(videoId, playlistName, playlistId) {
    if (!videoId) return { ok: false, needsApi: true, error: "missing videoId" };
    if (!playlistName && !playlistId) {
      return { ok: false, needsApi: true, error: "missing playlistName/playlistId" };
    }

    const row = await findRowByVideoIdResilient(videoId);
    if (!row) {
      return { ok: false, needsApi: true, error: `row not found for ${videoId}` };
    }
    row.scrollIntoView({ block: "center" });
    await sleep(150);
    if (!clickMenuButton(row)) {
      return { ok: false, needsApi: true, error: "menu button not found" };
    }

    let items = await waitForMenuItems(MENU_TIMEOUT_MS);
    let saveItem = items.find(
      (el) => /save to playlist/i.test(textOf(el)) || /^save$/i.test(textOf(el))
    );
    if (!saveItem) {
      pressEscape();
      const labels = visibleMenuLabels(items, 4);
      const listed = labels.length ? labels.join(" · ") : "(empty menu)";
      return {
        ok: false,
        needsApi: true,
        error: `Save / Save to playlist not in ⋮ menu (saw: ${listed})`,
      };
    }
    const saveClick =
      saveItem.closest("ytd-menu-service-item-renderer") ||
      saveItem.closest("[role='menuitem']") ||
      saveItem;
    saveClick.click();
    await sleep(300);

    const start = Date.now();
    let playlistEl = null;
    while (Date.now() - start < MENU_TIMEOUT_MS) {
      const candidates = [
        ...document.querySelectorAll(
          "ytd-playlist-add-to-option-renderer, tp-yt-paper-checkbox, yt-list-item-view-model, [role='checkbox'], ytd-compact-playlist-renderer, yt-lockup-view-model"
        ),
      ].filter(visible);

      // Prefer id match, then exact name
      if (playlistId) {
        playlistEl = candidates.find((el) => matchPlaylistCandidate(el, playlistId, null));
      }
      if (!playlistEl && playlistName) {
        playlistEl = candidates.find((el) => {
          const t = textOf(el);
          const label =
            el.querySelector?.("#label") ||
            el.querySelector?.("yt-formatted-string") ||
            el.querySelector?.("[id*='title']");
          const lab = label ? textOf(label) : "";
          return lab === playlistName || t === playlistName;
        });
      }
      if (!playlistEl && playlistName) {
        playlistEl = candidates.find((el) => textOf(el).includes(playlistName));
      }
      if (playlistEl) break;

      const labels = [...document.querySelectorAll("#label, yt-formatted-string, span, a")].filter(visible);
      let lab = null;
      if (playlistId) {
        lab = labels.find((el) => playlistIdFromEl(el) === playlistId || playlistIdFromEl(el.closest("a, div, ytd-playlist-add-to-option-renderer")) === playlistId);
      }
      if (!lab && playlistName) {
        lab = labels.find((el) => textOf(el) === playlistName);
      }
      if (lab) {
        playlistEl =
          lab.closest("ytd-playlist-add-to-option-renderer") ||
          lab.closest("[role='option']") ||
          lab.closest("tp-yt-paper-checkbox") ||
          lab.closest("yt-list-item-view-model") ||
          lab;
        break;
      }
      await sleep(100);
    }

    if (!playlistEl) {
      pressEscape();
      const label = playlistName || playlistId || "?";
      return {
        ok: false,
        needsApi: true,
        error: `Playlist "${label}" not visible — create it on YouTube first`,
      };
    }

    const checkbox =
      playlistEl.querySelector("tp-yt-paper-checkbox") ||
      playlistEl.querySelector("[aria-checked]") ||
      (playlistEl.getAttribute("aria-checked") != null ? playlistEl : null);
    const checked =
      checkbox?.getAttribute("aria-checked") === "true" ||
      checkbox?.checked === true ||
      playlistEl.getAttribute("aria-checked") === "true";

    if (!checked) {
      (checkbox || playlistEl).click();
      await sleep(250);
    }

    pressEscape();
    const closeBtn = document.querySelector(
      "yt-icon-button[aria-label*='Close'], button[aria-label*='Close']"
    );
    if (closeBtn && visible(closeBtn)) closeBtn.click();

    return { ok: true, matchedId: playlistIdFromEl(playlistEl) || playlistId || null };
  }

  const SYSTEM_PLAYLIST_IDS = new Set(["WL", "LL", "DL"]);

  function isUserPlaylistId(id) {
    if (!id || typeof id !== "string") return false;
    if (SYSTEM_PLAYLIST_IDS.has(id)) return false;
    // User playlists are typically PL…; also allow UU channel uploads if ever needed — exclude UU
    if (id.startsWith("UU")) return false;
    return id.startsWith("PL") || /^[a-zA-Z0-9_-]{10,}$/.test(id);
  }

  function collectPlaylistsFromObject(rootObj) {
    const found = new Map(); // id -> name
    if (!rootObj || typeof rootObj !== "object") return found;
    const stack = [rootObj];
    const visited = new Set();

    function add(id, name) {
      if (!id) return;
      const n = (name || "").trim();
      if (!n) return;
      if (!found.has(id) || (n && n.length > (found.get(id) || "").length)) {
        found.set(id, n);
      }
    }

    while (stack.length) {
      const cur = stack.pop();
      if (!cur || typeof cur !== "object") continue;
      if (visited.has(cur)) continue;
      visited.add(cur);

      // Classic playlist renderers
      const pr = cur.playlistRenderer || cur.gridPlaylistRenderer || cur.compactPlaylistRenderer;
      if (pr) {
        const id = pr.playlistId || pr?.navigationEndpoint?.watchEndpoint?.playlistId;
        const name =
          textFromRuns(pr.title) ||
          pr?.title?.simpleText ||
          textFromRuns(pr?.headline) ||
          null;
        if (id) add(id, name || id);
      }

      // Guide entries
      if (cur.guideEntryRenderer) {
        const g = cur.guideEntryRenderer;
        const id =
          g?.navigationEndpoint?.browseEndpoint?.browseId ||
          g?.navigationEndpoint?.watchEndpoint?.playlistId ||
          null;
        // browseId for playlists is often VLxxxxxxxx where xxxxxxxx is playlist id
        let pid = id;
        if (pid && pid.startsWith("VL")) pid = pid.slice(2);
        const name = textFromRuns(g.formattedTitle) || textFromRuns(g.title) || null;
        if (pid && (pid.startsWith("PL") || SYSTEM_PLAYLIST_IDS.has(pid))) add(pid, name || pid);
      }

      // Lockups with playlist
      if (cur.lockupViewModel) {
        const lock = cur.lockupViewModel;
        const contentId = lock.contentId;
        if (contentId && String(contentId).startsWith("PL")) {
          const titleVm = lock?.metadata?.lockupMetadataViewModel?.title || lock?.metadata?.title;
          const name = textFromRuns(titleVm) || titleVm?.content || null;
          add(contentId, name || contentId);
        }
      }

      // Generic: object with playlistId + title-ish
      if (cur.playlistId && typeof cur.playlistId === "string") {
        const name =
          textFromRuns(cur.title) ||
          textFromRuns(cur.headline) ||
          cur?.title?.simpleText ||
          textFromRuns(cur.formattedTitle) ||
          null;
        if (name) add(cur.playlistId, name);
      }

      // browseEndpoint playlist-ish
      const browseId = cur?.browseEndpoint?.browseId || cur?.navigationEndpoint?.browseEndpoint?.browseId;
      if (typeof browseId === "string" && browseId.startsWith("VL")) {
        const pid = browseId.slice(2);
        const name =
          textFromRuns(cur.title) ||
          textFromRuns(cur.formattedTitle) ||
          textFromRuns(cur?.guideEntryRenderer?.formattedTitle) ||
          null;
        if (name) add(pid, name);
      }

      if (Array.isArray(cur)) {
        for (let i = cur.length - 1; i >= 0; i--) stack.push(cur[i]);
      } else {
        const vals = Object.values(cur);
        for (let i = vals.length - 1; i >= 0; i--) {
          const v = vals[i];
          if (v && typeof v === "object") stack.push(v);
        }
      }
    }
    return found;
  }

  function playlistsFromMap(map) {
    const out = [];
    for (const [id, name] of map.entries()) {
      out.push({ id, name });
    }
    out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    return out;
  }

  function parseYtInitialDataFromHtml(html) {
    if (!html) return null;
    const marker = html.match(/ytInitialData\s*=\s*/);
    if (!marker) return null;
    const start = marker.index + marker[0].length;
    const jsonStr = extractJsonObject(html, start);
    if (!jsonStr) return null;
    try {
      return JSON.parse(jsonStr);
    } catch {
      return null;
    }
  }

  async function fetchPlaylistsPage() {
    try {
      const res = await fetch("https://www.youtube.com/feed/playlists", {
        credentials: "include",
        headers: { Accept: "text/html" },
      });
      if (!res.ok) return { ok: false, error: `fetch ${res.status}` };
      const html = await res.text();
      const data = parseYtInitialDataFromHtml(html);
      if (!data) return { ok: false, error: "no ytInitialData in /feed/playlists" };
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  async function listPlaylists() {
    const map = new Map();
    let method = "none";

    // 1) Current page ytInitialData
    const local = getYtInitialData();
    if (local) {
      const found = collectPlaylistsFromObject(local);
      for (const [id, name] of found) map.set(id, name);
      if (map.size) method = "ytInitialData";
    }

    // Filter to user playlists for destination count, but keep all in raw for method decision
    let userCount = [...map.keys()].filter(isUserPlaylistId).length;

    // 2) If fewer than 3 user playlists, fetch /feed/playlists
    if (userCount < 3) {
      const fetched = await fetchPlaylistsPage();
      if (fetched.ok && fetched.data) {
        const found = collectPlaylistsFromObject(fetched.data);
        for (const [id, name] of found) {
          if (!map.has(id)) map.set(id, name);
          else if ((name || "").length > (map.get(id) || "").length) map.set(id, name);
        }
        method = method === "none" ? "feed/playlists" : `${method}+feed/playlists`;
        userCount = [...map.keys()].filter(isUserPlaylistId).length;
      } else if (method === "none") {
        return {
          ok: false,
          playlists: [],
          method: "fail",
          count: 0,
          error: fetched.error || "could not discover playlists",
        };
      }
    }

    // Destinations: user playlists only (exclude WL/LL/DL/UU)
    const all = playlistsFromMap(map);
    const playlists = all.filter((p) => isUserPlaylistId(p.id));

    return {
      ok: true,
      playlists,
      method,
      count: playlists.length,
      excludedSystem: all.filter((p) => !isUserPlaylistId(p.id)).map((p) => ({ id: p.id, name: p.name })),
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "STASH_SCRAPE") {
      scrape()
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }
    if (msg?.type === "STASH_PING") {
      sendResponse({ ok: true, source: SOURCE, href: location.href });
      return true;
    }
    if (msg?.type === "STASH_REMOVE_FROM_WL") {
      removeFromWatchLater(msg.videoId).then(sendResponse).catch((err) => {
        sendResponse({ ok: false, error: String(err) });
      });
      return true;
    }
    if (msg?.type === "STASH_ADD_TO_PLAYLIST") {
      addToPlaylist(msg.videoId, msg.playlistName, msg.playlistId)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, needsApi: true, error: String(err) }));
      return true;
    }
    if (msg?.type === "STASH_LIST_PLAYLISTS") {
      listPlaylists()
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, playlists: [], count: 0, error: String(err) }));
      return true;
    }
  });
})();
