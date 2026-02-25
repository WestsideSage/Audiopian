# Karaokee Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix rap word-matching accuracy, add a pre-processing loading screen so both modes are ready on player load, and upgrade the demucs model to `htdemucs_ft` for cleaner vocal separation.

**Architecture:** Three independent areas: (1) frontend-only matching algorithm fixes in `player.js`, (2) backend auto-kick of separation in `app.py` + frontend loading overlay in `player.html`/`player.js`, (3) single-line demucs model swap in `vocal_remover.py`. No new files needed.

**Tech Stack:** Python/Flask backend, vanilla JS frontend, pytest for backend tests, manual browser verification for frontend. Design doc: `docs/plans/2026-02-25-karaokee-improvements-design.md`.

> ⚠️ **Windows template literal warning:** When writing or editing `player.js`, ALWAYS use the `Edit` or `Write` tools directly from the main Claude context. Do NOT delegate JS file writes to Bash subagents — backtick template literals (e.g. `` `${foo}` ``) get silently stripped on Windows.

---

### Task 1: Upgrade demucs model to htdemucs_ft

**Files:**
- Modify: `vocal_remover.py`
- Modify: `tests/test_vocal_remover.py`

**Step 1: Update the test mock path for htdemucs_ft**

In `tests/test_vocal_remover.py`, the mock glob path references `htdemucs`. Update it to `htdemucs_ft`:

```python
mock_glob.return_value = ["temp/demucs_out/htdemucs_ft/audio/no_vocals.wav"]
```

**Step 2: Run test to confirm it now fails**

```bash
cd C:/GPT5-Projects/Karaokee && python -m pytest tests/test_vocal_remover.py -v
```
Expected: `test_separate_returns_instrumental_path` FAILS (glob pattern mismatch).

**Step 3: Update vocal_remover.py — model name and glob pattern**

In `vocal_remover.py`, change both occurrences of `htdemucs` to `htdemucs_ft`:

```python
result = subprocess.run(
    [
        "python", "-m", "demucs",
        "--two-stems=vocals",
        "--name", "htdemucs_ft",          # was: htdemucs
        "--out", DEMUCS_OUT_DIR,
        input_path,
    ],
    capture_output=True,
    text=True,
)
```

And the glob pattern:
```python
pattern = os.path.join(DEMUCS_OUT_DIR, "htdemucs_ft", "*", "no_vocals.wav")
```

**Step 4: Run tests to confirm they pass**

```bash
python -m pytest tests/test_vocal_remover.py -v
```
Expected: both tests PASS.

**Step 5: Commit**

```bash
git add vocal_remover.py tests/test_vocal_remover.py
git commit -m "feat: upgrade demucs model to htdemucs_ft for better vocal isolation"
```

---

### Task 2: Auto-kick separation on /load

**Files:**
- Modify: `app.py`
- Modify: `tests/test_app.py`

**Step 1: Write a failing test for auto-kick**

Add to `tests/test_app.py`:

```python
def test_load_triggers_separation_automatically(client):
    """POST /load should auto-start vocal separation in the background."""
    import app as app_module
    app_module.separation_state["status"] = "idle"
    with patch("app.extract_metadata") as mock_meta, \
         patch("app.download_audio") as mock_dl, \
         patch("app.fetch_lyrics") as mock_lyrics, \
         patch("threading.Thread") as mock_thread:
        mock_meta.return_value = {"title": "Test", "artist": "Artist"}
        mock_dl.return_value = "/fake/path"
        mock_lyrics.return_value = []
        resp = client.post("/load", json={"url": "https://youtube.com/watch?v=fake"})
    assert resp.status_code == 200
    assert mock_thread.called, "Thread should have been started for separation"
    assert app_module.separation_state["status"] == "processing"
    # Reset for other tests
    app_module.separation_state["status"] = "idle"
```

**Step 2: Run test to confirm it fails**

```bash
python -m pytest tests/test_app.py::test_load_triggers_separation_automatically -v
```
Expected: FAIL — `separation_state["status"]` is still `"idle"`, `mock_thread` not called.

**Step 3: Update existing test_load_success to patch threading**

