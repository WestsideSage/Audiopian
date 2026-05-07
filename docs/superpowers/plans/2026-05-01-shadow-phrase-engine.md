# Shadow Phrase Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a shadow-mode phrase scoring engine that can explain lyric-flow performance with phrase segmentation, anchors, delayed settlement, source-specific evidence, and replayable telemetry before it replaces the current line scorer.

**Architecture:** Keep the existing line-level gameplay path intact while a new pure helper module computes phrase plans and phrase traces beside it. `static/player.js` should feed browser SR, Whisper, VAD, and transition events into the shadow engine only when game/debug mode is active, then export structured phrase traces through the existing telemetry JSON.

**Tech Stack:** Flask-served static frontend, browser JavaScript helpers in `static/`, Node CommonJS-style helper tests in `tests/*.cjs`, existing telemetry export from `static/player.js`.

---

## File Structure

- Create: `static/phrase-engine.js`
  - Owns pure phrase segmentation, difficulty profiles, anchor selection, evidence matching, token ownership, phrase settlement, and trace shaping.
- Create: `tests/test_phrase_engine.cjs`
  - Deterministic unit coverage for phrase segmentation, anchor selection, difficulty thresholds, carryover ownership, late settlement, humming rejection, and source-specific evidence roles.
- Modify: `static/player.html`
  - Load `phrase-engine.js` after `scoring.js` and before `player.js`.
- Modify: `static/player.js`
  - Instantiate the shadow phrase engine, feed ASR/Whisper/VAD/line-transition evidence, and append `phraseEngine` data to telemetry without changing current score totals.
- Modify: `tests/test_telemetry_replay.cjs`
  - Add phrase trace replay checks for telemetry fixtures that include the new `phraseEngine` section.
- Modify: `tests/fixtures/telemetry-replay/minimal-session.json`
  - Add a minimal phrase-engine replay fixture with expected behavioral invariants.
- Modify: `docs/algorithms/scoring.md`
  - Document the line scorer as current player-facing scoring and the phrase engine as shadow-mode future scoring.
- Modify: `docs/operations/telemetry.md`
  - Document the new phrase trace schema, benchmark labels, and debug-only verbosity policy.

---

## Task 1: Add Pure Phrase Planning

**Files:**
- Create: `static/phrase-engine.js`
- Create: `tests/test_phrase_engine.cjs`

- [ ] **Step 1: Write failing phrase planning tests**

Create `tests/test_phrase_engine.cjs` with a loader matching the existing helper tests and add these initial assertions:

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

var matchHelpers = loadBrowserCommonJs(path.join(__dirname, '..', 'static', 'match-helpers.js'));
var syncHelpers = loadBrowserCommonJs(path.join(__dirname, '..', 'static', 'sync-helpers.js'));
var scoring = loadBrowserCommonJs(path.join(__dirname, '..', 'static', 'scoring.js'), {
    require: function(specifier) {
        if (specifier === './match-helpers.js') return matchHelpers;
        if (specifier === './sync-helpers.js') return syncHelpers;
        throw new Error('Unexpected require: ' + specifier);
    },
    globalThis: globalThis
});
var phraseEngine = loadBrowserCommonJs(path.join(__dirname, '..', 'static', 'phrase-engine.js'), {
    require: function(specifier) {
        if (specifier === './scoring.js') return scoring;
        if (specifier === './match-helpers.js') return matchHelpers;
        throw new Error('Unexpected require: ' + specifier);
    },
    globalThis: globalThis
});

var lyrics = [
    { time: 10, text: 'First bar hits hard with a final word' },
    { time: 14, text: 'Second bar starts fast' },
    { time: 18, text: 'yeah yeah' }
];

var plan = phraseEngine.buildPhrasePlan(lyrics, { difficulty: 'hard', audioDuration: 22 });

assert.ok(plan.phrases.length >= 3, 'builds phrases from lyric lines');
assert.strictEqual(plan.phrases[0].lineIdx, 0, 'preserves source line index');
assert.strictEqual(plan.phrases[0].startSec, 10, 'uses lyric timestamp as phrase start');
assert.strictEqual(plan.phrases[0].endSec, 14, 'uses next lyric timestamp as phrase end');
assert.ok(plan.phrases[0].anchors.some(function(anchor) { return anchor.word === 'final'; }), 'selects distinctive anchors');
assert.ok(!plan.phrases[2].anchors.some(function(anchor) { return anchor.word === 'yeah'; }), 'does not anchor adlib-only filler words');
assert.ok(plan.difficulty.requiredAnchorRatio > 0.5, 'hard profile requires meaningful anchor coverage');

