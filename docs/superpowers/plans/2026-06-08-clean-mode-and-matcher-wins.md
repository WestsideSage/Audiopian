# Clean/Explicit Mode + Matcher QoL Wins — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in Clean mode (profanity never required as a key word + masked on screen, hard-R n-word never scored) and a substantial-affix match rule (so `battle`→`battlecry` scores), without touching architecture or opening cheese.

**Architecture:** A new pure UMD helper `static/profanity.js` (word sets + masking) is consumed lazily by `scoring.js` (never-score guard + affix rule) and `phrase-engine.js` (`selectAnchors` exclusions). A `cleanMode` localStorage boolean threads through `buildPhrasePlan({clean})` and gates display censoring in `player.js`'s two render functions. Default Explicit; everything degrades to today's behavior when the helper is absent.

**Tech Stack:** Plain ES5-style browser JS (UMD wrappers, `var`/functions — works in `<script>` and Node `require()`), `node:assert` `.cjs` golden tests, pytest for the Flask harness.

**Spec:** `docs/superpowers/specs/2026-06-08-clean-mode-and-matcher-wins-design.md`

---

## File Structure

- **`static/profanity.js`** *(new)* — `window.KaraokeeProfanity`: `isProfane`, `isNeverScore`, `censorWord`, `censorLine`. Pure, UMD, no deps.
- **`tests/test_profanity.cjs`** *(new)* — golden tests for the helper.
- **`static/scoring.js`** *(modify)* — lazy `_profanity()` resolver; `isSubstantialAffix`; never-score guard + affix branch in `wordsMatch`/`wordsMatchScore`.
- **`tests/test_scoring.cjs`** *(modify)* — add profanity to the `require` shim; add affix + cheese-guard + never-score cases.
- **`static/phrase-engine.js`** *(modify)* — lazy `_profanity()`; `selectAnchors(words, profile, opts)` profanity/never-score exclusions + fallback guard; `buildPhrasePlan` passes `clean`.
- **`tests/test_phrase_engine.cjs`** *(modify)* — clean-mode anchor exclusion + hard-R + fallback tests.
- **`static/player.html`** *(modify)* — load `profanity.js`; add Clean toggle button to the diff-gate.
- **`static/player.js`** *(modify)* — read `cleanMode`, pass `clean` to both `buildPhrasePlan` calls, censor both render functions, wire the toggle.
- **`CLAUDE.md`** *(modify)* — add `profanity.js` to the helper list + isolation list.

---

## Task 1: `profanity.js` helper + tests

**Files:**
- Create: `static/profanity.js`
- Create: `tests/test_profanity.cjs`

- [ ] **Step 1: Write the failing test** — Create `tests/test_profanity.cjs`:

```js
const assert = require('assert');
const P = require('../static/profanity.js');

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('  ok -', name); }

const hardR = 'nigga'.replace(/a$/, 'er');   // derive; avoid spelling the slur in source

check('isProfane: strong words + slurs, case/punctuation-insensitive', () => {
  assert.ok(P.isProfane('fuck'));
  assert.ok(P.isProfane('Shit,'));
  assert.ok(P.isProfane('bitches'));
  assert.ok(P.isProfane('nigga'));   // -a variant IS clean-mode profanity
  assert.ok(P.isProfane(hardR));     // hard-R is also profanity (censored in clean mode)
});

check('isProfane: mild words are NOT profane (strong + slurs only)', () => {
  assert.ok(!P.isProfane('damn'));
  assert.ok(!P.isProfane('hell'));
  assert.ok(!P.isProfane('ass'));
  assert.ok(!P.isProfane('hello'));
});

check('isNeverScore: hard-R only, not the -a variant', () => {
  assert.ok(P.isNeverScore(hardR));
  assert.ok(P.isNeverScore(hardR + 's'));
  assert.ok(!P.isNeverScore('nigga'));   // -a variant is scoreable in explicit mode
  assert.ok(!P.isNeverScore('fuck'));
});

check('censorWord: keep first letter, mask the rest, preserve punctuation', () => {
  assert.strictEqual(P.censorWord('fuck'), 'f***');
  assert.strictEqual(P.censorWord('Shit,'), 'S***,');
  assert.strictEqual(P.censorWord('a'), 'a');
});

check('censorLine: masks only profane tokens, preserves spacing & clean words', () => {
  assert.strictEqual(P.censorLine('you fuckin know'), 'you f***** know');
  assert.strictEqual(P.censorLine('damn that hello'), 'damn that hello');
});

console.log('profanity: ' + passed + ' checks passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test_profanity.cjs`
Expected: FAIL — `Cannot find module '../static/profanity.js'`.

