# Intelligent Lyrics Matching Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce false misses in karaoke word matching by adding word-boundary canonicalization, ASR latency compensation, a post-hoc reconciliation pass, and fast-section grace periods.

**Architecture:** New pure functions go in `static/match-helpers.js` (testable in Node.js). Integration code modifies `static/player.js` and `static/sync-helpers.js`. Tests follow the existing `tests/test_sync_helpers.cjs` pattern using Node.js `assert`.

**Tech Stack:** Plain JavaScript (browser globals, no modules), Node.js assert for tests

**Design doc:** `docs/plans/2026-03-03-intelligent-matching-design.md`

---

### Task 1: Create match-helpers.js with WORD_EQUIV_MAP and canonicalizeWords

**Files:**
- Create: `static/match-helpers.js`
- Create: `tests/test_match_helpers.cjs`

**Context:** `canonicalizeWords` merges multi-word phrases into canonical single-word forms (e.g., "all right" -> "alright"). Applied to both lyrics and ASR transcript so both sides normalize to the same form. This fixes the "alright" vs "all right" bug.

**Step 1: Write the failing test**

Create `tests/test_match_helpers.cjs`:

```javascript
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

// Load match-helpers.js the same way test_sync_helpers.cjs loads its module
var filePath = path.join(__dirname, '..', 'static', 'match-helpers.js');
var code = fs.readFileSync(filePath, 'utf8');
var fakeModule = { exports: {} };
var fn = new Function('module', 'exports', code);
fn(fakeModule, fakeModule.exports);

var canonicalizeWords = fakeModule.exports.canonicalizeWords;

// --- canonicalizeWords: split form merges ---
assert.deepStrictEqual(
    canonicalizeWords(['all', 'right']),
    ['alright'],
    '"all right" should merge to "alright"'
);

assert.deepStrictEqual(
    canonicalizeWords(['every', 'day']),
    ['everyday'],
    '"every day" should merge to "everyday"'
);

assert.deepStrictEqual(
    canonicalizeWords(['in', 'to']),
    ['into'],
    '"in to" should merge to "into"'
);

// --- canonicalizeWords: already-canonical words pass through ---
assert.deepStrictEqual(
    canonicalizeWords(['alright']),
    ['alright'],
    '"alright" should pass through unchanged'
);

assert.deepStrictEqual(
    canonicalizeWords(['hello', 'world']),
    ['hello', 'world'],
    'non-equiv words should pass through unchanged'
);

// --- canonicalizeWords: mixed sentence ---
assert.deepStrictEqual(
    canonicalizeWords(['its', 'all', 'right', 'every', 'day']),
    ['its', 'alright', 'everyday'],
    'should merge multiple equiv phrases in one pass'
);

// --- canonicalizeWords: longest match wins ---
assert.deepStrictEqual(
    canonicalizeWords(['all', 'together']),
    ['altogether'],
    '"all together" should merge to "altogether"'
);

// --- canonicalizeWords: empty input ---
assert.deepStrictEqual(canonicalizeWords([]), []);

// --- canonicalizeWords: single word not in map ---
assert.deepStrictEqual(canonicalizeWords(['love']), ['love']);

console.log('All canonicalizeWords tests passed.');
```

**Step 2: Run test to verify it fails**

Run: `node tests/test_match_helpers.cjs`
Expected: FAIL — file `static/match-helpers.js` does not exist

**Step 3: Write minimal implementation**

Create `static/match-helpers.js`:

```javascript
/**
 * Pure helper functions for intelligent lyrics matching.
 * No DOM or AudioContext dependencies — testable in Node.js.
 */

/**
 * Maps multi-word phrases to canonical single-word forms.
 * Both lyrics and ASR transcript are canonicalized so that
 * "all right" and "alright" both become "alright".
 */
var WORD_EQUIV_MAP = {
    'all right':     'alright',
    'every day':     'everyday',
    'every one':     'everyone',
    'any one':       'anyone',
    'some one':      'someone',
    'no one':        'noone',
    'any time':      'anytime',
    'some time':     'sometime',
    'any way':       'anyway',
    'every thing':   'everything',
    'some thing':    'something',
    'any thing':     'anything',
    'no thing':      'nothing',
    'in to':         'into',
    'on to':         'onto',
    'a lot':         'alot',
    'all ready':     'already',
    'all ways':      'always',
    'all though':    'although',
    'all together':  'altogether',
};

/**
 * Canonicalize a word array by merging multi-word phrases into
 * their single-word canonical form using WORD_EQUIV_MAP.
 * Scans with a sliding window of up to 3 words; longest match wins.
 *
 * @param {string[]} words - normalized word array
 * @returns {string[]} canonicalized word array (may be shorter)
 */
function canonicalizeWords(words) {
    var out = [];
    var i = 0;
    while (i < words.length) {
        var matched = false;
        // Try 3-word, then 2-word phrases (longest match wins)
        for (var n = 3; n >= 2; n--) {
            if (i + n <= words.length) {
                var phrase = words.slice(i, i + n).join(' ');
                if (WORD_EQUIV_MAP[phrase]) {
                    out.push(WORD_EQUIV_MAP[phrase]);
                    i += n;
                    matched = true;
                    break;
                }
            }
        }
        if (!matched) {
            out.push(words[i]);
            i++;
        }
    }
    return out;
}

// Node.js exports for testing; browser ignores this
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { WORD_EQUIV_MAP, canonicalizeWords };
}
```

