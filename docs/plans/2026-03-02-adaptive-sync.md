# Consolidated Plan Record

This file merges the original design and implementation documents for this feature.

## Design

# Adaptive Sync & Soft Boundaries Design

**Date:** 2026-03-02
**Goal:** Improve detection reliability across all tempos (ballads to fast rap), fix premature line cutoff at any line transition, and reduce latency on fast sections.

## Problem Statement

Three related issues:

1. **Line transitions cut off words** â€” the hard fence reset in `setActiveLine()` destroys the old line's matching context immediately. The 800ms late-score delay with -4 word lookback is a fragile second-chance mechanism that fails on fast songs.
2. **Fast songs produce mixed failures** â€” words never match, match late, or match on the wrong line. Fixed constants (window sizes, drift, chunk size) don't adapt to tempo.
3. **Back-to-back fast bars** â€” ASR latency (200-600ms for Web Speech, 2s+ for Whisper) means results arrive after the line has already transitioned, and the fence blocks them.

## Approach

**Approach 1 + selective Approach 3:** Adaptive constants based on per-line tempo, soft line boundaries with overlap zones, and dynamic Whisper chunk sizing for fast sections.

## Design

### 1. Tempo Analysis & Line Classification

Extend `interpolateWordTimings()` to compute per-line tempo metrics.

**Computed per line:**
- `wordsPerSecond` = word count / line duration
- `tempoClass` = slow | normal | fast

| Class    | WPS Range | Examples                              |
|----------|-----------|---------------------------------------|
| `slow`   | < 2.0     | Ballads, sustained notes, sparse lines |
| `normal` | 2.0 â€“ 5.0 | Pop, rock, most singing               |
| `fast`   | > 5.0     | Rap, fast-patter, spoken word          |

Stored on the existing `wordTimings` line metadata. Computed once at lyrics load â€” zero runtime cost.

**Last-line edge case:** Use `audio.duration` when available (clamped to max 8s) instead of the current `lineStart + 4.0s` fallback.

### 2. Adaptive Time Windows

Scale matching window constants based on `tempoClass`.

| Constant         | `slow` | `normal` | `fast` |
|------------------|--------|----------|--------|
| `windowStart`    | -0.3s  | -0.3s    | -0.5s  |
| `windowEnd`      | +1.5s  | +1.5s    | +2.5s  |
| Drift (Track 1)  | 14     | 18       | 25     |
| Drift (Track 2)  | 12     | 15       | 20     |

**Rationale:**
- Fast lines: words ~125ms apart, ASR latency 300-600ms â†’ results arrive 2-5 words late. Wider `windowEnd` and larger drift accommodate this.
- Fast singers anticipate beats â†’ `-0.5s` early buffer.
- Slow lines: tighter drift (14) reduces cross-line matching risk.

**Implementation:** `getWindowParams(tempoClass)` helper returns constants. Called once per `setActiveLine()`, stored on GameMode. All matching functions read from stored values.

### 3. Soft Line Boundaries

Replace the hard fence reset with an overlap zone where both the old and new line match simultaneously.

**Current (hard boundary):**
1. Line change detected â†’ `setActiveLine()` called
2. Old line state snapshotted, fence reset, matchedSet cleared
3. 800ms later, `_lateScoreLine()` tries -4 lookback
4. ASR results after 800ms are lost

**Proposed (soft boundary):**

```
LINE N active          OVERLAP ZONE           LINE N+1 active
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¤ â† lineN+1.time â†’ â”œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
                  â”‚                   â”‚
  matching lineN  â”‚  matching BOTH    â”‚  matching lineN+1
  scoring lineN   â”‚  scoring both     â”‚  scoring lineN+1
                  â”‚                   â”‚
                  â”‚â† overlapDuration â†’â”‚
```

**Overlap duration by tempo:**

| tempoClass | Overlap |
|------------|---------|
| `slow`     | 1.0s    |
| `normal`   | 0.8s    |
| `fast`     | 0.5s    |

**Mechanics:**
1. On line change, old line's `matchedSet`, `lineWords`, and fence are preserved in a `prevLine` overlay (not destroyed).
2. Incoming ASR results match against both old line (unmatched words) and new line.
3. Each lyric word belongs to exactly one line â€” no competition or theft.
4. Old line checked first (overdue words), then new line.
5. After `overlapDuration`, old line is finalized and overlay discarded.

**What this fixes:**
- ASR finals arriving 200-800ms after line change still credit the correct line.
- Fast transitions get shorter overlap (0.5s) so they don't pile up.
- Eliminates the need for the -4 lookback hack.

### 4. Dynamic Late Scoring

Replace fixed 800ms `_lateScoreLine()` with tempo-aware timing anchored to the overlap zone.

**Score delay by tempo (measured from end of overlap zone):**