- [ ] **Step 3: Write minimal implementation** — Create `static/profanity.js`:

```js
/**
 * Pure helper: profanity classification + display masking for Clean mode.
 * No DOM / wall-clock / randomness — testable in Node.js. UMD (browser <script> + require()).
 *
 * - isProfane(word): clean-mode set (strong words + slurs, INCLUDING the song-standard
 *   "-a" n-word variant). Excludes mild words (damn/hell/ass). Used to exclude key words
 *   and to mask the displayed lyrics in clean mode.
 * - isNeverScore(word): strict subset = the hard-R n-word variant(s) only. Applied in ALL
 *   modes (never an anchor, never credits) — a content-policy guard.
 * - censorWord / censorLine: display masking only (scoring uses the raw normalized words).
 */
(function (root) {
    'use strict';
    function set(list) { var o = {}; for (var i = 0; i < list.length; i++) o[list[i]] = true; return o; }

    // Song-standard "-a" n-word variant: censored/excluded in clean mode, but a normal
    // creditable key word in explicit mode (the hard-R policy lives in NEVER_SCORE below).
    var N_A = ['nigga', 'niggas'];

    var PROFANE = set([
        'fuck','fucks','fucked','fuckin','fucking','fucker','fuckers','fuckboy',
        'motherfucker','motherfuckers','motherfuckin','motherfucking',
        'shit','shits','shitted','shitting','shitty','bullshit',
        'bitch','bitches','bitchin','bitching',
        'dick','dicks','cock','cocks','pussy','pussies','cunt','cunts',
        'whore','whores','slut','sluts','twat',
        'faggot','faggots','fag','fags'
    ].concat(N_A));

    // Hard-R variant(s) — DERIVED from the -a entries (trailing vowel -> "-er") so the slur
    // is never spelled literally in source. Never an anchor, never credits, in ANY mode.
    var NEVER_SCORE = set(N_A.map(function (w) { return w.replace(/a(s?)$/, 'er$1'); }));
    Object.keys(NEVER_SCORE).forEach(function (w) { PROFANE[w] = true; }); // also censored in clean mode

    function norm(word) { return String(word || '').toLowerCase().replace(/[^a-z]/g, ''); }

    function isProfane(word) { return !!PROFANE[norm(word)]; }
    function isNeverScore(word) { return !!NEVER_SCORE[norm(word)]; }

    // Keep the first character, replace remaining letters with '*', preserve other chars.
    function censorWord(word) {
        var w = String(word || '');
        if (w.length <= 1) return w;
        return w.charAt(0) + w.slice(1).replace(/[A-Za-z]/g, '*');
    }

    // Mask only profane tokens; preserve original whitespace.
    function censorLine(text) {
        return String(text || '').split(/(\s+)/).map(function (tok) {
            return isProfane(tok) ? censorWord(tok) : tok;
        }).join('');
    }

    var api = {
        isProfane: isProfane, isNeverScore: isNeverScore,
        censorWord: censorWord, censorLine: censorLine,
        PROFANE: PROFANE, NEVER_SCORE: NEVER_SCORE
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.KaraokeeProfanity = api;
})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test_profanity.cjs`
Expected: `profanity: 5 checks passed`.

- [ ] **Step 5: Commit**

```bash
git add static/profanity.js tests/test_profanity.cjs
git commit -m "feat(scoring): add profanity helper (clean-mode set, hard-R never-score, censoring)"
```

---

## Task 2: never-score guard + substantial-affix match in `scoring.js`

**Files:**
- Modify: `static/scoring.js`
- Test: `tests/test_scoring.cjs`

- [ ] **Step 1: Write the failing tests** — In `tests/test_scoring.cjs`, (a) extend the `require` shim so `scoring.js` can resolve profanity, and (b) add cases. First, after the `syncHelpers` load (line ~18) add:

```js
var profanity = loadBrowserCommonJs(path.join(__dirname, '..', 'static', 'profanity.js'));
```

Then in the `scoring` loader's `require` shim (the function with `if (specifier === './match-helpers.js')`), add a branch before the `throw`:

```js
        if (specifier === './profanity.js') return profanity;
```

Then append these cases to the `matchCases` array (before the closing `];`):

```js
    // Substantial-affix: recognizer transcribed a prefix/suffix of the word (>=5 chars, >=60%)
    { spoken: 'battle', target: 'battlecry', method: 'affix', score: 1.0 },
    { spoken: 'tasteful', target: 'distasteful', method: 'affix', score: 1.0 },
    { spoken: 'reach', target: 'reached', method: 'affix', score: 1.0 },
    // Affix cheese guards: short common prefixes must NOT match
    { spoken: 'ever', target: 'everything', method: 'none', score: 0.0 },
    { spoken: 'over', target: 'overcome', method: 'none', score: 0.0 },
    { spoken: 'art', target: 'articulate', method: 'none', score: 0.0 }
```

Then after the `matchCases.forEach(...)` block, add explicit `wordsMatch` (boolean) assertions:

```js
var _hardR = 'nigga'.replace(/a$/, 'er');   // derived; avoid the literal slur in source
assert.strictEqual(scoring.wordsMatch('battle', 'battlecry'), true, 'affix wordsMatch battlecry');
assert.strictEqual(scoring.wordsMatch('ever', 'everything'), false, 'affix guard ever/everything');
assert.strictEqual(scoring.wordsMatch('nigga', 'nigga'), true, 'the -a variant still matches itself');
assert.strictEqual(scoring.wordsMatch(_hardR, _hardR), false, 'hard-R never matches');
assert.strictEqual(scoring.wordsMatchScore(_hardR, 'signed').score, 0.0, 'hard-R never credits');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test_scoring.cjs`
Expected: FAIL — first on the `require` shim (if not yet added) or on `battle -> battlecry method` (`none` !== `affix`).

- [ ] **Step 3: Write minimal implementation** — In `static/scoring.js`, inside the factory body (after `var classifyTempo = ...; var getWindowParams = ...;` near the top, before `function editDistance`), add the lazy resolver + affix helper:

```js
    function _profanity() {
        if (typeof module !== 'undefined' && module.exports) {
            try { return require('./profanity.js'); } catch (e) { return null; }
        }
        return (root && root.KaraokeeProfanity) || null;
    }
    function isNeverScore(w) {
        var p = _profanity();
        return !!(p && p.isNeverScore && p.isNeverScore(w));
    }
    // Recognizer transcribed a substantial prefix/suffix of the word (e.g. "battle" for
    // "battlecry"). Guarded so short common prefixes ("ever"/"everything") never match.
    function isSubstantialAffix(a, b) {
        if (!a || !b) return false;
        var shorter = a.length <= b.length ? a : b;
        var longer  = a.length <= b.length ? b : a;
        if (shorter.length < 5) return false;
        if (shorter.length / longer.length < 0.6) return false;
        return longer.indexOf(shorter) === 0 || longer.lastIndexOf(shorter) === longer.length - shorter.length;
    }
```

In `wordsMatch`, make the first line a never-score guard and add the affix branch before `return false;`:

```js
    function wordsMatch(spoken, target, targetPhonetic) {
        if (isNeverScore(spoken) || isNeverScore(target)) return false;
        if (spoken === target) return true;
```
…and immediately before the final `return false;`:
```js
        if (isSubstantialAffix(spoken, target)) return true;

        return false;
    }
```

In `wordsMatchScore`, add the same guard first and the affix branch before the final `return { score: 0.0, method: 'none' };`:

```js
    function wordsMatchScore(spoken, target, targetPhonetic) {
        if (isNeverScore(spoken) || isNeverScore(target)) return { score: 0.0, method: 'none' };
        if (spoken === target) return { score: 1.0, method: 'exact' };
```
…and immediately before the final `return { score: 0.0, method: 'none' };`:
```js
        if (isSubstantialAffix(spoken, target)) return { score: 1.0, method: 'affix' };

        return { score: 0.0, method: 'none' };
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test_scoring.cjs`
Expected: process exits 0 (the file asserts inline; no thrown AssertionError). Then run the dependent suites:
Run: `node tests/test_phrase_engine.cjs && node tests/test_scoring_session.cjs && node tests/test_phrase_score.cjs`
Expected: all pass (real `require` resolves `./profanity.js` natively).

- [ ] **Step 5: Commit**

