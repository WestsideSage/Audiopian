# Consolidated Plan Record

This file merges the original design and implementation documents for this feature.

## Design

# Karaokee Algorithm Improvements Design

**Date:** 2026-03-17
**Goal:** Incremental improvements across lyric detection accuracy, real-time speech analysis, and matching performance â€” without regressing the current responsiveness feel.

**Core problems:**
- Contractions/slang in lyrics (e.g., "gonna") frequently missed because ASR normalizes to full form ("going to") and matching only works one direction
- Latency across all line positions at high tempo â€” first words, mid-line, line boundaries
- Missed matches on longer words where a single character difference exceeds the hard edit-distance cap of 1

## 1. Bidirectional Contraction Matching

### Problem
`CONTRACTION_MAP` maps contractions to full forms (gonna â†’ going to) but:
- `expandContractions()` is defined but **never called** in the matching pipeline
- No reverse lookup exists â€” if lyrics say "gonna" and ASR returns "going to", no match
- Multi-word expansions (2 spoken words vs 1 lyric word) aren't handled

### Solution
A three-layer contraction matching system:

**Reverse contraction map** â€” auto-generated at load time. For every `{gonna: "going to"}`, create `{"going to": "gonna"}`. O(1) lookup in both directions.

**Multi-word target collapsing** â€” when building `lineWords`, scan for adjacent words that form a known expansion (e.g., lyrics "going" + "to" â†’ could match "gonna"). Store as phrase groups alongside individual words.

**ASR expansion matching** â€” when ASR returns "going to" but the lyric word is "gonna", check if the spoken multi-word sequence maps to the target contraction via the reverse map. Consume multiple spoken words for one lyric word match.

**Integration point:** inject contraction awareness into `wordsMatch()` and `_collectMatches()` rather than pre-expanding, keeping the hot path efficient.

## 2. N-gram Phrase Matching

### Problem
Word-by-word sequential matching fails when:
- ASR regroups word boundaries ("alright" vs "all right")
- Phrases get misheard as similar-sounding phrases ("let it go" â†’ "letter go")
- Filler words inserted by ASR ("I am gonna") consume drift window slots

### Solution

**Equivalent phrase map** â€” static lookup of word-boundary variants:
- `"alright" â†” "all right"`, `"everyday" â†” "every day"`, `"cannot" â†” "can not"`, `"into" â†” "in to"`, `"onto" â†” "on to"`, etc.
- Distinct from contractions â€” these are word-boundary ambiguities, not slang.

**Sliding 2-3 word phrase check** â€” during `_collectMatches()`, when a single word doesn't match, try concatenating the next 2-3 spoken words and comparing against the target (and vice versa). Example:
- Spoken `["all", "right"]` â†’ concat `"allright"` â†’ matches target `"alright"`
- Spoken `["letter"]` â†’ phonetic match against target phrase `"let her"`

**Filler word skipping** â€” small set of filler words ASR commonly inserts (`"uh"`, `"um"`, `"like"`, `"you know"`) that can be skipped without consuming drift window slots.

**Scoring:** phrase matches still count individual lyric words as matched. Spoken "alright" matching lyrics "all" + "right" lights both green.

## 3. Whisper Prompt Hinting & Word-Level Timestamps

### Problem
- Whisper transcribes without context â€” normalizes casual speech and picks generic homophones
- Word timing uses syllable-count interpolation, which misestimates and cascades into wrong time windows

### Solution

**Prompt hinting** â€” pass the current lyric line text as Whisper's `initial_prompt`:
```python
model.transcribe(audio_buf, language='en', beam_size=1,
                 initial_prompt=hint_text)
```
- Client sends current line text alongside WAV chunk
- Whisper biases toward expected vocabulary (returns "gonna" when lyrics say "gonna")
- Single highest-impact change for contraction/slang accuracy

**Word-level timestamps** â€” enable `word_timestamps=True` in faster-whisper:
```python
segments, _ = model.transcribe(audio_buf, language='en', beam_size=1,
                               word_timestamps=True)
```
- Returns per-word start/end times within each chunk
- Client uses these to validate/correct interpolated timing estimates
- Not a replacement for syllable interpolation (needed before audio plays), but a real-time correction layer
- Enables future "timing accuracy" scoring dimension

**API changes:**
- Request: adds `hint` field alongside WAV body
- Response: `{transcript, words: [{text, start, end}, ...]}`

## 4. Sliding Window ASR Buffer & Adaptive Edit Distance

### Problem
- Full transcript scan from `lineStartTranscriptPos` grows rapidly on fast songs â€” stale words accidentally fuzzy-match future lyrics
- Edit distance hard-capped at 1 regardless of word length â€” "everybody" misheard as "every body" (2 edits) fails, while "a" â†’ "I" (1 edit) passes

### Solution

**Rolling spoken window** â€” scan only the most recent N spoken words (scaled by tempo):
- Slow: last 20 words
- Normal: last 15 words
- Fast: last 12 words
- Existing drift windows (`driftTrack1`/`driftTrack2`) operate within this tighter buffer

**Syllable-scaled edit distance:**
- Words 1-3 chars: edit distance â‰¤ 1
- Words 4-6 chars: edit distance â‰¤ 1
- Words 7-9 chars: edit distance â‰¤ 2
- Words 10+ chars: edit distance â‰¤ 3
- Catches longer misheard words without loosening short-word matching

**Minimum word length gate** â€” skip edit distance matching entirely for words â‰¤ 2 characters. Short words ("I", "a", "to") generate too many false positives via fuzzy match. Require exact or phonetic match only.

## 5. Pre-computed Phonetic Index

### Problem
Every `wordsMatch()` call computes Double Metaphone on both spoken and target words. Target words never change but are recomputed hundreds of times per second during fast sections.

### Solution

**Phonetic index at song load** â€” when `interpolateWordTimings()` runs, cache Double Metaphone codes for every lyric word:
```
phoneticIndex[lineIdx][wordIdx] = { primary: "KN", secondary: "N" }
```
One-time O(total words) cost at song load, stored alongside `allWordTimings`.

