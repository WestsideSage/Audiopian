# Karaokee Voice-Detection & Scoring Teardown

**Date:** 2026-06-02
**Scope:** The voice-detection → transcription → matching → timing → scoring → feedback pipeline only. Not the loader/UI/search surface except where it touches scoring.
**Method:** Full first-hand read of the runtime scoring code, then a 13-agent adversarial fan-out (5 claim-verifiers, 3 red-team personas, 5 architecture researchers; external library facts web-verified).

### Evidence tiers (used throughout)
- **[CODE]** confirmed directly from source (file:line cited)
- **[TEST]** exercised by the existing automated suite (`tests/*.cjs`, `pytest`)
- **[INFER]** inferred risk — depends on runtime/environment, not provable from code alone
- **[HUMAN]** severity/feel can only be confirmed by a real microphone + singing session

> I have **not** sing-tested any of this. Every behavioral severity claim is flagged [INFER] or [HUMAN]; §6 is the protocol to confirm them.

---

## 1. Current Algorithm Map

The displayed score is, end to end, a **lyric-word-recall ratio**. There is no pitch, melody, rhythm, or onset measurement anywhere in the runtime [CODE — every `pitch|f0|onset|spectral` hit lives in `docs/` or CSS, never in `static/*.js` runtime].

**Stage 1 — Lyric & timing source (server).** `lyrics.py:fetch_lyrics` → lrclib.net synced LRC → `parse_lrc` → `[{time, text}]`, **line-level timestamps only, no word timing** [CODE lyrics.py:12-23]. `app.py:/load` also `download_audio` → `temp/audio.webm`; duration cached.

**Stage 2 — Word-timing interpolation (client).** `scoring.js:interpolateWordTimings` splits each line's duration (next line's time − this line's time; last line clamped to +8 s) across its words, weighted by `estimateSyllables` (vowel-cluster heuristic) [CODE scoring.js:360-435]. Each word gets `{estimatedTime, windowStart, windowEnd, wordClass, weight, phonetic}`. Tempo from `classifyTempo(wps)` — **absolute** thresholds `>5 fast / 2–5 normal / <2 slow` [CODE sync-helpers.js:11-15]. A per-song relative profile (`computeSongTempoProfile` p50/p80 → `classifyLineTempoRelative`) is computed but its **only** runtime effect is a 1.3× VAD multiplier for "slow" lines [CODE player.js:532-534, 1660]. `useVad = true` is set for **every** line regardless of tempo [CODE player.js:533].

**Stage 3 — Mic capture.** A single `getUserMedia({echoCancellation:true, noiseSuppression:true, autoGainControl:true})` [CODE player.js:1094-1095] feeds (a) `_vadAnalyser` (`fftSize 256`) for RMS energy, and (b) either the AudioWorklet `chunk-processor` (local Whisper, 16 kHz WAV chunks) or a WebRTC track (OpenAI realtime, 24 kHz).

**Stage 4 — Three detection sources (union + promotion):**
- **VAD energy** (`updateHotWord`, polled every 100 ms by `setInterval(updateLyrics,100)`): `isSpeaking = RMS > threshold`; **one-shot** calibration over the first 2 s of playback → `threshold = min(baseline+0.025, 0.06)`, then frozen [CODE player.js:1657-1675]. If speaking and the hot word's window is open, the word gets a provisional **0.25** (`vadMatchedSet`, amber) [CODE player.js:1699-1702].
- **Browser `webkitSpeechRecognition`** (en-US, continuous, interim, `maxAlternatives=3`): `onresult` → `_matchHotWord` + `_collectMatches` (primary transcript **plus up to 3 alternatives**, unioned) + `_matchPrevLine`; confirms/promotes VAD words. A 5 s watchdog restarts it on silence [CODE player.js:699-818].
- **Whisper Track 2:** local `/transcribe` (faster-whisper, `beam_size=1`, `word_timestamps=True`, **`initial_prompt = X-Lyric-Hint = the active line's text` — unconditional**) [CODE player.js:1249-1250, app.py:82-83]; or OpenAI realtime over WebRTC, where the client builds a title + first-8-lines seed but the **server drops it for the default `gpt-realtime-whisper` model** [CODE player.js:856-863; app.py:136-137 `if prompt and OPENAI_TRANSCRIBE_MODEL != 'gpt-realtime-whisper'`]. The OpenAI *file* path also forwards the hint (`data['prompt']=hint`, app.py:110-111). → `_collectMatchesWhisper`, promotes.

