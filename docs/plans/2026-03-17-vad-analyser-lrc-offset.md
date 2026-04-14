# VAD AnalyserNode + LRC Offset Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix whole-line VAD misses by decoupling voice detection from Whisper chunking, and add manual LRC timing offset buttons.

**Architecture:**
Task 1 adds a Web Audio `AnalyserNode` on the mic stream so `isSpeaking` is computed fresh on every 100ms polling tick instead of relying on stale AudioWorklet chunk messages (which arrive every 750ms for fast lines). Task 2 adds ±0.5s offset buttons in the player UI that shift all LRC word-timing windows by a user-adjustable delta, persisted to `localStorage` per video URL.

**Tech Stack:** Vanilla JS, Web Audio API (`AnalyserNode`, `getFloatTimeDomainData`), `localStorage`

---

## Task 1: Decouple VAD from Whisper chunking via AnalyserNode

### Root cause recap
`this.isSpeaking` is currently set inside the AudioWorklet `port.onmessage` handler (player.js line 625). For fast lines the AudioWorklet only sends a message every **750ms**. The VAD scoring loop runs every **100ms**. Word windows for fast lines can be as short as 100–200ms — meaning a word window can open and close entirely between two AudioWorklet messages, causing the whole line to silently miss.

**Files:**
- Modify: `static/player.js` (lines 414–418, 456–460, 600–639, 612–625, 921–946, 1148–1150)

---

**Step 1: Add AnalyserNode fields to the constructor initialiser block**

In `player.js`, find the block around line 414 where `isSpeaking`, `_energyThreshold`, `_vadBaseline`, `_vadBaselineReady`, `_vadBaselineSamples` are declared and add two new fields immediately after:

```javascript
this._vadAnalyser = null;        // AnalyserNode for real-time VAD
this._vadAnalyserBuf = null;     // Float32Array reused each tick
```

---

**Step 2: Repeat for the reset block (~line 456)**

Find the reset block where the same five VAD fields are re-initialised (around lines 456–460) and add the same two lines:

```javascript
this._vadAnalyser = null;
this._vadAnalyserBuf = null;
```

---

**Step 3: Wire the AnalyserNode in the audio setup block**

In `player.js` around lines 600–609, after `src` is created from `createMediaStreamSource` and **before** `src.connect(this._whisperNode)`, add:

```javascript
// VAD AnalyserNode — polled every 100ms, decoupled from Whisper chunks
this._vadAnalyser = this._whisperCtx.createAnalyser();
this._vadAnalyser.fftSize = 256;
this._vadAnalyserBuf = new Float32Array(this._vadAnalyser.fftSize);
src.connect(this._vadAnalyser);
```

The existing `src.connect(this._whisperNode)` line stays unchanged — the mic stream is now connected to both nodes in parallel.

---

**Step 4: Remove `isSpeaking` update from the AudioWorklet message handler**

In `player.js` find line 625:

```javascript
this.isSpeaking = msg.rms > this._energyThreshold;
```

**Delete this line.** `isSpeaking` will now be computed in `updateHotWord` instead (next step). The rest of the message handler (Whisper transcription, baseline sampling via `msg.rms`) is **untouched**.

---

**Step 5: Add a `_readVadRms()` helper method**

Add this method to the `GameMode` class (place it near the other small private helpers, just before `updateHotWord`):

```javascript
/** Read current mic RMS from the AnalyserNode. Returns 0 if not ready. */
_readVadRms() {
    if (!this._vadAnalyser || !this._vadAnalyserBuf) return 0;
    this._vadAnalyser.getFloatTimeDomainData(this._vadAnalyserBuf);
    var sum = 0;
    for (var i = 0; i < this._vadAnalyserBuf.length; i++) {
        sum += this._vadAnalyserBuf[i] * this._vadAnalyserBuf[i];
    }
    return Math.sqrt(sum / this._vadAnalyserBuf.length);
}
```

---

**Step 6: Update `isSpeaking` at the top of `updateHotWord`**

`updateHotWord` starts at line 921. Add the following as the **first two lines** of the function body (before `var t = audio.currentTime`):

```javascript
// Refresh isSpeaking from AnalyserNode — real-time, not tied to Whisper chunk rate
var vadRms = this._readVadRms();
this.isSpeaking = vadRms > this._energyThreshold;
```

---

**Step 7: Move the baseline calibration into `updateHotWord`**

The baseline calibration block (player.js lines 612–622) currently lives inside the AudioWorklet `port.onmessage` handler and uses `msg.rms`. Move the same logic into `updateHotWord`, right after the two lines added in Step 6, but using `vadRms` instead of `msg.rms`:

```javascript
// Baseline calibration during first 2s of playback
if (!this._vadBaselineReady) {
    if (audio.currentTime > 0 && audio.currentTime < 2.0) {
        this._vadBaselineSamples.push(vadRms);
    } else if (audio.currentTime >= 2.0) {
        if (this._vadBaselineSamples.length > 0) {
            var bSum = this._vadBaselineSamples.reduce(function(a, b) { return a + b; }, 0);
            this._vadBaseline = bSum / this._vadBaselineSamples.length;
            this._energyThreshold = Math.min(this._vadBaseline + 0.025, 0.06);
        }
        this._vadBaselineReady = true;
    }
}
```

Then **delete** the original baseline block from inside `port.onmessage` (lines 612–622 in the original file) since it's now handled in `updateHotWord`.

---

**Step 8: Verify the debug HUD still shows correct values**

