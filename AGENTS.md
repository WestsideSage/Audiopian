# Audiopian Agent Guide

  ## Scope
  These instructions apply to the whole repository.

  ## Product Path
  - Treat the shipped app as Flask + server-served static files.
  - The primary runtime path is `app.py` + `static/`.
  - `downloader.py` owns YouTube metadata/download behavior.
  - `lyrics.py` owns lyric fetch/parsing behavior.
  - Production code is `app.py` + `static/` (plus `downloader.py`/`lyrics.py`). There is no `src/` directory.

  ## Canonical Commands
  - Install: `pip install -r requirements.txt`
  - Run locally: `python app.py`
  - Backend tests: `python -m pytest tests/test_app.py tests/test_downloader.py tests/test_lyrics.py -v`
  - JS helper tests: `node tests/test_match_helpers.cjs` (and the other `tests/*.cjs` — scoring, sync-helpers, scoring-session, phrase-engine, phrase-score, scoring-arcade, commit-helpers, vad-helpers, anchor-selection, telemetry-helpers, lyric-paint-helpers, realtime-whisper, telemetry-replay)

  ## Editing Rules
  - Keep backend route/process orchestration in `app.py`.
  - Keep focused backend logic in `downloader.py` and `lyrics.py`.
  - In frontend work, prefer extracting pure logic into helper files that can be tested from Node.
  - Treat `static/` as the production frontend.

  ## Verification
  - When changing Python backend behavior, run the relevant pytest tests.
  - When changing `static/match-helpers.js` or `static/sync-helpers.js`, run the corresponding Node test script.
  - When changing playback, timing, ASR, scoring, telemetry, or mic/audio behavior, do a manual browser smoke test in
  addition to automated tests.

  ## Use Extra Care
  - Do not casually modify or delete local/generated data under `temp/`, `output_telemetry/`, or `.worktrees/`.
  - Be careful in `app.py` Whisper load/transcribe paths; they are hardware-sensitive and only lightly covered by tests.
  - Be careful in `static/player.js`; it contains core scoring, timing, and telemetry behavior.