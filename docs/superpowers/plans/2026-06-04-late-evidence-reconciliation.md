# Late-Evidence Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Credit recognized words to the line they were *sung* on (by content) rather than the line showing when the recognizer reports them, so wrongly-missed lines flip to cleared and repaint green — without inflating the honesty-gated %.

**Architecture:** A new pure function `reconcileLateEvidence(session, evidence, nowSec)` lives inside the `phrase-engine.js` factory (reusing its internals). It runs *after* the existing live `addEvidence`/`settlePhrases` path, only for late sources (`browser_final`, `whisper`). It matches the evidence's words against not-yet-cleared phrases whose `endSec` falls in a bounded look-back, using **monotonic forward-only attribution** (a `minIdx` pointer) so a repeated anchor word cannot be pulled back to an earlier line and a single token cannot inflate multiple lines. `player.js` calls it from `_addPhraseEvidence` and repaints any newly-confirmed phrase green via an extracted `_paintPhraseCleared` helper.

**Tech Stack:** Plain browser JS (UMD module pattern, `var`/functions for Node `require()` testability), Node `assert`-based golden tests (`tests/*.cjs`), Flask/pytest for the unchanged server.

**Spec:** [docs/superpowers/specs/2026-06-04-late-evidence-reconciliation-design.md](../specs/2026-06-04-late-evidence-reconciliation-design.md)

**Flag:** All player-visible behavior rides under `karaokee_v2` (press `V`). The human validation sing-test must re-run before any default-on flip.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `static/phrase-engine.js` | Phrase scoring engine factory | Add `RECONCILE_LOOKBACK_SEC` const + `reconcileLateEvidence()` function; export it. |
| `tests/test_phrase_engine.cjs` | Golden tests for the engine | Append reconciliation golden cases (catch-up, no-distant-cross-match, inflation-guard, dedup, partial→clear, cheese-safety). |
| `static/player.js` | Karaoke controller / recognition feed | Call `reconcileLateEvidence` in `_addPhraseEvidence` for late sources; extract `_paintPhraseCleared(phraseId)` from `_commitNewlySettled` and use it to repaint reconciled-confirmed lines. |

**Test-style note:** `tests/test_phrase_engine.cjs` is a single flat script — it runs top-to-bottom with `node:assert` and prints `Phrase engine tests passed.` at the end. There is no test framework; "run the test" = `node tests/test_phrase_engine.cjs`, which exits non-zero on the first failing assertion. New cases are appended *before* the final `console.log(...)` line.

---

### Task 1: `reconcileLateEvidence` — core function driven by catch-up + no-distant-cross-match + inflation-guard

**Files:**
- Modify: `static/phrase-engine.js` (add const near `LATE_EVIDENCE_GRACE_MS` line 31; add function after `addEvidence` ~line 414; add export in the return block lines 501-510)
- Test: `tests/test_phrase_engine.cjs` (append before the final `console.log`)

- [ ] **Step 1: Write the failing tests (catch-up, no-distant-cross-match, inflation-guard)**

Append this block to `tests/test_phrase_engine.cjs` immediately **before** the final `console.log('Phrase engine tests passed.');` line:

