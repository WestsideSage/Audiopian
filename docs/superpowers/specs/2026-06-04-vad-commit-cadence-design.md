# VAD-driven Commit Cadence + Unified Neural VAD — Design

**Date:** 2026-06-04
**Status:** Design approved (brainstorming); pending implementation plan.
**Flag:** all behavior change gated behind `karaokee_v2`; the live sing-test gates any flag-flip to default-on.
**Motivation:** the "cheap latency increment" identified in [docs/research/2026-06-04-core-loop-modernization.md](../../research/2026-06-04-core-loop-modernization.md) (Path A) — addresses the *recognition* failure mode (the "said-it-but-scored-missed" reds) and the architectural "catching-up" lag, and modernizes the VAD.

---

## 1. Problem

Two coupled defects in the realtime recognition path, both diagnosed from telemetry (the YAH Expert run, `output_telemetry/2026-06-04/...01-26-16.json`):

1. **Blind commit cadence → fragmented transcripts.** `_startRealtimeWhisperCommitTimer` ([static/player.js:599-615](../../../static/player.js#L599)) fires `input_audio_buffer.commit` on a **`setInterval(…, 700)`** — every 700 ms regardless of speech state. On dense/continuous singing the model transcribes sub-second slices in isolation (`"I got"`, `"Okay"`, `"Today"`), so the phrase engine — which trusts only `whisper` finals + `browser_final` — is **evidence-starved** on hard content. `gpt-realtime-whisper` has **no `turn_detection`** configured ([static/realtime-whisper.js:59-66](../../../static/realtime-whisper.js#L59)), so nothing aligns commits to speech boundaries.
2. **Hand-rolled energy VAD is brittle and over-credits noise.** The energy gate uses a one-shot calibration `min(baseline+0.025, 0.06)` over the first 2 s of *playback* ([static/player.js:~1664](../../../static/player.js)) that can silently pin to the `0.01` floor (noisy room → `isSpeaking` always true) or the `0.06` cap (loud start → VAD deaf). Any energy — a finger tap, fan, cough — can satisfy the `hasInWindowFlow` anti-cheese gate, because RMS cannot tell *voice* from *noise*.

The counterproductive corollary: `getChunkSamples` ([static/sync-helpers.js:85-92](../../../static/sync-helpers.js#L85)) uses **smaller** 0.625 s chunks on fast tempo "to commit sooner" — which *increases* fragmentation exactly where it hurts most.

## 2. Goals / Non-goals

**Goals**
- Commit `gpt-realtime-whisper` audio on **speech boundaries** (+ a bounded safety cap) so finals arrive as coherent phrases.
- Replace the energy gate with a **neural VAD (Silero v5)** that supplies a *voiced-speech* signal to both commit-triggering and the anti-cheese `hasInWindowFlow` gate.
- Reduce the recognizer "catching-up" lag on fast/dense songs.
- Keep the pure-helper / `.cjs`-test architecture; keep `player.js` as the only DOM/IO-bound file.

**Non-goals (explicitly out of scope for this increment)**
- The **pitch axis** (the anti-cheese *structural* fix) — separate milestone (Path B).
- Switching the capture stream to **raw** (EC/NS/AGC off) — a later tuning lever; keeping the stream constant isolates "commit timing + VAD" as the only changed variables.
- Replacing the cloud recognizer / Web Speech path (the larger Path A consolidation) — not this increment.
- Fixing the **repeated-hook KNOWN RESIDUAL** — needs pitch; not claimed here.
- TEN VAD (considered; Silero chosen for anti-cheese-safety — TEN is a documented fallback A/B if Silero endpoint lag bites).

## 3. Design

### 3.1 Commit cadence
- **Primary trigger:** on neural-VAD **speech-end** (breath/phrase boundary), send `input_audio_buffer.commit`. The model then transcribes a whole phrase.
- **Safety cap:** if speech is continuous past a **tempo-aware max** (`fast ≈ 1.5 s`, `normal ≈ 2.0 s`, `slow ≈ 2.5 s` — starting values, tunable), force a commit at the cap so breathless rap still flushes and worst-case latency is bounded.
- **No-op guard:** never commit an empty/near-empty buffer (no speech since last commit) — avoids spurious empty transcriptions.
- **Mechanism unchanged:** still client-driven `input_audio_buffer.commit` over the data channel — the *proven* path (it's what runs today). Only the *trigger* changes. Server `server_vad` is **not** used (unverified for `gpt-realtime-whisper`; the manual path is known-good).
- **Removed:** the `setInterval(…, 700)` timer; the fast-tempo small-chunk behavior in `getChunkSamples` (fast tempo now commits on phrasing + cap, not pre-fragmentation).

### 3.2 Neural VAD (Silero v5)
- **Model:** Silero VAD v5 (`silero_vad.onnx`), run via **onnxruntime-web (WASM)** on the **main thread**, consuming the audio frames the existing AudioWorklet already posts ([static/audio-processor.js](../../../static/audio-processor.js)). This is Karaokee's first on-device model.
- **Assets (no build step):** vendor `silero_vad.onnx` + the `onnxruntime-web` WASM/JS into `static/vendor/` (or similar), served by Flask; load via `<script>` + configured `onnxWASMBasePath`. Reference integration: `@ricky0123/vad-web` (use the core, not the React binding — Karaokee has no build step).
- **Output:** per-frame speech probability → fed into the (pure) debounce/hysteresis layer (§3.4) → a latched `isSpeaking` + speech-start/speech-end edges.
- **Capture stream:** unchanged (`echoCancellation/noiseSuppression/autoGainControl: true`). Silero works on processed audio; holding the stream constant keeps the `gpt-realtime-whisper` audio characteristics fixed.

### 3.3 Anti-cheese gate
- `hasInWindowFlow` and the amber "flow"/provisional path switch from **raw RMS threshold** to the neural VAD's **latched voiced-speech** decision.
- **Effect:** strengthens anti-cheese — non-voice transients (tap/fan/cough) no longer satisfy the in-window-flow requirement, while genuine singing still does. The honesty boundary is otherwise unchanged: only content-matched anchors credit ≥0.75; VAD remains *flow/presence only*, never lyric proof.
- **Removed:** the one-shot energy calibration (`_vadBaseline`, `min(baseline+0.025, 0.06)`, the "ready-latch" path).
- **Acknowledged limit:** Silero fires on **humming** (voiced) — humming-the-melody cheese is the pitch axis's job, not this increment's.

### 3.4 Module boundaries (testability)
- **`static/vad-helpers.js`** (already pure) — extend the debounce/hysteresis state machine to consume the neural VAD's frame **probability** (open/close thresholds + N-frame debounce already model this; generalize `updateVad` to take a probability in `[0,1]` rather than only RMS, or add a sibling). Stays `.cjs`-testable; **no** onnxruntime import here.
- **New pure commit-trigger helper** — `shouldCommit(state, msSinceLastCommit, tempoClass) → boolean` (speech-end edge OR cap exceeded; with the empty-buffer guard expressed as state). Lives in `sync-helpers.js` or a new `commit-helpers.js`; golden `.cjs` tests.
- **`static/player.js`** — impure glue only: run ort-web inference on posted frames → pure `vad-helpers` → pure commit-trigger → `dc.send(commitEvent)`; and feed the latched voiced-speech signal to the `hasInWindowFlow` path. Replaces `_startRealtimeWhisperCommitTimer`'s interval body and the energy-gate read.

### 3.5 Data flow (after)
```
mic → getUserMedia (EC/NS/AGC on, unchanged)
    → AudioWorklet (audio-processor.js) posts frames + (legacy RMS, now unused for gating)
    → [main thread] onnxruntime-web Silero VAD  → per-frame speech prob
        → vad-helpers (pure): debounce/hysteresis → isSpeaking + speech-start/end edges
            ├→ commit-trigger (pure): speech-end OR tempo cap → dc.send(input_audio_buffer.commit)
            │      → gpt-realtime-whisper transcribes a COHERENT phrase → whisper final → phrase engine
            └→ hasInWindowFlow / amber flow  (voiced-speech, not RMS)
```

## 4. Testing & validation (honesty-gated)

1. **Automated:** all `.cjs` + pytest suites green, plus new golden tests:
   - commit-trigger: speech-end fires; cap fires on continuous speech; empty-buffer no-op; no double-commit.
   - vad-helpers: probability-driven hysteresis/debounce (open/close, N-frame).
2. **Replay corpus:** re-run the 5 real Expert telemetry runs through the harness — assert `whisper` finals arrive as **coherent multi-word phrases** (fragment rate down) and **`summary.honesty.suspectedCheeseInflation` stays clean** (no cheese regression).
3. **Live sing-test (the flag-flip gate — only a human can):** cheese probes — silence-on-headphones, humming, "yeah yeah", mumbling, **finger-taps/noise** (the new gate should *improve* this) — must NOT build points or lift the multiplier; honest-but-sloppy scores fair; **latency visibly improves on a dense rap**. Set `benchmarkIntent` and scan the saved JSON.

**Do not flip `karaokee_v2` default-on until the live sing-test passes** (standing, non-negotiable gate).

## 5. Risks / unknowns
- **ort-web WASM hosting** — known `@ricky0123/vad-web` 404/path friction (issues #230/#234); an integration cost, not a blocker.
- **Silero endpoint lag** (~few-hundred-ms reported) could blunt the latency win → TEN VAD is the fallback A/B (smaller, claims faster transitions).
- **First on-device model** — adds onnxruntime-web to the page weight; runs on the main thread (frame-rate inference must stay cheap; Silero RTF ≪ 1, fine).
- **Tempo-cap tuning** — starting values are guesses; tune against the replay corpus + sing-test.

## 6. Rollout
- Branch: `feat/vad-commit-cadence`.
- Behind `karaokee_v2`; legacy energy-gate + 700 ms path remain when the flag is off (A/B preserved).
- Sequence: pure helpers + tests → ort-web Silero wiring → swap commit trigger + flow gate behind flag → replay-corpus validation → user live sing-test → (later) flag-flip decision.