**Stage 5 — Matching** (`scoring.js:wordsMatchScore`, a cascade): exact 1.0 / `-in↔-ing` 1.0 / contraction 1.0 / slang 0.9 / phonetic (Double Metaphone) 0.8 *(guard: same-first-letter OR both ≥5 chars & |Δlen|≤2 OR silent prefix)* / edit-distance-1 0.75 / edit-2 prefix-truncation 0.4 [CODE scoring.js:311-348; TEST `tests/test_scoring.cjs`, `test_match_helpers.cjs` exercise the tiers, `isEdit2PrefixTruncation`, and slang/contraction behavior]. Plus `multiWordContractionMatch`, `phraseMatch`. Filler words skipped. Drift window 14/18/25 spoken tokens by tempo; monotonic greedy, **break on first score > 0** [CODE player.js:1564-1614, sync-helpers.js:24-27].

**Stage 6 — Scoring** (`computeLineScore` via `_scoreLine`): per-word weight by class (core 1.0 / function 0.5 / adlib 0.25). `effectiveMatchScore` caps a VAD-only (unconfirmed) word at 0.25; `mergeConfirmedMatches` **removes that cap as soon as any ASR token matches the same word index** [CODE scoring.js:457-528]. Line score = `Σ weight·effectiveScore / Σ weight`; "perfect" if ≥ 0.9. A line with `lineHadAsrEvent === false` is **skipped, not zeroed** [CODE player.js:1794]. Running `#score-pct = Σ weightedMatched / Σ weightedTotal`; streak = consecutive perfect lines.

**Stage 7 — Soft boundaries & late scoring.** A `prevLine` overlay keeps the outgoing line matchable during an overlap zone (0.5–1.5 s by tempo); `_matchPrevLine` uses **boolean `wordsMatch` → writes a flat 1.0** [CODE player.js:1320-1356]. Finalize after overlap+scoreDelay; `_lateScoreLine` re-scans 800 ms later; last line scored on `ended`.

**Stage 8 — Feedback.** Word spans green (≥0.75) / amber (<0.75) / red (missed) + `asr-confirmed` flash; per-line `+matched/total` flash; `#score-pct`; end modal (%, words, perfect lines, best streak). Manual `lrcOffset ±10 s`. Debug HUD (`D`) + telemetry JSON.

**Stage 9 — Shadow phrase engine** (`phrase-engine.js`): a parallel scorer (anchors, difficulty profiles, settlement windows, source-roled evidence) that computes `lyricStatus`/`flowStatus` **live** but writes only to telemetry traces — **it does not drive the score** [CODE player.js:1924 `mode:'shadow'`, 2158]. The shadow-engine plan explicitly reserves promoting it to the live scorer as the next milestone.

---

## 2. Critical Weaknesses (ranked by severity × player impact)

**1. [CRITICAL — provider-conditional] Answer-key injection into Whisper.** On the **local faster-whisper path** the exact active-line text is sent per chunk as `X-Lyric-Hint` → `initial_prompt` **unconditionally**, with `beam_size=1` greedy decode and **no `vad_filter` / `no_speech_threshold` / `condition_on_previous_text=False`** [CODE player.js:1249-1250; app.py:82-99]. The OpenAI *file* path forwards it too [CODE app.py:110-111]. Whisper is well-documented to emit prompt tokens on silence/music/hum, so the recognizer is **primed with the answer key**: a hum, a mumble, or backing-track bleed can be transcribed *as the printed lyric*, then credited — simultaneously the highest-leverage cheese path **and** a fairness defect (a rapper who slurs half a bar is still scored as hitting it). **Scope:** the client builds a title+8-line seed for the realtime path, but the **server drops it for the default `gpt-realtime-whisper` model** [CODE app.py:136-137], so this vector is *not* active on a default realtime deployment. Severity is highest on the **local faster-whisper provider**, which CLAUDE.md's `WHISPER_DEVICE=cpu` config implies is the operative one on this machine — **verify which provider is live before prioritizing the fix.** Wiring is [CODE]; magnitude is [HUMAN].

