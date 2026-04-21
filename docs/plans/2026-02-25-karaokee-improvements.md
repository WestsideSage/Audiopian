# Consolidated Plan Record

This file merges the original design and implementation documents for this feature.

## Design

# Karaokee Improvements Design

**Date:** 2026-02-25
**Context:** Post-launch improvements based on testing with rap/hip-hop music.

---

## Area 1: Word Matching Overhaul

### Problem

Three compounding issues reduce word detection to ~30â€“50% for rap:

1. **Contraction expansion bug** â€” `setActiveLine()` calls `expandContractions([nw]).join(' ')`, producing a single multi-word string (e.g. `"gonna"` â†’ `"going to"` as one string). In `_matchTranscript`, spoken words are individual tokens, so `"going"` never equals `"going to"`. Spans go unlit.

2. **Drift window too tight** â€” window of 3 is too small for fast rap bars where words arrive in rapid bursts.

3. **Single-alternative transcript** â€” Chrome's first alternative for slang often misses; alternatives 2â€“3 frequently get it right.

### Solution

**Fix 1 â€” Remove contraction expansion from `lineWords`.**
`lineWords[i]` = `normalizeWord(w)` only (lowercase + strip punctuation). This keeps `lineWords` 1:1 with spans, fixing the type mismatch entirely.

**Fix 2 â€” Drop contraction expansion from both sides during matching.**
For rap, Chrome Speech API transcribes words phonetically as spoken ("gonna" â†’ "gonna"), so the expansion map hurts more than it helps. Both sides use plain `normalizeWords()`.

**Fix 3 â€” Widen drift window: 3 â†’ 6.**
Accommodates fast rap cadence where multiple words can arrive between polling cycles.

**Fix 4 â€” `maxAlternatives: 3`.**
Set on the `SpeechRecognition` instance. In `onresult`, collect all final alternatives per result and run `_matchTranscript` against each, taking the union of matched indices across all alternatives.

### Files Changed
- `static/player.js` â€” `setActiveLine()`, `_matchTranscript()`, `_setupRecognition()`

---

## Area 2: Pre-processing Loading Screen

### Problem

Vocal separation is manually triggered and takes 2â€“3 minutes. Users must wait after clicking "Remove Vocals" or "Game", interrupting the flow.

### Solution

**Backend â€” auto-kick separation on `/load`.**
After `download_audio()` completes in the `/load` endpoint, immediately start `separate()` in a background thread (same pattern as the existing `/separate` route). The `/separate` endpoint remains but becomes a no-op if separation is already running or done.

**Frontend â€” loading overlay on player page.**
`player.html` renders a full-screen overlay on load. The overlay displays the song title/artist and a pulsing "Preparing audioâ€¦" message. It polls `/separate-status` every 2 seconds. On `done`, the overlay fades out and the song autoplays â€” both Remove Vocals and Game mode are immediately available with no further wait.

**Skip button.**
The overlay includes a "â–¶ Skip (karaoke only)" button. Clicking it dismisses the overlay immediately, autoplays the full mix, and marks `instrumentalReady = false`. The Game button remains visible but shows a tooltip "Still processingâ€¦" and blocks activation until separation completes (checked on click).

### Files Changed
- `app.py` â€” `/load` endpoint auto-kicks separation
- `static/player.html` â€” loading overlay HTML + CSS
- `static/player.js` â€” overlay poll loop, skip logic, game button guard

---

## Area 3: Demucs Quality Upgrade

### Problem

Current model `htdemucs` leaves audible vocal bleed-through in the instrumental track, which causes the Speech API microphone to pick up residual vocals and produce incorrect transcripts.

### Solution

Switch to `htdemucs_ft` (fine-tuned variant). It was trained with additional data specifically to reduce vocal bleed and produces noticeably cleaner separation. Processing time increases ~50%, which is acceptable given the loading screen in Area 2 absorbs the wait.

**Change required:**
- `--name htdemucs` â†’ `--name htdemucs_ft`
- Output glob pattern: `htdemucs/` â†’ `htdemucs_ft/`

### Files Changed
- `vocal_remover.py`

---

## Out of Scope

- Phonetic / fuzzy word matching (Soundex, edit distance) â€” deferred to v3
- Score persistence / leaderboard
- Mobile support

---

## Implementation

# Karaokee Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix rap word-matching accuracy, add a pre-processing loading screen so both modes are ready on player load, and upgrade the demucs model to `htdemucs_ft` for cleaner vocal separation.

**Architecture:** Three independent areas: (1) frontend-only matching algorithm fixes in `player.js`, (2) backend auto-kick of separation in `app.py` + frontend loading overlay in `player.html`/`player.js`, (3) single-line demucs model swap in `vocal_remover.py`. No new files needed.

**Tech Stack:** Python/Flask backend, vanilla JS frontend, pytest for backend tests, manual browser verification for frontend. Design doc: `docs/plans/2026-02-25-karaokee-improvements-design.md`.

> âš ï¸ **Windows template literal warning:** When writing or editing `player.js`, ALWAYS use the `Edit` or `Write` tools directly from the main Claude context. Do NOT delegate JS file writes to Bash subagents â€” backtick template literals (e.g. `` `${foo}` ``) get silently stripped on Windows.

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

**Step 3: Update vocal_remover.py â€” model name and glob pattern**

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
Expected: FAIL â€” `separation_state["status"]` is still `"idle"`, `mock_thread` not called.

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
            <span>Preparing audioâ€¦</span>
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

### Task 4: Loading overlay JS â€” poll loop, skip, and game guard

**Files:**
- Modify: `static/player.js`

> âš ï¸ Use the `Edit` or `Write` tool directly â€” do NOT use Bash to write this file.

**Step 1: Add overlay state flag and suppress canplay autoplay during overlay**

In `player.js`, find the `// Auto-play when audio is ready` section and replace it:

```javascript
// Suppress autoplay while loading overlay is active
let overlayDismissed = false;

// Auto-play when audio is ready (only after overlay dismisses)
audio.addEventListener('canplay', () => {
    if (overlayDismissed) {
        audio.play().then(() => { playBtn.textContent = 'â¸'; }).catch(() => {});
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

> Note: Arrow functions and template literals are avoided here to prevent the Windows backtick-stripping issue. `\u2014` = em dash, `\u23F8` = â¸.

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
3. Wait for separation to complete â€” overlay should fade out and song should autoplay
4. Confirm both "Remove Vocals" and "Game" buttons work immediately
5. Load another song, click Skip â€” confirm overlay dismisses, song plays, Game button shows alert if clicked
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

> âš ï¸ Use the `Edit` or `Write` tool directly â€” do NOT use Bash to write this file.

**Step 1: Fix lineWords â€” remove contraction expansion**

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
3. Rap along for a few bars â€” words should light up green substantially more than before
4. Fast bars should still track (drift window of 6 helps)
5. Check console â€” no JS errors

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
- [ ] Skip button works â€” song plays, Game mode shows alert if vocal separation unfinished
- [ ] After overlay completes: Remove Vocals switches instantly, Game mode activates instantly
- [ ] Load a second song â€” overlay appears again (state was reset)
- [ ] Word matching noticeably better for rap (aim for >60% detection)
- [ ] Fast rap bars don't get stuck (drift window of 6)
- [ ] No JS errors in browser console throughout
- [ ] All 26 backend tests pass
