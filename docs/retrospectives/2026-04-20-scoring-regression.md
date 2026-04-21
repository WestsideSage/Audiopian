# 2026-04-20 Scoring Regression

## Summary

This document consolidates the 2026-04-20 retrospective and session learnings into one record. The session started from a real regression diagnosis, produced some useful low-risk insights, but the main `static/player.js` rollout made the shipped app worse and should be treated as a failed rollout.

Immediate user-visible failures:

- `Let It Fly` visibly lagged and marked correctly sung words red.
- `My Boy` remained unstable on short intro lines.
- After the second implementation pass, line progression itself became inconsistent.

Bottom line:

- restore the raw-line model before further scoring work
- keep future scoring changes narrow and independently validated
- do not tune the grouped-line rollout forward in place

## Hard Facts

### 1. Whisper GPU startup is unavailable on this machine

Observed backend log on fresh launch:

`Whisper: CUDA path failed during load/probe, retrying on CPU: Library cublas64_12.dll is not found or cannot be loaded`

Interpretation:

- the app requests CUDA first
- the Python process cannot load `cublas64_12.dll`
- Whisper falls back to CPU
- this is expected until the CUDA runtime is fixed or the app is forced to CPU

Practical implication:

- do not treat this warning as the primary bug
- do treat CPU mode as a real latency constraint for Whisper
- if GPU is not going to be fixed on this machine, the app should probably default to `WHISPER_DEVICE=cpu`

### 2. Whisper is not a reliable real-time scoring path here

New 2026-04-20 telemetry showed:

- `My Boy`: `41` dispatched, `353` coalesced
- `Let It Fly`: `17` dispatched, `211` coalesced

Whisper finals were still sparse and late:

- `My Boy`: mean gap about `7.7 s`
- `Let It Fly`: mean gap about `12.0 s`

Learning:

- Whisper should remain a late-upgrade or observability layer, not the primary real-time judge
- improving browser SR behavior matters more than trying to make Whisper real-time on this machine

### 3. `Let It Fly` failed mainly because of SR backlog, not line timing alone

Telemetry file:

- `output_telemetry/2026-04-20/karaokee-telemetry-2026-04-20T19-13-42.json`

Observed metrics:

- mean weighted score `0.631`
- pass rate `0.688`
- browser SR final/interim ratio `0.0289`
- early mean `43.7 ms`
- late mean `48.2 ms`

Compared with the 2026-04-18 `Let It Fly` runs:

- weighted score was similar
- pass rate collapsed badly

That means correctly sung words were still being recognized, but too late for the current-line matcher window to recover them. Concrete telemetry examples:

- `"Been arrived, kiss the sky, did the time"` scored `1/8`
- `"You not fuck with me and mine"` scored `1/7`
- `"Free your mind, read your mind, read your mind"` scored `1/9`

Later SR backlog still contained related text like:

- `"what's on your mind"`
- `"blow your mind"`
- `"skip the line"`

The recognizer was not fully deaf. The matcher window was too narrow and too local.

### 4. `My Boy` remained a short-line and intro pathology

Telemetry file:

- `output_telemetry/2026-04-20/karaokee-telemetry-2026-04-20T19-10-10.json`

Compared with the 2026-04-18 baseline:

- weighted score improved from `0.522` to `0.606`
- pass rate improved from `0.341` to `0.598`

But the song still showed:

- giant bogus `earlyMs`
- intro lines and backtracks around the Wale opener
- repeated misses on `"my"`, `"boy"`, `"me"`

The short-line problem was real; the grouped-line solution was not implemented safely.

## What Went Right

### 1. The diagnosis phase was strong

The plan in `docs/plans/2026-04-20-codex-has-been-doing-lucky-coral.md` correctly identified several high-value issues:

- write-once provisional scoring needed overwrite semantics
- browser SR final-rate degradation mattered
- Whisper was too latent and too coalesced to be a real-time scorer
- short LRC lines were a distinct failure case
- telemetry was strong enough to compare sessions concretely

### 2. Some isolated changes were still useful

The following concepts remain valid, even if the full rollout does not:

- overwrite-based slot scoring
- SR lifecycle instrumentation
- continuous tempo helper functions in `static/sync-helpers.js`
- explicit comparable-word policy in `static/match-helpers.js`
- energy summarization for instrumental classification

These should be reconsidered individually, not as part of the failed grouped-line refactor.

## What Went Wrong

### 1. Too much changed at once in `static/player.js`

The high-risk rollout combined:

- overwrite-based slot scoring
- SR instrumentation
- Whisper late-upgrade behavior
- recent-line backlog replay
- short-line grouping
- grouped timing interpolation
- grouped DOM word references
- aggregate score correction
- new HUD and recap behavior

This created a large regression surface with no focused browser smoke test before further iteration.

### 2. The grouped-line implementation introduced a broken state model

The fatal mistake was introducing `activeScoreGroupIdx` and grouped scoring while large parts of the app still assumed a single canonical line identity.

