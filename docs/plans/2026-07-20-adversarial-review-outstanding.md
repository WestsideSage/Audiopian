# Adversarial Review — Outstanding Items (handoff)

**Date:** 2026-07-20 · **Author:** Claude (Fable) adversarial review session · **For:** Codex (or any implementing agent)

Context: a full adversarial review of the scoring/matching algorithms was run against real telemetry
(170-run historical corpus + same-day validation sing-tests). Ten fixes already landed and were
sing-validated (Throwdown 80%→97%/S, Bands 92→93 with every fused line crediting). This document is
the remaining backlog, ranked. Everything here assumes the repo conventions in CLAUDE.md: TDD
(red→green), pure UMD helper modules with `.cjs` tests, don't grow `player.js` when a helper will do.

**Working-tree state at handoff:** the review fixes are UNCOMMITTED and share the tree with an
unrelated in-progress UX changeset (`static/stage-helpers.js`, edits to `index.html`, `player.html`,
`player.js`, `style.css` predating the review). Commit them as separate changesets before starting.
Baseline that must stay green: **37 JS test files + 59 Python tests**.

---

## Already done — do NOT redo

| Fix | Where |
|---|---|
| Fused repeat anchors match their unit (`dance-dance-dance` class), method `repeat` @0.9 | `match-helpers.js repeatedUnit`, `scoring.js` |
| Finals/whisper reconcile flow-gated (silent-skip cheese closed) | `scoring-session.js addPhraseEvidence` |
| Sensor-health fail-open (dead VAD ≠ zeroed run) + HUD "Mic issue" chip | `phrase-engine.js _vadFlowSeen`, `vad-health-helpers.js`, `player.js _updateVadHealth` |
| Manual stop force-settles ended phrases (last line commits) | `scoring-session.js endRun` |
| Interim reconcile monotonic lookback capped at 8s (fixed hook starvation AND steals) | `phrase-engine.js RECONCILE_INTERIM_LOOKBACK_SEC` |
| Affix: suffix ≥6 chars, score 0.8 | `scoring.js isSubstantialAffix` |
| Silence composite 25→0; onset-based flowStatus; lateCredit telemetry | `phrase-engine.js`, `telemetry-helpers.js` |

---

## 1. Late-rescue arcade upgrade — top game-feel item (M)

**Evidence:** validated Bands run (`output_telemetry/2026-07-20/karaokee-telemetry-2026-07-20T22-15-04.json`):
line 14 committed arcade MISS at settle, later upgraded to 1/3 partial; line 32 committed MISS at
settle (0/1), later **confirmed 1/1**. Both streak resets were wrong per the engine's own final
judgment. Recognizer lag makes this structural: arcade commits at settle (endSec+900ms), late
evidence keeps landing for seconds after.

