/** Shared Apply progress panel for side panel + deck. */
const StashApplyProgress = (() => {
  const STORAGE_KEY = "stashApplyProgress";
  let listening = false;

  function els() {
    return {
      wrap: document.getElementById("apply-progress"),
      title: document.getElementById("apply-progress-title"),
      fill: document.getElementById("apply-progress-fill"),
      line: document.getElementById("apply-progress-line"),
      counts: document.getElementById("apply-progress-counts"),
      errors: document.getElementById("apply-progress-errors"),
      status: document.getElementById("status"),
    };
  }

  function show() {
    const { wrap } = els();
    if (!wrap) return;
    wrap.hidden = false;
    wrap.setAttribute("aria-hidden", "false");
  }

  function hide() {
    const { wrap, fill, errors } = els();
    if (!wrap) return;
    wrap.hidden = true;
    wrap.setAttribute("aria-hidden", "true");
    wrap.classList.remove("is-done", "is-failed", "is-running");
    if (fill) fill.style.width = "0%";
    if (errors) errors.innerHTML = "";
  }

  function start({ total = 0 } = {}) {
    const { wrap, title, fill, line, counts, errors } = els();
    show();
    if (wrap) {
      wrap.classList.add("is-running");
      wrap.classList.remove("is-done", "is-failed");
    }
    if (title) title.textContent = "Applying…";
    if (fill) fill.style.width = "0%";
    if (line) line.textContent = total > 0 ? `0 / ${total}` : "starting…";
    if (counts) counts.textContent = "removed 0 · maybe 0 · yes 0 · fails 0";
    if (errors) errors.innerHTML = "";
  }

  function renderErrors(list) {
    const { errors } = els();
    if (!errors) return;
    const items = Array.isArray(list) ? list.slice(-5) : [];
    errors.innerHTML = "";
    for (const raw of items) {
      const li = document.createElement("li");
      li.textContent = String(raw || "").slice(0, 120);
      errors.appendChild(li);
    }
  }

  /**
   * Accept rich progress object or legacy string.
   * @param {string | { phase?: string, message?: string, done?: number, total?: number, currentTitle?: string, currentVideoId?: string, removed?: number, maybeMoved?: number, yesMoved?: number, failed?: string[], nothingToApply?: boolean, needWlTab?: boolean }} payload
   */
  function update(payload) {
    if (payload == null) return;
    const { wrap, title, fill, line, counts, status } = els();

    if (typeof payload === "string") {
      show();
      if (wrap) {
        wrap.classList.add("is-running");
        wrap.classList.remove("is-done", "is-failed");
      }
      if (title) title.textContent = "Applying…";
      if (line) line.textContent = payload;
      if (status) status.textContent = payload;
      return;
    }

    if (payload.nothingToApply || payload.needWlTab) {
      hide();
      if (status && payload.message) status.textContent = payload.message;
      return;
    }

    const phase = payload.phase || "running";
    const done = Math.max(0, Number(payload.done) || 0);
    const total = Math.max(0, Number(payload.total) || 0);
    const removed = Number(payload.removed) || 0;
    const maybeMoved = Number(payload.maybeMoved) || 0;
    const yesMoved = Number(payload.yesMoved) || 0;
    const failed = Array.isArray(payload.failed) ? payload.failed : [];
    const failCount = failed.length;

    show();
    if (wrap) {
      wrap.classList.toggle("is-running", phase !== "done" && phase !== "failed");
      wrap.classList.toggle("is-done", phase === "done");
      wrap.classList.toggle("is-failed", phase === "failed" || (phase === "done" && failCount > 0));
    }

    if (title) {
      if (phase === "failed" || (phase === "done" && failCount > 0 && removed + maybeMoved + yesMoved === 0)) {
        title.textContent = "Failed";
      } else if (phase === "done") {
        title.textContent = "Done";
      } else {
        title.textContent = "Applying…";
      }
    }

    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : phase === "done" || phase === "failed" ? 100 : 0;
    if (fill) fill.style.width = `${pct}%`;

    let lineText = payload.message || "";
    if (!lineText) {
      const label = payload.currentTitle || payload.currentVideoId || "";
      lineText = total > 0 ? `${done} / ${total}${label ? ` · ${label}` : ""}` : label || "";
    }
    if (line) line.textContent = lineText;

    if (counts) {
      counts.textContent = `removed ${removed} · maybe ${maybeMoved} · yes ${yesMoved} · fails ${failCount}`;
    }
    renderErrors(failed);

    if (status && lineText) status.textContent = lineText;
  }

  function finish(result) {
    if (!result) {
      update({ phase: "failed", message: "Failed", done: 1, total: 1, failed: ["unknown error"] });
      return;
    }
    if (result.nothingToApply || result.needWlTab) {
      hide();
      return;
    }
    const failed = Array.isArray(result.failed) ? result.failed : [];
    const phase = !result.ok && !failed.length ? "failed" : failed.length && !(result.removed || result.maybeMoved || result.yesMoved) ? "failed" : "done";
    update({
      phase,
      message: phase === "failed" ? "Failed" : "Done",
      done: Number(result.done) || 1,
      total: Number(result.total) || 1,
      removed: result.removed || 0,
      maybeMoved: result.maybeMoved || 0,
      yesMoved: result.yesMoved || 0,
      failed,
      currentTitle: "",
      currentVideoId: "",
    });
  }

  function applyStoragePayload(payload) {
    if (!payload) {
      hide();
      return;
    }
    if (payload.nothingToApply || payload.needWlTab) {
      hide();
      return;
    }
    const phase = payload.phase || "running";
    if (phase === "start") {
      start({ total: Number(payload.total) || 0 });
    }
    update(payload);
  }

  function listen() {
    if (listening || !chrome?.storage?.onChanged) return;
    listening = true;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[STORAGE_KEY]) return;
      applyStoragePayload(changes[STORAGE_KEY].newValue);
    });
    try {
      chrome.storage.local.get(STORAGE_KEY, (data) => {
        if (chrome.runtime?.lastError) return;
        const cur = data?.[STORAGE_KEY];
        if (!cur) return;
        const phase = cur.phase || "";
        // Only hydrate an in-flight run; leave terminal Done/Failed for a fresh local start
        if (phase && phase !== "done" && phase !== "failed") {
          applyStoragePayload(cur);
        }
      });
    } catch {
      /* ignore */
    }
  }

  return { show, hide, start, update, finish, listen, STORAGE_KEY };
})();
