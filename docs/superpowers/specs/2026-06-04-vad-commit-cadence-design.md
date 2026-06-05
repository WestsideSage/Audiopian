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

(Note: `getChunkSamples`'s fast-tempo small chunks ([static/sync-helpers.js:85-92](../../../static/sync-helpers.js)) drive only the **local** faster-whisper AudioWorklet via `_applyChunkTempo`, which is a **no-op on the realtime path** ([static/player.js:1059-1061](../../../static/player.js)). So it is NOT the realtime fragmentation cause and is **out of scope** here — the realtime cause is purely the 700 ms commit timer.)

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
- **Removed (V2 only):** the `setInterval(…, 700)` blind commit. (`getChunkSamples` is untouched — local-path only, see §1 note.)

### 3.2 Neural VAD — Silero v5 via `@ricky0123/vad-web`
- **Library:** `@ricky0123/vad-web` (runs Silero v5 over onnxruntime-web/WASM). It loads via plain **`<script>` tags — no build step** — exposing `vad.MicVAD.new({...})`. MicVAD owns the Silero ONNX plumbing, frame buffering, and the speech hysteresis state machine, and emits `onSpeechStart` / `onSpeechEnd` directly. We do **not** hand-roll Silero tensor plumbing or our own hysteresis.
- **Stream reuse (no second mic):** pass `getStream: () => Promise.resolve(this._whisperStream)` so MicVAD reuses Karaokee's already-open capture stream (it makes its own internal 16 kHz AudioContext from it). Override `pauseStream`/`resumeStream` to no-ops so MicVAD never stops the shared tracks. This avoids the dual-`getUserMedia` unreliability the teardown flagged.
- **Assets (self-hosted, no build step):** vendor `bundle.min.js` (vad-web), `ort.wasm.min.js` + `*.wasm` (onnxruntime-web), and the Silero model/worklet assets into `static/vendor/vad/`, served by Flask; configure `baseAssetPath` + `onnxWASMBasePath` to `/static/vendor/vad/`. **Pin** `@ricky0123/vad-web@0.0.29` + `onnxruntime-web@1.22.0` (the documented-compatible pair; 0.0.34 has a known regression).
- **Output consumed:** `onSpeechStart` → `isSpeaking = true`; `onSpeechEnd` → `isSpeaking = false` + a commit trigger (§3.1). The latched `isSpeaking` is the single signal feeding the session (§3.3).
- **Capture stream:** unchanged (`echoCancellation/noiseSuppression/autoGainControl: true`). Silero works on processed audio; holding the stream constant keeps the `gpt-realtime-whisper` audio characteristics fixed.

### 3.3 Anti-cheese gate
- `hasInWindowFlow` and the amber "flow"/provisional path switch from **raw RMS threshold** to the neural VAD's **latched voiced-speech** decision.
- **Effect:** strengthens anti-cheese — non-voice transients (tap/fan/cough) no longer satisfy the in-window-flow requirement, while genuine singing still does. The honesty boundary is otherwise unchanged: only content-matched anchors credit ≥0.75; VAD remains *flow/presence only*, never lyric proof.
- **What changes (V2 only):** `updateHotWord` currently sets `isSpeaking` from `updateVad(this._vadState, vadRms)` (RMS hysteresis, [static/player.js:1147-1151](../../../static/player.js)). MicVAD's `isSpeaking` replaces it; the RMS-hysteresis `_vadState`/`updateVad` path becomes unused on the V2 path (`vad-helpers.js` left in place — see §3.4).
- **V1 untouched:** the flag-off baseline (the one-shot `min(baseline+0.025, 0.06)` calibration, [static/player.js:1152-1168](../../../static/player.js)) is the A/B comparison and stays exactly as-is until the flag-flip.
- **Acknowledged limit:** Silero fires on **humming** (voiced) — humming-the-melody cheese is the pitch axis's job, not this increment's.

### 3.4 Module boundaries (testability)
- **MicVAD owns the VAD state machine** (Silero plumbing + hysteresis) — no new pure VAD helper needed, and `vad-helpers.js` is **not** modified (it stays in place, still `.cjs`-tested; it becomes unused on the V2 path — optional cleanup once MicVAD is the confirmed default, out of scope here).
- **New pure module `static/commit-helpers.js`** — the only new pure logic: the commit-cadence state machine. `createCommitState()`, `noteSpeechStart(s)`, `noteSpeechEnd(s, nowMs) → {commit}`, `checkCap(s, nowMs, tempoClass) → {commit}`, `noteCommitted(s, nowMs, stillSpeaking)`, and `capMsForTempo(tempoClass)`. No DOM/onnx imports; golden `.cjs` tests (`tests/test_commit_helpers.cjs`).
- **`static/player.js`** — impure glue only: create/destroy the MicVAD instance (reusing `_whisperStream`); its `onSpeechStart`/`onSpeechEnd` callbacks update `this.isSpeaking` and drive `commit-helpers`; `updateHotWord`'s 100 ms tick runs the cap check and relays `isSpeaking` to the session. Replaces `_startRealtimeWhisperCommitTimer`'s blind interval and the V2 RMS read.

### 3.5 Data flow (after)
```
mic → getUserMedia (EC/NS/AGC on, unchanged; one shared _whisperStream)
    ├→ WebRTC track → OpenAI realtime audio buffer (continuous, as today)
    └→ MicVAD (vad-web, reuses the stream): Silero + hysteresis → onSpeechStart / onSpeechEnd
          → this.isSpeaking (+ commit-helpers state machine)
              ├→ onSpeechEnd / cap-exceeded → dc.send(input_audio_buffer.commit)
              │      → gpt-realtime-whisper transcribes a COHERENT phrase → whisper final → phrase engine
              └→ updateHotWord setEnergy relay → flow events → hasInWindowFlow / amber (voiced-speech, not RMS)
```

## 4. Testing & validation (honesty-gated)

1. **Automated:** all `.cjs` + pytest suites green, plus new golden tests:
   - `commit-helpers`: speech-end fires a commit; cap fires on continuous speech; no commit without speech since last commit (empty-buffer guard); no double-commit; tempo cap values. (MicVAD owns VAD hysteresis — covered by the library, not re-tested here.)
2. **Replay corpus:** re-run the 5 real Expert telemetry runs — assert (a) `whisper` finals are **coherent multi-word phrases** (fragment rate down), (b) **per-song interim-reconciled honest-% does NOT regress** (Silero endpoint lag vs. the strict `hasInWindowFlow` window — mitigation: raise `RECONCILE_FLOW_GRACE_MS` above 0; **potentially blocking**, see §5), and (c) **`summary.honesty.suspectedCheeseInflation` stays clean**.
3. **Live sing-test (the flag-flip gate — only a human can):** cheese probes — silence-on-headphones, humming, "yeah yeah", mumbling, **finger-taps/noise** (the new gate should *improve* this) — must NOT build points or lift the multiplier; honest-but-sloppy scores fair. **Judge the win by recognition *coherence* (fragment-rate down / whisper clear-rate up), not raw latency** — the cap commits less often than the old 700 ms, so honest-% is expected near-flat (flat + cleaner anti-cheese = success). Set `benchmarkIntent` and scan the saved JSON.

**Do not flip `karaokee_v2` default-on until the live sing-test passes** (standing, non-negotiable gate).

## 5. Risks / unknowns
- **ort-web WASM hosting** — known `@ricky0123/vad-web` 404/path friction (issues #230/#234); an integration cost, not a blocker.
- **Silero endpoint lag vs. the anti-cheese window (the load-bearing risk).** Silero confirms speech-start/end a few frames late (~100-300 ms redemption). The interim-reconciliation path (~55% of the honest score) is gated by `hasInWindowFlow` at `RECONCILE_FLOW_GRACE_MS = 0` (strict, from `06dfde5`), so a late `isSpeaking` flow event can fall outside the window and under-credit honest singing. **Mitigation:** raise `RECONCILE_FLOW_GRACE_MS` above 0; validate on the replay corpus (§4.2) — **potentially blocking before flag-flip.**
- **Silero endpoint lag may also blunt commit timing** → TEN VAD is the fallback A/B (smaller, claims faster transitions).
- **First on-device model** — adds onnxruntime-web to the page weight; runs on the main thread (frame-rate inference must stay cheap; Silero RTF ≪ 1, fine).
- **Tempo-cap tuning** — starting values are guesses; tune against the replay corpus + sing-test.

## 6. Rollout
- Branch: `feat/vad-commit-cadence`.
- Behind `karaokee_v2`; legacy energy-gate + 700 ms path remain when the flag is off (A/B preserved).
- Sequence: pure helpers + tests → ort-web Silero wiring → swap commit trigger + flow gate behind flag → replay-corpus validation → user live sing-test → (later) flag-flip decision.
