# Deep Technical Review Request: Real-Time Karaoke Scoring Pipeline (VAD / ASR-Matching / Phrase-Scoring / Sync)

> Prompt authored 2026-06-27 for handing to an external frontier model (GLM 5.2) to produce an improvement report on the VAD / scoring / matching / sync algorithms. Paste everything below the line into GLM. See the attachment checklist at the bottom for the source files most worth pasting alongside it.

---

## 1. ROLE & GOAL

You are a senior engineer and researcher with deep, simultaneous expertise in: **real-time audio DSP and voice-activity detection**, **streaming ASR (automatic speech recognition) on sung/noisy audio**, **phonetic and fuzzy string matching**, and **game-feel / scoring-system design** (combo systems, grade curves, anti-cheat). You have shipped browser-based, client-side audio products and understand the constraints of running inference in WASM with no server.

Your goal: produce a **rigorous, evidence-based improvement report** for the scoring pipeline of a browser karaoke app called **Audiopian** (internally "Karaokee"). The pipeline converts sung microphone audio into an "Honest %" lyric score and an arcade points/combo/grade outcome.

This is NOT a request for a generic "here's how karaoke scoring works" overview. The team has already done substantial research and made deliberate, documented decisions. Many obvious ideas are already tried, rejected, or frozen (see §4). I am handing you specific real file names, real thresholds, real constants, and real prior conclusions. **Reward specificity. Engage with the actual numbers and the actual code seams. If you cannot improve something without re-litigating a settled decision, say so explicitly rather than proposing it.**

You will not have the source files unless you ask — but I (the human) can paste any of them, plus telemetry samples, on request. Tell me exactly what you want to see when a recommendation hinges on code or data you don't have.

---

## 2. SYSTEM CONTEXT

**Deployment posture (hard, non-negotiable — see §4):**
- **Pure-static, near-stateless, client-side-only.** Hosted on Cloudflare as a static frontend. The server downloads/holds NO audio and runs NO server inference. Backing audio plays **client-side via the YouTube IFrame Player API** (any embeddable song — there is no curated catalog; the thesis is "sing the songs you genuinely love", so any-song support is non-negotiable).
- **Desktop Chrome/Edge only by design** (because the default recognizer is the browser Web Speech API). Mobile / Firefox / Safari are out of v1 scope.
- The game **clock** is the YouTube IFrame `getCurrentTime()`, frame-grained (~60Hz), funneled through a single accessor `player.js _now()`. There is **no `performance.now()` interpolation layer** — this was investigated and deliberately cleared. Do not propose adding one.

**Recognizer tiers (dual-recognizer architecture, deliberately retained):**
1. **Browser Web Speech API (`browser_sr`)** — the **deployed default**, free. Emits interim hypotheses and final results; finals expose up to 3 alternatives (`maxAlternatives=3`). Rarely fires "final" during continuous singing, so interim-snapshot reconciliation is load-bearing.
2. **`gpt-realtime-whisper`** — opt-in **BYO-OpenAI-key** premium tier, browser-streamed over the OpenAI Realtime API (24kHz PCM16, client-side ephemeral token mint).
3. **Local faster-whisper** and **OpenAI file API** — non-streaming `/transcribe` dev/fallback paths only.

**The honesty thesis (the spine of the whole design):**
The system must **never credit a word the singer did not actually sing**. This is enforced everywhere: VAD energy alone can prove *sound* but never *the right word*; one-directional mishearing bridges; strict-win-only alternative selection; a human "anti-cheese sing-test" gate before any default flip. A prior research conclusion is that **anti-cheese honesty is structurally threshold-bound on the lyric-recognition axis** — no amount of better ASR, forced alignment, or goodness-of-pronunciation (GOP) scoring fixes it (GOP ~30% false-accept; Whisper hallucinates real tokens on silence/instrumental). The team's proposed strategic escape is an **orthogonal pitch/melody axis** so that cheese must beat words AND melody AND timing — but that axis is the **thinnest-researched area** and has **not earned budget** without a focused validation dive.

**Lyric-axis status:** The lyric scorer (match → reconcile → score → commit) is declared **FROZEN at its honesty ceiling**. The arcade scorer (points/combo/grade) is the **single** scoring path; the legacy V1 scorer, the `karaokee_v2` flag, and the `V` toggle were deleted.

