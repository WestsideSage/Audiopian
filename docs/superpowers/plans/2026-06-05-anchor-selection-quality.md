# Anchor-Selection Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the phrase engine's anchor layer from unfairly capping the honest score — exclude parenthetical adlibs from anchors (Fix A), and don't require *literally every* anchor on lines big enough to spare one (Fix B) — plus add per-anchor detail to telemetry traces so it's all legible.

**Architecture:** All changes are in `static/phrase-engine.js` (pure, DOM-free, `.cjs`-testable). A new exported `splitLyricWordsWithParens` mirrors the parenthesis tracking `scoring.interpolateWordTimings` already does; `selectAnchors` consumes `{word, inParen}` objects and passes `inParen` to `classifyWord`; `buildPhrasePlan` gains a one-line `anchorsRequired` cap; `getPhraseTrace` gains an additive `anchors[]` array. No new flag — rides the existing `karaokee_v2` phrase-engine path; V1 unaffected.

**Tech Stack:** plain ES5-style JS (UMD factory module), Node `.cjs` golden tests.

**Spec:** [docs/superpowers/specs/2026-06-05-anchor-selection-quality-design.md](../specs/2026-06-05-anchor-selection-quality-design.md)

---

## File Structure

- **Modify** `static/phrase-engine.js` — add `splitLyricWordsWithParens` (+ export); change `chunkWords` and `buildPhrasePlan` to carry `{word, inParen}` objects; change `selectAnchors` to use `inParen`; add the `anchorsRequired` force-all cap; add `anchors[]` to `getPhraseTrace`.
- **Create** `tests/test_anchor_selection.cjs` — golden tests for all of the above.

