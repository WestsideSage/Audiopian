# VAD-driven Commit Cadence + Unified Neural VAD — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the blind 700 ms realtime-whisper commit clock and the V2 RMS energy gate with a Silero neural VAD (`@ricky0123/vad-web`) that commits `gpt-realtime-whisper` on speech boundaries (+ a tempo cap) and supplies the voiced-speech signal to the anti-cheese gate.

**Architecture:** A new pure `commit-helpers.js` state machine decides *when* to commit (speech-end edge OR tempo-aware cap, with an empty-buffer guard). `@ricky0123/vad-web`'s `MicVAD` (loaded via `<script>`, reusing the existing mic stream) owns Silero + hysteresis and emits `onSpeechStart`/`onSpeechEnd`. `player.js` is the only impure glue. All behavior is gated behind `karaokee_v2`; if the neural VAD fails to init, the code falls back to the existing V2 RMS path, and the V1 path is untouched.

**Tech Stack:** plain ES5-style JS (UMD helpers, no build step), `@ricky0123/vad-web@0.0.29`, `onnxruntime-web@1.22.0`, Flask static serving, Node `.cjs` golden tests, pytest.

**Spec:** [docs/superpowers/specs/2026-06-04-vad-commit-cadence-design.md](../specs/2026-06-04-vad-commit-cadence-design.md)

---

## File Structure

- **Create** `static/commit-helpers.js` — pure commit-cadence state machine (UMD; `window.KaraokeeCommitHelpers`). One responsibility: decide when to commit.
- **Create** `tests/test_commit_helpers.cjs` — golden tests for the above.
- **Create** `static/vendor/vad/` — vendored Silero + ort-web + vad-web dist assets (no build step).
- **Modify** `static/player.html` — load `ort`, `vad-web`, and `commit-helpers.js` before `player.js`.
- **Modify** `static/player.js` — MicVAD lifecycle + callbacks, `_commitRealtimeBuffer`, make the blind timer inert under V2+neural-VAD, `updateHotWord` cap check + `isSpeaking` relay, cleanup.

No other files change. `realtime-whisper.js` is **unchanged** (we keep `turn_detection` off for `gpt-realtime-whisper` and drive commits client-side). `vad-helpers.js` and `sync-helpers.js` are **unchanged**.

---

## Task 1: Pure `commit-helpers.js` state machine (TDD)

**Files:**
- Create: `static/commit-helpers.js`
- Test: `tests/test_commit_helpers.cjs`

- [ ] **Step 1: Write the failing test**

Create `tests/test_commit_helpers.cjs`:

```js
const assert = require('assert');
const H = require('../static/commit-helpers.js');

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('  ok -', name); }

// capMsForTempo
check('capMsForTempo maps tempo classes', () => {
  assert.strictEqual(H.capMsForTempo('fast'), 1500);
  assert.strictEqual(H.capMsForTempo('slow'), 2500);
  assert.strictEqual(H.capMsForTempo('normal'), 2000);
  assert.strictEqual(H.capMsForTempo('medium'), 2000); // relative-tempo class
  assert.strictEqual(H.capMsForTempo(undefined), 2000);
});

// speech-end commits when there was speech
check('speech-end fires a commit after speech', () => {
  const s = H.createCommitState();
  H.noteSpeechStart(s, 1000);
  assert.strictEqual(H.noteSpeechEnd(s).commit, true);
});

// empty-buffer guard: no speech since last commit -> no commit
check('speech-end without speech-since-commit does not commit', () => {
  const s = H.createCommitState();
  H.noteSpeechStart(s, 1000);
  H.noteSpeechEnd(s);            // commits (speech happened)
  H.noteCommitted(s, 1100);     // speaking=false -> speechSinceCommit cleared
  assert.strictEqual(H.noteSpeechEnd(s).commit, false); // no new speech
});

// cap fires on continuous speech past the cap, not before
check('cap fires only after the tempo cap elapses', () => {
  const s = H.createCommitState();
  H.noteSpeechStart(s, 1000);
  assert.strictEqual(H.checkCap(s, 2400, 'fast').commit, false); // 1400 < 1500
  assert.strictEqual(H.checkCap(s, 2600, 'fast').commit, true);  // 1600 >= 1500
});

// cap does not fire when not speaking
check('cap does not fire when silent', () => {
  const s = H.createCommitState();
  H.noteSpeechStart(s, 1000);
  H.noteSpeechEnd(s);
  assert.strictEqual(H.checkCap(s, 9000, 'fast').commit, false);
});

// no double-commit: after a speech-end commit, cap stays quiet
check('no double-commit after speech-end', () => {
  const s = H.createCommitState();
  H.noteSpeechStart(s, 1000);
  H.noteSpeechEnd(s);
  H.noteCommitted(s, 1100);
  assert.strictEqual(H.checkCap(s, 5000, 'fast').commit, false);
});

// mid-speech cap commit is periodic; end commit clears the flag
check('mid-speech cap commit keeps firing periodically', () => {
  const s = H.createCommitState();
  H.noteSpeechStart(s, 1000);
  assert.strictEqual(H.checkCap(s, 2600, 'fast').commit, true); // first cap
  H.noteCommitted(s, 2600);                                     // still speaking
  assert.strictEqual(H.checkCap(s, 2700, 'fast').commit, false);// too soon
  assert.strictEqual(H.checkCap(s, 4200, 'fast').commit, true); // next window
  assert.strictEqual(H.noteSpeechEnd(s).commit, true);          // end still commits
});

console.log('commit-helpers: ' + passed + ' checks passed');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/test_commit_helpers.cjs`
Expected: FAIL — `Cannot find module '../static/commit-helpers.js'`.