console.log('Phrase engine tests passed.');
```

- [ ] **Step 2: Run the failing test**

Run: `node tests/test_phrase_engine.cjs`

Expected: FAIL because `static/phrase-engine.js` does not exist.

- [ ] **Step 3: Implement minimal phrase planning**

Create `static/phrase-engine.js` with a UMD wrapper like `static/scoring.js`. Export:

```javascript
buildPhrasePlan(lyrics, options)
getDifficultyProfile(difficulty)
selectAnchors(words, difficultyProfile)
```

Implementation rules:

- Normalize words with `scoring.normalizeWords()`.
- Start from LRC lines.
- Use next line timestamp as the current line end; use `audioDuration` or `start + 8` for the final line.
- Split only when a line has more than 14 normalized words or more than 3.5 words per second.
- For split lines, divide words into chunks of 6-10 words and split the timestamp window proportionally.
- Anchor candidates must exclude adlibs/function words from `classifyWord()`, words shorter than 3 characters, and repeated filler such as `yeah`, `uh`, `oh`, `ay`, `la`.
- Anchor weight should start from word class weight and add small boosts for final phrase words and words length 6+.
- Difficulty profiles:

```javascript
easy:   { requiredAnchorRatio: 0.20, timingToleranceMs: 1400, settlementMs: 1800, minFlowCoverage: 0.20 }
medium: { requiredAnchorRatio: 0.45, timingToleranceMs: 1000, settlementMs: 1400, minFlowCoverage: 0.45 }
hard:   { requiredAnchorRatio: 0.65, timingToleranceMs: 750,  settlementMs: 1100, minFlowCoverage: 0.65 }
expert: { requiredAnchorRatio: 0.80, timingToleranceMs: 500,  settlementMs: 900,  minFlowCoverage: 0.80 }
```

- [ ] **Step 4: Run phrase planning tests**

Run: `node tests/test_phrase_engine.cjs`

Expected: PASS.

- [ ] **Step 5: Run existing helper tests**

Run:

```powershell
node tests/test_scoring.cjs
node tests/test_match_helpers.cjs
node tests/test_sync_helpers.cjs
```

Expected: all pass.

---

## Task 2: Add Evidence Matching And Phrase Settlement

**Files:**
- Modify: `static/phrase-engine.js`
- Modify: `tests/test_phrase_engine.cjs`

- [ ] **Step 1: Add failing settlement tests**

Append tests that create a phrase plan from:

```javascript
[
    { time: 0, text: 'alpha bravo final' },
    { time: 3, text: 'charlie delta start' }
]
```

Assert:

- Browser final evidence `alpha bravo final charlie` at `receivedAtSec: 3.2` credits phrase 0 during settlement and phrase 1 for `charlie`.
- The token `charlie` is consumed once and cannot also validate phrase 0.
- Evidence source `vad` with no words increases flow coverage but does not clear anchors.
- Evidence source `whisper` can rescue a missed anchor within the review window but does not mark the phrase `liveClean`.
- Late-but-correct evidence produces `accuracyStatus: 'confirmed'` and `flowStatus: 'late'`.

- [ ] **Step 2: Run the failing test**

Run: `node tests/test_phrase_engine.cjs`

Expected: FAIL because evidence APIs are missing.

- [ ] **Step 3: Implement evidence APIs**

Add exports:

```javascript
createPhraseSession(phrasePlan)
addEvidence(session, evidence)
settlePhrases(session, nowSec)
getPhraseTrace(session)
```

Evidence shape:

```javascript
{
    id: 'browser-1',
    source: 'browser_final' | 'browser_interim' | 'whisper' | 'vad',
    text: 'recognized words',
    words: [{ word: 'recognized', start: 1.2, end: 1.5 }],
    receivedAtSec: 3.2,
    audioTimeSec: 2.9
}
```

Implementation rules:

- Convert text to normalized tokens if `words` is empty.
- Build candidate matches by comparing each evidence token to unconsumed phrase anchors with `scoring.wordsMatchScore()`.
- Match score roles:
  - `browser_final`: normal settlement evidence.
  - `browser_interim`: provisional only.
  - `whisper`: rescue/confirmation only.
  - `vad`: flow only, no lyric accuracy.
- A token can be consumed by only one phrase anchor.
- Prefer candidates by higher textual score, then closer timing, then older phrase if inside settlement.
- Keep rejected candidates with reason: `low_score`, `outside_window`, `already_consumed`, `weak_source`, or `generic_word`.
- A phrase can settle after `endSec + settlementMs / 1000`.
- Phrase result fields:

```javascript
{
    phraseId: 'p0',
    lineIdx: 0,
    text: 'alpha bravo final',
    status: 'open' | 'settling' | 'settled',
    lyricStatus: 'missing' | 'partial' | 'confirmed',
    flowStatus: 'silent' | 'early' | 'clean' | 'late',
    cleared: true,
    rescuedByWhisper: false,
    anchorsHit: 2,
    anchorsRequired: 2
}
```

- [ ] **Step 4: Run phrase engine tests**

Run: `node tests/test_phrase_engine.cjs`

Expected: PASS.

---

## Task 3: Wire Shadow Engine Into The Player Without Changing Scores

**Files:**
- Modify: `static/player.html`
- Modify: `static/player.js`
- Modify: `tests/test_phrase_engine.cjs`

- [ ] **Step 1: Load the new helper**

In `static/player.html`, add:

```html
<script src="/static/phrase-engine.js"></script>
```

between `scoring.js` and `player.js`.

- [ ] **Step 2: Initialize shadow state**

In `GameMode` construction/reset paths in `static/player.js`, add fields:

```javascript
this._phrasePlan = null;
this._phraseSession = null;
this._phraseDifficulty = 'medium';
```

In game start, after lyrics and word timings are available:

```javascript
if (window.KaraokeePhraseEngine) {
    this._phrasePlan = KaraokeePhraseEngine.buildPhrasePlan(lyrics, {
        difficulty: this._phraseDifficulty,
        audioDuration: audio && isFinite(audio.duration) ? audio.duration : null
    });
    this._phraseSession = KaraokeePhraseEngine.createPhraseSession(this._phrasePlan);
}
```

- [ ] **Step 3: Feed browser SR evidence**

Inside `recognition.onresult`, after `_logAsr(...)`, add:

```javascript
this._addPhraseEvidence({
    source: finalText ? 'browser_final' : 'browser_interim',
    text: finalText || interim,
    words: [],
    receivedAtSec: performance.now() / 1000,
    audioTimeSec: audio && isFinite(audio.currentTime) ? audio.currentTime : null
});
```

Because the current callback uses `self`, call `self._addPhraseEvidence(...)` there.

- [ ] **Step 4: Feed Whisper evidence**

Inside `_sendWhisperChunk`, after `_logAsr('final', data.transcript, data.words || [], 'whisper')`, add:

```javascript
this._addPhraseEvidence({
    source: 'whisper',
    text: data.transcript || '',
    words: data.words || [],
    receivedAtSec: performance.now() / 1000,
    audioTimeSec: audio && isFinite(audio.currentTime) ? audio.currentTime : null
});
```

- [ ] **Step 5: Feed VAD/flow evidence**

Where VAD currently creates provisional word matches, call:

```javascript
this._addPhraseEvidence({
    source: 'vad',
    text: '',
    words: [],
    receivedAtSec: performance.now() / 1000,
    audioTimeSec: audio && isFinite(audio.currentTime) ? audio.currentTime : null
});
```

The first version can record VAD presence count per active phrase without attempting pitch or word content.

- [ ] **Step 6: Add the player helper**

Add this method to `GameMode`:

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

- [ ] **Step 7: Verify no score behavior changed**

Run:

```powershell
node tests/test_scoring.cjs
node tests/test_phrase_engine.cjs
```

Expected: both pass. The existing modal score and line score should still come from `_scoreLine()`.

---

## Task 4: Export Phrase Trace Telemetry

**Files:**
- Modify: `static/player.js`
- Modify: `docs/operations/telemetry.md`

- [ ] **Step 1: Extend telemetry initialization**

In `_initTelemetry()`, add:

```javascript
phraseEngine: {
    version: 1,
    mode: 'shadow',
    difficulty: this._phraseDifficulty || 'medium',
    benchmark: null,
    plan: null,
    traces: []
}
```

- [ ] **Step 2: Snapshot phrase plan after initialization**

After creating `_phrasePlan`, if telemetry exists:

```javascript
if (this._telemetry && this._telemetry.phraseEngine) {
    this._telemetry.phraseEngine.difficulty = this._phraseDifficulty;
    this._telemetry.phraseEngine.plan = this._phrasePlan;
}
```

- [ ] **Step 3: Export final trace**

In `_downloadTelemetry()`, before `JSON.stringify`, add:

```javascript
if (this._telemetry.phraseEngine && this._phraseSession && window.KaraokeePhraseEngine) {
    this._telemetry.phraseEngine.traces = KaraokeePhraseEngine.getPhraseTrace(this._phraseSession);
}
```

- [ ] **Step 4: Document schema**

Update `docs/operations/telemetry.md` to add:

```markdown
## Phrase Engine Shadow Trace

