# Karaokee scoring & detection redesign — 2026-04-20

## Context

The user played a long session on 2026-04-18. Between the first and second halves, Codex fixed a Whisper loading bug (CUDA→CPU fallback in `app.py`) and added chunk coalescing (`static/player.js` `_queueWhisperChunk`). The user's subjective experience was that scoring got *worse* after the Whisper fix, and they want to push on three fronts simultaneously: **scoring accuracy**, **real-time detection feel**, and **visual clarity** — with the system behaving well across arbitrary song tempos/WPMs, not just pre-bucketed slow/medium/fast.

I ran independent analysis of all 14 telemetry files (7 pre-fix, 7 post-fix). Findings:

- S1 mean weighted score **0.739**, S2 mean **0.608** — a real regression (song mix confounds some but not all of it).
- Whisper contributes only **6.9% of matches, 2% of promotions**. It arrives every ~5.3s for ~1s of audio, and **85% of its chunks are coalesced away**. Whisper is essentially not in the real-time scoring loop.
- **Browser SpeechRecognition `final` events dropped 3.28% → 0.92% of interims** between sessions. The Web Speech API is committing far fewer finals when the AudioWorklet is feeding Whisper. This is the largest likely cause of the score regression.
- Promotions are **first-wins permanent**: 95%+ of `vad-provisional` (score 0.25) matches never get overwritten by a later `exact` (1.0) at the same `(lineIdx, wordIndex)`. This caps scores across the board.
- Line advance fires too early on short lines: S2 `earlyMs` 3–6× larger on fast/medium tempos because the trigger doesn't scale to `expectedTimeMs`.
- Short spoken-intro LRC lines (e.g. Wale — "Right here?", ~270 ms expected) cause `toIdx=-1` backtracks and full score resets.

This plan is a phased redesign. Tier-1 items are high-impact, low-risk, and mostly isolated. Tier-2 contains a Whisper decision gate (user asked for a recommendation + explicit gate). Tier-3 generalizes tempo handling for arbitrary songs. Tier-4 is visual clarity.

## Analysis artifact

Full analysis is captured in this plan (see "Data appendix" at the end). The agent report identified candidate algorithm changes C1–C11 referenced throughout.

---

## Phase 1 — Scoring core fixes (Tier 1)

Three localized changes that address the mechanical causes of low scores. Expected combined uplift: 5–15 pp on mean weighted score.

### C1. Promotion overwrite by confidence

**Problem.** In `static/player.js`, promotions are keyed by `(lineIdx, wordIndex)` and stored in a set that's written-once. 95%+ of `vad-provisional` 0.25 promotions are never upgraded even when a later `exact` 1.0 match lands at the same slot. The locking is visible in the telemetry: 728 S1 and 1084 S2 promotion positions all unique — zero re-evaluations.

**Change.** Replace the write-once set with a `Map<(lineIdx, wordIndex), { score, source, ts, method }>`. On every new match at an already-promoted slot, overwrite iff the new score is higher OR the new source is a stronger one (rank: whisper-final > browser-sr-final > browser-sr-interim > vad-provisional). Commit the final per-slot value when the line transitions (not mid-line — rendering should keep the live view snappy, but the scoring denominator sees only the max).

**Files.** `static/player.js` — promotion logic (search for `promotions`, `_scoreLine`, `_matchPrevLine` around 937–1520). Keep the existing promotion event list for telemetry, but stop using it as the commit store.

**Invariant.** Score monotonically increases within a line's live window. A word's final score is `max(confidence across all matches for that slot)`.

### C2. Duration-proportional advance threshold

**Problem.** `_scoreLine` / line-advance in `player.js` fires `trigger='score'` when positive evidence crosses a fixed threshold. Telemetry shows this trigger firing **early by 103–203 ms** on S2 fast/medium lines, which is 7–10% of a 2.5-s rap line vs <1% of a 5-s ballad line. Short lines get truncated before strong matches can commit.

**Change.** Gate the advance trigger on a minimum dwell time tied to `expectedTimeMs`. Proposed rule: the earliest the trigger may fire is `start + max(minDwellMs, 0.7 × expectedTimeMs)` where `minDwellMs` is a small floor (e.g. 400 ms). If the weighted-matched ratio already exceeds a high bar (e.g. 0.9), allow slightly earlier — but never before `0.5 × expectedTimeMs`.

**Files.** `static/player.js` — line transition logic; `static/sync-helpers.js` — expose a new `getMinLineDwellMs(expectedTimeMs, tempo)` helper so it's unit-testable from `tests/test_sync_helpers.cjs`.

