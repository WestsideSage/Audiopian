# Scoring-Session Seam Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the entire per-line/per-run scoring state machine out of the `player.js` `GameMode` controller into a new DOM-free, Node-testable module `static/scoring-session.js` (`window.KaraokeeScoringSession`), so the reconciliation/commit sequencing where the real bugs live becomes unit-testable, with zero runtime behavior change.

**Architecture:** A `ScoringSession` is a plain-data state object created by `createSession(config)` and driven by a small interface — `ingestFinal`/`ingestInterim`/`setEnergy` feed it, `setActiveLine`/`tick`/`endRun` advance it and **return arrays of render-intent events** (`lineScored`, `wordMatched`, `phraseCleared`, `phraseMissed`, `arcade`, `honestPct`, …). The session owns `matchedSet`/`vad`/`asr` sets, tallies, `phraseSession`, `arcadeState`, `committedPhrases`, and `prevLine`; it calls the already-pure engines (`scoring.js`, `phrase-engine.js`, `scoring-arcade.js`) and reads **no DOM and no clock** — the wall/media clock is passed in as `now`. The controller keeps the `audio` element, `AudioContext`, VAD analyser, and transcription source; it feeds the session, drives `tick(now)` from the 100 ms `updateLyrics` loop, and **renders** the returned events.

**Tech Stack:** Plain browser JS (UMD module pattern, `var`/`function` for Node `require()` testability), Node `assert`-based scripted tests (`tests/*.cjs`), Flask/pytest for the unchanged server.

**Design decisions (locked):** full-scope extraction · events-as-data out · preserve-current-feeding in · characterization-first safety. See the grilling record in session; domain vocabulary in [CONTEXT.md](../../../CONTEXT.md).

---

## Key constraints & gotchas (read before starting)

1. **Behavior-preserving.** This repo has a scoring-regression retrospective on record. Every move is a characterization-tested transform, not a rewrite. When current logic is subtle, reproduce it verbatim and only apply the three mechanical transforms below.

2. **The three mechanical transforms** applied when moving a method into the session:
   - `this.X` → `s.X` (the session object is the first param, named `s`).
   - `audio.currentTime` / `performance.now()` → the `now` parameter (seconds, media time). **No clock reads inside the session.**
   - Any DOM call (`lyricsScroll.querySelectorAll`, `document.createElement`, `.classList`, `#score-pct`) or telemetry call (`this._logMatch`, `this._updateRunningScore`, `this._paintPhraseCleared`) → **push an event** onto the returned `events` array instead. The controller does the DOM/telemetry when it renders the event.

3. **Energy is NOT in telemetry (verified).** Real `output_telemetry/*.json` capture `asr[]` and `matches[]` but **no `energy`/`isSpeaking`/`vad`** trace, and the existing `test_telemetry_replay.cjs` replays only the `computeLineScore` layer (pre-built match sets). So the **primary** safety net is **scripted input→event sequence tests** in `tests/test_scoring_session.cjs` (synthetic `ingestFinal`/`setEnergy`/`tick` sequences asserting emitted events). Telemetry replay stays a **secondary** net for the score layer.

4. **`setActiveLine` clock/timer wrinkle.** Today it schedules `prevLine` finalization with `performance.now()` + `setTimeout`. In the session this becomes **tick-driven**: `prevLine.overlapEnd` is stored in **media seconds** (`now + overlapDuration + scoreDelay`) and `tick(now)` finalizes when `now >= prevLine.overlapEnd`. This removes the timer and the wall-clock. It is the one intentional behavior nuance (media time freezes when audio pauses); Task 3.2 has a dedicated test.

5. **Telemetry-grade events.** `matches[]` telemetry entries carry `spokenWord/targetWord/method/editDistance/phoneticMatch/score/matched/windowPosition`. So the `wordMatched` event carries **all of these** (the renderer ignores the extra fields; the telemetry logger consumes them). One event stream, rich payload — no second stream.

6. **"Move-and-transform" steps are not placeholders.** Where a step says *"move `player.js:A–B` into `s.method`, applying the three transforms, pushing `{type:'…'}` where the DOM/telemetry call was"*, that is a complete, exact instruction: copy the real source lines (the engineer has the file open) and apply the named transforms. Full code is given for all new code (tests, skeleton, event factory, controller glue) and for the non-obvious transforms.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `static/scoring-session.js` | The per-run scoring state machine (`window.KaraokeeScoringSession`). DOM-free, clock-injected, events-out. | **Create.** UMD factory over `scoring.js`/`phrase-engine.js`/`scoring-arcade.js`/`sync-helpers.js`. |
| `tests/test_scoring_session.cjs` | Scripted input→event sequence tests (primary safety net). | **Create.** `node:assert`, flat script, prints `Scoring session tests passed.` |
| `static/player.js` | Karaoke controller (DOM/audio/IO + render). | **Modify.** Delete moved methods; add `_renderEvents(events)` dispatcher; wire feed (`ingestFinal`/`ingestInterim`/`setEnergy`) + `tick(now)`. |
| `static/player.html` | Script load order. | **Modify.** Add `<script src="/static/scoring-session.js"></script>` at line 533 (after `lyric-paint-helpers.js`, before `player.js`). |
| `CLAUDE.md` | Test commands + module map. | **Modify.** Add `node tests/test_scoring_session.cjs` to the JS test list; add `scoring-session.js` to the module map. |

