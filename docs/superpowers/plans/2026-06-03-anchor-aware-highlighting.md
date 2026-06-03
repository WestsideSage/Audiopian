# Anchor-Aware Highlighting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Under `karaokee_v2`, make the in-game word coloring a live mirror of the phrase engine — only key (anchor) words light up (green when the engine credits them), and red appears only when an anchor's phrase settles unscored; non-key words never color.

**Architecture:** A new pure `static/lyric-paint-helpers.js` maps phrase-plan anchors to displayed-word indices (handling chunked lines). `static/player.js` tags anchor spans at render, paints them from the engine's `anchorHits` (live green) and per-phrase `lyricStatus` at settle (red), and gates the four legacy V1 span-coloring ops off under V2. Scoring/honesty untouched; V1 coloring unchanged when the flag is off.

**Tech Stack:** Plain ES5-style browser JS (string concatenation, no template literals), UMD module + Node `.cjs` golden test, Flask static serving. Author JS via Write/Edit directly.

**Source spec:** [`docs/superpowers/specs/2026-06-03-anchor-aware-highlighting-design.md`](../specs/2026-06-03-anchor-aware-highlighting-design.md)

---

## File Structure
- **Create `static/lyric-paint-helpers.js`** — pure `buildAnchorSpanIndex(phrasePlan)`.
- **Create `tests/test_lyric_paint_helpers.cjs`** — golden test (chunked + non-chunked lines).
- **Modify `static/player.html`** — `<script src="/static/lyric-paint-helpers.js">` before `player.js`.
- **Modify `static/player.js`** — render tagging; `_paintAnchorSpansLive`; `_updateWordSpans` V2 branch; `_commitNewlySettled` settle paint; gate the 3 remaining V1 color ops to V1-only.

**Build order:** Task 1 (pure map + test) → Task 2 (include) → Task 3 (tag + live green) → Task 4 (settle red + gate V1 ops).

---

## Task 1: `buildAnchorSpanIndex` pure module (TDD)

**Files:** Create `static/lyric-paint-helpers.js`, `tests/test_lyric_paint_helpers.cjs`

- [ ] **Step 1: Write the failing test** — `tests/test_lyric_paint_helpers.cjs`:

```javascript
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

function loadBrowserCommonJs(filePath, extraArgs) {
    var code = fs.readFileSync(filePath, 'utf8');
    var fakeModule = { exports: {} };
    var argNames = ['module', 'exports'].concat(Object.keys(extraArgs || {}));
    var argValues = [fakeModule, fakeModule.exports].concat(Object.values(extraArgs || {}));
    var fn = new Function(argNames.join(','), code);
    fn.apply(null, argValues);
    return fakeModule.exports;
}
var S = path.join(__dirname, '..', 'static');
var matchHelpers = loadBrowserCommonJs(path.join(S, 'match-helpers.js'));
var syncHelpers = loadBrowserCommonJs(path.join(S, 'sync-helpers.js'));
var scoring = loadBrowserCommonJs(path.join(S, 'scoring.js'), {
    require: function (s) { if (s === './match-helpers.js') return matchHelpers; if (s === './sync-helpers.js') return syncHelpers; throw new Error(s); },
    globalThis: globalThis
});
var phraseEngine = loadBrowserCommonJs(path.join(S, 'phrase-engine.js'), {
    require: function (s) { if (s === './scoring.js') return scoring; if (s === './match-helpers.js') return matchHelpers; throw new Error(s); },
    globalThis: globalThis
});
var paint = loadBrowserCommonJs(path.join(S, 'lyric-paint-helpers.js'));

// A long line (>14 words) forces chunking into multiple phrases; a short line does not.
var lyrics = [
    { time: 0, text: 'morning sunlight breaks mountain valley rivers flowing gently distant oceans calling sailors homeward bound forever onward' },
    { time: 8, text: 'love conquers everything' }
];
var plan = phraseEngine.buildPhrasePlan(lyrics, { difficulty: 'hard', audioDuration: 20 });
var map = paint.buildAnchorSpanIndex(plan);

// Line 0 chunked into >= 2 phrases
var line0 = plan.phrases.filter(function (p) { return p.lineIdx === 0; });
assert.ok(line0.length >= 2, 'long line chunks into multiple phrases');
var p0 = line0[0], p1 = line0[1];
var offset1 = p0.words.length;
var entries0 = map[0] || [];

// First chunk: span index == anchor.wordIdx (offset 0)
p0.anchors.forEach(function (a) {
    var e = entries0.find(function (x) { return x.phraseId === p0.phraseId && x.anchorIdx === a.anchorIdx; });
    assert.ok(e, 'entry exists for first-chunk anchor');
    assert.strictEqual(e.wordIndex, a.wordIdx, 'first chunk uses offset 0');
});
// Second chunk: span index == first-chunk word count + anchor.wordIdx
p1.anchors.forEach(function (a) {
    var e = entries0.find(function (x) { return x.phraseId === p1.phraseId && x.anchorIdx === a.anchorIdx; });
    assert.ok(e, 'entry exists for second-chunk anchor');
    assert.strictEqual(e.wordIndex, offset1 + a.wordIdx, 'second chunk applies the chunk offset');
});
// All indices in bounds of the rendered word count
var nWords0 = scoring.normalizeWords(lyrics[0].text).length;
entries0.forEach(function (e) { assert.ok(e.wordIndex >= 0 && e.wordIndex < nWords0, 'wordIndex in bounds'); });

// Short line: single phrase, anchors map directly
var line1 = plan.phrases.filter(function (p) { return p.lineIdx === 1; });
assert.strictEqual(line1.length, 1, 'short line not chunked');
(map[1] || []).forEach(function (e) {
    var a = line1[0].anchors.find(function (x) { return x.anchorIdx === e.anchorIdx; });
    assert.ok(a && e.wordIndex === a.wordIdx, 'short line maps directly');
});

console.log('test_lyric_paint_helpers.cjs: all assertions passed');
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/test_lyric_paint_helpers.cjs`
Expected: FAIL — `ENOENT` (module missing).

