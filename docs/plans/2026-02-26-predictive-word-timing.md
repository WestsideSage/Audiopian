# Consolidated Plan Record

This file merges the original design and implementation documents for this feature.

## Design

# Predictive Word Timing Design

## Problem

Words turn green too late during gameplay. The current system is purely reactive:
sing -> mic capture -> speech recognition (300ms+ interim, 2s Whisper) -> match -> green.
There is no prediction of when words should be sung, so the system waits for full
recognition confidence before marking a word as matched.

## Goal

Reduce green-turn-on latency by 200-500ms using LRC timestamp data to predict when
each word should be sung, enabling the system to accept matches more eagerly when
timing aligns with predictions.

User preference: responsiveness over accuracy. False positives are acceptable and
can be tuned after implementation.

## Approach: Predictive Word Windows + Audio Energy Gating

### 1. Word-Level Timestamp Interpolation

At song load time, compute an estimated timestamp for every word in every line.

**Input:** LRC lines with `{time, text}` pairs (line-level timestamps only).

**Algorithm:**
- Line duration = nextLine.time - thisLine.time (last line: 4s default)
- Estimate syllable count per word using vowel-cluster heuristic
- Distribute line duration across words weighted by syllable count
- Each word gets: `{text, estimatedTime, windowStart, windowEnd}`
- `windowStart` = estimatedTime - 300ms (allow singing slightly early)
- `windowEnd` = estimatedTime + 1500ms (generous late buffer for recognition lag)

**Example:** Line at 10.0s ("don't stop believing"), next line at 14.0s (4s duration):
- "don't" (1 syl): ~10.0s
- "stop" (1 syl): ~10.8s
- "believing" (3 syl): ~11.6s

Computed once, stored on the lyrics data structure.

### 2. Predictive Pre-Arming & Instant Green

**Active word tracking:** A `hotWordIndex` tracks which word's time window contains
the current audio time, updated in the existing 100ms poll loop.

**Prioritized matching for hot words:** When a recognition result fires:
1. Check if spoken words match the currently-hot word (same fuzzy/phonetic logic).
   If yes, turn green immediately.
2. Run the existing full-line drift-window scan for remaining words.

**Interim-boosted matching for hot words:** Interim results (fast but unreliable)
get a lower acceptance bar for hot words. If an interim contains a phonetic match
for the expected word at this moment, accept it. The timing prediction provides
high prior confidence.

**Fallback:** The existing drift-window matching remains as-is. If prediction is
wrong (user skips a word, LRC timing is off), the current system still catches
everything. The prediction layer is purely additive.

**Tunable parameter:** Interim match confidence threshold for hot words. Start
aggressive, dial back if false positives are problematic.

### 3. Audio Energy Gating

**Purpose:** Prevent false greens during silence (e.g., user pauses between words
but LRC prediction says a word should happen now).

**Implementation:**
- Extend existing AudioWorklet (`audio-processor.js`) with lightweight RMS energy
  calculation, posted alongside audio chunks.
- Main thread maintains a rolling `isSpeaking` boolean (energy above threshold).
- Hot-word matching behavior:
  - `isSpeaking` true + partial interim match -> accept (instant green)
  - `isSpeaking` false + partial interim match -> require full match confidence
- ~10 lines in AudioWorklet, ~5 lines in GameMode to consume energy signal.

### 4. Update Loop Integration

No new timers or intervals. Everything uses existing infrastructure:

```
Song load -> interpolate word timestamps (one-time computation)
100ms poll (updateLyrics) -> also update hotWordIndex from audio.currentTime
Recognition fires -> check hot word first (instant green) -> then full-line scan
AudioWorklet -> post energy level -> update isSpeaking flag
```

**Data structures added to GameMode:**
- `wordTimings[]` - interpolated timestamps for current line's words
- `hotWordIndex` - index of word whose window contains current audio time
- `isSpeaking` - boolean from energy gating

## Files Modified

| File | Changes |
|------|---------|
| `static/player.js` | Word interpolation, hot-word tracking, modified matching, energy consumption |
| `static/audio-processor.js` | RMS energy calculation posted with chunks |

## Risk Mitigation

- Interpolation is imprecise for unevenly-paced lines (rap, spoken word). The
  existing drift-window matching handles these cases as it does today.
- Energy gating threshold may need per-environment tuning (mic sensitivity varies).
  A reasonable default with optional config is sufficient.
- Sticky matching semantics are preserved: once green, stays green. Prediction
  cannot make a word un-green.

