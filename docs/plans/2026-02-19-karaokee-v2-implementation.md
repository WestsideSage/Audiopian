# Karaokee v2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix two bugs (smart artist/title parsing, stale audio) and add vocal removal with demucs and YouTube song search.

**Architecture:** All backend changes are in Python/Flask. Bug fixes touch `downloader.py` and the player frontend. Vocal removal adds `vocal_remover.py` + three new Flask routes + player UI toggle. YouTube search adds `search_youtube()` to `downloader.py` + one Flask route + search UI on the setup screen.

**Tech Stack:** Python 3.x, Flask, yt-dlp, demucs (htdemucs model), plain HTML/CSS/JS

---

## Prerequisites

Install demucs before starting:
```bash
cd C:/GPT5-Projects/Karaokee
pip install demucs
```

Also add it to `requirements.txt` (just append `demucs` on a new line).

> **Note on demucs first run:** The first time `separate()` is called, demucs downloads the `htdemucs` model (~300MB) to `~/.cache/torch/hub`. This happens automatically — no manual step needed.

> **Note on ffmpeg:** demucs requires ffmpeg to convert audio formats. Check if it's installed: `ffmpeg -version`. If not, install via `winget install ffmpeg` or download from https://ffmpeg.org/download.html and add to PATH.

---

### Task 1: Smart Title/Artist Parsing (`downloader.py`)

**Problem:** YouTube titles like `"Black Moon - Who Got Da Props"` get used as the full title with the channel as artist, breaking lyrics lookup.

**Files:**
- Modify: `C:/GPT5-Projects/Karaokee/downloader.py`
- Modify: `C:/GPT5-Projects/Karaokee/tests/test_downloader.py`

**Step 1: Add new tests to `tests/test_downloader.py`**

Update the import line at the top to also import `parse_title_artist`:
```python
from downloader import extract_metadata, download_audio, parse_title_artist
```

Then append these tests at the end of the file:

```python
def test_parse_title_artist_with_dash():
    artist, title = parse_title_artist("Black Moon - Who Got Da Props", "SomeChannel")
    assert artist == "Black Moon"
    assert title == "Who Got Da Props"


def test_parse_title_artist_no_dash_falls_back_to_uploader():
    artist, title = parse_title_artist("WhoGotDaProps", "SomeChannel")
    assert artist == "SomeChannel"
    assert title == "WhoGotDaProps"


def test_parse_title_artist_multiple_dashes_splits_on_first():
    artist, title = parse_title_artist("Wu-Tang Clan - C.R.E.A.M.", "WuTangVEVO")
    assert artist == "Wu-Tang Clan"
    assert title == "C.R.E.A.M."


def test_extract_metadata_uses_dash_split_when_no_artist_field():
    mock_info = {
        "title": "Black Moon - Who Got Da Props",
        "uploader": "SomeChannel",
    }
    with patch("downloader.yt_dlp.YoutubeDL") as MockYDL:
        instance = MockYDL.return_value.__enter__.return_value
        instance.extract_info.return_value = mock_info
        result = extract_metadata("https://youtube.com/watch?v=fake")
    assert result["artist"] == "Black Moon"
    assert result["title"] == "Who Got Da Props"
```

**Step 2: Run tests to verify they fail**

```bash
cd C:/GPT5-Projects/Karaokee && python -m pytest tests/test_downloader.py -v
```
Expected: `ImportError: cannot import name 'parse_title_artist'`

**Step 3: Add `parse_title_artist` to `downloader.py` and update `extract_metadata`**

Replace the entire contents of `downloader.py` with:

```python
import os
import yt_dlp


TEMP_DIR = os.path.join(os.path.dirname(__file__), "temp")
AUDIO_PATH = os.path.join(TEMP_DIR, "audio.webm")


def parse_title_artist(title: str, uploader: str) -> tuple[str, str]:
    """Parse artist and title from a YouTube title string.

    If title contains ' - ', split on the first occurrence:
        'Black Moon - Who Got Da Props' -> ('Black Moon', 'Who Got Da Props')
    Otherwise fall back to uploader as artist and full title as title.
    """
    if " - " in title:
        parts = title.split(" - ", 1)
        return parts[0].strip(), parts[1].strip()
    return uploader, title


def extract_metadata(url: str) -> dict:
    """Extract title and artist from a YouTube URL without downloading."""
    ydl_opts = {"quiet": True, "skip_download": True}
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)

    raw_title = info.get("title", "Unknown Title")
    uploader = info.get("uploader", "Unknown Artist")

    # Prefer explicit artist tag; fall back to title-dash-split; fall back to uploader
    if info.get("artist"):
        artist = info["artist"]
        title = raw_title
    else:
        artist, title = parse_title_artist(raw_title, uploader)

    return {"title": title, "artist": artist}


def download_audio(url: str) -> str:
    """Download audio from YouTube URL to temp/audio.webm. Returns file path."""
    os.makedirs(TEMP_DIR, exist_ok=True)
    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": AUDIO_PATH,
        "quiet": True,
        "overwrites": True,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([url])
    return AUDIO_PATH


def search_youtube(query: str) -> list[dict]:
    """Search YouTube for up to 5 results. Returns list of result dicts."""
    ydl_opts = {
        "quiet": True,
        "skip_download": True,
        "extract_flat": True,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(f"ytsearch5:{query}", download=False)

    results = []
    for entry in (info.get("entries") or []):
        if not entry:
            continue
        results.append({
            "id": entry.get("id", ""),
            "title": entry.get("title", ""),
            "uploader": entry.get("uploader") or entry.get("channel", ""),
            "duration": entry.get("duration") or 0,
            "url": f"https://www.youtube.com/watch?v={entry.get('id', '')}",
        })
    return results
```

**Step 4: Run all downloader tests**

```bash
cd C:/GPT5-Projects/Karaokee && python -m pytest tests/test_downloader.py -v
```
Expected: 6 tests PASS (2 existing + 4 new)

**Step 5: Commit**

```bash
cd C:/GPT5-Projects/Karaokee && git add downloader.py tests/test_downloader.py && git commit -m "fix: smart title/artist parsing + add search_youtube"
```

---

### Task 2: Stale Audio Fix (`player.html` + `player.js`)

**Problem:** Browser caches `/audio` — navigating back then loading a new song plays the old audio under new lyrics.

**Files:**
- Modify: `C:/GPT5-Projects/Karaokee/static/player.html`
- Modify: `C:/GPT5-Projects/Karaokee/static/player.js`

**Step 1: Remove the hardcoded `src` from `<audio>` in `player.html`**

Find this line:
```html
<audio id="audio" src="/audio"></audio>
```
Change it to:
```html
<audio id="audio"></audio>
```

**Step 2: Add cache-busting audio load in `player.js`**

At the top of `player.js`, the `audio` element is already referenced. After the `songData` null-check block (after `if (!songData) { window.location.href = '/'; }`), add these two lines:

```javascript
audio.src = '/audio?t=' + Date.now();
audio.load();
```

The full block should look like:
```javascript
const songData = JSON.parse(sessionStorage.getItem('songData') || 'null');
if (!songData) {
    window.location.href = '/';
}

audio.src = '/audio?t=' + Date.now();
audio.load();

document.getElementById('song-title').textContent =
    `${songData.artist} — ${songData.title}`;
```

**Step 3: Verify tests still pass**

```bash
cd C:/GPT5-Projects/Karaokee && python -m pytest tests/ -v
```
Expected: all existing tests PASS (no backend change here)

**Step 4: Manual verification**

1. Run `python app.py`
2. Load a song, go to player, listen briefly
3. Click Back
4. Load a different song
5. Verify the new song's audio plays (not the old one)

**Step 5: Commit**

```bash
cd C:/GPT5-Projects/Karaokee && git add static/player.html static/player.js && git commit -m "fix: bust audio cache on player load to prevent stale audio"
```

