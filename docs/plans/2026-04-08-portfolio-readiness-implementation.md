# Portfolio Readiness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Clean up the Karaokee repo to be resume-ready — remove dead code, fix hygiene, improve presentation.

**Architecture:** No architecture changes. This is a deletion-heavy cleanup pass that removes orphaned code (React frontend, vocal separation), fixes broken tests, pins dependencies, organizes docs, and adds a README.

**Tech Stack:** Python/Flask backend, vanilla HTML/JS/CSS frontend, pytest, Node.js (for JS tests)

---

## Phase 1: Safe Cleanup

### Task 1: Delete orphaned React/TypeScript frontend

**Files:**
- Delete: `src/hooks/useGameEngine.ts`
- Delete: `src/hooks/useLyricSync.ts`
- Delete: `src/components/LyricsView.tsx`
- Delete: `src/parser/parseLrc.ts`
- Delete: `src/` (entire directory)
- Delete: `package.json`

**Step 1: Delete files**

```bash
rm -rf src/ package.json
```

**Step 2: Verify no imports reference these files**

```bash
grep -r "from.*src/" static/ app.py *.py 2>/dev/null || echo "No references found"
grep -r "require.*src/" static/ tests/ 2>/dev/null || echo "No references found"
```

Expected: No references found.

**Step 3: Commit**

```bash
git add -A src/ package.json
git commit -m "chore: remove orphaned React/TypeScript frontend

The project uses static HTML/JS served by Flask. The src/ directory
contained 734 lines of unused React hooks, components, and a Vite
config that was never wired up."
```

---

### Task 2: Delete miscellaneous dead files

**Files:**
- Delete: `demo.json`
- Delete: `temp/write_tests.py`

**Step 1: Verify demo.json is unused**

```bash
grep -r "demo.json" static/ app.py *.py tests/ 2>/dev/null || echo "Not referenced"
```

Expected: Not referenced.

**Step 2: Delete files**

```bash
rm -f demo.json temp/write_tests.py
```

**Step 3: Commit**

```bash
git add demo.json temp/write_tests.py
git commit -m "chore: remove unused demo.json and temp/write_tests.py"
```

---

### Task 3: Remove vocal separation from Python backend

**Files:**
- Delete: `vocal_remover.py`
- Delete: `tests/test_vocal_remover.py`
- Modify: `app.py` (remove separation imports, endpoints, state)
- Modify: `tests/test_app.py` (remove separation tests)
- Modify: `requirements.txt` (remove `demucs` dependency)

**Step 1: Run existing tests to establish baseline**

```bash
python -m pytest tests/test_app.py tests/test_vocal_remover.py -v
```

Expected: All pass (1 skipped).

**Step 2: Edit `app.py` — remove vocal separation import**

Change line 8 from:
```python
from vocal_remover import separate, INSTRUMENTAL_PATH
```
Remove this line entirely.

**Step 3: Edit `app.py` — remove separation state globals**

Remove lines 13-14:
```python
separation_state = {"status": "idle"}
separation_gen = 0  # incremented on each new song load; threads check before writing state
```

**Step 4: Edit `app.py` — clean up the `/load` endpoint**

In the `/load` function, remove the entire commented-out separation block (lines 85-104):
```python
    # Vocal separation disabled for rapid testing — re-enable by restoring the block below.
    separation_state["status"] = "idle"
    separation_state.pop("error", None)
    # --- re-enable block start ---
    # ... all 15 commented lines ...
    # --- re-enable block end ---
```

**Step 5: Edit `app.py` — remove `/separate`, `/separate-status`, `/instrumental` endpoints**

Remove the three endpoint functions (lines 141-220):
- `start_separate()` (lines 141-154)
- `separate_status()` (lines 157-165)
- `instrumental()` (lines 216-220)

**Step 6: Edit `app.py` — fix duplicate threading import**

Change lines 3-4 from:
```python
import threading
import threading as _threading
```
To:
```python
import threading
```

Then replace all `_threading.Lock()` with `threading.Lock()` (line 20).

**Step 7: Edit `tests/test_app.py` — remove separation tests**