---

## Implementation

# Predictive Word Timing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce green-turn-on latency by 200-500ms using LRC-interpolated word timestamps to predict when each word should be sung, enabling eager matching during predicted windows.

**Architecture:** At song load, interpolate per-word timestamps from line-level LRC data using syllable-weighted distribution. During gameplay, track a "hot word" index based on audio time. When speech recognition fires, prioritize matching against the hot word for instant green feedback. An audio energy gate (RMS from existing AudioWorklet) prevents false greens during silence.

**Tech Stack:** Plain JavaScript (no new dependencies). Extends existing `GameMode` class in `static/player.js` and `ChunkProcessor` in `static/audio-processor.js`.

---

### Task 1: Syllable Estimation Utility

**Files:**
- Modify: `static/player.js` (insert after `expandContractions` at line 272, before `class GameMode`)

**Step 1: Write the syllable estimation function**

Add this function before the `GameMode` class definition:

```javascript
/**
 * Estimate syllable count for a word using vowel-cluster heuristic.
 * Used to weight word-level timestamp interpolation so longer words
 * get proportionally more time.
 * @param {string} word - lowercase, already normalized
 * @returns {number} estimated syllable count (minimum 1)
 */
function estimateSyllables(word) {
    if (!word) return 1;
    // Remove trailing silent-e
    var w = word.replace(/e$/, '') || word;
    // Count vowel clusters
    var matches = w.match(/[aeiouy]+/gi);
    var count = matches ? matches.length : 1;
    return Math.max(1, count);
}
```

**Step 2: Verify manually**

Open browser console on the player page and test:
```javascript
estimateSyllables('believing')  // expect 3
estimateSyllables('dont')       // expect 1
estimateSyllables('stop')       // expect 1
estimateSyllables('karaoke')    // expect 3
estimateSyllables('me')         // expect 1
```

**Step 3: Commit**

```bash
git add static/player.js
git commit -m "feat: add estimateSyllables utility for word timing interpolation"
```

---

### Task 2: Word Timestamp Interpolation Function

**Files:**
- Modify: `static/player.js` (insert after `estimateSyllables`, before `class GameMode`)

**Step 1: Write the interpolation function**

```javascript
/**
 * Compute estimated per-word timestamps for all lyrics lines.
 * Each word gets {estimatedTime, windowStart, windowEnd} based on
 * syllable-weighted distribution within its line's time span.
 *
 * @param {Array<{time: number, text: string}>} lyricsArr - parsed LRC lines
 * @returns {Array<Array<{word: string, estimatedTime: number, windowStart: number, windowEnd: number}>>}
 *          One array per line, each containing per-word timing data.
 */
function interpolateWordTimings(lyricsArr) {
    var allTimings = [];
    for (var i = 0; i < lyricsArr.length; i++) {
        var line = lyricsArr[i];
        var words = line.text.trim().split(/\s+/);
        if (words.length === 0 || !words[0]) {
            allTimings.push([]);
            continue;
        }

        // Line duration: time to next line, or 4s default for last line
        var lineStart = line.time;
        var lineEnd = (i + 1 < lyricsArr.length) ? lyricsArr[i + 1].time : lineStart + 4.0;
        var lineDuration = lineEnd - lineStart;

        // Compute syllable weights
        var syllables = words.map(function(w) { return estimateSyllables(normalizeWord(w)); });
        var totalSyllables = 0;
        for (var s = 0; s < syllables.length; s++) totalSyllables += syllables[s];

        // Distribute time proportionally by syllable count
        var wordTimings = [];
        var cursor = lineStart;
        for (var wi = 0; wi < words.length; wi++) {
            var wordDuration = (syllables[wi] / totalSyllables) * lineDuration;
            var estimatedTime = cursor;
            wordTimings.push({
                word: normalizeWord(words[wi]),
                estimatedTime: estimatedTime,
                windowStart: estimatedTime - 0.3,  // 300ms early buffer
                windowEnd: estimatedTime + 1.5      // 1500ms late buffer
            });
            cursor += wordDuration;
        }
        allTimings.push(wordTimings);
    }
    return allTimings;
}
```

**Step 2: Verify manually**

In browser console after loading a song:
```javascript
var timings = interpolateWordTimings(lyrics);
console.log(timings[0]); // Should show word timing objects for first line
// Verify: first word's estimatedTime === lyrics[0].time
// Verify: all words span from lineStart to approximately nextLineStart
```