```bash
git add static/scoring.js tests/test_scoring.cjs
git commit -m "feat(scoring): substantial-affix match + hard-R never-score guard"
```

---

## Task 3: clean-mode anchor exclusion in `phrase-engine.js`

**Files:**
- Modify: `static/phrase-engine.js`
- Test: `tests/test_phrase_engine.cjs`

- [ ] **Step 1: Write the failing tests** — In `tests/test_phrase_engine.cjs`, add (use the file's existing `require`/assert harness; these call the engine directly):

```js
// Clean mode: profanity is never a required key word; non-profane key words remain.
(function () {
  const lyrics = [{ time: 0, text: 'bitch I run this fucking city' }];
  const explicit = KPE.buildPhrasePlan(lyrics, { difficulty: 'expert' }).phrases[0];
  const clean = KPE.buildPhrasePlan(lyrics, { difficulty: 'expert', clean: true }).phrases[0];
  const cleanWords = clean.anchors.map(a => a.word);
  assert.ok(!cleanWords.includes('bitch') && !cleanWords.includes('fucking'),
    'clean mode drops profane anchors');
  assert.ok(cleanWords.includes('run') || cleanWords.includes('city'),
    'clean mode keeps clean key words');
  assert.ok(explicit.anchors.map(a => a.word).includes('bitch'),
    'explicit mode keeps profanity as an anchor');
  console.log('  ok - clean mode excludes profane anchors, keeps clean ones');
})();

// Hard-R is never an anchor, in either mode.
(function () {
  const hardR = 'nigga'.replace(/a$/, 'er');   // derived; avoid the literal slur in source
  const lyrics = [{ time: 0, text: hardR + ' please listen closely' }];
  const explicit = KPE.buildPhrasePlan(lyrics, { difficulty: 'expert' }).phrases[0];
  assert.ok(!explicit.anchors.map(a => a.word).includes(hardR),
    'hard-R never an anchor even in explicit mode');
  console.log('  ok - hard-R never selected as anchor');
})();

// A profanity-only line in clean mode is non-scoring (no filler fallback to profanity).
(function () {
  const lyrics = [{ time: 0, text: 'fuck shit bitch' }];
  const clean = KPE.buildPhrasePlan(lyrics, { difficulty: 'expert', clean: true }).phrases[0];
  assert.strictEqual(clean.anchorsRequired, 0, 'profanity-only line is non-scoring in clean mode');
  console.log('  ok - profanity-only line non-scoring in clean mode');
})();
```

> If `tests/test_phrase_engine.cjs` imports the engine under a different variable name than `KPE`, use that name. Confirm with the file's existing `require('../static/phrase-engine.js')` binding.

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test_phrase_engine.cjs`
Expected: FAIL — clean anchors still include `bitch`/`fucking` (the `clean` option is ignored) and/or the hard-R variant appears as an anchor.

- [ ] **Step 3: Write minimal implementation** — In `static/phrase-engine.js`:

(3a) Add a lazy resolver near the top of the factory body (after the `var ADLIB_WORDS = ...;` line):

```js
    function _profanity() {
        if (typeof module !== 'undefined' && module.exports) {
            try { return require('./profanity.js'); } catch (e) { return null; }
        }
        return (root && root.KaraokeeProfanity) || null;
    }
    function _isProfane(w)    { var p = _profanity(); return !!(p && p.isProfane && p.isProfane(w)); }
    function _isNeverScore(w) { var p = _profanity(); return !!(p && p.isNeverScore && p.isNeverScore(w)); }
```

(3b) Change `selectAnchors(words, difficultyProfile)` to accept options and exclude profanity. Update the signature and add exclusions inside the main loop (after the `if (REPEATED_FILLER[word] || isAdlibWord(word)) continue;` line):

```js
    function selectAnchors(words, difficultyProfile, opts) {
        var clean = !!(opts && opts.clean);
```
…and inside the loop, after the existing filler/adlib `continue`:
```js
            if (_isNeverScore(word)) continue;               // all modes
            if (clean && _isProfane(word)) continue;          // clean mode only
```
…and in the empty-anchors fallback loop, after `if (!fw) continue;`:
```js
                if (_isNeverScore(fw)) continue;
                if (clean && _isProfane(fw)) continue;
```

(3c) In `buildPhrasePlan`, thread the option. Where it calls `selectAnchors(chunk.wordObjs, difficulty)`, change to:

```js
                var anchors = selectAnchors(chunk.wordObjs, difficulty, { clean: !!options.clean });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test_phrase_engine.cjs`
Expected: the three new `ok -` lines print; file exits 0.

- [ ] **Step 5: Commit**

```bash
git add static/phrase-engine.js tests/test_phrase_engine.cjs
git commit -m "feat(scoring): clean-mode anchor exclusion + hard-R guard in selectAnchors"
```

---

## Task 4: load `profanity.js` + Clean toggle UI in `player.html`

**Files:**
- Modify: `static/player.html`

- [ ] **Step 1: Add the script tag** — before `scoring.js` (so it's on `window` when scoring's factory first resolves it). Change:

```html
    <script src="/static/match-helpers.js"></script>
    <script src="/static/scoring.js"></script>
```
to:
```html
    <script src="/static/match-helpers.js"></script>
    <script src="/static/profanity.js"></script>
    <script src="/static/scoring.js"></script>
```

- [ ] **Step 2: Add the Clean toggle button** to the diff-gate. After the `<button class="diff-gate-listen ctrl-btn" onclick="justListen()">Just listen — no scoring</button>` line, add:

```html
                <button class="diff-gate-listen ctrl-btn" id="cleanModeToggle" type="button" aria-pressed="false" style="margin-top:6px;">Clean mode: Off</button>
```

- [ ] **Step 3: Verify the page still loads** (no JS yet — wiring is Task 5).

Run: `node --check static/player.js` (sanity — unchanged here) and visually confirm the HTML edit.
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add static/player.html
git commit -m "feat(player): load profanity.js + add Clean mode toggle button"
```

---

## Task 5: wire Clean mode in `player.js` (read flag, pass `clean`, censor renders, toggle handler)

**Files:**
- Modify: `static/player.js`

- [ ] **Step 1: Read the flag and pass `clean` to the game plan.** At line ~174 (after `this._phraseDifficulty = localStorage.getItem('arcadeDifficulty') || 'medium';`) add:

```js
        this._cleanMode = localStorage.getItem('cleanMode') === '1';
```
…and in the `buildPhrasePlan` call at ~176, add the option:
```js
            this._phrasePlan = KaraokeePhraseEngine.buildPhrasePlan(lyrics, {
                difficulty: this._phraseDifficulty,
                audioDuration: playback ? (playback.duration() || null) : null,
                clean: this._cleanMode
            });
```

- [ ] **Step 2: Pass `clean` to the difficulty-preview plan.** At ~2195 (inside `renderDifficultyPreview`), change the `buildPhrasePlan` call to:

```js
        plan = KaraokeePhraseEngine.buildPhrasePlan(lyrics, {
            difficulty: d,
            audioDuration: playback ? (playback.duration() || null) : null,
            clean: localStorage.getItem('cleanMode') === '1'
        });
```

- [ ] **Step 3: Censor the passive render.** In `renderLyrics()` (~1902), read the flag and censor the line text:

```js
function renderLyrics() {
    var clean = localStorage.getItem('cleanMode') === '1';
    lyricsScroll.innerHTML = '';
    lyrics.forEach((line, i) => {
        const el = document.createElement('div');
        el.className = 'lyric-line';
        el.textContent = (clean && window.KaraokeeProfanity) ? KaraokeeProfanity.censorLine(line.text) : line.text;
        el.dataset.index = i;
        lyricsScroll.appendChild(el);
    });
}
```

- [ ] **Step 4: Censor the game-mode render.** In `renderLyricsGameMode()` (~1913), read the flag once and censor each profane word span:

```js
function renderLyricsGameMode() {
    var clean = localStorage.getItem('cleanMode') === '1';
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
            span.textContent = (clean && window.KaraokeeProfanity && KaraokeeProfanity.isProfane(normalizeWord(word)))
                ? KaraokeeProfanity.censorWord(word) : word;
            el.appendChild(span);
            if (wi < words.length - 1) el.appendChild(document.createTextNode(' '));
        });

        lyricsScroll.appendChild(el);
    });
    _tagAnchorSpans();
}
```

- [ ] **Step 5: Wire the toggle.** Inside the `initDifficultyGate` IIFE (~2275), after the existing `cards.addEventListener(...)` wiring (before the IIFE closes), add:

```js
    var cleanBtn = document.getElementById('cleanModeToggle');
    if (cleanBtn) {
        var _paintClean = function () {
            var on = localStorage.getItem('cleanMode') === '1';
            cleanBtn.textContent = 'Clean mode: ' + (on ? 'On' : 'Off');
            cleanBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
        };
        _paintClean();
        cleanBtn.addEventListener('click', function () {
            var on = localStorage.getItem('cleanMode') === '1';
            localStorage.setItem('cleanMode', on ? '0' : '1');
            _paintClean();
            // Re-render the preview + lyrics so masking updates live.
            try { renderDifficultyPreview(localStorage.getItem('arcadeDifficulty') || 'medium'); } catch (e) {}
            try { (gameMode && gameMode.active ? renderLyricsGameMode : renderLyrics)(); } catch (e) {}
        });
    }
```

- [ ] **Step 6: Verify syntax + full suite green.**

Run: `node --check static/player.js`
Expected: no output (valid).
Run: `for f in tests/*.cjs; do node "$f" >/dev/null || echo "FAIL $f"; done`
Expected: no `FAIL` lines.

- [ ] **Step 7: Commit**

```bash
git add static/player.js
git commit -m "feat(player): wire Clean mode — pass clean to plan, censor renders, toggle handler"
```

---

## Task 6: docs + full verification

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Document the helper.** In `CLAUDE.md`, after the `share-card.js` / `alternatives.js` helper bullet, add:

```markdown
- **`profanity.js`** (`window.KaraokeeProfanity`) — pure `isProfane` / `isNeverScore` / `censorWord` / `censorLine` for Clean mode: profanity is excluded from key-word selection (`selectAnchors`) and masked in the displayed lyrics; the hard-R n-word is additionally `isNeverScore` (never an anchor, never credits, in any mode). Consumed lazily by `scoring.js` + `phrase-engine.js`. Tested in `test_profanity.cjs`.
```
…and add `` `profanity.js` `` to the UMD-wrapper list in the "JS helper isolation pattern" paragraph.

- [ ] **Step 2: Full verification.**

Run: `for f in tests/*.cjs; do node "$f" >/dev/null || echo "FAIL $f"; done`
Expected: no `FAIL`.
Run: `python -m pytest tests/test_app.py tests/test_downloader.py tests/test_lyrics.py -q`
Expected: `55 passed`.
Run: `node --check static/profanity.js && node --check static/player.js`
Expected: no errors.

- [ ] **Step 3: Manual smoke (local).** `python app.py`, open `/player` with an explicit song:
  - Toggle Clean: On → curse words show masked (`f***`) and the preview key words avoid profanity.
  - Start a run, sing a clean line over a cursing line → it scores on the clean key words; you're not dinged for skipped curses.
  - Toggle Off → explicit behavior returns.
  - Re-sing a `battlecry`-type line → it now scores.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add profanity.js helper + Clean mode to CLAUDE.md"
```

---

## Self-Review

**Spec coverage:**
- Clean-mode toggle (default Explicit, localStorage) → Tasks 4–5. ✓
- Profanity excluded from key words (strong + slurs; not damn/hell/ass) → Task 1 (set) + Task 3 (`selectAnchors`). ✓
- Display censoring (clean mode only) → Task 5 Steps 3–4. ✓
- Hard-R never an anchor + never credits, all modes → Task 2 (matcher guard) + Task 3 (`selectAnchors`). ✓
- No -a↔hard-R mapping; -a variant normal in explicit → Task 1 (-a ∉ NEVER_SCORE) + test_scoring -a self-match. ✓
- Substantial-affix match (≥5 / ≥60%) with cheese guards → Task 2. ✓
- Profanity-only line non-scoring in clean mode (no filler fallback) → Task 3 Step 3b fallback guard + test. ✓
- Not doing a dynamic per-song map → nothing added. ✓

**Placeholder scan:** All code steps contain full code; all commands have expected output. No TBD/TODO. ✓

**Type/name consistency:** `KaraokeeProfanity.{isProfane,isNeverScore,censorWord,censorLine}` used identically across scoring.js, phrase-engine.js, player.js, and tests. `buildPhrasePlan({clean})` → `selectAnchors(words, profile, {clean})` consistent. `cleanMode` localStorage key consistent across player.js read sites and the toggle. ✓

**Known acceptance (from spec):** `must←mustve` stays unfixed (4 chars); rare `should/shoulder`-class affix collisions accepted; difficulty preview is censored via re-render but is a minor surface. ✓
