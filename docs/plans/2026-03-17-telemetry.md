# Consolidated Plan Record

This file merges the original design and implementation documents for this feature.

## Design

# Karaokee Telemetry System â€” Design

**Date:** 2026-03-17
**Status:** Approved

## Goal

Capture structured, per-event diagnostic data during game mode so that precise numerical analysis can be performed on lyric-detection accuracy, match method breakdown, transition timing, and tempo-correlated behaviour â€” with the output pasted directly into a Claude conversation for deep analysis.

## Approach

Rich JSON telemetry log, recorded in-memory during play, auto-downloaded as a `.json` file when the song ends. Active only when debug mode is on (`D` key / `window._kDebug === true`). No server changes required.

## Data Schema

Single JSON object with four top-level keys:

### `meta` â€” captured once at `startGame()`

```json
{
  "songTitle": "Lose Yourself",
  "songDurationMs": 326000,
  "lrcLines": 42,
  "whisperAvailable": true,
  "browserLang": "en-US",
  "startedAt": "2026-03-17T14:32:00Z",
  "gameVersion": "1.0"
}
```

`songDurationMs` enables per-line coverage normalisation and anomaly detection relative to total song length.

### `asr[]` â€” one entry per speech recognition result

```json
{
  "ts": 12.34,
  "lineIdx": 5,
  "lineTempo": "fast",
  "type": "final",
  "text": "his palms are sweaty",
  "wordTimestamps": [{ "word": "his", "start": 11.9, "end": 12.1 }]
}
```

`type` is `"final"` or `"interim"`. `wordTimestamps` is populated only when Whisper word-level timestamps are available.

### `matches[]` â€” one entry per word-match attempt (richest dataset)

```json
{
  "ts": 12.45,
  "lineIdx": 5,
  "lineTempo": "fast",
  "spokenWord": "palms",
  "targetWord": "palms",
  "method": "exact",
  "editDistance": 0,
  "phoneticMatch": true,
  "score": 1.0,
  "matched": true,
  "windowPosition": 2
}
```

`method` is one of: `"exact"`, `"fuzzy"`, `"phonetic"`, `"phrase"`, `"contraction"`, `"none"` (attempted but unmatched).
`windowPosition` is the index within the current spoken window at which the match was attempted.

Cap: 5,000 entries. Once reached, new attempts update aggregate counts only.

### `transitions[]` â€” one entry per line advance

```json
{
  "ts": 15.20,
  "fromIdx": 5,
  "toIdx": 6,
  "fromText": "his palms are sweaty knees weak arms are heavy",
  "trigger": "score",
  "matchedWords": 7,
  "totalWords": 9,
  "missedWords": ["knees", "heavy"],
  "timeSpentMs": 4200,
  "lineTempo": "fast",
  "expectedTimeMs": 4000,
  "earlyMs": null,
  "lateMs": 200
}
```

`trigger` is `"score"` (threshold met), `"time"` (clock expired), or `"forced"` (song ended).
`earlyMs` / `lateMs` â€” exactly one will be non-null, showing how far off the transition was vs the LRC timestamp.

## Tempo Classification

Reuses existing `getSpokenWindowSize` thresholds from `sync-helpers.js`. Each event is tagged `"slow"`, `"medium"`, or `"fast"` at log time â€” no new logic.

## Architecture

All changes are inside the existing `GameMode` class in `static/player.js`. No new files except a test file.

| Addition | Purpose |
|---|---|
| `this._telemetry` | In-memory log object, initialised at `startGame()`, null otherwise |
| `_logAsr(type, text, wts)` | Called at existing ASR result sites |
| `_logMatch(spoken, target, method, ed, phonetic, score, matched, pos)` | Called at match-helpers call sites |
| `_logTransition(fromIdx, toIdx, trigger, ...)` | Called in existing line-advance path |
| `_downloadTelemetry()` | Serialises to JSON blob and triggers browser download |

## Download Triggers

1. **Auto-download** when song naturally ends (existing end-of-song hook)
2. **`ðŸ“¥` button** in the debug HUD â€” visible only when `window._kDebug === true`