**Step 4: Run test to verify it passes**

Run: `node tests/test_match_helpers.cjs`
Expected: PASS — "All canonicalizeWords tests passed."

**Step 5: Commit**

```bash
git add static/match-helpers.js tests/test_match_helpers.cjs
git commit -m "feat: add WORD_EQUIV_MAP and canonicalizeWords in match-helpers.js"
```

---

### Task 2: Add LatencyTracker to match-helpers.js

**Files:**
- Modify: `static/match-helpers.js` (append LatencyTracker class)
- Modify: `tests/test_match_helpers.cjs` (append LatencyTracker tests)

**Context:** Tracks how late ASR results arrive relative to predicted word timing. Maintains a sliding window of the 20 most recent deltas. The median is used to shift time windows so they adapt to actual ASR performance. Activates after 8 observations.

**Step 1: Write the failing tests**

Append to `tests/test_match_helpers.cjs` (before the final console.log, or add a new section):

```javascript
var LatencyTracker = fakeModule.exports.LatencyTracker;

// --- LatencyTracker: basic ---
var lt = new LatencyTracker();
assert.strictEqual(lt.isCalibrated(), false, 'not calibrated initially');
assert.strictEqual(lt.getEstimatedLatency(), 0, 'latency is 0 before calibration');

// --- LatencyTracker: calibration threshold ---
for (var i = 0; i < 7; i++) lt.record(0.4);
assert.strictEqual(lt.isCalibrated(), false, 'not calibrated with only 7 observations');
lt.record(0.4);
assert.strictEqual(lt.isCalibrated(), true, 'calibrated after 8 observations');
assert.ok(Math.abs(lt.getEstimatedLatency() - 0.4) < 0.01, 'latency should be ~0.4');

// --- LatencyTracker: median (not mean) ---
var lt2 = new LatencyTracker();
// Add 8 values: 7x 0.3 and 1x 10.0 (outlier)
for (var i = 0; i < 7; i++) lt2.record(0.3);
lt2.record(10.0);
// Median of [0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 10.0] = 0.3
assert.ok(Math.abs(lt2.getEstimatedLatency() - 0.3) < 0.01, 'median should resist outlier');

// --- LatencyTracker: sliding window of 20 ---
var lt3 = new LatencyTracker();
for (var i = 0; i < 20; i++) lt3.record(0.2);
assert.ok(Math.abs(lt3.getEstimatedLatency() - 0.2) < 0.01, 'should be 0.2');
// Push 20 new values of 0.8 to flush the old ones
for (var i = 0; i < 20; i++) lt3.record(0.8);
assert.ok(Math.abs(lt3.getEstimatedLatency() - 0.8) < 0.01, 'should adapt to 0.8');

// --- LatencyTracker: reset ---
var lt4 = new LatencyTracker();
for (var i = 0; i < 10; i++) lt4.record(0.5);
lt4.reset();
assert.strictEqual(lt4.isCalibrated(), false, 'not calibrated after reset');
assert.strictEqual(lt4.getEstimatedLatency(), 0, 'latency 0 after reset');

console.log('All LatencyTracker tests passed.');
```

**Step 2: Run test to verify it fails**

Run: `node tests/test_match_helpers.cjs`
Expected: FAIL — `LatencyTracker` is undefined

**Step 3: Write minimal implementation**

Append to `static/match-helpers.js` (before the `module.exports` block):

