# Telemetry

After each playthrough, the browser saves a JSON file describing what happened — for **offline analysis only.** It's how the scoring got tuned; it is *not* part of serving the game to players.

> **In the online version, telemetry is off.** The deployed app won't collect players' runs — see [ADR-0003](../adr/0003-arcade-default-lyric-axis-frozen.md) and the [deployment plan](deployment.md). If it's ever turned on, it must be **opt-in and fully transparent** (the player sees exactly what's collected, how, and why). For now it's a **local-development tool** only.

## Where it goes

The browser builds the JSON (`player.js`, `_buildTelemetryPayload`) at song-end or stop and POSTs it to `/telemetry`, which writes it under `output_telemetry/<date>/`. (Those files are git-ignored.)

Press **D** during local testing to label the next saved run and choose its capture
profile. Supported intents are `good_expert_run`, `humming_cheese`,
`silent_section_test`, and `ui_test`. Corpus analysis excludes `ui_test` while
retaining older untagged runs.

Choose the smallest profile that answers the question:

- **Compact analysis (recommended):** scoring, fairness, cheese, and routine playtests.
- **Recognition diagnostics:** honest misses, ASR behavior, and lattice investigations.
- **Full engine diagnostics:** one-off engine debugging where raw traces and the full plan are required.

The profile is fixed when the run starts and saved as `meta.telemetryProfile`.

## What's in it (schema v3)

`meta.schemaVersion` is `3`. Every file has these analysis surfaces:

As of 2026-07-20, new phrase plans omit the unused `difficulty.minFlowCoverage`
property, and new transition records omit the always-zero `weightedMatched` and
`totalComparisons` diagnostics. Readers should continue accepting those fields in
older saved payloads.

- **`summary`** — the at-a-glance digest: final scores, the arcade outcome, which recognizer earned the credit, sync drift, and a cheese-vs-honesty correlation. Built by the pure helper `summarizeRun` in `static/telemetry-helpers.js` (golden-tested in `tests/test_telemetry_helpers.cjs`).
- **`arcade`** — per-phrase commit events and the high score.
- **`analysis`** — compact phrase rows plus run-level outcome, source, matcher,
  rejection, and attention-flag counts. `voiced_miss`, `voiced_partial`,
  `late_credit` (250 ms or more), and `trace_overflow` point analysts directly at
  lines worth review; smaller credit lag remains available on each phrase row.
- **`transitions`** — line-level timing and source diagnostics.

The `recognition` profile adds `diagnostics.asr`, `diagnostics.matches`, and
`diagnostics.promotions`. `full` also adds `diagnostics.phrasePlan` and
`diagnostics.phraseTraces`. Older v2 files keep their former top-level locations;
offline readers must accept both layouts.

The localhost server stores v3 without formatting whitespace to reduce disk use.
The manual **Download Telemetry** button remains pretty-printed for inspection.

## Corpus report

`node scripts/summarize-telemetry.cjs` reads v2 and v3 files, skips `ui_test`, and
emits an analyst-ready JSON report with one normalized row per run. For a flat file:

```powershell
node scripts/summarize-telemetry.cjs --csv output_telemetry > telemetry-runs.csv
```

## What it's for

- see how each recognizer (browser vs. Whisper) behaved and what it contributed,
- review line/phrase timing and sync drift,
- study scoring honesty (did the Honest % match how the run actually went?),
- compare scoring changes between runs.

## A caveat on replay

Even the full export does not capture every raw scoring input, so it cannot
deterministically re-run every decision. For exact regressions, write a focused
pure test instead. `tests/test_telemetry_replay.cjs` is the replay-harness pattern.