### C3. Instrumental / zero-evidence transition handling

**Problem.** S2 had 13 `totalComparisons==0 && matchedWords==0` transitions scoring 0/N — typically instrumental bars or breakdown lines. These drag the mean.

**Change.** When a line closes with `totalComparisons == 0` **and** mic energy during the line's span was below a silence floor, mark the line `instrumental` and exclude from the score denominator (also surface in telemetry as a new transition type). Use the existing mic-energy signal from `static/audio-processor.js` (already emits RMS energy for VAD).

**Files.** `static/player.js` — transition recorder; `static/audio-processor.js` — expose per-line energy summary.

### Phase 1 verification

- Replay the 4/18 Session 2 Wale file against the new scorer offline (via a Node harness that takes `matches[]` + `asr[]` and recomputes the scoreboard). Expect the Wale pass-rate to move from 34% toward the S2 average (~80%).
- Run `tests/test_sync_helpers.cjs` with new `getMinLineDwellMs` tests.
- Run `tests/test_match_helpers.cjs` — should be unaffected.
- End-to-end: play one rap song (Wale/Lil Wayne) and one ballad (Linkin Park Breaking the Habit) and compare mean scores to a baseline captured first.

---

## Phase 2 — Browser SR regression + Whisper decision gate (Tier 2)

This is where the biggest unknown — and biggest potential win — lives.

### C4. Diagnose and fix browser SpeechRecognition final-rate regression

**Problem.** `final` events per `interim` dropped 3.28% → 0.92% between sessions. Fewer finals means the scorer relies more on un-committed interim text, interacting badly with first-wins promotions (resolved by C1 but still suboptimal). The regression correlates with Whisper's AudioWorklet pipeline being active.

**Hypotheses to test, cheapest first:**

1. `SpeechRecognition` and Whisper share the same `MediaStream` / mic track, and the AudioWorklet tap changes the commit cadence. Fix: request two independent `getUserMedia` streams.
2. `continuous`/`interimResults` flags on `webkitSpeechRecognition` were implicitly changed when the AudioWorklet was added. Fix: re-verify flags are `continuous=true, interimResults=true` and that `onresult` isn't accidentally filtering finals.
3. `SpeechRecognition` has a "no-speech" or "silence" timeout that now triggers because Whisper's buffer drain introduces a gap. Fix: restart recognition on `end` rather than waiting.

**Files.** `static/player.js` — search for `SpeechRecognition`, `onresult`, `getUserMedia`. Add telemetry: log SR `onend`/`onerror`/`onnomatch` events per file.

**Instrumentation first.** Before changing code, add to telemetry: `{ srStarts, srEnds, srErrors, srNoSpeechTimeouts }`. Capture one session with this instrumentation, then decide the fix based on which counter spikes.

### C5 (recommended). Whisper as late-upgrade layer — decision gate

**The question.** Whisper currently contributes ~2% of promotions and eats 85% of its own chunks. Options:

- **Recommended: C5.** Strip Whisper from real-time scoring. Keep the dispatcher, but use whisper-final results *only* to retroactively upgrade provisional promotions within the line's live window (works cleanly with C1). Coalescing becomes irrelevant because Whisper isn't on the critical path. Simpler architecture, matches what the data supports.
- **Alternative A: Fix coalesce + chunking.** Reduce the coalesce threshold, shorten chunks to ~1 s, allow 2 in-flight. Higher complexity; still fighting Whisper's inherent latency.
- **Alternative B: Disable Whisper entirely for now.** Since S1 (no Whisper) scored higher than S2, turn off the dispatcher until the scoring base is solid. Re-introduce once C1–C3 lock in gains.

**Recommendation: C5.** Reason: C1 specifically enables late-upgrades from higher-confidence sources, and Whisper is a strong late source for function words the browser mis-transcribes. Discarding Whisper loses that signal; fixing its real-time path is higher-effort than gating it to a late-upgrade role.

**Decision gate.** User reviews this plan and chooses C5 / A / B before Phase 2 implementation begins. If C5 or A, also proceed with C4. If B, C4 still runs because the SR regression may be independent of Whisper.

**Files if C5:** `static/player.js` — `_queueWhisperChunk`, `_sendChunkToWhisper` (dispatcher stays); add a retroactive-upgrade path that calls the same per-slot max-score Map from C1 using whisper finals as input. `app.py` `/transcribe` unchanged.

### Phase 2 verification

