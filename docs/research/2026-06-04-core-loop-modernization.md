# Core Gameplay Loop — Modernization Research

**Date:** 2026-06-04
**Question:** What should be the next major architectural milestone for Karaokee's core loop (mic → VAD → ASR → match-known-lyrics → timing → score)? Full survey, cloud vs. local, weighing accuracy/fairness · latency · cost · simplicity equally.
**Method:** 107-agent deep-research fan-out (5 angles → 25 sources → 121 claims → 24 verified / 1 refuted), then grounded against the [2026-06-02 voice-detection teardown](../audits/2026-06-02-voice-detection-scoring-teardown.md), the [2026-04-20 autopsy](../audits/2026-04-20-full-repository-autopsy.md), and the arcade-scoring telemetry battle log. Raw report: see the deep-research task output (`wfytgn1z8`).

> **Evidence tags:** [WEB] = externally cited & adversarially verified · [CODE/TELEM] = confirmed from this repo's code, audits, or telemetry · [INFER] = reasoned synthesis across the two.

---

## 0. The one finding that matters

**Exploiting the known lyrics (forced alignment / pronunciation scoring) does NOT fix the anti-cheese honesty problem. No ASR-based paradigm does. Cheese-resistance lives entirely in confidence/energy thresholds — forever.** [WEB]

- Goodness-of-Pronunciation scoring against known text: **~30% false-accept** on disordered read speech (Pellegrini 2014); best-recall GOP variant = **precision 0.189 at recall 0.919** (Parikh 2025) — a re-balanceable operating point, i.e. the honesty knob is the *threshold*, not the *method*. [WEB]
- Whisper free-ASR **hallucinates real tokens on silence/instrumental** ("Thank you.", music descriptions); LyricWhiz only suppressed it with a hand-set `no_speech_probability > 0.9` cutoff. [WEB]

**Why this is the headline for *us specifically*:** every anti-cheese fix in the arcade-scoring history has been a *threshold or energy gate* — the one-shot VAD floor `min(baseline+0.025, 0.06)`, the `minStartSec` forward-only floor, the `hasInWindowFlow` energy gate for interim reconciliation, the `RECONCILE_FLOW_GRACE_MS` knob — and the **KNOWN RESIDUAL** (skipping a line *immediately identical* to one just sung still over-credits, because "no presence-based signal separates them") is the exact wall the research predicts is structural. [CODE/TELEM] The research is external, cited confirmation that **we have not been failing to find the fix — there is no fix on the lyrics axis.** [INFER]

**The strategic consequence:** stop trying to make the *lyric* scorer cheese-proof — it can't be. The way forward is **defense-in-depth: a second, orthogonal axis that doesn't depend on word recognition at all — pitch/melody.** Pitch scoring is *also* threshold-bound (cents tolerance, timing tolerance — same knob shape). It is **not** a silver bullet. What it buys is that **cheese now has to defeat two independent gates at once** — right words *and* right melody *and* on time — and producing sustained, pitched vocalization that tracks a melody is intrinsically singing-like in a way "yeah yeah yeah" tripping an energy gate is not. This is also exactly the "category gap" the teardown flagged as CRITICAL #2 ("a flat monotone scores identically to a pitch-perfect performance") [CODE/TELEM], and it's how real karaoke games (SingStar, Smule) score — *because pitch is harder to fake than words, not impossible to fake.* [WEB, thin — see §7]

---

## 1. The four objectives — honest verdict