| tempoClass | Score delay | Total from line change |
|------------|-------------|------------------------|
| `slow`     | 1.2s        | 2.2s                   |
| `normal`   | 0.8s        | 1.6s                   |
| `fast`     | 0.5s        | 1.0s                   |

**Simplifications enabled by soft boundaries:**
- No -4 word lookback needed â€” overlap already captured late matches.
- No snapshot-and-freeze â€” scoring reads final state of the `prevLine` overlay.

**Fallback:** If the score timer fires while the next overlap is already active (extremely fast succession), score from whatever matches exist at that moment.

### 5. Dynamic Whisper Chunks

Reduce AudioWorklet chunk size for fast sections so Whisper results arrive sooner.

| tempoClass | Chunk size | Samples (16kHz) | Expected Whisper latency |
|------------|-----------|-----------------|--------------------------|
| `slow`     | 2.0s      | 32000           | ~2.5-3s                  |
| `normal`   | 1.5s      | 24000           | ~2-2.5s                  |
| `fast`     | 0.75s     | 12000           | ~1-1.5s                  |

**How tempo reaches the AudioWorklet:**
- `setActiveLine()` posts a message: `port.postMessage({ type: 'setChunkSize', samples: N })`
- AudioWorklet updates `chunkTarget` on the fly â€” no restart needed.

**Backend:** `faster-whisper` with `large-v3-turbo` on GPU handles 0.75s audio in ~100-200ms. At 0.75s intervals, request rate is ~1.3/s â€” trivial for local Flask.

## Files Affected

| File | Changes |
|------|---------|
| `static/player.js` | Tempo analysis, adaptive windows, soft boundaries, dynamic scoring |
| `static/audio-processor.js` | Dynamic chunk target via message handler |
| `app.py` | None expected (Whisper endpoint already handles variable-length audio) |

## Non-Goals

- No changes to phonetic matching, contraction expansion, or edit distance logic.
- No changes to the Web Speech API recognition setup (continuous mode, alternatives, etc.).
- No changes to the debug HUD layout (though it should display tempoClass and overlap state).

---

## Implementation

# Adaptive Sync & Soft Boundaries Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Improve detection reliability across all tempos by making time windows, line boundaries, late scoring, and Whisper chunk sizes adapt to per-line tempo.

**Architecture:** Extract pure helper functions (`classifyTempo`, `getWindowParams`, `getOverlapDuration`, `getScoreDelay`) that map tempo metrics to adaptive constants. Modify `interpolateWordTimings()` to compute per-line WPS and tempoClass. Rework `setActiveLine()` to preserve old-line state in a `prevLine` overlay during an overlap zone. Modify `_collectMatches`, `_collectMatchesWhisper`, and `_matchHotWord` to match against both current and previous line during overlap. Update AudioWorklet to accept dynamic chunk sizes.

**Tech Stack:** Plain JavaScript (no bundler), AudioWorklet API, Flask backend (no backend changes needed)

**Testing note:** This project has no JS test framework. Tasks 1 and 2 extract pure functions into `static/sync-helpers.js` with a companion Node.js test file `tests/test_sync_helpers.js` using `node:assert`. Integration tasks are verified via the debug HUD and manual testing with slow/fast songs.

---

### Task 1: Create sync-helpers.js with classifyTempo and getWindowParams

**Files:**
- Create: `static/sync-helpers.js`
- Create: `tests/test_sync_helpers.js`
- Modify: `static/player.html` (add script tag)

**Step 1: Write the failing test**

Create `tests/test_sync_helpers.js`:

```js
const assert = require('node:assert');
const { classifyTempo, getWindowParams, getOverlapDuration, getScoreDelay } = require('../static/sync-helpers.js');

// --- classifyTempo ---
assert.strictEqual(classifyTempo(1.0), 'slow');
assert.strictEqual(classifyTempo(1.9), 'slow');
assert.strictEqual(classifyTempo(2.0), 'normal');
assert.strictEqual(classifyTempo(5.0), 'normal');
assert.strictEqual(classifyTempo(5.1), 'fast');
assert.strictEqual(classifyTempo(10.0), 'fast');
assert.strictEqual(classifyTempo(0), 'slow');       // edge: zero
assert.strictEqual(classifyTempo(-1), 'slow');       // edge: negative

// --- getWindowParams ---
const slow = getWindowParams('slow');
assert.strictEqual(slow.windowStart, -0.3);
assert.strictEqual(slow.windowEnd, 1.5);
assert.strictEqual(slow.driftTrack1, 14);
assert.strictEqual(slow.driftTrack2, 12);

const normal = getWindowParams('normal');
assert.strictEqual(normal.windowStart, -0.3);
assert.strictEqual(normal.windowEnd, 1.5);
assert.strictEqual(normal.driftTrack1, 18);
assert.strictEqual(normal.driftTrack2, 15);

const fast = getWindowParams('fast');
assert.strictEqual(fast.windowStart, -0.5);
assert.strictEqual(fast.windowEnd, 2.5);
assert.strictEqual(fast.driftTrack1, 25);
assert.strictEqual(fast.driftTrack2, 20);

// fallback: unknown class defaults to normal
const unknown = getWindowParams('unknown');
assert.deepStrictEqual(unknown, normal);

// --- getOverlapDuration ---
assert.strictEqual(getOverlapDuration('slow'), 1.0);
assert.strictEqual(getOverlapDuration('normal'), 0.8);
assert.strictEqual(getOverlapDuration('fast'), 0.5);
assert.strictEqual(getOverlapDuration('unknown'), 0.8);

// --- getScoreDelay ---
assert.strictEqual(getScoreDelay('slow'), 1.2);
assert.strictEqual(getScoreDelay('normal'), 0.8);
assert.strictEqual(getScoreDelay('fast'), 0.5);
assert.strictEqual(getScoreDelay('unknown'), 0.8);

console.log('All sync-helpers tests passed.');
```

