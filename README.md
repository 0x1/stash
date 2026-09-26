# stash deck

Tinder-like triage for **YouTube Watch Later** (X bookmarks secondary). Built for Punk Software Hack Night · `#punksoftware`

## Load / reload

1. `chrome://extensions` → **Developer mode** → **Load unpacked** → this folder (`stash/`)
2. After code changes: **Reload** the extension, then **hard-refresh** any open YouTube tab and the deck tab

## Demo script (~90s)

1. On YouTube: create a playlist named **`Maybe Watch Later`** (or pick any playlist in deck config).
2. Open [Watch Later](https://www.youtube.com/playlist?list=WL) and scroll so rows are in the DOM.
3. Click the **stash** icon (side panel) → **Scan**.
4. Side panel shows cover thumb + counts → **Open full deck**.
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

## Watch Later sync (0.3.11)

Apply status explains **nothing to apply** (with live no/maybe/yes counts), confirms before changing YouTube, and notes when Yes stays on Watch Later (`yesMode: keep_wl`). Remove/add retries once after scrolling if a WL row is not yet in view.

**Remove matching** accepts `Remove from Watch later`, `Remove from playlist`, or `Remove video` (most specific wins). On miss, Escape closes the menu and the error lists visible labels.

**Apply progress** panel (`#apply-progress`) on side panel + deck shows bar, current video, counts, and recent fails — stays visible after Done/Failed until the next Apply.

Scan on Watch Later **prunes** youtube items that left the playlist when the scrape looks complete (≥95% of reported playlist size, or a full `ytInitialData` dump). Apply also drops successfully removed/moved videos from stash so the pie matches live WL. Use **Clear stash** to wipe storage; **Reset triage** only clears marks.

## Honesty / limits

- **Scrape** uses `ytInitialData` when present, else DOM rows. YouTube A/B markup can miss views, publish date, or channel avatar.
- **Remove from Watch later / playlist** automates the English ⋮ menu (`Remove from Watch later`, `Remove from playlist`, `Remove video`). Non-English UI will fail until labels match.
- **Add to playlist** is best-effort: Save menu → match by playlist id or exact name. Playlist discovery walks `ytInitialData` and may fetch `/feed/playlists`. No YouTube Data API key in this build.
- X/Twitter scrape stays basic.

## Files

- `deck.html` — primary triage UI + destination config
- `sidepanel.html` — launcher + mini cover + Scan / Open deck / Apply
- `content/youtube.js` — scrape + `STASH_REMOVE_FROM_WL` + `STASH_ADD_TO_PLAYLIST` + `STASH_LIST_PLAYLISTS`
- `shared/storage.js` / `shared/apply.js` / `shared/apply-progress.js` — data model + apply orchestration + progress UI

## Data (`chrome.storage.local`)

`stashItems`, `stashConfig`, `stashUndo`, `stashPlaylists` — statuses: `uncategorized` | `no` | `maybe` | `yes`.