```javascript
/**
 * Tracks ASR latency by recording match-time deltas and computing
 * a running median over a sliding window. Used to shift time gates
 * so they adapt to actual device/browser ASR performance.
 *
 * - Sliding window size: 20 observations
 * - Calibration threshold: 8 observations (first 2 lines have no data)
 * - Uses median (not mean) to resist outliers
 */
function LatencyTracker() {
    this._window = [];       // ring buffer of recent deltas
    this._maxSize = 20;
    this._minSamples = 8;    // calibration threshold
}

/**
 * Record a match latency observation.
 * @param {number} delta - seconds: (actual match time) - (predicted word time)
 */
LatencyTracker.prototype.record = function(delta) {
    this._window.push(delta);
    if (this._window.length > this._maxSize) {
        this._window.shift();
    }
};

/**
 * @returns {boolean} true if enough observations have been collected
 */
LatencyTracker.prototype.isCalibrated = function() {
    return this._window.length >= this._minSamples;
};

/**
 * @returns {number} estimated ASR latency in seconds (0 if not calibrated)
 */
LatencyTracker.prototype.getEstimatedLatency = function() {
    if (!this.isCalibrated()) return 0;
    var sorted = this._window.slice().sort(function(a, b) { return a - b; });
    var mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
        return (sorted[mid - 1] + sorted[mid]) / 2;
    }
    return sorted[mid];
};

/**
 * Clear all observations. Called on game start/restart.
 */
LatencyTracker.prototype.reset = function() {
    this._window = [];
};
```

Update the `module.exports` line:

```javascript
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { WORD_EQUIV_MAP, canonicalizeWords, LatencyTracker };
}
```

**Step 4: Run test to verify it passes**

Run: `node tests/test_match_helpers.cjs`
Expected: PASS — "All LatencyTracker tests passed."

**Step 5: Commit**

```bash
git add static/match-helpers.js tests/test_match_helpers.cjs
git commit -m "feat: add LatencyTracker class to match-helpers.js"
```

---

### Task 3: Add fast-section grace period helpers to sync-helpers.js

**Files:**
- Modify: `static/sync-helpers.js` (add two new functions)
- Modify: `tests/test_sync_helpers.cjs` (add tests)

**Context:** Fast sections need wider overlap zones and larger drift windows because ASR batches rapid speech into larger chunks. These helpers return multiplied values for fast tempo.

**Step 1: Write the failing tests**

Append to `tests/test_sync_helpers.cjs` (before the final `console.log`):

```javascript
var getFastOverlapDuration = fakeModule.exports.getFastOverlapDuration;
var getFastDriftMultiplier = fakeModule.exports.getFastDriftMultiplier;

// --- getFastOverlapDuration: 1.5x for fast, 1x for others ---
assert.strictEqual(getFastOverlapDuration('fast'), 0.75);   // 0.5 * 1.5
assert.strictEqual(getFastOverlapDuration('normal'), 0.8);  // unchanged
assert.strictEqual(getFastOverlapDuration('slow'), 1.0);    // unchanged

// --- getFastDriftMultiplier: 1.3x for fast, 1x for others ---
assert.strictEqual(getFastDriftMultiplier('fast'), 1.3);
assert.strictEqual(getFastDriftMultiplier('normal'), 1.0);
assert.strictEqual(getFastDriftMultiplier('slow'), 1.0);

console.log('All fast-grace tests passed.');
```

**Step 2: Run test to verify it fails**

Run: `node tests/test_sync_helpers.cjs`
Expected: FAIL — `getFastOverlapDuration` is undefined

**Step 3: Write minimal implementation**

Append to `static/sync-helpers.js` (before the `module.exports` block):

```javascript
/**
 * Return overlap duration with fast-section grace period applied.
 * Fast sections get 1.5x overlap to catch bursty ASR delivery.
 * @param {'slow'|'normal'|'fast'} tempoClass
 * @returns {number} seconds
 */
function getFastOverlapDuration(tempoClass) {
    var base = getOverlapDuration(tempoClass);
    return tempoClass === 'fast' ? base * 1.5 : base;
}

/**
 * Return drift window multiplier for a tempo class.
 * Fast sections get 1.3x wider drift to handle batched ASR.
 * @param {'slow'|'normal'|'fast'} tempoClass
 * @returns {number}
 */
function getFastDriftMultiplier(tempoClass) {
    return tempoClass === 'fast' ? 1.3 : 1.0;
}
```

Update the `module.exports` line in `sync-helpers.js`:

```javascript
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { classifyTempo, getWindowParams, getOverlapDuration, getScoreDelay, getChunkSamples, getFastOverlapDuration, getFastDriftMultiplier };
}
```

**Step 4: Run test to verify it passes**

Run: `node tests/test_sync_helpers.cjs`
Expected: PASS — "All fast-grace tests passed."

**Step 5: Commit**

```bash
git add static/sync-helpers.js tests/test_sync_helpers.cjs
git commit -m "feat: add fast-section grace period helpers to sync-helpers.js"
```

---

### Task 4: Wire match-helpers.js into player.html and normalization pipeline

