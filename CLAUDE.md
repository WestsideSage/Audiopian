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

### Whisper / transcription configuration (environment variables)
```bash
WHISPER_PROVIDER=auto          # auto|local (faster-whisper) | openai | openai_realtime (gpt-realtime-whisper, browser-streamed)
OPENAI_API_KEY=...             # required for the openai / openai_realtime providers
OPENAI_TRANSCRIBE_MODEL=gpt-realtime-whisper  # model for the openai / openai_realtime paths
WHISPER_MODEL=large-v3-turbo   # default local faster-whisper model
WHISPER_DEVICE=cpu             # default (cublas64_12.dll unavailable on this machine); set to "cuda" or "auto" to opt in
WHISPER_COMPUTE=int8           # default; use "float16" when WHISPER_DEVICE=cuda
WHISPER_COMPUTE_CPU=int8       # for CPU fallback
```

## Architecture

### Backend (Python/Flask — `app.py`)
Single-file Flask server with these responsibilities:
- **`/`** / **`/player`** — serve `static/index.html` (search/load UI) and `static/player.html` (the karaoke player)
- **`/load`** — accepts YouTube URL, calls `downloader.py` to fetch audio and `lyrics.py` to fetch synced lyrics, returns JSON with title/artist/audioUrl/lyrics
- **`/load-local`** — multipart upload of a local audio file + lyrics by title/artist (saved to `temp/audio.<ext>`); lets the app run/test without YouTube
- **`/audio`** — streams the most-recent `temp/audio.*` (YouTube `.webm` or an uploaded file), mimetype guessed
- **`/transcribe`** — accepts raw WAV bytes and transcribes via the resolved provider (`local` faster-whisper, or `openai` file API), returning `{transcript, words}` with word-level timestamps; 503 if model not ready, 409 when the active provider is `openai_realtime` (streaming runs browser-side — see `/realtime-transcription-session`), 500 on error
- **`/realtime-transcription-session`** — mints an ephemeral OpenAI Realtime transcription session so the browser streams mic audio straight to `gpt-realtime-whisper`; 404 if realtime isn't enabled, 503 if not configured/ready
- **`/whisper-status`** — polling endpoint for model load state (`idle | loading | ready | error`)
- **`/retry-lyrics`** — re-fetches lyrics with user-corrected title/artist
- **`/telemetry`** — persists a completed run's JSON to `output_telemetry/<date>/` (see Telemetry below)
- **`/search`** — proxies YouTube search via yt-dlp (returns up to 5 results)

**Transcription providers:** `_resolve_whisper_provider()` maps `WHISPER_PROVIDER` to one of `local` (faster-whisper; the `auto`/default), `openai` (OpenAI file API), or `openai_realtime` (browser-side streaming to `gpt-realtime-whisper` via `/realtime-transcription-session` — the server `/transcribe` route returns 409 in this mode).

**Whisper lifecycle:** The local model prewarms in a background thread on the first HTTP request (`_ensure_prewarm`). CUDA load failures automatically fall back to CPU. Runtime CUDA errors during transcription trigger `_switch_whisper_to_cpu`. For `openai_realtime`, `_mark_openai_realtime_ready()` flips state to `ready` without loading a local model. Module-level globals (`_whisper_model`, `_whisper_state`, `_whisper_error`, `_whisper_active_provider`, etc.) are protected by `_whisper_lock`. Tests that touch these globals must save/restore them (see `test_app.py` patterns with `orig_state`/`finally` blocks).

### Lyrics pipeline (`lyrics.py`)
Fetches time-synced LRC lyrics from lrclib.net. Scores candidates by title/artist token overlap + duration proximity + synced-lyrics bonus. `parse_lrc()` converts LRC format to `[{time: float, text: str}]` list.

### Downloader (`downloader.py`)
Wraps yt-dlp: `extract_metadata()` (no download), `download_audio()` (saves to `temp/audio.webm`), `search_youtube()`. Artist/title are parsed from YouTube title using ` - ` split or explicit `artist` tag.

### Frontend (plain HTML/JS — `static/`)
No build step; files are served directly by Flask.