---

### Task 3: Vocal Remover Module (`vocal_remover.py`)

**Files:**
- Create: `C:/GPT5-Projects/Karaokee/vocal_remover.py`
- Create: `C:/GPT5-Projects/Karaokee/tests/test_vocal_remover.py`

**Step 1: Write the failing test**

Create `tests/test_vocal_remover.py`:

```python
import os
from unittest.mock import patch, MagicMock
from vocal_remover import separate, INSTRUMENTAL_PATH


def test_separate_returns_instrumental_path():
    """separate() should return the path to the instrumental file."""
    with patch("vocal_remover.subprocess.run") as mock_run, \
         patch("vocal_remover.shutil.copy2") as mock_copy, \
         patch("vocal_remover.glob.glob") as mock_glob:
        mock_run.return_value = MagicMock(returncode=0)
        mock_glob.return_value = ["temp/demucs_out/htdemucs/audio/no_vocals.wav"]
        result = separate("temp/audio.webm")
    assert result == INSTRUMENTAL_PATH
    assert mock_copy.called


def test_separate_raises_on_demucs_failure():
    """separate() should raise RuntimeError if demucs exits non-zero."""
    with patch("vocal_remover.subprocess.run") as mock_run:
        mock_run.return_value = MagicMock(returncode=1, stderr="error")
        try:
            separate("temp/audio.webm")
            assert False, "Should have raised"
        except RuntimeError:
            pass
```

**Step 2: Run tests to verify they fail**

```bash
cd C:/GPT5-Projects/Karaokee && python -m pytest tests/test_vocal_remover.py -v
```
Expected: `ModuleNotFoundError: No module named 'vocal_remover'`

**Step 3: Create `vocal_remover.py`**

```python
import os
import glob
import shutil
import subprocess

TEMP_DIR = os.path.join(os.path.dirname(__file__), "temp")
DEMUCS_OUT_DIR = os.path.join(TEMP_DIR, "demucs_out")
INSTRUMENTAL_PATH = os.path.join(TEMP_DIR, "instrumental.wav")


def separate(input_path: str) -> str:
    """Run demucs htdemucs on input_path, return path to instrumental wav.

    Raises RuntimeError if demucs fails.
    """
    os.makedirs(DEMUCS_OUT_DIR, exist_ok=True)

    result = subprocess.run(
        [
            "python", "-m", "demucs",
            "--two-stems=vocals",
            "--name", "htdemucs",
            "--out", DEMUCS_OUT_DIR,
            input_path,
        ],
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        raise RuntimeError(f"demucs failed: {result.stderr}")

    # demucs outputs to: <out>/<model>/<stem_name>/no_vocals.wav
    pattern = os.path.join(DEMUCS_OUT_DIR, "htdemucs", "*", "no_vocals.wav")
    matches = glob.glob(pattern)
    if not matches:
        raise RuntimeError(f"demucs output not found at {pattern}")

    shutil.copy2(matches[0], INSTRUMENTAL_PATH)
    return INSTRUMENTAL_PATH
```

**Step 4: Run tests to verify they pass**

```bash
cd C:/GPT5-Projects/Karaokee && python -m pytest tests/test_vocal_remover.py -v
```
Expected: 2 PASSED

**Step 5: Commit**

```bash
cd C:/GPT5-Projects/Karaokee && git add vocal_remover.py tests/test_vocal_remover.py && git commit -m "feat: add demucs vocal remover module"
```

---

### Task 4: Vocal Removal Flask Routes (`app.py`)

**Files:**
- Modify: `C:/GPT5-Projects/Karaokee/app.py`
- Modify: `C:/GPT5-Projects/Karaokee/tests/test_app.py`

**Step 1: Add tests to `tests/test_app.py`**

Append these tests at the end of the file:

```python
def test_separate_starts_processing(client):
    with patch("app.separate") as mock_sep:
        mock_sep.return_value = "/fake/instrumental.wav"
        resp = client.post("/separate")
    assert resp.status_code == 200
    data = json.loads(resp.data)
    assert data["status"] == "processing"


def test_separate_status_returns_state(client):
    import app as app_module
    app_module.separation_state["status"] = "done"
    resp = client.get("/separate-status")
    assert resp.status_code == 200
    data = json.loads(resp.data)
    assert data["status"] == "done"
    assert data["audioUrl"] == "/instrumental"
    # Reset
    app_module.separation_state["status"] = "idle"


def test_search_returns_results(client):
    with patch("app.search_youtube") as mock_search:
        mock_search.return_value = [
            {"id": "abc", "title": "Test Song", "uploader": "TestChannel",
             "duration": 200, "url": "https://youtube.com/watch?v=abc"}
        ]
        resp = client.get("/search?q=test+song")
    assert resp.status_code == 200
    data = json.loads(resp.data)
    assert len(data) == 1
    assert data[0]["title"] == "Test Song"


def test_search_missing_query(client):
    resp = client.get("/search")
    assert resp.status_code == 400
```

**Step 2: Run new tests to verify they fail**

```bash
cd C:/GPT5-Projects/Karaokee && python -m pytest tests/test_app.py::test_separate_starts_processing tests/test_app.py::test_separate_status_returns_state tests/test_app.py::test_search_returns_results tests/test_app.py::test_search_missing_query -v
```
Expected: all 4 FAIL (routes don't exist yet)

**Step 3: Update `app.py`**

Add the new imports at the top (after existing imports):
```python
import threading
from vocal_remover import separate, INSTRUMENTAL_PATH
from downloader import extract_metadata, download_audio, AUDIO_PATH, search_youtube
```

Add module-level state dict after the `app = Flask(...)` line:
```python
separation_state = {"status": "idle"}
```

Add these four new routes after the existing `/retry-lyrics` route, before `if __name__ == "__main__":`:

```python
@app.route("/separate", methods=["POST"])
def start_separate():
    separation_state["status"] = "processing"

    def run():
        try:
            separate(AUDIO_PATH)
            separation_state["status"] = "done"
        except Exception as e:
            separation_state["status"] = "error"
            separation_state["error"] = str(e)

    threading.Thread(target=run, daemon=True).start()
    return jsonify({"status": "processing"})


@app.route("/separate-status")
def separate_status():
    status = separation_state.get("status", "idle")
    resp = {"status": status}
    if status == "done":
        resp["audioUrl"] = "/instrumental"
    if status == "error":
        resp["error"] = separation_state.get("error", "Unknown error")
    return jsonify(resp)


@app.route("/instrumental")
def instrumental():
    if not os.path.exists(INSTRUMENTAL_PATH):
        return jsonify({"error": "No instrumental available"}), 404
    return send_file(INSTRUMENTAL_PATH, mimetype="audio/wav")


@app.route("/search")
def search():
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify({"error": "Query required"}), 400
    results = search_youtube(q)
    return jsonify(results)
```

**Step 4: Run full test suite**

```bash
cd C:/GPT5-Projects/Karaokee && python -m pytest tests/ -v
```
Expected: all tests PASS (12 existing + 4 new = 16 total)

**Step 5: Commit**

```bash
cd C:/GPT5-Projects/Karaokee && git add app.py tests/test_app.py && git commit -m "feat: add /separate, /separate-status, /instrumental, /search routes"
```

---

### Task 5: Player UI — Remove Vocals Toggle

This task modifies the player's HTML and JS. Because the JS contains template literals, **write both files using the Edit tool from the main Claude context**, not via subagent shell commands.

**Files:**
- Modify: `C:/GPT5-Projects/Karaokee/static/player.html`
- Modify: `C:/GPT5-Projects/Karaokee/static/player.js`

**Step 1: Add the Remove Vocals button to `player.html`**

In the `.controls` div, add the button before the skip-back button:

Find:
```html
    <div class="controls">
        <button class="ctrl-btn" id="skipBackBtn" onclick="skipBack()">⏮</button>
```

Replace with:
```html
    <div class="controls">
        <button class="ctrl-btn" id="vocalBtn" onclick="toggleVocals()">🎤 Remove Vocals</button>
        <button class="ctrl-btn" id="skipBackBtn" onclick="skipBack()">⏮</button>
```

**Step 2: Add the vocal toggle logic to `player.js`**

Append this block at the end of `player.js` (after the `canplay` event listener):

```javascript
// Vocal removal toggle
let instrumentalReady = false;
let usingInstrumental = false;
const vocalBtn = document.getElementById('vocalBtn');

function toggleVocals() {
    if (usingInstrumental) {
        // Switch back to full mix
        const pos = audio.currentTime;
        audio.src = '/audio?t=' + Date.now();
        audio.load();
        audio.addEventListener('canplay', () => {
            audio.currentTime = pos;
            audio.play().catch(() => {});
        }, { once: true });
        usingInstrumental = false;
        vocalBtn.textContent = '🎤 Remove Vocals';
        return;
    }

    if (instrumentalReady) {
        // Already processed — just switch
        switchToInstrumental();
        return;
    }

    // Start processing
    vocalBtn.textContent = '⏳ Processing...';
    vocalBtn.disabled = true;

    fetch('/separate', { method: 'POST' })
        .then(() => pollSeparation())
        .catch(() => {
            vocalBtn.textContent = '🎤 Remove Vocals';
            vocalBtn.disabled = false;
        });
}

function pollSeparation() {
    fetch('/separate-status')
        .then(r => r.json())
        .then(data => {
            if (data.status === 'done') {
                instrumentalReady = true;
                switchToInstrumental();
            } else if (data.status === 'error') {
                vocalBtn.textContent = '❌ Failed';
                vocalBtn.disabled = false;
            } else {
                setTimeout(pollSeparation, 2000);
            }
        });
}

function switchToInstrumental() {
    const pos = audio.currentTime;
    audio.src = '/instrumental?t=' + Date.now();
    audio.load();
    audio.addEventListener('canplay', () => {
        audio.currentTime = pos;
        audio.play().catch(() => {});
    }, { once: true });
    usingInstrumental = true;
    vocalBtn.textContent = '🎵 Full Mix';
    vocalBtn.disabled = false;
}
```

**Step 3: Verify tests still pass**

```bash
cd C:/GPT5-Projects/Karaokee && python -m pytest tests/ -v
```
Expected: all tests PASS

**Step 4: Manual smoke test**

1. `python app.py`
2. Load a song, go to player
3. Verify "🎤 Remove Vocals" button appears in the controls bar
4. Click it — verify button changes to "⏳ Processing..."
5. Wait ~60–90s — verify button changes to "🎵 Full Mix" and audio switches
6. Click "🎵 Full Mix" — verify it switches back

**Step 5: Commit**

```bash
cd C:/GPT5-Projects/Karaokee && git add static/player.html static/player.js && git commit -m "feat: add vocal removal toggle to player UI"
```

---

### Task 6: YouTube Search UI (`static/index.html` + `static/style.css`)

**Files:**
- Modify: `C:/GPT5-Projects/Karaokee/static/index.html`
- Modify: `C:/GPT5-Projects/Karaokee/static/style.css`

**Step 1: Add search CSS to `static/style.css`**

Append these styles at the end of the file:

```css
/* Search feature */
.search-row {
    display: flex;
    gap: 8px;
    margin-bottom: 18px;
}

.search-row input {
    flex: 1;
    margin-bottom: 0;
}

.search-row button {
    width: auto;
    padding: 10px 16px;
    font-size: 0.9rem;
}

.search-results {
    background: #0d0d0d;
    border: 1px solid #333;
    border-radius: 8px;
    margin-bottom: 18px;
    overflow: hidden;
    display: none;
}

.search-result-item {
    padding: 12px 14px;
    cursor: pointer;
    border-bottom: 1px solid #1a1a1a;
    transition: background 0.15s;
}

.search-result-item:last-child {
    border-bottom: none;
}

.search-result-item:hover {
    background: #1a1a2e;
}

.search-result-title {
    font-size: 0.95rem;
    color: #f0f0f0;
    margin-bottom: 2px;
}

.search-result-meta {
    font-size: 0.78rem;
    color: #666;
}

.search-divider {
    text-align: center;
    color: #444;
    font-size: 0.8rem;
    margin-bottom: 18px;
    position: relative;
}

.search-divider::before,
.search-divider::after {
    content: '';
    position: absolute;
    top: 50%;
    width: 38%;
    height: 1px;
    background: #333;
}

.search-divider::before { left: 0; }
.search-divider::after { right: 0; }
```

**Step 2: Update `static/index.html`**

Replace the entire contents of `static/index.html` with:

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Karaokee</title>
    <link rel="stylesheet" href="/static/style.css">
</head>
<body>
    <div class="card">
        <h1>🎤 Karaokee</h1>

        <div class="search-row">
            <input type="text" id="searchQ" placeholder="Search for a song..." />
            <button onclick="searchSongs()">🔍</button>
        </div>

        <div class="search-results" id="searchResults"></div>

        <div class="search-divider">or paste a URL directly</div>

        <label for="url">YouTube URL</label>
        <input type="text" id="url" placeholder="https://youtube.com/watch?v=..." />

        <label for="artist">Artist <span style="color:#666">(auto-filled)</span></label>
        <input type="text" id="artist" placeholder="Artist name" />

        <label for="title">Title <span style="color:#666">(auto-filled)</span></label>
        <input type="text" id="title" placeholder="Song title" />

        <button id="loadBtn" onclick="loadSong()">Load Song</button>
        <div id="status"></div>
        <button id="retryBtn" onclick="retryLyrics()" style="display:none;margin-top:10px;background:#334;">
            Retry with edited title/artist
        </button>
    </div>

    <script>
        const statusEl = document.getElementById('status');
        const loadBtn = document.getElementById('loadBtn');

        // --- Search ---
        async function searchSongs() {
            const q = document.getElementById('searchQ').value.trim();
            if (!q) return;
            setStatus('Searching...', '');
            const resp = await fetch('/search?q=' + encodeURIComponent(q));
            if (!resp.ok) { setStatus('Search failed.', 'error'); return; }
            const results = await resp.json();
            renderResults(results);
            setStatus('', '');
        }

        function renderResults(results) {
            const container = document.getElementById('searchResults');
            if (!results.length) {
                container.style.display = 'block';
                container.innerHTML = '<div class="search-result-item"><div class="search-result-title" style="color:#666">No results found</div></div>';
                return;
            }
            container.style.display = 'block';
            container.innerHTML = results.map((r, i) =>
                `<div class="search-result-item" onclick="selectResult(${i})">
                    <div class="search-result-title">${escHtml(r.title)}</div>
                    <div class="search-result-meta">${escHtml(r.uploader)} &middot; ${fmtDuration(r.duration)}</div>
                </div>`
            ).join('');
            container._results = results;
        }

        function selectResult(i) {
            const results = document.getElementById('searchResults')._results;
            const r = results[i];
            document.getElementById('url').value = r.url;
            // Parse title/artist using same dash-split logic as backend
            const [artist, title] = parseTitleArtist(r.title, r.uploader);
            document.getElementById('artist').value = artist;
            document.getElementById('title').value = title;
            document.getElementById('searchResults').style.display = 'none';
            loadSong();
        }

        function parseTitleArtist(title, uploader) {
            if (title.includes(' - ')) {
                const idx = title.indexOf(' - ');
                return [title.slice(0, idx).trim(), title.slice(idx + 3).trim()];
            }
            return [uploader, title];
        }

        function escHtml(s) {
            return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        }

        function fmtDuration(s) {
            if (!s) return '';
            const m = Math.floor(s / 60);
            const sec = Math.floor(s % 60).toString().padStart(2, '0');
            return `${m}:${sec}`;
        }

        // --- Load Song ---
        async function loadSong() {
            const url = document.getElementById('url').value.trim();
            if (!url) { setStatus('Please enter a YouTube URL.', 'error'); return; }

            loadBtn.disabled = true;
            setStatus('Fetching metadata...', '');

            const metaResp = await fetch('/load', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url,
                    artist: document.getElementById('artist').value.trim() || undefined,
                    title: document.getElementById('title').value.trim() || undefined,
                })
            });

            if (!metaResp.ok) {
                const err = await metaResp.json();
                setStatus(err.error || 'Failed to load song.', 'error');
                loadBtn.disabled = false;
                return;
            }

            const data = await metaResp.json();

            if (!document.getElementById('artist').value) {
                document.getElementById('artist').value = data.artist;
            }
            if (!document.getElementById('title').value) {
                document.getElementById('title').value = data.title;
            }

            if (data.lyricsError) {
                setStatus(data.lyricsError, 'error');
                document.getElementById('retryBtn').style.display = 'block';
                loadBtn.disabled = false;
                return;
            }

            setStatus('Ready! Loading player...', 'success');
            sessionStorage.setItem('songData', JSON.stringify(data));
            window.location.href = '/player';
        }

        async function retryLyrics() {
            const title = document.getElementById('title').value.trim();
            const artist = document.getElementById('artist').value.trim();
            setStatus('Searching for lyrics...', '');
            const resp = await fetch('/retry-lyrics', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title, artist })
            });
            const data = await resp.json();
            if (data.lyricsError) {
                setStatus(data.lyricsError, 'error');
                return;
            }
            const existing = JSON.parse(sessionStorage.getItem('songData') || '{}');
            existing.lyrics = data.lyrics;
            existing.title = title;
            existing.artist = artist;
            sessionStorage.setItem('songData', JSON.stringify(existing));
            setStatus('Lyrics found! Loading player...', 'success');
            window.location.href = '/player';
        }

        function setStatus(msg, type) {
            statusEl.textContent = msg;
            statusEl.className = type;
        }

        document.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                if (document.activeElement === document.getElementById('searchQ')) {
                    searchSongs();
                } else {
                    loadSong();
                }
            }
        });
    </script>