**Modified `wordsMatch()`** â€” accepts pre-computed target codes instead of calling `doubleMetaphone(target)` every time. Halves phonetic computation on the hot path.

**Spoken word LRU cache** â€” small Map (cap ~50 entries) caching `spokenWord â†’ [primary, secondary]`. ASR repeats recent words in interim results, so this eliminates redundant computation. Evict oldest entries when full.

Pure performance optimization â€” no behavior change.

## 6. Smoother Adaptive Whisper Chunking

### Problem
Chunk size changes abruptly at line boundaries (2s â†’ 0.75s â†’ 2s). First chunk of a fast section contains stale slow-section audio. Transition back to slow creates a transcription gap.

### Solution

**Flush-on-transition** â€” when chunk size changes, immediately flush accumulated AudioWorklet buffer as a partial chunk:
- New message: `{type: 'flush'}` to AudioWorklet
- Emits current buffer if > 1600 samples (100ms minimum)
- Resets accumulator for fresh start at new chunk size

**Overlapping chunks for fast sections** â€” 50% overlap during `fast` tempo:
- Instead of [0-0.75s], [0.75-1.5s]: use [0-0.75s], [0.375-1.125s], [0.75-1.5s]
- AudioWorklet maintains secondary ring buffer offset by half chunk size
- New transcription arrives every ~0.375s instead of ~0.75s
- Only active for `fast` tempo class to avoid unnecessary GPU load

**Backend rate limiting** â€” in-flight counter prevents request queuing:
- If 2+ requests already in-flight, skip the overlapping chunk
- Non-overlapping chunks always go through

## Summary

| # | Change | Primary Benefit | Risk |
|---|--------|----------------|------|
| 1 | Bidirectional contraction matching | Fix gonna/going-to mismatches | Low â€” additive logic |
| 2 | N-gram phrase matching + filler skip | Handle word boundary ambiguities | Low â€” fallback layer |
| 3 | Whisper prompt hinting + word timestamps | Better ASR accuracy & real timing | Low â€” single param changes |
| 4 | Sliding window + adaptive edit distance | Fewer false matches, catch long-word typos | Medium â€” changes matching behavior |
| 5 | Pre-computed phonetic index | Less CPU during fast sections | Low â€” pure optimization |
| 6 | Smoother adaptive Whisper chunking | Faster transcription on tempo transitions | Medium â€” AudioWorklet changes |

---

## Implementation

# Algorithm Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Improve lyric detection accuracy, real-time speech matching, and performance across all tempo ranges â€” especially for contraction/slang-heavy songs and high-WPS sections.

**Architecture:** Six independent improvement layers that each touch isolated parts of the matching pipeline. Tasks 1-2 add new matching logic in a new `static/match-helpers.js` file. Task 3 modifies the Flask backend and client fetch. Tasks 4-5 modify existing matching functions in `static/player.js`. Task 6 modifies `static/audio-processor.js` and the client chunk sender.

**Tech Stack:** Vanilla JavaScript (browser), Python/Flask backend, faster-whisper, AudioWorklet API

**Testing patterns:**
- JS tests: `.cjs` files in `tests/` using `node:assert`. Scripts are loaded via `new Function('module', 'exports', code)` to simulate browser `<script>` loading. Run with `node tests/test_<name>.cjs`.
- Python tests: `pytest` with Flask test client. Run with `pytest tests/test_app.py -v`.
- The project has `"type": "module"` in package.json, so test files MUST use `.cjs` extension.

---

## Task 1: Bidirectional Contraction Matching

**Files:**
- Create: `static/match-helpers.js`
- Create: `tests/test_match_helpers.cjs`
- Modify: `static/player.js` (lines 14-72: CONTRACTION_MAP, lines 262-272: expandContractions, lines 215-222: wordsMatch, lines 871-890: _collectMatches)
- Modify: `static/player.html` (add `<script>` tag for match-helpers.js)

### Step 1: Write failing tests for reverse contraction map

Create `tests/test_match_helpers.cjs`:

```javascript
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

var filePath = path.join(__dirname, '..', 'static', 'match-helpers.js');
var code = fs.readFileSync(filePath, 'utf8');
var fakeModule = { exports: {} };
var fn = new Function('module', 'exports', code);
fn(fakeModule, fakeModule.exports);

var REVERSE_CONTRACTION_MAP = fakeModule.exports.REVERSE_CONTRACTION_MAP;
var contractionsMatch = fakeModule.exports.contractionsMatch;
var multiWordContractionMatch = fakeModule.exports.multiWordContractionMatch;

// --- REVERSE_CONTRACTION_MAP ---
// "going to" should reverse-map to "gonna"
assert.strictEqual(REVERSE_CONTRACTION_MAP['going to'], 'gonna');
assert.strictEqual(REVERSE_CONTRACTION_MAP['want to'], 'wanna');
assert.strictEqual(REVERSE_CONTRACTION_MAP['got to'], 'gotta');
assert.strictEqual(REVERSE_CONTRACTION_MAP['kind of'], 'kinda');
assert.strictEqual(REVERSE_CONTRACTION_MAP['about to'], 'bouta');

// --- contractionsMatch: spoken contraction vs full-form target ---
// Lyric says "going", ASR says "gonna" â€” should match via contraction expansion
assert.strictEqual(contractionsMatch('gonna', 'going'), true,
    'contraction "gonna" should match first word of expansion "going to"');
assert.strictEqual(contractionsMatch('hello', 'going'), false,
    'unrelated word should not match');

// --- contractionsMatch: spoken full-form vs contraction target ---
// Lyric says "gonna", ASR says "going" â€” need reverse lookup
assert.strictEqual(contractionsMatch('going', 'gonna'), false,
    'single word "going" does not match "gonna" (need multi-word "going to")');

// --- multiWordContractionMatch ---
// ASR returns ["going", "to"] and target is "gonna"
// Returns number of spoken words consumed (2) or 0 if no match
assert.strictEqual(multiWordContractionMatch(['going', 'to', 'the'], 0, 'gonna'), 2,
    '"going to" at index 0 should match "gonna", consuming 2 words');
assert.strictEqual(multiWordContractionMatch(['going', 'to', 'the'], 0, 'hello'), 0,
    '"going to" should not match unrelated target');
assert.strictEqual(multiWordContractionMatch(['i', 'am', 'going', 'to'], 2, 'gonna'), 2,
    '"going to" at index 2 should match "gonna"');

// Edge: spoken array too short
assert.strictEqual(multiWordContractionMatch(['going'], 0, 'gonna'), 0,
    'not enough spoken words to form "going to"');

// 3-word expansion: "i am going to" â†’ "ima"
assert.strictEqual(multiWordContractionMatch(['i', 'am', 'going', 'to'], 0, 'ima'), 4,
    '"i am going to" should match "ima", consuming 4 words');

// "do not know" â†’ "dunno"
assert.strictEqual(multiWordContractionMatch(['do', 'not', 'know', 'why'], 0, 'dunno'), 3,
    '"do not know" should match "dunno", consuming 3 words');

console.log('All contraction matching tests passed.');
```

