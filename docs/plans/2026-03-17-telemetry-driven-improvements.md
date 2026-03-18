# Telemetry-Driven Scoring & ASR Improvements — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Improve match accuracy and scoring fairness based on analysis of 10 real-play telemetry sessions (78.1% overall match rate across 620 lines, 5303 words).

**Architecture:** All changes are in the frontend JS layer (`static/match-helpers.js`, `static/sync-helpers.js`, `static/player.js`). The matching pipeline gains three new fallback stages (slang dictionary, phonetic scoring, edit-distance scoring). Word weights are computed at lyrics load time and fed into a weighted scoring formula. ASR buffer management gets line-transition resets and sliding-window truncation.

**Tech Stack:** Vanilla JS (browser), no build step. Files loaded via `<script>` tags. `match-helpers.js` and `sync-helpers.js` have Node.js exports for testing.

---

### Task 1: Add slang/ASR-mishearing dictionary to match-helpers.js

**Files:**
- Modify: `static/match-helpers.js:7-63` (near CONTRACTION_MAP)

**Step 1: Add the SLANG_MAP dictionary**

Add a new `SLANG_MAP` object after `CONTRACTION_MAP` (line 63). This is a **bidirectional** lookup — if the ASR hears "gonna" but the lyric says "going", OR the lyric says "gonna" but ASR hears "going", both should match. Unlike CONTRACTION_MAP (which maps slang→expansion for multi-word matching), SLANG_MAP maps single-word synonyms.

```javascript
// --- Slang / ASR-mishearing dictionary ---
// Bidirectional: if ASR hears key, it can match value, and vice versa.
// These handle cases where ASR sanitizes, mishears, or normalizes slang.
var SLANG_MAP = {};
(function() {
    var pairs = [
        // Profanity ASR sanitization
        ['nigga', 'n***a'], ['nigga', 'ninja'], ['nigga', 'miga'],
        ['niggas', 'ninjas'], ['shit', 'shoot'], ['shit', 'ship'],
        ['fuck', 'fudge'], ['fuck', 'fk'], ['fuckin', 'freaking'],
        ['fucking', 'freaking'], ['ass', 'as'], ['bitch', 'beach'],
        ['bitches', 'beaches'], ['damn', 'dang'], ['hell', 'heck'],
        // Common ASR mishearings
        ['ya', 'you'], ['yo', 'you'], ['yuh', 'yeah'],
        ['nah', 'no'], ['na', 'no'], ['aye', 'hey'],
        ['em', 'them'], ['im', 'i\'m'], ['ur', 'your'],
        ['cuz', 'because'], ['cause', 'because'],
        ['bout', 'about'], ['wit', 'with'],
        ['da', 'the'], ['tha', 'the'],
        ['dat', 'that'], ['dis', 'this'],
        ['dem', 'them'], ['dey', 'they'],
        ['lil', 'little'], ['til', 'until'],
        // Ad-lib / interjection normalization
        ['ooh', 'oh'], ['oooh', 'oh'], ['ooo', 'oh'],
        ['ahh', 'ah'], ['ahhh', 'ah'],
        ['yeah', 'yea'], ['yea', 'yeah'],
        ['huh', 'ha'], ['hmm', 'hm'],
        ['ayy', 'hey'], ['ey', 'hey'], ['ay', 'hey'],
        ['woo', 'whoo'], ['woah', 'whoa'],
        // Numbers / abbreviations
        ['2', 'two'], ['to', 'two'], ['too', 'two'],
        ['4', 'four'], ['for', 'four'],
    ];
    for (var i = 0; i < pairs.length; i++) {
        var a = pairs[i][0], b = pairs[i][1];
        if (!SLANG_MAP[a]) SLANG_MAP[a] = new Set();
        SLANG_MAP[a].add(b);
        if (!SLANG_MAP[b]) SLANG_MAP[b] = new Set();
        SLANG_MAP[b].add(a);
    }
})();

/**
 * Check if spoken word matches target via slang/ASR-mishearing dictionary.
 * Returns true if spoken is a known synonym of target.
 */
function slangMatch(spoken, target) {
    var alts = SLANG_MAP[spoken];
    return !!(alts && alts.has(target));
}
```

**Step 2: Export new symbols for testing**

Add `SLANG_MAP` and `slangMatch` to the Node.js exports block at line 251-264:

```javascript
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        CONTRACTION_MAP: CONTRACTION_MAP,
        REVERSE_CONTRACTION_MAP: REVERSE_CONTRACTION_MAP,
        contractionsMatch: contractionsMatch,
        multiWordContractionMatch: multiWordContractionMatch,
        PHRASE_EQUIV_MAP: PHRASE_EQUIV_MAP,
        phraseMatch: phraseMatch,
        FILLER_WORDS: FILLER_WORDS,
        maxEditDistance: maxEditDistance,
        skipFuzzyMatch: skipFuzzyMatch,
        MetaphoneLRU: MetaphoneLRU,
        SLANG_MAP: SLANG_MAP,
        slangMatch: slangMatch,
    };
}
```

**Step 3: Commit**

```bash
git add static/match-helpers.js
git commit -m "feat: add SLANG_MAP bidirectional dictionary for ASR mishearings, profanity, and ad-libs"
```

---

### Task 2: Change wordsMatch() to return a score instead of boolean

**Files:**
- Modify: `static/player.js:157-168` (wordsMatch function)

**Step 1: Create wordsMatchScore() alongside existing wordsMatch()**

Add a new function `wordsMatchScore()` that returns `{ score: number, method: string }` instead of boolean. Keep the existing `wordsMatch()` as a thin wrapper so that `_matchPrevLine()` and `_collectMatchesWhisper()` still work unchanged initially.

Add this right after the existing `wordsMatch()` function (after line 168):

```javascript
/**
 * Scored word matching. Returns { score, method } where:
 *   score:  0.0 to 1.0
 *   method: 'exact' | 'phonetic' | 'slang' | 'edit1' | 'edit2' | 'contraction' | 'none'
 */
function wordsMatchScore(spoken, target, targetPhonetic) {
    // 1. Exact
    if (spoken === target) return { score: 1.0, method: 'exact' };

    // 2. Contraction (single-word)
    if (contractionsMatch(spoken, target)) return { score: 1.0, method: 'contraction' };

    // 3. Slang dictionary
    if (slangMatch(spoken, target)) return { score: 0.9, method: 'slang' };

    // 4. Phonetic match
    var sp = _spokenLRU.get(spoken);
    var tp = targetPhonetic || doubleMetaphone(target);
    if (sp[0] && tp[0] && (sp[0] === tp[0] || sp[0] === tp[1] || (sp[1] && (sp[1] === tp[0] || sp[1] === tp[1])))) {
        return { score: 0.9, method: 'phonetic' };
    }

    // 5. Edit distance (only for words >= 3 chars)
    if (!skipFuzzyMatch(target) && !skipFuzzyMatch(spoken)) {
        var dist = (Math.abs(spoken.length - target.length) <= 3) ? editDistance(spoken, target) : Infinity;
        if (dist === 1) return { score: 0.75, method: 'edit1' };
        if (dist === 2) return { score: 0.5, method: 'edit2' };
    }

    return { score: 0.0, method: 'none' };
}
```

**Step 2: Commit**

```bash
git add static/player.js
git commit -m "feat: add wordsMatchScore() returning graduated scores and match methods"
```

---

### Task 3: Add word classification (core / function / ad-lib) with weights

**Files:**
- Modify: `static/match-helpers.js` (add word classification constants)
- Modify: `static/player.js:235-300` (interpolateWordTimings function)

**Step 1: Add classification constants to match-helpers.js**

Add after the `FILLER_WORDS` set (line 212):