- [ ] **Step 3: Write the implementation**

Create `static/commit-helpers.js`:

```js
/**
 * Pure commit-cadence state machine for the realtime-whisper path.
 * No DOM / AudioContext / wall-clock / randomness — testable in Node.js.
 *
 * Decides WHEN to send input_audio_buffer.commit so gpt-realtime-whisper
 * transcribes coherent phrases instead of blind 700ms slices:
 *   - commit on speech-end (a breath/phrase boundary), and
 *   - a tempo-aware safety cap so breathless passages still flush.
 * The empty-buffer guard (no commit without speech since the last commit)
 * prevents spurious empty transcriptions.
 */
(function (root) {
    function capMsForTempo(tempoClass) {
        switch (tempoClass) {
            case 'fast': return 1500;
            case 'slow': return 2500;
            default:     return 2000; // normal / medium / unknown
        }
    }

    function createCommitState() {
        return {
            speaking: false,          // mirror of MicVAD speech state
            speechSinceCommit: false, // was there speech since the last commit?
            capAnchorMs: 0            // when the current cap window started
        };
    }

    function noteSpeechStart(state, nowMs) {
        state.speaking = true;
        state.speechSinceCommit = true;
        state.capAnchorMs = nowMs;
    }

    function noteSpeechEnd(state) {
        state.speaking = false;
        return { commit: state.speechSinceCommit };
    }

    function checkCap(state, nowMs, tempoClass) {
        if (!state.speaking || !state.speechSinceCommit) return { commit: false };
        if (nowMs - state.capAnchorMs >= capMsForTempo(tempoClass)) return { commit: true };
        return { commit: false };
    }

    function noteCommitted(state, nowMs) {
        state.capAnchorMs = nowMs;
        // keep the flag set if still mid-speech (so the cap keeps firing periodically);
        // clear it if speech already ended (no empty commit until the next speech-start).
        state.speechSinceCommit = state.speaking;
    }

    var api = {
        capMsForTempo: capMsForTempo,
        createCommitState: createCommitState,
        noteSpeechStart: noteSpeechStart,
        noteSpeechEnd: noteSpeechEnd,
        checkCap: checkCap,
        noteCommitted: noteCommitted
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    root.KaraokeeCommitHelpers = api;
})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node tests/test_commit_helpers.cjs`
Expected: PASS — `commit-helpers: 7 checks passed`.

- [ ] **Step 5: Run the full JS suite to confirm no regressions**

Run (PowerShell):
```powershell
node tests/test_match_helpers.cjs; node tests/test_sync_helpers.cjs; node tests/test_scoring_session.cjs; node tests/test_phrase_engine.cjs; node tests/test_commit_helpers.cjs
```
Expected: all print their pass lines, no exceptions.

- [ ] **Step 6: Commit**

```bash
git add static/commit-helpers.js tests/test_commit_helpers.cjs
git commit -m "feat(commit-cadence): pure commit-helpers state machine + golden tests"
```

---

## Task 2: Vendor the neural-VAD assets (no build step)

**Files:**
- Create: `static/vendor/vad/` (asset files)

