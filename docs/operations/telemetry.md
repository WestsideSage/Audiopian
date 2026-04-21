# Telemetry

Gameplay telemetry is exported from the browser for offline analysis.

## Output Location

- Exported files are typically stored under `output_telemetry/<date>/`.

## Top-Level Sections

Telemetry JSON currently contains:

- `meta`
- `asr`
- `matches`
- `promotions`
- `transitions`

## Purpose

- inspect browser SR behavior
- inspect Whisper contribution
- review line transition timing
- compare scoring rollouts between sessions

## Known Limitation

Current telemetry is useful for analysis but not sufficient by itself to deterministically recompute every scoring decision. It captures line-level outcomes and event traces, not a full replay log of every runtime scoring input.

## Replay Guidance

- use telemetry to identify candidate regressions
- use `tests/test_scoring.cjs` for deterministic arithmetic regressions
- when a failure mode is found, add a focused pure regression case rather than relying on schema-only checks

## Current Policy

- stub-only telemetry tests were removed
- telemetry coverage should come from real production code or replay-oriented fixtures, not hand-written schema stubs