**2. [CRITICAL — category gap] No performance dimension.** Scoring is 100% lexical. Speaking the words in a flat monotone scores identically to a pitch-perfect performance; pitch, melody, and rhythm-vs-beat are unmeasured [CODE]. For a "Guitar Hero for voice" product this is a category miss, not a tuning problem. *Note: even the intended V2 (shadow phrase engine) is lyric+flow only and does not close this gap.*

**3. [HIGH] Timing is a gate, not a graded dimension.** `windowStart/windowEnd` only decide *when* a word becomes eligible; once eligible the credited value is purely lexical, and the eligibility window is **~1.8 s (slow/normal) to ~3.0 s (fast)** wide [CODE scoring.js:465-496, sync-helpers.js:24-25]. Right-words-wrong-beat scores the same as on-beat. For rap (every line classifies "fast"), each word's window is **wider than the whole line**, so timing cannot even discriminate which word was sung [CODE].

**4. [HIGH] The VAD energy floor over-credits and is mis-calibrated.** `useVad` is on for 100% of lines, so any energy in a word's window grants 0.25 amber [CODE player.js:533, 1699]. A single sustained tone sequentially paints **every** word on a line (each window opens, "first unmatched wins") [CODE player.js:1683-1693]. Calibration is a one-shot estimate over the first 2 s of *playback* (not silence), never recalibrated [CODE]; it can silently **no-op yet still latch "ready," leaving the threshold stuck at the 0.01 default** → in a noisy room `isSpeaking` is pinned true the whole song [CODE player.js:1664-1673]; or a loud first 2 s pins it to the 0.06 cap → VAD goes deaf. `fftSize 256` (~16 ms) instantaneous RMS with no smoothing/hysteresis lets a single clack/plosive trip it [CODE player.js:1102, 1643-1648]. There is **no SNR concept** — "loud" is treated as "singing" [CODE audio-processor.js:40-54]. Mechanism [CODE]; severity [INFER]/[HUMAN].

**5. [HIGH] A noise-driven VAD guess gets uncapped to the full ASR score.** Promotion is keyed on word **index only**, with no temporal alignment to the word's window, and fires on every ASR path (browser `onresult`, whisper, prev-line, late-score). The uncapped value is whatever the ASR token scored — **as low as 0.4 (edit-2) or 0.8 (phonetic)** — and that token can be a loose fuzzy match consumed from anywhere in the 14–25-token drift window [CODE scoring.js:457-528, player.js:756-763, 1602-1603]. So mumbled phonetic-adjacent garbage promotes amber words to solid credit. [CODE]

**6. [HIGH] Quiet/soft singers are under-credited (the inverse unfairness).** `noiseSuppression:true` on the capture stream attenuates low-energy, harmonically-sparse signal — exactly soft head-voice, sustained vowels, the tails of held notes — *before* either VAD or Whisper sees it (both tap the same processed `src`) [CODE player.js:1095, 1104, 1136]. Correct quiet singing can earn neither the VAD floor nor an ASR confirmation. The system rewards belting and punishes controlled quiet singing — the opposite of a real judge. [INFER]/[HUMAN]

**7. [HIGH] Music/vocal bleed on speakers.** There is no vocal separation (no `/separate` route, no demucs in `app.py`) and the only bleed defense is browser AEC, which is unreliable on the nonlinear laptop-speaker → built-in-mic path [CODE app.py route list; player.js:1095]. On speakers (the default), the original lead vocal bleeds in and is transcribed/credited as the user. Combined with #1, the track effectively sings itself. [INFER]/[HUMAN]

**8. [MED–HIGH] Generous matching inflates false positives.** Confirmed amplifiers: `SLANG_MAP` cross-credits **ungated short homophones** (`ya↔you`, `da↔the`, `em↔them`) and collapses distinct tokens (`sit/ship/shoot→shit`, `duck/fudge→fuck`) at 0.9 [CODE match-helpers.js:72-131]; a single target word gets **~6 independent match chances** (primary + 3 SR alternatives + whisper pass capped at 4× line length + hot-word + prev-line + late-score) [CODE player.js:747-757, 1363, 1742, 1320, 1849]; the overlap pass writes a flat 1.0; the `silentPrefix` branch widens the phonetic guard [CODE scoring.js:333-334]. Dampeners (genuinely present): ≤2-char words skip fuzzy matching, the drift scan is monotonic (one spoken token → one target), and function/adlib weights are 0.5/0.25. Net mechanism [CODE]; real magnitude [INFER].