```javascript
// ---------------------------------------------------------------------------
// Late-evidence reconciliation
// ---------------------------------------------------------------------------

// Catch-up: a missed early phrase whose anchor word arrives in much-later
// evidence (within the look-back) gets credited and returned as newly confirmed.
var catchupPlan = phraseEngine.buildPhrasePlan([
    { time: 10, text: 'mountain river stone' },
    { time: 14, text: 'second line here' }
], { difficulty: 'easy', audioDuration: 18 });
var catchupSession = phraseEngine.createPhraseSession(catchupPlan);
var catchupConfirmed = phraseEngine.reconcileLateEvidence(catchupSession, {
    id: 'late-1', source: 'browser_final', text: 'mountain', words: [],
    receivedAtSec: 20, audioTimeSec: 20
}, 20);
assert.deepStrictEqual(catchupConfirmed, ['p0'], 'catch-up returns the newly-confirmed phrase id');
assert.strictEqual(catchupSession.states['p0'].lyricStatus, 'confirmed', 'catch-up flips a missed phrase to confirmed');
assert.strictEqual(catchupSession.states['p0'].cleared, true, 'catch-up clears the phrase');
assert.ok(
    catchupSession.states['p0'].consumedTokens.some(function(t) { return t.source === 'browser_final_reconciled'; }),
    'reconciled credit is tagged *_reconciled for telemetry audit'
);

// No distant cross-match: the same anchor word outside the look-back window
// does NOT credit the old phrase.
var distantPlan = phraseEngine.buildPhrasePlan([
    { time: 0, text: 'mountain river stone' },
    { time: 4, text: 'second line here' }
], { difficulty: 'easy', audioDuration: 8 });
var distantSession = phraseEngine.createPhraseSession(distantPlan);
var distantConfirmed = phraseEngine.reconcileLateEvidence(distantSession, {
    id: 'late-2', source: 'browser_final', text: 'mountain', words: [],
    receivedAtSec: 30, audioTimeSec: 30
}, 30);
assert.deepStrictEqual(distantConfirmed, [], 'no phrase confirmed when evidence is outside the look-back');
assert.strictEqual(distantSession.states['p0'].lyricStatus, 'missing', 'distant evidence leaves the old phrase missing');
assert.strictEqual(Object.keys(distantSession.states['p0'].anchorHits).length, 0, 'distant evidence credits no anchors');

// Inflation guard (first-class): several un-cleared phrases share an anchor
// word ("fly"). Feeding one line's words must credit ONLY that line — the
// shared word must not light up the others.
var sharedPlan = phraseEngine.buildPhrasePlan([
    { time: 0, text: 'birds can fly' },   // p0: anchors birds, fly
    { time: 4, text: 'watch me fly' },    // p1: anchors watch, fly
    { time: 8, text: 'geese will fly' }   // p2: anchors geese, fly
], { difficulty: 'easy', audioDuration: 12 });
var sharedSession = phraseEngine.createPhraseSession(sharedPlan);
var sharedConfirmed = phraseEngine.reconcileLateEvidence(sharedSession, {
    id: 'late-3', source: 'browser_final', text: 'watch me fly', words: [],
    receivedAtSec: 9, audioTimeSec: 9
}, 9);
assert.deepStrictEqual(sharedConfirmed, ['p1'], 'one line\'s batch confirms only that line');
assert.strictEqual(sharedSession.states['p1'].lyricStatus, 'confirmed', 'the sung line is confirmed');
assert.strictEqual(sharedSession.states['p0'].lyricStatus, 'missing', 'the shared "fly" does NOT confirm the earlier line');
assert.strictEqual(sharedSession.states['p2'].lyricStatus, 'missing', 'the shared "fly" does NOT confirm the later line');
assert.strictEqual(Object.keys(sharedSession.states['p0'].anchorHits).length, 0, 'no spurious anchor credit on p0');
assert.strictEqual(Object.keys(sharedSession.states['p2'].anchorHits).length, 0, 'no spurious anchor credit on p2');

// Inflation guard, worst ordering: a bare repeated anchor word, fed once,
// credits AT MOST one phrase (cannot inflate every line that holds it).
var bareSession = phraseEngine.createPhraseSession(sharedPlan);
var bareConfirmed = phraseEngine.reconcileLateEvidence(bareSession, {
    id: 'late-4', source: 'browser_final', text: 'fly', words: [],
    receivedAtSec: 9, audioTimeSec: 9
}, 9);
assert.strictEqual(bareConfirmed.length, 1, 'a single shared token credits exactly one phrase, never all of them');
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node tests/test_phrase_engine.cjs`
Expected: FAIL with a `TypeError` like `phraseEngine.reconcileLateEvidence is not a function`.