The existing `test_load_success` will start a background thread once the feature is implemented. Update it to prevent that:

```python
def test_load_success(client):
    with patch("app.extract_metadata") as mock_meta, \
         patch("app.download_audio") as mock_dl, \
         patch("app.fetch_lyrics") as mock_lyrics, \
         patch("threading.Thread"):          # prevent real thread
        mock_meta.return_value = {"title": "Test Song", "artist": "Test Artist"}
        mock_dl.return_value = "/fake/path/audio.webm"
        mock_lyrics.return_value = [{"time": 1.0, "text": "Hello"}]
        resp = client.post("/load", json={"url": "https://youtube.com/watch?v=fake"})
    assert resp.status_code == 200
    data = json.loads(resp.data)
    assert data["title"] == "Test Song"
    assert data["artist"] == "Test Artist"
    assert data["lyrics"] == [{"time": 1.0, "text": "Hello"}]
    assert data["audioUrl"] == "/audio"
```

Also update `test_load_no_lyrics` the same way (add `patch("threading.Thread")`).

**Step 4: Implement auto-kick in app.py**

In `app.py`, replace the `/load` route body after `download_audio(url)` to reset state and kick off separation:

```python
@app.route("/load", methods=["POST"])
def load():
    data = request.get_json()
    url = (data or {}).get("url", "").strip()
    if not url:
        return jsonify({"error": "No URL provided"}), 400

    try:
        meta = extract_metadata(url)
    except Exception as e:
        return jsonify({"error": f"Could not load video: {str(e)}"}), 400

    title = (data.get("title") or meta["title"]).strip()
    artist = (data.get("artist") or meta["artist"]).strip()

    try:
        download_audio(url)
    except Exception as e:
        return jsonify({"error": f"Could not download audio: {str(e)}"}), 400

    # Always reset and auto-kick separation for the new song
    separation_state["status"] = "processing"
    separation_state.pop("error", None)

    def run():
        try:
            separate(AUDIO_PATH)
            separation_state["status"] = "done"
        except Exception as e:
            separation_state["status"] = "error"
            separation_state["error"] = str(e)

    threading.Thread(target=run, daemon=True).start()

    lyrics = fetch_lyrics(title, artist)
    response = {
        "title": title,
        "artist": artist,
        "audioUrl": "/audio",
        "lyrics": lyrics,
    }
    if not lyrics:
        response["lyricsError"] = "No lyrics found. Edit artist/title and retry."

    return jsonify(response)
```

**Step 5: Run all tests**

```bash
python -m pytest tests/ -v
```
Expected: all tests PASS (26 now).

**Step 6: Commit**

```bash
git add app.py tests/test_app.py
git commit -m "feat: auto-kick vocal separation on /load so player arrives ready"
```

---

### Task 3: Loading overlay HTML + CSS

**Files:**
- Modify: `static/player.html`

**Step 1: Add loading overlay CSS to the `<style>` block**

In `player.html`, append inside the `<style>` block (before the closing `</style>`):

```css
/* Loading overlay */
.prep-overlay {
    position: fixed;
    inset: 0;
    background: #0d0d1a;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 200;
    transition: opacity 0.4s;
}

.prep-box {
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 24px;
    padding: 40px;
}

.prep-song {
    font-size: 1.3rem;
    color: #e040fb;
    font-weight: 600;
    max-width: 400px;
}

.prep-status {
    display: flex;
    align-items: center;
    gap: 12px;
    color: #aaa;
    font-size: 0.95rem;
}

.prep-spinner {
    width: 20px;
    height: 20px;
    border: 2px solid #333;
    border-top-color: #e040fb;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
}

@keyframes spin {
    to { transform: rotate(360deg); }
}
```

**Step 2: Add overlay HTML div**

In `player.html`, add the overlay div immediately after `<body>` (before the `player-header` div):

```html
<div class="prep-overlay" id="prepOverlay">
    <div class="prep-box">
        <div class="prep-song" id="prepSongTitle"></div>
        <div class="prep-status">
            <div class="prep-spinner"></div>
            <span>Preparing audio…</span>
        </div>
        <button class="ctrl-btn" onclick="skipPrep()">&#9654; Skip (karaoke only)</button>
    </div>
</div>
```

