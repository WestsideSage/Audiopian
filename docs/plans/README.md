# Design & Implementation Documents

This directory contains paired design specs and implementation plans for each major feature iteration. They show how the project evolved from a basic karaoke player to a sophisticated real-time scoring engine, with each iteration informed by telemetry data from real gameplay sessions.

## Timeline

### February 2026 — Foundation

| Date | Feature | Design | Implementation |
|------|---------|--------|----------------|
| Feb 19 | V2 rewrite | [design](2026-02-19-karaokee-v2-design.md) | [impl](2026-02-19-karaokee-v2-implementation.md) |
| Feb 25 | UX improvements | [design](2026-02-25-karaokee-improvements-design.md) | [impl](2026-02-25-karaokee-improvements.md) |
| Feb 25 | Loading timer & lyric lag | [design](2026-02-25-loading-timer-and-lyric-lag-design.md) | [impl](2026-02-25-loading-timer-and-lyric-lag.md) |
| Feb 25 | Lyrics game mode | [design](2026-02-25-lyrics-game-design.md) | [impl](2026-02-25-lyrics-game-mode.md) |
| Feb 26 | Lyrics detection improvements | [design](2026-02-26-lyrics-detection-improvements-design.md) | [impl](2026-02-26-lyrics-detection-improvements.md) |
| Feb 26 | Predictive word timing | [design](2026-02-26-predictive-word-timing-design.md) | [impl](2026-02-26-predictive-word-timing-implementation.md) |

### March 2026 — Matching Algorithm

| Date | Feature | Design | Implementation |
|------|---------|--------|----------------|
| Mar 2 | Adaptive sync | [design](2026-03-02-adaptive-sync-design.md) | [impl](2026-03-02-adaptive-sync-implementation.md) |
| Mar 2 | Time-gated matching | [design](2026-03-02-time-gated-matching-design.md) | [impl](2026-03-02-time-gated-matching-implementation.md) |
| Mar 3 | Intelligent matching | [design](2026-03-03-intelligent-matching-design.md) | [impl](2026-03-03-intelligent-matching-implementation.md) |
| Mar 3 | Slow song time gate | [design](2026-03-03-slow-song-time-gate-design.md) | — |
| Mar 17 | Algorithm improvements | [design](2026-03-17-algorithm-improvements-design.md) | [impl](2026-03-17-algorithm-improvements-implementation.md) |

### March 2026 — Telemetry & Tuning

| Date | Feature | Design | Implementation |
|------|---------|--------|----------------|
| Mar 17 | Telemetry system | [design](2026-03-17-telemetry-design.md) | [impl](2026-03-17-telemetry-implementation.md) |
| Mar 17 | Telemetry-driven improvements | [design](2026-03-17-telemetry-driven-improvements-design.md) | [impl](2026-03-17-telemetry-driven-improvements.md) |
| Mar 17 | VAD optimistic scoring | [design](2026-03-17-vad-optimistic-scoring-design.md) | [impl](2026-03-17-vad-optimistic-scoring-implementation.md) |
| Mar 23 | Telemetry-driven tuning | [design](2026-03-23-telemetry-driven-tuning-design.md) | [impl](2026-03-23-telemetry-driven-tuning-implementation.md) |

### April 2026 — Hardening

| Date | Feature | Design | Implementation |
|------|---------|--------|----------------|
| Apr 6 | Slow-line VAD + scoring honesty | [design](2026-04-06-slow-line-vad-scoring-honesty-design.md) | [impl](2026-04-06-slow-line-vad-scoring-honesty.md) |
| Apr 6 | Whisper fix + observability | [design](2026-04-06-whisper-fix-observability-design.md) | [impl](2026-04-06-whisper-fix-observability.md) |
| Apr 8 | Portfolio readiness pass | [design](2026-04-08-portfolio-readiness-design.md) | [impl](2026-04-08-portfolio-readiness-implementation.md) |