Debug telemetry may include `phraseEngine`:

- `version`: trace schema version.
- `mode`: currently `shadow`; it does not drive player-facing scores.
- `difficulty`: `easy`, `medium`, `hard`, or `expert`.
- `benchmark`: optional user labels for intent, outcome, fairness, and notes.
- `plan`: generated phrase timing, anchors, and thresholds.
- `traces`: phrase-level evidence, consumed tokens, rejected candidates, flow status, lyric status, and settlement result.

This section is intentionally verbose in debug/benchmark mode. Normal play should keep telemetry lighter once a non-debug telemetry path exists.
```

- [ ] **Step 5: Verify syntax and docs**

Run:

```powershell
node tests/test_phrase_engine.cjs
node tests/test_telemetry_replay.cjs
```

Expected: both pass.

---

## Task 5: Add Benchmark Labels And Post-Run Feedback

**Files:**
- Modify: `static/player.html`
- Modify: `static/player.js`
- Modify: `docs/operations/telemetry.md`

- [ ] **Step 1: Add lightweight benchmark controls**

In the final score modal, add controls that only need to be used in debug sessions:

```html
<div class="benchmark-feedback" id="benchmarkFeedback" style="display:none">
    <label>Run intent
        <select id="benchmarkIntent">
            <option value="">Unlabeled</option>
            <option value="good_expert_run">Good expert run</option>
            <option value="humming_cheese">Humming cheese</option>
            <option value="late_delivery">Late delivery</option>
            <option value="partial_memory">Partial memory</option>
            <option value="silent_section_test">Silent section test</option>
        </select>
    </label>
    <label>Fairness
        <select id="benchmarkFairness">
            <option value="">Unjudged</option>
            <option value="fair">Fair</option>
            <option value="too_strict">Too strict</option>
            <option value="too_forgiving">Too forgiving</option>
            <option value="recognizer_lagged">Recognizer lagged</option>
            <option value="lyrics_misaligned">Lyrics misaligned</option>
        </select>
    </label>
    <textarea id="benchmarkNotes" rows="3" placeholder="Short note for AI analysis"></textarea>