**Step 3: Manual verification**

Open the player page in browser (navigate directly to `/player` with valid sessionStorage). Confirm:
- Full-screen dark overlay covers the player
- Song title shows, spinner animates
- Skip button visible
- No JS errors in console

**Step 4: Commit**

```bash
git add static/player.html
git commit -m "feat: add loading overlay HTML and CSS for pre-processing wait screen"
```

---

### Task 4: Loading overlay JS — poll loop, skip, and game guard

**Files:**
- Modify: `static/player.js`

> ⚠️ Use the `Edit` or `Write` tool directly — do NOT use Bash to write this file.

**Step 1: Add overlay state flag and suppress canplay autoplay during overlay**

In `player.js`, find the `// Auto-play when audio is ready` section and replace it:

```javascript
// Suppress autoplay while loading overlay is active
let overlayDismissed = false;

// Auto-play when audio is ready (only after overlay dismisses)
audio.addEventListener('canplay', () => {
    if (overlayDismissed) {
        audio.play().then(() => { playBtn.textContent = '⏸'; }).catch(() => {});
    }
});
```

**Step 2: Add overlay init, poll, finish, and skip functions**

After the `audio.addEventListener('ended', ...)` block, add:

```javascript
// --- Loading overlay ---

function initPrepOverlay() {
    const sd = JSON.parse(sessionStorage.getItem('songData') || 'null');
    if (sd) {
        document.getElementById('prepSongTitle').textContent =
            sd.artist + ' \u2014 ' + sd.title;
    }
    pollPrep();
}

function pollPrep() {
    fetch('/separate-status')
        .then(function(r) { return r.json(); })
        .then(function(data) {
            if (data.status === 'done') {
                finishPrep(true);
            } else if (data.status === 'error') {
                finishPrep(false);
            } else {
                setTimeout(pollPrep, 2000);
            }
        })
        .catch(function() { setTimeout(pollPrep, 2000); });
}

function finishPrep(success) {
    if (success) {
        instrumentalReady = true;
    }
    overlayDismissed = true;
    var overlay = document.getElementById('prepOverlay');
    overlay.style.opacity = '0';
    setTimeout(function() {
        overlay.style.display = 'none';
        audio.play().then(function() { playBtn.textContent = '\u23F8'; }).catch(function() {});
    }, 400);
}

function skipPrep() {
    overlayDismissed = true;
    document.getElementById('prepOverlay').style.display = 'none';
    audio.play().then(function() { playBtn.textContent = '\u23F8'; }).catch(function() {});
}

initPrepOverlay();
```

> Note: Arrow functions and template literals are avoided here to prevent the Windows backtick-stripping issue. `\u2014` = em dash, `\u23F8` = ⏸.

**Step 3: Guard toggleGameMode when instrumental not yet ready**

Find the existing `toggleGameMode()` function and replace it:

```javascript
function toggleGameMode() {
    if (lyrics.length === 0) {
        alert('No lyrics available for this song \u2014 game mode requires synced lyrics.');
        return;
    }
    if (!instrumentalReady) {
        alert('Vocal separation is still processing. Please wait or click Skip to use karaoke-only mode.');
        return;
    }
    if (gameMode.active) {
        gameMode.stop();
    } else {
        if (!usingInstrumental) {
            toggleVocals();
        }
        gameMode.start();
    }
}
```

**Step 4: Manual end-to-end verification**

1. Load a song from the home page
2. Confirm the loading overlay appears on the player page with the song title
3. Wait for separation to complete — overlay should fade out and song should autoplay
4. Confirm both "Remove Vocals" and "Game" buttons work immediately
5. Load another song, click Skip — confirm overlay dismisses, song plays, Game button shows alert if clicked
6. No JS errors throughout

**Step 5: Commit**

```bash
git add static/player.js
git commit -m "feat: add overlay poll loop, skip, and game mode guard for loading screen"
```

---

### Task 5: Fix word matching algorithm

**Files:**
- Modify: `static/player.js`

> ⚠️ Use the `Edit` or `Write` tool directly — do NOT use Bash to write this file.

**Step 1: Fix lineWords — remove contraction expansion**

