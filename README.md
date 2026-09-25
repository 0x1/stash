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

## Honesty / limits

- **Scrape** uses `ytInitialData` when present, else DOM rows. YouTube A/B markup can miss views, publish date, or channel avatar.
- **Remove from Watch later** automates the English ⋮ menu. Non-English UI will fail until labels match.
- **Add to playlist** is best-effort: Save menu → match by playlist id or exact name. Playlist discovery walks `ytInitialData` and may fetch `/feed/playlists`. No YouTube Data API key in this build.
- X/Twitter scrape stays basic.

## Files

- `deck.html` — primary triage UI + destination config
- `sidepanel.html` — launcher + mini cover + Scan / Open deck / Apply
- `content/youtube.js` — scrape + `STASH_REMOVE_FROM_WL` + `STASH_ADD_TO_PLAYLIST` + `STASH_LIST_PLAYLISTS`
- `shared/storage.js` / `shared/apply.js` — data model + apply orchestration

## Data (`chrome.storage.local`)

`stashItems`, `stashConfig`, `stashUndo`, `stashPlaylists` — statuses: `uncategorized` | `no` | `maybe` | `yes`.