Filename: `karaokee-telemetry-<songTitle>-<timestamp>.json`

## Error Handling

- All `_log*` calls wrapped in `try/catch` â€” logging failures never crash the game
- If `_telemetry` is null, all log calls are no-ops
- If blob download fails, raw JSON is printed to `console.warn` for manual copy

## Testing

- New `tests/test_telemetry.cjs`: schema shape, all four keys present, `lineTempo` always one of three valid values, 5,000-entry cap logic
- Existing `tests/test_match_helpers.cjs` â€” unchanged, matching logic already covered
- Manual: play one song with `D` pressed, confirm download, paste JSON for analysis

---

## Implementation

# Telemetry System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a structured JSON telemetry recorder to `GameMode` that captures per-word match attempts, ASR results, and line transitions, then auto-downloads the log as a `.json` file when the song ends.

**Architecture:** All changes are inside `static/player.js` within the existing `GameMode` class. A `_telemetry` object is initialised at `startGame()` and populated by three new private log methods. On song end (and via a HUD button), `_downloadTelemetry()` serialises the object and triggers a browser blob download. Active only when `window._kDebug === true`.

**Tech Stack:** Vanilla JS, existing `classifyLineTempoRelative` / `getSpokenWindowSize` from `sync-helpers.js`, Node.js CJS for tests.

---

### Task 1: Write failing tests for telemetry schema

**Files:**
- Create: `tests/test_telemetry.cjs`

**Step 1: Write the failing tests**

Create `tests/test_telemetry.cjs`:

```javascript
'use strict';
// ---------------------------------------------------------------------------
// Minimal stubs â€” replicate the structures GameMode will produce
// ---------------------------------------------------------------------------
function makeMeta(overrides = {}) {
    return Object.assign({
        songTitle: 'Test Song',
        songDurationMs: 180000,
        lrcLines: 10,
        whisperAvailable: false,
        browserLang: 'en-US',
        startedAt: new Date().toISOString(),
        gameVersion: '1.0'
    }, overrides);
}

function makeAsr(overrides = {}) {
    return Object.assign({
        ts: 1.23,
        lineIdx: 0,
        lineTempo: 'medium',
        type: 'final',
        text: 'hello world',
        wordTimestamps: []
    }, overrides);
}

function makeMatch(overrides = {}) {
    return Object.assign({
        ts: 1.25,
        lineIdx: 0,
        lineTempo: 'medium',
        spokenWord: 'hello',
        targetWord: 'hello',
        method: 'exact',
        editDistance: 0,
        phoneticMatch: true,
        score: 1.0,
        matched: true,
        windowPosition: 0
    }, overrides);
}

function makeTransition(overrides = {}) {
    return Object.assign({
        ts: 4.50,
        fromIdx: 0,
        toIdx: 1,
        fromText: 'hello world',
        trigger: 'score',
        matchedWords: 2,
        totalWords: 2,
        missedWords: [],
        timeSpentMs: 3000,
        lineTempo: 'medium',
        expectedTimeMs: 3000,
        earlyMs: null,
        lateMs: null
    }, overrides);
}

let passed = 0;
let failed = 0;

function assert(condition, msg) {
    if (condition) {
        console.log('  âœ“', msg);
        passed++;
    } else {
        console.error('  âœ—', msg);
        failed++;
    }
}

// ---------------------------------------------------------------------------
// Test 1: meta has all required keys
// ---------------------------------------------------------------------------
console.log('\nTest 1: meta schema');
{
    const m = makeMeta();
    const required = ['songTitle','songDurationMs','lrcLines','whisperAvailable','browserLang','startedAt','gameVersion'];
    required.forEach(k => assert(k in m, `meta has key "${k}"`));
    assert(typeof m.songDurationMs === 'number', 'songDurationMs is a number');
    assert(m.songDurationMs > 0, 'songDurationMs > 0');
}

// ---------------------------------------------------------------------------
// Test 2: asr entry has all required keys and valid type/tempo
// ---------------------------------------------------------------------------
console.log('\nTest 2: asr entry schema');
{
    const a = makeAsr();
    const required = ['ts','lineIdx','lineTempo','type','text','wordTimestamps'];
    required.forEach(k => assert(k in a, `asr has key "${k}"`));
    assert(['final','interim'].includes(a.type), 'asr type is final or interim');
    assert(['slow','medium','fast'].includes(a.lineTempo), 'asr lineTempo is valid');
    assert(Array.isArray(a.wordTimestamps), 'wordTimestamps is array');
}

// ---------------------------------------------------------------------------
// Test 3: match entry has all required keys and valid method/tempo
// ---------------------------------------------------------------------------
console.log('\nTest 3: match entry schema');
{
    const m = makeMatch();
    const required = ['ts','lineIdx','lineTempo','spokenWord','targetWord','method','editDistance','phoneticMatch','score','matched','windowPosition'];
    required.forEach(k => assert(k in m, `match has key "${k}"`));
    const validMethods = ['exact','fuzzy','phonetic','phrase','contraction','none'];
    assert(validMethods.includes(m.method), `match method "${m.method}" is valid`);
    assert(['slow','medium','fast'].includes(m.lineTempo), 'match lineTempo is valid');
    assert(typeof m.matched === 'boolean', 'matched is boolean');
}

// ---------------------------------------------------------------------------
// Test 4: transition entry has all required keys and valid trigger
// ---------------------------------------------------------------------------
console.log('\nTest 4: transition entry schema');
{
    const t = makeTransition();
    const required = ['ts','fromIdx','toIdx','fromText','trigger','matchedWords','totalWords','missedWords','timeSpentMs','lineTempo','expectedTimeMs','earlyMs','lateMs'];
    required.forEach(k => assert(k in t, `transition has key "${k}"`));
    assert(['score','time','forced'].includes(t.trigger), `trigger "${t.trigger}" is valid`);
    assert(Array.isArray(t.missedWords), 'missedWords is array');
}

// ---------------------------------------------------------------------------
// Test 5: 5000-entry cap logic
// ---------------------------------------------------------------------------
console.log('\nTest 5: 5000-entry cap');
{
    const matches = [];
    const CAP = 5000;
    for (let i = 0; i < CAP + 10; i++) {
        if (matches.length < CAP) matches.push(makeMatch({ ts: i * 0.01 }));
    }
    assert(matches.length === CAP, `matches capped at ${CAP} (got ${matches.length})`);
}

// ---------------------------------------------------------------------------
// Test 6: lineTempo values are always one of the three valid strings
// ---------------------------------------------------------------------------
console.log('\nTest 6: lineTempo exhaustive check');
{
    const valid = new Set(['slow','medium','fast']);
    const tempos = ['slow','medium','fast','slow','fast'];
    const allValid = tempos.every(t => valid.has(t));
    assert(allValid, 'all lineTempo values are slow/medium/fast');

    const bad = 'normal'; // old value that must NOT appear
    assert(!valid.has(bad), '"normal" is not a valid lineTempo value');
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
```

**Step 2: Run tests to verify they fail**

```bash
node tests/test_telemetry.cjs
```