**Step 2: Run test to verify it fails**

Run: `node tests/test_sync_helpers.js`
Expected: FAIL with "Cannot find module '../static/sync-helpers.js'"

**Step 3: Write minimal implementation**

Create `static/sync-helpers.js`:

```js
/**
 * Pure helper functions for adaptive sync timing.
 * No DOM or AudioContext dependencies â€” testable in Node.js.
 */

/**
 * Classify a line's tempo based on words-per-second.
 * @param {number} wps - words per second for the line
 * @returns {'slow'|'normal'|'fast'}
 */
function classifyTempo(wps) {
    if (wps > 5.0) return 'fast';
    if (wps >= 2.0) return 'normal';
    return 'slow';
}

/**
 * Return adaptive matching window constants for a tempo class.
 * @param {'slow'|'normal'|'fast'} tempoClass
 * @returns {{ windowStart: number, windowEnd: number, driftTrack1: number, driftTrack2: number }}
 */
function getWindowParams(tempoClass) {
    switch (tempoClass) {
        case 'slow':   return { windowStart: -0.3, windowEnd: 1.5, driftTrack1: 14, driftTrack2: 12 };
        case 'fast':   return { windowStart: -0.5, windowEnd: 2.5, driftTrack1: 25, driftTrack2: 20 };
        case 'normal': // fall through
        default:       return { windowStart: -0.3, windowEnd: 1.5, driftTrack1: 18, driftTrack2: 15 };
    }
}

/**
 * Return overlap duration (seconds) for soft line boundaries.
 * @param {'slow'|'normal'|'fast'} tempoClass
 * @returns {number}
 */
function getOverlapDuration(tempoClass) {
    switch (tempoClass) {
        case 'slow':   return 1.0;
        case 'fast':   return 0.5;
        case 'normal': // fall through
        default:       return 0.8;
    }
}

/**
 * Return late-score delay (seconds) measured from end of overlap zone.
 * @param {'slow'|'normal'|'fast'} tempoClass
 * @returns {number}
 */
function getScoreDelay(tempoClass) {
    switch (tempoClass) {
        case 'slow':   return 1.2;
        case 'fast':   return 0.5;
        case 'normal': // fall through
        default:       return 0.8;
    }
}

/**
 * Return AudioWorklet chunk target (samples at 16kHz) for a tempo class.
 * @param {'slow'|'normal'|'fast'} tempoClass
 * @returns {number}
 */
function getChunkSamples(tempoClass) {
    switch (tempoClass) {
        case 'slow':   return 32000; // 2.0s
        case 'fast':   return 12000; // 0.75s
        case 'normal': // fall through
        default:       return 24000; // 1.5s
    }
}

// Node.js exports for testing; browser ignores this
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { classifyTempo, getWindowParams, getOverlapDuration, getScoreDelay, getChunkSamples };
}
```

**Step 4: Run test to verify it passes**

Run: `node tests/test_sync_helpers.js`
Expected: "All sync-helpers tests passed."

**Step 5: Add script tag to player.html**

In `static/player.html`, add before the `player.js` script tag:

```html
<script src="/static/sync-helpers.js"></script>
```

**Step 6: Commit**

```bash
git add static/sync-helpers.js tests/test_sync_helpers.js static/player.html
git commit -m "feat: add sync-helpers with tempo classification and adaptive constants"
```

---

### Task 2: Extend interpolateWordTimings to compute per-line tempo metadata

**Files:**
- Modify: `static/player.js:300-338` (`interpolateWordTimings` function)
- Modify: `tests/test_sync_helpers.js` (add tests for timing metadata)

**Step 1: Write the failing test**

Append to `tests/test_sync_helpers.js`, above the final console.log:

```js
// --- interpolateWordTimings tempo metadata ---
// We need to test this function too. Import it from player.js is impractical
// (DOM dependencies), so we test the logic by extracting the WPS calculation.
// The actual integration is: interpolateWordTimings calls classifyTempo(wps).

// Verify WPS calculation formula
function computeWps(wordCount, lineStart, lineEnd) {
    const duration = lineEnd - lineStart;
    if (duration <= 0) return 0;
    return wordCount / duration;
}

// Slow: 3 words in 4 seconds = 0.75 wps
assert.strictEqual(classifyTempo(computeWps(3, 0, 4)), 'slow');
// Normal: 6 words in 2 seconds = 3.0 wps
assert.strictEqual(classifyTempo(computeWps(6, 10, 12)), 'normal');
// Fast: 12 words in 1.5 seconds = 8.0 wps
assert.strictEqual(classifyTempo(computeWps(12, 20, 21.5)), 'fast');
// Edge: last line with audio.duration fallback (8s clamp)
assert.strictEqual(classifyTempo(computeWps(4, 180, 188)), 'slow');
```

**Step 2: Run test to verify it passes**

Run: `node tests/test_sync_helpers.js`
Expected: PASS (these only test classifyTempo with computed WPS values)

**Step 3: Modify interpolateWordTimings in player.js**

In `static/player.js`, replace lines 300-338 (the `interpolateWordTimings` function) with the version below. Key changes:
- Use `audio.duration` for last-line fallback (clamped to 8s), falling back to `lineStart + 4.0` if unavailable
- Compute `wps` and `tempoClass` per line
- Use `getWindowParams(tempoClass)` for per-word `windowStart`/`windowEnd` instead of hardcoded `-0.3`/`+1.5`
- Store `wps`, `tempoClass`, `lineStart`, `lineEnd` as metadata on each line's timing array

```js
/**
 * Compute estimated per-word timestamps for all lyrics lines.
 * Each word gets {estimatedTime, windowStart, windowEnd} based on
 * syllable-weighted distribution within its line's time span.
 * Each line's array also gets metadata: wps, tempoClass, lineStart, lineEnd.
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
            var empty = [];
            empty.wps = 0;
            empty.tempoClass = 'slow';
            empty.lineStart = line.time;
            empty.lineEnd = line.time;
            allTimings.push(empty);
            continue;
        }

        // Line duration: time to next line, or audio.duration for last line (clamped to 8s)
        var lineStart = line.time;
        var lineEnd;
        if (i + 1 < lyricsArr.length) {
            lineEnd = lyricsArr[i + 1].time;
        } else {
            // Last line: use audio duration if available, else fallback to +4s
            var audioDur = (typeof audio !== 'undefined' && audio.duration && isFinite(audio.duration))
                ? audio.duration : lineStart + 4.0;
            lineEnd = Math.min(audioDur, lineStart + 8.0);
        }
        var lineDuration = lineEnd - lineStart;

        // Compute per-line tempo
        var wps = lineDuration > 0 ? words.length / lineDuration : 0;
        var tempoClass = classifyTempo(wps);
        var params = getWindowParams(tempoClass);

        // Compute syllable weights
        var syllables = words.map(function(w) { return estimateSyllables(normalizeWord(w)); });
        var totalSyllables = 0;
        for (var s = 0; s < syllables.length; s++) totalSyllables += syllables[s];
        if (totalSyllables === 0) totalSyllables = 1; // defensive guard

        // Distribute time proportionally by syllable count
        var wordTimings = [];
        var cursor = lineStart;
        for (var wi = 0; wi < words.length; wi++) {
            var wordDuration = (syllables[wi] / totalSyllables) * lineDuration;
            var estimatedTime = cursor;
            wordTimings.push({
                word: normalizeWord(words[wi]),
                estimatedTime: estimatedTime,
                windowStart: estimatedTime + params.windowStart,
                windowEnd: estimatedTime + params.windowEnd
            });
            cursor += wordDuration;
        }

        // Attach line-level metadata to the array
        wordTimings.wps = wps;
        wordTimings.tempoClass = tempoClass;
        wordTimings.lineStart = lineStart;
        wordTimings.lineEnd = lineEnd;

        allTimings.push(wordTimings);
    }
    return allTimings;
}
```

**Step 4: Verify existing tests still pass**

Run: `node tests/test_sync_helpers.js`
Expected: PASS

**Step 5: Commit**

```bash
git add static/player.js tests/test_sync_helpers.js
git commit -m "feat: extend interpolateWordTimings with per-line tempo classification"
```

---

### Task 3: Wire adaptive drift windows into _collectMatches and _collectMatchesWhisper

**Files:**
- Modify: `static/player.js:698-720` (`_collectMatches`)
- Modify: `static/player.js:596-621` (`_collectMatchesWhisper`)
- Modify: `static/player.js:623-696` (`setActiveLine` â€” store current window params)

**Step 1: Add currentParams storage to GameMode constructor**

In `static/player.js`, add to the constructor (after line 380, the `_energyThreshold` line):

```js
        this.currentParams = getWindowParams('normal'); // adaptive window params for active line
```