**Test-style note:** `tests/*.cjs` are single flat scripts run top-to-bottom with `node:assert`; "run the test" = `node tests/test_scoring_session.cjs`, which exits non-zero on the first failing assertion. Use the `loadBrowserCommonJs` loader pattern already in `tests/test_phrase_score.cjs` / `tests/test_telemetry_replay.cjs`.

---

## The interface contract (single source of truth for all tasks)

```js
// createSession(config) -> session (plain object `s`)
// config: { lyrics, allWordTimings, phrasePlan, difficulty, flags:{KARAOKEE_V2} }
//   - phraseSession & arcadeState are created internally from phrasePlan/difficulty.
//
// Feed (no return):
//   ingestFinal(s, text, source)     // source: 'browser_sr' | 'browser_final' | 'whisper'
//   ingestInterim(s, text)
//   setEnergy(s, isSpeaking)
//
// Advance (return Event[]):
//   setActiveLine(s, lineIdx, now)   // finalize/snapshot outgoing line, set up new line
//   tick(s, now)                     // settle -> reconcile -> commit -> hot-word match -> honestPct
//   endRun(s, now)                   // final flush (commit settled, score last line)
//
// Query (no side effects):
//   getScores(s)      -> { weightedTotal, weightedMatched, totalWords, matchedWords,
//                          linesScored, perfectLines, currentStreak, bestStreak }
//   getHonestPct(s)   -> number | null
```

### Event shapes (exact — keep names consistent across every task)

```js
{ type:'lineScored',  lineIdx, matched, scoredTotal, missedWordIndices, perfect,
                      weightedTotal, weightedMatched }
{ type:'wordMatched', lineIdx, wordIndex, spokenWord, targetWord, method,
                      editDistance, phoneticMatch, score, matched, windowPosition, source }
{ type:'promotion',   source, wordIndex, score }
{ type:'phraseCleared', phraseId }
{ type:'phraseMissed',  phraseId }
{ type:'arcade',      evt }      // raw KaraokeeArcade.commitPhrase(...) result
{ type:'arcadeRecord', record }  // the per-phrase record appended to telemetry _arcadeEvents
{ type:'honestPct',   pct }
{ type:'transition',  fromIdx, toIdx, trigger, fromText, matchedCount, total,
                      missedWords, lineStartAudioTime, sourceCounts }
```

Helper used everywhere in the module:
```js
function ev(list, type, fields) { fields.type = type; list.push(fields); return list; }
```

---

## Phase 0 — Characterization harness + feasibility lock

Goal: prove energy-gated reconciliation is deterministically testable as a scripted sequence **before** building the module. Establishes the loader, the contract, and the riskiest test.

### Task 0.1: Test harness skeleton + simplest contract test

**Files:**
- Create: `tests/test_scoring_session.cjs`

- [ ] **Step 1: Write the harness + first failing test**

```js
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
function load(name, deps) {
    return loadBrowserCommonJs(path.join(S, name), Object.assign({
        require: function (spec) {
            var m = { './match-helpers.js': mh, './sync-helpers.js': sh,
                      './scoring.js': scoring, './phrase-engine.js': phrase,
                      './scoring-arcade.js': arcade }[spec];
            if (!m) throw new Error('Unexpected require: ' + spec);
            return m;
        }, globalThis: globalThis
    }, deps || {}));
}
var mh = loadBrowserCommonJs(path.join(S, 'match-helpers.js'));
var sh = loadBrowserCommonJs(path.join(S, 'sync-helpers.js'));
var scoring = load('scoring.js');
var phrase = load('phrase-engine.js');
var arcade = loadBrowserCommonJs(path.join(S, 'scoring-arcade.js'));
var session = load('scoring-session.js');

// Minimal one-line song; a single matching final should score the line.
function lyric(time, text) { return { time: time, text: text }; }
var cfg = {
    lyrics: [lyric(0, 'hello world')],
    allWordTimings: scoring.interpolateWordTimings([lyric(0, 'hello world')]),
    phrasePlan: null, difficulty: 'medium', flags: { KARAOKEE_V2: true }
};
var s = session.createSession(cfg);
var ev = session.setActiveLine(s, 0, 0.0);
session.ingestFinal(s, 'hello world', 'browser_sr');
var out = session.tick(s, 1.0);
var scored = out.filter(function (e) { return e.type === 'wordMatched'; });
assert.ok(scored.length >= 1, 'expected at least one wordMatched event for "hello world"');

console.log('Scoring session tests passed.');
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/test_scoring_session.cjs`
Expected: FAIL — `Cannot find module` / `createSession is not a function` (module not created yet).

- [ ] **Step 3: Commit the red harness**

```bash
git add tests/test_scoring_session.cjs
git commit -m "test(scoring-session): harness + first contract test (red)"
```

### Task 0.2: Module skeleton so the harness loads

**Files:**
- Create: `static/scoring-session.js`
- Modify: `static/player.html:532-533`

- [ ] **Step 1: Write the UMD skeleton with full state + stub methods**