```javascript
// --- Word classification for weighted scoring ---
var FUNCTION_WORDS = new Set([
    'a', 'an', 'the', 'i', 'me', 'my', 'we', 'us', 'our',
    'you', 'your', 'he', 'him', 'his', 'she', 'her',
    'it', 'its', 'they', 'them', 'their',
    'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
    'in', 'on', 'at', 'to', 'of', 'for', 'with', 'by', 'from',
    'and', 'or', 'but', 'so', 'if', 'as', 'than', 'that',
    'do', 'does', 'did', 'has', 'have', 'had',
    'not', 'no', 'up', 'out',
]);

var ADLIB_WORDS = new Set([
    'ooh', 'oh', 'ah', 'uh', 'yeah', 'yea', 'hey', 'huh',
    'wow', 'woo', 'whoo', 'whoa', 'woah', 'ayy', 'aye', 'ay',
    'la', 'na', 'da', 'ba', 'sha', 'ra',
    'hmm', 'hm', 'mm', 'mmm',
    'oo', 'ooo', 'oooh', 'ahh', 'ahhh',
    'skrrt', 'brr', 'grr', 'pew', 'pow', 'bang',
    'yuh', 'yah', 'aye',
]);

var WORD_WEIGHTS = { core: 1.0, function: 0.5, adlib: 0.25 };

/**
 * Classify a word for scoring weight.
 * @param {string} normalizedWord - already lowercased, punctuation-stripped
 * @param {boolean} inParentheses - true if the word was inside parentheses in the original lyric
 * @returns {'core'|'function'|'adlib'}
 */
function classifyWord(normalizedWord, inParentheses) {
    if (inParentheses) return 'adlib';
    if (ADLIB_WORDS.has(normalizedWord)) return 'adlib';
    if (FUNCTION_WORDS.has(normalizedWord)) return 'function';
    return 'core';
}
```

**Step 2: Tag words during interpolateWordTimings() in player.js**

In `interpolateWordTimings()` (player.js), modify the word timing construction loop (around line 276-294). After each word timing is pushed, add a `wordClass` and `weight` property.

First, detect parenthetical regions. Change the raw word processing (around line 239-248) to track parentheses state. Replace the word processing section:

```javascript
// Inside the for loop over lyrics lines, replace lines ~239-294
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

// ... (lineStart/lineEnd/lineDuration calculation stays the same) ...

// Compute syllable weights and word classifications
var inParen = false;
var wordClasses = [];
var syllables = words.map(function(w, wi) {
    var nw = normalizeWord(w);
    // Track parentheses — a word starting with '(' opens, ending with ')' closes
    if (w.indexOf('(') >= 0) inParen = true;
    wordClasses.push(classifyWord(nw, inParen));
    if (w.indexOf(')') >= 0) inParen = false;
    return estimateSyllables(nw);
});
// ... (totalSyllables calculation stays the same) ...

// Distribute time proportionally by syllable count
var wordTimings = [];
var cursor = lineStart;
for (var wi = 0; wi < words.length; wi++) {
    var wordDuration = (syllables[wi] / totalSyllables) * lineDuration;
    var estimatedTime = cursor;
    var wStart = tempoClass === 'slow'
        ? lineStart + params.windowStart
        : estimatedTime + params.windowStart;
    var timing = {
        word: normalizeWord(words[wi]),
        estimatedTime: estimatedTime,
        windowStart: wStart,
        windowEnd: estimatedTime + params.windowEnd,
        wordClass: wordClasses[wi],
        weight: WORD_WEIGHTS[wordClasses[wi]]
    };
    timing.phonetic = doubleMetaphone(normalizeWord(words[wi]));
    wordTimings.push(timing);
    cursor += wordDuration;
}
```

**Step 3: Export new symbols from match-helpers.js**

Add `FUNCTION_WORDS`, `ADLIB_WORDS`, `WORD_WEIGHTS`, and `classifyWord` to the Node.js exports block.

**Step 4: Commit**

```bash
git add static/match-helpers.js static/player.js
git commit -m "feat: add word classification (core/function/adlib) with weights in timing data"
```

---

### Task 4: Integrate scored matching into _collectMatches()

**Files:**
- Modify: `static/player.js:860-900` (_collectMatches method)

**Step 1: Change matchedSet from Set<number> to Map<number, number>**

The `matchedSet` currently stores word indices as a `Set`. Change it to a `Map<wordIndex, score>` so that partial credit is preserved through to scoring.

In `setActiveLine()` (line 807), change:
```javascript
this.matchedSet = new Map();  // was: new Set()
```

Also update `vadMatchedSet` similarly (line 808):
```javascript
this.vadMatchedSet = new Map();  // was: new Set()
```

**Step 2: Rewrite _collectMatches() to use wordsMatchScore()**

Replace the inner matching logic (lines 860-900):

