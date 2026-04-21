# Consolidated Plan Record

This file merges the original design and implementation documents for this feature.

## Design

# VAD-Gated Optimistic Scoring â€” Design Document

**Date:** 2026-03-17
**Status:** Approved

## Problem Statement

The current lyrics matching system uses ASR (Whisper + Web Speech API) as the primary gating mechanism: a word only turns green after ASR transcribes it and the match passes validation. This architecture has an inherent latency floor â€” Whisper processes audio in chunks with 500â€“1500ms turnaround, and Web Speech API batches fast speech into bursts. For slow songs this is fine. For fast sections (rapid verses, rap), ASR cannot keep up and entire verses go unscored despite being sung correctly.

Additionally, false greens are occurring on ad-libs and background vocals from the track being picked up through the mic â€” likely because `echoCancellation` is not enabled on the `getUserMedia` call.

The root issue is that the current model is **confirmation-first**: ASR must confirm before the word lights up. The desired experience is a **game-feel model**: words light up as you say them, in real time.

## Goals

- Words light up immediately when sung â€” no waiting for ASR
- Works at any song speed, including Eminem-tier fast rap
- Per-song tempo calibration (not global fixed thresholds)
- Fix existing audio bleed / false green issue
- No backend changes, no new dependencies
- Slow songs continue to use the existing ASR path unchanged

## Design

### 1. Echo Cancellation Fix (applies to current system too)

Update the `getUserMedia` call to enable browser AEC:

```js
getUserMedia({
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  }
})
```

This removes audio playing through headphones/speakers from the mic signal at the source, eliminating ad-lib false greens in both the current ASR path and the new VAD path.

### 2. Voice Activity Detection (VAD)

A lightweight VAD is added using the Web Audio API. An `AnalyserNode` is connected to the mic stream and polled every ~20ms. RMS energy is computed over the frequency range 100â€“3000 Hz (human vocal range) to avoid reacting to low-frequency rumble or high-frequency hiss.

```
Mic â†’ MediaStreamSource â†’ AnalyserNode â†’ RMS computation (20ms interval)
                                              â†“
                                       isVoiceActive (boolean)
```

**Ambient baseline:** During the first 2 seconds of song playback (before the user typically starts singing), the VAD samples the ambient noise floor. The voice threshold is set as `baseline + offset` rather than a fixed value. This handles mic sensitivity differences between users and catches any residual bleed not removed by AEC.

### 3. Per-Song Tempo Calibration

At song load time, after word timings are interpolated, compute the song's tempo distribution across all lines:

1. For each line, compute `wordsPerSecond = wordCount / lineDuration`
2. Collect all per-line WPS values
3. Compute the 50th and 80th percentiles of that distribution

These percentiles define the slow/medium/fast boundaries **relative to this song**. A Kendrick Lamar track with a wide tempo range self-calibrates correctly â€” slow bars use the existing ASR path, fast bars use VAD-gated scoring.

| Tempo class | Threshold | Primary scorer |
|---|---|---|
| slow | Below song's 50th percentile WPS | Existing ASR matching (unchanged) |
| medium | 50thâ€“80th percentile WPS | VAD-gated optimistic |
| fast | Above 80th percentile WPS | VAD-gated optimistic |

The computed thresholds are shown in the debug HUD at song start.

### 4. Optimistic Scoring Path

For lines classified as `medium` or `fast`, the scoring model flips:

**Current model (ASR-first):**
```
ASR transcribes word â†’ match validated â†’ word turns green
```

**New model (VAD-gated optimistic):**
```
Word's time window arrives AND VAD detects voice â†’ word turns green immediately
```

Specifically, for each word in a VAD-mode line:
- When playback enters the word's `windowStart`, begin watching VAD
- If `isVoiceActive` is true at any point before `windowEnd`, mark word as hit â†’ green
- If `windowEnd` passes with no voice detected, mark as miss â†’ red

The existing word time windows (already computed by the interpolation system) are reused unchanged.

### 5. ASR Confirmation Layer

The existing ASR pipeline (Whisper + Web Speech API) continues running unchanged in the background. When ASR produces a match for a word that is already VAD-greened:

- The word receives a **visual upgrade** â€” a brighter flash or sparkle animation
- This signals "you said the right word" vs. "you were making sounds"
- No score effect â€” confirmation is cosmetic only