### Step 2: Run tests to verify they fail

Run: `node tests/test_match_helpers.cjs`
Expected: FAIL â€” `Cannot find module` or `ENOENT` because `static/match-helpers.js` doesn't exist yet.

### Step 3: Implement match-helpers.js

Create `static/match-helpers.js`. This file must include the existing `CONTRACTION_MAP` (which will be moved here from player.js) plus new reverse/multi-word logic:

```javascript
/**
 * Match-helpers: contraction matching, phrase matching, and filler skipping.
 * Loaded before player.js via <script> tag.
 */

// --- Contraction Map (moved from player.js) ---
var CONTRACTION_MAP = {
    'gonna':   'going to',
    'wanna':   'want to',
    'gotta':   'got to',
    'kinda':   'kind of',
    'sorta':   'sort of',
    'coulda':  'could have',
    'shoulda': 'should have',
    'woulda':  'would have',
    'ima':     'i am going to',
    'tryna':   'trying to',
    'dunno':   'do not know',
    "ain't":   'is not',
    'ain':     'is not',
    "y'all":   'you all',
    'yall':    'you all',
    'finna':   'fixing to',
    'bouta':   'about to',
    'outta':   'out of',
    'lotta':   'lot of',
    'cmon':    'come on',
    'nah':     'no',
    'bruh':    'brother',
    'bro':     'brother',
    'fam':     'family',
    'fasho':   'for sure',
    'fosho':   'for sure',
    'sho':     'sure',
    'deadass': 'seriously',
    'lowkey':  'low key',
    'highkey': 'high key',
    'ong':     'on god',
    'fr':      'for real',
    'ngl':     'not gonna lie',
    'rn':      'right now',
    'smh':     'shaking my head',
    'aight':   'alright',
    'ight':    'alright',
    'prolly':  'probably',
    'sumn':    'something',
    'sumthin': 'something',
    'nothin':  'nothing',
    'nuthin':  'nothing',
    'cuz':     'because',
    'cus':     'because',
    'wit':     'with',
    'da':      'the',
    'dem':     'them',
    'dey':     'they',
    'dat':     'that',
    'dis':     'this',
    'em':      'them',
    'til':     'until',
    'bout':    'about',
    'ops':     'opposition',
    'lil':     'little',
};

// --- Reverse Contraction Map (auto-generated) ---
var REVERSE_CONTRACTION_MAP = {};
(function() {
    var seen = {};
    for (var contraction in CONTRACTION_MAP) {
        var expansion = CONTRACTION_MAP[contraction];
        if (!seen[expansion]) {
            REVERSE_CONTRACTION_MAP[expansion] = contraction;
            seen[expansion] = true;
        }
    }
})();

// Pre-split expansions for multi-word matching lookups
var _expansionIndex = {};
(function() {
    for (var contraction in CONTRACTION_MAP) {
        var words = CONTRACTION_MAP[contraction].split(' ');
        if (words.length >= 2) {
            if (!_expansionIndex[words[0]]) _expansionIndex[words[0]] = [];
            _expansionIndex[words[0]].push({ words: words, contraction: contraction });
        }
    }
    for (var key in _expansionIndex) {
        _expansionIndex[key].sort(function(a, b) { return b.words.length - a.words.length; });
    }
})();

/**
 * Check if a spoken word matches a target word via contraction expansion.
 * Handles the case where spoken="gonna" and target="going" (first word of expansion).
 */
function contractionsMatch(spoken, target) {
    var expansion = CONTRACTION_MAP[spoken];
    if (expansion) {
        var expWords = expansion.split(' ');
        if (expWords[0] === target) return true;
    }
    return false;
}

/**
 * Try to match a multi-word spoken sequence against a single target contraction.
 * Returns number of spoken words consumed (0 = no match).
 */
function multiWordContractionMatch(spokenWords, startIdx, target) {
    var firstWord = spokenWords[startIdx];
    var candidates = _expansionIndex[firstWord];
    if (!candidates) return 0;

    for (var c = 0; c < candidates.length; c++) {
        var entry = candidates[c];
        if (entry.contraction !== target) continue;
        if (startIdx + entry.words.length > spokenWords.length) continue;
        var match = true;
        for (var w = 0; w < entry.words.length; w++) {
            if (spokenWords[startIdx + w] !== entry.words[w]) { match = false; break; }
        }
        if (match) return entry.words.length;
    }
    return 0;
}

// Node.js exports for testing; browser ignores this
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        CONTRACTION_MAP: CONTRACTION_MAP,
        REVERSE_CONTRACTION_MAP: REVERSE_CONTRACTION_MAP,
        contractionsMatch: contractionsMatch,
        multiWordContractionMatch: multiWordContractionMatch,
    };
}
```

