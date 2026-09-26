# stash deck

Tinder-like triage for **YouTube Watch Later** (X bookmarks secondary). Built for Punk Software Hack Night · `#punksoftware`

## Load / reload

1. `chrome://extensions` → **Developer mode** → **Load unpacked** → this folder (`stash/`)
2. After code changes: **Reload** the extension, then **hard-refresh** any open YouTube tab and the deck tab

## Demo script (~90s)

1. On YouTube: create a playlist named **`Maybe Watch Later`** (or pick any playlist in deck config).
2. Open [Watch Later](https://www.youtube.com/playlist?list=WL) (Scan auto-scrolls to load the full list).
3. Click the **stash** icon (side panel) → **Scan**.
4. Side panel shows cover thumb + counts → **Start triage**.
5. On the deck: hammer keys
   - **← / n / j** → no (default: remove from WL on Apply)
   - **→ / y / k** → maybe (add to Maybe playlist, then remove from WL)
   - **↑ / Space** → yes (default: keep in WL)
   - **Esc / Backspace** → undo
6. Optional: ⚙ config — set No / Maybe / Yes destinations (Refresh playlists with a YT tab open).
7. Click **Apply decisions** (deck or side panel) with the WL tab open.

## Keys (deck tab)

| keys | meaning |
|------|---------|
| `←` `n` `j` | **no** — remove from WL (or move to a playlist) on apply |
| `→` `y` `k` | **maybe** — add to Maybe playlist, then remove from WL |
| `↑` `Space` | **yes** — keep in WL (or move to Yes playlist) |
| `Esc` `Backspace` | undo last decision |

Uncategorized items are left alone on Apply.

**0.3.20** — Maybe Save-to-playlist: search/scroll the virtualized picker, case-insensitive name match, resolve playlist id from cache before Apply, clearer miss errors (visible names + scroll/search hint). Soft cache-miss preflight; config hint when default Maybe isn’t cached. Side panel **Start triage** (was Open full deck).

**0.3.19** — Pause mid-scan (Scan morphs to Pause): keep what’s loaded, merge into stash, triage while the rest waits. Clearer per-phase stay-on-page tips when the Watch Later tab is hidden (`paused — focus Watch Later to keep loading` / `…to keep filling details`). Leaving the playlist mid-load finalizes a partial like Pause.

**0.3.18** — Pause WL scroll when the tab is hidden; clearer loading / filling-details progress; prefer largest playlist header count.

**0.3.17** — Fix the side-panel pie card after clearing the stash.

**0.3.16** — Clarify button tooltips and triage confirmation dialogs.

## Watch Later sync (0.3.15)

**Duration totals** compact when ≥24h (`5w 5d 10h`); hover `title` shows exact hours (`970h 17m`).

**Apply ⋮ menus** are scoped to open popup roots (`ytd-menu-popup-renderer`, open `tp-yt-iron-dropdown`, `tp-yt-paper-listbox`) — left guide entries (Home / Shorts / Subscriptions) are filtered out so Remove / Save resolve correctly.

Apply status explains **nothing to apply** (with live no/maybe/yes counts), confirms before changing YouTube, and notes when Yes stays on Watch Later (`yesMode: keep_wl`). Remove/add retries once after scrolling if a WL row is not yet in view.

**Remove matching** accepts `Remove from Watch later`, `Remove from playlist`, or `Remove video` (most specific wins). On miss, Escape closes the menu and the error lists visible labels. If the row is already gone from WL, remove returns `alreadyGone` and Apply drops the stash mark (no infinite retry).

**Apply** removes matched videos from stash so a second Apply won’t re-hit them. Stale marks (already off Watch Later) clear with a status like `cleared N stale marks`.

**Apply progress** — side panel is the primary live view while Apply focuses the WL tab. `#apply-progress` sits sticky under the header (thick bar, pulse while running). Progress is broadcast via `chrome.storage.local` key `stashApplyProgress` so deck ↔ side panel stay in sync. Deck keeps a widget too (with “also watching on side panel”). Apply tries `chrome.sidePanel.open` after focusing WL (best-effort).

**Scan** auto-scrolls the playlist until unique video ids reach ~98% of the reported count (or scroll stalls / safety cap), with a live `loading playlist… N / M` bar. Scroll/time budgets scale with the header count (enough for ~5k Watch Later), accumulate ids across passes, and nudge harder before declaring stall. Status reports `loaded N / M · meta N` or `partial N / M — scroll stalled` so gaps vs YouTube’s count stay obvious. Meta enrich runs up to 5k with progress against the real need set (`filling details… N / M`). Leaving the Watch Later tab pauses auto-scroll (status: `paused — focus Watch Later tab`) so Chrome background throttling doesn’t silently short the scrape. Scan on Watch Later **prunes** youtube items that left the playlist when the scrape looks complete (`loadedFully`, ≥95% of reported size, or a full `ytInitialData` dump). Use **Clear stash** to wipe storage; **Reset triage** only clears marks.

## Honesty / limits

- **Scrape** auto-loads the playlist (scroll), then uses `ytInitialData` when present, else DOM rows. YouTube A/B markup can miss views, publish date, or channel avatar.
- **Remove from Watch later / playlist** automates the English ⋮ menu (`Remove from Watch later`, `Remove from playlist`, `Remove video`). Non-English UI will fail until labels match.
- **Add to playlist** is best-effort: Save menu → search/filter or scroll the virtualized list → match by playlist id or case-insensitive name. Playlist discovery walks `ytInitialData` and may fetch `/feed/playlists`. No YouTube Data API key in this build. Create **Maybe Watch Later** (or pick another) once in YouTube / deck ⚙.
- X/Twitter scrape stays basic.

## Files

- `deck.html` — primary triage UI + destination config
- `sidepanel.html` — launcher + mini cover + Scan / Start triage / Apply
- `content/youtube.js` — scrape + `STASH_REMOVE_FROM_WL` + `STASH_ADD_TO_PLAYLIST` + `STASH_LIST_PLAYLISTS`
- `shared/storage.js` / `shared/apply.js` / `shared/apply-progress.js` — data model + apply orchestration + progress UI

## Data (`chrome.storage.local`)

`stashItems`, `stashConfig`, `stashUndo`, `stashPlaylists`, `stashApplyProgress` — statuses: `uncategorized` | `no` | `maybe` | `yes`.