If ASR doesn't confirm (too slow, fast section, word not transcribed), the word stays regular green and the score is unaffected. No penalties.

### 6. Score Calculation

Score formula is unchanged: `score = hits / totalWords`

A "hit" in VAD mode = voice detected during the word's time window.
A "hit" in ASR mode (slow lines) = existing match logic.

Lines mix modes freely within a song â€” each line independently uses whichever path its tempo class dictates.

## Updated Processing Pipeline

```
Song Load
  â””â”€ computeSongTempoProfile()     â† NEW: percentile thresholds
  â””â”€ getUserMedia (echoCancellation: true)  â† UPDATED
  â””â”€ initVAD()                     â† NEW: AnalyserNode + polling loop

Playback
  For each word:
    if line.tempoClass == 'slow'
      â””â”€ existing ASR matching path (unchanged)
    else
      â””â”€ VAD window watch:
           windowStart â†’ poll isVoiceActive â†’ hit/miss at windowEnd
           ASR background â†’ confirm â†’ visual upgrade if hit
```

## Files Modified

| File | Changes |
|---|---|
| `static/player.js` | `initVAD()`, `computeSongTempoProfile()`, VAD scoring path in word evaluation loop, ASR confirmation visual upgrade, updated `getUserMedia` constraints |
| `static/sync-helpers.js` | Replace fixed WPS thresholds with `classifyLineTempoRelative(wps, profile)` using per-song percentiles |
| `static/audio-processor.js` | VAD energy computation helper (RMS over vocal frequency band), or inline in player.js if small enough |

No backend changes. No new npm/pip dependencies.

## Debug HUD Additions

- Song tempo profile at load: `p50: 2.1 WPS | p80: 3.8 WPS`
- Per-line tempo class indicator (already exists, updated to show song-relative classification)
- Current VAD state: `VAD: active / silent`
- Ambient baseline value
- ASR confirmation count per line (e.g., `confirmed: 4/8`)

## What Stays the Same

- Existing ASR matching for slow lines
- Word time window computation (interpolation system)
- Scoring formula
- All existing debug HUD elements
- Whisper backend architecture
- Contraction expansion, canonicalization, phonetic matching (still used for slow lines and ASR confirmation)

---

## Implementation

# VAD-Gated Optimistic Scoring â€” Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace ASR-as-gatekeeper with VAD-gated optimistic scoring for fast lines, plus fix audio bleed via echo cancellation, so words light up in real-time on any-speed song.

