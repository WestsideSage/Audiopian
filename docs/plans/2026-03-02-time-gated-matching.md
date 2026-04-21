# Consolidated Plan Record

This file merges the original design and implementation documents for this feature.

## Design

# Time-Gated Matching & Transcript Fencing

**Date:** 2026-03-02
**Problem:** Words turn green before the user has said them, primarily at the start of new lines.

## Root Cause

Two paths cause premature green highlighting:

1. **Stale transcript bleed:** `_collectMatches` starts scanning from `lineStartWordCount - 4`, so the last 4 words of the previous line's transcript can match against the new line's target words â€” especially common words like "I", "you", "the".

2. **No temporal awareness in general matching:** Unlike the hot-word system which has time windows, `_collectMatches` has zero time gating. It matches purely by sequential order against the accumulated transcript.

## Design

### 1. Time-Gated `_collectMatches`

Add a temporal gate to `_collectMatches`: only accept a match if `audio.currentTime >= wordTimings[wordIndex].windowStart`.

- Word timing data is already computed by `interpolateWordTimings()` and stored per-line.
- Pass the current line's word timings into `_collectMatches` and check the gate before accepting each match.
- If the playback hasn't reached the word's predicted window yet, skip it. The next poll cycle (100ms) or speech event will pick it up once the time arrives.
- The existing 300ms early buffer (`windowStart = estimatedTime - 0.3`) still allows slightly eager speakers to get instant feedback.

### 2. Transcript Fencing Per Line

Eliminate cross-line transcript bleed by fencing the spoken buffer per line.

- When `setActiveLine` fires, record the exact transcript length as `lineStartTranscriptPos`.
- In `_collectMatches`, start scanning from `lineStartTranscriptPos` (not `lineStartWordCount - 4`).
- In `_matchHotWord`, only search words from `lineStartTranscriptPos` onward (not the last 10 of the full transcript).
- Late-arriving finals for the previous line are handled by the existing `_lateScoreLine` mechanism (800ms delayed re-score).

### 3. Edge Cases

- **Variable BPM / slower bars:** Timing estimates are syllable-weighted within each LRC line's time span. Slow sections naturally stretch the windows. The 300ms early + 1500ms late buffer absorbs most tempo variation.
- **Repeated words within a line:** Sequential matching with `spokenIdx` advancement handles this correctly. Time gating doesn't interfere since repeated words get sequential time windows.
- **Very short lines:** 1-2 word lines get the full line duration, giving wide time windows. No special handling needed.
- **Sticky matching stays:** Once a word passes both gates (time + fence) and gets matched, it stays green permanently. We're only preventing premature entry.
- **Debug HUD:** Add `windowStart`/`windowEnd` to debug output for timing verification during testing.

## Summary of Changes

| File | Change |
|------|--------|
| `static/player.js` â€” `_collectMatches()` | Add time gate: check `audio.currentTime >= wt.windowStart` before accepting match |
| `static/player.js` â€” `setActiveLine()` | Record `lineStartTranscriptPos` from current transcript length |
| `static/player.js` â€” `_collectMatches()` | Use `lineStartTranscriptPos` as scan start instead of `lineStartWordCount - 4` |
| `static/player.js` â€” `_matchHotWord()` | Fence search to words from `lineStartTranscriptPos` onward |
| `static/player.js` â€” debug output | Add word timing window info to debug HUD |

---

## Implementation

# Time-Gated Matching & Transcript Fencing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent words from turning green before the user has said them by adding time gating and transcript fencing to the matching logic.

**Architecture:** All changes are in `static/player.js`. Add a `lineStartTranscriptPos` field to fence transcript scanning per line. Pass `wordTimings` and `audio.currentTime` into `_collectMatches` and `_collectMatchesWhisper` so they can gate each word match against its predicted time window.

**Tech Stack:** Plain JavaScript (no build step, no JS test framework)

**Design doc:** `docs/plans/2026-03-02-time-gated-matching-design.md`

---

### Task 1: Add `lineStartTranscriptPos` field and set it in `setActiveLine`

**Files:**
- Modify: `static/player.js:351` (constructor â€” add field)
- Modify: `static/player.js:647` (setActiveLine â€” set field)

**Step 1: Add field to constructor**

In the constructor (after `lineStartWordCount` on line 350), add:

```javascript
this.lineStartTranscriptPos = 0;  // transcript word index when current line started (fence)
```

**Step 2: Set the fence in `setActiveLine`**

In `setActiveLine`, line 647 currently has:

```javascript
this.lineStartWordCount = normalizeWords(this.transcript).length;
```

Keep that line, but add immediately after it:

```javascript
this.lineStartTranscriptPos = this.lineStartWordCount;
```

Also set it in `start()` (around line 389 where `lineStartWordCount` is reset):

```javascript
this.lineStartTranscriptPos = 0;
```

**Step 3: Commit**

```
git add static/player.js
git commit -m "feat: add lineStartTranscriptPos fence field"
```

---

### Task 2: Apply transcript fence to `_collectMatches`

**Files:**
- Modify: `static/player.js:681-699` (`_collectMatches`)

**Step 1: Replace the scan start calculation**

Change `_collectMatches` from:

```javascript
_collectMatches(transcript, resultSet) {
    if (this.lineWords.length === 0) return;
    var spoken = normalizeWords(transcript);
    // Start near the word position where the current line began.
    // The -4 buffer absorbs recognition latency: finals that committed
    // just before setActiveLine fired may still contain the line's words.
    var startOffset = Math.max(0, this.lineStartWordCount - 4);
    var spokenIdx = startOffset;
```

To:

```javascript
_collectMatches(transcript, resultSet) {
    if (this.lineWords.length === 0) return;
    var spoken = normalizeWords(transcript);
    // Fence: only scan words spoken since the current line started.
    // Late-arriving finals for the previous line are handled by _lateScoreLine.
    var spokenIdx = this.lineStartTranscriptPos;
```

**Step 2: Commit**

```
git add static/player.js
git commit -m "feat: fence _collectMatches to current line's transcript"
```

---

### Task 3: Add time gate to `_collectMatches`

**Files:**
- Modify: `static/player.js:681-699` (`_collectMatches`)

**Step 1: Add time gate check inside the match loop**

After applying the fence from Task 2, the function should become:

```javascript
_collectMatches(transcript, resultSet) {
    if (this.lineWords.length === 0) return;
    var spoken = normalizeWords(transcript);
    // Fence: only scan words spoken since the current line started.
    var spokenIdx = this.lineStartTranscriptPos;
    var now = audio.currentTime;
    for (var li = 0; li < this.lineWords.length; li++) {
        // Time gate: don't match words whose predicted window hasn't started yet
        if (li < this.wordTimings.length) {
            if (now < this.wordTimings[li].windowStart) continue;
        }
        var target = this.lineWords[li];
        var driftWindow = 18;
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

Key detail: the `continue` on the time gate skips the word but does NOT advance `spokenIdx`, so when the next poll cycle runs (100ms later) and `now` has advanced, the word can still be matched sequentially.

**Step 2: Commit**

```
git add static/player.js
git commit -m "feat: add time gate to _collectMatches"
```

---

### Task 4: Add time gate to `_collectMatchesWhisper`

**Files:**
- Modify: `static/player.js:587-604` (`_collectMatchesWhisper`)

**Step 1: Add time gate check**

The Whisper buffer is already reset per-line (no fence needed), but it needs the same time gate. Change the function to:

```javascript
_collectMatchesWhisper(transcript) {
    if (this.lineWords.length === 0) return;
    const spoken = normalizeWords(transcript);
    const whisperSet = new Set();
    let spokenIdx = 0;
    var now = audio.currentTime;
    for (let li = 0; li < this.lineWords.length; li++) {
        // Time gate: don't match words whose predicted window hasn't started yet
        if (li < this.wordTimings.length) {
            if (now < this.wordTimings[li].windowStart) continue;
        }
        const target = this.lineWords[li];
        const driftWindow = 15; // slightly wider than Track 1 â€” Whisper gives complete phrases
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

**Step 2: Commit**

```
git add static/player.js
git commit -m "feat: add time gate to _collectMatchesWhisper"
```

---

### Task 5: Apply transcript fence to `_matchHotWord`

**Files:**
- Modify: `static/player.js:755-781` (`_matchHotWord`)

**Step 1: Replace the search window**

Change lines 762-764 from:

```javascript
var spoken = normalizeWords(transcript);

// Search the tail of the spoken buffer for the hot word
// (only look at recent words â€” last 10)
var searchStart = Math.max(0, spoken.length - 10);
```

To:

```javascript
var spoken = normalizeWords(transcript);

// Fence: only search words spoken since the current line started
// (within that, only look at recent 10)
var searchStart = Math.max(this.lineStartTranscriptPos, spoken.length - 10);
```

This ensures `_matchHotWord` never searches transcript words from before the current line.

**Step 2: Commit**

```
git add static/player.js
git commit -m "feat: fence _matchHotWord to current line's transcript"
```

---

### Task 6: Add timing window info to debug HUD

**Files:**
- Modify: `static/player.js:479-493` (debug MATCH log in `onresult`)

**Step 1: Add hot word timing to debug output**

In the debug MATCH log block (around line 488), add the hot word timing info:

Find the existing debug MATCH block:

```javascript
self._debugLog('MATCH', {
    lineIdx:     self.activeLineIdx,
    targets:     self.lineWords.slice(),
    spokenWindow: spokenFull.slice(scanFrom, scanFrom + 20),
    matchedIdxs: [...unionSet],
});
```

Replace with:

```javascript
self._debugLog('MATCH', {
    lineIdx:     self.activeLineIdx,
    targets:     self.lineWords.slice(),
    spokenWindow: spokenFull.slice(scanFrom, scanFrom + 20),
    matchedIdxs: [...unionSet],
    hotIdx:      self.hotWordIndex,
    hotWindow:   self.hotWordIndex >= 0 && self.wordTimings[self.hotWordIndex]
                    ? [self.wordTimings[self.hotWordIndex].windowStart.toFixed(2),
                       self.wordTimings[self.hotWordIndex].windowEnd.toFixed(2)]
                    : null,
    audioTime:   audio.currentTime.toFixed(2),
    fencePos:    self.lineStartTranscriptPos,
});
```

**Step 2: Commit**

```
git add static/player.js
git commit -m "feat: add timing and fence info to debug HUD"
```

---

### Task 7: Manual verification

**Step 1: Start the app**

```
cd /c/GPT5-Projects/Karaokee && python app.py
```

**Step 2: Test with a song**

1. Open the app in Chrome
2. Load a song (e.g., "Dear X, You Don't Own Me")
3. Enable game mode
4. Enable debug HUD (press D or whatever the debug toggle is)
5. Sing along and verify:
   - Words do NOT go green at the start of a new line before singing
   - Words still go green when you sing them correctly
   - The debug HUD shows `fencePos`, `audioTime`, and `hotWindow` values
   - Overall accuracy is not noticeably worse than before

**Step 3: Final commit if any tweaks needed**

```
git add static/player.js
git commit -m "fix: tune time-gated matching parameters"
```