### Step 4: Run tests to verify they pass

Run: `node tests/test_match_helpers.cjs`
Expected: All assertions pass, "All contraction matching tests passed."

### Step 5: Integrate into player.js

Modify `static/player.js`:

1. **Remove `CONTRACTION_MAP` and `expandContractions`** (lines 14-72 and 262-272) since they now live in `match-helpers.js`.

2. **Update `wordsMatch()`** (line 215) to add contraction check as a 4th matching tier:

```javascript
function wordsMatch(spoken, target) {
    if (spoken === target) return true;
    const [sp, ss] = doubleMetaphone(spoken);
    const [tp, ts] = doubleMetaphone(target);
    if (sp && tp && (sp === tp || sp === ts || (ss && (ss === tp || ss === ts)))) return true;
    if (Math.abs(spoken.length - target.length) <= 1 && editDistance(spoken, target) <= 1) return true;
    if (contractionsMatch(spoken, target)) return true;
    return false;
}
```

3. **Update `_collectMatches()`** to handle multi-word spoken â†’ single target:
   After the `wordsMatch(spoken[si], target)` check fails, try `multiWordContractionMatch(spoken, si, target)`. If it returns N > 0, mark the target matched and advance `spokenIdx` by N.

4. **Update `_collectMatchesWhisper()`** with the same multi-word logic.

5. **Add `<script src="/static/match-helpers.js"></script>`** to `static/player.html` BEFORE the player.js script tag.

### Step 6: Run existing tests to verify no regression

Run: `node tests/test_sync_helpers.cjs && pytest tests/ -v`
Expected: All existing tests still pass.

### Step 7: Commit

```
git add static/match-helpers.js tests/test_match_helpers.cjs static/player.js static/player.html
git commit -m "feat: add bidirectional contraction matching for lyric detection"
```

---

## Task 2: N-gram Phrase Matching & Filler Skipping

**Files:**
- Modify: `static/match-helpers.js` (add phrase map, filler set, and matching functions)
- Modify: `tests/test_match_helpers.cjs` (add phrase matching tests)
- Modify: `static/player.js` (`_collectMatches` and `_collectMatchesWhisper` to use phrase matching)

### Step 1: Write failing tests for phrase matching

Append to `tests/test_match_helpers.cjs`:

```javascript
var PHRASE_EQUIV_MAP = fakeModule.exports.PHRASE_EQUIV_MAP;
var phraseMatch = fakeModule.exports.phraseMatch;
var FILLER_WORDS = fakeModule.exports.FILLER_WORDS;

// --- PHRASE_EQUIV_MAP ---
assert.strictEqual(PHRASE_EQUIV_MAP['all right'], 'alright');
assert.strictEqual(PHRASE_EQUIV_MAP['alright'], 'all right');
assert.strictEqual(PHRASE_EQUIV_MAP['every day'], 'everyday');
assert.strictEqual(PHRASE_EQUIV_MAP['everyday'], 'every day');

// --- phraseMatch: spoken multi-word matches single target ---
var r1 = phraseMatch(['all', 'right', 'now'], 0, ['alright', 'now'], 0);
assert.deepStrictEqual(r1, { spokenConsumed: 2, targetConsumed: 1 },
    '"all right" should match "alright"');

// --- phraseMatch: spoken single matches multi-word target ---
var r2 = phraseMatch(['alright', 'now'], 0, ['all', 'right', 'now'], 0);
assert.deepStrictEqual(r2, { spokenConsumed: 1, targetConsumed: 2 },
    '"alright" should match "all right"');

// --- phraseMatch: no match ---
var r3 = phraseMatch(['hello'], 0, ['world'], 0);
assert.strictEqual(r3, null, 'unrelated words should return null');

// --- phraseMatch: "cannot" vs "can not" ---
var r4 = phraseMatch(['cannot'], 0, ['can', 'not'], 0);
assert.deepStrictEqual(r4, { spokenConsumed: 1, targetConsumed: 2 });

// --- FILLER_WORDS ---
assert.strictEqual(FILLER_WORDS.has('uh'), true);
assert.strictEqual(FILLER_WORDS.has('um'), true);
assert.strictEqual(FILLER_WORDS.has('hello'), false);

console.log('All phrase matching tests passed.');
```

### Step 2: Run tests to verify they fail

Run: `node tests/test_match_helpers.cjs`
Expected: FAIL â€” `PHRASE_EQUIV_MAP` is undefined.

### Step 3: Implement phrase matching in match-helpers.js

Add to `static/match-helpers.js` before the `module.exports` block:

