# Filter Non-Lyric LRC Lines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the scoring engine from treating LRC speaker labels (`Lil'D:`, `Shawty e demoni:`) and section headers (`[Chorus]`, `(Verse 1)`) as required-to-sing lyrics, by filtering them at the single parse choke point.

**Architecture:** A new pure, DOM-free helper `static/lyric-annotations.js` exposes two predicates (`isSpeakerLabel`, `isSectionHeader`) + a `stripNonLyricLines` filter with an all-annotations fail-safe. `parseLrc()` in `lyrics-client.js` calls it through a load-order-robust lazy resolver (the `_profanity()` pattern from `scoring.js`). The Python `parse_lrc()` in `lyrics.py` mirrors the same logic for the local-dev path. The player consumes already-filtered `songData.lyrics` from sessionStorage, so no player-side change is needed.

**Tech Stack:** Plain ES5-style JS (UMD wrapper, `var`/functions — browser `<script>` + Node `require`), Node `assert` `.cjs` tests, Python 3 + pytest.

**Spec:** [docs/superpowers/specs/2026-06-24-lrc-non-lyric-lines-design.md](../specs/2026-06-24-lrc-non-lyric-lines-design.md)

**Branch:** `feat/filter-non-lyric-lrc-lines` (already created; spec committed as `b48e974`).

---

### Task 1: Pure helper `lyric-annotations.js` + golden test

**Files:**
- Create: `static/lyric-annotations.js`
- Test: `tests/test_lyric_annotations.cjs`

- [ ] **Step 1: Write the failing test**

Create `tests/test_lyric_annotations.cjs`:

```js
const assert = require('assert');
const {
    isSpeakerLabel, isSectionHeader, isNonLyricLine, stripNonLyricLines,
} = require('../static/lyric-annotations.js');

// --- speaker labels (trailing colon, short, no sentence stopword) -> DROP ---
assert.strictEqual(isSpeakerLabel('Shawty e demoni:'), true, 'multi-word demon name label');
assert.strictEqual(isSpeakerLabel("Lil'D:"), true, 'single-token rapper label');
assert.strictEqual(isSpeakerLabel('MC:'), true, 'short label');

// --- NOT speaker labels -> KEEP ---
assert.strictEqual(isSpeakerLabel('and then she said:'), false, 'sentence stopword guard keeps real lyric');
assert.strictEqual(isSpeakerLabel('Soul? Shawty I got that'), false, 'no trailing colon');
assert.strictEqual(isSpeakerLabel('Ah Lil D! Welcome to "soul stack records".'), false, 'ends in period, name is mid-lyric');
assert.strictEqual(isSpeakerLabel('Get em Shawty'), false, 'no colon');
assert.strictEqual(isSpeakerLabel('I want to tell you all something right now please:'), false, 'too many words to be a label');

// --- section headers (entire line is a section tag) -> DROP ---
assert.strictEqual(isSectionHeader('[Chorus]'), true);
assert.strictEqual(isSectionHeader('(Verse 1)'), true);
assert.strictEqual(isSectionHeader('[Bridge]'), true);
assert.strictEqual(isSectionHeader('(Intro)'), true);
assert.strictEqual(isSectionHeader('{Hook}'), true);
assert.strictEqual(isSectionHeader('(Pre-Chorus 2)'), true);

// --- NOT section headers -> KEEP (sung parentheticals / partial wraps) ---
assert.strictEqual(isSectionHeader('(Soul) Ah ah ah ah!'), false, 'wrap does not span whole line');
assert.strictEqual(isSectionHeader("(I Can't Get No) Satisfaction"), false, 'text continues past paren');
assert.strictEqual(isSectionHeader('(Ooh)'), false, 'fully wrapped but not a section word');
assert.strictEqual(isSectionHeader('(Soul)'), false, 'backing vocal, not a section word');

// --- combined predicate ---
assert.strictEqual(isNonLyricLine("Lil'D:"), true);
assert.strictEqual(isNonLyricLine('[Chorus]'), true);
assert.strictEqual(isNonLyricLine('Get em Shawty'), false);

// --- stripNonLyricLines: removes annotations, keeps lyrics, preserves order ---
const lines = [
    { time: 1, text: 'Ah Lil D! Welcome to "soul stack records".' },
    { time: 2, text: 'Shawty e demoni:' },
    { time: 3, text: 'But all we want is your soul' },
    { time: 4, text: '[Chorus]' },
    { time: 5, text: '(Soul) Ah ah ah ah!' },
];
const kept = stripNonLyricLines(lines);
assert.strictEqual(kept.length, 3, 'two annotation lines removed');
assert.deepStrictEqual(kept.map(l => l.time), [1, 3, 5], 'order preserved, labels/headers gone');

// --- fail-safe: an all-annotations list returns the ORIGINAL unchanged ---
const allAnn = [{ time: 1, text: 'Lil D:' }, { time: 2, text: '[Verse]' }];
assert.strictEqual(stripNonLyricLines(allAnn).length, 2, 'never blank out the whole sheet');

console.log('test_lyric_annotations: OK');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test_lyric_annotations.cjs`
Expected: FAIL — `Cannot find module '../static/lyric-annotations.js'`