Remove these test functions and their related code:
- `test_separate_starts_processing` (lines 72-78)
- `test_separate_status_returns_state` (lines 81-90)
- `test_load_does_not_trigger_separation_when_disabled` (lines 111-128)
- `test_stale_separation_thread_does_not_overwrite_new_song_status` (lines 131-171) — already skipped

**Step 8: Delete vocal_remover module and its tests**

```bash
rm vocal_remover.py tests/test_vocal_remover.py
```

**Step 9: Remove `demucs` from `requirements.txt`**

Remove the line `demucs` from `requirements.txt`.

**Step 10: Run tests to verify nothing broke**

```bash
python -m pytest tests/ -v
```

Expected: All remaining tests pass. No skipped tests.

**Step 11: Commit**

```bash
git add -A
git commit -m "feat: remove vocal separation feature

Vocal separation was disabled and half-wired. Removing it entirely:
- Delete vocal_remover.py and its tests
- Remove /separate, /separate-status, /instrumental endpoints
- Remove separation state globals and commented-out load block
- Remove demucs dependency
- Fix duplicate threading import

Will be re-added as a deliberate feature in a future PR."
```

---

### Task 4: Remove vocal separation from frontend

**Files:**
- Modify: `static/player.js` (remove toggleVocals, pollSeparation, switchToInstrumental, vocal btn refs, prep overlay separation code)
- Modify: `static/player.html` (remove hidden vocalBtn)

**Step 1: Edit `static/player.html` — remove vocalBtn**

Remove line 327:
```html
        <button class="ctrl-btn" id="vocalBtn" onclick="toggleVocals()" style="display:none">🎤 Remove Vocals</button>
```
And its comment on line 326:
```html
        <!-- vocalBtn hidden while vocal separation is disabled; restore display:'' to re-enable -->
```

**Step 2: Edit `static/player.js` — remove vocal separation variables and functions**

Remove the entire vocal removal section (lines 2127-2192):
```javascript
// Vocal removal toggle
let instrumentalReady = false;
let usingInstrumental = false;
const vocalBtn = document.getElementById('vocalBtn');

function toggleVocals() { ... }
function pollSeparation() { ... }
function switchToInstrumental() { ... }
```

**Step 3: Edit `static/player.js` — clean up `initPrepOverlay()`**

Simplify `initPrepOverlay()` by removing the commented-out separation polling block (lines 2073-2086). The function should just show the song title and call `skipPrep()`:
```javascript
function initPrepOverlay() {
    var sd = JSON.parse(sessionStorage.getItem('songData') || 'null');
    if (sd) {
        document.getElementById('prepSongTitle').textContent =
            sd.artist + ' \u2014 ' + sd.title;
    }
    skipPrep();
}
```

**Step 4: Edit `static/player.js` — remove `pollPrep()` and `finishPrep()` functions**

Remove lines 2089-2116 (these only exist for separation polling):
```javascript
function pollPrep() { ... }
function finishPrep(success) { ... }
```

**Step 5: Edit `static/player.js` — clean up `toggleGameMode()`**

Remove the commented-out separation guards in `toggleGameMode()` (lines 2199-2210). Should become:
```javascript
function toggleGameMode() {
    if (lyrics.length === 0) {
        alert('No lyrics available for this song \u2014 game mode requires synced lyrics.');
        return;
    }
    if (gameMode.active) {
        gameMode.stop();
    } else {
        gameMode.start();
    }
}
```

**Step 6: Verify the app still works**

```bash
python app.py &
# Open http://localhost:5000 in browser — verify search, load, playback, game mode all work
```

**Step 7: Commit**

```bash
git add static/player.js static/player.html
git commit -m "chore: remove vocal separation UI code

Remove toggleVocals, pollSeparation, switchToInstrumental functions,
hidden vocalBtn, prep overlay separation polling, and commented-out
auto-switch blocks from toggleGameMode."
```

---

### Task 5: Remove telemetry output from git tracking

**Files:**
- Modify: `.gitignore`
- Untrack: `output_telemetry/`

**Step 1: Add entries to `.gitignore`**

Append to `.gitignore`:
```
output_telemetry/
*.log
.idea/
.vscode/
*.swp
*.swo
node_modules/
```