**Files:**
- Modify: `static/player.html:343` (add script tag)
- Modify: `static/player.js:806-813` (canonicalize lyrics in setActiveLine)
- Modify: `static/player.js:824-843` (canonicalize spoken words in _collectMatches)
- Modify: `static/player.js:691-718` (canonicalize in _collectMatchesWhisper)
- Modify: `static/player.js:658-689` (canonicalize in _matchPrevLine)
- Modify: `static/player.js:898-924` (canonicalize in _matchHotWord)

**Context:** Two changes: (1) add `<script>` tag for match-helpers.js, (2) insert `canonicalizeWords(expandContractions(...))` into every path where words are prepared for matching. Note: `expandContractions()` is defined but never called in the current code — we wire it in here too.

**Step 1: Add script tag**

In `static/player.html` at line 343, add match-helpers.js between sync-helpers and player.js:

```html
    <script src="/static/sync-helpers.js"></script>
    <script src="/static/match-helpers.js"></script>
    <script src="/static/player.js"></script>
```

**Step 2: Canonicalize lyrics words in setActiveLine**

In `static/player.js`, replace lines 812-813:

```javascript
        var rawWords = lineText.split(' ');
        this.lineWords = rawWords.map(function(w) { return normalizeWord(w); });
```

With:

```javascript
        var rawWords = lineText.split(' ');
        var normed = rawWords.map(function(w) { return normalizeWord(w); });
        this.lineWords = canonicalizeWords(expandContractions(normed));
```

**Important:** After this change, `this.lineWords` may have a different length than `rawWords` (e.g., "all right" becomes one word "alright" but is still rendered as two `<span>` elements). We need a mapping from canonicalized word indices back to span indices. Add a word-to-span index map:

```javascript
        var rawWords = lineText.split(' ');
        var normed = rawWords.map(function(w) { return normalizeWord(w); });
        this.lineWords = canonicalizeWords(expandContractions(normed));

        // Build mapping: lineWords[i] → [spanIdx, spanIdx, ...] so we can
        // light up the correct visual spans when a canonicalized word matches.
        this.wordToSpans = [];
        var spanCursor = 0;
        var expanded = expandContractions(normed);
        var ci = 0;
        while (ci < expanded.length && this.wordToSpans.length < this.lineWords.length) {
            // How many expanded words did canonicalization consume for this canonical word?
            var canonWord = this.lineWords[this.wordToSpans.length];
            var spanIndices = [];
            // Try 3-word, 2-word match, else 1-word
            var consumed = 1;
            for (var n = 3; n >= 2; n--) {
                if (ci + n <= expanded.length) {
                    var phrase = expanded.slice(ci, ci + n).join(' ');
                    if (WORD_EQUIV_MAP[phrase] === canonWord) {
                        consumed = n;
                        break;
                    }
                }
            }
            for (var k = 0; k < consumed; k++) spanIndices.push(spanCursor++);
            this.wordToSpans.push(spanIndices);
        }
        // If there are remaining spans (from contraction expansion mismatch), map 1:1
        while (this.wordToSpans.length < this.lineWords.length) {
            this.wordToSpans.push([spanCursor++]);
        }
```

**Step 3: Update _updateWordSpans to use wordToSpans mapping**

In `static/player.js`, replace the `_updateWordSpans` method (lines 852-864):

```javascript
    _updateWordSpans() {
        const lines = lyricsScroll.querySelectorAll('.lyric-line');
        const lineEl = lines[this.activeLineIdx];
        if (!lineEl) return;

        const spans = lineEl.querySelectorAll('.word-span');
        for (var wi = 0; wi < this.lineWords.length; wi++) {
            var spanIdxs = this.wordToSpans[wi] || [wi];
            for (var si = 0; si < spanIdxs.length; si++) {
                var span = spans[spanIdxs[si]];
                if (!span) continue;
                span.classList.remove('matched', 'missed', 'reconciled');
                if (this.matchedSet.has(wi)) {
                    span.classList.add('matched');
                }
            }
        }
    }
```

**Step 4: Canonicalize spoken words in _collectMatches**

In `static/player.js`, replace line 826 in `_collectMatches`:

```javascript
        var spoken = normalizeWords(transcript);
```

With:

```javascript
        var spoken = canonicalizeWords(expandContractions(normalizeWords(transcript)));
```

**Step 5: Canonicalize spoken words in _collectMatchesWhisper**

In `static/player.js`, replace line 693 in `_collectMatchesWhisper`:

```javascript
        const spoken = normalizeWords(transcript);
```

With:

```javascript
        const spoken = canonicalizeWords(expandContractions(normalizeWords(transcript)));
```