**Pipeline shape:**
```
mic → VAD (neural Silero primary, RMS energy-gate fallback)
    → ASR (browser_sr default / gpt-realtime-whisper premium)
    → match-against-known-LRC-lyrics (phonetic + edit-distance + curated bridges, VAD-gated)
    → reconcile late/interim recognition onto the line it was sung on
    → phrase-level anchor scoring → arcade points/combo/grade
    → Honest % headline
```
Backing-track lyrics come from lrclib (time-synced LRC). Each completed run auto-saves a telemetry JSON; a pure `summarizeRun` digest exposes the measurable signals (see §3 and §5).

---

## 3. SUBSYSTEMS TO ANALYZE

For each subsystem below I give the **real files**, the **current approach**, and the **actual parameters/thresholds in the code**. Engage with these specifics.

### 3A. Voice Activity Detection (VAD)
**Files:** `static/vad-helpers.js`, `static/audio-processor.js`, `static/player.js`, `static/scoring-session.js`, `static/vendor/vad/bundle.min.js` (vendored `@ricky0123/vad-web` MicVAD + Silero ONNX).

**Approach — two-tier:**
- **PRIMARY (neural):** On mic open, `player.js _startNeuralVad()` constructs `MicVAD.new()` reusing the existing mic stream (`ort.env.wasm.numThreads=1` because there is no SharedArrayBuffer / COOP-COEP cross-origin isolation), loading Silero ONNX from `/static/vendor/vad/` (both `silero_vad_v5.onnx` and `silero_vad_legacy.onnx` are vendored). `onSpeechStart/onSpeechEnd` set `player.isSpeaking` and drive commit cadence. `_startNeuralVad` passes **no** thresholds, so library defaults govern sensitivity (`positiveSpeechThreshold`/`negativeSpeechThreshold`/`redemptionFrames` are unknown to me — inside the bundle).
- **FALLBACK (RMS):** If neural init throws, every ~100ms `updateHotWord()` reads a live `AnalyserNode` (`fftSize=256`, ~16ms window) via `_readVadRms` (sqrt(mean(x²))) and runs the pure `updateVad` state machine in `vad-helpers.js`: EMA noise floor (`floorAlpha=0.05`, **frozen while speaking**), open threshold = floor + `openMargin=0.02`, close threshold = floor + `closeMargin=0.01`, debounce `openFrames=2` consecutive above-open to latch ON, `closeFrames=5` below-close to latch OFF. A still-older legacy branch uses a single calibrated fixed threshold (baseline over first 2s, `min(baseline+0.025, 0.06)`, ×1.3 for slow tempo).
- A separate worklet (`audio-processor.js`) also posts ~100ms RMS frames (1600 samples @16kHz) — but the **gate actually consumes the AnalyserNode path**, so the worklet energy posting is partly redundant.

**How VAD gates scoring (`scoring-session.js setEnergy`):** while `isSpeaking` AND a hot word is in window, the hot word gets **provisional amber credit 0.25** (method `vad-provisional`), upgradeable to 1.0 by real ASR (`vad-confirmed`). When silent, hot-word matching tightens to **exact-or-phonetic only** (no edit-distance credit). `isSpeaking` also gates interim ASR reconciliation. `effectiveMatchScore` enforces: a word matched ONLY by VAD (not ASR-confirmed) earns **zero** lyric credit.

**Known weaknesses:** backing-track/speaker bleed (mic hears the instrumental → false "speaking", no spectral/speaker discrimination); RMS fallback latency (~200ms onset, ~500ms hangover) plus neural model-frame latency delays speech-end edges (which drive realtime commits); hardcoded non-adaptive hysteresis; quiet singers near floor may never latch ON, loud rooms may latch ON permanently (floor frozen while speaking can self-perpetuate a false positive until 5 below-close frames); silent fallback is invisible to the user (only `meta.neuralVadActive` in telemetry); single-threaded ORT has no headroom and WASM init is the likely failure point.

### 3B. Core word-matching + line-scoring engine
**Files:** `static/scoring.js` (single source of truth), `static/match-helpers.js`.