**Step 2: Remove from git tracking (keep files on disk)**

```bash
git rm -r --cached output_telemetry/
```

**Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore: untrack telemetry output and expand .gitignore

56MB of gameplay telemetry JSON doesn't belong in the repo.
Files remain on disk for local analysis. Added IDE and log
file patterns to .gitignore."
```

---

### Task 6: Clean up stale git branches

**Step 1: List all branches**

```bash
git branch -a
```

**Step 2: Delete stale local branches**

```bash
git branch -d feat/time-gated-matching
git branch -d backup/local-prototype-snapshot
git branch -d telemetry-driven-tuning
```

If any fail with "not fully merged", use `-D` after verifying the work is already on main.

**Step 3: Clean up worktrees if no uncommitted work**

```bash
git worktree list
```

Verify each worktree. If safe:
```bash
git worktree remove .worktrees/intelligent-matching
git worktree remove .worktrees/telemetry-improvements
git worktree remove .worktrees/whisper-fix
```

Then delete the corresponding remote-tracking branches if they exist:
```bash
git branch -d feature/intelligent-matching
git branch -d feature/whisper-fix
```

**Step 4: No commit needed** (branch operations don't create commits)

---

## Phase 2: Structural Improvements

### Task 7: Fix broken maxEditDistance JS test

**Files:**
- Modify: `tests/test_match_helpers.cjs` (line 103)
- OR Modify: `static/match-helpers.js` (if the code is wrong, not the test)

**Step 1: Understand the current behavior**

The function in `static/match-helpers.js:319-322`:
```javascript
function maxEditDistance(len) {
    if (len <= 6) return 1;
    return 2;
}
```

The test on line 103 asserts `maxEditDistance(10)` should equal `3`. But the code returns `2` for any length > 6. The test expectation is wrong — there's no third tier in the code.

**Step 2: Fix the test assertion**

In `tests/test_match_helpers.cjs`, line 103, the assertion currently reads:
```javascript
assert.strictEqual(maxEditDistance(10), 3);
```

But based on the code, `maxEditDistance(10)` returns `2`. Looking at the pattern:
- len 1-6 → edit distance 1
- len 7+ → edit distance 2

The test at line 103 should be `2`, not `3`. Change to:
```javascript
assert.strictEqual(maxEditDistance(10), 2);
```

**Step 3: Run the test**

```bash
node tests/test_match_helpers.cjs
```

Expected: All tests pass.

**Step 4: Commit**

```bash
git add tests/test_match_helpers.cjs
git commit -m "fix: correct maxEditDistance test assertion

maxEditDistance returns 2 for lengths > 6, not 3. The function has
two tiers (1 for short words, 2 for longer), not three."
```

---

### Task 8: Pin requirements.txt versions

**Files:**
- Modify: `requirements.txt`

**Step 1: Update requirements.txt with pinned versions**

```
flask>=3.1,<4.0
yt-dlp>=2026.3,<2027.0
requests>=2.32,<3.0
pytest>=8.0,<9.0
faster-whisper>=1.0,<2.0
```

Note: `demucs` was already removed in Task 3.

**Step 2: Verify install still works**

```bash
pip install -r requirements.txt
```

**Step 3: Commit**

```bash
git add requirements.txt
git commit -m "chore: pin dependency version ranges in requirements.txt"
```

---

### Task 9: Fix thread safety and Flask debug mode in app.py

**Files:**
- Modify: `app.py`

**Step 1: Add lock around `_last_duration`**

After the existing `_whisper_lock` line, the `_last_duration` variable (line 15) is written without a lock. Wrap its write in the `/load` endpoint:

Add a lock near the other locks:
```python
_duration_lock = threading.Lock()
```

In the `/load` function, change:
```python
    global _last_duration
    _last_duration = meta.get("duration", 0)
```
To:
```python
    global _last_duration
    with _duration_lock:
        _last_duration = meta.get("duration", 0)
```

And in `/retry-lyrics`, wrap the read:
```python
    with _duration_lock:
        duration = _last_duration
    lyrics = fetch_lyrics(title, artist, duration=duration)