**Step 6: Canonicalize spoken words in _matchPrevLine**

In `static/player.js`, replace line 663 in `_matchPrevLine`:

```javascript
        var spoken = normalizeWords(transcript);
```

With:

```javascript
        var spoken = canonicalizeWords(expandContractions(normalizeWords(transcript)));
```

**Step 7: Canonicalize spoken words in _matchHotWord**

In `static/player.js`, replace line 903 in `_matchHotWord`:

```javascript
        var spoken = normalizeWords(transcript);
```

With:

```javascript
        var spoken = canonicalizeWords(expandContractions(normalizeWords(transcript)));
```

**Step 8: Update fence calculation in setActiveLine**

In `static/player.js`, replace lines 776-777 in `setActiveLine`:

```javascript
        this.lineStartWordCount = normalizeWords(this.transcript).length;
        this.lineStartTranscriptPos = this.lineStartWordCount;
```

With (use same pipeline so fence counts canonicalized words):

```javascript
        this.lineStartWordCount = canonicalizeWords(expandContractions(normalizeWords(this.transcript))).length;
        this.lineStartTranscriptPos = this.lineStartWordCount;
```

**Step 9: Run existing tests to verify no regressions**

Run: `node tests/test_sync_helpers.cjs && node tests/test_match_helpers.cjs`
Expected: Both pass

**Step 10: Commit**

```bash
git add static/player.html static/player.js
git commit -m "feat: wire canonicalizeWords and expandContractions into matching pipeline"
```

---

### Task 5: Add concatenation fallback to matching loops

**Files:**
- Modify: `static/player.js:824-843` (_collectMatches)
- Modify: `static/player.js:691-718` (_collectMatchesWhisper)

**Context:** When `wordsMatch` fails, try concatenating adjacent spoken words and checking with phonetic matching only. Also try the reverse: a single spoken word matching two adjacent target words concatenated. The phonetic-only gate prevents false greens.

**Step 1: Add a phoneticOnly match helper near wordsMatch**

In `static/player.js`, add after `wordsMatch` (after line 222):

```javascript
/**
 * Returns true only if spoken matches target via exact or Double Metaphone.
 * Does NOT allow edit-distance matching. Used for concatenation fallback
 * where false-green risk is higher.
 */
function wordsMatchPhoneticOnly(spoken, target) {
    if (spoken === target) return true;
    var sp = doubleMetaphone(spoken);
    var tp = doubleMetaphone(target);
    if (sp[0] && tp[0] && (sp[0] === tp[0] || sp[0] === tp[1] || (sp[1] && (sp[1] === tp[0] || sp[1] === tp[1])))) return true;
    return false;
}
```

**Step 2: Add concatenation fallback to _collectMatches**

In `static/player.js`, replace the inner loop of `_collectMatches` (lines 835-841). The current code is:

```javascript
            for (var si = spokenIdx; si < Math.min(spokenIdx + driftWindow, spoken.length); si++) {
                if (wordsMatch(spoken[si], target)) {
                    resultSet.add(li);
                    spokenIdx = si + 1;
                    break;
                }
            }
```

Replace with:

```javascript
            var found = false;
            for (var si = spokenIdx; si < Math.min(spokenIdx + driftWindow, spoken.length); si++) {
                if (wordsMatch(spoken[si], target)) {
                    resultSet.add(li);
                    spokenIdx = si + 1;
                    found = true;
                    break;
                }
                // Concatenation fallback: try merging spoken[si]+spoken[si+1] → target (phonetic only)
                if (si + 1 < spoken.length && wordsMatchPhoneticOnly(spoken[si] + spoken[si + 1], target)) {
                    resultSet.add(li);
                    spokenIdx = si + 2; // consume both spoken words
                    found = true;
                    break;
                }
            }
            // Reverse fallback: single spoken word matches two adjacent target words
            if (!found && li + 1 < this.lineWords.length) {
                var combinedTarget = target + this.lineWords[li + 1];
                for (var si = spokenIdx; si < Math.min(spokenIdx + driftWindow, spoken.length); si++) {
                    if (wordsMatchPhoneticOnly(spoken[si], combinedTarget)) {
                        resultSet.add(li);
                        resultSet.add(li + 1);
                        spokenIdx = si + 1;
                        li++; // skip next target word (already matched)
                        break;
                    }
                }
            }
```

**Step 3: Add same fallback to _collectMatchesWhisper**

Apply the same pattern to `_collectMatchesWhisper` (lines 698-710). Replace the inner loop:

```javascript
            for (let si = spokenIdx; si < Math.min(spokenIdx + driftWindow, spoken.length); si++) {
                if (wordsMatch(spoken[si], target)) {
                    whisperSet.add(li);
                    spokenIdx = si + 1;
                    break;
                }
            }
```