- [ ] **Step 3: Add the `RECONCILE_LOOKBACK_SEC` constant**

In `static/phrase-engine.js`, immediately after the `LATE_EVIDENCE_GRACE_MS` declaration (line 31), add:

```javascript
    // How far back (in audio seconds) reconciliation will look when crediting a
    // late recognition result to an already-ended phrase. Sized to the browser
    // speech-rec batch latency observed in telemetry (it can batch ~8 lines into
    // one late `final`). Tunable; see the design spec §7.
    var RECONCILE_LOOKBACK_SEC = 18;
```

- [ ] **Step 4: Implement `reconcileLateEvidence`**

In `static/phrase-engine.js`, add this function immediately **after** the `addEvidence` function closes (after line 414, before `function settlePhrases`):

```javascript
    // Content-based catch-up for late recognition. Runs AFTER the live addEvidence
    // path. For each token in spoken order, finds the first un-hit anchor in a
    // not-yet-cleared phrase whose endSec is inside the look-back window, scanning
    // candidates forward from a monotonic pointer so a repeated anchor word cannot
    // be pulled back to an earlier line and a single token cannot inflate multiple
    // lines. Returns the phraseIds that reached 'confirmed' during this pass.
    function reconcileLateEvidence(session, evidence, nowSec) {
        if (!session || !session.plan || !evidence) return [];
        var source = evidence.source || 'browser_final';
        var tokens = evidenceTokens(evidence);
        if (tokens.length === 0) return [];

        var lookbackStart = nowSec - RECONCILE_LOOKBACK_SEC;
        var candidates = (session.plan.phrases || []).filter(function(phrase) {
            var state = session.states[phrase.phraseId];
            if (!state || state.cleared) return false;
            if (!(phrase.anchorsRequired > 0)) return false;
            return phrase.endSec >= lookbackStart && phrase.endSec <= nowSec;
        }).sort(function(a, b) { return a.startSec - b.startSec; });
        if (candidates.length === 0) return [];

        var minIdx = 0;
        for (var ti = 0; ti < tokens.length; ti++) {
            var token = tokens[ti];
            var tokenId = evidence.id + ':' + token.idx;
            if (session.consumedTokenIds[tokenId]) continue;
            var isFiller = REPEATED_FILLER[token.word] || isAdlibWord(token.word);

            for (var ci = minIdx; ci < candidates.length; ci++) {
                var state = session.states[candidates[ci].phraseId];
                var anchors = state.phrase.anchors || [];
                var creditedAnchor = null;
                var creditedScore = 0;
                for (var ai = 0; ai < anchors.length; ai++) {
                    var anchor = anchors[ai];
                    if (state.anchorHits[anchor.anchorIdx]) continue;
                    if (isFiller && !anchor.fillerOnly) continue;
                    var result = scoring.wordsMatchScore(token.word, anchor.word, anchor.phonetic);
                    if (result && result.score >= 0.75) {
                        creditedAnchor = anchor;
                        creditedScore = result.score;
                        break;
                    }
                }
                if (creditedAnchor) {
                    session.consumedTokenIds[tokenId] = true;
                    state.anchorHits[creditedAnchor.anchorIdx] = {
                        word: creditedAnchor.word,
                        source: source + '_reconciled',
                        evidenceId: evidence.id,
                        score: creditedScore
                    };
                    pushBounded(state, 'evidence', {
                        evidenceId: evidence.id,
                        source: source + '_reconciled',
                        text: evidence.text || '',
                        score: creditedScore,
                        method: 'reconciled'
                    }, MAX_EVIDENCE_PER_PHRASE);
                    pushBounded(state, 'consumedTokens', {
                        evidenceId: evidence.id,
                        tokenIdx: token.idx,
                        word: token.word,
                        anchor: creditedAnchor.word,
                        source: source + '_reconciled',
                        timeSec: tokenTime(evidence, token),
                        score: creditedScore
                    }, MAX_TOKENS_PER_PHRASE);
                    updatePhraseResult(session, state);
                    minIdx = ci;
                    break;
                }
            }
        }

        var newlyConfirmed = [];
        candidates.forEach(function(phrase) {
            if (session.states[phrase.phraseId].cleared) newlyConfirmed.push(phrase.phraseId);
        });
        return newlyConfirmed;
    }
```

