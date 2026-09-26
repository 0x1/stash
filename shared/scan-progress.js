/** Shared scan progress strip for side panel + deck. Calm bar + light copy. */
const StashScanProgress = (() => {
  let hideTimer = null;

  function els() {
    return {
      wrap: document.getElementById("scan-progress"),
      fill: document.getElementById("scan-progress-fill"),
      label: document.getElementById("scan-progress-label"),
      context: document.getElementById("scan-progress-context"),
      status: document.getElementById("status"),
    };
  }

  function setContext(text) {
    const { context } = els();
    if (!context) return;
    const t = (text || "").trim();
    context.textContent = t;
    context.hidden = !t;
  }

  function clearHideTimer() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function show() {
    const { wrap } = els();
    if (!wrap) return;
    clearHideTimer();
    wrap.hidden = false;
    wrap.setAttribute("aria-hidden", "false");
  }

  function hide() {
    const { wrap, fill, context } = els();
    if (!wrap) return;
    clearHideTimer();
    wrap.hidden = true;
    wrap.setAttribute("aria-hidden", "true");
    wrap.classList.remove("is-indeterminate", "is-determinate");
    if (fill) {
      fill.style.width = "0%";
      fill.style.removeProperty("margin-left");
    }
    if (context) {
      context.textContent = "";
      context.hidden = true;
    }
  }

  function setScanning(statusText) {
    const { wrap, fill, label, status } = els();
    show();
    if (wrap) {
      wrap.classList.add("is-indeterminate");
      wrap.classList.remove("is-determinate");
    }
    if (fill) fill.style.width = "32%";
    if (label) label.textContent = "scanning";
    if (status && statusText !== false) {
      status.textContent = statusText || "scanning…";
    }
  }

  /** @deprecated alias */
  const setAuditing = setScanning;

  function setMeta(done, total, statusText) {
    const { wrap, fill, label, status } = els();
    const d = Math.max(0, Number(done) || 0);
    const t = Math.max(0, Number(total) || 0);
    show();
    if (wrap) {
      wrap.classList.remove("is-indeterminate");
      wrap.classList.add("is-determinate");
    }
    const pct = t > 0 ? Math.min(100, Math.round((d / t) * 100)) : 0;
    if (fill) fill.style.width = `${pct}%`;
    // Count lives only under the bar — status stays a calm verb
    if (label) label.textContent = t > 0 ? `${d} / ${t}` : "scanning";
    if (status && statusText !== false) {
      status.textContent = statusText || "scanning…";
    }
  }

  function setDone({ brief = true } = {}) {
    const { wrap, fill, label } = els();
    show();
    if (wrap) {
      wrap.classList.remove("is-indeterminate");
      wrap.classList.add("is-determinate");
    }
    if (fill) fill.style.width = "100%";
    if (label) label.textContent = "done";
    if (!brief) {
      hide();
      return;
    }
    clearHideTimer();
    hideTimer = setTimeout(() => hide(), 420);
  }

  function applyMessage(msg) {
    if (!msg || msg.type !== "STASH_SCAN_PROGRESS") return;
    const phase = msg.phase;
    if (phase === "loading") {
      const d = Math.max(0, Number(msg.done) || 0);
      const t = Math.max(0, Number(msg.total) || 0);
      const statusText =
        t > 0 ? `loading playlist… ${d} / ${t}` : `loading playlist… ${d || ""}`.trim();
      setMeta(d, t || d, statusText);
      return;
    }
    if (phase === "page") {
      // Ignore shouty content-script labels — UI stays calm
      setScanning("scanning…");
      return;
    }
    if (phase === "meta") {
      // Prefer our calm status; ignore shouty content-script labels
      setMeta(msg.done, msg.total, null);
      return;
    }
    if (phase === "done") {
      setDone({ brief: true });
    }
  }

  function listen() {
    if (!chrome?.runtime?.onMessage) return;
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === "STASH_SCAN_PROGRESS") applyMessage(msg);
    });
  }

  return {
    show,
    hide,
    setContext,
    setScanning,
    setAuditing,
    setMeta,
    setDone,
    applyMessage,
    listen,
  };
})();
