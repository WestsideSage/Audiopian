# Architecture

Karaokee ships as a Flask app plus server-served static files.

## Runtime Path

1. `app.py` serves `/`, `/player`, `/load`, `/audio`, `/retry-lyrics`, `/search`, `/whisper-status`, and `/transcribe`.
2. `downloader.py` owns YouTube metadata extraction and audio download into `temp/audio.webm`.
3. `lyrics.py` owns lrclib lookup, candidate ranking, and LRC parsing.
4. `static/index.html` gathers the song request and stores `songData` in `sessionStorage`.
5. `static/player.html` loads the production frontend:
   - `sync-helpers.js`
   - `match-helpers.js`
   - `scoring.js`
   - `player.js`
6. `player.js` coordinates playback, line activation, speech recognition, Whisper dispatch, VAD hints, scoring, and telemetry export.

## Main Data Flow

### Load Path

1. User loads a song.
2. `/load` extracts title, artist, and duration from YouTube metadata.
3. `/load` downloads audio and ranks synced lyric candidates from lrclib.
4. The browser stores `{title, artist, audioUrl, lyrics}` in `sessionStorage`.
5. `/player` reads `songData`, renders lyrics, and prepares the game mode state.

### Game Path

1. `player.js` interpolates per-word timings from LRC lines.
2. `updateLyrics()` advances the active line from audio time.
3. Browser SpeechRecognition provides low-latency interim and final text.
4. Whisper receives chunked WAV audio from `audio-processor.js` and can add slower late confirmations.
5. Matching updates per-word slot state.
6. `_scoreLine()` computes weighted line results when a line closes.
7. Running totals, streaks, and modal results are updated in the DOM.

## State Boundaries

- Session state lives in `GameMode`.
- Per-line state is reset by `_resetLineState()`.
- Per-session counters are reset by `_resetSessionCounters()`.
- Pure matching and scoring helpers live in `static/match-helpers.js`, `static/sync-helpers.js`, and `static/scoring.js`.

## Operational Constraints

- The shipped frontend is `static/`, not `src/`.
- Only one downloaded audio file is active at a time.
- Browser speech recognition is the real-time path.
- Whisper is supplemental and often CPU-bound on this machine.