- [ ] **Step 5: Export `reconcileLateEvidence`**

In the return block at the end of `static/phrase-engine.js` (lines 501-510), add the function to the exports. Change:

```javascript
        addEvidence: addEvidence,
        settlePhrases: settlePhrases,
```

to:

```javascript
        addEvidence: addEvidence,
        reconcileLateEvidence: reconcileLateEvidence,
        settlePhrases: settlePhrases,
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node tests/test_phrase_engine.cjs`
Expected: PASS — prints `Phrase engine tests passed.`

If the inflation-guard case fails (e.g. `sharedConfirmed` is not exactly `['p1']`), STOP — that is the test deciding monotonic is insufficient; re-read spec §3 and the failure before any further change. Do not loosen the assertion to make it pass.

- [ ] **Step 7: Commit**

```bash
git add static/phrase-engine.js tests/test_phrase_engine.cjs
git commit -m "feat(phrase-engine): add monotonic late-evidence reconciliation

Credit recognized words to the line they were sung on (by content) over a
bounded look-back, using forward-only attribution so a repeated anchor word
cannot be pulled to an earlier line and a single token cannot inflate
multiple lines. Tagged *_reconciled for telemetry audit. Honesty-gate safe.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Reconciliation edge cases — dedup, partial→clear, cheese-safety

**Files:**
- Test: `tests/test_phrase_engine.cjs` (append before the final `console.log`)

- [ ] **Step 1: Write the failing edge-case tests**

Append this block to `tests/test_phrase_engine.cjs` immediately **before** the final `console.log('Phrase engine tests passed.');` line (i.e. after the Task 1 block):

```javascript
// Dedup: tokens consumed by a first reconcile pass are not re-credited if the
// same evidence is reconciled again.
var dedupPlan = phraseEngine.buildPhrasePlan([
    { time: 10, text: 'mountain river stone' },
    { time: 14, text: 'second line here' }
], { difficulty: 'easy', audioDuration: 18 });
var dedupSession = phraseEngine.createPhraseSession(dedupPlan);
var dedupEvidence = {
    id: 'dup-1', source: 'browser_final', text: 'mountain river stone', words: [],
    receivedAtSec: 16, audioTimeSec: 16
};
phraseEngine.reconcileLateEvidence(dedupSession, dedupEvidence, 16);
var dedupHitsAfterFirst = Object.keys(dedupSession.states['p0'].anchorHits).length;
var dedupSecondPass = phraseEngine.reconcileLateEvidence(dedupSession, dedupEvidence, 16);
assert.deepStrictEqual(dedupSecondPass, [], 'a second reconcile of the same evidence confirms nothing new');
assert.strictEqual(
    Object.keys(dedupSession.states['p0'].anchorHits).length, dedupHitsAfterFirst,
    'already-consumed tokens are not re-credited'
);

// Partial -> clear: a phrase needing 2 anchors stays partial after one late
// word and clears when a second late word supplies the missing anchor.
var partialPlan = phraseEngine.buildPhrasePlan([
    { time: 10, text: 'mountain river stone' },
    { time: 14, text: 'second line here' }
], { difficulty: 'medium', audioDuration: 18 });
assert.ok(partialPlan.phrases[0].anchorsRequired >= 2, 'medium requires >=2 anchors for a 3-anchor line');
var partialSession = phraseEngine.createPhraseSession(partialPlan);
var partialFirst = phraseEngine.reconcileLateEvidence(partialSession, {
    id: 'part-1', source: 'whisper', text: 'mountain', words: [],
    receivedAtSec: 16, audioTimeSec: 16
}, 16);
assert.deepStrictEqual(partialFirst, [], 'one anchor is not enough to confirm a 2-anchor phrase');
assert.strictEqual(partialSession.states['p0'].lyricStatus, 'partial', 'phrase is partial after one anchor');
var partialSecond = phraseEngine.reconcileLateEvidence(partialSession, {
    id: 'part-2', source: 'whisper', text: 'river', words: [],
    receivedAtSec: 17, audioTimeSec: 17
}, 17);
assert.deepStrictEqual(partialSecond, ['p0'], 'the second late anchor clears the phrase');
assert.strictEqual(partialSession.states['p0'].lyricStatus, 'confirmed', 'phrase confirms once both anchors are supplied');