**Approach — layered cascade `wordsMatchScore` (first hit wins) returning `{score, method}`:**
1. `isNeverScore` short-circuit → 0 (hard-R slur, derived not spelled)
2. exact equality → **1.0**
3. `-ing`/`-in` stem equality (both ≥4 chars, stems ≥3 and equal) → **1.0**
4. contraction expansion (`CONTRACTION_MAP`, ~60 entries, symmetric; reverse restricted to multi-word) → **1.0**
5. bidirectional slang/homophone/number map (`SLANG_MAP` + `HOMOPHONE_PAIRS` ~16 pairs) → **0.9**
6. target-directional ASR-mishearing map (`ASR_MISHEARINGS`, currently **exactly one entry** `{gorilla:['really']}`, lyric-keyed only) → **0.9**, method `mishearing`
7. double-metaphone code overlap (primary/secondary, either side), gated by `sameFirst` OR `bothLong` (both ≥5 chars AND |len diff|≤2) OR silent-prefix; both words must be ≥3 chars → **0.8**
8. edit distance (only when |len diff| ≤ `maxEditDistance` = 1 for shorter-word-len ≤6 else 2; words ≤2 chars skip fuzzy entirely): dist==1 → **0.75**; dist==2 only if pure 1-char trailing-truncation (`isEdit2PrefixTruncation`, e.g. singin→singing but NOT less→lesson) → **0.4**
9. substantial affix (shorter ≥5 chars, ratio ≥0.6, prefix/suffix overlap) → **1.0**
10. else → **0.0**

Per-line: `collectSequentialWordMatches` scans spoken words **monotonically left-to-right (never backtracks)**; `mergeConfirmedMatches` keeps best score per target; `computeLineScore` aggregates weighted (`core=1.0`, `function=0.5`, `adlib=0` — ad-libs excluded entirely, neither help nor hurt), marking "perfect" at `weightedMatched ≥ 0.9 × weightedTotal`. `interpolateWordTimings` builds per-word timing windows from a crude vowel-group syllable heuristic. `MetaphoneLRU` caches spoken metaphones (capacity 50).

**Known weaknesses:** double-metaphone collisions (the `sameFirst`/`bothLong` guard reduces but doesn't eliminate 0.8 false credits); short-word fragility (≤2 chars skip fuzzy, <3 can't reach phonetic → rely wholly on enumerated `HOMOPHONE_PAIRS`); threshold cliffs at len 6 (edit) and len 5 (phonetic `bothLong`); curated maps don't scale (one mishearing entry, hand-maintained); **greedy monotonic matching can mis-assign a spoken word to an early target and starve a better later target**; magic constants (0.9/0.8/0.75/0.4, perfect bar 0.9) with no documented calibration; crude syllable estimator skews timing windows.

### 3C. Phrase engine + arcade + scoring-session
**Files:** `static/phrase-engine.js`, `static/scoring-arcade.js`, `static/scoring-session.js`.

**Approach:** `buildPhrasePlan` turns each LRC line into one+ phrases; `selectAnchors` picks must-sing key words (drops <3 chars, function/adlib, fillers, profanity in clean mode; weights core 1.0/function 0.5/adlib 0.25, +0.2 if last/2nd-last word, +0.15 if ≥6 chars). `anchorsRequired = ceil(anchors × ratio)` min 1, with **force-all relief** (only triggers at ≥4 anchors: required → N−1) and a **fast-tempo floor** (≥4 wps lines drop toward half-anchors but never below 2 genuinely-recognized).

**`DIFFICULTY` profiles** `{requiredAnchorRatio, timingToleranceMs, settlementMs, minFlowCoverage}`:
- easy `{0.20, 1400, 1800, 0.20}` / medium `{0.45, 1000, 1400, 0.45}` (default) / hard `{0.65, 750, 1100, 0.65}` / expert `{0.80, 500, 900, 0.80}` / insane `{0.90, 400, 800, 0.90}`.
- **`minFlowCoverage` is carried in every profile but read NOWHERE** — dead config.