- [ ] **Step 3: Write the implementation**

Create `static/lyric-annotations.js`:

```js
/**
 * Pure detection + removal of NON-LYRIC LRC lines: rap-battle / dialogue
 * SPEAKER LABELS ("Lil'D:", "Shawty e demoni:") and SECTION HEADERS
 * ("[Chorus]", "(Verse 1)"). These are annotations, not sung lyrics, so the
 * scoring engine must never treat them as required lines. Applied at the
 * parseLrc choke point (lyrics-client.js / lyrics.py). No DOM — Node-testable.
 */
var MAX_SPEAKER_LABEL_WORDS = 4;

// Presence of any of these in a colon-ending line means it is a SENTENCE
// (e.g. "and then she said:"), not a bare speaker tag -> keep it.
var SENTENCE_STOPWORDS = {
    'and': 1, 'then': 1, 'the': 1, 'to': 1, 'of': 1, 'in': 1, 'is': 1, 'are': 1,
    'was': 1, 'were': 1, 'she': 1, 'he': 1, 'we': 1, 'you': 1, 'it': 1, 'that': 1,
    'this': 1, 'but': 1, 'so': 1, 'with': 1, 'my': 1, 'your': 1, 'a': 1, 'i': 1
};

// First inner word of a fully-wrapped line (after dropping a trailing number / "xN").
var SECTION_KEYWORDS = {
    'intro': 1, 'verse': 1, 'chorus': 1, 'prechorus': 1, 'pre-chorus': 1,
    'postchorus': 1, 'post-chorus': 1, 'bridge': 1, 'outro': 1, 'hook': 1,
    'refrain': 1, 'interlude': 1, 'breakdown': 1, 'drop': 1, 'instrumental': 1,
    'solo': 1, 'vamp': 1, 'coda': 1, 'spoken': 1
};

function _words(s) {
    return String(s || '').trim().split(/\s+/).filter(Boolean);
}

function isSpeakerLabel(text) {
    var t = String(text || '').trim();
    if (t.charAt(t.length - 1) !== ':') return false;
    var core = t.slice(0, -1).trim();
    if (!core) return false;
    var words = _words(core);
    if (words.length === 0 || words.length > MAX_SPEAKER_LABEL_WORDS) return false;
    for (var i = 0; i < words.length; i++) {
        var w = words[i].toLowerCase().replace(/[^a-z'-]/g, '');
        if (SENTENCE_STOPWORDS[w]) return false;
    }
    return true;
}

function isSectionHeader(text) {
    var t = String(text || '').trim();
    // entire line is ONE balanced [ ] / ( ) / { } wrap, no inner brackets
    var m = /^[\[({]\s*([^\[\](){}]+?)\s*[\])}]$/.exec(t);
    if (!m) return false;
    var inner = m[1].toLowerCase().trim();
    inner = inner.replace(/[\s-]*(?:x\s*)?\d+\s*x?$/i, '').trim(); // "verse 1" -> "verse"
    var first = inner.split(/\s+/)[0] || inner;
    return !!(SECTION_KEYWORDS[inner] || SECTION_KEYWORDS[first]);
}

function isNonLyricLine(text) {
    return isSpeakerLabel(text) || isSectionHeader(text);
}

function stripNonLyricLines(lines) {
    if (!Array.isArray(lines)) return lines;
    var out = [];
    for (var i = 0; i < lines.length; i++) {
        if (lines[i] && isNonLyricLine(lines[i].text)) continue;
        out.push(lines[i]);
    }
    if (out.length === 0 && lines.length > 0) return lines; // fail-safe: never blank the sheet
    return out;
}

var KaraokeeLyricAnnotations = {
    isSpeakerLabel: isSpeakerLabel,
    isSectionHeader: isSectionHeader,
    isNonLyricLine: isNonLyricLine,
    stripNonLyricLines: stripNonLyricLines,
    MAX_SPEAKER_LABEL_WORDS: MAX_SPEAKER_LABEL_WORDS,
    SENTENCE_STOPWORDS: SENTENCE_STOPWORDS,
    SECTION_KEYWORDS: SECTION_KEYWORDS
};
if (typeof window !== 'undefined') window.KaraokeeLyricAnnotations = KaraokeeLyricAnnotations;
if (typeof module !== 'undefined' && module.exports) module.exports = KaraokeeLyricAnnotations;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test_lyric_annotations.cjs`
Expected: PASS — prints `test_lyric_annotations: OK`