**Step 3: Commit**

```bash
git add static/player.js
git commit -m "feat: add interpolateWordTimings for LRC-based word-level timing"
```

---

### Task 3: Integrate Word Timings into GameMode State

**Files:**
- Modify: `static/player.js` â€” `GameMode` constructor (line ~275), `start()` (line ~309), `setActiveLine()` (line ~516)

**Step 1: Add new state properties to constructor**

In the `GameMode` constructor, after the `this._dbBuf = [];` line (line 306), add:

```javascript
        // Predictive timing state
        this.allWordTimings = [];    // interpolated word timings for all lines
        this.wordTimings    = [];    // word timings for current active line
        this.hotWordIndex   = -1;    // index of word whose time window contains audio.currentTime
        this.isSpeaking     = false; // true when mic energy exceeds threshold
        this._energyThreshold = 0.01; // RMS threshold for voice activity detection
```

**Step 2: Compute timings in `start()`**

In the `start()` method, after `this._lastResultTime = Date.now();` (line 325) and before `renderLyricsGameMode();` (line 327), add:

```javascript
        this.allWordTimings = interpolateWordTimings(lyrics);
        this.wordTimings = [];
        this.hotWordIndex = -1;
        this.isSpeaking = false;
```

**Step 3: Set word timings in `setActiveLine()`**

In `setActiveLine()`, after `this.whisperBuffer = '';` (line 558), add:

```javascript
        // Load interpolated word timings for this line
        this.wordTimings = (lineIdx >= 0 && lineIdx < this.allWordTimings.length)
            ? this.allWordTimings[lineIdx]
            : [];
        this.hotWordIndex = -1;
```

**Step 4: Commit**

```bash
git add static/player.js
git commit -m "feat: wire interpolated word timings into GameMode state"
```

---

### Task 4: Hot Word Tracking in Update Loop

**Files:**
- Modify: `static/player.js` â€” add `updateHotWord()` method to `GameMode`, call it from the existing 100ms poll

**Step 1: Add `updateHotWord()` method to GameMode**

Add this method to the `GameMode` class, after `_updateWordSpans()` (after line 624):

```javascript
    /**
     * Update hotWordIndex based on current audio time.
     * Called every 100ms from the updateLyrics poll.
     * The hot word is the word whose predicted time window contains
     * the current audio time â€” matching this word gets priority.
     */
    updateHotWord() {
        if (!this.active || this.wordTimings.length === 0) {
            this.hotWordIndex = -1;
            return;
        }
        var t = audio.currentTime;
        var newHot = -1;
        for (var i = 0; i < this.wordTimings.length; i++) {
            var wt = this.wordTimings[i];
            if (t >= wt.windowStart && t <= wt.windowEnd) {
                newHot = i;
                break;  // first matching window wins
            }
        }
        this.hotWordIndex = newHot;
    }
```

**Step 2: Call `updateHotWord()` from the 100ms poll**

In the `updateLyrics()` function (line 862), after `gameMode.setActiveLine(idx);` (line 877) and before the closing brace of the `if (gameMode.active)` block, add the hot word update. Also add it as a standalone call that runs every poll regardless of line change.

Modify lines 876-878 from:
```javascript
    if (gameMode.active) {
        gameMode.setActiveLine(idx);
    }
```
to:
```javascript
    if (gameMode.active) {
        gameMode.setActiveLine(idx);
    }
```

And after line 896 (the closing brace of `updateLyrics`), add a separate poll. Actually, better: add the hot word update INSIDE `updateLyrics()` so it runs every 100ms regardless of whether the line changed. Add it after line 878 but before the container scrolling code (line 880):

After the `if (gameMode.active) { gameMode.setActiveLine(idx); }` block and before `const container = ...`, add:

```javascript
    // Update hot word tracking every poll (not just on line change)
    if (gameMode.active) {
        gameMode.updateHotWord();
    }
```

Wait â€” the line-change check has an early return at line 872: `if (idx === currentLineIndex) return;`. The hot word update needs to run even when the line hasn't changed. Move the hot word call to BEFORE the early return, or add a separate call outside. The cleanest approach: add a second interval or restructure. The simplest fix: add the hot word update before the early return:

In `updateLyrics()`, change lines 872-873 from:
```javascript
    if (idx === currentLineIndex) return;
    currentLineIndex = idx;
```
to:
```javascript
    // Update hot word tracking every poll even if line hasn't changed
    if (gameMode.active) gameMode.updateHotWord();

    if (idx === currentLineIndex) return;
    currentLineIndex = idx;
```