```javascript
// --- Equivalent Phrase Map ---
var _PHRASE_PAIRS = [
    ['alright', 'all right'],
    ['altogether', 'all together'],
    ['everyday', 'every day'],
    ['everyone', 'every one'],
    ['everything', 'every thing'],
    ['cannot', 'can not'],
    ['into', 'in to'],
    ['onto', 'on to'],
    ['anymore', 'any more'],
    ['anyone', 'any one'],
    ['anyway', 'any way'],
    ['outside', 'out side'],
    ['tonight', 'to night'],
    ['without', 'with out'],
    ['maybe', 'may be'],
    ['goodbye', 'good bye'],
    ['throughout', 'through out'],
    ['wherever', 'where ever'],
    ['whatever', 'what ever'],
    ['whenever', 'when ever'],
];

var PHRASE_EQUIV_MAP = {};
(function() {
    for (var i = 0; i < _PHRASE_PAIRS.length; i++) {
        PHRASE_EQUIV_MAP[_PHRASE_PAIRS[i][0]] = _PHRASE_PAIRS[i][1];
        PHRASE_EQUIV_MAP[_PHRASE_PAIRS[i][1]] = _PHRASE_PAIRS[i][0];
    }
})();

var _phraseIndex = {};
(function() {
    for (var key in PHRASE_EQUIV_MAP) {
        var words = key.split(' ');
        if (words.length >= 2) {
            if (!_phraseIndex[words[0]]) _phraseIndex[words[0]] = [];
            _phraseIndex[words[0]].push({ words: words, equiv: PHRASE_EQUIV_MAP[key] });
        }
    }
    for (var k in _phraseIndex) {
        _phraseIndex[k].sort(function(a, b) { return b.words.length - a.words.length; });
    }
})();

function phraseMatch(spokenWords, spokenIdx, targetWords, targetIdx) {
    var spokenWord = spokenWords[spokenIdx];
    var targetWord = targetWords[targetIdx];

    // Direction 1: multiple spoken words â†’ single target word
    var spokenCandidates = _phraseIndex[spokenWord];
    if (spokenCandidates) {
        for (var i = 0; i < spokenCandidates.length; i++) {
            var entry = spokenCandidates[i];
            if (spokenIdx + entry.words.length > spokenWords.length) continue;
            var match = true;
            for (var w = 0; w < entry.words.length; w++) {
                if (spokenWords[spokenIdx + w] !== entry.words[w]) { match = false; break; }
            }
            if (match && entry.equiv === targetWord) {
                return { spokenConsumed: entry.words.length, targetConsumed: 1 };
            }
        }
    }

    // Direction 2: single spoken word â†’ multiple target words
    var equivOfSpoken = PHRASE_EQUIV_MAP[spokenWord];
    if (equivOfSpoken) {
        var equivWords = equivOfSpoken.split(' ');
        if (equivWords.length >= 2 && targetIdx + equivWords.length <= targetWords.length) {
            var match = true;
            for (var w = 0; w < equivWords.length; w++) {
                if (targetWords[targetIdx + w] !== equivWords[w]) { match = false; break; }
            }
            if (match) {
                return { spokenConsumed: 1, targetConsumed: equivWords.length };
            }
        }
    }

    return null;
}

var FILLER_WORDS = new Set(['uh', 'um', 'ah', 'er', 'hm', 'hmm', 'mhm', 'ugh']);
```

Update the `module.exports` block to include the new exports.

### Step 4: Run tests to verify they pass

Run: `node tests/test_match_helpers.cjs`
Expected: All assertions pass.

### Step 5: Integrate into _collectMatches in player.js

In `_collectMatches()` and `_collectMatchesWhisper()`, after the `wordsMatch` check:

1. **Filler word skip**: if `spoken[si]` is in `FILLER_WORDS`, skip it without consuming a drift slot.
2. **Phrase match fallback**: if `wordsMatch` fails, try `phraseMatch(spoken, si, this.lineWords, li)`. If it returns a result, mark `targetConsumed` target words as matched and advance `spokenIdx` by `spokenConsumed`.

### Step 6: Run all tests

Run: `node tests/test_match_helpers.cjs && node tests/test_sync_helpers.cjs && pytest tests/ -v`
Expected: All pass.

### Step 7: Commit

```
git add static/match-helpers.js tests/test_match_helpers.cjs static/player.js
git commit -m "feat: add n-gram phrase matching and filler word skipping"
```

---

## Task 3: Whisper Prompt Hinting & Word-Level Timestamps

**Files:**
- Modify: `app.py` (lines 144-158: `/transcribe` endpoint)
- Modify: `tests/test_app.py` (add tests for hint and word timestamps)
- Modify: `static/player.js` (lines 662-677: `_sendChunkToWhisper`)

### Step 1: Write failing tests for prompt hinting

Add to `tests/test_app.py`:

```python
def test_transcribe_with_hint(client):
    """When hint is provided via header, it should be passed as initial_prompt."""
    mock_model = MagicMock()
    mock_segment = MagicMock()
    mock_segment.text = 'gonna be alright'
    mock_segment.words = []
    mock_model.transcribe.return_value = ([mock_segment], None)

    with patch('app.get_whisper_model', return_value=mock_model):
        resp = client.post('/transcribe', data=_make_wav(),
                           content_type='audio/wav',
                           headers={'X-Lyric-Hint': 'gonna be alright'})

    assert resp.status_code == 200
    call_kwargs = mock_model.transcribe.call_args
    assert call_kwargs[1].get('initial_prompt') == 'gonna be alright'


def test_transcribe_without_hint(client):
    """Without hint header, initial_prompt should not be passed."""
    mock_model = MagicMock()
    mock_segment = MagicMock()
    mock_segment.text = 'going to be all right'
    mock_segment.words = []
    mock_model.transcribe.return_value = ([mock_segment], None)

    with patch('app.get_whisper_model', return_value=mock_model):
        resp = client.post('/transcribe', data=_make_wav(),
                           content_type='audio/wav')

    assert resp.status_code == 200
    call_kwargs = mock_model.transcribe.call_args
    assert 'initial_prompt' not in call_kwargs[1] or call_kwargs[1]['initial_prompt'] is None


def test_transcribe_returns_word_timestamps(client):
    """Response should include words array with text, start, end."""
    mock_model = MagicMock()
    mock_segment = MagicMock()
    mock_segment.text = 'hello world'
    mock_word1 = MagicMock()
    mock_word1.word = 'hello'
    mock_word1.start = 0.0
    mock_word1.end = 0.5
    mock_word2 = MagicMock()
    mock_word2.word = 'world'
    mock_word2.start = 0.5
    mock_word2.end = 1.0
    mock_segment.words = [mock_word1, mock_word2]
    mock_model.transcribe.return_value = ([mock_segment], None)

    with patch('app.get_whisper_model', return_value=mock_model):
        resp = client.post('/transcribe', data=_make_wav(),
                           content_type='audio/wav')

    assert resp.status_code == 200
    data = json.loads(resp.data)
    assert 'words' in data
    assert len(data['words']) == 2
    assert data['words'][0] == {'text': 'hello', 'start': 0.0, 'end': 0.5}
    assert data['words'][1] == {'text': 'world', 'start': 0.5, 'end': 1.0}
```