**9. [MED–HIGH] No per-song/tempo normalization; rap pins to the loosest regime.** `classifyTempo` is absolute, so every Black Moon/Wu-Tang line (>5 wps) classifies "fast" and gets the **widest windows, 25-token drift, 0.75 s chunks** — the supposedly adaptive system never adapts within a rap song, running permanently in maximum-over-credit mode [CODE sync-helpers.js:11-15, 24-28, 79-86]. The relative-tempo profile that could level within-song difficulty is inert. Dense-rap scores are inflated and indistinguishable between a clean and a sloppy run. [CODE]/[HUMAN]

**10. [MED] Backup ASR collapses on the hardest content.** Overlap chunks (the redundancy meant to cover fast rap) are gated `_whisperInFlight < 2`; on a CPU box where a 0.75 s chunk takes >0.75 s to transcribe, they're dropped exactly when chunks arrive fastest [CODE player.js:1121-1126; CLAUDE.md cpu/int8 default]. ASR lag (~0.5–1.5 s) exceeds a ~2 s rap line, so late tokens are offered to both the new line and the overlapped old line → double-credit on repeated hooks [CODE player.js:744-748, 1414-1416]. [CODE]+[INFER]

**11. [MED] Feedback latency.** Green confirmation lags singing by ~1 s (cloud SR + 1.5/0.75 s chunks + overlap + scoreDelay). The one instant signal (amber VAD) is the over-credit vector from #4. [CODE]/[INFER]

**12. [MED] LRC/YouTube drift.** A single manual global `lrcOffset`; no auto-alignment. A live-vs-studio version mismatch desyncs every window. [CODE]

**13. [LOW] `estimateSyllables` mistimes polysyllabic/slang rap** → the hot-word highlight drifts off the word actually being sung, so the karaoke follow-along is visually wrong even when the aggregate looks fine [CODE scoring.js:360-366].

---

## 3. Research Breakthrough Opportunities

**The reframe:** the engine conflates *"the recognizer output the lyric"* with *"the human performed the lyric."* Every weakness flows from that. Breakthroughs split into (i) making the lyric signal honest, and (ii) adding the missing performance axes.