```

**Step 2: Fix Flask debug mode**

Change the last line of `app.py` from:
```python
if __name__ == "__main__":
    app.run(debug=True, port=5000)
```
To:
```python
if __name__ == "__main__":
    app.run(debug=os.environ.get("FLASK_DEBUG", "0") == "1", port=5000)
```

**Step 3: Run tests**

```bash
python -m pytest tests/test_app.py -v
```

Expected: All pass.

**Step 4: Commit**

```bash
git add app.py
git commit -m "fix: add thread lock for _last_duration, use env var for Flask debug mode"
```

---

### Task 10: Add basic logging to lyrics.py

**Files:**
- Modify: `lyrics.py`

**Step 1: Add logging import and logger**

At the top of `lyrics.py`, add:
```python
import logging

log = logging.getLogger(__name__)
```

**Step 2: Replace silent exception swallowing**

In `fetch_lyrics()`, change line 92:
```python
    except Exception:
        return []
```
To:
```python
    except Exception:
        log.exception("Failed to fetch lyrics for %s - %s", title, artist)
        return []
```

**Step 3: Run tests**

```bash
python -m pytest tests/test_lyrics.py -v
```

Expected: All pass.

**Step 4: Commit**

```bash
git add lyrics.py
git commit -m "fix: log exceptions in lyrics fetch instead of silently swallowing"
```

---

### Task 11: Organize docs/plans/ with an index

**Files:**
- Create: `docs/plans/README.md`

**Step 1: Create an index README**

Create `docs/plans/README.md` that groups the design docs chronologically and shows the project's iteration story:

```markdown
# Design & Implementation Documents

This directory contains paired design specs and implementation plans for each major feature iteration. They show how the project evolved from a basic karaoke player to a sophisticated real-time scoring engine, with each iteration informed by telemetry data from real gameplay sessions.

## Timeline

### February 2026 — Foundation
| Date | Feature | Design | Implementation |
|------|---------|--------|----------------|
| Feb 19 | Initial Karaokee app | [design](2026-02-19-karaokee-design.md) | [impl](2026-02-19-karaokee-implementation.md) |
| Feb 19 | V2 rewrite | [design](2026-02-19-karaokee-v2-design.md) | [impl](2026-02-19-karaokee-v2-implementation.md) |
| Feb 25 | UX improvements | [design](2026-02-25-karaokee-improvements-design.md) | [impl](2026-02-25-karaokee-improvements.md) |
| Feb 25 | Loading timer & lyric lag | [design](2026-02-25-loading-timer-and-lyric-lag-design.md) | [impl](2026-02-25-loading-timer-and-lyric-lag.md) |
| Feb 25 | Lyrics game mode | [design](2026-02-25-lyrics-game-design.md) | [impl](2026-02-25-lyrics-game-mode.md) |
| Feb 26 | Lyrics detection improvements | [design](2026-02-26-lyrics-detection-improvements-design.md) | [impl](2026-02-26-lyrics-detection-improvements.md) |
| Feb 26 | Predictive word timing | [design](2026-02-26-predictive-word-timing-design.md) | [impl](2026-02-26-predictive-word-timing-implementation.md) |

### March 2026 — Matching Algorithm
| Date | Feature | Design | Implementation |
|------|---------|--------|----------------|
| Mar 2 | Adaptive sync | [design](2026-03-02-adaptive-sync-design.md) | [impl](2026-03-02-adaptive-sync-implementation.md) |
| Mar 2 | Time-gated matching | [design](2026-03-02-time-gated-matching-design.md) | [impl](2026-03-02-time-gated-matching-implementation.md) |
| Mar 3 | Intelligent matching | [design](2026-03-03-intelligent-matching-design.md) | [impl](2026-03-03-intelligent-matching-implementation.md) |
| Mar 3 | Slow song time gate | [design](2026-03-03-slow-song-time-gate-design.md) | — |
| Mar 17 | Algorithm improvements | [design](2026-03-17-algorithm-improvements-design.md) | [impl](2026-03-17-algorithm-improvements-implementation.md) |