- With C4 instrumentation shipped, capture a single-song session and inspect SR counter distribution before picking a fix.
- After C4 fix, measure `final/interim` ratio — expect recovery toward ≥3% (the S1 baseline).
- With C5 wired, replay Session 2 telemetry offline: count how many `vad-provisional` slots that got frozen at 0.25 would have been upgraded by a later whisper final. Target: at least half of S2's 2375 frozen provisionals get a real upgrade.

---

## Phase 3 — Dynamic tempo and short-line robustness (Tier 3)

### C6. Continuous tempo scaling

**Problem.** `static/sync-helpers.js` `classifyTempo()` maps words-per-second to three discrete buckets. Songs near bucket boundaries get abrupt parameter changes, and arbitrary-WPM songs (user's stated concern about variety) all get coerced into one of three behaviors.

**Change.** Replace discrete `classifyTempo(wps)` with a continuous feature vector: `{ windowMs, overlapMs, scoreDelayMs, chunkSamples }` computed as smooth functions of `wps`. Keep `classifyTempo()` as a thin back-compat wrapper that maps wps→label for telemetry only. Use the continuous values everywhere the helpers are consumed in `player.js`.

**Interpolation shape.** Start with piecewise-linear between the three existing anchor points (current slow/medium/fast), then tune. Keep functions pure so `tests/test_sync_helpers.cjs` covers them.

**Files.** `static/sync-helpers.js` — `classifyTempo`, `getWindowParams`, `getAdjustedOverlapDuration`, `getScoreDelay`, `getChunkSamples`; add continuous counterparts. Update `tests/test_sync_helpers.cjs`.

### C7. Short-line merging

**Problem.** Wale's "Right here?" / "My boy" / "Count me in, Cole" intro (2-word lines, 270–700 ms expected) caused `toIdx=-1` backtracks and full promotion resets. Current transition logic assumes each LRC line can sustain a normal scoring window.

**Change.** At load time, post-process `lrcLines` (returned from `/load` in `app.py`): merge consecutive lines whose combined `expectedTimeMs` is below a short-line floor (e.g. ~900 ms) into a single composite line for scoring purposes, while keeping visual rendering of each line intact.

**Files.** `static/player.js` — the LRC load handler. Add a `_composeShortLines()` pass that emits `lines[] → scoredGroups[]`. The render path reads `lines[]`, the scorer reads `scoredGroups[]`.

### C8. Symmetric filler handling

**Problem.** Top missed words in S2 are stopwords (`my`, `the`, `a`, `to`, `and`, `i`). `static/match-helpers.js` has filler-skip logic that skips function words on one side; the other side still penalizes.

**Change.** Audit `skipFuzzyMatch`, `classifyWord`, and the filler-skipping callsites in `player.js`. Either skip on both lyric side and user side, or score on both. My recommendation: **score on both sides but weight function words at 0.5** (already the intent of `classifyWord`'s "function" tier). Ensure misses of function words count at 0.5 × miss, not 1.0 × miss.

**Files.** `static/match-helpers.js`, `static/player.js`.

### Phase 3 verification

- Add a Node test that feeds synthetic (wps, expectedMs) inputs through the continuous tempo functions and asserts monotonic behavior at bucket boundaries.
- Replay Wale telemetry with short-line merging: expect the `toIdx=-1` backtracks to disappear and the intro pass-rate to rise.
- Run `tests/test_match_helpers.cjs` — extend with filler-symmetry cases.

---

## Phase 4 — Visual clarity (Tier 4)

The telemetry doesn't directly inform these — they're user-experience improvements.

### C9. Confidence-tier word coloring

Three-tier rendering of each word as the line plays:
- **Gray** — no attempt detected yet
- **Amber** — provisional match (score 0.25–0.5)
- **Green** — committed match (score ≥ 0.75)

Today's rendering collapses provisional and committed into the same amber/green and doesn't clearly signal "we're still listening."

**Files.** `static/player.js` render path; CSS in `static/styles.css` (or inline).

### C10. Live tempo/window indicator

Small HUD element showing:
- Tempo label (slow/medium/fast) — cosmetic, drawn from the back-compat wrapper in C6.
- A subtle bar showing the current scoring window for the active line (start-window → now → end-window), so the player can see when the game is "listening."

Goal: reduce confusion about why a word wasn't counted — "oh, it was still listening."

**Files.** `static/player.html`, `static/player.js`.

### C11. Post-line recap micro-interaction

When a line transitions, briefly flash per-word outcomes (hit / partial / miss) for ~250 ms before the next line fills. Uses the final per-slot scores from C1's commit.

**Files.** `static/player.js`, CSS.

### Phase 4 verification

- Play through one full song and screen-record it. Sanity-check by watching the playback.
- No unit tests — this is UI behavior; verify visually.

---

## Dependencies and sequencing

- **C1 must land before C5** (late-upgrade needs overwrite semantics).
- **C4 instrumentation must land before C4 fix** (we need data to pick the right hypothesis).
- **C6 should land before C2's tuning** is finalized (continuous tempo affects what "expected duration" means on edge songs).
- **C9 should land after C1** (clean tiering depends on max-per-slot commits).

## Critical files (reference, not exhaustive)

- `static/player.js` — core karaoke controller; `_matchPrevLine`, `_matchTranscript`, `_matchHotWord`, `_scoreLine` (lines ~937–1520); promotion Map; SpeechRecognition wiring; `_queueWhisperChunk`, `_sendChunkToWhisper`; render path.
- `static/sync-helpers.js` — `classifyTempo`, `getWindowParams`, `getAdjustedOverlapDuration`, `getScoreDelay`, `getChunkSamples`, `computeSongTempoProfile`, `classifyLineTempoRelative` (lines 11–127). Pure, testable in Node.
- `static/match-helpers.js` — `classifyWord`, `skipFuzzyMatch`, `maxEditDistance`, `phraseMatch`, `slangMatch` (lines 128–360). Pure, testable.
- `static/audio-processor.js` — AudioWorklet for mic chunks and RMS energy. Source of instrumental-line VAD signal (C3).
- `app.py` — `/load`, `/transcribe`, Whisper lifecycle. Largely untouched in this plan; LRC pass-through may gain a short-line metadata tag (C7).
- `tests/test_sync_helpers.cjs`, `tests/test_match_helpers.cjs`, `tests/test_telemetry.cjs` — extend coverage as each phase lands.

## End-to-end verification

Before declaring any phase done, re-play at least one rap song (Lil Wayne or Wale) and one melodic song (Linkin Park or Kendrick melody), comparing to a captured baseline telemetry file. Track:

- Mean `weightedMatched/weightedTotal` over `trigger=='score'` transitions.
- Pass-rate (% lines with `matchedWords >= 0.7 * totalWords`).
- `earlyMs`/`lateMs` distributions by tempo.
- Whisper coalesce ratio and contribution share (C5 target: drop coalesce to near-zero, or decouple from real-time path).
- Browser SR `final/interim` ratio (C4 target: ≥3%).
- Visual sanity of C9–C11.

Save telemetry outputs to `output_telemetry/YYYY-MM-DD/` as usual; no schema changes needed (new fields are additive).

## Open questions the plan does not resolve

1. **What does `matched=true` universally mean in `matches[]`?** 100% of logged matches are `matched=true`, which means the rejection tail is invisible. Adding a `rejected` log in a future instrumentation pass would sharpen all of C1/C2/C8.
2. **Are any of the 13 `cmp=0` S2 transitions genuinely sung-but-missed rather than instrumental?** C3's silence-floor gate handles the instrumental case; if this class turns out to be "user sang but ASR heard nothing" the fix is different (mic gain / VAD sensitivity).
3. **Does the browser-SR regression survive across browsers/OSes?** The session is Chrome on Windows; Firefox/Safari may behave differently.

## Data appendix (condensed)

| Metric | S1 (Whisper dead) | S2 (Whisper alive) |
|---|---|---|
| Mean weighted score | **0.739** | **0.608** |
| Pass rate (≥0.7 matched) | 98.1% | 81.8% |
| Browser SR final/interim | 3.28% | **0.92%** |
| Whisper match share | 0% | 6.9% |
| Whisper promotion share | 0% | 2.0% |
| Whisper coalesce ratio | n/a | **84.9%** |
| `vad-provisional` share of matches | 69.8% | 67.5% |
| Frozen provisionals (no later upgrade) | 95.8% | 95.1% |
| Slow `earlyMs` mean | 41 | **185** |
| Medium `earlyMs` mean | 33 | **203** |
| Fast `earlyMs` mean | 32 | **103** |

Top S2 missed words: `my`(36), `boy`(28), `me`(18), `to`(14), `the`(13), `a`(13), `it`(12), `and`(11), `i`(9).

Wale "My Boy" anomaly: 126 transitions, pass-rate 34.1%, 470 match entries but 0 promotions. 2-word spoken-intro lines triggered `toIdx=-1` backtracks and score resets — the motivating case for C7.