**Incremental path (cheap, high-confidence, mostly pure-JS, ship first):**
- **Kill the answer-key injection** — drop `initial_prompt` from the crediting path (or keep it biasing-only) and turn on faster-whisper `vad_filter` + `no_speech_threshold` + `condition_on_previous_text=False`. Defuses #1 directly. [CODE change, [TEST]-able via pytest]
- **Bounded sequence re-alignment** replacing greedy drift matching: a windowed Needleman-Wunsch (≈ 8 targets × 20 spoken = ~160-cell DP/tick, sub-ms, **no dependency**), substitution cost = the existing `wordsMatchScore` (already embeds Double Metaphone), with gap penalties so a missed word becomes a gap instead of cascading index drift. Structurally forbids grabbing a word sung for the next line. **HIGH confidence**, verified feasible in-browser with no build step.
- **Confidence weighting** from faster-whisper `Word.probability` (already computed by `word_timestamps=True`, currently **dropped** in `app.py` — one dict key to restore) and realtime per-token logprobs (already requested). Demotes low-prob mishears that currently fire greedily. (Chrome's per-word SR confidence is unreliable, so the browser path stays uniform-weighted — a named limitation, not a universal gain.)

**Ambitious redesign path (closes the category gap):**
- **Promote the shadow phrase engine to live.** It already computes `lyricStatus`/`flowStatus` from all four source roles (`vad`=flow-only, `browser_interim`=provisional, `browser_final`=settle, `whisper`=rescue) — promotion *reads existing state*, it is not a rewrite. Surfaces separate **lyrics / timing / stability** sub-scores with per-song difficulty normalization (the `DIFFICULTY` profiles already exist). **HIGH confidence.**
- **Real word onsets via server-side forced alignment.** The server already holds `temp/audio.webm` + the LRC text — exactly the (audio, transcript) pair forced alignment consumes. `torchaudio.functional.forced_align` with a wav2vec2 model (~360 MB English) at `/load`, off the real-time path, yields true onsets → honest timing scoring + DTW anchoring. **Not in-browser feasible** (no JS/ONNX-web `forced_align`); speech models degrade on polyphonic mixes, so it needs Demucs vocal separation and confidence-gated fallback to the syllable heuristic. [verified — medium confidence]
- **Pitch sub-score** (the missing "did you sing the notes"): SPICE (the TF.js model behind Google's FreddieMeter) tracks the user's F0 in-browser. **The hard wall is the reference melody** — SPICE on a YouTube *mix* follows dominant energy (often an instrument), so a fair *absolute* pitch score requires a server Demucs vocal stem + `basic-pitch` reference. Ship a reference-free *engagement* meter (monotone-vs-melodic, no reference) first as a separate display; gate the true-melody version behind a flag. [verified — medium]
- **Rhythm/onset sub-score:** native Web Audio spectral flux on a dedicated 2048-bin AnalyserNode (**zero dependencies**), scoring onset *presence* per line + *relative* intra-line cadence (scale/offset-invariant — there's no fair absolute reference until forced alignment lands). Separate "Rhythm" stat, never a hard gate. [verified — medium]
- **Robust adaptive VAD + mic normalization:** one **raw** stream (EC/NS/AGC all off) feeding both VAD and Whisper; continuous adaptive noise-floor + separate open/close thresholds (hysteresis) + N-frame debounce + a pre-song calibration pass (all pure JS). Optional Silero-VAD (~2 MB ONNX via onnxruntime-web, vendored) / RNNoise. **HIGH confidence.** Caveat: opening a *second* AGC-off stream alongside an AGC-on one is unreliable in Chrome — use a single raw stream.

---

## 4. Recommended V2 Algorithm

Multi-axis, source-aware, alignment-based. Keep lyric matching but make it honest; add measured performance axes as **separate** sub-scores; promote the phrase engine to the live scorer.

### Data flow
```
/load (server, once per song):
  download_audio + fetch_lyrics            (existing)
  → demucs vocal stem                      (new, optional, cached)
  → wav2vec2 forced_align(stem, LRC text)  (new) → lyrics[i].words=[{word,start,end,conf}]
  → (optional) reference pitch contour per line (basic-pitch on stem)
  Fall back to estimateSyllables when align conf is low.

Client (one RAW getUserMedia, EC/NS/AGC = false):
  ├─ measurement AnalyserNode → adaptive VAD (hysteresis/debounce) + spectral-flux onsets
  ├─ pitch worklet (SPICE / YIN) → user F0 contour
  ├─ whisper chunk worklet → /transcribe (NO answer-key prompt; vad_filter on) → {words, probability}
  └─ browser SpeechRecognition → tokens

Per ASR tick:
  windowed Needleman-Wunsch( lyricLineTokens , spokenWindow )
    substitution = wordsMatchScore(spoken, target, phonetic)   # existing
    token weight = whisper word.probability (uniform on browser path)
    gaps allowed for genuine misses; monotonic; line-bounded
  → feed phrase engine evidence with source role

Per phrase (phrase engine, LIVE):
  Lyrics  = confidence-weighted anchor coverage (vad never proves a lyric)
  Timing  = sung-onset vs forced-aligned-onset deviation, tolerance + hysteresis
  Pitch   = octave-invariant DTW(user contour, reference)   # "correctness" only if stem exists; else "engagement"
  Stability = 1 − (rescue rate / rejection ratio / flow flapping)
  Composite = w_L·L + w_T·T (+ w_P·P), per-song difficulty-normalized, weights shown to player
```

### Bounded aligner (pseudocode — replaces greedy `_collectMatches`)
```
function alignSpokenToLyrics(spoken[0..m], target[0..n], conf[], gapOpen, gapExt):
  # m ≈ 20 windowed spoken tokens, n ≈ 8 line tokens → ~160 cells, sub-ms
  dp, back = score+backpointer matrices with affine gaps
  for i,j: cell = max(
      diag + wordsMatchScore(spoken[i],target[j]) * conf[i],   # align
      up   + gap(open/extend),                                  # skip spoken (insertion)
      left + gap(open/extend))                                  # skip target  (a real MISS)
  traceback → Map<targetIdx → {score, spokenIdx, conf, method}>   # one-to-one, monotonic
```

### Tunable table (current → proposed)
| Knob | Today | V2 |
|---|---|---|
| Whisper prompt | active line text (answer key) | removed from crediting; `vad_filter`+`no_speech_threshold` on |
| VAD threshold | one-shot `min(b+0.025,0.06)`, frozen | adaptive EMA floor, open/close hysteresis, debounce, pre-song calibration; AGC/NS off |
| VAD provisional | 0.25, uncaps on index match | flow-only (never lyric credit); amber = UI hint excluded from score |
| Matching | greedy drift 14/25 + 3 alts, break-on-first | single confidence-weighted bounded NW per source |
| Overlap match | boolean → flat 1.0 | graded score, not 1.0 |
| Timing | eligibility gate only | graded sub-score vs forced-aligned onsets |
| Difficulty | none | per-song normalization via existing `DIFFICULTY` profiles |
| Pitch / rhythm | none | separate sub-scores / meters |

---

## 5. Implementation Plan (staged)

**Stage 0 — Stop the bleeding (hours–days, low risk, no new deps):**
1. Remove answer-key injection from the crediting path; add `vad_filter=True`, `no_speech_threshold`, `condition_on_previous_text=False` to `_transcribe_with_model`. *(defuses #1)*
2. Make VAD-only words **flow-only** — keep amber as a UI hint, exclude from `#score-pct`. *(defuses #4/#5 over-credit)*
3. Require the promoting ASR token to fall within the word's time window (temporal alignment), not just index match. *(#5)*
4. Make the overlap prev-line pass write graded scores, not 1.0. *(#8)*
5. Add a headphones prompt; ship demucs `/instrumental` (already planned in the v2 doc, never built). *(#7)*
Covered by existing `pytest` + `.cjs` harness.

**Stage 1 — Core matching refactor [HIGH confidence]:** add pure `alignSpokenToLyrics` (NW, plain JS, CommonJS-testable) to `scoring.js`; rewire `_collectMatches` as a thin caller; carry `word.probability` through (`app.py` one-line). New `tests/test_align_helpers.cjs` with false-positive/missed-word/confidence golden cases. *(#3 partial, #8, #9)*

**Stage 2 — Robust VAD + normalization [HIGH]:** adaptive noise floor + hysteresis/debounce + pre-song calibration as pure functions in `sync-helpers.js`; switch to one raw stream; optional vendored Silero-VAD. `tests/test_vad_helpers.cjs`. *(#4, #6, #7 partial)*

**Stage 3 — Promote the shadow phrase engine to live:** `getLiveScore(session)` → lyrics/timing/stability sub-scores + difficulty normalization; drive `#score-pct` behind a flag; A/B against the old scorer via telemetry replay. *(#2 partial, #9)*

**Stage 4 — Real onsets (server forced alignment + demucs):** `align_lyric_words` at `/load` → `lyrics[i].words`; consume in `interpolateWordTimings`; add the timing sub-score against true onsets. Confidence-gated fallback. *(#3, #13)*

**Stage 5 — Pitch + rhythm sub-scores (stretch):** native spectral-flux rhythm meter (zero-dep) and SPICE pitch meter (engagement now, true-melody with stem). Separate displays, never silently blended. *(closes #2)*

**Test harness / instrumentation:** extend the existing golden `.cjs` tests; add alignment/pitch/onset/VAD fixtures; use telemetry replay for aggregate old-vs-new score deltas (**not** accuracy proof — no sung-word ground truth). Telemetry already logs `matches[]` (method/score), `promotions[]` (source/index/score/ts), `transitions[]` (weighted totals, early/late ms, `sourceCounts`), and `phraseEngine.traces` (`lyricStatus`/`flowStatus`/`rejectedCandidates`) plus benchmark intent/fairness labels — extend with per-axis sub-scores, alignment confidence, onset times, the live VAD threshold, and promotion timing.

---

## 6. Human Testing Protocol (Maurice)

This is the part that actually validates the work — automated tests cannot. Use **headphones** except where the test is about bleed. Press **D** for the debug HUD + telemetry download. Each test pairs a behavior with a prediction and the **exact telemetry field** that must move.

**Songs:** a slow ballad (clear vowels), a function-word-dense pop song, a dense rap (Black Moon / Wu-Tang). Plus the cheese probes below.

### A. Cheese probes — a fixed system must score these LOW
| # | Do this | Predict | Watch (good vs bad) |
|---|---|---|---|
| 1 | Stay silent, backing track on **speakers** | ~0% | `sourceCounts.whisper/browser_sr` should be ~0 while you're silent; `matches[]` with `method:"exact"` on un-sung words = **bad** (bleed/prompt crediting) |
| 2 | Hum one sustained tone through a line (headphones, no words) | line not cleared | amber sweep in HUD, `promotions[]` firing; `phraseEngine` `lyricStatus` must stay `missing`. Line clears = **bad** |
| 3 | Loop common words ("yeah you the I that") | low | `matches[]` crediting function words across lines you didn't sing = **bad** |
| 4 | Mumble phonetic garbage over a known line | line not cleared | `promotions[]` uncapping VAD words, `method:"phonetic"/"edit1"` hits = **bad** |

### B. Honest-singing fairness — must score WELL / dissociate axes
| # | Do this | Predict | Watch |
|---|---|---|---|
| 5 | Sing correctly, on beat | high (baseline) | reference run |
| 6 | Sing correct words, deliberately **off-beat** within window | today == #5; V2 timing sub-score drops, lyrics stays | `transitions` `earlyMs/lateMs`; new timing sub-score |
| 7 | Sing correctly but **quiet/breathy** | should ≈ #5 | sparse `matches[]` despite correct singing = the #6 fairness bug confirmed |
| 8 | Correct words, **monotone (wrong melody)** | lexical high; pitch meter drops | if pitch meter doesn't move, the pitch feature is falsified |
| 9 | Dense rap **clean vs sloppy** | clean > sloppy | equal scores ⇒ over-crediting confirmed (#9) |

### C. Environment
| # | Do this | Predict | Watch |
|---|---|---|---|
| 10 | Noisy room, **you silent** | ~0% | HUD `thr:` — stuck at `0.01` or `0.06` ⇒ calibration bug (#4); `isSpeaking` pinned = bad |
| 11 | Cheap laptop mic across the room, sing correctly | measure miss rate vs close mic | drop in `matches[]` exact rate quantifies the SNR penalty |

**Tuning loop after each test:** from telemetry, compare per-line `weightedMatched/weightedTotal` against your own honest assessment; adjust (VAD open/close thresholds, promotion window, alignment gap penalty, difficulty ratio); re-run #5–#9 to confirm fairness didn't regress. **Old-vs-new feel:** run the *same* song + behaviors on both builds; compare score distributions **and** the `matches[]` method mix — V2 should show fewer `phonetic/edit2/vad-only` credits and more in-window `exact`.

**Do not declare success** until a human confirms all three: cheese probes (A) score low, honest variations (off-beat / quiet / accent, B) score fairly, and clean-vs-sloppy rap (9) separate.

---

## 7. Final Verdict

**Redesign from the scoring core outward — but stage it; do not rewrite the app.**

The product intent ("Guitar Hero for voice / vocal performance") makes lyric-recall-only a *category* miss, and the team has already built the redesign seed (the shadow phrase engine) and explicitly reserved promoting it. The direction is therefore set. But three things must happen that the shadow engine alone does **not** deliver:

1. **Patch the two defects that make today's score weakly coupled to performance** — answer-key prompt injection (#1) and VAD-floor over-crediting/uncapping (#4/#5). These are urgent and patch-level (Stage 0).
2. **Replace greedy matching with confidence-weighted bounded alignment** (Stage 1) — the highest-confidence, lowest-cost structural win.
3. **Add the measured timing / pitch / rhythm axes** the phrase engine still lacks (Stages 4–5) — only these close the category gap.

So: patch the bleeding now, refactor the scoring core via alignment + robust VAD + phrase-engine promotion (Stages 1–3, the real work), and treat forced-alignment / pitch / onset as the research upgrades. The scoring architecture genuinely demands the core refactor; the surrounding app — capture transport, lyrics, transcription, telemetry, UI — is sound and should be **kept, not rebuilt**.

Every *feel* claim in this report is conditional. The mechanisms are confirmed from code; whether the redesign actually feels fairer, more responsive, and harder to cheese is a question only Maurice's §6 protocol can answer. **Do not claim the V2 is better until a human sings it.**