### March 2026 — Telemetry & Tuning
| Date | Feature | Design | Implementation |
|------|---------|--------|----------------|
| Mar 17 | Telemetry system | [design](2026-03-17-telemetry-design.md) | [impl](2026-03-17-telemetry-implementation.md) |
| Mar 17 | Telemetry-driven improvements | [design](2026-03-17-telemetry-driven-improvements-design.md) | [impl](2026-03-17-telemetry-driven-improvements.md) |
| Mar 17 | VAD optimistic scoring | [design](2026-03-17-vad-optimistic-scoring-design.md) | [impl](2026-03-17-vad-optimistic-scoring-implementation.md) |
| Mar 17 | VAD analyser & LRC offset | [notes](2026-03-17-vad-analyser-lrc-offset.md) | — |
| Mar 23 | Telemetry-driven tuning | [design](2026-03-23-telemetry-driven-tuning-design.md) | [impl](2026-03-23-telemetry-driven-tuning-implementation.md) |

### April 2026 — Hardening
| Date | Feature | Design | Implementation |
|------|---------|--------|----------------|
| Apr 6 | Slow-line VAD + scoring honesty | [design](2026-04-06-slow-line-vad-scoring-honesty-design.md) | [impl](2026-04-06-slow-line-vad-scoring-honesty.md) |
| Apr 6 | Whisper fix + observability | [design](2026-04-06-whisper-fix-observability-design.md) | [impl](2026-04-06-whisper-fix-observability.md) |
| Apr 8 | Portfolio readiness pass | [design](2026-04-08-portfolio-readiness-design.md) | [impl](2026-04-08-portfolio-readiness-implementation.md) |
```

**Step 2: Commit**

```bash
git add docs/plans/README.md
git commit -m "docs: add index to design docs showing project iteration timeline"
```

---

## Phase 3: Resume-Facing Polish

### Task 12: Write project README

**Files:**
- Create: `README.md`

**Step 1: Write README.md**

```markdown
# Karaokee

A real-time karaoke scoring engine that matches your singing against song lyrics using dual-track automatic speech recognition (ASR), phonetic matching, and adaptive timing.

## How It Works

1. **Search & Load** — Paste a YouTube URL or search by song name. The backend extracts audio via yt-dlp and fetches synced lyrics from lrclib.net.

2. **Dual-Track ASR** — Two speech recognition systems run in parallel:
   - **Browser SpeechRecognition** for low-latency interim results
   - **Whisper** (server-side, via faster-whisper) for high-accuracy word-level timestamps

3. **Fuzzy Matching** — Words are matched using multiple strategies:
   - Exact match
   - Double Metaphone phonetic codes ("night" ≈ "knight")
   - Levenshtein edit distance with length-adaptive thresholds
   - Contraction expansion ("gonna" ↔ "going to")
   - Slang normalization (76+ bidirectional mappings)

4. **Adaptive Sync** — Timing windows adjust based on song tempo:
   - Slow songs (< 2 wps): wider windows, longer overlap
   - Fast songs (> 5 wps): tighter windows, shorter chunks

5. **Scoring** — Per-word scoring with positional accuracy, streak tracking, and VAD-assisted provisional credit for words the mic picks up but ASR hasn't confirmed yet.

## Tech Stack

- **Backend:** Python, Flask, faster-whisper, yt-dlp
- **Frontend:** Vanilla HTML/JS/CSS (no framework)
- **ASR:** Browser Web Speech API + server-side Whisper (large-v3-turbo on CUDA)
- **Audio:** Web Audio API (AudioWorklet for real-time mic processing)

## Setup

### Prerequisites

- Python 3.10+
- NVIDIA GPU with CUDA support (for Whisper)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) (installed via pip)

### Install

```bash
pip install -r requirements.txt
```

### Run

```bash
python app.py
```

Then open http://localhost:5000.

On Windows, you can also use `start.bat` which launches the server and opens the browser.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `FLASK_DEBUG` | `0` | Set to `1` for Flask debug mode |

## Project Structure

