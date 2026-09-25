/** Day / night / system pastel themes for Stash. */
(function (root) {
  const KEY = "stashTheme";
  const DEFAULT = "system"; // day | night | system
  let mql = null;
  let mqlHandler = null;

  function normalizePref(t) {
    if (t === "day" || t === "night" || t === "system") return t;
    return DEFAULT;
  }

  function systemResolved() {
    try {
      return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches
        ? "day"
        : "night";
    } catch {
      return "night";
    }
  }

  function resolve(pref) {
    const p = normalizePref(pref);
    return p === "system" ? systemResolved() : p;
  }

  function syncSwitch(pref) {
    const p = normalizePref(pref);
    document.documentElement.setAttribute("data-theme-pref", p);
    document.querySelectorAll("[data-theme-set]").forEach((el) => {
      const on = el.getAttribute("data-theme-set") === p;
      el.classList.toggle("is-active", on);
      el.setAttribute("aria-checked", on ? "true" : "false");
    });
  }

  function bindSystemListener(pref) {
    if (mql && mqlHandler) {
      try {
        mql.removeEventListener("change", mqlHandler);
      } catch {
        try {
          mql.removeListener(mqlHandler);
        } catch {
          /* old webkit */
        }
      }
      mql = null;
      mqlHandler = null;
    }
    if (normalizePref(pref) !== "system") return;
    if (!window.matchMedia) return;
    mql = window.matchMedia("(prefers-color-scheme: light)");
    mqlHandler = () => {
      applyVisual(resolve("system"));
    };
    try {
      mql.addEventListener("change", mqlHandler);
    } catch {
      try {
        mql.addListener(mqlHandler);
      } catch {
        /* ignore */
      }
    }
  }

  function applyVisual(resolved) {
    const t = resolved === "day" ? "day" : "night";
    document.documentElement.setAttribute("data-theme", t);
    document.documentElement.style.colorScheme = t === "day" ? "light" : "dark";
    return t;
  }

  function apply(pref) {
    const p = normalizePref(pref);
    syncSwitch(p);
    bindSystemListener(p);
    applyVisual(resolve(p));
    return p;
  }

  async function load() {
    const data = await chrome.storage.local.get({ [KEY]: DEFAULT });
    return apply(data[KEY]);
  }

  async function set(pref) {
    const p = apply(pref);
    await chrome.storage.local.set({ [KEY]: p });
    return p;
  }

  function wireButton() {
    const rootEl = document.getElementById("theme-switch");
    if (!rootEl || rootEl.dataset.themeWired) return;
    rootEl.dataset.themeWired = "1";
    rootEl.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-theme-set]");
      if (!btn) return;
      const pref = btn.getAttribute("data-theme-set");
      set(pref).catch((err) => console.warn("theme set", err));
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[KEY]) {
      apply(changes[KEY].newValue);
    }
  });

  root.StashTheme = { load, set, apply, wireButton, KEY, DEFAULT, resolve };
})(typeof globalThis !== "undefined" ? globalThis : window);