| Objective | Verdict | Why |
|---|---|---|
| **Accuracy — recognition** ("did-sing": credit words they *did* sing) | **Directly improvable — and it's your most-logged pain** | The "evidence-starved Expert / said-it-but-scored-missed" reds are a *recognition* failure: `browser_sr` transcribes perfectly but as `interim` (never `final`), and `gpt-realtime-whisper` arrives as sub-second fragments [TELEM]. A recognizer with **real finals + word timestamps** fixes this head-on. This is a **fairness win for honest-but-poorly-recognized singers** — Path A. |
| **Fairness — anti-cheese** ("didn't-sing": *don't* credit words they didn't) | **Threshold-bound forever on lyrics; needs a 2nd axis** | This is the §0 finding. Sung-audio WER is also structurally bad (Whisper large-v3 = **35.5% WER on Jam-ALT** vs ~2–10% clean [WEB]); "**ASR coverage is the ceiling on the honest %**" [TELEM]. No recognizer makes *this* honest. Pitch (defense-in-depth) is the leverage — Path B. |
| **Latency** | **Architectural — fixable, and we know the exact cause** | The "catching up" lag is *not* model speed. Our YAH telemetry pinned it: a blind **700 ms `setInterval` commit** + **no `turn_detection`** for `gpt-realtime-whisper` → sub-second fragments [TELEM]. Research confirms the pattern: Whisper zero-pads every clip to 30 s; Moonshine spends compute only on real input (**73 ms vs 1940 ms** short-phrase) [WEB]; streaming endpointing dominates. Fix = semantic-VAD endpointing, not blind intervals. |
| **Cost** | **Real lever, mostly via consolidation** | `gpt-realtime-whisper` is the priciest path. Cloud streaming alternatives: AssemblyAI Universal-Streaming **$0.15/hr** (session-billed) [WEB]. Local self-host (Kyutai) or in-browser (Moonshine/Whisper) = compute only [WEB]. |
| **Simplicity** | **Big win — collapse the dual recognizer, retire the *interim* hack** | We run **two** flaky recognizers (Web Speech `browser_sr` + `gpt-realtime-whisper`). One controllable streaming ASR with real finals + word timestamps lets us **delete the interim-snapshot workaround specifically** — `reconcileInterimSnapshot`, the prefix/segment-reset detection, the `_interimFloorSec` floor — which exists *only* because Chrome won't fire `final` during continuous singing [TELEM]. **Caveat:** late-evidence *attribution* (`reconcileLateEvidence`) is **not** deletable — a word sung at 1.9 s into a 2.0 s line and emitted at 2.3 s lands after the line closes no matter how clean the ASR is. The late-attribution core survives; the interim kludge dies. |

---

## 2. Component landscape (cited)

### 2a. Neural VAD — low-risk drop-in [WEB]

| Option | Browser? | Size | Notes |
|---|---|---|---|
| **TEN VAD** | ✅ WASM+JS | **277 KB** | RTF ~0.010 web; claims faster speech→non-speech transition than Silero (vendor-reported). [WEB] |
| **Silero via `@ricky0123/vad-web`** | ✅ ONNX/WASM | ~2.2 MB | `onSpeechStart/onSpeechEnd` API; use the core `vad-web` pkg (we have **no build step / no React**). [WEB] |
| *our energy gate* | n/a | 0 | Cannot separate voice from a mix; singing is systematically misclassified as speech. [WEB] |

> **Our nuance:** music-bleed is *less* urgent for us than the generic case — the singer is on **headphones (DT 900 PRO X), bleed ruled out by control test** [TELEM]. So a neural VAD's value for us is **endpointing + latency + future speaker-users**, not bleed defense. Still worth it, but right-size the motivation.

### 2b. Cloud streaming ASR [WEB — coverage thin, see §7]

| Vendor | Latency | Price | Word timestamps | Verified? |
|---|---|---|---|---|
| **AssemblyAI Universal-Streaming** | ~300 ms median word emission | **$0.15/hr** session-billed (premium tier $0.45) | ✅ | ✅ 3-0 |
| Deepgram Nova-3 | ~280–516 ms (metric-dependent) | — | ✅ | ⚠️ only as AssemblyAI's foil |
| OpenAI Realtime / `gpt-4o-transcribe` (**our current**) | — | highest | ❌ no usable word timestamps [TELEM] | ✗ not independently verified |
| Google / Azure / Speechmatics / Soniox / Gladia | — | — | — | ✗ no surviving claims |

> ⚠️ **Refuted claim worth heeding:** AssemblyAI tokens are **NOT** immutable — they get revised after first emit (0-3 refuted) [WEB]. That's the exact trap we already hit (interim revisions re-exposing credited words → the `minStartSec` floor fix). Whatever streaming ASR we pick, **don't commit scoring on the first interim token.** [INFER]

### 2c. Local / on-device / browser ASR [WEB]

| Option | Where | Latency | Timestamps | License | Notes |
|---|---|---|---|---|---|
| **Kyutai STT `stt-1b-en_fr`** | self-host | 500 ms (→~125 ms flush trick) | ✅ ~80 ms grid | CC-BY-4.0 | **built-in semantic VAD** — directly fixes our blind-commit fragmentation. Needs a GPU box. |
| Kyutai STT `stt-2.6b-en` | self-host | 2.5 s | ✅ | CC-BY-4.0 | accuracy-optimized; too laggy for live. |
| **Moonshine** (streaming) | browser/edge | variable-window, ~73 ms small | partial | MIT-ish | spends compute only on real input → kills short-phrase lag. WER>100% on <1 s segments. |
| Whisper via **transformers.js v3 + WebGPU** | browser | varies | segment | MIT | `pipeline('automatic-speech-recognition','onnx-community/whisper-tiny.en',{device:'webgpu'})`; "100x faster than WASM" is marketing — WASM often wins for small models. |