With the same concatenation + reverse fallback pattern as above (using `whisperSet` instead of `resultSet`).

**Step 4: Run tests**

Run: `node tests/test_match_helpers.cjs && node tests/test_sync_helpers.cjs`
Expected: All pass (no new unit tests for this task — the fallback is integration-level, tested manually)

**Step 5: Commit**

```bash
git add static/player.js
git commit -m "feat: add phonetic-gated concatenation fallback to matching loops"
```

---

### Task 6: Wire LatencyTracker into GameMode

**Files:**
- Modify: `static/player.js:372-417` (GameMode constructor)
- Modify: `static/player.js:419-450` (start method)
- Modify: `static/player.js:824-843` (_collectMatches — record latency)
- Modify: `static/player.js:898-924` (_matchHotWord — record latency)
- Modify: `static/player.js:830-832` (time gate — apply compensation)

**Context:** Create a LatencyTracker instance in GameMode. Each time a word matches, record the delta between actual match time and the word's predicted time. Use the estimated latency to shift time gate windows.

**Step 1: Add LatencyTracker to constructor**

In `static/player.js`, add to the GameMode constructor (around line 412):

```javascript
        // ASR latency compensation
        this.latencyTracker = new LatencyTracker();
```

**Step 2: Reset tracker on start**

In the `start()` method (around line 438), add after `this.isSpeaking = false;`:

```javascript
        this.latencyTracker.reset();
```

**Step 3: Record latency in _collectMatches**

In `_collectMatches`, after a match is found (`resultSet.add(li)`), record the latency delta. Add after `resultSet.add(li);`:

```javascript
                    // Record latency for adaptive compensation
                    if (li < this.wordTimings.length) {
                        var expected = this.wordTimings[li].estimatedTime;
                        this.latencyTracker.record(now - expected);
                    }
```

**Step 4: Record latency in _matchHotWord**

In `_matchHotWord`, after `this.matchedSet.add(this.hotWordIndex);` (line 919), add:

```javascript
                // Record latency
                if (this.hotWordIndex < this.wordTimings.length) {
                    var expected = this.wordTimings[this.hotWordIndex].estimatedTime;
                    this.latencyTracker.record(audio.currentTime - expected);
                }
```

**Step 5: Apply latency compensation to time gates**

In `_collectMatches`, replace the time gate check (lines 831-833):

```javascript
            if (li < this.wordTimings.length) {
                if (now < this.wordTimings[li].windowStart) continue;
            }
```

With:

```javascript
            if (li < this.wordTimings.length) {
                var latencyShift = this.latencyTracker.getEstimatedLatency();
                var effectiveStart = this.wordTimings[li].windowStart - latencyShift;
                if (now < effectiveStart) continue;
            }
```

**Step 6: Apply same compensation to _collectMatchesWhisper time gate**

In `_collectMatchesWhisper`, replace the time gate check (lines 699-701):

```javascript
                if (now < this.wordTimings[li].windowStart) continue;
```

With:

```javascript
                var latencyShift = this.latencyTracker.getEstimatedLatency();
                if (now < this.wordTimings[li].windowStart - latencyShift) continue;
```

**Step 7: Apply compensation to updateHotWord window**

In `updateHotWord` (line 882), replace:

```javascript
            if (t >= wt.windowStart && t <= wt.windowEnd) {
```

With:

```javascript
            var latencyShift = this.latencyTracker.getEstimatedLatency();
            if (t >= wt.windowStart - latencyShift && t <= wt.windowEnd + Math.max(latencyShift, 0.3)) {
```

**Step 8: Run tests**

Run: `node tests/test_match_helpers.cjs && node tests/test_sync_helpers.cjs`
Expected: All pass

**Step 9: Commit**

```bash
git add static/player.js
git commit -m "feat: wire LatencyTracker into GameMode for adaptive time gates"
```

---

### Task 7: Add post-hoc reconciliation to _finalizePrevLine

**Files:**
- Modify: `static/player.js:641-650` (_finalizePrevLine)

**Context:** Before scoring a completed line, re-scan any unmatched words against the full transcript. Uses wider drift and restricts short words to exact+phonetic only. Reconciled words get a distinct CSS class.

**Step 1: Add reconciliation logic to _finalizePrevLine**

In `static/player.js`, replace `_finalizePrevLine` (lines 641-650):

```javascript
    _finalizePrevLine() {
        if (!this.prevLine) return;
        var prev = this.prevLine;
        this.prevLine = null;

        // Score the previous line with its final match state
        if (prev.lineWords.length > 0) {
            this._scoreLine(prev.lineIdx, prev.lineWords, prev.matchedSet);
        }
    }
```