```javascript
_collectMatches(transcript, resultMap) {
    if (this.lineWords.length === 0) return;
    var spoken = normalizeWords(transcript);
    var windowSize = getSpokenWindowSize((this.wordTimings && this.wordTimings.tempoClass) || 'normal');
    // Sliding window: cap spoken scan to lineWords.length * 3
    var maxWindow = this.lineWords.length * 3;
    var spokenIdx = Math.max(this.lineStartTranscriptPos, spoken.length - Math.min(windowSize, maxWindow));
    var now = audio.currentTime;
    var driftWindow = this.currentParams.driftTrack1;
    for (var li = 0; li < this.lineWords.length; li++) {
        if (li < this.wordTimings.length) {
            if (now < this.wordTimings[li].windowStart) continue;
        }
        var target = this.lineWords[li];
        var targetPhonetic = this.wordTimings[li] ? this.wordTimings[li].phonetic : undefined;
        for (var si = spokenIdx; si < Math.min(spokenIdx + driftWindow, spoken.length); si++) {
            if (FILLER_WORDS.has(spoken[si])) { spokenIdx = si + 1; si = spokenIdx - 1; continue; }

            // Try multi-word contraction first (consumes multiple spoken words)
            var consumed = multiWordContractionMatch(spoken, si, target);
            if (consumed > 0) {
                resultMap.set(li, 1.0);
                this._logMatch(spoken[si], target, 'contraction', 0, false, 1.0, true, si);
                spokenIdx = si + consumed;
                break;
            }

            // Try phrase match (consumes multiple target or spoken words)
            var pm = phraseMatch(spoken, si, this.lineWords, li);
            if (pm) {
                for (var pt = 0; pt < pm.targetConsumed; pt++) { resultMap.set(li + pt, 1.0); }
                this._logMatch(spoken[si], this.lineWords[li], 'phrase', 0, false, 1.0, true, si);
                spokenIdx = si + pm.spokenConsumed;
                li += pm.targetConsumed - 1;
                break;
            }

            // Scored single-word match
            var result = wordsMatchScore(spoken[si], target, targetPhonetic);
            if (result.score > 0) {
                // Only upgrade, never downgrade a previously matched word
                var prev = resultMap.get(li);
                if (prev === undefined || result.score > prev) {
                    resultMap.set(li, result.score);
                }
                this._logMatch(spoken[si], target, result.method,
                    result.method === 'edit1' ? 1 : result.method === 'edit2' ? 2 : 0,
                    result.method === 'phonetic', result.score, true, si);
                spokenIdx = si + 1;
                break;
            }

            // Log unmatched attempt
            this._logMatch(spoken[si], target, 'none', -1, false, 0.0, false, si);
        }
    }
}
```

**Step 3: Update _matchTranscript() to use Map**

At line 902-907, change `_matchTranscript`:
```javascript
_matchTranscript(transcript) {
    var unionMap = new Map();
    this._collectMatches(transcript, unionMap);
    this.matchedSet = unionMap;
    this._updateWordSpans();
}
```

**Step 4: Update all matchedSet.has() calls to work with Map**

`Map.has()` works the same as `Set.has()`, so most call sites work unchanged. But `matchedSet.size` and iteration patterns need checking.

Update `_updateWordSpans()` (line 909-928) — `this.matchedSet.has(wi)` works with Map, no change needed.

Update `_collectMatchesWhisper()` (line 726-728) — change Set.add to Map.set:
```javascript
whisperSet.forEach(function(score, i) {
    var existing = this.matchedSet.get(i);
    if (existing === undefined || score > existing) {
        this.matchedSet.set(i, score);
    }
    if (this.vadMatchedSet.has(i)) this.asrConfirmedSet.add(i);
}.bind(this));
```

But `whisperSet` is also still a Set in `_collectMatchesWhisper`. Change it to a Map too and update the Whisper matching loop to use `wordsMatchScore`:

```javascript
_collectMatchesWhisper(transcript) {
    if (this.lineWords.length === 0) return;
    const spoken = normalizeWords(transcript);
    const whisperMap = new Map();
    const windowSize = getSpokenWindowSize((this.wordTimings && this.wordTimings.tempoClass) || 'normal');
    var maxWindow = this.lineWords.length * 3;
    let spokenIdx = Math.max(0, spoken.length - Math.min(windowSize, maxWindow));
    var now = audio.currentTime;
    var driftWindow = this.currentParams.driftTrack2;
    for (let li = 0; li < this.lineWords.length; li++) {
        if (li < this.wordTimings.length) {
            if (now < this.wordTimings[li].windowStart) continue;
        }
        const target = this.lineWords[li];
        const targetPhonetic = this.wordTimings[li] ? this.wordTimings[li].phonetic : undefined;
        for (let si = spokenIdx; si < Math.min(spokenIdx + driftWindow, spoken.length); si++) {
            if (FILLER_WORDS.has(spoken[si])) { spokenIdx = si + 1; si = spokenIdx - 1; continue; }

            var consumed = multiWordContractionMatch(spoken, si, target);
            if (consumed > 0) {
                whisperMap.set(li, 1.0);
                spokenIdx = si + consumed;
                break;
            }
            var pm = phraseMatch(spoken, si, this.lineWords, li);
            if (pm) {
                for (var pt = 0; pt < pm.targetConsumed; pt++) { whisperMap.set(li + pt, 1.0); }
                spokenIdx = si + pm.spokenConsumed;
                li += pm.targetConsumed - 1;
                break;
            }
            var result = wordsMatchScore(spoken[si], target, targetPhonetic);
            if (result.score > 0) {
                whisperMap.set(li, result.score);
                spokenIdx = si + 1;
                break;
            }
        }
    }
    whisperMap.forEach(function(score, i) {
        var existing = this.matchedSet.get(i);
        if (existing === undefined || score > existing) {
            this.matchedSet.set(i, score);
        }
        if (this.vadMatchedSet.has(i)) this.asrConfirmedSet.add(i);
    }.bind(this));
    this._updateWordSpans();

    if (this.prevLine) {
        this._matchPrevLine(this.prevLine.whisperBuffer + ' ' + transcript, 'track2');
    }
}
```

**Step 5: Update _matchPrevLine() to use Map**

In `_matchPrevLine()` (lines 656-688), change `prev.matchedSet.add(li)` to `prev.matchedSet.set(li, 1.0)`:

```javascript
if (wordsMatch(spoken[si], target, targetPhonetic)) {
    prev.matchedSet.set(li, 1.0);
    // ... rest stays the same
}
```

**Step 6: Update _handleAsrResult and VAD matching**

Search for all remaining `.add(` calls on matchedSet and vadMatchedSet and convert them to `.set(idx, score)`. The VAD matching in the ASR handler (look for `vadMatchedSet.add`) should use `vadMatchedSet.set(li, 1.0)`.

**Step 7: Commit**

```bash
git add static/player.js
git commit -m "feat: integrate scored matching into _collectMatches and _collectMatchesWhisper

Changes matchedSet from Set<index> to Map<index, score> throughout.
Adds slang dictionary, phonetic (0.9), and edit-distance (0.75/0.5) fallbacks.
Adds sliding window truncation (lineWords.length * 3) to both tracks."
```

---

### Task 5: Implement weighted scoring in _scoreLine()

**Files:**
- Modify: `static/player.js:1039-1085` (_scoreLine and _updateRunningScore)

**Step 1: Change _scoreLine() to use weighted scoring**

Replace the simple count-based scoring with weighted scoring:

```javascript
_scoreLine(lineIdx, lineWords, matchedSet) {
    lineIdx    = (lineIdx    !== undefined) ? lineIdx    : this.activeLineIdx;
    lineWords  = (lineWords  !== undefined) ? lineWords  : this.lineWords;
    matchedSet = (matchedSet !== undefined) ? matchedSet : this.matchedSet;

    const total = lineWords.length;
    if (total === 0) return;

    // Compute weighted score
    var wordTimings = (lineIdx >= 0 && lineIdx < this.allWordTimings.length)
        ? this.allWordTimings[lineIdx] : [];
    var weightedTotal = 0;
    var weightedMatched = 0;
    for (var i = 0; i < lineWords.length; i++) {
        var weight = (wordTimings[i] && wordTimings[i].weight) || 1.0;
        weightedTotal += weight;
        var matchScore = matchedSet.get ? matchedSet.get(i) : (matchedSet.has(i) ? 1.0 : 0);
        if (matchScore > 0) {
            weightedMatched += weight * matchScore;
        }
    }

    // For display: count matched words (any score > 0)
    var matched = 0;
    for (var j = 0; j < lineWords.length; j++) {
        if (matchedSet.has(j)) matched++;
    }

    // Mark unmatched spans as red
    const lines = lyricsScroll.querySelectorAll('.lyric-line');
    const lineEl = lines[lineIdx];
    if (lineEl) {
        lineEl.querySelectorAll('.word-span').forEach((span, wi) => {
            if (!matchedSet.has(wi)) span.classList.add('missed');
        });

        // Flash per-line score
        const flash = document.createElement('div');
        flash.className = 'line-score-flash';
        flash.textContent = `+${matched}/${total}`;
        flash.style.top = lineEl.offsetTop + 'px';
        document.getElementById('lyrics-container').appendChild(flash);
        setTimeout(() => flash.remove(), 1300);
    }

    this.weightedTotal   += weightedTotal;
    this.weightedMatched += weightedMatched;
    this.totalWords      += total;
    this.matchedWords    += matched;
    this.linesScored++;

    if (matched === total) {
        this.perfectLines++;
        this.currentStreak++;
        if (this.currentStreak > this.bestStreak) this.bestStreak = this.currentStreak;
    } else {
        this.currentStreak = 0;
    }

    this._updateRunningScore();
}
```