// Cheese safety: filler-only and non-matching words credit nothing.
var cheesePlan = phraseEngine.buildPhrasePlan([
    { time: 10, text: 'mountain river stone' },
    { time: 14, text: 'second line here' }
], { difficulty: 'easy', audioDuration: 18 });
var cheeseSession = phraseEngine.createPhraseSession(cheesePlan);
var cheeseFiller = phraseEngine.reconcileLateEvidence(cheeseSession, {
    id: 'cheese-1', source: 'browser_final', text: 'yeah yeah uh oh na', words: [],
    receivedAtSec: 16, audioTimeSec: 16
}, 16);
assert.deepStrictEqual(cheeseFiller, [], 'filler words confirm nothing');
var cheeseWrong = phraseEngine.reconcileLateEvidence(cheeseSession, {
    id: 'cheese-2', source: 'browser_final', text: 'banana orange purple', words: [],
    receivedAtSec: 16, audioTimeSec: 16
}, 16);
assert.deepStrictEqual(cheeseWrong, [], 'non-matching real words confirm nothing');
assert.strictEqual(Object.keys(cheeseSession.states['p0'].anchorHits).length, 0, 'cheese credits no anchors');
```

- [ ] **Step 2: Run the tests to verify they pass**

Run: `node tests/test_phrase_engine.cjs`
Expected: PASS — prints `Phrase engine tests passed.`

These cases need no new implementation (Task 1 already handles dedup via `consumedTokenIds`, partial→clear via `updatePhraseResult`, and cheese-safety via the filler gate + `≥0.75` threshold). If any fail, the bug is in Task 1's function — fix it there, do not special-case.

- [ ] **Step 3: Commit**

```bash
git add tests/test_phrase_engine.cjs
git commit -m "test(phrase-engine): cover reconciliation dedup, partial-clear, cheese-safety

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Wire reconciliation into player.js + extract `_paintPhraseCleared`

**Files:**
- Modify: `static/player.js` — `_addPhraseEvidence` (~1774-1785); add `_paintPhraseCleared` helper; refactor `_commitNewlySettled` V2 block (~1980-1988)

- [ ] **Step 1: Add the `_paintPhraseCleared` helper**

In `static/player.js`, add this method immediately **after** the `_paintAnchorSpansLive` method closes (after line 1684, before the `_readVadRms` comment block):

```javascript
    // V2: paint every span of a cleared phrase green (whole-line-green on pass).
    // Shared by _commitNewlySettled (settle-time) and late-evidence reconciliation
    // (a missed line flips green a few seconds late when its batched words arrive).
    _paintPhraseCleared(phraseId) {
        if (!window.KARAOKEE_V2) return;
        var sel = '.word-span[data-phrase-id="' + phraseId + '"]';
        document.querySelectorAll(sel).forEach(function (span) {
            span.classList.remove('matched-partial', 'missed');
            span.classList.add('matched');
        });
    }
```

- [ ] **Step 2: Refactor `_commitNewlySettled` to use the helper**

In `static/player.js`, in `_commitNewlySettled`, replace the V2 coloring block (lines 1980-1988):