With:

```javascript
    _finalizePrevLine() {
        if (!this.prevLine) return;
        var prev = this.prevLine;
        this.prevLine = null;

        if (prev.lineWords.length === 0) return;

        // --- Post-hoc reconciliation pass ---
        // Re-scan unmatched words against the full transcript accumulated during
        // this line's lifetime, with a wider drift window.
        var spokenFull = canonicalizeWords(expandContractions(normalizeWords(this.transcript)));
        var reconciledSet = new Set();
        var driftWindow = (prev.params.driftTrack1 || 18) * 2; // 2x normal drift
        var cursor = prev.lineStartTranscriptPos;

        for (var li = 0; li < prev.lineWords.length; li++) {
            if (prev.matchedSet.has(li)) {
                // Already matched — advance cursor past this word's approximate position
                cursor++;
                continue;
            }
            var target = prev.lineWords[li];

            // Short-word guard: 3 chars or fewer → phonetic only (no edit distance)
            var matchFn = target.length <= 3 ? wordsMatchPhoneticOnly : wordsMatch;

            for (var si = cursor; si < Math.min(cursor + driftWindow, spokenFull.length); si++) {
                if (matchFn(spokenFull[si], target)) {
                    prev.matchedSet.add(li);
                    reconciledSet.add(li);
                    cursor = si + 1;
                    break;
                }
            }
        }

        // Light reconciled words green with distinct class
        if (reconciledSet.size > 0) {
            var allLines = lyricsScroll.querySelectorAll('.lyric-line');
            var lineEl = allLines[prev.lineIdx];
            if (lineEl) {
                var spans = lineEl.querySelectorAll('.word-span');
                reconciledSet.forEach(function(wi) {
                    var spanIdxs = prev.wordToSpans ? prev.wordToSpans[wi] : [wi];
                    for (var k = 0; k < spanIdxs.length; k++) {
                        var span = spans[spanIdxs[k]];
                        if (span) {
                            span.classList.remove('missed');
                            span.classList.add('matched', 'reconciled');
                        }
                    }
                });
            }

            if (window._kDebug) {
                var reconWords = [];
                reconciledSet.forEach(function(i) { reconWords.push(prev.lineWords[i]); });
                console.log('[GAME] Reconciled +' + reconciledSet.size + ' on line ' + prev.lineIdx + ':', reconWords.join(', '));
            }
        }

        // Score the previous line with its updated match state
        this._scoreLine(prev.lineIdx, prev.lineWords, prev.matchedSet);
    }
```

**Step 2: Save wordToSpans in prevLine snapshot**

In `setActiveLine`, in the prevLine capture block (around line 735-745), add `wordToSpans` to the snapshot:

```javascript
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
                wordToSpans:            this.wordToSpans ? this.wordToSpans.slice() : null,
            };
```

**Step 3: Run tests**

Run: `node tests/test_match_helpers.cjs && node tests/test_sync_helpers.cjs`
Expected: All pass

**Step 4: Commit**

```bash
git add static/player.js
git commit -m "feat: add post-hoc reconciliation pass to _finalizePrevLine"
```

---

### Task 8: Wire fast-section grace period into overlap and drift

**Files:**
- Modify: `static/player.js:720-757` (setActiveLine — use getFastOverlapDuration)
- Modify: `static/player.js:824-843` (_collectMatches — apply drift multiplier)
- Modify: `static/player.js:691-718` (_collectMatchesWhisper — apply drift multiplier)

**Step 1: Use getFastOverlapDuration in setActiveLine**

In `setActiveLine`, replace line 732:

```javascript
            var overlapDuration = getOverlapDuration(outgoingTempoClass);
```

With:

```javascript
            var overlapDuration = getFastOverlapDuration(outgoingTempoClass);
```

**Step 2: Apply drift multiplier in _collectMatches**

In `_collectMatches`, replace line 829:

```javascript
        var driftWindow = this.currentParams.driftTrack1;
```

With:

```javascript
        var tempoClass = (this.wordTimings && this.wordTimings.tempoClass) || 'normal';
        var driftWindow = Math.round(this.currentParams.driftTrack1 * getFastDriftMultiplier(tempoClass));
```

**Step 3: Apply drift multiplier in _collectMatchesWhisper**

In `_collectMatchesWhisper`, replace line 697:

```javascript
        var driftWindow = this.currentParams.driftTrack2;
```

With:

```javascript
        var tempoClass = (this.wordTimings && this.wordTimings.tempoClass) || 'normal';
        var driftWindow = Math.round(this.currentParams.driftTrack2 * getFastDriftMultiplier(tempoClass));
```