- **`player.js`** — main karaoke controller (DOM, audio playback, lyric scrolling, mic capture, game mode, HUD). Orchestration only: it binds the matching/scoring primitives from `window.KaraokeeScoring` (see `scoring.js`) rather than implementing them.
- **`scoring.js`** (`window.KaraokeeScoring`) — phonetic/fuzzy matching + line scoring engine: `doubleMetaphone`, `editDistance`, `wordsMatch`/`wordsMatchScore`, word normalization, syllable-weighted `interpolateWordTimings`, `computeLineScore`, `findMatchInWindow`, `mergeConfirmedMatches`. **Single source of truth** for these — `player.js` binds them. Tested in `test_scoring.cjs`.
- **`phrase-engine.js`** (`window.KaraokeePhraseEngine`) — phrase-level scoring built on `scoring.js`: anchor matching, line settle/commit, late-evidence reconciliation. Tested in `test_phrase_engine.cjs` / `test_phrase_score.cjs`.
- **`scoring-arcade.js`** (`window.KaraokeeArcade`) — pure arcade scoring state machine (combos, points, grade). Tested in `test_scoring_arcade.cjs`.
- **`match-helpers.js`** — contraction/slang normalization, filler-word skipping, `MetaphoneLRU`, `maxEditDistance`, `classifyWord`. Loaded before `scoring.js`/`player.js`.
- **`sync-helpers.js`** — pure adaptive-sync timing: `classifyTempo()`, `getWindowParams()` keyed by tempo class (slow/normal/fast). Tested in `test_sync_helpers.cjs`.
- **`vad-helpers.js`** — adaptive, debounced voice-activity gate (EMA noise floor, dual-threshold hysteresis). Tested in `test_vad_helpers.cjs`.
- **`telemetry-helpers.js`** (`window.KaraokeeTelemetry`) — `summarizeRun` digest builder for the telemetry `summary` block. Tested in `test_telemetry_helpers.cjs`.
- **`lyric-paint-helpers.js`** (`window.KaraokeeLyricPaint`) — pure anchor→span index mapping for in-game lyric coloring. Tested in `test_lyric_paint_helpers.cjs`.
- **`realtime-whisper.js`** (`window.KaraokeeRealtimeWhisper`) — browser-side OpenAI Realtime client helpers (Float32→PCM16/base64, session wiring). Tested in `test_realtime_whisper_helpers.cjs`.
- **`audio-processor.js`** — AudioWorklet processor that buffers mic samples, emits chunks to the main thread for whisper, and posts RMS energy for VAD.

### JS helper isolation pattern
The helper modules above (`scoring.js`, `phrase-engine.js`, `scoring-arcade.js`, `match-helpers.js`, `sync-helpers.js`, `vad-helpers.js`, `telemetry-helpers.js`, `lyric-paint-helpers.js`, `realtime-whisper.js`) are pure (no DOM/AudioContext) and use a UMD wrapper, so they can be `require()`d by the `.cjs` test files in `tests/` **and** loaded as `<script>` globals in the browser. `player.js` is the only DOM-bound file. When adding logic, prefer a pure helper module (with a `.cjs` test) over growing `player.js`, and preserve Node.js compatibility.

### Telemetry
Each completed run auto-saves a JSON to `output_telemetry/<date>/` via `POST /telemetry` (Flask writes it; the client builds it in `player.js` `_buildTelemetryPayload`, called on song-end and on stop). Schema v2 (`meta.schemaVersion: 2`) adds a `summary` block (final scores, arcade outcome, recognizer attribution, sync drift, and a cheese/honesty correlation) and an `arcade` block (per-phrase commit events + high score). Lean by default; the heavy raw arrays (`asr`/`matches`/`promotions`/`phraseEngine.traces`) are included only when debug is on (press `D`). The `summary` digest is derived by the pure `static/telemetry-helpers.js` (`summarizeRun`, golden-tested in `tests/test_telemetry_helpers.cjs`). For offline analysis of scoring honesty/economy and timing drift — not part of the production serving path.

## Key constraints

- `temp/audio.webm` holds only one song at a time (overwritten on each `/load`).
- The JS helper files use `var` / plain functions (not ES modules) so they work in both browser `<script>` context and Node.js `require()`.
- When writing JS files with backtick template literals on Windows, use the Edit or Write tools directly — do not delegate to Bash subagents (backtick expressions get stripped).

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `WestsideSage/Vocalz` (via the `gh` CLI; requires `gh` installed + `gh auth login`). See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage labels using default names (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