- [ ] **Step 1: Fetch the exact dist files via a throwaway npm install**

Karaokee has no `node_modules`; install the pinned versions in a temp dir and copy the dist files out. Run (PowerShell):
```powershell
$tmp = Join-Path $env:TEMP "vadvendor"
New-Item -ItemType Directory -Force $tmp | Out-Null
Push-Location $tmp
npm init -y | Out-Null
npm install @ricky0123/vad-web@0.0.29 onnxruntime-web@1.22.0
Pop-Location
New-Item -ItemType Directory -Force "static/vendor/vad" | Out-Null
Copy-Item "$tmp/node_modules/@ricky0123/vad-web/dist/*" "static/vendor/vad/" -Recurse -Force
Copy-Item "$tmp/node_modules/onnxruntime-web/dist/*.wasm" "static/vendor/vad/" -Force
Copy-Item "$tmp/node_modules/onnxruntime-web/dist/ort.wasm.min.js" "static/vendor/vad/" -Force
```

- [ ] **Step 2: Verify the required files are present**

Run (PowerShell):
```powershell
Get-ChildItem "static/vendor/vad" | Select-Object Name
```
Expected to include at least: `bundle.min.js`, `vad.worklet.bundle.min.js`, a Silero model `*.onnx` (e.g. `silero_vad.onnx`/`silero_vad_v5.onnx`), `ort.wasm.min.js`, and one or more `ort-wasm*.wasm` files.
If any are missing, list `$tmp/node_modules/@ricky0123/vad-web/dist` and `$tmp/node_modules/onnxruntime-web/dist` and copy the missing model/wasm by name. **Record the exact `.onnx` filename** — Task 3 does not hardcode it (vad-web resolves it from `baseAssetPath`), but you must confirm it loads with no 404 in Task 6.

- [ ] **Step 3: Commit**

```bash
git add static/vendor/vad
git commit -m "chore(vad): vendor @ricky0123/vad-web@0.0.29 + onnxruntime-web@1.22.0 assets"
```

> Note: if your `.gitignore` excludes `vendor/` or `*.wasm`, force-add (`git add -f static/vendor/vad`) — these are intentionally vendored, no-build-step assets.

---

## Task 3: Load the scripts in `player.html`

**Files:**
- Modify: `static/player.html` (the script-loading block, near the other `static/*.js` `<script>` tags)

- [ ] **Step 1: Add the script tags before `player.js`**

Find the block that loads the helper scripts and `player.js` (search for `sync-helpers.js`). Immediately **before** the `<script src="/static/player.js"></script>` line, add:

```html
<script src="/static/vendor/vad/ort.wasm.min.js"></script>
<script src="/static/vendor/vad/bundle.min.js"></script>
<script src="/static/commit-helpers.js"></script>
```

(Order matters: `ort` before the vad `bundle`, both before `player.js`.)

- [ ] **Step 2: Verify the page loads the globals**

Run: `python app.py` (or `FLASK_DEBUG=1 python app.py`), open the player, and in the browser console confirm:
```js
typeof window.vad, typeof window.KaraokeeCommitHelpers, typeof window.ort
```
Expected: `"object" "object" "object"` (none `"undefined"`).

- [ ] **Step 3: Commit**

```bash
git add static/player.html
git commit -m "feat(vad): load ort + vad-web + commit-helpers in player.html"
```

---

## Task 4: `player.js` — state init, `_startNeuralVad`, `_commitRealtimeBuffer`

**Files:**
- Modify: `static/player.js` (constructor state init near line 155-161; new methods near `_startRealtimeWhisperCommitTimer`, ~line 599)

- [ ] **Step 1: Add state fields**

In the constructor, find (near [static/player.js:157-161](../../../static/player.js)):
```js
        this._vadBaseline = 0;
        this._vadBaselineReady = false;
        this._vadBaselineSamples = [];
        this._vadAnalyser = null;        // AnalyserNode for real-time VAD
        this._vadAnalyserBuf = null;     // Float32Array reused each tick
```
Add immediately after:
```js
        this._micVad = null;             // @ricky0123/vad-web MicVAD instance (V2 neural VAD)
        this._neuralVadActive = false;   // true once MicVAD inits OK (else fall back to RMS)
        this._commitState = null;        // KaraokeeCommitHelpers state machine
        this._vadInitError = null;       // last neural-VAD init error (telemetry/HUD)
```