**Architecture:** Voice activity detection (VAD) already exists â€” `audio-processor.js` already emits `energy` RMS messages, and `isSpeaking` is already tracked on `GameEngine`. The new system uses per-song tempo percentiles (p50/p80 of all lines' WPS) to classify lines as VAD-eligible, then in `updateHotWord()`, marks words green immediately when voice is detected in their time window. ASR keeps running and adds a visual "confirmed" upgrade when it catches up.

**Tech Stack:** Plain JS (no new libraries), Web Audio API (already in use), Node.js `assert` for sync-helpers tests (already established pattern in `tests/test_sync_helpers.cjs`).

---

### Task 1: Fix getUserMedia Echo Cancellation

**Files:**
- Modify: `static/player.js:659`

**Step 1: Apply the fix**

At line 659, change:
```js
this._whisperStream = await navigator.mediaDevices.getUserMedia({ audio: true });
```
to:
```js
this._whisperStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
});
```

**Step 2: Manual smoke test**

Start the app (`python app.py`), open a song in game mode, play it with headphones. Ad-libs and background vocals should no longer cause false greens. Words should only go green when you actually speak.

**Step 3: Commit**

```bash
git add static/player.js
git commit -m "fix: enable echo cancellation on mic getUserMedia to prevent audio bleed false greens"
```

---

### Task 2: Add computeSongTempoProfile to sync-helpers (TDD)

**Files:**
- Modify: `tests/test_sync_helpers.cjs`
- Modify: `static/sync-helpers.js`

**Step 1: Write the failing tests**

Add to the bottom of `tests/test_sync_helpers.cjs` (before the `console.log` line):

```js
// --- computeSongTempoProfile ---
var computeSongTempoProfile = fakeModule.exports.computeSongTempoProfile;

// Empty / all-zero input â†’ fallback defaults
var emptyProfile = computeSongTempoProfile([]);
assert.strictEqual(emptyProfile.p50, 2.0);
assert.strictEqual(emptyProfile.p80, 5.0);

// Single line
var single = [{ wps: 3.0 }];
var sp = computeSongTempoProfile(single);
assert.strictEqual(sp.p50, 3.0);
assert.strictEqual(sp.p80, 3.0);

// Five lines: [1.0, 2.0, 3.0, 4.0, 5.0]
// p50 = 3.0, p80 = 4.6 (interpolated between index 3 and 4)
var fiveLines = [
    { wps: 5.0 }, { wps: 1.0 }, { wps: 3.0 }, { wps: 2.0 }, { wps: 4.0 }
];
var fp = computeSongTempoProfile(fiveLines);
assert.strictEqual(fp.p50, 3.0);
assert.ok(fp.p80 > 4.0 && fp.p80 < 5.0, 'p80 should be between 4 and 5');

// Lines with wps=0 are filtered out
var withZero = [{ wps: 0 }, { wps: 2.0 }, { wps: 4.0 }];
var wzp = computeSongTempoProfile(withZero);
assert.strictEqual(wzp.p50, 3.0); // median of [2.0, 4.0] = 3.0
```

**Step 2: Run tests to verify they fail**

```bash
node tests/test_sync_helpers.cjs
```
Expected: `TypeError: computeSongTempoProfile is not a function`

**Step 3: Implement computeSongTempoProfile in sync-helpers.js**

Add before the `if (typeof module !== 'undefined'...)` block:

```js
/**
 * Compute per-song tempo distribution from all interpolated line timings.
 * Returns percentile thresholds for slow/medium/fast classification.
 * @param {Array} allWordTimings - array of line timing arrays, each with .wps property
 * @returns {{ p50: number, p80: number }}
 */
function computeSongTempoProfile(allWordTimings) {
    var wpsList = allWordTimings
        .map(function(lt) { return lt.wps || 0; })
        .filter(function(wps) { return wps > 0; })
        .sort(function(a, b) { return a - b; });
    if (wpsList.length === 0) return { p50: 2.0, p80: 5.0 };

    function percentile(arr, p) {
        var idx = (p / 100) * (arr.length - 1);
        var lo = Math.floor(idx);
        var hi = Math.ceil(idx);
        if (lo === hi) return arr[lo];
        return arr[lo] + (idx - lo) * (arr[hi] - arr[lo]);
    }

    return {
        p50: percentile(wpsList, 50),
        p80: percentile(wpsList, 80)
    };
}
```

Also add `computeSongTempoProfile` to the exports line:
```js
module.exports = { classifyTempo, getWindowParams, getOverlapDuration, getScoreDelay, getChunkSamples, computeSongTempoProfile };
```

**Step 4: Run tests to verify they pass**

```bash
node tests/test_sync_helpers.cjs
```
Expected: `All sync-helpers tests passed.`

**Step 5: Commit**

```bash
git add static/sync-helpers.js tests/test_sync_helpers.cjs
git commit -m "feat: add computeSongTempoProfile for per-song tempo percentile calibration"
```

---

### Task 3: Add classifyLineTempoRelative to sync-helpers (TDD)

**Files:**
- Modify: `tests/test_sync_helpers.cjs`
- Modify: `static/sync-helpers.js`

**Step 1: Write the failing tests**

Add to `tests/test_sync_helpers.cjs` (before the `console.log` line):

```js
// --- classifyLineTempoRelative ---
var classifyLineTempoRelative = fakeModule.exports.classifyLineTempoRelative;

var profile = { p50: 2.0, p80: 4.0 };

// below p50 â†’ slow
assert.strictEqual(classifyLineTempoRelative(1.0, profile), 'slow');
assert.strictEqual(classifyLineTempoRelative(1.9, profile), 'slow');

// at or above p50, below p80 â†’ medium
assert.strictEqual(classifyLineTempoRelative(2.0, profile), 'medium');
assert.strictEqual(classifyLineTempoRelative(3.5, profile), 'medium');
assert.strictEqual(classifyLineTempoRelative(3.99, profile), 'medium');

// at or above p80 â†’ fast
assert.strictEqual(classifyLineTempoRelative(4.0, profile), 'fast');
assert.strictEqual(classifyLineTempoRelative(8.0, profile), 'fast');

// edge: p50 === p80 (all lines same tempo) â†’ fast if at/above, slow otherwise
var flatProfile = { p50: 3.0, p80: 3.0 };
assert.strictEqual(classifyLineTempoRelative(3.0, flatProfile), 'fast');
assert.strictEqual(classifyLineTempoRelative(2.9, flatProfile), 'slow');
```

**Step 2: Run tests to verify they fail**

```bash
node tests/test_sync_helpers.cjs
```
Expected: `TypeError: classifyLineTempoRelative is not a function`

**Step 3: Implement classifyLineTempoRelative in sync-helpers.js**

Add after `computeSongTempoProfile`:

```js
/**
 * Classify a line's tempo relative to its song's tempo profile.
 * @param {number} wps - words per second for this line
 * @param {{ p50: number, p80: number }} profile - song tempo profile
 * @returns {'slow'|'medium'|'fast'}
 */
function classifyLineTempoRelative(wps, profile) {
    if (wps >= profile.p80) return 'fast';
    if (wps >= profile.p50) return 'medium';
    return 'slow';
}
```

Also add `classifyLineTempoRelative` to exports:
```js
module.exports = { classifyTempo, getWindowParams, getOverlapDuration, getScoreDelay, getChunkSamples, computeSongTempoProfile, classifyLineTempoRelative };
```

**Step 4: Run tests to verify they pass**

```bash
node tests/test_sync_helpers.cjs
```
Expected: `All sync-helpers tests passed.`

**Step 5: Commit**

```bash
git add static/sync-helpers.js tests/test_sync_helpers.cjs
git commit -m "feat: add classifyLineTempoRelative for song-relative slow/medium/fast classification"
```

---

### Task 4: Wire Per-Song Profile into GameEngine.start()

**Files:**
- Modify: `static/player.js:519`

**Step 1: Add songTempoProfile property to constructor**

In the `GameEngine` constructor (around line 488, after `this.allWordTimings = []`), add:
```js
this.songTempoProfile = null; // per-song { p50, p80 } computed at start
```

**Step 2: Compute profile after interpolation at start()**

At player.js line 519, the current code is:
```js
this.allWordTimings = interpolateWordTimings(lyrics);
```

Change it to:
```js
this.allWordTimings = interpolateWordTimings(lyrics);
this.songTempoProfile = computeSongTempoProfile(this.allWordTimings);
for (var li = 0; li < this.allWordTimings.length; li++) {
    var lt = this.allWordTimings[li];
    var relClass = classifyLineTempoRelative(lt.wps || 0, this.songTempoProfile);
    lt.useVad = (relClass !== 'slow');
    lt.vadTempoClass = relClass;
}
```

**Step 3: Manual verification**

Open the app with a song, open browser devtools console, add a temporary `console.log(gameMode.songTempoProfile)` after game starts. For a Kendrick song with mixed tempo, you should see a `p50` around 2-4 and `p80` noticeably higher.

**Step 4: Commit**

```bash
git add static/player.js
git commit -m "feat: compute per-song tempo profile and tag lines with useVad flag at game start"
```

---

### Task 5: Add VAD Ambient Baseline Calibration

**Files:**
- Modify: `static/player.js` (constructor ~line 491, energy handler ~line 667)

**Step 1: Add baseline state to constructor**

In the `GameEngine` constructor, after `this._energyThreshold = 0.01`, add:
```js
this._vadBaseline = 0;
this._vadBaselineReady = false;
this._vadBaselineSamples = [];
```

**Step 2: Reset baseline state in start()**

In `start()` (around line 522, after `this.isSpeaking = false`), add:
```js
this._vadBaseline = 0;
this._vadBaselineReady = false;
this._vadBaselineSamples = [];
this._energyThreshold = 0.01; // reset to default until baseline computed
```

**Step 3: Collect baseline during first 2 seconds**

In `_startWhisperTrack()`, the energy handler is at line 667:
```js
if (msg && msg.type === 'energy') {
    // Update voice activity detection flag
    this.isSpeaking = msg.rms > this._energyThreshold;
```

Change it to:
```js
if (msg && msg.type === 'energy') {
    // Collect ambient baseline during first 2 seconds of playback
    if (!this._vadBaselineReady) {
        if (audio.currentTime > 0 && audio.currentTime < 2.0) {
            this._vadBaselineSamples.push(msg.rms);
        } else if (audio.currentTime >= 2.0 && this._vadBaselineSamples.length > 0) {
            var sum = this._vadBaselineSamples.reduce(function(a, b) { return a + b; }, 0);
            this._vadBaseline = sum / this._vadBaselineSamples.length;
            this._energyThreshold = this._vadBaseline + 0.025;
            this._vadBaselineReady = true;
        }
    }
    // Update voice activity detection flag
    this.isSpeaking = msg.rms > this._energyThreshold;
```

**Step 4: Manual verification**

In the debug HUD (Task 8 will add this), you can temporarily log `this._energyThreshold` to console after baseline sets. With headphones and a quiet room, threshold should be very low (~0.025). With audio bleed, it auto-calibrates higher.

**Step 5: Commit**

```bash
git add static/player.js
git commit -m "feat: add VAD ambient baseline calibration from first 2 seconds of playback"
```

---

### Task 6: Add VAD Optimistic Scoring in updateHotWord()

**Files:**
- Modify: `static/player.js` (constructor ~line 459, start() ~line 504, line transition ~line 983, updateHotWord() ~line 1105)

**Step 1: Add vadMatchedSet to constructor**

In the `GameEngine` constructor, after `this.matchedSet = new Set()` (line 459), add:
```js
this.vadMatchedSet  = new Set(); // indices matched via VAD (optimistic)
```

**Step 2: Reset vadMatchedSet in start()**

In `start()`, after `this.matchedSet = new Set()` (line 504), add:
```js
this.vadMatchedSet = new Set();
```

**Step 3: Reset vadMatchedSet at line transitions**

In `_activateLine()` (around line 983 where `this.matchedSet = new Set()`), add:
```js
this.vadMatchedSet = new Set();
```

**Step 4: Add VAD scoring to updateHotWord()**

Current `updateHotWord()` ends at line 1120 with:
```js
this.hotWordIndex = newHot;
```

Change it to:
```js
this.hotWordIndex = newHot;

// VAD optimistic scoring: if this line uses VAD mode and mic is active,
// mark the hot word as hit immediately without waiting for ASR.
if (newHot >= 0 && this.isSpeaking && this.wordTimings.useVad) {
    if (!this.matchedSet.has(newHot)) {
        this.matchedSet.add(newHot);
        this.vadMatchedSet.add(newHot);
        this._updateWordSpans();
    }
}
```

**Step 5: Manual test**

Load a fast Kendrick song. Fast lines should now have words lighting up green in real-time as you rap along, without waiting for Whisper. Slow lines should behave exactly as before. Try mumbling â€” words should still go green if you're making sounds in the right window (this is expected).

**Step 6: Commit**

```bash
git add static/player.js
git commit -m "feat: VAD-gated optimistic scoring â€” words light up immediately when voice detected in time window on fast lines"
```

---

### Task 7: Add ASR Confirmation Visual Upgrade

**Files:**
- Modify: `static/player.js` (constructor, start(), line transition, energy handler results, `_matchHotWord`, `_updateWordSpans`)
- Modify: `static/player.html` (CSS for `asr-confirmed` class)

**Step 1: Add asrConfirmedSet to constructor**

After `this.vadMatchedSet = new Set()`, add:
```js
this.asrConfirmedSet = new Set(); // VAD-matched words later confirmed by ASR
```

**Step 2: Reset asrConfirmedSet in start() and _activateLine()**

In `start()`, after `this.vadMatchedSet = new Set()`:
```js
this.asrConfirmedSet = new Set();
```

In `_activateLine()`, after `this.vadMatchedSet = new Set()`:
```js
this.asrConfirmedSet = new Set();
```

**Step 3: Mark ASR confirmations in Track 1 results handler**

At player.js line 600:
```js
unionSet.forEach(i => self.matchedSet.add(i));
```
Change to:
```js
unionSet.forEach(i => {
    self.matchedSet.add(i);
    if (self.vadMatchedSet.has(i)) self.asrConfirmedSet.add(i);
});
```

**Step 4: Mark ASR confirmations in Whisper results handler**

At player.js line 866:
```js
whisperSet.forEach(i => this.matchedSet.add(i));
```
Change to:
```js
whisperSet.forEach(i => {
    this.matchedSet.add(i);
    if (this.vadMatchedSet.has(i)) this.asrConfirmedSet.add(i);
});
```

**Step 5: Mark ASR confirmation in _matchHotWord**

At player.js line 1152:
```js
this.matchedSet.add(this.hotWordIndex);
```
Change to:
```js
this.matchedSet.add(this.hotWordIndex);
if (this.vadMatchedSet.has(this.hotWordIndex)) this.asrConfirmedSet.add(this.hotWordIndex);
```

**Step 6: Update _updateWordSpans() to apply asr-confirmed class**

Current `_updateWordSpans()` at line 1085:
```js
spans.forEach((span, wi) => {
    span.classList.remove('matched', 'missed');
    if (this.matchedSet.has(wi)) {
        span.classList.add('matched');
    }
```

Change to:
```js
spans.forEach((span, wi) => {
    span.classList.remove('matched', 'missed', 'asr-confirmed');
    if (this.matchedSet.has(wi)) {
        span.classList.add('matched');
        if (this.asrConfirmedSet && this.asrConfirmedSet.has(wi)) {
            span.classList.add('asr-confirmed');
        }
    }
```

**Step 7: Add CSS for asr-confirmed in player.html**

In `static/player.html`, after the `.word-span.missed` rule (around line 129), add:

```css
@keyframes confirmPulse {
    0%   { text-shadow: 0 0 0px #fff; }
    50%  { text-shadow: 0 0 8px #fff, 0 0 14px #00e676; }
    100% { text-shadow: 0 0 0px #fff; }
}

.word-span.asr-confirmed {
    animation: confirmPulse 0.4s ease-out;
}
```

**Step 8: Manual test**

Sing along to a fast line. Words should go green immediately (VAD). When Whisper confirms, they should briefly pulse/glow brighter. On slow lines, everything should behave as before.

**Step 9: Commit**

```bash
git add static/player.js static/player.html
git commit -m "feat: ASR confirmation visual upgrade â€” VAD-greened words pulse when ASR later confirms them"
```

---

### Task 8: Debug HUD Additions

**Files:**
- Modify: `static/player.js` (`_renderDebugHud()` ~line 1314, `_renderDebugHud()` Tempo row ~line 1341)

**Step 1: Add song tempo profile row**

In `_renderDebugHud()`, after the Tempo row (line 1343):
```js
html += `<div class="dbg-row"><span class="dbg-label">Tempo </span>${tc} (${wpsVal} wps)</div>`;
```

Add below it:
```js
// Song tempo profile
const p50 = this.songTempoProfile ? this.songTempoProfile.p50.toFixed(2) : 'â€”';
const p80 = this.songTempoProfile ? this.songTempoProfile.p80.toFixed(2) : 'â€”';
const vadMode = (this.wordTimings && this.wordTimings.useVad) ? `VAD:ON (${this.wordTimings.vadTempoClass})` : 'VAD:off';
const vadThresh = this._vadBaselineReady ? `thr:${this._energyThreshold.toFixed(4)}` : 'calibratingâ€¦';
html += `<div class="dbg-row"><span class="dbg-label">Song  </span>p50:${p50} | p80:${p80} | ${vadMode} | ${vadThresh}</div>`;

// ASR confirmation count for current line
const confirmed = this.asrConfirmedSet ? this.asrConfirmedSet.size : 0;
const vadHits = this.vadMatchedSet ? this.vadMatchedSet.size : 0;
html += `<div class="dbg-row"><span class="dbg-label">VAD   </span>hits:${vadHits} | asr-conf:${confirmed}/${this.lineWords.length}</div>`;
```

**Step 2: Manual verification**

Open game mode and press `D` to toggle debug HUD. You should see:
- `Song  p50:X.XX | p80:Y.YY | VAD:ON (fast) | thr:0.0350`
- `VAD   hits:4 | asr-conf:2/8`
- During slow lines: `VAD:off` should appear

**Step 3: Commit**

```bash
git add static/player.js
git commit -m "feat: debug HUD additions â€” song tempo profile, VAD mode, threshold, and confirmation counts"
```

---

## Verification Checklist

After all tasks complete, test these scenarios:

1. **Slow song (e.g., Kendrick "Sing About Me"):** VAD mode off for all/most lines. Scoring identical to before. No regression.
2. **Fast song (e.g., Kendrick "HUMBLE.", any Eminem):** Words light up in real-time as you rap. No more whole verses going red.
3. **Headphone bleed test:** Play without singing. Words should NOT go green from audio bleed (echo cancellation fix).
4. **Ad-lib test:** Don't sing ad-libs. They should stay grey.
5. **Debug HUD:** Press D and verify all new rows display correctly with reasonable values.