**Evidence flows three ways:** (1) live `addEvidence` credits an ASR token to an anchor when `wordsMatchScore ≥ 0.75` and timestamp is inside the **strict-early / generous-late** review window (`endSec + settlementMs + LATE_EVIDENCE_GRACE_MS=1000`); each token consumed once. (2) `reconcileLateEvidence` (post-live): monotonic forward pass (`minIdx` pointer, threshold 0.75, lookback `RECONCILE_LOOKBACK_SEC=18`) + a cheese-safe **unique-anchor** out-of-order pass (threshold 0.8, only when the anchor word is unique among un-hit anchors of in-flow lines). (3) `reconcileInterimSnapshot` credits ended lines from Chrome's growing interim hypothesis, gated by a forward-only `_interimFloorSec` AND `requireInWindowFlow` (`RECONCILE_FLOW_GRACE_MS=0`).

**Settle/commit:** `settlePhrases` advances open → settling (≥endSec) → settled (≥endSec+settlementMs). On the tick a phrase first reads "settled", `commitNewlySettled` → `arcade.commitPhrase` exactly once with the **UNCAPPED** hit count. Arcade: `BASE_PER_ANCHOR=100`, `points = round(100 × required × baseScale × (perfect?1.5:1) × currentMultiplier)` (awarded with current mult, THEN ramp advances; `RAMP_PER_TIER=4`); miss (hit==0) resets mult/ramp/streak; partial is a no-op hold. `isPerfect` = `hit ≥ total anchors` (`PERFECT_THRESHOLD='all'`, uncapped). `ARCADE_TUNING` baseScale/multCap: easy `{1.0,4}` … insane `{2.5,10}`. `GRADE_CUTOFFS` (S/A/B/C/D) harshen with difficulty: medium S87/A73/B59/C45; insane S98/A91/B81/C69.

**`getHonestPct`** = `round(sumHit/sumReq × 100)` over **non-open** phrases (includes "settling"), hit capped at required.

**Known weaknesses (critical ones):**
- **Headline-vs-points divergence ("blessed divergence"):** commit freezes the arcade multiplier on the hit count at the settle instant, but evidence windows stay open ~1s longer AND `reconcileLateEvidence` has an 18s lookback. Late/reconciled hits lift Honest % but NEVER the already-committed points/multiplier/streak. Documented as intentional but it's the largest fairness asymmetry.
- **Two "settled" definitions:** commit/`getHonestPct` use `endSec+settlementMs`; evidence acceptance uses `endSec+settlementMs+1000ms`. A phrase can be committed miss/partial while its evidence window is still open.
- **Short-line all-or-nothing:** force-all relief only triggers at ≥4 anchors, so 2–3-anchor lines require ALL — one ASR-impossible word sinks the line.
- **Grade-curve reachability:** Honest % is bounded below 100% by ASR completeness, yet insane S=98% may be unreachable under real ASR drop rates. `PERFECT_THRESHOLD='all'` gates the +50% bonus on recognizer completeness, not singing.
- `getHonestPct` includes "settling" phrases → headline dips then recovers (jitter).
- `minFlowCoverage` dead; honestly-sung lines that ASR simply missed read as total misses (flowEvents exist but anchorHits stay empty).

### 3D. Adaptive sync + recognizer plumbing
**Files:** `static/sync-helpers.js`, `static/commit-helpers.js`, `static/realtime-whisper.js`, `static/alternatives.js`.

**Approach — tempo drives everything.** `classifyTempo`: wps>5.0 fast / ≥2.0 normal / else slow (absolute thresholds). The class keys: matching window (`getWindowParams`: slow −0.3/1.5, normal −0.3/1.5, fast −0.5/2.5 + drift tracks), overlap (`getOverlapDuration`: slow 1.0s/normal 0.8s/fast 0.5s, ×1.5 for short slow lines), finalize delay (`getScoreDelay`: 1.0–1.2s to wait out recognizer latency the comment pegs at ~0.7–2s), worklet chunk size (`getChunkSamples`: slow 32000/normal 24000/fast 10000 samples — **comment says @16kHz**), spoken-word lookback (`getSpokenWindowSize`: slow 20/normal 15/fast 12). A relative per-song path (`computeSongTempoProfile`/`classifyLineTempoRelative`, p50/p80 percentiles) **emits 'medium'** — a vocabulary mismatch with the slow/normal/fast switch keys (so 'medium' silently hits the default branch).