Also add the same four resets where the other `_vad*` fields are reset (near [static/player.js:354-358](../../../static/player.js), after `this._vadAnalyserBuf = null;`):
```js
        this._micVad = null;
        this._neuralVadActive = false;
        this._commitState = null;
        this._vadInitError = null;
```
(Do **not** destroy `_micVad` here — that lifecycle belongs to `_startWhisperTrack`/`_stopWhisperTrack`; this is plain field reset on the per-song state reset path.)

- [ ] **Step 2: Add `_startNeuralVad` and `_commitRealtimeBuffer`**

Immediately **after** the `_stopRealtimeWhisperCommitTimer()` method (ends ~[static/player.js:622](../../../static/player.js)), add:

```js
    // V2 neural VAD: Silero via @ricky0123/vad-web, reusing the existing mic stream.
    // MicVAD owns Silero + hysteresis and emits speech-start/end; we drive isSpeaking
    // and the commit cadence (commit-helpers) from those edges. Falls back silently
    // to the RMS path if the library/model fails to load.
    async _startNeuralVad() {
        if (!window.KARAOKEE_V2) return;
        if (!window.vad || !window.vad.MicVAD || !window.KaraokeeCommitHelpers) {
            this._vadInitError = 'vad-web/commit-helpers not loaded';
            return;
        }
        if (!this._whisperStream) { this._vadInitError = 'no mic stream'; return; }
        var self = this;
        this._commitState = KaraokeeCommitHelpers.createCommitState();
        try {
            this._micVad = await window.vad.MicVAD.new({
                // Reuse Karaokee's already-open stream; never let MicVAD stop its tracks.
                getStream: function () { return Promise.resolve(self._whisperStream); },
                pauseStream: function () { return Promise.resolve(); },
                resumeStream: function () { return Promise.resolve(self._whisperStream); },
                baseAssetPath: '/static/vendor/vad/',
                onnxWASMBasePath: '/static/vendor/vad/',
                onSpeechStart: function () {
                    self.isSpeaking = true;
                    KaraokeeCommitHelpers.noteSpeechStart(self._commitState, performance.now());
                },
                onSpeechEnd: function () {
                    self.isSpeaking = false;
                    var r = KaraokeeCommitHelpers.noteSpeechEnd(self._commitState);
                    if (r.commit) self._commitRealtimeBuffer();
                }
            });
            this._micVad.start();
            this._neuralVadActive = true;
        } catch (err) {
            this._vadInitError = (err && err.message) ? err.message : 'vad init failed';
            this._neuralVadActive = false;
            this._micVad = null;
        }
    }

    // Send one input_audio_buffer.commit on the realtime data channel and advance the
    // commit-cadence state. Shared by the speech-end edge and the tempo cap.
    _commitRealtimeBuffer() {
        var dc = this._whisperRealtimeDc;
        if (!dc || dc.readyState !== 'open') return;
        if (!window.KaraokeeRealtimeWhisper) return;
        try {
            dc.send(JSON.stringify(KaraokeeRealtimeWhisper.buildCommitEvent()));
            this._whisperRealtimeCommitsSent++;
            if (this._commitState && window.KaraokeeCommitHelpers) {
                KaraokeeCommitHelpers.noteCommitted(this._commitState, performance.now());
            }
        } catch (err) {
            this._whisperRealtimeLastError = (err && err.message) ? err.message : 'commit send failed';
        }
    }
```

- [ ] **Step 3: Verify the JS suite still passes (no syntax errors)**

