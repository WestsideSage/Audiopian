# Telemetry

After each playthrough, the browser saves a JSON file describing what happened — for **offline analysis only.** It's how the scoring got tuned; it is *not* part of serving the game to players.

> **In the online version, telemetry is off.** The deployed app won't collect players' runs — see [ADR-0003](../adr/0003-arcade-default-lyric-axis-frozen.md) and the [deployment plan](deployment.md). If it's ever turned on, it must be **opt-in and fully transparent** (the player sees exactly what's collected, how, and why). For now it's a **local-development tool** only.

## Where it goes

The browser builds the JSON (`player.js`, `_buildTelemetryPayload`) at song-end or stop and POSTs it to `/telemetry`, which writes it under `output_telemetry/<date>/`. (Those files are git-ignored.)

## What's in it (schema v2)

`meta.schemaVersion` is `2`. The file is **lean by default**, with two always-on digests:

- **`summary`** — the at-a-glance digest: final scores, the arcade outcome, which recognizer earned the credit, sync drift, and a cheese-vs-honesty correlation. Built by the pure helper `summarizeRun` in `static/telemetry-helpers.js` (golden-tested in `tests/test_telemetry_helpers.cjs`).
- **`arcade`** — per-phrase commit events and the high score.

The **heavy raw arrays** — `asr`, `matches`, `promotions`, and `phraseEngine.traces` — are included **only when debug mode is on (press `D`)**, because they're large.

## What it's for

- see how each recognizer (browser vs. Whisper) behaved and what it contributed,
- review line/phrase timing and sync drift,
- study scoring honesty (did the Honest % match how the run actually went?),
- compare scoring changes between runs.

## A caveat on replay

The export captures outcomes and event traces, not every raw scoring input — so it can't deterministically *re-run* every decision. For exact regressions, write a focused pure test instead. `tests/test_telemetry_replay.cjs` is the replay-harness pattern (it consumes a telemetry-shaped fixture with an explicit `replay` section, since production exports aren't replay-complete).
