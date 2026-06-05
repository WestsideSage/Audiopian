# Plans & Specs (May 2026 onward)

This folder holds the design records for Karaokee's **arcade-scoring, realtime-whisper, and scoring-session era** (May–June 2026). Each feature usually comes as a pair:

- a **`specs/*-design.md`** — what we're building and why, and
- a matching **`plans/*.md`** — how, step by step.

Older foundation / matching / telemetry work (Feb–Apr 2026) lives in [`../plans/`](../plans/README.md). The decisions that came out of *this* era are recorded as [ADRs](../adr/).

## Timeline

### May 2026 — the phrase engine
| Feature | Spec | Plan |
|---|---|---|
| Shadow phrase engine | — | [plan](plans/2026-05-01-shadow-phrase-engine.md) |

### June 2026 — scoring v2, arcade, and beyond
| Feature | Spec | Plan |
|---|---|---|
| Scoring v2 (stage 0) | [design](specs/2026-06-02-scoring-v2-design.md) | [plan](plans/2026-06-02-scoring-v2-stage0.md) |
| Arcade scoring & gameplay | [design](specs/2026-06-02-arcade-scoring-gameplay-design.md) | [plan](plans/2026-06-02-arcade-scoring-gameplay.md) |
| Arcade flow & HUD | — | [plan](plans/2026-06-03-arcade-flow-and-hud.md) |
| Telemetry v2 | [design](specs/2026-06-03-telemetry-v2-design.md) | [plan](plans/2026-06-03-telemetry-v2.md) |
| Difficulty grade & preview | [design](specs/2026-06-03-difficulty-grade-and-preview-design.md) | [plan](plans/2026-06-03-difficulty-grade-and-preview.md) |
| Anchor-aware highlighting | [design](specs/2026-06-03-anchor-aware-highlighting-design.md) | [plan](plans/2026-06-03-anchor-aware-highlighting.md) |
| Late-evidence reconciliation | [design](specs/2026-06-04-late-evidence-reconciliation-design.md) | [plan](plans/2026-06-04-late-evidence-reconciliation.md) |
| Scoring-session seam | — | [plan](plans/2026-06-04-scoring-session-seam.md) |
| VAD commit cadence | [design](specs/2026-06-04-vad-commit-cadence-design.md) | [plan](plans/2026-06-04-vad-commit-cadence.md) |
| Anchor selection quality | [design](specs/2026-06-05-anchor-selection-quality-design.md) | [plan](plans/2026-06-05-anchor-selection-quality.md) |

> These are **point-in-time design records**, not living docs — correct as of their date. For how the system works *now*, see [`../architecture.md`](../architecture.md) and the [algorithm docs](../algorithms/).