- [ ] **Step 5: Commit**

```bash
git add static/lyric-annotations.js tests/test_lyric_annotations.cjs
git commit -m "feat(lyrics): pure helper to detect non-lyric LRC lines (speaker labels + section headers)"
```

---

### Task 2: Wire filter into `parseLrc` + load the helper in `index.html`

**Files:**
- Modify: `static/lyrics-client.js:7-22` (add lazy resolver; filter in `parseLrc`)
- Modify: `tests/test_lyrics_search.cjs` (add a `parseLrc` filtering assertion)
- Modify: `static/index.html:75` (load the helper before `lyrics-client.js`)

- [ ] **Step 1: Write the failing test**

In `tests/test_lyrics_search.cjs`, immediately before the final `console.log('test_lyrics_search: OK');` line, add:

```js
    // --- parseLrc drops non-lyric annotation lines (speaker labels + section headers) ---
    const pl = client.parseLrc(
        '[00:01.00] Verse line one\n' +
        "[00:02.00] Lil'D:\n" +
        '[00:03.00] [Chorus]\n' +
        '[00:04.00] All we want is your soul'
    );
    assert.strictEqual(pl.length, 2, 'parseLrc strips the speaker label and the section header');
    assert.deepStrictEqual(pl.map(l => l.text), ['Verse line one', 'All we want is your soul']);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test_lyrics_search.cjs`
Expected: FAIL — `AssertionError [ERR_ASSERTION]: parseLrc strips the speaker label and the section header` (currently returns 4 lines)

- [ ] **Step 3: Write the implementation**

In `static/lyrics-client.js`, add the lazy resolver after the two constants (after line 8, `var LRCLIB_MAX_ATTEMPTS = 2;`):

```js
// Lazy resolver (load-order robust): require() in Node, window global in browser.
function _annotations() {
    if (typeof module !== 'undefined' && module.exports) {
        try { return require('./lyric-annotations.js'); } catch (e) { return null; }
    }
    return (typeof window !== 'undefined' && window.KaraokeeLyricAnnotations) || null;
}
```

Then in `parseLrc`, replace the final `return lines;` (line 21) with:

```js
    var ann = _annotations();
    return (ann && ann.stripNonLyricLines) ? ann.stripNonLyricLines(lines) : lines;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/test_lyrics_search.cjs`
Expected: PASS — prints `test_lyrics_search: OK`

Run: `node tests/test_lyric_annotations.cjs`
Expected: PASS (still green)

- [ ] **Step 5: Load the helper in `index.html`**

In `static/index.html`, replace the line at `:75`:

```html
    <script src="/static/lyrics-client.js"></script>
```

with (helper first, so its global exists before `parseLrc` runs):

```html
    <script src="/static/lyric-annotations.js"></script>
    <script src="/static/lyrics-client.js"></script>
```

Verify the tag is present and ordered:
Run: `grep -n "lyric-annotations.js\|lyrics-client.js" static/index.html`
Expected: `lyric-annotations.js` line is printed immediately before `lyrics-client.js`.

- [ ] **Step 6: Commit**

```bash
git add static/lyrics-client.js tests/test_lyrics_search.cjs static/index.html
git commit -m "feat(lyrics): filter non-lyric lines in parseLrc; load helper in index.html"
```

---

### Task 3: Python parity in `lyrics.py` + parity tests

**Files:**
- Modify: `lyrics.py:1-24` (add constants + predicates; filter in `parse_lrc`)
- Modify: `tests/test_lyrics.py` (add parity tests)