**Step 2: Set currentParams in setActiveLine**

In `setActiveLine()`, after loading `this.wordTimings` (line 671), add:

```js
        // Load adaptive window params for this line's tempo
        this.currentParams = (this.wordTimings && this.wordTimings.tempoClass)
            ? getWindowParams(this.wordTimings.tempoClass)
            : getWindowParams('normal');
```

**Step 3: Update _collectMatches to use adaptive drift**

In `_collectMatches` (line 698-720), replace the hardcoded `driftWindow = 18` with:

```js
    _collectMatches(transcript, resultSet) {
        if (this.lineWords.length === 0) return;
        var spoken = normalizeWords(transcript);
        var spokenIdx = this.lineStartTranscriptPos;
        var now = audio.currentTime;
        var driftWindow = this.currentParams.driftTrack1;
        for (var li = 0; li < this.lineWords.length; li++) {
            if (li < this.wordTimings.length) {
                if (now < this.wordTimings[li].windowStart) continue;
            }
            var target = this.lineWords[li];
            for (var si = spokenIdx; si < Math.min(spokenIdx + driftWindow, spoken.length); si++) {
                if (wordsMatch(spoken[si], target)) {
                    resultSet.add(li);
                    spokenIdx = si + 1;
                    break;
                }
            }
        }
    }
```

**Step 4: Update _collectMatchesWhisper to use adaptive drift**

In `_collectMatchesWhisper` (line 596-621), replace the hardcoded `driftWindow = 15` with:

```js
    _collectMatchesWhisper(transcript) {
        if (this.lineWords.length === 0) return;
        const spoken = normalizeWords(transcript);
        const whisperSet = new Set();
        let spokenIdx = 0;
        var now = audio.currentTime;
        var driftWindow = this.currentParams.driftTrack2;
        for (let li = 0; li < this.lineWords.length; li++) {
            if (li < this.wordTimings.length) {
                if (now < this.wordTimings[li].windowStart) continue;
            }
            const target = this.lineWords[li];
            for (let si = spokenIdx; si < Math.min(spokenIdx + driftWindow, spoken.length); si++) {
                if (wordsMatch(spoken[si], target)) {
                    whisperSet.add(li);
                    spokenIdx = si + 1;
                    break;
                }
            }
        }
        whisperSet.forEach(i => this.matchedSet.add(i));
        this._updateWordSpans();
    }
```

**Step 5: Verify tests still pass**

Run: `node tests/test_sync_helpers.js`
Expected: PASS

**Step 6: Commit**

```bash
git add static/player.js
git commit -m "feat: wire adaptive drift windows into _collectMatches and _collectMatchesWhisper"
```

---

### Task 4: Implement soft line boundaries with prevLine overlay

This is the biggest change. It reworks `setActiveLine()` to preserve old-line matching context and modifies `_collectMatches`/`_collectMatchesWhisper`/`_matchHotWord` to match against both lines during the overlap zone.

**Files:**
- Modify: `static/player.js` â€” `GameMode` constructor, `setActiveLine`, `_collectMatches`, `_collectMatchesWhisper`, `_matchHotWord`

**Step 1: Add prevLine state to GameMode constructor**

In the constructor, after `this.currentParams` (added in Task 3), add:

```js
        // Soft boundary: previous line overlay during overlap zone
        this.prevLine = null;  // { lineIdx, lineWords, matchedSet, lineStartWordCount, lineStartTranscriptPos, wordTimings, params, overlapEnd }
```

**Step 2: Add _finalizePrevLine helper**

Add this new method to GameMode, before `_collectMatches`:

```js
    /**
     * Finalize and score the previous line's overlay, then discard it.
     * Called when the overlap zone expires or when a new overlap begins.
     */
    _finalizePrevLine() {
        if (!this.prevLine) return;
        const prev = this.prevLine;
        this.prevLine = null;

        // Score the previous line with its final match state
        if (prev.lineWords.length > 0) {
            this._scoreLine(prev.lineIdx, prev.lineWords, prev.matchedSet);
        }
    }
```

**Step 3: Rework setActiveLine to use soft boundaries**

Replace the entire `setActiveLine` method with:

```js
    setActiveLine(lineIdx) {
        // Capture outgoing state for diagnostics BEFORE anything changes
        const _dbgFromIdx  = this.activeLineIdx;
        const _dbgFromText = (_dbgFromIdx >= 0 && lyrics[_dbgFromIdx]) ? lyrics[_dbgFromIdx].text : 'â€”';

        // --- Soft boundary: preserve outgoing line as prevLine overlay ---
        // If there's already a prevLine overlay, finalize it first (fast succession)
        this._finalizePrevLine();

        // Create overlay for the outgoing line (if it had words to match)
        if (this.activeLineIdx >= 0 && this.lineWords.length > 0) {
            const outgoingTempoClass = (this.wordTimings && this.wordTimings.tempoClass) || 'normal';
            const overlapDuration = getOverlapDuration(outgoingTempoClass);
            const scoreDelay = getScoreDelay(outgoingTempoClass);

            this.prevLine = {
                lineIdx:                this.activeLineIdx,
                lineWords:              this.lineWords.slice(),
                matchedSet:             new Set(this.matchedSet),
                lineStartWordCount:     this.lineStartWordCount,
                lineStartTranscriptPos: this.lineStartTranscriptPos,
                wordTimings:            this.wordTimings,
                params:                 this.currentParams,
                overlapEnd:             performance.now() + (overlapDuration * 1000),
                whisperBuffer:          this.whisperBuffer,
            };

            // Schedule finalization after overlap + score delay
            const totalDelay = (overlapDuration + scoreDelay) * 1000;
            const capturedLineIdx = this.activeLineIdx;
            setTimeout(() => {
                // Only finalize if this prevLine is still the active overlay
                if (this.prevLine && this.prevLine.lineIdx === capturedLineIdx) {
                    this._finalizePrevLine();
                }
            }, totalDelay);
        }

        // Diagnostic: log transition
        if (window._kDebug && _dbgFromIdx >= 0 && this.lineWords.length > 0) {
            this._debugLog('LINE', {
                fromIdx:       _dbgFromIdx,
                fromText:      _dbgFromText,
                toIdx:         lineIdx,
                toText:        (lineIdx >= 0 && lyrics[lineIdx]) ? lyrics[lineIdx].text : 'â€”',
                matched:       this.matchedSet.size,
                total:         this.lineWords.length,
                missedWords:   this.lineWords.filter((w, i) => !this.matchedSet.has(i)).join(', '),
                transcriptTail: normalizeWords(this.transcript).slice(-8).join(' '),
                interim:       this.latestInterim,
            });
        }

        // --- Set up new line ---
        this.activeLineIdx = lineIdx;
        this.lineStartWordCount = normalizeWords(this.transcript).length;
        this.lineStartTranscriptPos = this.lineStartWordCount;
        this.matchedSet = new Set();
        this.whisperBuffer = '';

        // Load interpolated word timings for this line
        this.wordTimings = (lineIdx >= 0 && lineIdx < this.allWordTimings.length)
            ? this.allWordTimings[lineIdx]
            : [];
        this.hotWordIndex = -1;

        // Load adaptive window params for this line's tempo
        this.currentParams = (this.wordTimings && this.wordTimings.tempoClass)
            ? getWindowParams(this.wordTimings.tempoClass)
            : getWindowParams('normal');

        if (lineIdx < 0 || lineIdx >= lyrics.length) {
            this.lineWords = [];
            return;
        }

        const lineText = lyrics[lineIdx].text.trim();
        if (!lineText || lineText === 'â™ª' || lineText === 'â™«') {
            this.lineWords = [];
            return;
        }

        const rawWords = lineText.split(' ');
        this.lineWords = rawWords.map(w => normalizeWord(w));

        // Reset spans to grey for new active line
        const lines = lyricsScroll.querySelectorAll('.lyric-line');
        if (lines[lineIdx]) {
            lines[lineIdx].querySelectorAll('.word-span').forEach(s => {
                s.classList.remove('matched', 'missed');
            });
        }
    }
```

**Step 4: Add _matchPrevLine helper for overlap matching**

Add this new method to GameMode, after `_finalizePrevLine`:

```js
    /**
     * During the overlap zone, attempt to match ASR words against the
     * previous line's unmatched words. Returns true if any match was found.
     * @param {string} transcript - full transcript (Track 1) or whisper buffer (Track 2)
     * @param {'track1'|'track2'} track
     */
    _matchPrevLine(transcript, track) {
        if (!this.prevLine) return false;
        if (performance.now() > this.prevLine.overlapEnd) return false;

        const prev = this.prevLine;
        const spoken = normalizeWords(transcript);
        const spokenIdx = (track === 'track1') ? prev.lineStartTranscriptPos : 0;
        const driftWindow = (track === 'track1') ? prev.params.driftTrack1 : prev.params.driftTrack2;
        let cursor = spokenIdx;
        let anyMatched = false;

        for (let li = 0; li < prev.lineWords.length; li++) {
            if (prev.matchedSet.has(li)) { cursor++; continue; }
            const target = prev.lineWords[li];
            for (let si = cursor; si < Math.min(cursor + driftWindow, spoken.length); si++) {
                if (wordsMatch(spoken[si], target)) {
                    prev.matchedSet.add(li);
                    cursor = si + 1;
                    anyMatched = true;
                    // Light the span green on the previous line
                    const allLines = lyricsScroll.querySelectorAll('.lyric-line');
                    const lineEl = allLines[prev.lineIdx];
                    if (lineEl) {
                        const span = lineEl.querySelectorAll('.word-span')[li];
                        if (span) { span.classList.remove('missed'); span.classList.add('matched'); }
                    }
                    break;
                }
            }
        }
        return anyMatched;
    }
```

