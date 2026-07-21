# Phoneme-Lattice Corpus Replay

**Date:** 2026-07-20  
**Scope:** preregistered adversarial-review gate for the phoneme-lattice fallback

## Method

The replay read the latest debug-on telemetry captures named by the adversarial
review. Each trace was joined to its original phrase-plan anchors. Existing consumed
anchor names were excluded, the capture clock was reconciled from transition time
minus phrase end time, and ASR windows were limited to the phrase through four
seconds after its end (the production lattice horizon). The aligner then evaluated
only the remaining anchors.

This is a recovery-opportunity scan, not sung-word ground truth. Human sing-testing
still owns the final fairness judgment.

## Results

| Capture | Eligible incomplete phrases | Lattice anchors recovered | Phrases reaching clear |
|---|---:|---:|---:|
| Comethazine — Bands, 2026-07-20 22:15 | 5 | 1 | 1 |
| Ces Cru — Klick Clack Bang, 2026-06-29 20:39 | 38 | 14 | 7 |
| Nas — Who Killed It?, 2026-05-01 20:58 | 61 | 246 | 49 |
| The Roots — Here I Come, 2026-06-29 20:44 | 47 | 9 | 8 |

The old Nas capture predates anchor detail in traces, so its existing hit count and
plan anchors were reconciled by phrase ID; its large recovery count is directional
evidence, not a trustworthy accuracy estimate.

Representative recovered ASR drift included `rocket` from `pocket`, `ripple up`
from `you pull up`, `microphone cord` from `microphone core`, and `yawnin` from
`joining`.

## Cheese gates

Automated phrase-engine scenarios remained at zero new lattice clears:

- silent target line followed by a matching burst while the VAD sensor is alive;
- in-window hum followed by a matching burst outside the four-second lattice
  horizon;
- one aligned token span offered to two eligible phrases (consumed once only).

Pure golden cases also reject a single matching word inside an unrelated line and
the historical Nas cold-start garbage window `look here see` vs `putting Mike ...`.