**Step 3: Commit**

```bash
git add static/player.js
git commit -m "feat: add hot word tracking updated every 100ms from lyrics poll"
```

---

### Task 5: Predictive Hot-Word Matching in Speech Recognition Handler

**Files:**
- Modify: `static/player.js` â€” `recognition.onresult` handler (line 369) and `_collectMatches` (line 584)

**Step 1: Add hot-word priority matching method**

Add this new method to `GameMode`, after `updateHotWord()`:

```javascript
    /**
     * Attempt to match the current hot word against spoken words.
     * Uses more aggressive matching: accepts any word in the spoken
     * buffer that phonetically matches the hot word, regardless of
     * position. Returns true if the hot word was matched.
     *
     * Only matches if isSpeaking is true (energy gate) OR if the
     * match is an exact/phonetic match (not just edit-distance).
     */
    _matchHotWord(transcript) {
        if (this.hotWordIndex < 0 || this.hotWordIndex >= this.lineWords.length) return false;
        if (this.matchedSet.has(this.hotWordIndex)) return false; // already matched

        var target = this.lineWords[this.hotWordIndex];
        var spoken = normalizeWords(transcript);

        // Search the tail of the spoken buffer for the hot word
        // (only look at recent words â€” last 10)
        var searchStart = Math.max(0, spoken.length - 10);
        for (var i = searchStart; i < spoken.length; i++) {
            if (wordsMatch(spoken[i], target)) {
                // Energy gate: if not speaking, require exact or phonetic match (not edit-distance)
                if (!this.isSpeaking) {
                    if (spoken[i] !== target) {
                        var sp = doubleMetaphone(spoken[i]);
                        var tp = doubleMetaphone(target);
                        var phonetic = sp[0] && tp[0] && (sp[0] === tp[0] || sp[0] === tp[1] || (sp[1] && (sp[1] === tp[0] || sp[1] === tp[1])));
                        if (!phonetic) continue; // skip edit-distance-only matches when silent
                    }
                }
                this.matchedSet.add(this.hotWordIndex);
                return true;
            }
        }
        return false;
    }
```

**Step 2: Call hot-word matching first in the recognition handler**

In `recognition.onresult` (line 369), after the union set is populated and sticky merge is done (after line 395 `unionSet.forEach(i => self.matchedSet.add(i));`), add the hot-word check. Actually, for maximum responsiveness, call it BEFORE the full-line scan so it fires first:

Modify the `onresult` handler. After line 381 (`self.latestInterim = interim;`) and before line 383 (`// Match primary transcript`), insert:

```javascript
            // HOT-WORD PRIORITY: check predicted word first for instant green
            var hotMatched = self._matchHotWord(self.transcript + interim);
            if (hotMatched) self._updateWordSpans();
```

This ensures the hot word turns green in the same event handler tick, before the full-line scan even runs.

**Step 3: Commit**

```bash
git add static/player.js
git commit -m "feat: add predictive hot-word priority matching for faster green feedback"
```

---

### Task 6: Audio Energy Gating in AudioWorklet

**Files:**
- Modify: `static/audio-processor.js` â€” add RMS energy calculation and post it with chunks

**Step 1: Modify the AudioWorklet to post energy data**

Replace the entire `audio-processor.js` with:

```javascript
/**
 * AudioWorklet processor that accumulates Float32 mic samples and emits
 * a 2-second chunk (32000 samples at 16kHz) to the main thread each time
 * the buffer fills. Also posts RMS energy level every ~100ms (1600 samples)
 * for voice activity detection.
 */
class ChunkProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._buf = [];
        this._target = 32000; // 2 seconds at 16 000 Hz
        this._energyBuf = [];
        this._energyTarget = 1600; // ~100ms at 16kHz
    }

    process(inputs) {
        const channel = inputs[0] && inputs[0][0];
        if (!channel) return true;

        for (let i = 0; i < channel.length; i++) {
            this._buf.push(channel[i]);
            this._energyBuf.push(channel[i]);
        }

        // Post energy level every ~100ms for voice activity detection
        if (this._energyBuf.length >= this._energyTarget) {
            const samples = this._energyBuf.splice(0, this._energyTarget);
            let sumSq = 0;
            for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i];
            const rms = Math.sqrt(sumSq / samples.length);
            this.port.postMessage({ type: 'energy', rms: rms });
        }

        // Post audio chunk every 2 seconds for Whisper transcription
        if (this._buf.length >= this._target) {
            const chunk = new Float32Array(this._buf.splice(0, this._target));
            this.port.postMessage({ type: 'chunk', data: chunk });
        }

        return true; // keep processor alive
    }
}

registerProcessor('chunk-processor', ChunkProcessor);
```