The debug HUD at line 1149 reads `this._energyThreshold` and `this._vadBaselineReady` — these are still updated by the same logic, just in a different call site. No HUD changes needed. Confirm by opening the debug panel (press `D`) and checking the `thr:` value appears and updates.

---

**Step 9: Manual smoke test**

1. Start a fast song (e.g. Worldwide Choppers)
2. Open the debug HUD (`D`)
3. Confirm `thr:` shows a value (not `calibrating…`) after ~2s
4. Rap along — verify words light up green in real-time on fast lines
5. Stay silent for a full line — verify the line goes red as expected
6. Confirm no whole-line misses on lines where you were clearly speaking

---

**Step 10: Commit**

```bash
git add static/player.js
git commit -m "fix: decouple VAD isSpeaking from Whisper chunk rate via AnalyserNode

isSpeaking was only updated when Whisper chunks arrived (every 750ms for
fast lines), causing word windows as short as 100ms to be missed entirely.
Now uses a dedicated AnalyserNode polled on every 100ms updateHotWord tick."
```

---

## Task 2: Manual LRC offset buttons (±0.5s)

### What this fixes
LRC files are authored against a specific version of a song (usually the Spotify/Apple Music master). YouTube may serve the music video version, a fan edit, or a remaster with a different intro length. The timestamp mismatch is a fixed delta across the whole song, correctable with a single offset value.

**Files:**
- Modify: `static/player.html` (controls area, ~line 319–330)
- Modify: `static/player.js` (game state, hot-word window check, offset persistence)

---

**Step 1: Add offset state fields**

In `player.js`, in the constructor initialiser block near the other game state fields, add:

```javascript
this.lrcOffset = 0;   // seconds to add to all LRC timestamps (positive = delay lyrics)
```

Add the same line in the reset block (~line 456).

---

**Step 2: Load persisted offset when a song starts**

In `player.js`, find where game mode is initialised at song load (where `allWordTimings` and `songTempoProfile` are computed). After those lines, add:

```javascript
// Restore per-video LRC offset from localStorage
var _vid = new URLSearchParams(window.location.search).get('v') || '';
this.lrcOffset = parseFloat(localStorage.getItem('lrcOffset_' + _vid) || '0');
```

---

**Step 3: Apply offset in the hot-word window check**

In `updateHotWord` (line 926 area), find:

```javascript
var t = audio.currentTime;
```

Change to:

```javascript
var t = audio.currentTime - (window._gameMode ? window._gameMode.lrcOffset : 0);
```

Wait — `updateHotWord` is a method on the GameMode instance, so `this` is available. Change it to:

```javascript
var t = audio.currentTime - this.lrcOffset;
```

This shifts the comparison time by the offset, effectively sliding all LRC windows forward or backward without recomputing them.

---

**Step 4: Add offset buttons to player.html**

In `player.html`, find the controls div (around line 319–330). Add the following after the existing controls (after the volume slider, before the closing `</div>`):

```html
<div id="lrc-offset-control" style="display:none; align-items:center; gap:6px; font-size:13px; color:#aaa;">
  <span>Lyrics offset</span>
  <button id="offsetMinus" title="Shift lyrics earlier">−0.5s</button>
  <span id="offsetDisplay">0.0s</span>
  <button id="offsetPlus"  title="Shift lyrics later">+0.5s</button>
</div>
```

The `display:none` is intentional — the control only appears in game mode (next step).

---

**Step 5: Show/hide offset control with game mode, wire button handlers**

In `player.js`, find where game mode is activated (where the game UI is shown). Add:

```javascript
document.getElementById('lrc-offset-control').style.display = 'flex';
```

And where game mode is deactivated / song ends:

```javascript
document.getElementById('lrc-offset-control').style.display = 'none';
```

Wire the buttons (place this near other UI event listeners in the DOMContentLoaded block):

```javascript
function _updateOffsetDisplay() {
    document.getElementById('offsetDisplay').textContent =
        (window._gameMode ? window._gameMode.lrcOffset : 0).toFixed(1) + 's';
}

document.getElementById('offsetMinus').addEventListener('click', function() {
    if (!window._gameMode) return;
    window._gameMode.lrcOffset = Math.max(-10, window._gameMode.lrcOffset - 0.5);
    var vid = new URLSearchParams(window.location.search).get('v') || '';
    localStorage.setItem('lrcOffset_' + vid, window._gameMode.lrcOffset);
    _updateOffsetDisplay();
});

document.getElementById('offsetPlus').addEventListener('click', function() {
    if (!window._gameMode) return;
    window._gameMode.lrcOffset = Math.min(10, window._gameMode.lrcOffset + 0.5);
    var vid = new URLSearchParams(window.location.search).get('v') || '';
    localStorage.setItem('lrcOffset_' + vid, window._gameMode.lrcOffset);
    _updateOffsetDisplay();
});
```

Call `_updateOffsetDisplay()` once after loading the persisted offset (end of Step 2 block).

---

**Step 6: Basic smoke test**

1. Load a song where you know the lyrics are ~1s late
2. Press `+0.5s` twice → lyrics shift 1s earlier relative to audio
3. Confirm the `offsetDisplay` reads `1.0s`
4. Reload the page — confirm the offset is restored from localStorage
5. Press `−0.5s` twice → back to `0.0s`

---

**Step 7: Commit**

```bash
git add static/player.html static/player.js
git commit -m "feat: add manual LRC offset buttons (+/-0.5s) persisted per video URL

YouTube videos sometimes differ in length from the version the LRC was
authored against. Offset is stored in localStorage keyed by video ID."
```