- [ ] **Step 3: Implement the module** — `static/lyric-paint-helpers.js`:

```javascript
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        root.KaraokeeLyricPaint = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // Map a phrase plan's anchors to displayed-word (span) indices per line.
    // The engine's per-line word list (normalizeWords) is the same 1:1 sequence the
    // renderer produces; for lines the engine chunks into multiple phrases, each
    // anchor's wordIdx is into its chunk, so add the chunk's offset within the line.
    // Returns { [lineIdx]: [ { wordIndex, phraseId, anchorIdx } ... ] }.
    function buildAnchorSpanIndex(phrasePlan) {
        var byLine = {};
        var offset = {};
        var phrases = (phrasePlan && phrasePlan.phrases) || [];
        phrases.forEach(function (p) {
            var li = p.lineIdx;
            if (offset[li] == null) offset[li] = 0;
            if (!byLine[li]) byLine[li] = [];
            (p.anchors || []).forEach(function (a) {
                byLine[li].push({
                    wordIndex: offset[li] + a.wordIdx,
                    phraseId: p.phraseId,
                    anchorIdx: a.anchorIdx
                });
            });
            offset[li] += (p.words || []).length;
        });
        return byLine;
    }

    return { buildAnchorSpanIndex: buildAnchorSpanIndex };
});
```

- [ ] **Step 4: Run the test + syntax check**

Run: `node --check static/lyric-paint-helpers.js && node tests/test_lyric_paint_helpers.cjs`
Expected: `test_lyric_paint_helpers.cjs: all assertions passed`

- [ ] **Step 5: Commit**

```bash
git add static/lyric-paint-helpers.js tests/test_lyric_paint_helpers.cjs
git commit -m "feat(highlight): pure anchor->span index map + golden test"
```

---

## Task 2: Include the module

**Files:** Modify `static/player.html`

- [ ] **Step 1: Add the include** — after the `scoring-arcade.js`/`telemetry-helpers.js` includes, before `player.js`:

```html
    <script src="/static/lyric-paint-helpers.js"></script>
```

- [ ] **Step 2: Commit**

```bash
git add static/player.html
git commit -m "feat(highlight): include lyric-paint-helpers"
```

---

## Task 3: Tag anchor spans at render + live green

**Files:** Modify `static/player.js` (`renderLyricsGameMode` ~line 2687; `_updateWordSpans` ~line 1642)

- [ ] **Step 1: Tag spans in `renderLyricsGameMode`** — replace the function (the current body ends at `lyricsScroll.appendChild(el); });` + closing `}`):