**Step 2: Initialize weighted accumulators**

In the GameMode constructor (around lines 324-325), add:
```javascript
this.weightedTotal = 0;
this.weightedMatched = 0;
```

In the `start()` method (around lines 379-380), add resets:
```javascript
this.weightedTotal = 0;
this.weightedMatched = 0;
```

**Step 3: Update _updateRunningScore() to use weighted score**

```javascript
_updateRunningScore() {
    if (this.weightedTotal === 0) return;
    const pct = Math.round((this.weightedMatched / this.weightedTotal) * 100);
    document.getElementById('score-pct').textContent = pct + '%';
}
```

**Step 4: Update showEndModal() to use weighted score**

In `showEndModal()` (line 1405-1414):
```javascript
showEndModal() {
    if (!this.active || this.totalWords === 0) return;
    const pct = Math.round((this.weightedMatched / this.weightedTotal) * 100);
    document.getElementById('modalScore').textContent = pct + '%';
    document.getElementById('modalWords').textContent = `${this.matchedWords}/${this.totalWords}`;
    document.getElementById('modalLines').textContent = `${this.perfectLines}/${this.linesScored}`;
    document.getElementById('modalStreak').textContent = this.bestStreak;
    document.getElementById('lrc-offset-control').style.display = 'none';
    document.getElementById('gameModal').style.display = 'flex';
}
```

**Step 5: Commit**

```bash
git add static/player.js
git commit -m "feat: implement weighted scoring using word classification weights

Score formula changes from matchedWords/totalWords to weightedMatched/weightedTotal.
Core words=1.0, function words=0.5, ad-lib words=0.25."
```

---

### Task 6: ASR buffer line-transition reset

**Files:**
- Modify: `static/player.js:738-858` (setActiveLine method)

**Step 1: Add final match pass before resetting line state**

In `setActiveLine()`, just before the "Set up new line" section (line 802), add a final match pass against the outgoing line using the latest transcript. This ensures no words are lost at the boundary.

The current code at lines 790-800 already logs the transition. Insert the final match pass **before** the transition log, around line 789:

```javascript
// --- Final match pass on outgoing line before transition ---
if (this.lineWords.length > 0 && this.transcript) {
    var finalMap = new Map();
    this._collectMatches(this.transcript + ' ' + this.latestInterim, finalMap);
    // Merge any new matches into matchedSet
    finalMap.forEach(function(score, idx) {
        var existing = this.matchedSet.get(idx);
        if (existing === undefined || score > existing) {
            this.matchedSet.set(idx, score);
        }
    }.bind(this));
    this._updateWordSpans();
}
```

This runs one last `_collectMatches` before the line state is captured for scoring/transition logging.

**Step 2: Commit**

```bash
git add static/player.js
git commit -m "feat: add final match pass at line transitions to capture boundary words"
```

---

### Task 7: Telemetry improvements — remove cap, add smart filtering

**Files:**
- Modify: `static/player.js:1180-1203` (_logMatch method)

**Step 1: Remove the 5000 cap and add smart filtering**

Replace the cap logic with first-time-only logging:

```javascript
_logMatch(spokenWord, targetWord, method, editDist, phoneticMatch, score, matched, windowPosition) {
    if (!this._telemetry) return;
    if (!window._kDebug) return;

    // Smart filtering: only log first-time matches and misses for unmatched words.
    // Skip redundant re-checks for words already confirmed matched.
    if (matched && this._telemetryLoggedMatches && this._telemetryLoggedMatches.has(this.activeLineIdx + ':' + targetWord)) {
        return;  // Already logged a match for this word on this line
    }

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
            editDistance:   editDist,
            phoneticMatch: phoneticMatch,
            score:         score,
            matched:       matched,
            windowPosition: windowPosition
        });

        // Track logged matches to avoid duplicates
        if (matched) {
            if (!this._telemetryLoggedMatches) this._telemetryLoggedMatches = new Set();
            this._telemetryLoggedMatches.add(this.activeLineIdx + ':' + targetWord);
        }
    } catch (e) { /* telemetry must never crash the game */ }
}
```

**Step 2: Reset the logged-matches tracker on line transitions**

In `setActiveLine()`, after the new line setup (around line 810), add:
```javascript
this._telemetryLoggedMatches = new Set();
```

**Step 3: Update _logTransition to include weighted scores**

In `_logTransition()` (lines 1216-1258), add weighted score data to the transition event. After line 1248 (`matchedWords: matchedWords`), add:

```javascript
weightedMatched: this._computeLineWeightedMatched(fromIdx, matchedWords),
weightedTotal:   this._computeLineWeightedTotal(fromIdx),
```

And add these two helper methods to GameMode:

```javascript
_computeLineWeightedTotal(lineIdx) {
    var timings = (lineIdx >= 0 && lineIdx < this.allWordTimings.length)
        ? this.allWordTimings[lineIdx] : [];
    var total = 0;
    for (var i = 0; i < timings.length; i++) {
        total += (timings[i].weight || 1.0);
    }
    return parseFloat(total.toFixed(2));
}

_computeLineWeightedMatched(lineIdx) {
    var timings = (lineIdx >= 0 && lineIdx < this.allWordTimings.length)
        ? this.allWordTimings[lineIdx] : [];
    var matched = 0;
    for (var i = 0; i < timings.length; i++) {
        var score = this.matchedSet.get ? this.matchedSet.get(i) : (this.matchedSet.has(i) ? 1.0 : 0);
        if (score > 0) matched += (timings[i].weight || 1.0) * score;
    }
    return parseFloat(matched.toFixed(2));
}
```

**Step 4: Commit**

```bash
git add static/player.js
git commit -m "feat: remove 5000 telemetry cap, add smart dedup filtering, log weighted scores"
```

---

### Task 8: Update _lateScoreLine to work with Map-based matchedSet

**Files:**
- Modify: `static/player.js:1093-1140` (_lateScoreLine method)

**Step 1: Read the full _lateScoreLine method and update it**

The `_lateScoreLine` method runs 500ms after line advance to catch late ASR finals. It currently uses `matchedSet` as a Set. Update it to work with Map and use `wordsMatchScore`:

Where it currently does `matchedSet.add(li)`, change to `matchedSet.set(li, result.score)` using `wordsMatchScore`.

Where it computes `var newlyMatched = matchedSet.size - originalSize`, change to account for the Map and weighted scores.

**Step 2: Commit**

```bash
git add static/player.js
git commit -m "fix: update _lateScoreLine to work with Map-based matchedSet and scored matching"
```

---

### Task 9: Smoke test and verify

**Step 1: Start the Flask server and load a song**

```bash
cd C:/GPT5-Projects/Karaokee
python app.py
```

**Step 2: Open browser console and verify**

Check for JS errors on page load. Verify:
- `wordsMatchScore('gonna', 'going')` returns `{ score: 0.9, method: 'slang' }` or similar
- `slangMatch('nigga', 'ninja')` returns `true`
- `classifyWord('the', false)` returns `'function'`
- `classifyWord('ooh', true)` returns `'adlib'`
- `WORD_WEIGHTS` is accessible

**Step 3: Play a song and verify scoring works**

- Start a song in game mode
- Verify word highlighting still works (green for matched, red for missed)
- Verify score percentage displays correctly
- Verify telemetry downloads without the 5000 cap truncation
- Check that the line-score flash still shows `+N/M`

**Step 4: Compare scores**

Play the same song that was in the telemetry. The new weighted scoring should produce a higher percentage than before (since function words and ad-libs penalize less).

**Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: address smoke test findings"
```