**Step 4: Run tests**

Run: `node tests/test_sync_helpers.cjs && node tests/test_match_helpers.cjs`
Expected: All pass

**Step 5: Commit**

```bash
git add static/player.js
git commit -m "feat: wire fast-section grace period into overlap and drift windows"
```

---

### Task 9: Add reconciled-word pulse CSS and update _scoreLine for reconciled spans

**Files:**
- Modify: `static/player.html:123-129` (add `.reconciled` CSS)
- Modify: `static/player.js:940-955` (_scoreLine — skip reconciled spans when marking missed)

**Step 1: Add CSS for reconciled animation**

In `static/player.html`, after the `.word-span.missed` rule (line 129), add:

```css
        .word-span.reconciled {
            animation: reconcile-pulse 0.6s ease-out;
        }

        @keyframes reconcile-pulse {
            0%   { color: #ffff00; text-shadow: 0 0 8px #ffff0088; }
            100% { color: #00e676; text-shadow: none; }
        }
```

**Step 2: Update _scoreLine to respect reconciled words**

In `_scoreLine`, the line that marks unmatched spans as red (line 945):

```javascript
                if (!matchedSet.has(wi)) span.classList.add('missed');
```

Should also handle reconciled spans — already matched spans with `.reconciled` should NOT get `.missed`. The current logic only checks `matchedSet.has(wi)` which already includes reconciled words (they were added to `matchedSet` in the reconciliation pass). So this line should work correctly as-is. No change needed.

**Step 3: Run tests**

Run: `node tests/test_sync_helpers.cjs && node tests/test_match_helpers.cjs`
Expected: All pass

**Step 4: Commit**

```bash
git add static/player.html
git commit -m "feat: add reconciled-word pulse animation CSS"
```

---

### Task 10: Update debug HUD with latency, reconciliation, and canonicalization info

**Files:**
- Modify: `static/player.js:1054-1111` (_renderDebugHud)

**Step 1: Add latency and reconciliation info to debug HUD**

In `_renderDebugHud`, after the overlap info line (around line 1090), add:

```javascript
        // ASR latency compensation
        var latEst = this.latencyTracker.isCalibrated()
            ? this.latencyTracker.getEstimatedLatency().toFixed(3) + 's'
            : 'calibrating (' + this.latencyTracker._window.length + '/8)';
        html += '<div class="dbg-row"><span class="dbg-label">Ltncy </span>' + latEst + '</div>';
```

**Step 2: Log canonicalization events**

In `setActiveLine`, after the `this.lineWords = canonicalizeWords(...)` assignment, add debug logging:

```javascript
        // Debug: log if canonicalization changed anything
        if (window._kDebug && this.lineWords.length !== normed.length) {
            console.log('[GAME] Canonicalized line ' + lineIdx + ': [' + normed.join(', ') + '] → [' + this.lineWords.join(', ') + ']');
        }
```

**Step 3: Run tests**

Run: `node tests/test_sync_helpers.cjs && node tests/test_match_helpers.cjs`
Expected: All pass

**Step 4: Commit**

```bash
git add static/player.js
git commit -m "feat: update debug HUD with latency and canonicalization info"
```

---

### Task 11: Run all tests and verify

**Step 1: Run all automated tests**

Run: `node tests/test_sync_helpers.cjs && node tests/test_match_helpers.cjs`
Expected: All pass with no errors

**Step 2: Verify no syntax errors in player.js**

Run: `node --check static/player.js`
Expected: No syntax errors (exit code 0)

Note: `player.js` references browser globals (`document`, `audio`, etc.) so it can't be _executed_ in Node, but `--check` only validates syntax.

**Step 3: Verify no syntax errors in match-helpers.js**

Run: `node --check static/match-helpers.js`
Expected: No syntax errors (exit code 0)

**Step 4: Verify no syntax errors in sync-helpers.js**

Run: `node --check static/sync-helpers.js`
Expected: No syntax errors (exit code 0)

**Step 5: Manual smoke test**

Start the app (`python app.py`) and:
1. Load a song with "alright" in the lyrics
2. Enable debug HUD (press D)
3. Start Game Mode and sing along
4. Verify: saying "all right" lights up "Alright" green
5. Verify: debug HUD shows latency calibration progress
6. Verify: on fast sections, drift windows are wider
7. Verify: reconciled words pulse yellow→green at line transitions
8. Verify: no false greens on words you didn't say

**Step 6: Commit (if any fixes were needed)**

```bash
git add -A
git commit -m "fix: address issues found during smoke testing"
```