```javascript
function renderLyricsGameMode() {
    lyricsScroll.innerHTML = '';
    lyrics.forEach((line, i) => {
        const el = document.createElement('div');
        el.className = 'lyric-line';
        el.dataset.index = i;

        const words = line.text.split(' ').filter(function(w) { return normalizeWord(w).length > 0; });
        words.forEach((word, wi) => {
            const span = document.createElement('span');
            span.className = 'word-span';
            span.dataset.wordIndex = wi;
            span.textContent = word;
            el.appendChild(span);
            if (wi < words.length - 1) el.appendChild(document.createTextNode(' '));
        });

        lyricsScroll.appendChild(el);
    });
    _tagAnchorSpans();
}

// Tag the spans that are phrase-engine anchors (the scored "key words") with their
// phrase + anchor identity, so V2 coloring can mirror the engine. Harmless under V1.
function _tagAnchorSpans() {
    if (!window.KaraokeeLyricPaint || !gameMode || !gameMode._phrasePlan) return;
    var map = KaraokeeLyricPaint.buildAnchorSpanIndex(gameMode._phrasePlan);
    var lines = lyricsScroll.querySelectorAll('.lyric-line');
    Object.keys(map).forEach(function (li) {
        var lineEl = lines[li];
        if (!lineEl) return;
        var spans = lineEl.querySelectorAll('.word-span');
        map[li].forEach(function (entry) {
            var span = spans[entry.wordIndex];
            if (!span) return;
            span.classList.add('key-word');
            span.dataset.phraseId = entry.phraseId;
            span.dataset.anchorIdx = entry.anchorIdx;
        });
    });
}
```

- [ ] **Step 2: V2 branch in `_updateWordSpans`** — replace the method (~lines 1642-1662):

```javascript
    _updateWordSpans() {
        const lines = lyricsScroll.querySelectorAll('.lyric-line');
        const lineEl = lines[this.activeLineIdx];
        if (!lineEl) return;

        if (window.KARAOKEE_V2) { this._paintAnchorSpansLive(lineEl); return; }

        const spans = lineEl.querySelectorAll('.word-span');
        spans.forEach((span, wi) => {
            span.classList.remove('matched', 'matched-partial', 'missed');
            var _wScore = this.matchedSet.get(wi);
            if (_wScore !== undefined) {
                span.classList.add(_wScore >= 0.75 ? 'matched' : 'matched-partial');
                if (this.asrConfirmedSet.has(wi) && !span.classList.contains('asr-confirmed')) {
                    span.classList.add('asr-confirmed');
                }
            } else {
                span.classList.remove('asr-confirmed');
            }
        });
    }

    // V2: green a key-word span the moment the engine credits its anchor (anchorHits).
    // Reds are applied at settle (see _commitNewlySettled). Non-key spans untouched.
    _paintAnchorSpansLive(lineEl) {
        var states = this._phraseSession && this._phraseSession.states;
        if (!states) return;
        lineEl.querySelectorAll('.word-span.key-word').forEach(function (span) {
            var st = states[span.dataset.phraseId];
            var hit = st && st.anchorHits && st.anchorHits[span.dataset.anchorIdx];
            if (hit) { span.classList.add('matched'); span.classList.remove('missed'); }
        });
    }
```

- [ ] **Step 3: Syntax check**

Run: `node --check static/player.js`
Expected: no output (exit 0).

- [ ] **Step 4: Commit**

```bash
git add static/player.js
git commit -m "feat(highlight): tag anchor spans; live-green key words from the engine (V2)"
```

---

## Task 4: Settle reds + gate the legacy V1 color ops

**Files:** Modify `static/player.js` (`_commitNewlySettled` ~1952; prev-line green ~1369; `_lateScoreLine` green ~2071; `_scoreLine` red ~1841)

- [ ] **Step 1: Paint at settle** — in `_commitNewlySettled`, replace the line `if (evt && routeEvents && window.KARAOKEE_V2) this._onArcadeEvent(evt);` with that line plus the anchor paint:

```javascript
            if (evt && routeEvents && window.KARAOKEE_V2) this._onArcadeEvent(evt);

            // V2 coloring: finalize this phrase's key words — green the hits, red the
            // un-hit anchors only if the phrase didn't clear (a cleared line shows no red).
            if (window.KARAOKEE_V2) {
                var _conf = pst.lyricStatus === 'confirmed';
                var _sel = '.word-span.key-word[data-phrase-id="' + ph.phraseId + '"]';
                document.querySelectorAll(_sel).forEach(function (span) {
                    var _hit = pst.anchorHits && pst.anchorHits[span.dataset.anchorIdx];
                    span.classList.remove('matched', 'matched-partial', 'missed');
                    if (_hit) span.classList.add('matched');
                    else if (!_conf) span.classList.add('missed');
                });
            }
```