### 2d. The closed-problem path — forced alignment [WEB]

- We already hold `temp/audio.webm` + LRC text server-side at `/load` — the exact `(audio, transcript)` pair forced alignment consumes. [CODE/TELEM]
- **HMM aligners out-time neural ones at every tolerance:** MFA vs WhisperX vs MMS = **89.4 / 82.4 / 75.7%** correct @50 ms on TIMIT; mean error MFA 21.9 ms < WhisperX 34.3 ms [WEB].
- **Hybrid is best:** neural ASR wins WER, HMM wins timing → "neural transcript + HMM timing" [WEB, the recommendation rests on a 2-1 vote].
- **But:** all benchmarks are clean *speech*, not singing; aligners degrade on sung/polyphonic audio → needs a **vocal stem** first; **not in-browser feasible** (no JS `forced_align`). [WEB + CODE/TELEM]
- **Cheese truth:** forced alignment will happily map expected phonemes onto mumbling/silence — it fixes **timing**, not **honesty**. [WEB]

### 2e. The new axis — pitch / melody [WEB: thin; CODE/TELEM: flagged CRITICAL]

- Commercial karaoke (SingStar, Smule, Rock Band) scores **pitch + timing, not lyric content** — because it's harder to cheese and doesn't depend on recognizing slurred words. [WEB, attributed]
- In-browser pitch tracking: **SPICE** (TF.js, the model behind Google's FreddieMeter), CREPE, pYIN/YIN, native AnalyserNode autocorrelation. [WEB — but **zero claims survived verification**, see §7]
- **The hard wall (from our own teardown):** SPICE on a YouTube *mix* follows the loudest instrument, not the vocal → a fair **absolute** pitch score needs a **server Demucs vocal stem + reference pitch** (`basic-pitch`/CREPE). A **reference-free engagement meter** (monotone vs melodic) ships with no reference. [CODE/TELEM]

### 2f. Evaluation substrate — stop trusting clean-speech WER [WEB]

- **Jam-ALT** — 79 Creative-Commons songs, 4 languages, MP3 **with backing instrumentals**, ships with the `alt-eval` metrics package. This is how we A/B candidates on *sung-over-backing-track* audio instead of vendor marketing numbers. DALI / DSing / MIREX are adjacent. [WEB]

---

## 3. The Demucs insight (why B and C are cheaper together)

Both the **pitch axis** (§2e: needs a vocal stem for a fair reference) and **forced alignment** (§2d: needs a vocal stem to not degrade on the mix) depend on the *same* server-side step: **Demucs vocal separation at `/load`, cached.** Build that pipeline once and you unlock honest timing *and* honest pitch from one piece of infrastructure. [INFER]

> **Demucs is recoverable, not unknown territory** (git history, [CODE/TELEM]): we *built* a full vocal-separation feature — `vocal_remover.py`, `/separate` + `/separate-status` + `/instrumental` routes, auto-kick on `/load`, even **upgraded to `htdemucs_ft` "for better vocal isolation"** (commit `1d998a1`). It was "**disabled for rapid testing (re-enable comments in place)**" (`6b20d24`) then removed as cleanup of a "disabled and half-wired" feature (`063bb13`) — **not** abandoned on a quality verdict. So revival is cheap; the *only* real constraint is the load-time latency that made you shelve it — and pitch-reference / forced-alignment are one-time `/load` steps off the realtime path anyway, so "slow at load, cached" is acceptable by design.

---

## 4. Three milestone paths (Karaokee-specific)

### Path A — **Consolidate & modernize the recognizer** *(recommended first)*
**Do:** Replace **both** the Web Speech path *and* `gpt-realtime-whisper` with **one controllable streaming ASR that fires real finals WITH word timestamps and has semantic-VAD endpointing.** Add a neural VAD (TEN/Silero) for the energy gate. **Retire the interim-snapshot workaround** (`reconcileInterimSnapshot` + segment-reset detection + `_interimFloorSec`) — keep `reconcileLateEvidence` (late attribution is fundamental, see §1).
- **Cloud:** AssemblyAI Universal-Streaming (~300 ms, $0.15/hr, word ts) or Deepgram Nova-3.
- **Local/free/private:** self-host **Kyutai `stt-1b-en_fr`** (500 ms, word ts, semantic VAD, CC-BY-4.0) — needs a GPU box; or in-browser Moonshine/Whisper (zero infra, accuracy cost).
- **Hits:** latency (semantic endpoint ≫ blind 700 ms commit), the **recognition/fairness** failure mode (real finals + word ts → fewer "said-it-but-scored-missed" reds), simplicity (one recognizer, retire the interim kludge), dependency-risk (no Chrome lock-in), cost (if local), and **word timestamps unlock honest timing later**.
- **Does NOT fix:** anti-cheese (still threshold-bound), the category gap (still lyrics-only), the sung-audio WER ceiling.
- **⚠️ The core bet is unverified — de-risk before committing.** `browser_sr` (Google) currently carries **~55% of the honest score and transcribes "perfectly"** [TELEM], and it's **free**. The research came back thin on cloud-ASR-*on-singing* (only AssemblyAI survived, not on sung audio). So "the replacement recognizes sung lyrics ≥ Chrome" is an **assumption**. Mitigation: **bench candidates on our own telemetry corpus + Jam-ALT *first*** (we have the substrate). 
- **Cheaper increment that captures most of the latency win without betting the load-bearing path:** fix the **700 ms blind commit + add `turn_detection`** on `gpt-realtime-whisper`, and add **neural-VAD endpointing**, on the *existing* dual-recognizer stack. Do this first; it's low-risk and may make the full swap optional.
- **Cheese risk:** unchanged. **Effort:** medium (full swap) / low (the increment). **Risk:** medium — replacing the path carrying ~55% of the honest score; **the sing-test gate still applies.**

### Path B — **Add the pitch axis** *(defense-in-depth + closes the category gap)*
**Do:** In-browser pitch tracking (SPICE/CREPE/YIN) → user F0 contour as a **separate** sub-score. Ship reference-free "expressiveness" first; gate true-melody scoring behind the **Demucs stem + reference pitch**. Never silently blend into the lyric %.
- **Hits:** **anti-cheese as defense-in-depth** (an orthogonal gate independent of word recognition — cheese must now beat words *and* melody *and* timing) and **sidesteps the WER ceiling for the new axis** (pitch tracking doesn't care that "deuteronomy" was misrecognized). Closes the "Guitar Hero for voice" category gap.
- **Cheese truth (honest):** pitch is *also* threshold-bound (cents/timing tolerance) — it does **not** end threshold-tuning. It is *harder* to cheese, not *un*-cheeseable (you can la-la-la the melody) — but la-la-la-ing the correct melody on time **is a real skill** that arguably *should* score; lyrics+pitch combined is very hard to fake. [INFER]
- **Cheese risk:** materially better than any lyrics-only approach, but still a knob. **Effort:** medium-high (Demucs server step + pitch worklet + reference extraction). **Research gap:** this is the **thinnest-covered area** (§7, zero verified claims) — **needs a focused second dive before it earns the budget.**

### Path C — **Alignment-first timing** *(closed-problem, rides on B's stem)*
**Do:** Server-side forced alignment at `/load` (wav2vec2/torchaudio CTC, or MFA for best timing) on the **Demucs vocal stem** → true per-word onsets → graded **timing** sub-score (right-words-wrong-beat finally scores differently; today timing is only a gate, and on rap the window is wider than the whole line [CODE/TELEM]).
- **Hits:** timing accuracy (the closed problem done properly), DTW anchoring, better hot-word follow-along.
- **Cheese truth:** **does NOT fix honesty** — relocates it to GOP/confidence thresholds (~30% false-accept regime). A timing upgrade, not an honesty upgrade. Set expectations accordingly.
- **Cheese risk:** unchanged. **Effort:** medium-high. Shares the Demucs infra with B.

---

## 5. Recommendation & sequencing

1. **Path A first** — but **start with the cheap increment** (fix the 700 ms commit + `turn_detection` + neural-VAD endpointing on the existing stack), and **bench replacement recognizers on our telemetry + Jam-ALT before** doing the full swap. Rationale: it's the cleanest multi-objective win (latency + recognition-fairness + simplicity + cost + dependency-risk), it directly attacks your *most-logged lived pain* (recognition, not cheese), and a clean recognizer with **word timestamps** is the foundation everything downstream wants. Highest-value sub-move once de-risked: **collapse to one recognizer and retire the interim kludge** — the biggest simplicity dividend in the codebase, directly serving the "tear out the hand-tuned heuristics" goal.
2. **Path B is the most promising *direction* for the anti-cheese objective — pending a focused pitch-validation dive (§7).** The research's hard verdict (anti-cheese is structurally unwinnable on the lyrics axis) is *why* an orthogonal pitch axis matters. But pitch is exactly the area where **zero claims survived verification**, so it has **not** earned "the milestone" status yet. **Resolve the gap before funding it:** run the pitch/melody + Demucs research dive (§7.1, §7.3); if it holds up, promote Path B to the headline milestone and build the Demucs stem here.
3. **Path C as an enhancement that rides B's Demucs stem** — fold in honest timing once the stem exists.

Everything stays behind `karaokee_v2` and **nothing flips to default until the human sing-test passes** — the standing, non-negotiable gate. The research doesn't change that; it *reinforces* it (every false-accept number is a reminder the threshold can only be validated by a human singing the cheese probes). [CODE/TELEM]

What this milestone does **not** require: rebuilding the app. The capture transport, lyrics pipeline, telemetry, and UI are sound (both audits agree). This is surgery on the recognizer + scoring axes, not a rewrite.

---

## 6. Caveats (from the research itself)

- **Domain mismatch is the dominant caveat.** Nearly every benchmark is clean *read/conversational speech*, not sung-over-backing-track. The timing orderings (MFA > neural) and false-accept numbers (~30%) are **proxies** for the singing case, not measurements of it. No surviving claim *directly* measured forced-alignment false-accept on humming/silence. [WEB]
- **Vendor self-benchmarks:** TEN VAD & Moonshine speed figures and AssemblyAI's "41% faster than Deepgram" are first-party, undisclosed methodology — treat as attributed marketing. [WEB]
- **WebGPU "100x faster than WASM"** is a headline best-case; WASM often wins for our profile (small models, short phrases). [WEB]
- **Time-sensitivity:** pricing and model availability (Kyutai/Moonshine/TEN are all 2025 releases) shift; figures current ~mid-2026. [WEB]

---

## 7. Where the research came back thin (→ follow-up dives)

These are the gaps to close *before* committing budget to the path they gate:

1. **Pitch / melody scoring (gates Path B — the most important): ZERO claims survived verification.** No verified evidence on SPICE/CREPE/pYIN/aubio accuracy, in-browser latency, reference-extraction quality, or how cheeseable pitch actually is. This is the thinnest area and it's the differentiator.
2. **Cloud ASR head-to-head (gates Path A vendor choice):** only AssemblyAI survived. No verified Deepgram Nova-3 / Kyutai / Soniox / OpenAI-Realtime numbers on *short noisy sung phrases with word timestamps*.
3. **Music source separation in the browser / at low latency (gates B + C):** Demucs/Spleeter feasibility, latency, and accuracy uplift were named but produced no surviving claim — the most direct technical answer to both the reference-melody and the alignment-on-mix problems is unquantified.
4. **No integrated, end-to-end-on-singing benchmark exists** for any candidate stack — all three paths rest on component-level evidence. Jam-ALT is the substrate to build one.

---

## 8. Key sources

- Jam-ALT sung-lyrics benchmark — arXiv 2311.13987 · github.com/audioshake/alt-eval
- GOP false-accept — hal.science/hal-04080790 (Pellegrini 2014) · arXiv 2506.12067 (Parikh 2025)
- Whisper hallucination on silence/instrumental — arXiv 2306.17103 (LyricWhiz) · 2505.12969 (Calm-Whisper)
- Forced-alignment timing (MFA > neural) — Rousso et al., Interspeech 2024 (isca-archive) · arXiv 2509.09987
- Singing WER degradation — arXiv 2311.13987 (Jam-ALT Table 1) · 2306.17103 (LyricWhiz Table 3)
- Neural VAD — github.com/TEN-framework/ten-vad · github.com/ricky0123/vad · SR-SAD arXiv 2512.09713
- Streaming ASR — assemblyai.com/blog/introducing-universal-streaming · kyutai.org/stt
- Low-latency on-device — github.com/moonshine-ai/moonshine (arXiv 2410.15608) · huggingface.co/blog/transformersjs-v3