In `GameMode.setActiveLine()`, find:

```javascript
        const rawWords = lineText.split(' ');
        this.lineWords = rawWords.map(w => {
            const nw = normalizeWord(w);
            return expandContractions([nw]).join(' ');
        });
```

Replace with:

```javascript
        const rawWords = lineText.split(' ');
        this.lineWords = rawWords.map(w => normalizeWord(w));
```

This keeps `lineWords` 1:1 with spans and removes the bug where `"gonna"` became the single string `"going to"`.

**Step 2: Add _collectMatches helper to GameMode**

Inside the `GameMode` class, add this method (before the closing `}`):

```javascript
    _collectMatches(transcript, resultSet) {
        if (this.lineWords.length === 0) return;
        const spoken = normalizeWords(transcript);
        let spokenIdx = 0;
        for (let li = 0; li < this.lineWords.length; li++) {
            const target = this.lineWords[li];
            const driftWindow = 6;
            for (let si = spokenIdx; si < Math.min(spokenIdx + driftWindow, spoken.length); si++) {
                if (spoken[si] === target) {
                    resultSet.add(li);
                    spokenIdx = si + 1;
                    break;
                }
            }
        }
    }
```

**Step 3: Replace _matchTranscript to use _collectMatches**

Replace the existing `_matchTranscript` method body:

```javascript
    _matchTranscript(transcript) {
        const unionSet = new Set();
        this._collectMatches(transcript, unionSet);
        this.matchedSet = unionSet;
        this._updateWordSpans();
    }
```

**Step 4: Add maxAlternatives and multi-alternative union matching**

In `_setupRecognition()`, add `maxAlternatives` after `this.recognition.lang = 'en-US';`:

```javascript
        this.recognition.maxAlternatives = 3;
```

Replace the entire `this.recognition.onresult` handler:

```javascript
        this.recognition.onresult = function(e) {
            var interim = '';
            var finalText = '';
            for (var i = e.resultIndex; i < e.results.length; i++) {
                if (e.results[i].isFinal) {
                    finalText += e.results[i][0].transcript + ' ';
                } else {
                    interim += e.results[i][0].transcript + ' ';
                }
            }
            if (finalText) self.transcript += finalText;

            // Match primary transcript
            var unionSet = new Set();
            self._collectMatches(self.transcript + interim, unionSet);

            // Union with alternative transcripts from latest result
            var latest = e.results[e.results.length - 1];
            for (var a = 1; a < latest.length; a++) {
                self._collectMatches(self.transcript + latest[a].transcript, unionSet);
            }

            self.matchedSet = unionSet;
            self._updateWordSpans();
        };
```

> Note: Uses `var` and a `self` reference to avoid arrow function + `this` issues. Add `var self = this;` at the top of `_setupRecognition()` before the `const SR = ...` line.

**Step 5: Manual verification**

1. Load a rap song with synced lyrics
2. Enable Game mode
3. Rap along for a few bars — words should light up green substantially more than before
4. Fast bars should still track (drift window of 6 helps)
5. Check console — no JS errors

**Step 6: Run all backend tests to make sure nothing broke**

```bash
cd C:/GPT5-Projects/Karaokee && python -m pytest tests/ -v
```
Expected: all 26 tests PASS.

**Step 7: Commit**

```bash
git add static/player.js
git commit -m "feat: fix word matching - drop expansion bug, widen drift window, add maxAlternatives union"
```

---

## Manual Test Checklist

Before considering complete:

- [ ] Demucs uses `htdemucs_ft` (check subprocess call in `vocal_remover.py`)
- [ ] Loading overlay appears on player page with song title + spinner
- [ ] Overlay dismisses and song autoplays when separation completes
- [ ] Skip button works — song plays, Game mode shows alert if vocal separation unfinished
- [ ] After overlay completes: Remove Vocals switches instantly, Game mode activates instantly
- [ ] Load a second song — overlay appears again (state was reset)
- [ ] Word matching noticeably better for rap (aim for >60% detection)
- [ ] Fast rap bars don't get stuck (drift window of 6)
- [ ] No JS errors in browser console throughout
- [ ] All 26 backend tests pass