```javascript
            if (window.KARAOKEE_V2) {
                var _conf = pst.lyricStatus === 'confirmed';
                var _sel = '.word-span[data-phrase-id="' + ph.phraseId + '"]';
                document.querySelectorAll(_sel).forEach(function (span) {
                    span.classList.remove('matched', 'matched-partial', 'missed');
                    if (_conf) span.classList.add('matched');
                    else if (span.classList.contains('key-word')) span.classList.add('missed');
                });
            }
```

with:

```javascript
            if (window.KARAOKEE_V2) {
                if (pst.lyricStatus === 'confirmed') {
                    this._paintPhraseCleared(ph.phraseId);
                } else {
                    var _sel = '.word-span[data-phrase-id="' + ph.phraseId + '"]';
                    document.querySelectorAll(_sel).forEach(function (span) {
                        span.classList.remove('matched', 'matched-partial', 'missed');
                        if (span.classList.contains('key-word')) span.classList.add('missed');
                    });
                }
            }
```

(`_commitNewlySettled` iterates with a `for` loop, so `this` is the controller instance here — `this._paintPhraseCleared(...)` is valid.)

- [ ] **Step 3: Call `reconcileLateEvidence` from `_addPhraseEvidence`**

In `static/player.js`, replace the whole `_addPhraseEvidence` method (lines 1774-1785):

```javascript
    _addPhraseEvidence(evidence) {
        if (!this._phraseSession || !window.KaraokeePhraseEngine) return;
        try {
            KaraokeePhraseEngine.addEvidence(this._phraseSession, evidence);
            KaraokeePhraseEngine.settlePhrases(
                this._phraseSession,
                audio && isFinite(audio.currentTime) ? audio.currentTime : 0
            );
        } catch (e) {
            console.warn('[PhraseEngine] evidence ignored:', e);
        }
    }
```

with:

```javascript
    _addPhraseEvidence(evidence) {
        if (!this._phraseSession || !window.KaraokeePhraseEngine) return;
        try {
            var nowSec = audio && isFinite(audio.currentTime) ? audio.currentTime : 0;
            KaraokeePhraseEngine.addEvidence(this._phraseSession, evidence);
            KaraokeePhraseEngine.settlePhrases(this._phraseSession, nowSec);
            // Content-based catch-up for late recognition (browser SR can batch
            // several lines into one late `final`; realtime Whisper lags too).
            // Reconcile credits the words to the line they were sung on and flips
            // wrongly-missed lines green. Live path handles the active phrase.
            if (evidence.source === 'browser_final' || evidence.source === 'whisper') {
                var confirmed = KaraokeePhraseEngine.reconcileLateEvidence(this._phraseSession, evidence, nowSec);
                if (confirmed && confirmed.length && window.KARAOKEE_V2) {
                    for (var ci = 0; ci < confirmed.length; ci++) {
                        this._paintPhraseCleared(confirmed[ci]);
                    }
                }
            }
        } catch (e) {
            console.warn('[PhraseEngine] evidence ignored:', e);
        }
    }
```

- [ ] **Step 4: Syntax-check player.js**

Run: `node --check static/player.js`
Expected: no output, exit 0 (clean parse).

- [ ] **Step 5: Commit**

