# Karaokee Scoring V2 — Design Spec

**Date:** 2026-06-02
**Author:** Westside Sage (+ Claude)
**Source analysis:** [`docs/audits/2026-06-02-voice-detection-scoring-teardown.md`](../../audits/2026-06-02-voice-detection-scoring-teardown.md)
**Status:** Approved (design); Stage 0 detailed, Stages 1–3 summarized (each gets its own spec/plan when reached).

---

## 1. Context & Goal

The teardown established that Karaokee's displayed score is a **lyric-word-recall ratio** with three structural defects: it credits sound that isn't the right word (VAD floor + answer-key prompt injection), it credits words the singer never sang (greedy fuzzy matching over a wide window), and it measures no performance dimension (no pitch/timing/rhythm). The live Whisper provider on this machine is **local faster-whisper** (`WHISPER_PROVIDER` resolves to `local`; `start.bat` sets no env), so the answer-key prompt-injection defect is fully active.

**Goal:** rebuild the scoring engine, in four sequenced stages, into a multi-axis, source-aware, alignment-based scorer that is **fair** (right-word-required), **hard to cheese**, **tolerant of normal human variation**, and **explainable** — without rewriting the surrounding app (capture transport, lyrics, transcription, telemetry, UI shell are kept).

**Non-negotiable honesty constraint:** no *feel* improvement may be declared validated by automated tests. Stages that change what the score means ship behind a flag with a dual display and are validated only by a human singing session (§6 of the teardown).

---

## 2. Guiding Principle

A **lyric-accuracy** score must be provable from *which words were sung*. Vocal energy (VAD) proves sound was made, not that the right word was sung — so energy belongs in a **flow/stability** sub-score, never in the lyric score. This mirrors the existing shadow phrase engine's source-role model (`vad` = flow-only, `browser_interim` = provisional, `browser_final` = settle, `whisper` = rescue). Stage 0 makes the line scorer honest; Stage 3 reintroduces "you were engaged" credit *correctly* as a separate axis.

---

## 3. Architecture & Cross-Cutting Decisions

### 3.1 Feature flag
A single client flag `karaokee_v2` (persisted in `localStorage`, toggled by a key — proposed `V`, mirroring the existing `D` debug toggle; default **off**).
- **Off:** today's app behavior **plus** the always-on Stage 0 safety fixes.
- **On:** aligned matcher (S1) + raw-stream adaptive VAD (S2) + V2 phrase-engine panel (S3) all active.
- **Stage 0 fixes are unconditional** — they remove provably-wrong credit (bug-fixing, not a feel gamble), so they apply whether or not `karaokee_v2` is on.

### 3.2 Validation strategy
- **Automated (every stage):** each new *pure* function gets a `.cjs` golden test via the existing `loadBrowserCommonJs` shim (see `tests/test_scoring.cjs`); `app.py` changes get `pytest`. The telemetry-replay harness (`tests/test_telemetry_replay.cjs` + `tests/fixtures/telemetry-replay/`) measures **aggregate old-vs-new score deltas** on recorded sessions — a regression tool, **not** an accuracy proof (no sung-word ground truth exists).
- **Human (gating):** the teardown §6 protocol — cheese probes (silent+speakers, hum, common-word loop, mumble), fairness tests (on-beat / off-beat / quiet / monotone / clean-vs-sloppy rap), environment tests — run with the dual display + telemetry export. **V2 does not become default until** cheese probes score low *and* honest variations score fairly, confirmed by a human.