### Step 2: Run tests to verify they fail

Run: `pytest tests/test_app.py -v -k "hint or timestamp"`
Expected: FAIL.

### Step 3: Update /transcribe endpoint in app.py

Replace the `/transcribe` route (lines 144-158):

```python
@app.route('/transcribe', methods=['POST'])
def transcribe():
    """Accept a raw WAV body, transcribe with Whisper, return {transcript, words}."""
    wav_bytes = request.data
    if len(wav_bytes) < 100:
        return jsonify(transcript='', words=[])
    try:
        model = get_whisper_model()
        audio_buf = io.BytesIO(wav_bytes)

        hint = request.headers.get('X-Lyric-Hint')

        kwargs = dict(language='en', beam_size=1, word_timestamps=True)
        if hint:
            kwargs['initial_prompt'] = hint

        segments, _ = model.transcribe(audio_buf, **kwargs)
        segments = list(segments)

        text = ' '.join(s.text for s in segments).strip()

        words = []
        for seg in segments:
            if seg.words:
                for w in seg.words:
                    words.append({
                        'text': w.word.strip(),
                        'start': round(w.start, 3),
                        'end': round(w.end, 3),
                    })

        return jsonify(transcript=text, words=words)
    except Exception:
        return jsonify(transcript='', words=[]), 503
```

### Step 4: Run tests to verify they pass

Run: `pytest tests/test_app.py -v`
Expected: All tests pass.

### Step 5: Update client to send hint and receive word timestamps

In `static/player.js`, modify `_sendChunkToWhisper()`:

```javascript
async _sendChunkToWhisper(float32) {
    const wav = encodeWav(float32, 16000);
    try {
        var headers = { 'Content-Type': 'audio/wav' };
        if (this.activeLineIdx >= 0 && lyrics[this.activeLineIdx]) {
            headers['X-Lyric-Hint'] = lyrics[this.activeLineIdx].text;
        }
        const resp = await fetch('/transcribe', {
            method: 'POST',
            body: wav,
            headers: headers
        });
        if (!resp.ok) return;
        const data = await resp.json();
        if (data.transcript && this.active) {
            this.whisperBuffer = (this.whisperBuffer + ' ' + data.transcript).trim();
            this._collectMatchesWhisper(this.whisperBuffer);
        }
        if (data.words && data.words.length > 0 && this.active) {
            this._lastWhisperWords = data.words;
        }
    } catch (_) { /* fire-and-forget */ }
}
```

### Step 6: Run all tests

Run: `pytest tests/ -v && node tests/test_sync_helpers.cjs && node tests/test_match_helpers.cjs`
Expected: All pass.

### Step 7: Commit

```
git add app.py tests/test_app.py static/player.js
git commit -m "feat: add Whisper prompt hinting and word-level timestamps"
```

---

## Task 4: Adaptive Edit Distance & Minimum Word Length Gate

**Files:**
- Modify: `static/match-helpers.js` (add `maxEditDistance()` and `skipFuzzyMatch()`)
- Modify: `tests/test_match_helpers.cjs` (add tests)
- Modify: `static/player.js` (lines 215-222: `wordsMatch()`)

### Step 1: Write failing tests

Append to `tests/test_match_helpers.cjs`:

```javascript
var maxEditDistance = fakeModule.exports.maxEditDistance;
var skipFuzzyMatch = fakeModule.exports.skipFuzzyMatch;

// --- maxEditDistance ---
assert.strictEqual(maxEditDistance(1), 1);
assert.strictEqual(maxEditDistance(3), 1);
assert.strictEqual(maxEditDistance(6), 1);
assert.strictEqual(maxEditDistance(7), 2);
assert.strictEqual(maxEditDistance(9), 2);
assert.strictEqual(maxEditDistance(10), 3);
assert.strictEqual(maxEditDistance(15), 3);
assert.strictEqual(maxEditDistance(0), 1);

// --- skipFuzzyMatch ---
assert.strictEqual(skipFuzzyMatch('i'), true);
assert.strictEqual(skipFuzzyMatch('a'), true);
assert.strictEqual(skipFuzzyMatch('to'), true);
assert.strictEqual(skipFuzzyMatch('the'), false);
assert.strictEqual(skipFuzzyMatch('love'), false);

console.log('All edit distance tests passed.');
```

### Step 2: Run tests to verify they fail

Run: `node tests/test_match_helpers.cjs`
Expected: FAIL â€” `maxEditDistance` is undefined.

### Step 3: Implement in match-helpers.js

Add before the exports block:

```javascript
function maxEditDistance(len) {
    if (len <= 0) return 1;
    if (len <= 6) return 1;
    if (len <= 9) return 2;
    return 3;
}

function skipFuzzyMatch(word) {
    return word.length <= 2;
}
```

Add to `module.exports`.

### Step 4: Run tests to verify they pass

Run: `node tests/test_match_helpers.cjs`
Expected: All pass.

### Step 5: Update wordsMatch() in player.js

Replace the edit distance check:

```javascript
function wordsMatch(spoken, target) {
    if (spoken === target) return true;
    const [sp, ss] = doubleMetaphone(spoken);
    const [tp, ts] = doubleMetaphone(target);
    if (sp && tp && (sp === tp || sp === ts || (ss && (ss === tp || ss === ts)))) return true;
    if (!skipFuzzyMatch(target) && !skipFuzzyMatch(spoken)) {
        var maxDist = maxEditDistance(Math.min(spoken.length, target.length));
        if (Math.abs(spoken.length - target.length) <= maxDist && editDistance(spoken, target) <= maxDist) return true;
    }
    if (contractionsMatch(spoken, target)) return true;
    return false;
}
```

### Step 6: Run all tests

Run: `node tests/test_match_helpers.cjs && node tests/test_sync_helpers.cjs && pytest tests/ -v`
Expected: All pass.

### Step 7: Commit

```
git add static/match-helpers.js tests/test_match_helpers.cjs static/player.js
git commit -m "feat: adaptive edit distance scaling and short-word fuzzy gate"
```

