# Telemetry v3 — analysis-first capture

**Date:** 2026-07-20
**Status:** Implemented with the adversarial-review follow-up

## Why change it now

The local corpus contains 229 JSON files totaling 397.7 MB. The median file is
990 KB and p90 is 4.8 MB. In current v2 debug runs the useful run summary is
under 1 KB, while repeated recognition snapshots and raw per-phrase diagnostic
arrays dominate the payload. Those raw records are valuable when diagnosing a
recognizer failure, but they are not useful in every scoring or cheese run.

The goal is therefore not lossy global pruning. It is to make routine files
analysis-first and make expensive forensic capture an explicit choice.

## Capture profiles

The D-panel selects the profile for the **next run**:

| Profile | Intended use | Payload |
|---|---|---|
| `compact` | Routine score, fairness, and cheese runs | Summary, arcade, transitions, compact phrase analysis |
| `recognition` | Investigating honest misses and ASR/lattice behavior | Compact payload plus raw ASR, accepted matches, and promotions |
| `full` | Engine development and one-off forensic debugging | Recognition payload plus the full phrase plan and raw phrase traces |

`compact` is the default. The selected profile is written to
`meta.telemetryProfile`; changing it after a run starts does not silently change
what that run captured.

## Schema v3

All profiles retain the stable `meta`, `summary`, `arcade`, `phraseEngine`, and
`transitions` concepts. Schema v3 adds an always-on `analysis` block whose
`phrases` rows contain:

- line/window and final lyric/flow outcome;
- hit/required/total anchors and missed anchor words;
- compact accepted credits with source, score, timing, and recognizer lag;
- method and rejection counts rather than repeated diagnostic objects;
- flow-event count and first/last time rather than every VAD pulse;
- analyst flags for voiced misses/partials and credit arriving at least 250 ms late
  (smaller lag remains measurable on each credit row).

Run-level method, rejection, source, flag, and phrase-outcome counts are derived
from those rows. This makes common questions answerable without walking raw
traces.

Raw arrays move under `diagnostics` and exist only for the two diagnostic
profiles. `full` adds `diagnostics.phrasePlan` and
`diagnostics.phraseTraces`. Offline readers must continue accepting v2's
top-level `asr`, `matches`, `promotions`, and `phraseEngine.traces`.

## Persistence and compatibility

The localhost server writes v3 JSON compactly. Manual D-panel downloads remain
pretty-printed for humans. The server continues pretty-writing older schemas so
existing tests and ad-hoc legacy behavior remain stable.

No historical files are rewritten or deleted. `scripts/summarize-telemetry.cjs`
is the compatibility boundary: it reads both v2 and v3, skips `ui_test`, and
produces analyst-ready run rows rather than only counting files.

## Validation

- Pure helper tests pin profile normalization and the compact phrase digest.
- Backend tests pin compact v3 persistence and readable legacy persistence.
- Player syntax and the complete JS/Python suites remain green.
- Browser smoke verifies both D-panel selectors and their persistent values.