</div>
```

- [ ] **Step 2: Show feedback only in debug mode**

When the modal opens, set:

```javascript
var feedback = document.getElementById('benchmarkFeedback');
if (feedback) feedback.style.display = window._kDebug ? 'block' : 'none';
```

- [ ] **Step 3: Save labels into telemetry before download**

In `_downloadTelemetry()`, before serialization:

```javascript
var intentEl = document.getElementById('benchmarkIntent');
var fairnessEl = document.getElementById('benchmarkFairness');
var notesEl = document.getElementById('benchmarkNotes');
if (this._telemetry.phraseEngine) {
    this._telemetry.phraseEngine.benchmark = {
        intent: intentEl ? intentEl.value : '',
        fairness: fairnessEl ? fairnessEl.value : '',
        notes: notesEl ? notesEl.value : ''
    };
}
```

- [ ] **Step 4: Verify telemetry includes labels**

Manual browser smoke test:

1. Run `python app.py`.
2. Load a short song.
3. Start game mode.
4. Enable debug HUD.
5. Finish or seek near the end.
6. Select benchmark labels.
7. Export telemetry.
8. Confirm exported JSON contains `phraseEngine.benchmark`.

Expected: existing score behavior remains unchanged and benchmark labels export.

---

## Task 6: Add Replay-Oriented Phrase Invariants

**Files:**
- Modify: `tests/test_telemetry_replay.cjs`
- Modify: `tests/fixtures/telemetry-replay/minimal-session.json`

- [ ] **Step 1: Extend the fixture**

Add a `phraseEngine` fixture section:

```json
{
  "version": 1,
  "mode": "shadow",
  "difficulty": "hard",
  "benchmark": {
    "intent": "good_expert_run",
    "fairness": "fair",
    "notes": "fixture validates phrase trace shape"
  },
  "traces": [
    {
      "phraseId": "p0",
      "lyricStatus": "confirmed",
      "flowStatus": "clean",
      "cleared": true,
      "anchorsHit": 2,
      "anchorsRequired": 2,
      "rejectedCandidates": []
    },
    {
      "phraseId": "p1",
      "lyricStatus": "missing",
      "flowStatus": "clean",
      "cleared": false,
      "anchorsHit": 0,
      "anchorsRequired": 2,
      "rejectedCandidates": [
        { "reason": "weak_source", "source": "vad" }
      ]
    }
  ],
  "invariants": {
    "confirmedPhraseClears": true,
    "vadOnlyDoesNotClear": true
  }
}
```

Preserve the existing top-level fixture shape and line replay inputs.

- [ ] **Step 2: Add invariant checks**

In `tests/test_telemetry_replay.cjs`, after existing line checks:

```javascript
if (telemetry.phraseEngine) {
    var traces = telemetry.phraseEngine.traces || [];
    var confirmed = traces.find(function(trace) { return trace.phraseId === 'p0'; });
    var vadOnly = traces.find(function(trace) { return trace.phraseId === 'p1'; });

    assert.ok(confirmed, 'missing confirmed phrase trace');
    assert.strictEqual(confirmed.cleared, true, 'confirmed phrase should clear');
    assert.strictEqual(confirmed.lyricStatus, 'confirmed', 'confirmed phrase lyric status');

    assert.ok(vadOnly, 'missing vad-only phrase trace');
    assert.strictEqual(vadOnly.cleared, false, 'vad-only phrase should not clear');
    assert.ok(
        (vadOnly.rejectedCandidates || []).some(function(candidate) { return candidate.reason === 'weak_source'; }),
        'vad-only trace should explain rejected lyric evidence'
    );
}
```

- [ ] **Step 3: Run replay tests**

Run:

```powershell
node tests/test_telemetry_replay.cjs
node tests/test_phrase_engine.cjs
```

Expected: both pass.

---

## Task 7: Document The New Engine Story

**Files:**
- Modify: `docs/algorithms/scoring.md`
- Modify: `docs/architecture.md`

- [ ] **Step 1: Update scoring docs**

Add a section to `docs/algorithms/scoring.md`:

```markdown
## Shadow Phrase Engine