**Build:** when a committed phrase's `anchorHits` later improve enough to change its outcome
(miss→partial, miss/partial→clear) within a bounded window (suggest ≤4s after settle), emit a
`LATE RESCUE` arcade event: restore the streak (recompute as if the correct outcome had been
committed), award the points delta, and give it a celebratory HUD treatment (this converts a
felt-bad moment into a feel-good one). Alternative simpler design (choose one, don't build both):
defer the commit by one settlement period when a phrase settles with in-window flow but 0 hits —
the "recognizer still owes us" case.

**Where:** `scoring-arcade.js` needs an upgrade API (commitPhrase is commit-once by design — add
`upgradePhrase(state, phraseId, newCounts)` that recomputes points/streak/multiplier deltas);
`scoring-session.js` tick detects post-commit hit-count changes; `player.js _renderEvents` renders
the event; record upgrades in the telemetry `arcade.events`.

**Validate:** TDD in `test_scoring_arcade.cjs` + `test_scoring_session.cjs`; replay the Bands 22:15
file — lines 14/32 must produce rescue events; hi-score integrity (final points must equal what a
correct-at-settle commit sequence would have produced, or document the delta rule).

## 2. Phoneme-lattice matcher — the remaining honest-miss class (L, own branch + spec first)

**Evidence:** after the landed fixes, essentially every remaining sung-but-uncredited line is a
recognizer *word-segmentation* error, unreachable by per-word matching: "choppa let it eat" →
"chocolate lady", "watch me do my" → "want me to my", "I skrrt" → "Oscar", "shiny gold" → "shiny
goat". The stuck songs: Bands 22:15 remaining partials, Klick Clack 83%, Nas — Who Killed It 84%,
Roots 68%.

**Build:** a pure `lattice-align.js`: (a) `doubleMetaphoneFull` variant (do NOT change the existing
4-char-truncated `doubleMetaphone` — other behavior depends on it); (b) Smith-Waterman local
alignment over the phoneme strings of (lyric line) vs (ASR window text), substitution costs cheap
within phoneme classes (T/D, P/B, S/X…); (c) credit an unhit anchor iff the whole-line alignment
clears a floor AND the anchor's own span aligns above a per-word threshold — the line-level floor is
the honesty guard (one word can't ride a garbage alignment). Method `'lattice'`, score ~0.85,
consume the underlying evidence tokens whose spans aligned. Plug in at settle/reconcile for phrases
with unhit anchors only; keep it behind the same flow gate. Cost is trivial (~40×200 DP cells/line).

**Validate (pre-registered, non-negotiable):** replay the historical corpus (`output_telemetry/`,
debug-on runs have full `asr` arrays) — criteria: recovers lines on the four stuck songs above;
**zero new clears** on silent/cheese scenarios (build them like the review harness: lines with no
flow + a later burst; and hum+burst). If a cheese scenario gains a clear, tighten the floor, don't
ship. This retires the curation treadmill (compound bridge, `ASR_MISHEARINGS`, half the homophone
list stay as fast paths; lattice is the general fallback).

## 3. Cheese-protocol tagging + actually running it (S code, then a human sings)

**Evidence:** `telemetry-helpers.js CHEESE_INTENTS` (`humming_cheese`, `silent_section_test`) and
`suspectedCheeseInflation` have existed for months; `benchmarkIntent` is hardcoded `''` at
`player.js` (~line 1522) — **zero tagged runs in 170**. The ungated-finals hole would have been
caught months earlier by one scripted cheese run.

**Build:** a way to tag the next run's intent — simplest: a debug-panel selector (press `D`) or a
`localStorage['karaokee_benchmark_intent']` read at `_finalizeTelemetry`; add `ui_test` and
`good_expert_run` to the label set; make analysis scripts skip `ui_test` runs (~30 of the 170 are
untagged UI-test noise, all "Special Ed — I Got It Made" 0% runs). Then make a cheese run part of
the pre-merge ritual for any scoring change (human required — the code just enables it).

**Known residual to probe with it:** the live path credits tokens arriving ≤ settlement+grace
(~1.9s) after a line ends without a flow check — deliberately left open (gating it risks quiet-mic
recall). Decide with cheese-run data, not by feel.

## 4. Provider-aware fast-easing (S–M, replay-gated)

**Evidence:** `buildPhrasePlan`'s fast-line easing (floor 1 recognized anchor, `FAST_RECOGNIZED_FLOOR`)
was calibrated for browser-SR dropout. The user's own 06-08 A/B pairs show the realtime provider
doesn't need it (rt ≥ bsr by +3..+9, partials collapse: THIB 7→1, WAV 20→13). On expert, 7/40 Bands
lines required 1 anchor of 2–4; insane shares the same floor.

**Build:** pass the active provider (or a recognizer-health profile) into `buildPhrasePlan` options;
under `openai_realtime`, floor 2 when anchors ≥4 on expert/insane. **Hard constraint:** replay the
Roots run (`output_telemetry/2026-06-29/...20-44-*.json`, browser SR, dense rap) — it must NOT
regress; that run is why the easing exists (`7241882` was validated on it). The fancier version
(ease from measured recognized-vs-VAD-voiced ratio in a trailing window) feeds the performance-axis
plan — fine to spec, don't block on it.

## 5. Hyphen tokenization — the remaining fusion class (M, display-mapping care)

**Evidence:** `normalizeWord` strips `-` to empty. The repeated-unit collapse fixed pure repeats,
but non-repeat fusions remain: `wife-uh`→`wifeuh` (ZIPPER, unhittable), and the related
split-compound class: lyric `alright` sung "all right" scores 0 in the anchor path (compound bridge
requires ≥0.9; the merge scores 0.8 phonetic) while the paint path credits it via `phraseMatch` —
display/score divergence.

**Build options (pick one):** (a) treat `[-–—/]` as separators at tokenization
(`scoring.js normalizeWords` + `phrase-engine.js splitLyricWordsWithParens`) — the right long-term
fix, BUT scoring word counts then diverge from display spans (display splits on whitespace): the
`wordIdx`↔span mapping in `lyric-paint-helpers.js` / `player.js` must be handled, and the
`uhoh`/`uhhuh` ADLIB_WORDS workarounds become obsolete; or (b) narrower: port multi-word equivalence
(`match-helpers.js phraseMatch` / PHRASE_EQUIV_MAP) into `phrase-engine.js anchorMatchResult` so
"all right"→`alright` credits via the anchor path too. (b) is smaller and kills the known divergence;
(a) subsumes it. Note the lattice matcher (#2) also largely subsumes this class — if #2 ships first,
re-evaluate whether this is still needed.

## 6. Unify the paint/score matching stacks (L, architectural)

**Evidence:** two matchers disagree: the word-paint path (`scoring-session.js collectMatches`,
with `phraseMatch`/`multiWordContractionMatch`/FILLER skipping) vs the anchor path
(`phrase-engine.js`). Proven divergence ('alright'); also `matches[]` telemetry logs the PAINT
stack, so telemetry analysis of "matches" analyzes the stack that doesn't score. This class of bug
regenerates until the phrase engine is the single matcher and paint derives from anchor hits +
lenient non-anchor matches. Fits the pending architecture-sprint items (#2 transcription-source
seam, #4 app.py providers). Big; do after #1–#4.

## 7. Small cleanups (S, one commit)

- Dead `anchor.fillerOnly` guards in `phrase-engine.js` (`candidateFor`, reconcile) — the
  filler-fallback anchors were removed in `4b0f24f`; nothing sets `fillerOnly`.
- `minFlowCoverage` in every DIFFICULTY profile is never read — delete or implement (it's also in
  the plan JSON telemetry consumers see; removal is a schema note).
- Vestigial `transitions[].weightedMatched` / `totalComparisons` (always 0).
- Split the `already_consumed` rejection reason into `token_consumed` vs `anchor_already_hit`
  (`phrase-engine.js candidateFor`) — it conflates two causes and cost real diagnosis time.

## 8. Decided-against / deferred with reasons — don't implement without new evidence

- **Edit1 on 3-letter words** ("nice"→"ice" @0.75 meets the anchor bar): tightening kills honest
  recall (ran→run, dime→time). Only revisit with a replay showing net win.
- **Conviction double-count** (a partial hurts both terms; a full miss doesn't count as "engaged",
  so attempting scores worse than skipping): fold into the performance-axis flow/conviction rebuild
  (see `speaker-bleed` plan) rather than patching twice.
- **Mid-run VAD-death re-flag** (the new chip's `vadEverFired` is sticky-ok): rare mode; per-line
  flow data still records it. Revisit if a real run shows it.
- **Mic Check via the game's VAD stack:** structurally can't prove the game-time stream (check runs
  pre-`start()`); the run-time chip is the reliable layer. Option if wanted: reuse `_startNeuralVad`
  against the mic-check stream.

## 9. Not code (for the human)

- **Melodic-catalog capture evening:** the corpus is ~95% hip-hop; zero current-code data on
  sustained-note melodic singing (elongated vowels across interims, vibrato vs metaphone). One
  evening of rock/pop runs de-risks it; folds into the planned 5-states×3-setups capture.
- **Run the cheese protocol** (after #3 lands) and a Bands S-rank attempt after #2.