**Realtime commit cadence (`commit-helpers.js`):** commit on VAD speech-end OR a tempo cap (`capMsForTempo`: fast 1500 / slow 2500 / default 2000 ms), with `DEFAULT_MIN_INTER_COMMIT_MS=350` and an empty-buffer guard — replacing the old blind 700ms `setInterval` slices.

**Realtime wiring (`realtime-whisper.js`):** `float32ToPcm16Base64` (asymmetric clamp), `buildSessionUpdateEvent`/`buildClientSecretBody` — **input format declares rate 24000**, includes logprobs, `server_vad turn_detection` suppressed for `gpt-realtime-whisper` (client-side commit cadence used instead), `delay` knob only on that model, `expires_after` default 600s. **Note the sample-rate inconsistency:** `getChunkSamples` math assumes 16kHz but the Realtime session declares 24kHz.

**Alternatives (`alternatives.js`):** `pickBestTranscript(alternatives, expectedWords, matchFn)` mines alt[0..2] of a **final** browser-SR result, switching off alt[0] only on a **strict** win (ties keep alt[0]; nothing matches → keep alt[0] — honesty bound). Only runs on finals, over the single currently-expected line.

---

## 4. WHAT'S ALREADY BEEN TRIED / OFF-LIMITS

Do **NOT** re-propose these. If your best idea touches one of them, name the constraint and explain why your variant is different.

**Settled conclusions (do not rehash):**
1. **Lyric-axis honesty is structurally threshold-bound.** No ASR upgrade, forced alignment, or GOP scoring fixes the cheese problem on the words axis (GOP ~30% false-accept; Whisper hallucinates tokens on instrumental/silence). Do not propose "use a better ASR / add GOP / add forced alignment to improve honesty." Timing/recall improvements from those are fine to discuss — but framed as timing/recall, not honesty.
2. **The dual recognizer (browser_sr default + BYO-key whisper premium) is deliberately retained** (ADR-0001). Do NOT propose ripping out browser_sr or unifying to one recognizer as a *deployment* decision. The interim-snapshot machinery (`reconcileInterimSnapshot`, segment-reset detection, `_interimFloorSec`) stays load-bearing because browser_sr rarely fires finals during continuous singing.
3. **`reconcileLateEvidence` is fundamental and not deletable** (a word sung at line-end and emitted after the line closes always needs it). Only `reconcileInterimSnapshot`/`_interimFloorSec` are theoretically deletable if the recognizer changes.
4. **The honest-%-vs-arcade-multiplier divergence is "by design"** per spec 4.2 — but I explicitly want your view on whether it should be revisited (see §5). Treat it as a known tradeoff, not an undiscovered bug.
5. **The YouTube IFrame clock granularity** (frame-grained `getCurrentTime()`, no `performance.now()` interpolation) was investigated and cleared. Don't propose interpolation.
6. **The matcher gate must NOT be loosened** to catch trivially-close short words. The honesty-safe alternative pool was measured at ~2 anchors across 4 benchmark songs — the matcher is healthy and recall on dense rap is recognizer-limited, NOT a matcher bug. Do not propose matcher-loosening to chase that recall.