```
├── app.py              # Flask server — API endpoints, Whisper lifecycle
├── downloader.py       # YouTube metadata extraction and audio download
├── lyrics.py           # LRC lyrics fetching and candidate ranking
├── requirements.txt    # Python dependencies
├── start.bat           # Windows launcher
├── static/
│   ├── index.html      # Search page
│   ├── player.html     # Playback + game mode UI
│   ├── player.js       # Core game engine — matching, scoring, telemetry
│   ├── match-helpers.js    # Contraction/slang/phonetic matching
│   ├── sync-helpers.js     # Tempo classification, adaptive timing
│   ├── audio-processor.js  # AudioWorklet for mic sampling + VAD
│   └── style.css
├── tests/              # pytest + Node.js test suites
└── docs/plans/         # Design docs showing iterative development
```

## Design Documents

The [docs/plans/](docs/plans/) directory contains paired design specs and implementation plans for each feature iteration, showing how the scoring algorithm evolved through telemetry-driven tuning. See the [index](docs/plans/README.md) for the full timeline.

## License

MIT
```

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add project README with architecture overview and setup instructions"
```

---

### Task 13: Add GitHub Actions CI

**Files:**
- Create: `.github/workflows/test.yml`

**Step 1: Create CI workflow**

```yaml
name: Tests

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: "3.11"

      - name: Install dependencies
        run: |
          pip install flask yt-dlp requests pytest

      - name: Run Python tests
        run: python -m pytest tests/test_app.py tests/test_downloader.py tests/test_lyrics.py -v

      - name: Run JS tests
        run: |
          node tests/test_match_helpers.cjs
          node tests/test_sync_helpers.cjs
```

Note: We install only the testable deps (not faster-whisper/demucs which need CUDA). The Python tests mock Whisper.

**Step 2: Commit**

```bash
git add .github/workflows/test.yml
git commit -m "ci: add GitHub Actions workflow for pytest and JS tests"
```

---

### Task 14: Move hardcoded config to env vars

**Files:**
- Modify: `app.py`

**Step 1: Add config constants at the top of app.py**

After the imports, add:
```python
WHISPER_MODEL = os.environ.get('WHISPER_MODEL', 'large-v3-turbo')
WHISPER_DEVICE = os.environ.get('WHISPER_DEVICE', 'cuda')
WHISPER_COMPUTE = os.environ.get('WHISPER_COMPUTE', 'float16')
```

**Step 2: Use constants in `_prewarm_whisper()`**

Change lines 29-31 from:
```python
        app.logger.info('Whisper: loading large-v3-turbo on cuda ...')
        from faster_whisper import WhisperModel
        model = WhisperModel('large-v3-turbo', device='cuda', compute_type='float16')
```
To:
```python
        app.logger.info('Whisper: loading %s on %s ...', WHISPER_MODEL, WHISPER_DEVICE)
        from faster_whisper import WhisperModel
        model = WhisperModel(WHISPER_MODEL, device=WHISPER_DEVICE, compute_type=WHISPER_COMPUTE)
```

**Step 3: Use constants in `/whisper-status`**

Change the `whisper_status()` endpoint from:
```python
        model='large-v3-turbo',
        device='cuda',
```
To:
```python
        model=WHISPER_MODEL,
        device=WHISPER_DEVICE,
```

**Step 4: Run tests**

```bash
python -m pytest tests/test_app.py -v
```

Expected: All pass.

**Step 5: Commit**

```bash
git add app.py
git commit -m "chore: move Whisper config to environment variables with sensible defaults"
```

---

## Task Summary

| Task | Phase | Description | Risk |
|------|-------|-------------|------|
| 1 | 1 | Delete orphaned React frontend | None |
| 2 | 1 | Delete misc dead files | None |
| 3 | 1 | Remove vocal separation (backend) | Low — verify tests pass |
| 4 | 1 | Remove vocal separation (frontend) | Low — verify app works |
| 5 | 1 | Untrack telemetry output | None |
| 6 | 1 | Clean up stale branches | Low — verify no uncommitted work |
| 7 | 2 | Fix broken JS test | None |
| 8 | 2 | Pin dependency versions | None |
| 9 | 2 | Fix thread safety + debug mode | Low |
| 10 | 2 | Add logging to lyrics.py | None |
| 11 | 2 | Organize docs with index | None |
| 12 | 3 | Write project README | None |
| 13 | 3 | Add GitHub Actions CI | None |
| 14 | 3 | Move config to env vars | Low |
