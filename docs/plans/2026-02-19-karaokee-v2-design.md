# Karaokee v2 — Design Document
**Date:** 2026-02-19

## Overview

Three improvements to the Karaokee app:
1. **Bug fixes** — smart title/artist parsing from YouTube titles + stale audio fix
2. **Vocal removal** — demucs `htdemucs` model with toggle UI, processes in background
3. **YouTube search** — search by song name, pick from results list, auto-load (stretch feature)

---

## Bug Fix 1: Smart Title/Artist Parsing

**Problem:** YouTube videos often have titles like `"Black Moon - Who Got Da Props"` with the channel name as `uploader`. The current code uses uploader as artist and the full string as title, causing lyrics lookup to fail.

**Fix:** Add `parse_title_artist(title, uploader)` helper in `downloader.py`:

1. If `info` has a populated `artist` field → use it (existing behaviour, unchanged)
2. Else if `title` contains ` - ` → split on first ` - `: left = artist, right = title
3. Else → uploader as artist, full title as title (existing fallback)

**Files changed:** `downloader.py`, `tests/test_downloader.py`

---

## Bug Fix 2: Stale Audio on Second Song

**Problem:** `<audio src="/audio">` in `player.html` is cached by the browser. Navigating back and loading a new song leaves the old audio playing under new lyrics.

**Fix:**
- Remove `src="/audio"` from the `<audio>` tag in `player.html` (leave it empty)
- In `player.js`, on init: `audio.src = '/audio?t=' + Date.now(); audio.load();`
- The cache-busting timestamp forces the browser to re-fetch the audio file every time the player page loads

**Files changed:** `static/player.html`, `static/player.js`

---

## Feature 2: Vocal Removal

**Dependency:** `demucs` (pip install). Uses `htdemucs` model (~300MB, downloaded once to `~/.cache/torch/hub`). Processing time ~60–90s on CPU.

### New file: `vocal_remover.py`

```
separate(input_path: str) -> str
```
- Runs `demucs --two-stems=vocals --name htdemucs <input_path> --out temp/demucs_out`
- demucs outputs: `temp/demucs_out/htdemucs/<stem>/no_vocals.wav`
- Copies result to `temp/instrumental.wav`
- Returns `temp/instrumental.wav`

### New backend routes in `app.py`

| Route | Method | Description |
|---|---|---|
| `/separate` | POST | Starts demucs in background thread. Returns `{"status": "processing"}` immediately. |
| `/separate-status` | GET | Returns `{"status": "processing"\|"done"\|"error", "audioUrl": "/instrumental"}` |
| `/instrumental` | GET | Serves `temp/instrumental.wav` |

State tracked via module-level dict in `app.py`: `separation_state = {"status": "idle"}`.

### Player UI changes (`static/player.html` + `static/player.js`)

- New button in controls bar: **"🎤 Remove Vocals"**
- On click:
  1. Button changes to "⏳ Processing..." (disabled)
  2. `POST /separate` called
  3. Poll `GET /separate-status` every 2s
  4. On `"done"`: save `audio.currentTime`, swap `audio.src` to `/instrumental?t=<ts>`, `audio.load()`, seek back to saved time, resume playback, button changes to "🎵 Full Mix"
  5. On `"error"`: button resets, show error message
- Clicking "🎵 Full Mix" swaps back to `/audio?t=<original_ts>`, resumes at current position
- Button state persists for the session (don't re-separate on toggle back)

---

## Feature 3: YouTube Search

### New backend route: `GET /search?q=<query>`

Uses yt-dlp's `ytsearch5:` prefix (no API key needed). Returns top 5 results:

```json
[
  {
    "id": "abc123",
    "title": "Black Moon - Who Got Da Props",
    "uploader": "BlackMoonVEVO",
    "duration": 245,
    "url": "https://www.youtube.com/watch?v=abc123"
  }
]
```

**Files changed:** `downloader.py` (add `search_youtube(q)` function), `app.py` (add `/search` route), `tests/`

### Setup screen UI changes (`static/index.html`)

Add a search section **above** the existing URL field:

```
[Search for a song...          ] [🔍 Search]

┌─────────────────────────────────────────┐
│ Black Moon - Who Got Da Props           │
│ BlackMoonVEVO · 4:05                    │
├─────────────────────────────────────────┤
│ Who Got Da Props - Black Moon (Live)    │
│ OldSchoolHipHop · 3:58                  │
└─────────────────────────────────────────┘

── or paste a URL directly ──

YouTube URL: [_______________________]
Artist: [____________]  Title: [_____]
[ Load Song ]
```

**Clicking a result:**
1. Fills URL field with `result.url`
2. Runs `parse_title_artist` logic in JS (same split-on-dash logic) to fill artist/title fields
3. Immediately calls `loadSong()` — no extra click

**Styling:** Results list uses `.search-results` class, dark card style matching existing theme. Selected result highlighted briefly before loading.

### New CSS in `static/style.css`

```css
.search-results { ... }          /* container */
.search-result-item { ... }      /* each row */
.search-result-item:hover { ... }/* hover highlight */
.search-divider { ... }          /* "or paste a URL" divider */
```

---

## Files Changed Summary

| File | Change |
|---|---|
| `downloader.py` | Add `parse_title_artist()`, update `extract_metadata()`, add `search_youtube()` |
| `vocal_remover.py` | New file — demucs wrapper |
| `app.py` | Add `/separate`, `/separate-status`, `/instrumental`, `/search` routes; add `separation_state` |
| `static/player.html` | Remove `src` from `<audio>`, add Remove Vocals button |
| `static/player.js` | Add cache-busting audio load, add vocal toggle logic |
| `static/index.html` | Add search bar + results list UI |
| `static/style.css` | Add search result styles |
| `requirements.txt` | Add `demucs` |
| `tests/test_downloader.py` | Add tests for `parse_title_artist`, `search_youtube` |
| `tests/test_app.py` | Add tests for `/separate`, `/separate-status`, `/search` |

---

## Out of Scope (v2)

- Persisting separation results across app restarts
- GPU acceleration for demucs
- Pagination of search results beyond 5
- Thumbnail images in search results