```js
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory(require('./scoring.js'), require('./phrase-engine.js'),
                                 require('./scoring-arcade.js'), require('./sync-helpers.js'), root || globalThis);
    } else {
        root.KaraokeeScoringSession = factory(root.KaraokeeScoring, root.KaraokeePhraseEngine,
                                              root.KaraokeeArcade, root, root);
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (scoring, phraseEngine, arcade, sync, root) {
    'use strict';
    function ev(list, type, fields) { fields.type = type; list.push(fields); return list; }

    function createSession(config) {
        var s = {
            lyrics: config.lyrics || [],
            allWordTimings: config.allWordTimings || [],
            phrasePlan: config.phrasePlan || null,
            phraseSession: null,
            arcadeState: null,
            difficulty: config.difficulty || 'medium',
            flags: config.flags || {},
            // current line
            activeLineIdx: -1, lineWords: [], matchedSet: new Map(),
            vadMatchedSet: new Map(), asrConfirmedSet: new Set(), wordSourceMap: new Map(),
            transcript: '', transcriptWords: [], latestInterim: '',
            lineStartWordCount: 0, lineStartTranscriptPos: 0, lineHadAsrEvent: false,
            isSpeaking: false, hotWordIndex: -1, wordTimings: [],
            currentParams: sync.getWindowParams('normal'),
            // tallies
            weightedTotal: 0, weightedMatched: 0, totalWords: 0, matchedWords: 0,
            linesScored: 0, perfectLines: 0, currentStreak: 0, bestStreak: 0,
            // phrase/arcade
            committedPhrases: {}, arcadeEvents: [], prevLine: null, _lineStartAudioTime: null
        };
        if (s.phrasePlan && phraseEngine && phraseEngine.createPhraseSession) {
            s.phraseSession = phraseEngine.createPhraseSession(s.phrasePlan);
        }
        if (s.phrasePlan && arcade && arcade.createArcadeState) {
            s.arcadeState = arcade.createArcadeState(s.difficulty);
        }
        return s;
    }

    // Stubs — filled in by later tasks. Each returns an event list.
    function setActiveLine(s, lineIdx, now) { return []; }
    function ingestFinal(s, text, source) {}
    function ingestInterim(s, text) {}
    function setEnergy(s, isSpeaking) { s.isSpeaking = !!isSpeaking; }
    function tick(s, now) { return []; }
    function endRun(s, now) { return []; }
    function getScores(s) {
        return { weightedTotal: s.weightedTotal, weightedMatched: s.weightedMatched,
                 totalWords: s.totalWords, matchedWords: s.matchedWords, linesScored: s.linesScored,
                 perfectLines: s.perfectLines, currentStreak: s.currentStreak, bestStreak: s.bestStreak };
    }
    function getHonestPct(s) { return null; }

    return { createSession: createSession, setActiveLine: setActiveLine,
             ingestFinal: ingestFinal, ingestInterim: ingestInterim, setEnergy: setEnergy,
             tick: tick, endRun: endRun, getScores: getScores, getHonestPct: getHonestPct };
});
```

> **Note (verified during execution):** the real construction API is `KaraokeePhraseEngine.createPhraseSession(plan)` and `KaraokeeArcade.createArcadeState(difficulty)` (and `KaraokeePhraseEngine.buildPhrasePlan(lyrics, opts)` for fixtures). The skeleton above already uses the correct names. Confirmed: the module loads under Node with `node --check` clean and all dep APIs resolve (commit `9646dca`).

- [ ] **Step 2: Add the script tag**

Modify `static/player.html` — insert after line 532 (`lyric-paint-helpers.js`), before `player.js`:
```html
    <script src="/static/scoring-session.js"></script>
```

- [ ] **Step 3: Run harness — load must succeed**