</body>
</html>
```

**Step 3: Run full test suite**

```bash
cd C:/GPT5-Projects/Karaokee && python -m pytest tests/ -v
```
Expected: all tests PASS

**Step 4: Manual smoke test**

1. `python app.py`, open `http://localhost:5000`
2. Type `"Black Moon Who Got Da Props"` in the search box, press Enter
3. Verify 5 results appear with title + channel + duration
4. Click a result — verify URL, artist, title fields fill in and song starts loading

**Step 5: Commit**

```bash
cd C:/GPT5-Projects/Karaokee && git add static/index.html static/style.css && git commit -m "feat: add YouTube search UI to setup screen"
```

---

### Task 7: Update `requirements.txt`

**Files:**
- Modify: `C:/GPT5-Projects/Karaokee/requirements.txt`

**Step 1: Add demucs**

Append `demucs` to `requirements.txt`:
```
flask
yt-dlp
requests
pytest
demucs
```

**Step 2: Commit**

```bash
cd C:/GPT5-Projects/Karaokee && git add requirements.txt && git commit -m "chore: add demucs to requirements"
```

---

## Final Verification

Run full test suite:

```bash
cd C:/GPT5-Projects/Karaokee && python -m pytest tests/ -v
```
Expected: all 16+ tests PASS

End-to-end manual checklist:
1. Search for a song → results appear → click result → song loads correctly with proper artist/title
2. Paste a `"Artist - Title"` format YouTube URL → artist/title auto-split correctly
3. Complete a song → go back → load a different song → new audio plays (not old)
4. On player, click "🎤 Remove Vocals" → processing starts → switches to instrumental when done
5. Click "🎵 Full Mix" → switches back to full audio at same position
