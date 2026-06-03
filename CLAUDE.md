# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Run the app
```bash
python app.py
# Or with debug mode:
FLASK_DEBUG=1 python app.py
```

### Run Python tests
```bash
python -m pytest tests/test_app.py tests/test_downloader.py tests/test_lyrics.py -v
# Single test file:
python -m pytest tests/test_app.py -v
# Single test by name:
python -m pytest tests/test_app.py::test_transcribe_returns_transcript -v
```

### Run JS tests
```bash
node tests/test_match_helpers.cjs
node tests/test_sync_helpers.cjs
node tests/test_telemetry.cjs
```

### Whisper configuration (environment variables)
```bash
WHISPER_MODEL=large-v3-turbo   # default
WHISPER_DEVICE=cpu             # default (cublas64_12.dll unavailable on this machine); set to "cuda" or "auto" to opt in
WHISPER_COMPUTE=int8           # default; use "float16" when WHISPER_DEVICE=cuda
WHISPER_COMPUTE_CPU=int8       # for CPU fallback
```

## Architecture

### Backend (Python/Flask — `app.py`)
Single-file Flask server with these responsibilities:
- **`/load`** — accepts YouTube URL, calls `downloader.py` to fetch audio and `lyrics.py` to fetch synced lyrics, returns JSON with title/artist/audioUrl/lyrics
- **`/audio`** — streams the downloaded `temp/audio.webm` file
- **`/transcribe`** — accepts raw WAV bytes, runs faster-whisper, returns `{transcript, words}` with word-level timestamps; returns 503 if model not ready, 500 on transcription error
- **`/whisper-status`** — polling endpoint for model load state (`idle | loading | ready | error`)
- **`/retry-lyrics`** — re-fetches lyrics with user-corrected title/artist
- **`/search`** — proxies YouTube search via yt-dlp (returns up to 5 results)

**Whisper lifecycle:** The model prewarms in a background thread on the first HTTP request (`_ensure_prewarm`). CUDA load failures automatically fall back to CPU. Runtime CUDA errors during transcription trigger `_reload_whisper_on_cpu`. Module-level globals (`_whisper_model`, `_whisper_state`, `_whisper_error`, etc.) are protected by `_whisper_lock`. Tests that touch these globals must save/restore them (see `test_app.py` patterns with `orig_state`/`finally` blocks).

### Lyrics pipeline (`lyrics.py`)
Fetches time-synced LRC lyrics from lrclib.net. Scores candidates by title/artist token overlap + duration proximity + synced-lyrics bonus. `parse_lrc()` converts LRC format to `[{time: float, text: str}]` list.

### Downloader (`downloader.py`)
Wraps yt-dlp: `extract_metadata()` (no download), `download_audio()` (saves to `temp/audio.webm`), `search_youtube()`. Artist/title are parsed from YouTube title using ` - ` split or explicit `artist` tag.

### Frontend (plain HTML/JS — `static/`)
No build step; files are served directly by Flask.

- **`player.js`** — main karaoke controller. Manages audio playback, lyric scrolling, game mode (user sings along), and scoring. Contains full Double Metaphone implementation and Levenshtein edit distance for phonetic/fuzzy matching of sung words vs. lyrics.
- **`match-helpers.js`** — contraction normalization, phrase matching, filler word skipping. Loaded before `player.js`.
- **`sync-helpers.js`** — pure functions for adaptive sync timing: `classifyTempo()`, `getWindowParams()` keyed by tempo class (slow/normal/fast). Designed to be testable in Node.js.
- **`audio-processor.js`** — AudioWorklet processor that buffers mic samples, emits chunks to main thread for whisper, and posts RMS energy for VAD.

### JS helper isolation pattern
`sync-helpers.js` and `match-helpers.js` are pure (no DOM/AudioContext) so they can be `require()`d by the `.cjs` test files in `tests/`. When adding functionality to these modules, preserve Node.js compatibility.

### Telemetry
Each completed run auto-saves a JSON to `output_telemetry/<date>/` via `POST /telemetry` (Flask writes it; the client builds it in `player.js` `_buildTelemetryPayload`, called on song-end and on stop). Schema v2 (`meta.schemaVersion: 2`) adds a `summary` block (final scores, arcade outcome, recognizer attribution, sync drift, and a cheese/honesty correlation) and an `arcade` block (per-phrase commit events + high score). Lean by default; the heavy raw arrays (`asr`/`matches`/`promotions`/`phraseEngine.traces`) are included only when debug is on (press `D`). The `summary` digest is derived by the pure `static/telemetry-helpers.js` (`summarizeRun`, golden-tested in `tests/test_telemetry_helpers.cjs`). For offline analysis of scoring honesty/economy and timing drift — not part of the production serving path.

## Key constraints

- `temp/audio.webm` holds only one song at a time (overwritten on each `/load`).
- The JS helper files use `var` / plain functions (not ES modules) so they work in both browser `<script>` context and Node.js `require()`.
- When writing JS files with backtick template literals on Windows, use the Edit or Write tools directly — do not delegate to Bash subagents (backtick expressions get stripped).