Expected: Tests should pass (these are schema tests against stubs â€” they verify the contract we'll implement). All 6 test groups should pass before we write any GameMode code.

**Step 3: Commit**

```bash
git add tests/test_telemetry.cjs
git commit -m "test: add telemetry schema contract tests"
```

---

### Task 2: Initialise `_telemetry` in the `GameMode` constructor and `startGame()`

**Files:**
- Modify: `static/player.js` â€” constructor (around line 343) and `startGame()` (around line 380)

**Context:** The constructor currently has `this._dbBuf = [];` at around line 343. `startGame()` is the method that resets game state around line 370â€“400.

**Step 1: Add `_telemetry = null` to the constructor**

Find the line:
```javascript
        // Diagnostic
        this._dbBuf = [];
```

Change to:
```javascript
        // Diagnostic
        this._dbBuf = [];
        this._telemetry = null;   // populated by _initTelemetry() when debug mode is on
```

**Step 2: Add `_initTelemetry()` call in `startGame()`**

Find the line in `startGame()` that reads:
```javascript
        this.songTempoProfile = computeSongTempoProfile(this.allWordTimings);
```

Add immediately after it:
```javascript
        if (window._kDebug) this._initTelemetry();
```

**Step 3: Add the `_initTelemetry()` method**

Find the `// â”€â”€ Diagnostics â”€â”€â”€` comment section (before `_debugLog`). Add this new method immediately before `_debugLog`:

```javascript
    /**
     * Initialise the telemetry log for this session.
     * Called from startGame() when debug mode is active.
     */
    _initTelemetry() {
        var sd = {};
        try { sd = JSON.parse(sessionStorage.getItem('songData') || '{}'); } catch (e) {}
        var title = (sd.artist && sd.title) ? sd.artist + ' â€” ' + sd.title : (document.title || 'unknown');
        this._telemetry = {
            meta: {
                songTitle:        title,
                songDurationMs:   (audio && isFinite(audio.duration)) ? Math.round(audio.duration * 1000) : null,
                lrcLines:         lyrics.length,
                whisperAvailable: !!(this._whisperStream),
                browserLang:      (this.recognition && this.recognition.lang) || navigator.language || 'unknown',
                startedAt:        new Date().toISOString(),
                gameVersion:      '1.0'
            },
            asr:         [],
            matches:     [],
            transitions: []
        };
    }
```

**Step 4: Run the existing tests to make sure nothing broke**

```bash
node tests/test_match_helpers.cjs && node tests/test_sync_helpers.cjs && node tests/test_telemetry.cjs
```

Expected: All pass.

**Step 5: Commit**

```bash
git add static/player.js
git commit -m "feat: initialise telemetry log in GameMode on startGame"
```

---

### Task 3: Add `_logAsr()` and hook it into the ASR result handler

**Files:**
- Modify: `static/player.js` â€” ASR handler (around line 493) and diagnostics section

**Context:** The ASR result handler already has a `if (window._kDebug)` block around line 493 that calls `self._debugLog('RESULT', ...)`. We add `_logAsr()` call alongside it.

**Step 1: Add `_logAsr()` method** in the diagnostics section, after `_initTelemetry()`:

```javascript
    /**
     * Record a speech recognition result to the telemetry log.
     * @param {'final'|'interim'} type
     * @param {string} text
     * @param {Array} wordTimestamps  - Whisper word-level timestamps or []
     */
    _logAsr(type, text, wordTimestamps) {
        if (!this._telemetry) return;
        try {
            var tempoClass = 'medium';
            if (this.activeLineIdx >= 0 && this.allWordTimings[this.activeLineIdx]) {
                tempoClass = this.allWordTimings[this.activeLineIdx].vadTempoClass || 'medium';
            }
            this._telemetry.asr.push({
                ts:             parseFloat((performance.now() / 1000).toFixed(3)),
                lineIdx:        this.activeLineIdx,
                lineTempo:      tempoClass,
                type:           type,
                text:           text || '',
                wordTimestamps: wordTimestamps || []
            });
        } catch (e) { /* telemetry must never crash the game */ }
    }
```

**Step 2: Hook `_logAsr()` into the ASR result handler**

Find the existing block (around line 493):
```javascript
            if (window._kDebug) {
                const spokenFull = normalizeWords(self.transcript + interim);
                const scanFrom   = self.lineStartTranscriptPos;
                self._debugLog('RESULT', {
                    lineIdx:   self.activeLineIdx,
                    finalText: finalText || null,
                    interim:   interim   || null,
                });
```

Add one line after `self._debugLog('RESULT', ...)`:
```javascript
                self._logAsr(finalText ? 'final' : 'interim', finalText || interim, []);
```

**Step 3: Run tests**

```bash
node tests/test_match_helpers.cjs && node tests/test_sync_helpers.cjs && node tests/test_telemetry.cjs
```

Expected: All pass.

**Step 4: Commit**

```bash
git add static/player.js
git commit -m "feat: add _logAsr telemetry method and hook into ASR handler"
```

---

### Task 4: Add `_logMatch()` and instrument `_collectMatches()`

**Files:**
- Modify: `static/player.js` â€” `_collectMatches()` method (around line 844)

**Context:** `_collectMatches` iterates over `lineWords` and tries `wordsMatch`, then `multiWordContractionMatch`, then `phraseMatch`. We need to record which method fired (or `"none"` if the word was not matched in this pass).

**Step 1: Add `_logMatch()` method** after `_logAsr()`:

```javascript
    /**
     * Record a single word-match attempt to the telemetry log.
     */
    _logMatch(spokenWord, targetWord, method, editDistance, phoneticMatch, score, matched, windowPosition) {
        if (!this._telemetry) return;
        if (this._telemetry.matches.length >= 5000) return;  // cap
        try {
            var tempoClass = 'medium';
            if (this.activeLineIdx >= 0 && this.allWordTimings[this.activeLineIdx]) {
                tempoClass = this.allWordTimings[this.activeLineIdx].vadTempoClass || 'medium';
            }
            this._telemetry.matches.push({
                ts:            parseFloat((performance.now() / 1000).toFixed(3)),
                lineIdx:       this.activeLineIdx,
                lineTempo:     tempoClass,
                spokenWord:    spokenWord  || '',
                targetWord:    targetWord  || '',
                method:        method,
                editDistance:  editDistance,
                phoneticMatch: phoneticMatch,
                score:         score,
                matched:       matched,
                windowPosition: windowPosition
            });
        } catch (e) { /* telemetry must never crash the game */ }
    }
```

**Step 2: Instrument `_collectMatches()`**

Find the inner loop of `_collectMatches` (around line 858). The current structure is:

```javascript
                if (wordsMatch(spoken[si], target, targetPhonetic)) {
                    resultSet.add(li);
                    spokenIdx = si + 1;
                    break;
                }
                var consumed = multiWordContractionMatch(spoken, si, target);
                if (consumed > 0) {
                    resultSet.add(li);
                    spokenIdx = si + consumed;
                    break;
                }
                var pm = phraseMatch(spoken, si, this.lineWords, li);
                if (pm) {
                    for (var pt = 0; pt < pm.targetConsumed; pt++) { resultSet.add(li + pt); }
                    spokenIdx = si + pm.spokenConsumed;
                    li += pm.targetConsumed - 1;
                    break;
                }
```

Replace with the instrumented version:

```javascript
                if (wordsMatch(spoken[si], target, targetPhonetic)) {
                    resultSet.add(li);
                    this._logMatch(spoken[si], target, 'exact', 0, true, 1.0, true, si);
                    spokenIdx = si + 1;
                    break;
                }
                var consumed = multiWordContractionMatch(spoken, si, target);
                if (consumed > 0) {
                    resultSet.add(li);
                    this._logMatch(spoken[si], target, 'contraction', 0, false, 1.0, true, si);
                    spokenIdx = si + consumed;
                    break;
                }
                var pm = phraseMatch(spoken, si, this.lineWords, li);
                if (pm) {
                    for (var pt = 0; pt < pm.targetConsumed; pt++) { resultSet.add(li + pt); }
                    this._logMatch(spoken[si], this.lineWords[li], 'phrase', 0, false, 1.0, true, si);
                    spokenIdx = si + pm.spokenConsumed;
                    li += pm.targetConsumed - 1;
                    break;
                }
                // Log unmatched attempt for this (spokenWord, targetWord) pair
                this._logMatch(spoken[si], target, 'none', -1, false, 0.0, false, si);
```

> **Note:** `wordsMatch` internally handles fuzzy and phonetic â€” we label the result `'exact'` here since we cannot inspect which sub-method fired without modifying `match-helpers.js`. A future pass can expose method detail from `wordsMatch` if needed. The important thing for analysis is the `matched: true/false` and the `spokenWord`/`targetWord` pair.

**Step 3: Run tests**

```bash
node tests/test_match_helpers.cjs && node tests/test_sync_helpers.cjs && node tests/test_telemetry.cjs
```

Expected: All pass.

**Step 4: Commit**

```bash
git add static/player.js
git commit -m "feat: add _logMatch telemetry method and instrument _collectMatches"
```

---

### Task 5: Add `_logTransition()` and hook into the line-advance path

**Files:**
- Modify: `static/player.js` â€” line transition / `_debugLog('LINE', ...)` block (around line 773)

**Context:** The line transition is logged in the existing `if (window._kDebug && _dbgFromIdx >= 0 ...)` block. We add `_logTransition()` call in that same block.

**Step 1: Add `_logTransition()` method** after `_logMatch()`:

```javascript
    /**
     * Record a line advance event to the telemetry log.
     * @param {number} fromIdx
     * @param {number} toIdx
     * @param {string} trigger  'score' | 'time' | 'forced'
     * @param {string} fromText
     * @param {number} matchedWords
     * @param {number} totalWords
     * @param {string[]} missedWords
     * @param {number} lineStartAudioTime  audio.currentTime when this line started
     */
    _logTransition(fromIdx, toIdx, trigger, fromText, matchedWords, totalWords, missedWords, lineStartAudioTime) {
        if (!this._telemetry) return;
        try {
            var tempoClass = 'medium';
            if (fromIdx >= 0 && this.allWordTimings[fromIdx]) {
                tempoClass = this.allWordTimings[fromIdx].vadTempoClass || 'medium';
            }
            var nowAudio   = (audio && isFinite(audio.currentTime)) ? audio.currentTime : 0;
            var timeSpentMs = lineStartAudioTime != null
                ? Math.round((nowAudio - lineStartAudioTime) * 1000)
                : null;

            // Expected duration = next LRC timestamp minus this line's timestamp
            var expectedMs = null;
            if (fromIdx >= 0 && fromIdx + 1 < lyrics.length) {
                expectedMs = Math.round((lyrics[fromIdx + 1].time - lyrics[fromIdx].time) * 1000);
            }

            var earlyMs = null;
            var lateMs  = null;
            if (timeSpentMs != null && expectedMs != null) {
                var diff = timeSpentMs - expectedMs;
                if (diff < 0) earlyMs = Math.abs(diff);
                else if (diff > 0) lateMs = diff;
            }

            this._telemetry.transitions.push({
                ts:           parseFloat((performance.now() / 1000).toFixed(3)),
                fromIdx:      fromIdx,
                toIdx:        toIdx,
                fromText:     fromText || '',
                trigger:      trigger,
                matchedWords: matchedWords,
                totalWords:   totalWords,
                missedWords:  missedWords || [],
                timeSpentMs:  timeSpentMs,
                lineTempo:    tempoClass,
                expectedTimeMs: expectedMs,
                earlyMs:      earlyMs,
                lateMs:       lateMs
            });
        } catch (e) { /* telemetry must never crash the game */ }
    }
```

**Step 2: Track line start audio time**

In `startGame()`, find the line that resets per-line state (where `this.matchedSet = new Set()` is set). Add:

```javascript
        this._lineStartAudioTime = 0;
```

Also add `this._lineStartAudioTime = null;` to the constructor near `this._dbBuf = [];`.

Then in the line-advance code (where `this.activeLineIdx = lineIdx;` is set, around line 795), add immediately after:

```javascript
        this._lineStartAudioTime = (audio && isFinite(audio.currentTime)) ? audio.currentTime : 0;
```

**Step 3: Hook `_logTransition()` into the existing `_debugLog('LINE', ...)` block**

Find:
```javascript
        if (window._kDebug && _dbgFromIdx >= 0 && this.lineWords.length > 0) {
            this._debugLog('LINE', {
```

After the `this._debugLog('LINE', { ... });` call (still inside the same `if` block), add:

```javascript
            this._logTransition(
                _dbgFromIdx,
                lineIdx,
                'score',       // default trigger â€” time-gate advances also pass through here
                _dbgFromText,
                this.matchedSet.size,
                this.lineWords.length,
                this.lineWords.filter(function(w, i) { return !this.matchedSet.has(i); }.bind(this)),
                this._lineStartAudioTime
            );
```

**Step 4: Run tests**

```bash
node tests/test_match_helpers.cjs && node tests/test_sync_helpers.cjs && node tests/test_telemetry.cjs
```

Expected: All pass.

**Step 5: Commit**

```bash
git add static/player.js
git commit -m "feat: add _logTransition telemetry method and hook into line-advance path"
```

---

### Task 6: Add `_downloadTelemetry()`, auto-download on song end, and HUD button

**Files:**
- Modify: `static/player.js` â€” diagnostics section, `audio.ended` handler (around line 1406), `_renderDebugHud()` (around line 1147)

**Step 1: Add `_downloadTelemetry()` method** after `_logTransition()`:

```javascript
    /**
     * Serialise the telemetry log to JSON and trigger a browser download.
     * Falls back to console.warn if the blob URL fails.
     */
    _downloadTelemetry() {
        if (!this._telemetry) return;
        try {
            // Fill in songDurationMs now if audio is ready and it was null at startGame
            if (!this._telemetry.meta.songDurationMs && audio && isFinite(audio.duration)) {
                this._telemetry.meta.songDurationMs = Math.round(audio.duration * 1000);
            }
            var json = JSON.stringify(this._telemetry, null, 2);
            var ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            var name = 'karaokee-telemetry-' + ts + '.json';
            var blob = new Blob([json], { type: 'application/json' });
            var url  = URL.createObjectURL(blob);
            var a    = document.createElement('a');
            a.href     = url;
            a.download = name;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            console.log('[Telemetry] Downloaded:', name,
                '|', this._telemetry.asr.length, 'asr,',
                this._telemetry.matches.length, 'matches,',
                this._telemetry.transitions.length, 'transitions');
        } catch (e) {
            console.warn('[Telemetry] Download failed â€” raw JSON below:', e);
            console.warn(JSON.stringify(this._telemetry, null, 2));
        }
    }
```

**Step 2: Call `_downloadTelemetry()` at song end**

Find the `audio.addEventListener('ended', ...)` handler (around line 1406). It already calls `gameMode.showEndModal()` inside a `setTimeout`. Add the telemetry download **before** that:

Find:
```javascript
        setTimeout(function() { gameMode.showEndModal(); }, 1500);
```

Change to:
```javascript
        if (window._kDebug) gameMode._downloadTelemetry();
        setTimeout(function() { gameMode.showEndModal(); }, 1500);
```

**Step 3: Add a ðŸ“¥ download button to the debug HUD**

Find `_renderDebugHud()`. It builds an HTML string for the HUD. Find where the HUD inner HTML is set (look for `hud.innerHTML = ...` or similar). Add a download button row.

Find the line that closes the HUD HTML (typically something like a closing `</div>` before `hud.innerHTML = ...`). Add this button before the closing content:

```javascript
        const dlBtn = `<div style="margin-top:6px"><button onclick="gameMode._downloadTelemetry()" style="font-size:11px;padding:2px 6px;cursor:pointer">ðŸ“¥ Download Telemetry</button></div>`;
```

Then include `dlBtn` in the `hud.innerHTML` assignment.

> **Tip:** Read `_renderDebugHud()` carefully before editing â€” the exact location depends on how the innerHTML string is built. Add `dlBtn` as the last item before `hud.innerHTML = ...`.

**Step 4: Run all tests**

```bash
node tests/test_match_helpers.cjs && node tests/test_sync_helpers.cjs && node tests/test_telemetry.cjs && python -m pytest tests/ -v
```

Expected: All pass.

**Step 5: Commit**

```bash
git add static/player.js
git commit -m "feat: add _downloadTelemetry, auto-download on song end, HUD download button"
```

---

### Task 7: Manual smoke test

1. Start the Flask server: `python app.py`
2. Open a song in the browser, press **D** to enable debug mode
3. Start Game Mode, sing along for at least 2â€“3 lines
4. Let the song end (or press ðŸ“¥ in the HUD)
5. Confirm a `.json` file downloads
6. Open it and verify:
   - `meta.songDurationMs` is a positive number
   - `meta.lrcLines` matches the song's line count
   - `asr[]`, `matches[]`, `transitions[]` all have entries
   - Every `lineTempo` value is `"slow"`, `"medium"`, or `"fast"` (never `"normal"`)
   - `transitions[]` entries have `missedWords` as an array

**Step 7: Final commit (if any fixups were needed)**

```bash
git add static/player.js
git commit -m "fix: telemetry smoke test fixups"
```
