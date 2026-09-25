(function () {
  const SOURCE = "x";

  function statusIdFromHref(href) {
    try {
      const m = href.match(/\/status\/(\d+)/);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  function estimateReadSec(text) {
    const words = (text || "").trim().split(/\s+/).filter(Boolean).length;
    const sec = Math.round((words / 200) * 60);
    return Math.min(480, Math.max(45, sec || 60));
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
      /* ignore */
    }
  }

  function scrape() {
    emitScanProgress({ phase: "page", done: 0, total: 0, label: "scanning…" });
    const items = [];
    const seen = new Set();
    const tweets = document.querySelectorAll('article[data-testid="tweet"]');

    tweets.forEach((article, index) => {
      const links = [...article.querySelectorAll('a[href*="/status/"]')];
      const statusLink = links.find(
        (a) => /\/status\/\d+$/.test(a.pathname) || /\/status\/\d+\?/.test(a.href)
      );
      const href = statusLink?.href;
      const sid = href ? statusIdFromHref(href) : null;
      if (!sid || seen.has(sid)) return;
      seen.add(sid);

      const textEl = article.querySelector('[data-testid="tweetText"]');
      const text = (textEl?.innerText || textEl?.textContent || "").trim();
      const userEl = article.querySelector('[data-testid="User-Name"]');
      const userLine = (userEl?.innerText || "").split("\n").filter(Boolean);
      const author = userLine[0] || null;
      const handle = userLine.find((t) => t.startsWith("@")) || null;

      const timeEl = article.querySelector("time");
      const postedAt = timeEl?.getAttribute("datetime") || null;
      const publishedText = timeEl?.textContent?.trim() || null;

      const title = text
        ? text.slice(0, 140) + (text.length > 140 ? "…" : "")
        : `(tweet by ${handle || author || "unknown"})`;

      const durationSec = estimateReadSec(text);

      const img =
        article.querySelector('[data-testid="tweetPhoto"] img') ||
        article.querySelector('img[src*="pbs.twimg.com/media"]') ||
        article.querySelector('img[src*="pbs.twimg.com/profile_images"]');
      const thumbnailUrl = img?.src || null;

      const avatar =
        article.querySelector('[data-testid="Tweet-User-Avatar"] img') ||
        article.querySelector('img[src*="profile_images"]');
      const channelThumbUrl = avatar?.src || null;

      items.push({
        id: `x:${sid}`,
        source: SOURCE,
        title,
        url: href.split("?")[0],
        videoId: null,
        durationSec,
        durationText: `~${Math.round(durationSec / 60)}m`,
        thumbnailUrl,
        channel: handle || author,
        channelUrl: null,
        channelThumbUrl,
        publishedText,
        publishedAt: postedAt,
        viewsText: null,
        viewsCount: null,
        scrapedAt: Date.now(),
        index,
      });
    });

    const isBookmarks =
      /\/i\/bookmarks/i.test(location.href) ||
      document.title.toLowerCase().includes("bookmark");

    emitScanProgress({ phase: "done", done: 1, total: 1, label: "" });
    return {
      ok: true,
      source: SOURCE,
      pageUrl: location.href,
      isBookmarks,
      count: items.length,
      items,
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "STASH_SCRAPE") {
      try {
        sendResponse(scrape());
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
      return true;
    }
    if (msg?.type === "STASH_PING") {
      sendResponse({ ok: true, source: SOURCE, href: location.href });
      return true;
    }
  });
})();