Symptoms:

- raw lyric line index and score-group index diverged
- some render paths used raw lyric lines
- some scoring paths used grouped lines
- some telemetry used raw line indices while transitions used grouped indices
- some late-scoring code still passed raw line indices into grouped timing data

This is why line progression itself stopped behaving consistently.

### 3. Transition-time matching and snapshotting were ordered incorrectly

The outgoing snapshot was cloned before the transition-time final transcript sweep was applied. The snapshot that was actually finalized and scored could therefore be stale even if the live DOM briefly looked better.

### 4. Backlog replay was under-specified

The session correctly identified that SR backlog was hurting `Let It Fly`, but the attempted fix added recent-group replay without fully updating:

- score bookkeeping
- streak bookkeeping
- telemetry consistency
- line-activity semantics
- grouped-line lifecycle rules

The result was more state complexity than validated value.

### 5. Browser smoke testing happened too late

The repo guidance already required manual browser testing for playback, timing, mic, and scoring changes. Automated tests still passed, but they did not validate the actual failure mode the user saw.

## Autopsy Findings From The Failed Rollout

Subagent review and direct inspection found these specific problems in the failed `static/player.js` rollout:

- grouped lines could advance visually while scoring state remained anchored to an older group
- raw lyric-line indices and grouped score indices were mixed in delayed scoring paths
- the outgoing snapshot was created before the final transition-time match pass
- late backlog repairs could still fail because snapshot `lineHadAsrEvent` was stale
- rescoring updated aggregate totals without fully recomputing streak state
- telemetry became harder to interpret because events were logged against raw lines while scoring used groups

These findings are enough to justify reverting the rollout instead of attempting more local fixes.

## What Not To Do Next Time

### 1. Do not mix raw lyric-line identity with score-group identity in the same rollout

If grouping is attempted again, it needs:

- one canonical internal identity
- explicit mapping for render and telemetry
- full migration of delayed scoring, overlap scoring, hot-word logic, telemetry, recap rendering, and end-of-song logic

### 2. Do not stack multiple architectural changes before browser verification

This session combined scoring rewrites, Whisper role changes, tempo helper expansion, backlog replay, grouped scoring, and UI changes before browser validation.

### 3. Do not assume similar weighted score means similar user experience

`Let It Fly` proved that pass rate and visible false-miss behavior can degrade even when weighted score looks roughly similar. Future rollout decisions should prioritize:

- pass rate
- visible miss patterns
- SR backlog behavior
- per-line latency feel

## Safe Salvage Candidates

These can be preserved or reintroduced carefully:

- `app.py` CUDA-to-CPU fallback behavior
- `static/sync-helpers.js` continuous tempo helpers
- `static/match-helpers.js` comparable-word policy helper
- SR counters and observability fields
- energy summarization support

## Recommended Next Approach

1. Restore the last known-good raw-line progression model in `static/player.js`.
2. Keep the scoring model single-indexed while introducing only overwrite-based slot scoring.
3. Add only a bounded elastic transcript search window for SR backlog.
4. Validate in browser with `My Boy` and `Let It Fly`.
5. Only if short lines still require grouping, implement grouping as a separate reviewed design with full call-site migration.

## Suggested Next Investigation

Concrete next questions:

1. How much can `Let It Fly` improve by only widening the browser SR transcript search window under detected backlog?
2. Can backlog repair be limited to the active line plus the immediately previous raw line instead of introducing score groups?
3. What is the minimum safe short-line mitigation for `My Boy` if grouping is avoided?
4. Should this environment default to `WHISPER_DEVICE=cpu` until CUDA is actually repaired?
5. Which metrics should become the decision metrics for future scoring rollouts?

Recommended decision metrics:

- pass rate
- browser SR final/interim ratio
- line-level visible false-miss rate
- early/late timing distribution
- Whisper coalesced/dispatched ratio

## Files And Artifacts

Telemetry:

- `output_telemetry/2026-04-20/karaokee-telemetry-2026-04-20T19-10-10.json`
- `output_telemetry/2026-04-20/karaokee-telemetry-2026-04-20T19-13-42.json`
- `output_telemetry/2026-04-18/Session2/karaokee-telemetry-2026-04-19T05-15-04.json`
- `output_telemetry/2026-04-18/Session2/karaokee-telemetry-2026-04-19T05-30-13.json`
- `output_telemetry/2026-04-18/Session2/karaokee-telemetry-2026-04-19T05-38-27.json`

Planning and review:

- `docs/plans/2026-04-20-codex-has-been-doing-lucky-coral.md`
- this retrospective

## Final Takeaway

The key lesson is not that grouped scoring is impossible. The real lesson is:

- the shipped problem is primarily SR backlog plus short-line handling
- the grouped-line solution was too invasive and broke runtime state consistency
- the next pass should restore a single-index raw-line model and make one narrow improvement at a time