Run: `node tests/test_scoring_session.cjs` and `node --check static/scoring-session.js`
Expected: parse OK; the test now runs and FAILS on the assertion (`expected at least one wordMatched event`) because `tick`/`ingest` are stubs. (Load works — that's the win.)

- [ ] **Step 4: Commit**

```bash
git add static/scoring-session.js static/player.html
git commit -m "feat(scoring-session): UMD skeleton + state shape (loads under Node)"
```

### Task 0.3: Energy-gated reconciliation characterization test (feasibility proof)

**Files:**
- Modify: `tests/test_scoring_session.cjs`

This encodes the `06dfde5` invariant: an ended line whose words appear only in the interim **with no in-window vocal energy** must NOT be reconciled/cleared; with energy, it must.

- [ ] **Step 1: Append the two-case test before the final `console.log`**

```js
// --- Energy-gated interim reconciliation (commit 06dfde5) ---
function twoLineCfg() {
    var L = [lyric(0, 'first line words'), lyric(2, 'second line words')];
    return { lyrics: L, allWordTimings: scoring.interpolateWordTimings(L),
             phrasePlan: buildPhrasePlanFromLyrics(L), difficulty: 'medium', flags: { KARAOKEE_V2: true } };
}
// (A) No energy while line 1 is active+ended -> its words arriving in interim do NOT clear it.
(function () {
    var s = session.createSession(twoLineCfg());
    session.setActiveLine(s, 0, 0.0);
    session.setEnergy(s, false);                 // silent
    session.ingestInterim(s, 'first line words');// words present but no energy
    session.setActiveLine(s, 1, 2.0);            // line 1 ends
    var out = session.tick(s, 2.1);
    var cleared = out.filter(function (e) { return e.type === 'phraseCleared'; });
    assert.strictEqual(cleared.length, 0, 'silent interim must NOT reconcile/clear the ended line');
})();
// (B) With energy, the same words DO clear line 1.
(function () {
    var s = session.createSession(twoLineCfg());
    session.setActiveLine(s, 0, 0.0);
    session.setEnergy(s, true);                  // singing
    session.ingestInterim(s, 'first line words');
    session.setActiveLine(s, 1, 2.0);
    var out = session.tick(s, 2.1);
    var cleared = out.filter(function (e) { return e.type === 'phraseCleared'; });
    assert.ok(cleared.length >= 1, 'energized interim SHOULD reconcile/clear the ended line');
})();
```

> `buildPhrasePlanFromLyrics` is a tiny test helper: call the same phrase-plan builder the app uses at game start (find it in `player.js` `start()` — it constructs `this._phrasePlan` from `KaraokeePhraseEngine`). Define it once at the top of the test file by calling that builder so fixtures match production phrase grouping.

- [ ] **Step 2: Run — expect FAIL on case (B)** (stubs emit nothing)

Run: `node tests/test_scoring_session.cjs`
Expected: FAIL at case (B) assertion. Case (A) passes trivially (stub emits nothing) — that's fine; it becomes meaningful once reconciliation is wired.

- [ ] **Step 3: Commit the feasibility-locking test**

```bash
git add tests/test_scoring_session.cjs
git commit -m "test(scoring-session): energy-gated reconciliation characterization (red)"
```

**Phase 0 exit criterion:** the harness loads the module, drives the full interface, and the energy-gated reconciliation behavior is expressible as a deterministic scripted assertion. Feasibility proven.

---

## Phase 1 — Move the pure, no-DOM methods

Each task: write/extend the characterization test (red), move-and-transform the method, run (green), commit. Source line numbers are **current `player.js`** (post-#1); re-grep if they drift.

### Task 1.1: `_resetLineState` + `_resetSessionCounters` + `getHonestPct`

**Files:**
- Modify: `static/scoring-session.js`, `tests/test_scoring_session.cjs`
- Source: `player.js` `_resetLineState` (287–301), `_resetSessionCounters` (303–…), `_liveHonestPct` (1606–1621)

- [ ] **Step 1: Test** — append:
```js
(function () {
    var s = session.createSession(twoLineCfg());
    session.setActiveLine(s, 0, 0.0);
    assert.strictEqual(s.matchedSet.size, 0, 'new line starts with empty matchedSet');
    assert.strictEqual(session.getHonestPct(s), null, 'no ended phrases yet -> null honest %');
})();
```
- [ ] **Step 2: Run → FAIL.** Run: `node tests/test_scoring_session.cjs`
- [ ] **Step 3: Implement** — move `_resetLineState`/`_resetSessionCounters` bodies into module-private `resetLineState(s, lineStartAudioTime, discardPrevLine)` / `resetSessionCounters(s)` applying transform #2.1 (`this.`→`s.`). Implement `getHonestPct` by moving `_liveHonestPct` (reads `s.phraseSession.states`, pure). Have `setActiveLine` stub call `resetLineState(s, now, false)` and set `s.activeLineIdx = lineIdx`, plus build `s.lineWords` from `s.lyrics[lineIdx]` (move lines 1220–1227).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(scoring-session): line/session reset + honest %"`

### Task 1.2: `_matchHotWord` → emits `wordMatched`

**Files:** Source: `player.js` `_matchHotWord` (1498–1533), `updateHotWord` hot-index logic (1374–1444).

- [ ] **Step 1: Test** — energy gate on edit-distance matches:
```js
(function () {
    var s = session.createSession(twoLineCfg());
    session.setActiveLine(s, 0, 0.0);
    s.hotWordIndex = 0; s.wordTimings = s.allWordTimings[0];
    session.setEnergy(s, false);
    // 'frst' is edit-distance to 'first'; silent -> must NOT match (energy gate)
    var out = matchHotWordForTest(s, 'frst', 0.5);
    assert.strictEqual(out.filter(function(e){return e.type==='wordMatched';}).length, 0,
        'edit-distance match must be rejected while silent');
    session.setEnergy(s, true);
    out = matchHotWordForTest(s, 'frst', 0.6);
    assert.ok(out.some(function(e){return e.type==='wordMatched' && e.wordIndex===0;}),
        'edit-distance match accepted while singing');
})();
```
where `matchHotWordForTest` is a thin wrapper the test defines: `function matchHotWordForTest(s, text, now){ session.ingestInterim(s, text); return session.tick(s, now); }` — i.e. the behavior is exercised through `tick`, never a private.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — move `_matchHotWord` into private `matchHotWord(s, transcript, now, events)`. Transforms: `this.`→`s.`; replace the `this._logMatch(...)` call (1525–1527) with `ev(events, 'wordMatched', { lineIdx:s.activeLineIdx, wordIndex:s.hotWordIndex, spokenWord:spoken[i], targetWord:target, method:'vad-confirmed', editDistance:-1, phoneticMatch:false, score:1.0, matched:true, windowPosition:s.hotWordIndex, source:'browser_sr' })`; replace `this._setWordSource(...)` with an internal `setWordSource(s, idx, src)` (move 753–761). Keep `doubleMetaphone`/`wordsMatch` (from `scoring`). Call it from `tick` after computing the hot index.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(scoring-session): hot-word match emits wordMatched (energy-gated)"`

### Task 1.3: `_collectMatches` + `_collectMatchesWhisper` + `mergeConfirmedMatches`

**Files:** Source: `_collectMatches` (1238–1300), `_collectMatchesWhisper` (1037–1098).

- [ ] **Step 1: Test** — a clean final fills the matched set for present words and emits `wordMatched`/`promotion` for newly confirmed ones (assert counts on `getScores` after a `setActiveLine` that scores the line). 
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — move both into privates `collectMatches(s, transcript, resultMap, events)` / `collectMatchesWhisper(s, transcript, events)`. Transforms: `this.`→`s.`; `findMatchInWindow`/`wordsMatchScore` from `scoring`; replace `_logMatch`/`_logPromotion` with `wordMatched`/`promotion` events; replace `_setWordSource` with `setWordSource(s,…)`. `ingestFinal(s, text, source)` accumulates into `s.transcript`/`s.transcriptWords` (move the `_appendWhisperTranscript`/SR append logic, 512–515 + 718–752 relevant parts) and sets `s.lineHadAsrEvent = true`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(scoring-session): collectMatches + ingestFinal accumulation"`

### Task 1.4: `_addPhraseEvidence` + `_reconcileInterim` → emit `phraseCleared`

**Files:** Source: `_addPhraseEvidence` (1445–1466), `_reconcileInterim` (1475–1488). **This is the reconciliation core — the riskiest behavior.**

- [ ] **Step 1: Test** — the Phase 0 case (A)/(B) energy-gated assertions now become live. Also add: a `browser_final` that batches two ended lines reconciles each to its own line (assert two distinct `phraseCleared`), and a repeated-anchor case does not double-credit (monotonic). Mirror the cases in `tests/test_phrase_engine.cjs` reconciliation tests but at the session level.
- [ ] **Step 2: Run → FAIL** (and Phase 0 case (B) flips to exercised).
- [ ] **Step 3: Implement** — move both into privates `addPhraseEvidence(s, evidence, now, events)` / `reconcileInterim(s, now, events)`. Transforms: `this.`→`s.`; `audio.currentTime`→`now`; replace each `this._paintPhraseCleared(confirmed[ci])` with `ev(events,'phraseCleared',{phraseId:confirmed[ci]})`. **Preserve the source gate verbatim** (`evidence.source === 'browser_final' || 'whisper'`) and the interim snapshot assembly (`s.transcript + ' ' + s.latestInterim`). The **energy gate** from `06dfde5` is **internal to `phrase-engine.js`** (verified): `reconcileInterimSnapshot(session, text, nowSec)` is 3-arg and gates via `hasInWindowFlow(state, phrase)`, which checks `state.flowEvents` (recorded by the live `addEvidence` path) within the phrase window — there is **no** energy parameter. So **do NOT re-implement an energy check in the session.** Preserve the gate by faithfully reproducing the live `addEvidence` feeding — specifically the `isSpeaking`-gated VAD flow-event evidence in the hot-word path (Task 1.2; `player.js:1423` `if (newHot >= 0 && this.isSpeaking && this.wordTimings.useVad && !this._suspended) …` feeds the `vad`-source evidence that becomes a `flowEvent`). If `setEnergy`/the hot-word VAD feeding is reproduced correctly, the interim gate works automatically. The Phase-0 Task 0.3 case (B) therefore only goes green once Task 1.2 (VAD feed) **and** Task 1.4 (reconcile) are both in.
- [ ] **Step 4: Run → PASS** (Phase 0 (A) and (B) both green).
- [ ] **Step 5: Commit** — `git commit -am "feat(scoring-session): phrase evidence + energy-gated interim reconcile"`

---

## Phase 2 — Move scoring + commit

### Task 2.1: `_scoreLine` → emits `lineScored`

**Files:** Source: `_scoreLine` (1539–1597).

- [ ] **Step 1: Test** — feed a line, score it via `setActiveLine` advance, assert one `lineScored` with correct `matched`/`scoredTotal`/`perfect` and that `getScores().linesScored === 1`; assert a zero-`weightedTotal` (all-filler) line emits **no** `lineScored` and does not break the streak.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — move into `scoreLine(s, lineIdx, lineWords, matchedSet, lineHadAsrEvent, vadMatchedSet, asrConfirmedSet, events)`. Keep `computeLineScore` (from `scoring`) and **all guards verbatim** (zero-ASR fence line 1550; `weightedTotal===0` early-return 1557). **Delete the DOM block (1563–1580)** — the `.missed` span marking and `.line-score-flash` — and instead `ev(events,'lineScored',{ lineIdx, matched, scoredTotal, missedWordIndices:scoreSummary.missedWordIndices, perfect:scoreSummary.perfect, weightedTotal, weightedMatched })`. Keep the tally mutations (1582–1594) as `s.weightedTotal += …`. Replace `this._updateRunningScore()` (1596) with `ev(events,'runningScore',{})` (controller repaints from `getScores`).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(scoring-session): scoreLine emits lineScored (no DOM)"`

### Task 2.2: `_lateScoreLine`

**Files:** Source: `_lateScoreLine` (1786–1840).

- [ ] **Step 1: Test** — a late final that arrives after the line ended still produces a `lineScored` for the correct `lineIdx` with the late-credited count.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — move into `lateScoreLine(s, …, events)` mirroring Task 2.1 transforms. Reuse `scoreLine` internals where they overlap (DRY: if `_lateScoreLine` largely re-does `_scoreLine` with a snapshot, have it call `scoreLine` with the snapshot params).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(scoring-session): lateScoreLine"`

### Task 2.3: `_commitNewlySettled` → emits `arcade` / `phraseCleared` / `phraseMissed`

**Files:** Source: `_commitNewlySettled` (1653–1703). **Commit-once invariant lives here.**

- [ ] **Step 1: Test** — settle a phrase, assert exactly one `arcade` event + one `arcadeRecord`; call `tick` again at a later `now`, assert **no** second `arcade` for the same phrase (commit-once via `s.committedPhrases`). A confirmed phrase emits `phraseCleared`; a missed phrase emits `phraseMissed`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — move into `commitNewlySettled(s, now, routeEvents, events)`. Transforms: `this.`→`s.`; `audio.currentTime`→`now`; keep `KaraokeeArcade.commitPhrase` and the `s.committedPhrases[id]` guard verbatim. Replace: the `_arcadeEvents.push({...})` → also `ev(events,'arcadeRecord',{record:{…the same object…}})` (still push to `s.arcadeEvents` for `endRun`/telemetry); `this._onArcadeEvent(evt)` → `ev(events,'arcade',{evt:evt})`; the V2 paint block (1691–1700): `confirmed` → `ev(events,'phraseCleared',{phraseId:ph.phraseId})`, else `ev(events,'phraseMissed',{phraseId:ph.phraseId})`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(scoring-session): commit-once emits arcade/phrase events"`

### Task 2.4: `tick` orchestration + `honestPct`

**Files:** Source: `_tickArcade` (1628–1647).

- [ ] **Step 1: Test** — `tick` returns events in the order: (reconcile) `phraseCleared` → (commit) `arcade`/`phraseMissed` → `honestPct`; and `honestPct` value equals `getHonestPct(s)`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — fill `tick(s, now)`: (1) `phraseEngine.settlePhrases(s.phraseSession, now)`; (2) the **tick-driven prevLine finalize** check (Task 3.2 adds it — leave a `finalizePrevLineIfDue(s, now, events)` call here now, no-op until 3.2); (3) if `KARAOKEE_V2`, `reconcileInterim(s, now, events)`; (4) `commitNewlySettled(s, now, true, events)`; (5) compute hot index + `matchHotWord(s, …, now, events)`; (6) if `KARAOKEE_V2`, `ev(events,'honestPct',{pct:getHonestPct(s)})`. Return `events`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(scoring-session): tick orchestration + honestPct event"`

---

## Phase 3 — Move the line transition (`setActiveLine`) + prevLine

> **MUST close these Phase-1 deferrals (flagged by Phase-1 spec review):**
> 1. **Boundary crediting** — `setActiveLine`'s outgoing `collectMatches` pass MUST run BEFORE `resetLineState` (player.js:1110–1122), crediting a pre-boundary `final`'s words to the outgoing line via `prevLine.matchedSet`. The `test_scoring_session.cjs` boundary "TRIPWIRE" case currently asserts `s.prevLine === null`; when it fails here, replace it with a crediting assertion (on `prevLine.matchedSet` or a line-0 `lineScored`).
> 2. **Interim-only collect** — `ingestInterim` currently only stores `latestInterim`; it does NOT mark the collect dirty, so continuous singing with no `final` never full-collects (production runs `_collectMatches` on every `onresult` incl. interims — player.js:431). Make `ingestInterim` mark collect-dirty (or have `tick` collect `transcript + ' ' + latestInterim`), and add a characterization test: a multi-word interim with energy credits all its in-window words via `tick`.

### Task 3.1: `setActiveLine` body (snapshot + new-line setup) → events

**Files:** Source: `setActiveLine` (1099–1236).

- [ ] **Step 1: Test** — advancing from line 0 (with matches) to line 1 emits a `lineScored` for line 0 and a `transition` event; `s.prevLine.lineIdx === 0`; `s.activeLineIdx === 1`; `s.lineWords` equals normalized line-1 words.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — fill `setActiveLine(s, lineIdx, now)` by moving 1099–1236 with transforms. Specifically:
  - `this._finalizePrevLine()` → `finalizePrevLine(s, now, events)` (Task 3.2).
  - The outgoing final pass (1110–1122): keep `collectMatches`/`mergeConfirmedMatches`; replace `_logPromotion`/`_setWordSource`/`_updateWordSpans` with `promotion` events + `setWordSource` + a single `ev(events,'wordSpans',{})` signal (controller repaints active-line spans).
  - The prevLine overlay build (1130–1148): keep, but **change `overlapEnd`** from `performance.now() + (overlapDuration+scoreDelay)*1000` to **`now + overlapDuration + scoreDelay`** (media seconds). **Delete the `setTimeout` block (1150–1159)** — finalization becomes tick-driven (Task 3.2).
  - The diagnostic transition (1163–1186): replace `this._debugLog('LINE',…)` + `this._logTransition(…)` with one `ev(events,'transition',{ fromIdx:_dbgFromIdx, toIdx:lineIdx, trigger:'score', fromText:_dbgFromText, matchedCount:s.matchedSet.size, total:s.lineWords.length, missedWords:[…], lineStartAudioTime:s._lineStartAudioTime, sourceCounts:countWordSources(s.wordSourceMap) })`.
  - New-line setup (1188–1227): keep (`resetLineState`, load `wordTimings`/`currentParams`, build `lineWords`). **Remove the `_whisperNode.port.postMessage` block (1201–1213)** — that is transcription-source control; return `ev(events,'chunkTempo',{tempoClass})` and let the controller message the worklet. **Remove the DOM span reset (1229–1235)** — emit `ev(events,'resetSpans',{lineIdx})`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(scoring-session): setActiveLine returns events (no DOM/timer/port)"`

### Task 3.2: tick-driven prevLine finalize (`_finalizePrevLine`/`_matchPrevLine`)

**Files:** Source: `_finalizePrevLine` (983–1000), `_matchPrevLine` (1001–1036).

- [ ] **Step 1: Test** — set up a `prevLine` with `overlapEnd = 5.0`; `tick(s, 4.9)` does NOT finalize (no late `lineScored` for prevLine); `tick(s, 5.0)` finalizes (emits the prevLine's `lineScored`). This is the wall-clock→media-clock conversion guard.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — move `_finalizePrevLine`/`_matchPrevLine` into `finalizePrevLine(s, now, events)` / `matchPrevLine(s, transcript, track, now, events)`. Add `finalizePrevLineIfDue(s, now, events)`: `if (s.prevLine && now >= s.prevLine.overlapEnd) finalizePrevLine(s, now, events);` and call it at the top of `tick` (Task 2.4 left the hook). `finalizePrevLine` calls `lateScoreLine` for the prevLine snapshot and nulls `s.prevLine`; replace its DOM/paint with events.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(scoring-session): tick-driven prevLine finalize (media clock)"`

### Task 3.3: `ingestInterim` + `setEnergy` final wiring + `endRun`

- [ ] **Step 1: Test** — `endRun(s, now)` flushes: commits any settled phrase (commit-once respected) and scores the final active line; assert the final `getScores()` and that a second `endRun` is idempotent.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — `ingestInterim(s, text)` sets `s.latestInterim = text` (+ `s.lineHadAsrEvent = true` if non-empty, matching current). `endRun(s, now)`: run a final `collectMatches` on the active line, `scoreLine` it, `settlePhrases`, `commitNewlySettled(s, now, false, events)` (note `routeEvents=false`, matching the end-screen flush at 1653 comment), return events.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(scoring-session): ingestInterim/setEnergy/endRun"`

**Phase 3 exit:** `tests/test_scoring_session.cjs` covers transition, prevLine media-clock finalize, reconciliation (energy-gated), commit-once, scoring, endRun. The module is behavior-complete and never touches DOM/clock.

---

## Phase 4 — Controller swap (player.js feeds + renders)

### Task 4.1: Add `_renderEvents(events)` dispatcher to `GameMode`

**Files:** Modify `static/player.js`.

- [ ] **Step 1:** Write `_renderEvents(events)` that maps each event to the DOM/telemetry the moved code used to do inline. Full code:
```js
_renderEvents(events) {
    if (!events) return;
    for (var i = 0; i < events.length; i++) {
        var e = events[i];
        switch (e.type) {
            case 'lineScored': this._renderLineScored(e); break;       // .missed spans + .line-score-flash (old _scoreLine DOM block)
            case 'wordMatched': this._logMatch(e.spokenWord, e.targetWord, e.method, e.editDistance, e.phoneticMatch, e.score, e.matched, e.windowPosition); break;
            case 'promotion': this._logPromotion(e.source, e.wordIndex, e.score); break;
            case 'phraseCleared': this._paintPhraseCleared(e.phraseId); break;
            case 'phraseMissed': this._paintPhraseMissed(e.phraseId); break;  // the else-branch paint from old _commitNewlySettled
            case 'arcade': this._onArcadeEvent(e.evt); break;
            case 'arcadeRecord': /* already in session.arcadeEvents; telemetry reads it at build time */ break;
            case 'honestPct': { var el = document.getElementById('score-pct'); if (el && e.pct != null) el.textContent = e.pct + '%'; break; }
            case 'runningScore': this._updateRunningScore(); break;
            case 'transition': this._logTransition(e.fromIdx, e.toIdx, e.trigger, e.fromText, e.matchedCount, e.total, e.missedWords, e.lineStartAudioTime, e.sourceCounts); break;
            case 'resetSpans': this._resetLineSpans(e.lineIdx); break;
            case 'wordSpans': this._updateWordSpans(); break;
            case 'chunkTempo': this._applyChunkTempo(e.tempoClass); break; // the _whisperNode.port.postMessage block
        }
    }
}
```
- [ ] **Step 2:** Extract the small DOM helpers referenced above (`_renderLineScored`, `_paintPhraseMissed`, `_resetLineSpans`, `_applyChunkTempo`) from the original method bodies (they are the exact DOM/port snippets deleted in Phases 2–3). Keep `_paintPhraseCleared`, `_updateWordSpans`, `_onArcadeEvent`, `_logMatch`, `_logPromotion`, `_logTransition`, `_updateRunningScore` as-is (they are renderers/loggers now).
- [ ] **Step 3:** `node --check static/player.js`. Expected: PASS.
- [ ] **Step 4: Commit** — `git commit -am "feat(player): event renderer dispatcher for scoring session"`

### Task 4.2: Create the session at game start; feed it

**Files:** Modify `static/player.js` `start()`, the whisper/SR/VAD handlers, and the `updateLyrics` loop.

- [ ] **Step 1:** In `start()`, after `this._phrasePlan` is built, `this._session = KaraokeeScoringSession.createSession({ lyrics: lyrics, allWordTimings: this.allWordTimings, phrasePlan: this._phrasePlan, difficulty: this._phraseDifficulty, flags: { KARAOKEE_V2: !!window.KARAOKEE_V2 } });` (keep `this._phraseSession`/`this._arcadeState` pointing at `this._session.phraseSession`/`.arcadeState` if other code reads them, or repoint those readers).
- [ ] **Step 2:** Replace the bodies of the now-delegating controller triggers:
  - `setActiveLine(lineIdx)` → `this._renderEvents(KaraokeeScoringSession.setActiveLine(this._session, lineIdx, this._now()));`
  - in `_handleWhisperTranscript`/SR final path → `KaraokeeScoringSession.ingestFinal(this._session, text, source);`
  - interim path → `KaraokeeScoringSession.ingestInterim(this._session, interimText);`
  - VAD tick (where `this.isSpeaking` is set) → `KaraokeeScoringSession.setEnergy(this._session, this.isSpeaking);`
  - in the 100 ms `updateLyrics`/`updateHotWord`/`_tickArcade` path → `this._renderEvents(KaraokeeScoringSession.tick(this._session, this._now()));`
  - song end / stop → `this._renderEvents(KaraokeeScoringSession.endRun(this._session, this._now()));`
  where `_now()` returns `(audio && isFinite(audio.currentTime)) ? audio.currentTime : 0`.
- [ ] **Step 3:** Point `_buildTelemetryPayload` at the session: read scores from `KaraokeeScoringSession.getScores(this._session)` and arcade records from `this._session.arcadeEvents`.
- [ ] **Step 4: Verify in browser** (manual): `python app.py`, load a song, enter game mode, sing a few lines. Confirm spans paint, HUD updates, `#score-pct` moves, end screen shows. (This is the standing sing-test gate.)
- [ ] **Step 5: Commit** — `git commit -am "feat(player): drive scoring via KaraokeeScoringSession (feed + tick + render)"`

---

## Phase 5 — Delete moved code + full verification

### Task 5.1: Delete the now-duplicated `GameMode` methods

**Files:** Modify `static/player.js`.

- [ ] **Step 1:** Delete from `GameMode` the methods fully moved into the session: `_resetLineState`, `_resetSessionCounters`, `_matchHotWord`, `_collectMatches`, `_collectMatchesWhisper`, `_addPhraseEvidence`, `_reconcileInterim`, `_scoreLine`, `_lateScoreLine`, `_commitNewlySettled`, `_liveHonestPct`, `_tickArcade`, `_finalizePrevLine`, `_matchPrevLine`, and the scoring state fields in the constructor now owned by the session (keep only what the controller still reads). **Keep** all renderers/loggers (`_paintPhraseCleared`, `_updateWordSpans`, `_logMatch`, etc.) and the transcription/VAD methods (those are #2's territory).
- [ ] **Step 2:** `node --check static/player.js`; grep to confirm no remaining callers of the deleted privates (`grep -nE "this\._(scoreLine|commitNewlySettled|reconcileInterim|matchHotWord|collectMatches|finalizePrevLine|tickArcade|liveHonestPct)\b" static/player.js` → empty).
- [ ] **Step 3: Commit** — `git commit -am "refactor(player): delete scoring methods now owned by the session"`

### Task 5.2: Full verification gate

- [ ] **Step 1:** JS suite:
```bash
for f in tests/*.cjs; do node "$f" || echo "FAIL $f"; done
```
Expected: every file prints its `... tests passed.` line; no `FAIL`.
- [ ] **Step 2:** Python suite: `python -m pytest tests/test_app.py tests/test_downloader.py tests/test_lyrics.py -q`. Expected: `53 passed`.
- [ ] **Step 3:** `node --check static/player.js && node --check static/scoring-session.js`. Expected: clean.
- [ ] **Step 4: Manual sing-test (standing gate).** `python app.py`, load a known song, sing with deliberate skips and a repeated-hook line; scan the run JSON in `output_telemetry/<date>/` for `*_reconciled` credits on skipped lines (the cheese check from memory). Confirm honest % and arcade behave as before the refactor.
- [ ] **Step 5: Commit** (docs) — update `CLAUDE.md`:
  - Add `node tests/test_scoring_session.cjs` to the JS test list.
  - Add `scoring-session.js` (`window.KaraokeeScoringSession`) to the frontend module map: "per-run scoring state machine (match→reconcile→score→commit); DOM-free, event-emitting; consumes scoring/phrase-engine/scoring-arcade."
  - In the JS helper isolation pattern list, add `scoring-session.js`.
```bash
git add CLAUDE.md && git commit -m "docs: document scoring-session.js module + test"
```

---

## Self-Review

**Spec coverage:**
- Full-scope extraction → Phases 1–3 move every listed method; Phase 5 deletes them. ✓
- Events-as-data out → event contract defined once; every move emits events; Task 4.1 renders them. ✓
- Preserve-feeding in → `ingestFinal`/`ingestInterim`/`setEnergy`; session keeps internal `transcript`/`latestInterim`; phrase engine fed `transcript + ' ' + interim` verbatim (Task 1.4). ✓
- Characterization-first → Phase 0 establishes scripted net before module logic; each task is test-first. ✓
- Energy-not-in-telemetry → primary net is scripted (Phase 0/Task 1.4); telemetry replay not relied on for energy. ✓
- setActiveLine timer/clock wrinkle → Task 3.1 deletes `setTimeout`/`performance.now`; Task 3.2 tick-driven media-clock finalize + dedicated test. ✓
- Telemetry-grade events → `wordMatched` carries full match detail; Task 4.1 logger consumes it. ✓

**Placeholder scan:** Move steps name exact source ranges + the three transforms + the exact event to emit — no "handle edge cases"/"TBD". New code (skeleton, events, harness, renderer) shown in full. ✓

**Type consistency:** Method names (`createSession`, `setActiveLine`, `ingestFinal`, `ingestInterim`, `setEnergy`, `tick`, `endRun`, `getScores`, `getHonestPct`) and event `type` strings (`lineScored`, `wordMatched`, `promotion`, `phraseCleared`, `phraseMissed`, `arcade`, `arcadeRecord`, `honestPct`, `transition`, `runningScore`, `resetSpans`, `wordSpans`, `chunkTempo`) are used identically in the contract, the module tasks, and the renderer. ✓

**Open items to confirm during execution (not blockers):** exact `phrase-engine.js`/`scoring-arcade.js` constructor names (Task 0.2 note); exact location of the `06dfde5` energy gate inside the current reconcile path (Task 1.4 Step 3); whether any non-scoring code reads the constructor fields being deleted (Task 5.1 Step 1 grep).