**Important:** Messages now have a `type` field: `'energy'` for RMS updates, `'chunk'` for audio data. The consumer in `player.js` must be updated to handle this (Task 7).

**Step 2: Commit**

```bash
git add static/audio-processor.js
git commit -m "feat: add RMS energy posting to AudioWorklet for voice activity detection"
```

---

### Task 7: Consume Energy Data and Update Message Handler

**Files:**
- Modify: `static/player.js` â€” `_startWhisperTrack()` (line 445), update the `port.onmessage` handler

**Step 1: Update the message handler to handle typed messages**

In `_startWhisperTrack()`, replace the `port.onmessage` handler (lines 452-454) from:

```javascript
            this._whisperNode.port.onmessage = (e) => {
                if (this.active) this._sendChunkToWhisper(e.data);
            };
```

to:

```javascript
            this._whisperNode.port.onmessage = (e) => {
                if (!this.active) return;
                var msg = e.data;
                if (msg && msg.type === 'energy') {
                    // Update voice activity detection flag
                    this.isSpeaking = msg.rms > this._energyThreshold;
                } else if (msg && msg.type === 'chunk') {
                    this._sendChunkToWhisper(msg.data);
                } else if (msg instanceof Float32Array) {
                    // Backward compat: raw Float32Array (shouldn't happen but safe)
                    this._sendChunkToWhisper(msg);
                }
            };
```

**Step 2: Commit**

```bash
git add static/player.js
git commit -m "feat: consume AudioWorklet energy data for voice activity gating"
```

---

### Task 8: Add Predictive Timing to Debug HUD

**Files:**
- Modify: `static/player.js` â€” `_renderDebugHud()` method (line 752)

**Step 1: Add hot word and energy info to debug HUD**

In `_renderDebugHud()`, after the line showing `wBuf` and `wStart` (line 774), add:

```javascript
        html += `<div class="dbg-row"><span class="dbg-label">Hot   </span>word[${this.hotWordIndex}] ${this.hotWordIndex >= 0 && this.wordTimings[this.hotWordIndex] ? this.wordTimings[this.hotWordIndex].word : 'â€”'} | speaking: ${this.isSpeaking ? 'YES' : 'no'}</div>`;
```

**Step 2: Commit**

```bash
git add static/player.js
git commit -m "feat: show hot word and energy state in debug HUD"
```

---

### Task 9: Manual Integration Testing

**Files:** None (testing only)

**Step 1: Load a song and enable debug mode**

1. Start the Flask server: `python app.py`
2. Open browser, search for a slower song (e.g., "Let It Be" by The Beatles)
3. Press `D` to enable debug HUD
4. Click the game mode button

**Step 2: Verify hot word tracking**

Watch the debug HUD's "Hot" line. As the song plays, the hot word index should advance through each word roughly in time with the lyrics. Verify:
- Hot word index advances during each line
- It resets when a new line starts
- The word shown matches what's expected at that point in the song

**Step 3: Verify improved green responsiveness**

Sing along and observe:
- Words should turn green faster than before, especially when on-beat
- When you pause/stop singing, false greens should NOT appear (energy gate)
- The existing full-line matching should still work as fallback for off-beat words

**Step 4: Test a fast song**

Search for a faster song (rap or uptempo). Verify:
- Hot word tracking doesn't crash or lag
- Words still get matched (may be less precise due to interpolation, but no worse than before)
- Score still tallies correctly at end

**Step 5: Commit (no code changes, this is testing only)**

No commit needed unless bugs are found. If bugs found, fix and commit each fix individually.

---

### Task 10: Final Review and Cleanup

**Step 1: Review all changes**

```bash
git diff main..HEAD --stat
git log --oneline main..HEAD
```

Verify:
- No unintended file changes
- All commits have clear messages
- No debug `console.log` statements left (except inside `_kDebug` guards)

**Step 2: Ensure backward compatibility**

- Game mode without the predictive layer (e.g., if `allWordTimings` is empty) should work identically to before
- Non-game-mode (normal lyric display) is completely unaffected
- AudioWorklet backward compat handler catches old-format messages