### 3.3 Resolved design forks
- **Whisper prompt (S0.1):** remove the exact-line hint from the crediting path entirely; enable `vad_filter`/`no_speech_threshold`/`condition_on_previous_text=False`. (The hint aids honest recognition, but it is the #1 fairness defect; alignment + multi-source union recover the accuracy. A non-leaking prompt may be A/B'd later.)
- **Mic capture (S2):** **one raw stream** (`echoCancellation`/`noiseSuppression`/`autoGainControl` all false) feeding both VAD and Whisper — not two streams (Chrome applies audio processing at device scope; a second AGC-off stream is unreliable). Tradeoff: NS-off may degrade Whisper in noisy rooms; mitigated by server `vad_filter` + adaptive VAD; flag-gated for A/B.
- **VAD floor (S0.2):** unconfirmed VAD words contribute **0** to the lyric score (not 0.25). The legitimate "sang with energy" credit migrates to the S3 flow/stability sub-score.
- **Difficulty (S3):** a manual `easy/medium/hard/expert` toggle in the V2 panel (default `medium`), using the phrase engine's existing `DIFFICULTY` profiles; auto-selection from the per-song tempo profile is a later refinement.

---

## 4. Stage Decomposition

Each stage is an independently shippable sub-project with its own verification gate. Stages 1–3 are summarized here and will each get a detailed spec + plan when reached.

### Stage 0 — Stop the bleeding (unconditional; this sub-project's detailed scope)

| # | Change | File / anchor | Test |
|---|---|---|---|
| 0.1 | Remove the exact-line `initial_prompt` (local path) and `prompt` (file path) from `/transcribe`; add `vad_filter=True`, `no_speech_threshold=0.6`, `condition_on_previous_text=False` to `_transcribe_with_model`. Stop sending `X-Lyric-Hint` from the client. Leave the realtime path as-is (server already drops the seed for `gpt-realtime-whisper`). | `app.py:79-99, 102-126`; `player.js:1248-1251` | pytest with a mocked model: assert `initial_prompt` not in kwargs, `vad_filter`/`no_speech_threshold`/`condition_on_previous_text` set; existing `/transcribe` tests still pass |
| 0.2 | `effectiveMatchScore` returns **0** for a word that is VAD-only (in `vadMatchedSet`, not in `asrConfirmedSet`) — was `min(rawScore, 0.25)`. Amber UI span is retained (driven by `vadMatchedSet`, not by the scored value). `mergeConfirmedMatches` promotion is unchanged, so an ASR-confirmed word still scores its true value. The per-line `+matched/total` flash counts **confirmed** words only. | `scoring.js:457-463`; flash at `player.js:1814` | `test_scoring.cjs`: extend `effectiveMatchScore` cases — vad-only ⇒ 0, vad+asr-confirmed ⇒ raw, non-vad ⇒ raw |
| 0.3 | Overlap `_matchPrevLine` writes the graded `wordsMatchScore` result (upgrade-only via existing merge), not a flat `1.0`. Extract the per-target match loop into a pure helper (e.g. `scoring.js:matchTargetInWindow`) so it is golden-testable. | `player.js:1320-1356` | new pure-helper golden cases in `test_scoring.cjs` (exact ⇒ 1.0, phonetic ⇒ 0.8, edit2 ⇒ 0.4, none ⇒ absent) |

**Stage 0 success criteria:** all existing `.cjs` + `pytest` suites green; new tests green; `node --check` clean on edited JS; the hum / silent-on-speakers / mumble cheese paths no longer add lyric credit in a telemetry replay; honest on-beat singing is unchanged except that ASR-unconfirmable words lose the 0.25 floor (credit returns in S3).

### Stage 1 — Bounded alignment matcher (flag-gated for A/B, then default-on once validated)
- New pure `alignSpokenToLyrics(spokenWindow, lineWords, wordTimings, opts)` in `scoring.js`: windowed Needleman–Wunsch with affine gaps; substitution cost = `wordsMatchScore`; optional per-token confidence weight; monotonic and line-bounded; returns a `Map<lineIdx,{score,...}>` matching today's `resultMap` shape. `multiWordContractionMatch`/`phraseMatch` kept as a token-coalescing pre-pass.
- Rewire `_collectMatches` / `_collectMatchesWhisper` as thin callers (behind `karaokee_v2`; greedy path retained for A/B).
- `app.py`: include faster-whisper `word.probability` in the `/transcribe` `words[]` payload (currently dropped); plumb confidence through the whisper matching path. Browser-SR path uses uniform confidence (Chrome per-word confidence is unreliable).
- Tests: `tests/test_align_helpers.cjs` — false-positive guard (next-line word not grabbed), missed-word gap, confidence tie-break, regression-identical-to-greedy where greedy was already correct.

### Stage 2 — Robust adaptive VAD + mic normalization (flag-gated; feel-dependent)
- New pure helpers (in `sync-helpers.js` or a new `vad-helpers.js`): adaptive noise floor (EMA of percentile RMS), hysteresis (separate open/close thresholds), debounce (N consecutive frames). All CommonJS-testable.
- `player.js`: replace the one-shot calibration in `updateHotWord` + the `_readVadRms` gate with the adaptive state machine; add a pre-song calibration pass in `start()`; switch `getUserMedia` to one raw stream feeding both VAD analyser and Whisper worklet (behind `karaokee_v2`).
- Tests: `tests/test_vad_helpers.cjs` — hysteresis latch through a sub-threshold dip, debounce count, noise-floor adaptation. Feel validated only by the human protocol.

### Stage 3 — Promote shadow phrase engine to live (dual display) + difficulty normalization
- New `KaraokeePhraseEngine.getLiveScore(session)` → `{lyrics, timing, stability, composite}`: lyrics = confidence-weighted anchor coverage; timing = fraction of cleared phrases with `flowStatus === 'clean'` (penalize early/late via `timingDistance`); stability = 1 − (rescue/rejection rate). Per-song difficulty via the existing `DIFFICULTY` profiles (manual toggle, default `medium`).
- `player.js`: compute `getLiveScore` alongside the existing scorer; render a **V2 panel** (flag-gated, default off) showing the three sub-scores + composite beside the unchanged headline `#score-pct`. Old scorer stays the headline until human-validated.
- Tests: `tests/test_phrase_score.cjs` — anchor-coverage math, timing penalty for late tokens, difficulty monotonicity (expert < easy for identical evidence), confirmed-anchors ⇒ non-zero.

---

## 5. Out of Scope (this project)
- Pitch and rhythm/onset sub-scores (teardown Stages 4–5) — separate future projects; they require server forced alignment and/or Demucs and are research-tier.
- Server-side forced alignment / Demucs vocal separation.
- Silero-VAD / RNNoise ONNX upgrades (Stage 2 ships the pure-JS adaptive VAD; ML VAD is a later option).
- Auto-difficulty selection, LRC auto-alignment, and any rewrite of capture transport, lyrics fetch, search, or the UI shell.

## 6. Success Criteria (whole project)
- **Automated:** all `.cjs` + `pytest` suites green at every stage; new golden tests cover every new pure function.
- **Anti-cheese (human, gating):** with `karaokee_v2` on, the four cheese probes from teardown §6.A score low; honest variations (§6.B) score fairly; clean-vs-sloppy rap separates.
- **No silent regressions:** old scorer remains the headline and default until the human protocol passes; the flag makes the change reversible.

---

## 7. References
- Teardown / weaknesses / human-test protocol: `docs/audits/2026-06-02-voice-detection-scoring-teardown.md`
- Shadow phrase engine plan: `docs/superpowers/plans/2026-05-01-shadow-phrase-engine.md`
- Scoring core: `static/scoring.js`, `static/match-helpers.js`, `static/sync-helpers.js`, `static/phrase-engine.js`, `static/player.js`, `app.py`