- [ ] **Step 2: Gate the prev-line late-green op** — replace (~lines 1369-1372):

```javascript
                if (lineEl) {
                    var span = lineEl.querySelectorAll('.word-span')[li];
                    if (span) { span.classList.remove('missed'); span.classList.add(m.score >= 0.75 ? 'matched' : 'matched-partial'); }
                }
```

with:

```javascript
                if (lineEl && !window.KARAOKEE_V2) {
                    var span = lineEl.querySelectorAll('.word-span')[li];
                    if (span) { span.classList.remove('missed'); span.classList.add(m.score >= 0.75 ? 'matched' : 'matched-partial'); }
                }
```

- [ ] **Step 3: Gate the `_lateScoreLine` late-green op** — replace (~lines 2071-2077):

```javascript
                    if (lineEl) {
                        const span = lineEl.querySelectorAll('.word-span')[li];
                        if (span) {
                            span.classList.remove('missed');
                            span.classList.add(result.score >= 0.75 ? 'matched' : 'matched-partial');
                        }
                    }
```

with:

```javascript
                    if (lineEl && !window.KARAOKEE_V2) {
                        const span = lineEl.querySelectorAll('.word-span')[li];
                        if (span) {
                            span.classList.remove('missed');
                            span.classList.add(result.score >= 0.75 ? 'matched' : 'matched-partial');
                        }
                    }
```

- [ ] **Step 4: Gate the `_scoreLine` red op** — replace (~lines 1842-1844):

```javascript
            lineEl.querySelectorAll('.word-span').forEach((span, wi) => {
                if (scoreSummary.missedWordIndices.indexOf(wi) >= 0) span.classList.add('missed');
            });
```

with:

```javascript
            if (!window.KARAOKEE_V2) {
                lineEl.querySelectorAll('.word-span').forEach((span, wi) => {
                    if (scoreSummary.missedWordIndices.indexOf(wi) >= 0) span.classList.add('missed');
                });
            }
```

- [ ] **Step 5: Syntax check + full suites**

Run:
```bash
node --check static/player.js
node tests/test_lyric_paint_helpers.cjs && node tests/test_scoring_arcade.cjs && node tests/test_telemetry_helpers.cjs && node tests/test_phrase_engine.cjs && node tests/test_scoring.cjs && node tests/test_sync_helpers.cjs
python -m pytest tests/test_app.py -q
```
Expected: all pass.

- [ ] **Step 6: Verify in the browser** (V2 on): on Easy, sing — only key words light green, non-key words never color, a cleared line shows no red; deliberately skip a line → its un-hit key words go red at settle. Hover/play Expert → reds appear when you fall short of its bar. Toggle V off → legacy per-word coloring returns.

- [ ] **Step 7: Commit**

```bash
git add static/player.js
git commit -m "feat(highlight): red key words at settle; gate legacy V1 coloring to V1-only"
```

---

## Self-Review
- **Spec coverage:** §2 behavior (non-key dim; key green from `anchorHits`; red only at settle-unconfirmed) → Tasks 3-4; §3 mechanism (tag at render; live green; settle red; suppress V1) → Tasks 3-4 (all four V1 color ops gated: live via the `_updateWordSpans` branch, the two late-greens in steps 2-3, the `_scoreLine` red in step 4); §4 index map (chunk offset) → Task 1 + test; §5 files → all tasks. All mapped.
- **Placeholder scan:** complete code + commands throughout; no TBDs.
- **Type/name consistency:** `buildAnchorSpanIndex` → `{wordIndex, phraseId, anchorIdx}`; spans tagged `key-word` + `data-phrase-id` + `data-anchor-idx`; read identically in `_paintAnchorSpansLive` and `_commitNewlySettled`; `anchorHits` keyed by anchorIdx (string-keyed object — `dataset.anchorIdx` string lookup works); `lyricStatus === 'confirmed'` is the clear test (matches phrase-engine `updatePhraseResult`).

## Open Items
- Late Whisper rescues after a phrase settles lift the score but won't retro-green the span (live paint only covers the active line) — consistent with the arcade's commit-once "blessed divergence"; acceptable.
- The separate recognizer-miss (lag/boundary) investigation is out of scope (spec §7).