- [ ] **Step 1: Write the failing tests**

In `tests/test_lyrics.py`, update the import line at the top:

```python
from lyrics import (
    parse_lrc, fetch_lyrics, _score_candidate,
    is_speaker_label, is_section_header, strip_non_lyric_lines,
)
```

Then add these tests at the end of the file:

```python
def test_is_speaker_label_detects_trailing_colon_labels():
    assert is_speaker_label("Shawty e demoni:") is True
    assert is_speaker_label("Lil'D:") is True
    assert is_speaker_label("and then she said:") is False  # stopword guard
    assert is_speaker_label("Soul? Shawty I got that") is False  # no colon
    assert is_speaker_label('Ah Lil D! Welcome to "soul stack records".') is False


def test_is_section_header_detects_full_wrap_section_words():
    assert is_section_header("[Chorus]") is True
    assert is_section_header("(Verse 1)") is True
    assert is_section_header("(Pre-Chorus 2)") is True
    assert is_section_header("(Soul) Ah ah ah ah!") is False  # partial wrap
    assert is_section_header("(Ooh)") is False  # fully wrapped, not a section word


def test_parse_lrc_strips_speaker_labels_and_section_headers():
    lrc = (
        "[00:01.00] Verse line one\n"
        "[00:02.00] Lil'D:\n"
        "[00:03.00] [Chorus]\n"
        "[00:04.00] All we want is your soul"
    )
    assert parse_lrc(lrc) == [
        {"time": 1.0, "text": "Verse line one"},
        {"time": 4.0, "text": "All we want is your soul"},
    ]


def test_strip_non_lyric_lines_fail_safe_keeps_all_annotation_sheet():
    lines = [{"time": 1.0, "text": "Lil D:"}, {"time": 2.0, "text": "[Verse]"}]
    assert strip_non_lyric_lines(lines) == lines  # never blank out the whole sheet
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_lyrics.py -v`
Expected: FAIL — `ImportError: cannot import name 'is_speaker_label' from 'lyrics'`

- [ ] **Step 3: Write the implementation**

In `lyrics.py`, add these constants and functions immediately before `def parse_lrc` (after the existing `LRCLIB_*` constants):

```python
MAX_SPEAKER_LABEL_WORDS = 4

# Presence of any of these in a colon-ending line means it is a SENTENCE
# (e.g. "and then she said:"), not a bare speaker tag -> keep it.
SENTENCE_STOPWORDS = {
    "and", "then", "the", "to", "of", "in", "is", "are", "was", "were", "she",
    "he", "we", "you", "it", "that", "this", "but", "so", "with", "my", "your",
    "a", "i",
}

SECTION_KEYWORDS = {
    "intro", "verse", "chorus", "prechorus", "pre-chorus", "postchorus",
    "post-chorus", "bridge", "outro", "hook", "refrain", "interlude",
    "breakdown", "drop", "instrumental", "solo", "vamp", "coda", "spoken",
}


def is_speaker_label(text: str) -> bool:
    """True for a bare rap-battle / dialogue speaker tag like 'Lil D:'."""
    t = (text or "").strip()
    if not t.endswith(":"):
        return False
    core = t[:-1].strip()
    if not core:
        return False
    words = core.split()
    if not words or len(words) > MAX_SPEAKER_LABEL_WORDS:
        return False
    for word in words:
        w = re.sub(r"[^a-z'-]", "", word.lower())
        if w in SENTENCE_STOPWORDS:
            return False
    return True


def is_section_header(text: str) -> bool:
    """True when the ENTIRE line is a section tag like '[Chorus]' / '(Verse 1)'."""
    t = (text or "").strip()
    m = re.match(r"^[\[({]\s*([^\[\](){}]+?)\s*[\])}]$", t)
    if not m:
        return False
    inner = m.group(1).lower().strip()
    inner = re.sub(r"[\s-]*(?:x\s*)?\d+\s*x?$", "", inner, flags=re.IGNORECASE).strip()
    first = inner.split()[0] if inner.split() else inner
    return inner in SECTION_KEYWORDS or first in SECTION_KEYWORDS


def is_non_lyric_line(text: str) -> bool:
    return is_speaker_label(text) or is_section_header(text)


def strip_non_lyric_lines(lines: list[dict]) -> list[dict]:
    out = [ln for ln in lines if not is_non_lyric_line(ln.get("text", ""))]
    if not out and lines:  # fail-safe: never blank the sheet
        return lines
    return out
```