The phrase engine is the next scoring architecture and currently runs in shadow mode. It does not replace line-level score totals until benchmark evidence shows it is fairer and more stable.

The phrase engine treats each song as timed phrases rather than closed lines. Each phrase has selected anchors, a difficulty profile, a settlement window, and source-specific evidence. Browser SR can provide provisional and final near-live evidence. Whisper can rescue or confirm recent phrases, but it should not control live timing. VAD can prove vocal presence and flow, but it cannot prove lyric correctness by itself.

The target behavior is lyric-flow scoring: presence unlocks scoring, flow determines timing quality, and lyric anchors determine whether the flow counts.
```

- [ ] **Step 2: Update architecture docs**

In `docs/architecture.md`, add `phrase-engine.js` to the production frontend load path and describe it as shadow-mode only.

- [ ] **Step 3: Verify docs mention shadow mode**

Run:

```powershell
Select-String -Path docs\architecture.md,docs\algorithms\scoring.md,docs\operations\telemetry.md -Pattern "phrase engine|shadow"
```

Expected: each file has relevant entries.

---

## Final Verification

Run:

```powershell
node tests/test_phrase_engine.cjs
node tests/test_scoring.cjs
node tests/test_match_helpers.cjs
node tests/test_sync_helpers.cjs
node tests/test_telemetry_replay.cjs
python -m pytest tests/test_app.py tests/test_downloader.py tests/test_lyrics.py -v
```

Manual smoke test required because this touches playback, timing, ASR, scoring, telemetry, and debug behavior:

1. Run `python app.py`.
2. Load a known short song.
3. Start Game mode.
4. Enable debug HUD.
5. Produce browser SR and, if available, Whisper evidence.
6. Export telemetry.
7. Confirm current player-facing score still behaves as before.
8. Confirm telemetry contains `phraseEngine.plan`, `phraseEngine.traces`, rejected candidates, consumed evidence, and optional benchmark labels.

---

## Rollout Boundary

This milestone must not switch player-facing scoring to the phrase engine. It only creates the shadow engine, trace output, benchmark labels, and replay invariants. The next milestone can use the generated traces to decide whether phrase scoring is ready to drive the UI.