No other files change. `scoring.js` / `match-helpers.js` are unchanged (we *reuse* `classifyWord`'s existing `inParentheses` param and `scoring.normalizeWord`). `bestScore` from spec §3C is **deferred** (the four fields `word/wordClass/weight/hit` answer the validation questions without a hot-path touch).

---

## Task 1: `splitLyricWordsWithParens` pure helper

**Files:**
- Modify: `static/phrase-engine.js` (add function near `normalizedWords` ~line 72; add to exports ~line 763)
- Test: `tests/test_anchor_selection.cjs`

- [ ] **Step 1: Write the failing test**

Create `tests/test_anchor_selection.cjs`:

```js
const assert = require('assert');
const PE = require('../static/phrase-engine.js');

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('  ok -', name); }

// --- Task 1: splitLyricWordsWithParens ---
check('splits and tags single-token parens as inParen', () => {
  assert.deepStrictEqual(
    PE.splitLyricWordsWithParens('shadows dancing (forever) tonight'),
    [ {word:'shadows', inParen:false},
      {word:'dancing', inParen:false},
      {word:'forever', inParen:true},
      {word:'tonight', inParen:false} ]
  );
});

check('tracks parens across multiple tokens', () => {
  assert.deepStrictEqual(
    PE.splitLyricWordsWithParens('hold (on my) love').map(o => o.inParen),
    [false, true, true, false]
  );
});

check('handles spaced parens (bare ( and ) tokens drop out)', () => {
  const r = PE.splitLyricWordsWithParens('a ( yeah ) b');
  assert.deepStrictEqual(r.map(o => o.word), ['a', 'yeah', 'b']);
  assert.deepStrictEqual(r.map(o => o.inParen), [false, true, false]);
});

check('empty / whitespace input yields empty array', () => {
  assert.deepStrictEqual(PE.splitLyricWordsWithParens('   '), []);
  assert.deepStrictEqual(PE.splitLyricWordsWithParens(''), []);
});

console.log('anchor-selection: ' + passed + ' checks passed');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/test_anchor_selection.cjs`
Expected: FAIL — `TypeError: PE.splitLyricWordsWithParens is not a function`.

- [ ] **Step 3: Implement the helper**

In `static/phrase-engine.js`, immediately after the `isAdlibWord` function (ends ~line 78), add:

```js
    // Split a raw lyric line into normalized words, tagging each with whether it was
    // inside parentheses in the ORIGINAL text. Mirrors the inParen walk that
    // scoring.interpolateWordTimings already does (scoring.js ~401-409), so the phrase
    // engine classifies parenthetical content as adlib instead of treating it as a
    // required anchor. Bare "(" / ")" tokens normalize to "" and are dropped, but still
    // toggle the inParen state (handles spaced parentheses).
    function splitLyricWordsWithParens(text) {
        var raw = String(text || '').trim().split(/\s+/);
        var out = [];
        var inParen = false;
        for (var i = 0; i < raw.length; i++) {
            var tok = raw[i];
            if (!tok) continue;
            if (tok.indexOf('(') >= 0) inParen = true;
            var word = scoring.normalizeWord(tok);
            if (word) out.push({ word: word, inParen: inParen });
            if (tok.indexOf(')') >= 0) inParen = false;
        }
        return out;
    }
```

Then add it to the returned exports object (the `return { ... }` near line 763), e.g. right after `buildPhrasePlan: buildPhrasePlan,`:

```js
        splitLyricWordsWithParens: splitLyricWordsWithParens,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node tests/test_anchor_selection.cjs`
Expected: PASS — `anchor-selection: 4 checks passed`.

- [ ] **Step 5: Commit**

```bash
git add static/phrase-engine.js tests/test_anchor_selection.cjs
git commit -m "feat(anchors): splitLyricWordsWithParens helper (paren-aware word split)"
```

---

## Task 2: Fix A — exclude parenthetical content from anchors

**Files:**
- Modify: `static/phrase-engine.js` — `chunkWords` (~133-146), `buildPhrasePlan` (~157-163), `selectAnchors` (~80-118)
- Test: `tests/test_anchor_selection.cjs`

- [ ] **Step 1: Add the failing test**

Append to `tests/test_anchor_selection.cjs` (before the final `console.log`):

```js
// --- Task 2: Fix A — parenthetical content is not an anchor ---
check('parenthetical content word is excluded from anchors', () => {
  const plan = PE.buildPhrasePlan(
    [{ time: 0, text: 'shadows dancing (forever) tonight' }],
    { difficulty: 'expert' }
  );
  const words = plan.phrases[0].anchors.map(a => a.word).sort();
  assert.ok(!words.includes('forever'), '"forever" was in parens — must not be an anchor');
  assert.deepStrictEqual(words, ['dancing', 'shadows', 'tonight']);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/test_anchor_selection.cjs`
Expected: FAIL — `forever` is present in anchors (assert throws), because `selectAnchors` still hardcodes `inParentheses=false`.

- [ ] **Step 3: Implement Fix A**

Three edits in `static/phrase-engine.js`:

**(a)** Change `chunkWords` to operate on `{word, inParen}` objects and emit both the string array (`words`, for downstream) and the object array (`wordObjs`, for anchor selection). Replace the whole function (~133-146):

```js
    function chunkWords(wordObjs, startSec, endSec) {
        function mk(slice, s, e) {
            return { words: slice.map(function (o) { return o.word; }), wordObjs: slice, startSec: s, endSec: e };
        }
        if (wordObjs.length <= 14) return [mk(wordObjs, startSec, endSec)];
        var chunkSize = wordObjs.length <= 20 ? Math.ceil(wordObjs.length / 2) : 8;
        chunkSize = Math.max(6, Math.min(10, chunkSize));
        var duration = Math.max(0, endSec - startSec);
        var chunks = [];
        for (var i = 0; i < wordObjs.length; i += chunkSize) {
            var part = wordObjs.slice(i, i + chunkSize);
            var partStart = startSec + duration * (i / wordObjs.length);
            var partEnd = startSec + duration * (Math.min(i + chunkSize, wordObjs.length) / wordObjs.length);
            chunks.push(mk(part, partStart, partEnd));
        }
        return chunks;
    }
```

**(b)** In `buildPhrasePlan`, replace the word-split + chunk lines (~157, ~160) and the `selectAnchors` call (~163). Find:

```js
            var words = normalizedWords(line.text || '');
            var duration = Math.max(0.001, endSec - startSec);
            var shouldSplit = words.length > 14 || (words.length / duration) > 3.5;
            var chunks = shouldSplit ? chunkWords(words, startSec, endSec) : [{ words: words, startSec: startSec, endSec: endSec }];
```

Replace with:

```js
            var wordObjs = splitLyricWordsWithParens(line.text || '');
            var words = wordObjs.map(function (o) { return o.word; });
            var duration = Math.max(0.001, endSec - startSec);
            var shouldSplit = words.length > 14 || (words.length / duration) > 3.5;
            var chunks = shouldSplit
                ? chunkWords(wordObjs, startSec, endSec)
                : [{ words: words, wordObjs: wordObjs, startSec: startSec, endSec: endSec }];
```

Then find the `selectAnchors` call (~163):

```js
                var anchors = selectAnchors(chunk.words, difficulty);
```

Replace with:

```js
                var anchors = selectAnchors(chunk.wordObjs, difficulty);
```

**(c)** Change `selectAnchors` to consume `{word, inParen}` objects. Replace its body up to the fallback (lines ~80-99). Find:

```js
    function selectAnchors(words, difficultyProfile) {
        var anchors = [];
        for (var i = 0; i < words.length; i++) {
            var word = words[i];
            var wordClass = classifyWord ? classifyWord(word, false) : 'core';
            if (!word || word.length < 3) continue;
            if (wordClass === 'function' || wordClass === 'adlib') continue;
            if (REPEATED_FILLER[word] || isAdlibWord(word)) continue;
            var weight = WORD_WEIGHTS[wordClass] || 1.0;
            if (i === words.length - 1 || i === words.length - 2) weight += 0.2;
            if (word.length >= 6) weight += 0.15;
            anchors.push({
                anchorIdx: anchors.length,
                wordIdx: i,
                word: word,
                wordClass: wordClass,
                weight: parseFloat(weight.toFixed(3)),
                phonetic: scoring.doubleMetaphone ? scoring.doubleMetaphone(word) : undefined
            });
        }
```

Replace with (note `words` is now an array of `{word, inParen}`):

```js
    function selectAnchors(words, difficultyProfile) {
        var anchors = [];
        for (var i = 0; i < words.length; i++) {
            var word = words[i] ? words[i].word : '';
            var inParen = !!(words[i] && words[i].inParen);
            var wordClass = classifyWord ? classifyWord(word, inParen) : 'core';
            if (!word || word.length < 3) continue;
            if (wordClass === 'function' || wordClass === 'adlib') continue;
            if (REPEATED_FILLER[word] || isAdlibWord(word)) continue;
            var weight = WORD_WEIGHTS[wordClass] || 1.0;
            if (i === words.length - 1 || i === words.length - 2) weight += 0.2;
            if (word.length >= 6) weight += 0.15;
            anchors.push({
                anchorIdx: anchors.length,
                wordIdx: i,
                word: word,
                wordClass: wordClass,
                weight: parseFloat(weight.toFixed(3)),
                phonetic: scoring.doubleMetaphone ? scoring.doubleMetaphone(word) : undefined
            });
        }
```

Then fix the all-filler fallback just below it (lines ~104-118), which still reads bare strings. Find:

```js
        if (anchors.length === 0 && words.length > 0) {
            for (var fi = 0; fi < words.length; fi++) {
                var fw = words[fi];
                if (!fw) continue;
```

Replace with:

```js
        if (anchors.length === 0 && words.length > 0) {
            for (var fi = 0; fi < words.length; fi++) {
                var fw = words[fi] ? words[fi].word : '';
                if (!fw) continue;
```

(The rest of the fallback — `word: fw`, `phonetic: ...doubleMetaphone(fw)` — already uses `fw`, now a string, so it is unchanged and correct.)

- [ ] **Step 4: Run to verify it passes**

Run: `node tests/test_anchor_selection.cjs`
Expected: PASS — `anchor-selection: 5 checks passed`.

- [ ] **Step 5: Run the existing phrase-engine suite (no regression)**

Run: `node tests/test_phrase_engine.cjs`
Expected: `Phrase engine tests passed.` (the engine still builds plans correctly with the new object-carrying chunks).

- [ ] **Step 6: Commit**

```bash
git add static/phrase-engine.js tests/test_anchor_selection.cjs
git commit -m "fix(anchors): exclude parenthetical adlibs from anchors (plumb inParen)"
```

---

## Task 3: Fix B — force-all relief in `anchorsRequired`

**Files:**
- Modify: `static/phrase-engine.js` — `buildPhrasePlan` (~164, right after the ratio computation)
- Test: `tests/test_anchor_selection.cjs`

- [ ] **Step 1: Add the failing tests**

Append to `tests/test_anchor_selection.cjs` (before the final `console.log`):

```js
// --- Task 3: Fix B — don't force ALL anchors on lines big enough to spare one ---
function planFor(text, difficulty) {
  return PE.buildPhrasePlan([{ time: 0, text: text }], { difficulty: difficulty }).phrases[0];
}
// 4 content words at low WPS -> 4 anchors (no split, no fast-tempo floor on an 8s line)
check('N=4 Expert: ceil(4*0.8)=4 force-all -> capped to 3', () => {
  const p = planFor('shadows dancing rivers mountains', 'expert');
  assert.strictEqual(p.anchors.length, 4);
  assert.strictEqual(p.anchorsRequired, 3);
});
check('N=4 Medium: ceil(4*0.45)=2 (not force-all) -> unchanged', () => {
  assert.strictEqual(planFor('shadows dancing rivers mountains', 'medium').anchorsRequired, 2);
});
check('N=2 Expert: short line not collapsed -> still 2', () => {
  const p = planFor('shadows dancing', 'expert');
  assert.strictEqual(p.anchors.length, 2);
  assert.strictEqual(p.anchorsRequired, 2);
});
check('N=5 Expert: ceil(5*0.8)=4 < 5 (has headroom) -> unchanged', () => {
  const p = planFor('shadows dancing rivers mountains thunder', 'expert');
  assert.strictEqual(p.anchors.length, 5);
  assert.strictEqual(p.anchorsRequired, 4);
});
check('Easy never force-all: N=4 -> 1', () => {
  assert.strictEqual(planFor('shadows dancing rivers mountains', 'easy').anchorsRequired, 1);
});
```

- [ ] **Step 2: Run to verify the N=4 Expert case fails**

Run: `node tests/test_anchor_selection.cjs`
Expected: FAIL on "N=4 Expert … capped to 3" — today `anchorsRequired` is 4 (forces all), so it asserts `4 === 3` and throws.

- [ ] **Step 3: Implement the cap**

In `static/phrase-engine.js` `buildPhrasePlan`, find the requirement computation (~164):

```js
                var anchorsRequired = anchors.length > 0 ? Math.max(1, Math.ceil(anchors.length * difficulty.requiredAnchorRatio)) : 0;
```

Insert immediately after it:

```js
                // Force-all relief: a line big enough to spare one anchor shouldn't require
                // EVERY one of them, so a single ASR-impossible word (e.g. "greaze", "velour")
                // can't sink a correctly-sung line. Only triggers when the ratio rounds up to
                // all N AND there are >=4 anchors (short 2-3 anchor lines keep needing all, so
                // they can't collapse). Auto-scales by difficulty: force-all only happens at
                // high ratios, so Easy/Medium never reach it. Lowers only, never raises.
                if (anchors.length >= 4 && anchorsRequired >= anchors.length) {
                    anchorsRequired = anchors.length - 1;
                }
```

(This sits *before* the existing fast-tempo floor at ~169-172; both only lower `anchorsRequired`, so they compose — the floor `min()`s further on high-WPS lines.)

- [ ] **Step 4: Run to verify it passes**

Run: `node tests/test_anchor_selection.cjs`
Expected: PASS — `anchor-selection: 10 checks passed`.

- [ ] **Step 5: Commit**

```bash
git add static/phrase-engine.js tests/test_anchor_selection.cjs
git commit -m "fix(anchors): force-all relief — cap anchorsRequired at N-1 for N>=4"
```

---

## Task 4: §3C — per-anchor detail in `getPhraseTrace`

**Files:**
- Modify: `static/phrase-engine.js` — `getPhraseTrace` (~736-760)
- Test: `tests/test_anchor_selection.cjs`

- [ ] **Step 1: Add the failing test**

Append to `tests/test_anchor_selection.cjs` (before the final `console.log`):

```js
// --- Task 4: per-anchor trace detail (§3C) ---
check('getPhraseTrace exposes per-anchor word/wordClass/weight/hit', () => {
  const plan = PE.buildPhrasePlan(
    [{ time: 0, text: 'shadows dancing (forever) tonight' }],
    { difficulty: 'expert' }
  );
  const phrase = plan.phrases[0];
  // minimal session: mark the first (sorted) anchor as hit via its anchorIdx
  const state = {
    anchorHits: {}, status: 'open', lyricStatus: 'partial', accuracyStatus: 'missing',
    flowStatus: 'silent', cleared: false, rescuedByWhisper: false, liveClean: false,
    evidence: [], consumedTokens: [], rejectedCandidates: [], flowEvents: [], overflow: {}
  };
  state.anchorHits[phrase.anchors[0].anchorIdx] = { word: phrase.anchors[0].word };
  const session = { plan: plan, states: {} };
  session.states[phrase.phraseId] = state;

  const trace = PE.getPhraseTrace(session)[0];
  assert.strictEqual(trace.anchors.length, phrase.anchors.length);
  assert.ok(trace.anchors.every(a =>
    typeof a.word === 'string' && typeof a.wordClass === 'string' &&
    typeof a.weight === 'number' && typeof a.hit === 'boolean'));
  // the marked anchor reads hit:true, exactly one anchor is hit
  assert.strictEqual(trace.anchors.filter(a => a.hit).length, 1);
  assert.strictEqual(trace.anchors.find(a => a.word === phrase.anchors[0].word).hit, true);
  // Fix A guarantee: no adlib-class anchor survived (forever was excluded entirely)
  assert.ok(trace.anchors.every(a => a.wordClass !== 'adlib'));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/test_anchor_selection.cjs`
Expected: FAIL — `trace.anchors` is `undefined` (`getPhraseTrace` doesn't emit it yet).

- [ ] **Step 3: Implement the trace field**

In `static/phrase-engine.js` `getPhraseTrace`, find the returned object (it ends with `overflow: Object.assign({}, state.overflow)` ~line 758). Add an `anchors` field. Change:

```js
                anchorsHit: anchorsHit,
                anchorsRequired: phrase.anchorsRequired,
```

to:

```js
                anchorsHit: anchorsHit,
                anchorsRequired: phrase.anchorsRequired,
                anchors: (phrase.anchors || []).map(function (a) {
                    return {
                        word: a.word,
                        wordClass: a.wordClass,
                        weight: a.weight,
                        hit: !!state.anchorHits[a.anchorIdx]
                    };
                }),
```

- [ ] **Step 4: Run to verify it passes**

Run: `node tests/test_anchor_selection.cjs`
Expected: PASS — `anchor-selection: 11 checks passed`.

- [ ] **Step 5: Run the full suite (no regression)**

Run (PowerShell):
```powershell
node tests/test_anchor_selection.cjs; node tests/test_phrase_engine.cjs; node tests/test_scoring_session.cjs; node tests/test_match_helpers.cjs; node tests/test_sync_helpers.cjs; node tests/test_commit_helpers.cjs; python -m pytest tests/test_app.py tests/test_downloader.py tests/test_lyrics.py -q
```
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add static/phrase-engine.js tests/test_anchor_selection.cjs
git commit -m "feat(telemetry): per-anchor detail in getPhraseTrace (word/class/weight/hit)"
```

---

## Task 5: Validation — A + B together on the replay corpus + sing-test

**Files:** none (validation only). The two fixes **compound** (A reduces N, B reduces required-from-N), so validate together — never independently.

- [ ] **Step 1: Re-derive the Praise The Lord partials with the fixes**

The honest replay needs the app + a real run, but the *anchor selection* can be checked offline. Run the app (`python app.py`), reload `/player` with a **hard refresh**, and re-run A$AP Rocky — Praise The Lord on **Expert** (press `V`, then `D`). Download the telemetry.

In the new telemetry's `phraseEngine.traces`, use the new `anchors[]` to confirm, per line:
- **Fix A:** no anchor has `wordClass: "adlib"` arising from a parenthetical (parenthetical content no longer appears in `anchors[]`).
- **Fix B:** the greaze (line ~33) and velour (line ~15) lines now show `anchorsRequired` one below their anchor count, and `cleared: true` when you sang the rest.

- [ ] **Step 2: Confirm no cheese regression**

In the same run's `summary`, assert `honesty.suspectedCheeseInflation === false`, and re-run the cheese probes (silence / humming / "Ah" on cadence / finger-taps): they must still score **0 cleared** — the cap never lets you reach a positive requirement from zero hits.

- [ ] **Step 3: Confirm short lines didn't over-clear**

Scan the traces for any 2–3 anchor line that now clears with fewer than all anchors hit (there should be none — Fix B only touches `N≥4`). If A+B compounded a short line below intent, tune: raise the Fix-B threshold or revisit Fix A's effect on that line. Record findings in the PR.

- [ ] **Step 4: Live sing-test (the gate)**

Confirm a correctly-sung greaze/velour line now clears, the cheese probes still fail, and the honest-% on a clean run is **≥** its pre-fix value (these fixes should only ever raise or hold it). This is the standing gate before any `karaokee_v2` flag-flip.

---

## Self-Review (completed by plan author)

- **Spec coverage:** §3A paren fix → Tasks 1+2. §3B force-all relief → Task 3. §3C per-anchor trace → Task 4 (bestScore deferred per spec's "drop if not worth it"). §4 module boundaries/tests → all golden tests in `tests/test_anchor_selection.cjs`. §5 validate-together → Task 5. §7 rollout (no flag, V2 path) → respected (no flag touched).
- **Placeholder scan:** none — every code step shows complete before/after code; commands have expected output. `bestScore` is explicitly deferred, not a placeholder.
- **Type/name consistency:** `splitLyricWordsWithParens` returns `[{word, inParen}]` (Task 1) and is consumed identically by `chunkWords`/`buildPhrasePlan`/`selectAnchors` (Task 2). `chunk.wordObjs` (set in Task 2's `chunkWords` + the non-split branch) is exactly what `selectAnchors` reads. The trace `anchors[]` shape `{word, wordClass, weight, hit}` (Task 4) matches the test assertions and `phrase.anchors`/`state.anchorHits` field names.
- **Known soft spot:** Task 5's thresholds (`N≥4`) are validated against the 6 partials + cheese probes, not asserted in unit tests — by design (the spec calls for data-driven tuning).
