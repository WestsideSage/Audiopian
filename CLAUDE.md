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
node tests/test_scoring_session.cjs
node tests/test_telemetry_helpers.cjs
# ...and the rest under tests/*.cjs (scoring, phrase-engine, phrase-score, scoring-arcade,
# commit-helpers, vad-helpers, anchor-selection, lyric-paint-helpers, realtime-whisper, telemetry-replay)
```

### Whisper / transcription configuration (environment variables)
```bash
WHISPER_PROVIDER=auto          # auto|local (faster-whisper) | openai | openai_realtime (gpt-realtime-whisper, browser-streamed)
OPENAI_API_KEY=...             # required for the openai / openai_realtime providers
OPENAI_TRANSCRIBE_MODEL=gpt-realtime-whisper  # model for the openai / openai_realtime paths
OPENAI_TRANSCRIBE_DELAY=       # gpt-realtime-whisper latency/accuracy: minimal|low|medium|high|xhigh — set low/minimal to cut the recognizer "catching up" lag on fast/dense songs (small accuracy cost)
WHISPER_MODEL=large-v3-turbo   # default local faster-whisper model
WHISPER_DEVICE=cpu             # effective here: code default is "cuda", but cublas64_12.dll is unavailable on this machine so it auto-falls back to cpu; set "cuda"/"auto" to force GPU
WHISPER_COMPUTE=int8           # effective here on the cpu fallback; code default is "float16" (used when WHISPER_DEVICE=cuda)
WHISPER_CPU_COMPUTE=int8       # for CPU fallback
```

## Architecture

### Backend (Python/Flask — `app.py`)
Single-file Flask server with these responsibilities:
- **`/`** / **`/player`** — serve `static/index.html` (search/load UI) and `static/player.html` (the karaoke player)
- **`/load`** — accepts a YouTube URL; returns JSON with `title`/`artist`/**`videoId`**/`audioUrl`/`lyrics` (lyrics via `lyrics.py`). The browser plays the backing track **client-side via the YouTube IFrame player** (from `videoId`); `audioUrl` is always `/audio` but is read **only by the local `<audio>` fallback** (the IFrame path ignores it). The server **does not download audio by default** — set `KARAOKEE_SERVER_AUDIO=1` (dev) to re-enable the `yt-dlp` download to `temp/audio.*` for that `<audio>` path. (See ADR-0002 + `static/youtube-source.js`.)
- **`/load-local`** — multipart upload of a local audio file + lyrics by title/artist (saved to `temp/audio.<ext>`); lets the app run/test without YouTube
- **`/audio`** — streams the most-recent `temp/audio.*`, mimetype guessed. Now used **only by the local `<audio>` path** (uploaded files via `/load-local`, or the dev `KARAOKEE_SERVER_AUDIO` download) — the deployed YouTube path streams from the IFrame, not here
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
Wraps yt-dlp: `extract_metadata()` (no download — returns `title`/`artist`/`duration`/**`id`**), `download_audio()` (saves to `temp/audio.webm` — **dev-only now**: `/load` calls it only when `KARAOKEE_SERVER_AUDIO=1`), `search_youtube()`. Artist/title are parsed from the YouTube title using ` - ` split or explicit `artist` tag.

### Frontend (plain HTML/JS — `static/`)
No build step; files are served directly by Flask.

- **`player.js`** — main karaoke controller (DOM, playback, lyric scrolling, mic capture, game mode, HUD). Playback goes through a **source-agnostic `playback` adapter** (`playback-source.js`): a YouTube IFrame source when `songData.videoId` is present, else an `<audio>` source for uploaded local files. Orchestration and rendering only: it feeds events into `KaraokeeScoringSession` (see `scoring-session.js`) and renders the session's emitted events via `_renderEvents`. The scoring state machine itself (match→reconcile→score→commit) lives in `scoring-session.js`.
- **`scoring-session.js`** (`window.KaraokeeScoringSession`) — the per-run scoring state machine (match→reconcile→score→commit) extracted from `player.js`; DOM-free, clock-injected, emits render-intent events that `player.js` `_renderEvents` paints. Tested in `tests/test_scoring_session.cjs`.
- **`playback-source.js`** (`AudioElementSource`) — the playback-source contract + its `<audio>` implementation; lets `player.js` drive `<audio>` or the YouTube IFrame behind one interface (`play/pause/seek/currentTime/duration/setVolume` + `onReady/onEnded/onState`). Tested in `tests/test_playback_source.cjs`.
- **`youtube-source.js`** (`YouTubeIframeSource`, `ytStateToString`, `isEmbedDisabledError`, `ensureYouTubeApi`) — the YouTube IFrame implementation of that contract. Clock = `getCurrentTime()` (frame-grained; **no** `performance.now()` interpolation — see ADR-0002 + the `spikes/youtube-clock/` spike). Tested in `tests/test_youtube_source.cjs`.
- **`playback-gate.js`** (`playbackGateDecision`) — pure helper: scoring is credited only while `playing`; buffering/ads freeze the clock; embed-disabled (101/150) → fallback UI. Tested in `tests/test_playback_gate.cjs`.
- **`scoring.js`** (`window.KaraokeeScoring`) — phonetic/fuzzy matching + line scoring engine: `doubleMetaphone`, `editDistance`, `wordsMatch`/`wordsMatchScore`, word normalization, syllable-weighted `interpolateWordTimings`, `computeLineScore`, `findMatchInWindow`, `mergeConfirmedMatches`. **Single source of truth** for these — `player.js` binds them. Tested in `test_scoring.cjs`.
- **`phrase-engine.js`** (`window.KaraokeePhraseEngine`) — phrase-level scoring built on `scoring.js`: anchor matching, line settle/commit, late-evidence reconciliation. Tested in `test_phrase_engine.cjs` / `test_phrase_score.cjs`.
- **`scoring-arcade.js`** (`window.KaraokeeArcade`) — pure arcade scoring state machine (combos, points, grade). Tested in `test_scoring_arcade.cjs`.
- **`match-helpers.js`** — contraction/slang normalization, **homophone matching** (`HOMOPHONE_PAIRS` → `SLANG_MAP`: short/different-first-letter homophones the metaphone path misses, e.g. eye/I, no/know, one/won, by/bye), filler-word skipping, `MetaphoneLRU`, `maxEditDistance`, `classifyWord`. Loaded before `scoring.js`/`player.js`.
- **`sync-helpers.js`** — pure adaptive-sync timing: `classifyTempo()`, `getWindowParams()` keyed by tempo class (slow/normal/fast). Tested in `test_sync_helpers.cjs`.
- **`vad-helpers.js`** — the RMS energy-gate voice-activity logic (EMA noise floor, dual-threshold hysteresis), used as the **fallback**. Tested in `test_vad_helpers.cjs`. The **primary** VAD is a neural model (Silero, via the vendored `@ricky0123/vad-web` `MicVAD` under `static/vendor/vad/`), wired in `player.js` (`_micVad` / `_neuralVadActive`) with the RMS gate as fallback.
- **`telemetry-helpers.js`** (`window.KaraokeeTelemetry`) — `summarizeRun` digest builder for the telemetry `summary` block. Tested in `test_telemetry_helpers.cjs`.
- **`lyric-paint-helpers.js`** (`window.KaraokeeLyricPaint`) — pure anchor→span index mapping for in-game lyric coloring. Tested in `test_lyric_paint_helpers.cjs`.
- **`realtime-whisper.js`** (`window.KaraokeeRealtimeWhisper`) — browser-side OpenAI Realtime client helpers (Float32→PCM16/base64, session wiring). Tested in `test_realtime_whisper_helpers.cjs`.
- **`commit-helpers.js`** — pure commit-cadence state machine for the `openai_realtime` path: decides when to flush `input_audio_buffer.commit` (on speech-end + a tempo-aware cap) instead of blind 700 ms slices. Tested in `test_commit_helpers.cjs`.
- **`browser-support.js`** (`isSupportedBrowser`) — pure desktop-Chrome/Edge support predicate (mobile UA or no Web Speech → unsupported; block-if-unsure) behind the `index.html` desktop-only interstitial. Tested in `test_browser_support.cjs`.
- **`share-card.js`** (`buildShareCardLines`) — pure formatter for the end-screen score share-image (brand/grade/stat/song lines); the 1080² canvas draw + PNG download is `player.js` `_downloadShareImage`. Tested in `test_share_card.cjs`.
- **`alternatives.js`** (`window.KaraokeeAlternatives`) — pure `pickBestTranscript(alternatives, expectedWords, matchFn)`: on a **final** browser-SR result, picks the alternative (`maxAlternatives=3`) that matches the most of the expected line, but only switches away from alt[0] on a *strict* win (honesty-bounded: nothing matches → keep alt[0], so it can't credit unsung words). `player.js` `_chooseAlternative`/`_expectedWordsForAlt` wire it with `KaraokeeScoring.wordsMatch`. Tested in `test_alternatives.cjs`.
- **`profanity.js`** (`window.KaraokeeProfanity`) — pure `isProfane` / `isNeverScore` / `censorWord` / `censorLine` for Clean mode: profanity is excluded from key-word selection (`phrase-engine.js selectAnchors`) and masked in the displayed lyrics; the hard-R n-word is additionally `isNeverScore` (never an anchor, never credits, in any mode — derived in source so it isn't spelled out). Consumed lazily by `scoring.js` + `phrase-engine.js`. Tested in `test_profanity.cjs`.
- **`audio-processor.js`** — AudioWorklet processor that buffers mic samples, emits chunks to the main thread for whisper, and posts RMS energy for VAD.

### JS helper isolation pattern
The helper modules above (`scoring.js`, `phrase-engine.js`, `scoring-arcade.js`, `scoring-session.js`, `match-helpers.js`, `sync-helpers.js`, `vad-helpers.js`, `telemetry-helpers.js`, `lyric-paint-helpers.js`, `realtime-whisper.js`, `commit-helpers.js`, `browser-support.js`, `share-card.js`, `alternatives.js`, `profanity.js`, `playback-gate.js`, `playback-source.js`, `youtube-source.js`) use a UMD wrapper, so they can be `require()`d by the `.cjs` test files in `tests/` **and** loaded as `<script>` globals in the browser. Most are pure (no DOM/AudioContext); the playback sources are thin adapters tested via dependency injection (a fake `<audio>` element / a fake `YT` API). `player.js` is the only DOM-bound file. When adding logic, prefer a pure helper module (with a `.cjs` test) over growing `player.js`, and preserve Node.js compatibility.

### Telemetry
Each completed run auto-saves a JSON to `output_telemetry/<date>/` via `POST /telemetry` (Flask writes it; the client builds it in `player.js` `_buildTelemetryPayload`, called on song-end and on stop). Schema v2 (`meta.schemaVersion: 2`) adds a `summary` block (final scores, arcade outcome, recognizer attribution, sync drift, and a cheese/honesty correlation) and an `arcade` block (per-phrase commit events + high score). Lean by default; the heavy raw arrays (`asr`/`matches`/`promotions`/`phraseEngine.traces`) are included only when debug is on (press `D`). The `summary` digest is derived by the pure `static/telemetry-helpers.js` (`summarizeRun`, golden-tested in `tests/test_telemetry_helpers.cjs`). For offline analysis of scoring honesty/economy and timing drift — not part of the production serving path.

## Key constraints

- `temp/audio.*` holds only one song at a time (overwritten on each `/load-local` upload, or each `/load` when `KARAOKEE_SERVER_AUDIO=1`). The deployed YouTube path doesn't use it — playback is the client-side IFrame.
- The JS helper files use `var` / plain functions (not ES modules) so they work in both browser `<script>` context and Node.js `require()`.
- When writing JS files with backtick template literals on Windows, use the Edit or Write tools directly — do not delegate to Bash subagents (backtick expressions get stripped).

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `WestsideSage/Vocalz` (via the `gh` CLI; requires `gh` installed + `gh auth login`). See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage labels using default names (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
