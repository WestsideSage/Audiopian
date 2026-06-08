# Benchmark batch analysis — free vs premium (2026-06-08)

Source: `output_telemetry/2026-06-08/actual 6-8/` (9 files = 4 songs × {free, premium} + 1 duplicate premium THIB).
Analysis scripts: `temp/tele_probe.py`, `temp/tele_match.cjs` (real-matcher diagnosis), `temp/tele_whisper_unique.cjs`.
All runs: **expert difficulty, dense rap.** Free = browser Web Speech; Premium = browser SR + gpt-realtime-whisper (default `delay`).

## Headline matrix

| Song (len) | Free honest/grade | Premium honest/grade | whisper-unique clears (lower bound) |
|---|---|---|---|
| Kendrick — euphoria (6:24) | 93 / **A** | 96 / **S** | 27/137 = **20%** |
| Lupe — WAV Files (6:39) | 93 / **A** | 96 / **S** | 19/137 = **14%** |
| Isaiah — THIB (2:35) | 95 / **A** | 99 / **S** | 2–5/38 = 5–13% |
| Jay Prince — FLOW (2:42) | 97 / **S** | 98 / **S** | 4/46 = 9% |

Premium flips the grade **A→S on 3 of 4** songs on (different) takes of the same songs. The duplicate premium THIB (99/99, S/S) is the only within-cell variance point.

## Findings (evidence-backed)

1. **The matcher is healthy — almost nothing is left on the table by our code.** Classifying every uncredited anchor on non-cleared free lines with the *real* engine (`scoring.js`: exact/contraction/SLANG/phonetic/edit): only ≤10 lines across all 4 free runs combined would clear even if every locally-heard-but-uncredited anchor were credited (optimistic upper bound; loose window). Do **not** invest in matcher tweaks for this regime.

2. **The free-lane gap is a browser-SR recall ceiling, not a bug.** Of free uncredited anchors, **56% / 71% / 76% / 29%** are matchable *nowhere* in the entire recognized transcript — the recognizer never returned the word in any form the matcher accepts. They are rare/dense words & proper nouns: *distasteful, homeboys, brigantine, imbibe, levitate, locker, williamsbury, baratoga*. (The real matcher *did* recover a chunk the naive proxy missed via SLANG/phonetic — e.g. euphoria never-heard 64%→56% — confirming the slang/profanity recovery path works.)

3. **Premium is near its own recognizer ceiling.** Premium's residual misses are matchable-nowhere even with whisper (57–100% of its few misses): *habitual, brigantine, williamsbury, elisee, marquis*. Whisper's clean unique contribution is **~5–20% of clears** (lower bound), scaling with density. The earlier within-take "39–69%" figure is **discarded** — it's biased up by a token-race confound (once whisper credits an anchor, `candidateFor`/`reconcile` reject the later browser token as `already_consumed`, so "browser didn't credit" ≠ "browser couldn't").

4. **Timing is a non-issue on both lanes.** Median line drift ~21–37 ms, early/late symmetric (~50/50). The phrase engine's latency absorption works — premium drift is *not* worse than free despite recognizer lag.

5. **No cheese anywhere** (`suspectedCheeseInflation=false` on all 9); max multiplier reached on the long songs (real engagement). **Premium realtime healthy**: commits == completions, 0 failures. **Neural VAD active on all runs, no init errors.**

## Critical caveats (scope)

- **n=1 per cell**, and free vs premium are *different performances* — cross-take deltas are suggestive, **not proven**. Replication (≥3 takes/cell) is the next batch.
- **This is a worst-case pilot, not the mass-test**: all cells are dense rap @ expert (0.80 anchor ratio). "Free is recall-limited" holds *here* and will likely **not** generalize to melodic/sparse songs @ easy/medium (0.20–0.45 ratio — the recall ceiling barely binds).

## What to do with it

- **Free lane — one experiment worth running:** the misses are "not in the top transcript," which is exactly what `maxAlternatives` (alt[1]/[2], currently computed and discarded) might contain. Instrument alt[0..2] logging, re-run `tele_match.cjs` against the union. Expect *modest* recovery (alternatives are often near-duplicates) — but it's the only untested free-lane lever and the data motivates it.
- **Premium:** near ceiling; residual is proper nouns even whisper misses. A vocabulary prompt could help but needs `gpt-4o-transcribe` (prompt unsupported on `gpt-realtime-whisper`). Low priority.
- **`delay` knob:** untested (no variation in this batch); premium already wins at default delay → low urgency. A/B it next batch if snappier highlighting is wanted.
- **Product/fairness question now backed by data:** on dense/expert, free is recall-capped near **A** while premium reaches **S** on the same singing. Intended tiering, or should the free grade curve offset its recall ceiling? Design decision.

## Amber root-cause (follow-up: "clearly-sung words marked amber")

Amber (`.matched-partial`) = VAD detected voice at the word, but ASR never returned a matching token — "heard you, couldn't read the word." Splitting every un-hit anchor on non-cleared free lines by *what browser_sr emitted there* (`temp/tele_substitution.cjs`, real matcher):

| Song | safe-recoverable (real phonetic/affix near-miss, gate rejects) | short-word coincidence (credit = cheese) | unrelated / not recognized |
|---|---|---|---|
| euphoria | **2 (3%)** | 18 (24%) | 44 (59%) |
| FLOW | 0 | 1 | 5 |
| WAV Files | 0 | 7 | 36 |
| THIB | 0 | 0 | 6 |

**Verdict:** the honesty-safe recoverable pool is ~2 anchors across all 4 songs (`distasteful→tasteful`, `mustve→must`). The matcher gate cannot be safely loosened to catch the rest — the "near" tokens are trivially-close short words (`type~the`, `just~us`) or genuinely unrelated. Confirms the user's symptom (recognizer fumbles clear singing) but **not** a matcher lever. The principled recovery is to widen the recognizer's *output* (`maxAlternatives` — alt[1]/[2] may hold the real word where alt[0] was wrong), not loosen the *gate*; or to fix the *input* (capture chain / premium). The structural answer is the orthogonal **pitch axis (Path B)** — it rewards clear singing regardless of whether ASR read the word.

## Next-batch spec (turn the pilot into the real test)

1. Add **melodic/sparse** songs and **easy/medium** difficulties (test whether free-is-recall-limited generalizes).
2. **≥3 takes per cell** for a variance band.
3. Keep **D on**; tag each run via the benchmark-intent field with lane + config.
4. If testing alternatives/`delay`: make them switchable and bank a baseline first (push-to-main auto-deploys).
