# Design Documents

This directory contains the surviving plan record for each major feature iteration. Former design and implementation pairs have been consolidated into one document per feature so the history stays readable without duplicating context.

> **Newer work lives elsewhere.** Plans and specs from **May 2026 onward** — the arcade-scoring, realtime-whisper, and scoring-session era — are kept as spec + plan pairs under [`docs/superpowers/`](../superpowers/README.md). The timeline below covers the **February–April 2026** foundation, matching, telemetry, and hardening work.

## Timeline

### February 2026 - Foundation

| Date | Feature | Document |
|------|---------|----------|
| Feb 19 | Original build plan | [doc](2026-02-19-karaokee.md) |
| Feb 19 | V2 rewrite | [doc](2026-02-19-karaokee-v2.md) |
| Feb 25 | UX improvements | [doc](2026-02-25-karaokee-improvements.md) |
| Feb 25 | Loading timer and lyric lag | [doc](2026-02-25-loading-timer-and-lyric-lag.md) |
| Feb 25 | Lyrics game mode | [doc](2026-02-25-lyrics-game-mode.md) |
| Feb 26 | Lyrics detection improvements | [doc](2026-02-26-lyrics-detection-improvements.md) |
| Feb 26 | Predictive word timing | [doc](2026-02-26-predictive-word-timing.md) |

### March 2026 - Matching Algorithm

| Date | Feature | Document |
|------|---------|----------|
| Mar 2 | Adaptive sync | [doc](2026-03-02-adaptive-sync.md) |
| Mar 2 | Time-gated matching | [doc](2026-03-02-time-gated-matching.md) |
| Mar 3 | Intelligent matching | [doc](2026-03-03-intelligent-matching.md) |
| Mar 3 | Slow song time gate | [doc](2026-03-03-slow-song-time-gate-design.md) |
| Mar 17 | Algorithm improvements | [doc](2026-03-17-algorithm-improvements.md) |

### March 2026 - Telemetry and Tuning

| Date | Feature | Document |
|------|---------|----------|
| Mar 17 | Telemetry system | [doc](2026-03-17-telemetry.md) |
| Mar 17 | Telemetry-driven improvements | [doc](2026-03-17-telemetry-driven-improvements.md) |
| Mar 17 | VAD optimistic scoring | [doc](2026-03-17-vad-optimistic-scoring.md) |
| Mar 17 | VAD analyser LRC offset | [doc](2026-03-17-vad-analyser-lrc-offset.md) |
| Mar 23 | Telemetry-driven tuning | [doc](2026-03-23-telemetry-driven-tuning.md) |

### April 2026 - Hardening

| Date | Feature | Document |
|------|---------|----------|
| Apr 6 | Slow-line VAD and scoring honesty | [doc](2026-04-06-slow-line-vad-scoring-honesty.md) |
| Apr 6 | Whisper fix and observability | [doc](2026-04-06-whisper-fix-observability.md) |
| Apr 8 | Portfolio readiness pass | [doc](2026-04-08-portfolio-readiness.md) |
| Apr 20 | Scoring regression redesign attempt | [doc](2026-04-20-codex-has-been-doing-lucky-coral.md) |