**Step 5: Wire prevLine matching into recognition.onresult**

In `_setupRecognition` â†’ `recognition.onresult` handler (around line 462-478), after the hot-word check and `_collectMatches` block, add prevLine matching. The full block becomes:

```js
            // HOT-WORD PRIORITY: check predicted word first for instant green
            var hotMatched = self._matchHotWord(self.transcript + interim);
            if (hotMatched) self._updateWordSpans();

            // Match against previous line during overlap zone (Track 1)
            self._matchPrevLine(self.transcript + interim, 'track1');

            // Match primary transcript
            var unionSet = new Set();
            self._collectMatches(self.transcript + interim, unionSet);

            // Union with alternative transcripts from latest result
            var latest = e.results[e.results.length - 1];
            for (var a = 1; a < latest.length; a++) {
                self._collectMatches(self.transcript + latest[a].transcript, unionSet);
            }

            // Sticky: once matched, stay matched
            unionSet.forEach(i => self.matchedSet.add(i));
            self._updateWordSpans();
```

**Step 6: Wire prevLine matching into _collectMatchesWhisper**

At the end of `_collectMatchesWhisper`, after `this._updateWordSpans()`, add:

```js
        // Match against previous line during overlap zone (Track 2)
        if (this.prevLine) {
            this._matchPrevLine(this.prevLine.whisperBuffer + ' ' + transcript, 'track2');
        }
```

**Step 7: Remove the old _lateScoreLine call from setActiveLine**

The old `setTimeout(() => this._lateScoreLine(...), 800)` block in `setActiveLine` has been replaced by the soft boundary mechanism. The `_lateScoreLine` method itself is kept for the `audio.ended` handler (final line of song).

**Step 8: Update audio.ended handler**

In the `audio.addEventListener('ended', ...)` handler (around line 1145-1161), update to work with soft boundaries:

```js
audio.addEventListener('ended', () => {
    if (gameMode.active) {
        // Finalize any active prevLine overlay
        if (gameMode.prevLine) {
            setTimeout(() => gameMode._finalizePrevLine(), 500);
        }
        // Score the final line
        if (gameMode.activeLineIdx >= 0 && gameMode.lineWords.length > 0) {
            const _lastLineIdx   = gameMode.activeLineIdx;
            const _lastLineWords = gameMode.lineWords.slice();
            const _lastMatched   = new Set(gameMode.matchedSet);
            const _lastLineStart = gameMode.lineStartWordCount;
            setTimeout(() => gameMode._lateScoreLine(
                _lastLineIdx, _lastLineWords, _lastMatched, _lastLineStart
            ), 800);
        }
        setTimeout(() => gameMode.showEndModal(), 1500);
    }
});
```

**Step 9: Reset prevLine in start() and stop()**

In `start()` (line 383-413), add after `this.whisperBuffer = '';`:

```js
        this.prevLine = null;
```

In `stop()` (line 415-431), add after `this._stopWhisperTrack();`:

```js
        this.prevLine = null;
```

**Step 10: Verify tests still pass**

Run: `node tests/test_sync_helpers.js`
Expected: PASS

**Step 11: Commit**

```bash
git add static/player.js
git commit -m "feat: implement soft line boundaries with prevLine overlap zone"
```

---

### Task 5: Add debug HUD display for tempo and overlap state

**Files:**
- Modify: `static/player.js` â€” `_renderDebugHud` method

**Step 1: Add tempo and overlap info to the debug HUD**

In `_renderDebugHud()` (around line 932), find the section that builds the HUD HTML. Add after the existing line info display:

```js
        // Tempo classification
        const tc = (this.wordTimings && this.wordTimings.tempoClass) || 'â€”';
        const wps = (this.wordTimings && this.wordTimings.wps) ? this.wordTimings.wps.toFixed(1) : 'â€”';

        // Overlap state
        const overlapActive = this.prevLine && performance.now() < this.prevLine.overlapEnd;
        const overlapInfo = overlapActive
            ? `OVERLAP line ${this.prevLine.lineIdx} (${((this.prevLine.overlapEnd - performance.now()) / 1000).toFixed(1)}s left, ${this.prevLine.matchedSet.size}/${this.prevLine.lineWords.length} matched)`
            : 'none';
```

Include `tc`, `wps`, and `overlapInfo` in the HUD HTML string alongside the existing fields. The exact insertion point depends on the current HUD layout â€” add them as new rows in the HUD table.

**Step 2: Verify via manual testing**

Load a song, press D to toggle debug HUD, start Game Mode. Verify:
- `tempo` shows `slow`, `normal`, or `fast` per line
- `wps` shows the words-per-second value
- `overlap` shows active overlap info during line transitions

**Step 3: Commit**