---

## Task 5: Pre-computed Phonetic Index & LRU Cache

**Files:**
- Modify: `static/match-helpers.js` (add `MetaphoneLRU` class)
- Modify: `tests/test_match_helpers.cjs` (add LRU tests)
- Modify: `static/player.js` (`interpolateWordTimings()`, `wordsMatch()`, all match call sites)

### Step 1: Write failing tests

Append to `tests/test_match_helpers.cjs`:

```javascript
var MetaphoneLRU = fakeModule.exports.MetaphoneLRU;

var lru = new MetaphoneLRU(5);
var r = lru.get('night');
assert.ok(Array.isArray(r), 'should return array');
assert.strictEqual(r.length, 2, 'should have primary and secondary');

var r2 = lru.get('night');
assert.deepStrictEqual(r, r2, 'cached result should be identical');

// Fill beyond capacity
lru.get('a'); lru.get('b'); lru.get('c'); lru.get('d'); lru.get('e');
assert.strictEqual(lru._cache.has('night'), false, 'oldest should be evicted');
assert.strictEqual(lru._cache.size, 5, 'cache at capacity');

lru.reset();
assert.strictEqual(lru._cache.size, 0, 'reset clears cache');

console.log('All MetaphoneLRU tests passed.');
```

### Step 2: Run tests to verify they fail

Run: `node tests/test_match_helpers.cjs`
Expected: FAIL.

### Step 3: Implement MetaphoneLRU

Add to `static/match-helpers.js`:

```javascript
function MetaphoneLRU(capacity) {
    this._capacity = capacity || 50;
    this._cache = new Map();
}

MetaphoneLRU.prototype.get = function(word) {
    if (this._cache.has(word)) {
        var val = this._cache.get(word);
        this._cache.delete(word);
        this._cache.set(word, val);
        return val;
    }
    var result = (typeof doubleMetaphone === 'function') ? doubleMetaphone(word) : [word, ''];
    if (this._cache.size >= this._capacity) {
        var oldest = this._cache.keys().next().value;
        this._cache.delete(oldest);
    }
    this._cache.set(word, result);
    return result;
};

MetaphoneLRU.prototype.reset = function() {
    this._cache.clear();
};
```

Add to `module.exports`.

### Step 4: Run tests to verify they pass

Run: `node tests/test_match_helpers.cjs`
Expected: All pass.

### Step 5: Add phonetic index to interpolateWordTimings in player.js

In `interpolateWordTimings()`, after pushing each word timing object, add:
```javascript
wordTimings[wordTimings.length - 1].phonetic = doubleMetaphone(normalizeWord(words[wi]));
```

### Step 6: Update wordsMatch to use LRU and pre-computed phonetics

Create module-level `var _spokenLRU = new MetaphoneLRU(50);` in player.js.

Update `wordsMatch()`:
```javascript
function wordsMatch(spoken, target, targetPhonetic) {
    if (spoken === target) return true;
    var sp = _spokenLRU.get(spoken);
    var tp = targetPhonetic || doubleMetaphone(target);
    if (sp[0] && tp[0] && (sp[0] === tp[0] || sp[0] === tp[1] || (sp[1] && (sp[1] === tp[0] || sp[1] === tp[1])))) return true;
    if (!skipFuzzyMatch(target) && !skipFuzzyMatch(spoken)) {
        var maxDist = maxEditDistance(Math.min(spoken.length, target.length));
        if (Math.abs(spoken.length - target.length) <= maxDist && editDistance(spoken, target) <= maxDist) return true;
    }
    if (contractionsMatch(spoken, target)) return true;
    return false;
}
```

Update all call sites (`_collectMatches`, `_collectMatchesWhisper`, `_matchHotWord`, `_matchPrevLine`, `_lateScoreLine`) to pass `this.wordTimings[li].phonetic` as the third argument.

### Step 7: Run all tests

Run: `node tests/test_match_helpers.cjs && node tests/test_sync_helpers.cjs && pytest tests/ -v`
Expected: All pass.

### Step 8: Commit

```
git add static/match-helpers.js static/player.js tests/test_match_helpers.cjs
git commit -m "feat: pre-computed phonetic index and spoken word LRU cache"
```

---

## Task 6: Smoother Adaptive Whisper Chunking

**Files:**
- Modify: `static/audio-processor.js` (add flush and overlap support)
- Modify: `static/player.js` (setActiveLine chunk transition, _sendChunkToWhisper in-flight counter)

### Step 1: Update AudioWorklet to handle flush message

In `static/audio-processor.js`, update the `port.onmessage` handler to handle `flush` and `enableOverlap` messages. Add overlap buffer support to `process()`.

See the flush handler:
```javascript
} else if (e.data && e.data.type === 'flush') {
    if (this._buf.length >= 1600) {
        var chunk = new Float32Array(this._buf.splice(0, this._buf.length));
        this.port.postMessage({ type: 'chunk', data: chunk });
    } else {
        this._buf.length = 0;
    }
} else if (e.data && e.data.type === 'enableOverlap') {
    this._overlapEnabled = !!e.data.enabled;
    this._overlapBuf = [];
    this._overlapTarget = Math.floor(this._target / 2);
    this._overlapPhase = 0;
}
```

And the overlap chunk emission in `process()`:
```javascript
if (this._overlapEnabled) {
    for (var i = 0; i < channel.length; i++) {
        this._overlapBuf.push(channel[i]);
    }
    this._overlapPhase += channel.length;
    if (this._overlapPhase >= this._overlapTarget && this._overlapBuf.length >= this._target) {
        var chunk = new Float32Array(this._overlapBuf.splice(0, this._target));
        this.port.postMessage({ type: 'overlap-chunk', data: chunk });
        this._overlapPhase = 0;
    }
}
```

### Step 2: Update setActiveLine in player.js

Add flush before chunk size change, enable overlap for fast sections:

```javascript
if (this._whisperNode && this._whisperNode.port) {
    var tempoClass = (this.wordTimings && this.wordTimings.tempoClass) || 'normal';
    this._whisperNode.port.postMessage({ type: 'flush' });
    this._whisperNode.port.postMessage({
        type: 'setChunkSize',
        samples: getChunkSamples(tempoClass)
    });
    this._whisperNode.port.postMessage({
        type: 'enableOverlap',
        enabled: tempoClass === 'fast'
    });
}
```

### Step 3: Handle overlap-chunk in message handler

Update `_startWhisperTrack()` port.onmessage to handle `overlap-chunk`:
```javascript
} else if (msg && msg.type === 'overlap-chunk') {
    if (this._whisperInFlight < 2) {
        this._sendChunkToWhisper(msg.data);
    }
}
```

### Step 4: Add in-flight counter to _sendChunkToWhisper

Add `this._whisperInFlight = 0;` to the GameMode constructor.

Wrap `_sendChunkToWhisper` with increment/decrement:
```javascript
async _sendChunkToWhisper(float32) {
    this._whisperInFlight++;
    try {
        // ... existing fetch logic ...
    } catch (_) { }
    finally {
        this._whisperInFlight = Math.max(0, this._whisperInFlight - 1);
    }
}
```

### Step 5: Run all tests

Run: `node tests/test_sync_helpers.cjs && node tests/test_match_helpers.cjs && pytest tests/ -v`
Expected: All pass.

### Step 6: Commit

```
git add static/audio-processor.js static/player.js
git commit -m "feat: flush-on-transition and overlapping chunks for fast sections"
```

---

## Task 7: Sliding Window ASR Buffer

**Files:**
- Modify: `static/sync-helpers.js` (add `getSpokenWindowSize()`)
- Modify: `tests/test_sync_helpers.cjs` (add tests)
- Modify: `static/player.js` (`_collectMatches` to use rolling window)

### Step 1: Write failing tests

Append to `tests/test_sync_helpers.cjs`:

```javascript
var getSpokenWindowSize = fakeModule.exports.getSpokenWindowSize;

assert.strictEqual(getSpokenWindowSize('slow'), 20);
assert.strictEqual(getSpokenWindowSize('normal'), 15);
assert.strictEqual(getSpokenWindowSize('fast'), 12);
assert.strictEqual(getSpokenWindowSize('unknown'), 15);

console.log('All getSpokenWindowSize tests passed.');
```

### Step 2: Run tests to verify they fail

Run: `node tests/test_sync_helpers.cjs`
Expected: FAIL.

### Step 3: Implement in sync-helpers.js

Add before the exports:
```javascript
function getSpokenWindowSize(tempoClass) {
    switch (tempoClass) {
        case 'slow':   return 20;
        case 'fast':   return 12;
        case 'normal':
        default:       return 15;
    }
}
```

Add `getSpokenWindowSize` to `module.exports`.

### Step 4: Run tests to verify they pass

Run: `node tests/test_sync_helpers.cjs`
Expected: All pass.

### Step 5: Use in _collectMatches

In `_collectMatches()`, clamp scan start:
```javascript
var windowSize = getSpokenWindowSize(this.wordTimings.tempoClass || 'normal');
var spokenIdx = Math.max(this.lineStartTranscriptPos, spoken.length - windowSize);
```

Apply same to `_collectMatchesWhisper()`.

### Step 6: Run all tests

Run: `node tests/test_sync_helpers.cjs && node tests/test_match_helpers.cjs && pytest tests/ -v`
Expected: All pass.

### Step 7: Commit

```
git add static/sync-helpers.js tests/test_sync_helpers.cjs static/player.js
git commit -m "feat: sliding window ASR buffer to reduce stale word false matches"
```

---

## Task 8: Integration Testing & Manual Verification

### Step 1: Run full automated test suite

Run: `node tests/test_match_helpers.cjs && node tests/test_sync_helpers.cjs && pytest tests/ -v`
Expected: All pass with no regressions.

### Step 2: Manual browser testing checklist

1. **Contraction test:** Load a song with "gonna"/"wanna" in lyrics. Verify words light up green.
2. **Phrase test:** Find a song with "alright" or "all right". Verify matching works both forms.
3. **Fast section test:** Load a song with rap verses. Check debug HUD shows correct tempo class.
4. **Prompt hint test:** DevTools Network tab â€” verify `X-Lyric-Hint` header on `/transcribe` requests.
5. **Word timestamps test:** Verify `/transcribe` response JSON includes `words` array.
6. **Overlap chunks test:** During fast sections, verify more frequent `/transcribe` requests.

### Step 3: Commit any fixes from manual testing

Fix and commit individually.

---

## Dependency Graph

```
Task 1 (contractions) â”€â”€â”
Task 2 (phrases)     â”€â”€â”€â”¤â”€â”€ sequential (both write match-helpers.js)
                        â”‚
Task 3 (Whisper)     â”€â”€â”€â”¤â”€â”€ independent (backend + client fetch)
                        â”‚
Task 4 (edit dist)   â”€â”€â”€â”¤â”€â”€ depends on Task 1 (match-helpers.js exists)
Task 5 (phonetic)    â”€â”€â”€â”¤â”€â”€ depends on Task 4 (wordsMatch signature)
                        â”‚
Task 6 (chunking)    â”€â”€â”€â”¤â”€â”€ independent (audio-processor.js)
Task 7 (sliding win) â”€â”€â”€â”¤â”€â”€ independent (sync-helpers.js)
                        â”‚
Task 8 (integration) â”€â”€â”€â”˜â”€â”€ depends on all above
```

**Parallelizable groups:**
- Group A: Tasks 1 â†’ 2 â†’ 4 â†’ 5 (sequential)
- Group B: Task 3 (independent)
- Group C: Task 6 (independent)
- Group D: Task 7 (independent)
- Groups B, C, D can run in parallel with each other and with Group A.
- Task 8 runs last.