Then change the final `return lines` in `parse_lrc` to:

```python
    return strip_non_lyric_lines(lines)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_lyrics.py -v`
Expected: PASS — all tests in the file green (existing + 4 new).

- [ ] **Step 5: Commit**

```bash
git add lyrics.py tests/test_lyrics.py
git commit -m "feat(lyrics): mirror non-lyric line filter in Python parse_lrc"
```

---

### Task 4: End-to-end verification against the real LRC + full sweep

**Files:**
- Create (temporary, network): `tests/manual_verify_non_lyric_filter.cjs`

- [ ] **Step 1: Write the real-LRC verification script**

Create `tests/manual_verify_non_lyric_filter.cjs` (MANUAL / network check — not part of the standard sweep; requires Node 18+ for global `fetch`):

```js
// Confirms the real "We Want Your Soul" LRC loses exactly its 4 speaker-label
// lines once parseLrc filters annotations. Network call to lrclib.net.
const assert = require('assert');
const { parseLrc } = require('../static/lyrics-client.js');

(async () => {
    const url = 'https://lrclib.net/api/search?q=' +
        encodeURIComponent('We Want Your Soul Class of 3000');
    const data = await (await fetch(url)).json();
    const row = data.find(d => d.syncedLyrics && /want your soul/i.test(d.trackName));
    assert.ok(row, 'found the synced LRC candidate');

    const rawCount = row.syncedLyrics.split(/\r?\n/)
        .filter(l => /^\[\d+:\d+\.\d+\]\s*\S/.test(l.trim())).length;
    const filtered = parseLrc(row.syncedLyrics);

    console.log('raw timestamped lines:', rawCount, '-> filtered:', filtered.length);
    assert.strictEqual(rawCount, 82, 'raw line count (pre-filter, blank lines excluded)');
    assert.strictEqual(filtered.length, 78, 'filtered: the 4 speaker labels removed');
    assert.ok(!filtered.some(l => l.text.trim().endsWith(':')), 'no trailing-colon labels remain');
    assert.ok(filtered.some(l => /welcome to/i.test(l.text)), 'real "Ah Lil D! Welcome..." kept');
    console.log('manual_verify_non_lyric_filter: OK');
})().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run the verification**

Run: `node tests/manual_verify_non_lyric_filter.cjs`
Expected: prints `raw timestamped lines: 82 -> filtered: 78` then `manual_verify_non_lyric_filter: OK`

(If lrclib is unreachable, this step may be retried later; it is not a committed gate.)

- [ ] **Step 3: Run the full JS + Python test sweep**

Run:
```bash
node tests/test_lyric_annotations.cjs
node tests/test_lyrics_search.cjs
python -m pytest tests/test_lyrics.py tests/test_app.py -v
```
Expected: all green — `test_lyric_annotations: OK`, `test_lyrics_search: OK`, and pytest all passed.

- [ ] **Step 4: Remove the temporary verification script**

```bash
git rm -f --ignore-unmatch tests/manual_verify_non_lyric_filter.cjs
rm -f tests/manual_verify_non_lyric_filter.cjs
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test(lyrics): verify real LRC loses its 4 speaker labels (82 -> 78)"
```

---

## Notes for the implementer

- **Do not edit `player.html` / `player.js`.** The player reads already-parsed, already-filtered `songData.lyrics` from sessionStorage (`player.js:2014`); the filter lives entirely on the `index.html` -> `parseLrc` ingestion path.
- **Keep JS and Python constant lists identical.** If you tune `MAX_SPEAKER_LABEL_WORDS`, `SENTENCE_STOPWORDS`, or `SECTION_KEYWORDS`, change both files and both test suites in lockstep.
- **Windows + template literals:** these files use no backtick template literals, but per repo convention edit JS files with the Edit/Write tools directly, never via a Bash heredoc.
- **Spec §5.3 breadth check is covered** by the Task 1 golden corpus (normal lines kept, headers/labels dropped — deterministic) plus the Task 4 real-LRC run. Optionally spot-check one more real lrclib song with section headers if you want extra confidence; not a gate (synced LRCs rarely embed `[Verse]`/`[Chorus]`, which is why the speaker-label case is the realistic driver).