Run (PowerShell):
```powershell
node tests/test_scoring_session.cjs; node tests/test_phrase_engine.cjs
```
Expected: pass (these `require` nothing new, but a syntax error in `player.js` won't surface here — Step in Task 6 does the browser check). Primarily confirm you didn't break the `.cjs` harness.

- [ ] **Step 4: Commit**

```bash
git add static/player.js
git commit -m "feat(vad): add _startNeuralVad + _commitRealtimeBuffer (V2, fallback-safe)"
```

---

## Task 5: `player.js` — wire MicVAD into the realtime startup; make the blind timer inert under V2

**Files:**
- Modify: `static/player.js` (`_startWhisperTrack` realtime branch ~line 738-739; `_startRealtimeWhisperCommitTimer` body ~line 602-614)

- [ ] **Step 1: Start the neural VAD after the realtime connection opens**

Find (near [static/player.js:738-740](../../../static/player.js)):
```js
            if (this._isRealtimeWhisperProvider()) {
                await this._openRealtimeWhisperConnection();
            } else {
```
Replace with:
```js
            if (this._isRealtimeWhisperProvider()) {
                await this._openRealtimeWhisperConnection();
                await this._startNeuralVad();
            } else {
```

- [ ] **Step 2: Make the blind 700 ms timer inert once neural VAD is active**

Find the interval body in `_startRealtimeWhisperCommitTimer` (near [static/player.js:602-611](../../../static/player.js)):
```js
        this._whisperRealtimeCommitTimer = setInterval(function() {
            var dc = self._whisperRealtimeDc;
            if (!dc || dc.readyState !== 'open') return;
            if (!window.KaraokeeRealtimeWhisper) return;
            try {
                dc.send(JSON.stringify(KaraokeeRealtimeWhisper.buildCommitEvent()));
                self._whisperRealtimeCommitsSent++;
            } catch (err) {
                self._whisperRealtimeLastError = err && err.message ? err.message : 'commit send failed';
            }
```
Replace with (adds the inert guard; race-safe — the timer self-skips once neural VAD confirms active, and keeps working as a fallback if it never does):
```js
        this._whisperRealtimeCommitTimer = setInterval(function() {
            var dc = self._whisperRealtimeDc;
            if (!dc || dc.readyState !== 'open') return;
            if (!window.KaraokeeRealtimeWhisper) return;
            // V2 with neural VAD active: commits are VAD-driven (onSpeechEnd) + the tempo
            // cap (updateHotWord). The blind timer stays inert. If neural VAD failed to
            // init (_neuralVadActive false), this 700ms fallback keeps the path alive.
            if (window.KARAOKEE_V2 && self._neuralVadActive) return;
            try {
                dc.send(JSON.stringify(KaraokeeRealtimeWhisper.buildCommitEvent()));
                self._whisperRealtimeCommitsSent++;
            } catch (err) {
                self._whisperRealtimeLastError = err && err.message ? err.message : 'commit send failed';
            }
```

- [ ] **Step 3: Commit**

```bash
git add static/player.js
git commit -m "feat(vad): start neural VAD on realtime open; blind commit timer inert under V2"
```

---

## Task 6: `player.js` — `updateHotWord` cap + relay; MicVAD cleanup; browser verify

**Files:**
- Modify: `static/player.js` (`updateHotWord` ~line 1144-1174; `_stopWhisperTrack` ~line 809-810)

- [ ] **Step 1: Add the neural-VAD branch to `updateHotWord`**

Find the start of `updateHotWord` (near [static/player.js:1144-1146](../../../static/player.js)):
```js
    updateHotWord() {
        // Refresh isSpeaking from AnalyserNode — real-time, not tied to Whisper chunk rate
        var vadRms = this._readVadRms();
```
Insert, immediately after the `updateHotWord() {` line and **before** the `var vadRms` line:
```js
        // V2 neural VAD: isSpeaking is maintained by MicVAD callbacks (not RMS). Run the
        // tempo-aware commit cap here (100ms granularity is fine for a 1.5-2.5s cap),
        // then relay isSpeaking to the session. Falls through to the RMS path if neural
        // VAD is not active (init failed) or V1.
        if (window.KARAOKEE_V2 && this._neuralVadActive && this._commitState && window.KaraokeeCommitHelpers) {
            var _tempoClass = (this.wordTimings && this.wordTimings.vadTempoClass) || 'normal';
            var _capRes = KaraokeeCommitHelpers.checkCap(this._commitState, performance.now(), _tempoClass);
            if (_capRes.commit) this._commitRealtimeBuffer();
            if (this._session) KaraokeeScoringSession.setEnergy(this._session, this.isSpeaking);
            return;
        }
```

- [ ] **Step 2: Destroy the MicVAD instance on stop**

Find (near [static/player.js:809-810](../../../static/player.js)):
```js
        this._vadAnalyser    = null;
        this._vadAnalyserBuf = null;
```
Insert immediately **before** those two lines:
```js
        if (this._micVad) {
            try { this._micVad.destroy(); } catch (e) {}
            this._micVad = null;
        }
        this._neuralVadActive = false;
        this._commitState = null;
```

- [ ] **Step 3: Browser smoke test (V2 path, real recognition)**

Run `python app.py`, load a song, press `V` to enable `karaokee_v2`, start a run, and sing a few lines. In the browser console / Network / debug HUD (`D`), confirm:
```js
// after a few sung lines:
gameMode._neuralVadActive            // true  (MicVAD initialised)
gameMode._vadInitError               // null
gameMode._whisperRealtimeCommitsSent // increments on speech-end / cap, NOT ~every 700ms during silence
```
Confirm **no 404s** for `/static/vendor/vad/*` (the known vad-web asset-path friction). Confirm whisper finals in the HUD/telemetry arrive as multi-word phrases, not 1-2-word fragments. If `_neuralVadActive` is false, read `_vadInitError` and fix asset paths/filenames (Task 2) before proceeding.

- [ ] **Step 4: Confirm V1 still works (A/B intact)**

Reload, do **not** press `V` (flag off). Start a run; confirm the legacy path still scores (V1 uses the one-shot energy gate + 700 ms timer, untouched). The blind timer should commit (since `_neuralVadActive` is false / flag off).

- [ ] **Step 5: Run the full automated suite**

Run (PowerShell):
```powershell
node tests/test_match_helpers.cjs; node tests/test_sync_helpers.cjs; node tests/test_scoring_session.cjs; node tests/test_phrase_engine.cjs; node tests/test_commit_helpers.cjs; python -m pytest tests/test_app.py tests/test_downloader.py tests/test_lyrics.py -q
```
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add static/player.js
git commit -m "feat(vad): VAD-driven commit cap + isSpeaking relay in updateHotWord; MicVAD cleanup"
```

---

## Task 7: Validation against the honesty gate

**Files:** none (validation only)

- [ ] **Step 1: Replay-corpus check (recognition + no cheese regression)**

Re-run / replay the saved Expert telemetry runs (the 5 used for interim-snapshot validation) with the flag on. Confirm:
- `whisper`-sourced finals are coherent multi-word phrases (fragment rate down vs. the recorded baseline).
- `summary.honesty.suspectedCheeseInflation` stays clean on the cheese-labelled runs (no regression).
Record findings in this plan's PR / a short note under `output_telemetry/`.

- [ ] **Step 2: Live sing-test (the flag-flip gate — human only)**

With `karaokee_v2` on, headphones, run the cheese probes and honest probes from the spec §4:
- Cheese (must NOT build points / lift multiplier): silence, humming, "yeah yeah yeah", mumbling, **finger-taps / desk noise** (the new neural gate should reject these where RMS did not).
- Honest (must score fair): clean rap, sloppy-but-real, quiet singing.
- Latency: on a dense rap, words should green noticeably sooner than the 700 ms-fragmented baseline.
Set the end-screen `benchmarkIntent`, download the telemetry (`D`), and scan for any cheese run that inflated.

- [ ] **Step 3: Decision gate**

Only if Step 2 passes do we consider flipping `karaokee_v2` default-on (a separate change, with the user). Until then the feature ships behind the flag. Document the sing-test outcome before any flag-flip.

---

## Self-Review (completed by plan author)

- **Spec coverage:** §3.1 commit cadence → Tasks 1,4,5,6. §3.2 Silero/vad-web → Tasks 2,3,4. §3.3 anti-cheese via `isSpeaking` → Task 6 Step 1 (relay) + Task 4 (callbacks). §3.4 module boundaries → Task 1 (commit-helpers pure) + player.js glue; `vad-helpers.js`/`sync-helpers.js` untouched as specified. §3.5 data flow → Tasks 4-6. §4 validation → Task 7 + the `.cjs`/pytest steps. §6 rollout (behind flag, V1 A/B) → fallback guards in Tasks 4-6.
- **Placeholder scan:** none — every code step shows complete code; commands have expected output.
- **Type/name consistency:** `KaraokeeCommitHelpers` API (`capMsForTempo`, `createCommitState`, `noteSpeechStart`, `noteSpeechEnd`, `checkCap`, `noteCommitted`) is defined in Task 1 and used identically in Tasks 4 & 6. `_neuralVadActive`, `_commitState`, `_micVad`, `_commitRealtimeBuffer` are defined in Task 4 and referenced consistently in Tasks 5 & 6.
- **Known soft spot:** the exact vad-web `.onnx`/`.wasm` filenames depend on the pinned dist (Task 2 verifies them at runtime via the no-404 browser check in Task 6 Step 3, rather than hardcoding).