**Hard constraints every recommendation MUST respect:**
- **Client-side only, no server inference, no server-held audio** (any server step like Demucs vocal separation or forced alignment breaks the near-stateless ADR-0002 posture and must be justified explicitly against it).
- **Backing audio is the YouTube IFrame**; any-song (no curated catalog).
- **Desktop Chrome/Edge only.**
- **ORT must stay single-threaded** unless COOP/COEP cross-origin-isolation headers are added (SharedArrayBuffer unavailable today).
- **MicVAD must reuse the existing mic stream and never stop its tracks** (the game's capture stack owns the stream lifecycle; pause/resume are no-ops).
- **Honesty bound is non-negotiable:** VAD alone never confirms a word (provisional credit capped at amber 0.25, ASR-upgradeable only; silent → exact/phonetic only; `effectiveMatchScore` zeroes VAD-only credit). `ASR_MISHEARINGS` stays one-directional (lyric-keyed). A pitch axis must NEVER silently blend into the lyric Honest % — it is a separate sub-score.
- **Pure helper modules** (`vad-helpers.js`, `scoring.js`, `match-helpers.js`, `sync-helpers.js`, `commit-helpers.js`, `realtime-whisper.js`, `alternatives.js`, `phrase-engine.js`, `scoring-arcade.js`, `scoring-session.js`) must stay DOM-free / clock-injected / no randomness, and dual-loadable (Node `require()` + browser `<script>`) via UMD with `var`/plain functions (no ES modules). `player.js` is the only DOM-bound file.
- **Neural VAD failure must degrade silently to RMS** without breaking the run.
- **Slurs derived in source, never spelled** (hard-R n-word is `isNeverScore` in all modes).
- **The anti-cheese sing-test is a standing human gate**: nothing flips to default / no competitive ranking ships until a human sings the cheese probes and confirms cheese ≈ 0. Metrics can't substitute for it.

**Measurable signals available (telemetry `summarizeRun`):** difficulty; scores `{honestLyricPct, composite}`; arcade `{points, grade, maxMultiplier, longestStreak, perfects, clears}`; phraseOutcomes `{cleared/partial/missed/total}`; `recognizer.clearsBySource {whisper, browser_sr, vad}` + `finalWordSourceCounts`; sync `{medianLineDriftMs, linesEarly, linesLate}`; honesty `{benchmarkIntent, pointsBuilt, maxMultiplier, suspectedCheeseInflation}`. `SOURCE_RANK = {whisper:3, browser_sr:2, vad:1}`. `CHEESE_INTENTS = {humming_cheese, silent_section_test}`. **Caveat:** the existing benchmark batch is n=1 per cell, all dense rap @ expert (worst-case pilot) — deltas are suggestive, not proven, and likely do NOT generalize to melodic/sparse/easy songs.

---

## 5. SPECIFIC QUESTIONS

Answer these directly. Group your report by subsystem.

**VAD (3A):**
1. Given backing-track bleed is the dominant false-positive source and there is NO spectral/speaker discrimination, what client-side, single-threaded-WASM-feasible defenses are realistic? Consider: cross-correlating mic energy against the known backing-track signal (the app has the YouTube audio playing — but can it access those samples client-side given IFrame sandboxing? flag if you need to know), spectral-flux or harmonicity gating, or a lightweight echo-cancellation path. Rank by feasibility under the constraints.
2. The neural MicVAD runs with **default** `positiveSpeechThreshold`/`negativeSpeechThreshold`/`redemptionFrames` (none passed). Given Silero-on-singing and the realtime-commit latency goal, what starting values would you trial, and what telemetry signal validates them? (I can paste the bundle defaults.)
3. Is the RMS fallback's fixed hysteresis (open +0.02 / close +0.01 above an EMA floor with `floorAlpha=0.05`, 2/5 debounce frames) defensible, or should margins/debounce be tempo-adaptive (a `vadTempoClass` already exists)? Specifically: can the "floor frozen while speaking → false-positive self-perpetuates until 5 below-close frames" failure be fixed without hurting quiet singers? Is a max-hold timeout the right tool?
4. Should the noise floor be calibrated during the existing pre-game **Mic Check** instead of (or in addition to) the first-2s in-song baseline? What's the risk?
5. Two RMS sources coexist (worklet 1600-sample frames vs the AnalyserNode `fftSize=256` ~16ms read that the gate actually consumes). Is the small-window jitter materially destabilizing the gate, and is unifying on the larger window worth it? Is the worklet energy post dead code to remove?

**Core matching (3B):**
6. The per-line matcher is **greedy monotonic** (`collectSequentialWordMatches` advances `spokenIdx`, never backtracks). Quantify the risk: under what line shapes (repeated words, transposed words, ASR insertions) does this starve a correct later match, and is a bounded DP / Needleman-Wunsch alignment over the line worth the complexity given the honesty bound? Propose a concrete alignment that preserves "no credit for unsung words."
7. Are the cascade score constants (slang/mishearing 0.9, phonetic 0.8, edit1 0.75, edit2 0.4) and the 0.9 perfect bar defensible, or arbitrary? Propose a principled way to set them from telemetry (`asr`/`matches` arrays) without loosening honesty.
8. The phonetic layer needs both words ≥3 chars and gates 0.8 on `sameFirst`/`bothLong(≥5, |Δlen|≤2)`/silent-prefix. Where does this over- or under-fire? Is there a target-word case where the double-metaphone primary code is empty so the phonetic layer silently never fires (falling through to edit distance only)?
9. Short words (≤2 skip fuzzy, <3 can't reach phonetic) rely on ~16 enumerated `HOMOPHONE_PAIRS`. Is there a *principled* short-word phonetic/syllable/IPA encoding that scales beyond the hand list while staying honesty-safe (identical-sound only)?
10. The threshold cliffs (`maxEditDistance` flips 1→2 exactly at shorter-len 6; phonetic `bothLong` hard-cuts at 5) create qualitatively different leniency at boundaries. Should these be continuous functions of length? What's the honesty risk of continuity?

**Phrase engine + arcade (3C):**
11. **The headline-vs-points divergence.** Three options: (a) defer commit until `endSec+settlementMs+LATE_EVIDENCE_GRACE_MS` (align all three "settled" notions); (b) allow a one-shot post-commit multiplier/streak retro-correction when reconciliation lifts a committed phrase from miss/partial to clear; (c) leave it. Evaluate each for fairness, game-feel (combo integrity), and implementation risk. Which would you ship?
12. The two "settled" definitions (commit at `+settlementMs`, evidence accepted to `+settlementMs+1000`) let a phrase commit as miss/partial while its window is still open. Is this a bug to fix or acceptable? Cheapest correct fix?
13. **Short-line all-or-nothing:** force-all relief triggers only at ≥4 anchors, so 2–3-anchor lines require ALL. Propose continuous relief (e.g. a per-word recognizability prior so a known-ASR-hard anchor doesn't sink a short line) that preserves the fast-tempo "≥2 genuinely-recognized" floor and can't be cheesed.
14. **Grade-curve reachability:** Honest % is capped by ASR completeness, yet insane S=98% and `PERFECT_THRESHOLD='all'`. Should Honest % be normalized by an estimated per-song ASR-completeness ceiling so honest singers can reach S? Should `PERFECT_THRESHOLD` move to `'requiredPlusOne'` to detach the perfect bonus from full anchor completeness? What telemetry validates the new cutoffs?
15. Should `getHonestPct` exclude "settling" phrases (kill the dip-then-recover jitter) or show a separate provisional band? Tradeoff vs delaying credit by `settlementMs`.
16. `minFlowCoverage` is dead config in every profile. Was a flow-coverage honesty gate intended (require energy across X% of a phrase window to be credit-eligible)? Is it worth wiring, or should it be deleted? If wired, does it strengthen or weaken honesty?
17. Honestly-sung lines that ASR simply missed read as total misses (flowEvents exist, anchorHits empty). Should there be an "engaged-but-unrecognized" line state distinct from "silent/skipped", and can it exist WITHOUT crediting unsung words?

**Sync + plumbing (3D):**
18. `classifyLineTempoRelative` emits `'medium'` but the window/overlap switches only know `slow/normal/fast` → 'medium' silently hits default. Fix the vocabulary mismatch and/or adopt the relative per-song percentile profile end-to-end? Quantify the upside.
19. **Sample-rate inconsistency:** `getChunkSamples` math assumes 16kHz but the Realtime session declares 24kHz. Where is the resample, is there a latent mismatch, and does it mis-tune chunk durations on the streaming path?
20. The realtime commit cap (1500/2000/2500ms) + 350ms min-inter-commit: can a breathless passage still be cut mid-phrase, and would a logprob/confidence-gated early flush cut catch-up lag without fragmenting? Are these values tunable from the sync-drift telemetry?
21. `pickBestTranscript` only runs on finals over the single expected line, strict-win-only. Is extending alt-mining to interim reconciliation worth it while preserving the strict-win honesty bound? Is the strict-win rule discarding genuinely-better alt[1] on ties (and does that matter)?

**The orthogonal pitch axis (cross-cutting — the strategic question):**
22. Given the lyric axis is honesty-ceilinged, is a **client-side, browser-feasible, reference-free** pitch/expressiveness sub-axis a credible orthogonal anti-cheese signal? Assess in-browser pitch trackers (e.g. SPICE/CREPE/pYIN-class) for WASM latency, accuracy on sung-over-backing audio, and *actual cheeseability* — the prior research found ZERO verified claims here. What can ship reference-free (no vocal stem) vs what truly needs a reference pitch (which would require server-side Demucs, breaking the static posture)? Be explicit about what you'd need to validate before this earns budget, and how it stays a SEPARATE sub-score (never blended into Honest %).

---

## 6. REQUIRED REPORT FORMAT

Produce:

1. **Executive summary** (≤200 words): the 3–5 highest-leverage moves and the single biggest risk.

2. **Prioritized recommendations**, each as a structured block:
   - **Title** + **subsystem** + **Impact × Effort** rating (High/Med/Low each, with a one-line justification).
   - **Concrete mechanism:** exactly what to change, in which file, with which new values/algorithm — specific enough to implement. Reference the real constants above.
   - **Expected effect:** what improves and by roughly how much / under what song regime.
   - **Validating telemetry signal:** which `summarizeRun` field (or new field you'd add) would confirm the win, and the before/after you'd expect. Prefer A/B-testable proposals.
   - **Risks / regressions:** what could get worse, especially game-feel and latency.
   - **Honesty-preservation note:** an explicit argument that the change cannot credit an unsung word (or a flag that it needs the human sing-test gate).

3. **"Already-settled awareness" section:** explicitly list the ideas you deliberately did NOT recommend because §4 settles them, in one line each, so I know you read the constraints.

4. **Final ranked roadmap:** a single ordered list (do-first → do-later) merging all subsystems, grouped into "cheap increments on the current stack" vs "bigger bets", with the pitch-axis validation dive placed honestly relative to the cheap wins.

5. **Uncertainty / data requests:** a clear list of every place you are guessing, and the **exact source files or telemetry samples** you'd want me to paste to firm up the recommendation. (Most likely candidates: `static/scoring-session.js`, `static/phrase-engine.js`, the vendored MicVAD defaults in `static/vendor/vad/bundle.min.js`, and a few real telemetry JSONs from `output_telemetry/`.)

---

## 7. GROUND RULES

- **Evidence over vibes.** Tie claims to the actual constants/files or to a measurable telemetry signal. When you assert an effect size, say whether it's grounded, estimated, or a hypothesis.
- **Respect every constraint in §4.** A recommendation that violates the static/client-side/desktop-Chrome/honesty constraints is invalid unless you explicitly argue the constraint should change and quantify the cost.
- **Prefer measurable, testable, A/B-able proposals** over architectural rewrites. Cheap increments on the existing dual-recognizer stack are more valuable to me than greenfield redesigns.
- **Call out your assumptions** every time you make one, and prefer asking for the file/telemetry over guessing when a recommendation hinges on it.
- **Distinguish honesty improvements from recall/timing improvements** — they are different axes here and conflating them is the #1 way to produce advice the team has already rejected.
- Match my specificity. Generic karaoke-scoring advice is not useful; engagement with `wordsMatchScore`, `commitNewlySettled`, `updateVad`, `getChunkSamples`, and the real thresholds is.

Begin when ready. If you want any of the source files or telemetry samples before you start, ask for the specific ones first; otherwise produce the full report and flag your uncertainties inline.

---

## Attachment checklist (paste these into GLM alongside the prompt for best results)

1. `static/scoring-session.js`
2. `static/phrase-engine.js`
3. `static/scoring-arcade.js`
4. `static/scoring.js`
5. `static/match-helpers.js`
6. `static/vad-helpers.js`
7. `static/sync-helpers.js`
8. `static/commit-helpers.js`
9. `static/realtime-whisper.js`
10. `static/alternatives.js`
11. `static/telemetry-helpers.js`
12. `docs/research/2026-06-04-core-loop-modernization.md`
13. `docs/research/2026-06-08-benchmark-batch-analysis.md`
14. `docs/adr/0003-arcade-default-lyric-axis-frozen.md`
15. A representative telemetry JSON from `output_telemetry/<date>/` (ideally a debug-on run, plus one cheese-intent run)