```bash
git add static/player.js
git commit -m "feat: show tempo class and overlap state in debug HUD"
```

---

### Task 6: Implement dynamic Whisper chunk sizing in AudioWorklet

**Files:**
- Modify: `static/audio-processor.js` â€” add `setChunkSize` message handler
- Modify: `static/player.js` â€” `setActiveLine` posts chunk size to AudioWorklet

**Step 1: Add message handler to AudioWorklet**

Replace the entire `static/audio-processor.js` with:

```js
/**
 * AudioWorklet processor that accumulates Float32 mic samples and emits
 * chunks to the main thread. Chunk size is dynamically adjustable via
 * port messages. Also posts RMS energy level every ~100ms (1600 samples)
 * for voice activity detection.
 */
class ChunkProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._buf = [];
        this._target = 32000; // default: 2 seconds at 16000 Hz
        this._energyBuf = [];
        this._energyTarget = 1600; // ~100ms at 16kHz

        // Listen for dynamic chunk size changes
        this.port.onmessage = (e) => {
            if (e.data && e.data.type === 'setChunkSize' && typeof e.data.samples === 'number') {
                this._target = Math.max(1600, Math.min(64000, e.data.samples)); // clamp to 0.1sâ€“4s
            }
        };
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

        // Post audio chunk when buffer reaches target
        if (this._buf.length >= this._target) {
            const chunk = new Float32Array(this._buf.splice(0, this._target));
            this.port.postMessage({ type: 'chunk', data: chunk });
        }

        return true; // keep processor alive
    }
}

registerProcessor('chunk-processor', ChunkProcessor);
```

**Step 2: Post chunk size from setActiveLine**

In `setActiveLine()` (Task 4's version), after setting `this.currentParams`, add:

```js
        // Dynamic Whisper chunk size: smaller chunks for fast sections
        if (this._whisperNode && this._whisperNode.port) {
            const tempoClass = (this.wordTimings && this.wordTimings.tempoClass) || 'normal';
            this._whisperNode.port.postMessage({
                type: 'setChunkSize',
                samples: getChunkSamples(tempoClass)
            });
        }
```

**Step 3: Add getChunkSamples test**

Append to `tests/test_sync_helpers.js`, above the final console.log:

```js
// --- getChunkSamples ---
const { getChunkSamples } = require('../static/sync-helpers.js');
assert.strictEqual(getChunkSamples('slow'), 32000);
assert.strictEqual(getChunkSamples('normal'), 24000);
assert.strictEqual(getChunkSamples('fast'), 12000);
assert.strictEqual(getChunkSamples('unknown'), 24000);
```

**Step 4: Run test to verify it passes**

Run: `node tests/test_sync_helpers.js`
Expected: "All sync-helpers tests passed."

**Step 5: Commit**

```bash
git add static/audio-processor.js static/player.js tests/test_sync_helpers.js
git commit -m "feat: dynamic Whisper chunk sizing based on line tempo"
```

---

### Task 7: Manual integration testing and tuning

**Files:**
- No code changes (or minor constant tweaks if needed)

**Step 1: Test with a slow ballad**

Load a slow song (e.g. ballad, <2 WPS). Start Game Mode with debug HUD (press D).
Verify:
- `tempo: slow` in HUD
- Lines score normally with overlap = 1.0s
- No regression from current behavior

**Step 2: Test with a normal-tempo pop/rock song**

Load a mid-tempo song (2-5 WPS). Verify:
- `tempo: normal` in HUD
- Line transitions are smooth
- Last word of each line isn't cut off

**Step 3: Test with a fast rap song**

Load a fast song (>5 WPS). Verify:
- `tempo: fast` in HUD
- Words still match despite fast delivery
- Overlap zone (0.5s) catches boundary words
- Whisper chunks arrive faster (~1s vs ~2.5s)

**Step 4: Test rapid line transitions**

Seek to a section with many short lines back-to-back. Verify:
- `overlap` in HUD shows transitions without piling up
- `_finalizePrevLine()` fires before the next overlap starts (fast succession guard)
- No JS errors in console

**Step 5: If constants need adjustment, tune and commit**

If any WPS thresholds (2.0/5.0), window sizes, or overlap durations need adjustment based on testing, update `static/sync-helpers.js` and tests.

```bash
git add -A
git commit -m "fix: tune adaptive sync constants based on integration testing"
```

---

### Task 8: Run full test suite and final commit

**Step 1: Run Node.js sync-helpers tests**

Run: `node tests/test_sync_helpers.js`
Expected: "All sync-helpers tests passed."

**Step 2: Run Python test suite**

Run: `cd C:/GPT5-Projects/Karaokee && python -m pytest tests/ -v`
Expected: All existing tests pass (no backend changes were made)

**Step 3: Final commit if any cleanup needed**

```bash
git add -A
git commit -m "chore: cleanup after adaptive sync implementation"
```