```bash
git add static/player.js
git commit -m "feat(player): reconcile late evidence + repaint reconciled lines green

Call reconcileLateEvidence for late sources (browser_final, whisper) after the
live path; extract _paintPhraseCleared (shared with _commitNewlySettled) to flip
a wrongly-missed line green when its batched words arrive a few seconds late.
Player-visible behavior gated on karaokee_v2.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Full regression + browser verification + finish

**Files:** none (verification only)

- [ ] **Step 1: Run all JS golden suites**

Run:
```bash
node tests/test_phrase_engine.cjs
node tests/test_match_helpers.cjs
node tests/test_sync_helpers.cjs
node tests/test_telemetry.cjs
```
Expected: each prints its `... tests passed.` line, exit 0.

- [ ] **Step 2: Run the Python suite**

Run: `python -m pytest tests/test_app.py tests/test_downloader.py tests/test_lyrics.py -q`
Expected: all pass (51 passing as of the last arcade work), no failures.

- [ ] **Step 3: Browser-verify the wiring (manual)**

Start a server with realtime Whisper + Firefox cookies (the configuration that downloads work on this machine):
```powershell
$env:WHISPER_PROVIDER='openai_realtime'; $env:YTDLP_COOKIES_BROWSER='firefox'; python app.py
```
Then in the browser at `http://127.0.0.1:5000/`:
1. Load a song, press `V` (enable `karaokee_v2`), pick a difficulty, start playing and let one line scroll past **unsung** so it settles red.
2. Open DevTools console and inject a late browser_final carrying that line's key word(s), e.g. for a past line whose text you can read on screen:
   ```js
   // pick the controller instance the page exposes, then:
   karaoke._addPhraseEvidence({ source: 'browser_final', text: '<that line\'s words>', words: [], receivedAtSec: performance.now()/1000, audioTimeSec: audio.currentTime });
   ```
   (If the instance isn't named `karaoke`, find it via the play handler; the method is on the controller class.)
3. **Expected:** the previously-red past line flips **green** (its `.word-span`s gain `.matched`), even though it is not the active line, and the honest % headline ticks up. This confirms reconcile → `_paintPhraseCleared` repaints a non-active line.

Kill the server when done (leftover servers squat port 5000):
```powershell
Get-CimInstance Win32_Process -Filter "Name='python.exe'" | ?{$_.CommandLine -like '*app.py*'} | %{Stop-Process -Id $_.ProcessId -Force}
```

- [ ] **Step 4: Finish the development branch**

Announce: "I'm using the finishing-a-development-branch skill to complete this work." Then follow `superpowers:finishing-a-development-branch` — it verifies tests, detects environment, and presents the merge/PR/keep/discard options. Default expectation (matching prior phases): merge `feat/late-evidence-reconciliation` to `main` locally.

**Do NOT flip `karaokee_v2` default-on as part of this work** — the human validation sing-test is the gate for that, and must re-run on a healthy-recognition session first.

---

## Self-Review

**1. Spec coverage:**
- §3 monotonic algorithm + `RECONCILE_LOOKBACK_SEC=18` → Task 1 Steps 3-4. ✔
- §3 returns newly-confirmed phraseIds → Task 1 Step 4 (`newlyConfirmed`). ✔
- §4 wiring in `_addPhraseEvidence` for late sources → Task 3 Step 3. ✔
- §4 `_paintPhraseCleared` extracted from `_commitNewlySettled` + repaint → Task 3 Steps 1-2. ✔
- §6 catch-up, no-distant-cross-match, **inflation-guard (first-class)**, dedup, partial→clear, cheese-safety → Task 1 Step 1 + Task 2 Step 1. ✔
- §6 regression (all `.cjs` + pytest + `node --check`) → Task 3 Step 4, Task 4 Steps 1-2. ✔
- §6 manual *Let It Fly* / red→green flip → Task 4 Step 3. ✔
- §2/§5 honesty preserved, `*_reconciled` tag → Task 1 (tag asserted in Step 1). ✔
- Flag gating + sing-test gate retained → Task 3 (gated on `KARAOKEE_V2`), Task 4 Step 4 note. ✔

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to". All code blocks are complete. The browser-verify `<that line's words>` is an explicit manual-input placeholder for a human step, not code to write. ✔

**3. Type consistency:** Function named `reconcileLateEvidence` everywhere (engine def, export, both player call sites, all tests). Helper named `_paintPhraseCleared` in definition (Task 3 Step 1), `_commitNewlySettled` call (Step 2), and `_addPhraseEvidence` call (Step 3). `anchorHits[idx]` shape `{word, source, evidenceId, score}` matches `addEvidence`'s existing shape. `consumedTokens` push shape matches `addEvidence`'s. ✔
