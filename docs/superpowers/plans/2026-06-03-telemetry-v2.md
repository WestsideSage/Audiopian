# Telemetry v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each run's telemetry analysis-ready (final scores + arcade event log + a scannable `summary` with a cheese/honesty correlation) and auto-saved server-side via a new `POST /telemetry` endpoint — lean by default, full raw arrays behind debug (`D`).

**Architecture:** A new pure `static/telemetry-helpers.js` (`summarizeRun`) derives the digest; `static/player.js` records arcade commit events, assembles the payload through one shared builder, and auto-POSTs on every run end; `app.py` persists to `output_telemetry/<date>/`. Additive schema (`schemaVersion: 2`) — existing v1 files still parse.

**Tech Stack:** Plain ES5-style browser JS (UMD module for Node `require()` + `loadBrowserCommonJs` tests), Flask, Node `.cjs` golden tests, pytest. Author all JS with the Write/Edit tools directly (Windows backtick gotcha); the new module uses string concatenation.

**Source spec:** [`docs/superpowers/specs/2026-06-03-telemetry-v2-design.md`](../specs/2026-06-03-telemetry-v2-design.md)

---

## File Structure

- **Create `static/telemetry-helpers.js`** — pure `summarizeRun(inputs)` + `median(nums)` + `CHEESE_INTENTS`. No DOM/deps.
- **Create `tests/test_telemetry_helpers.cjs`** — golden assertions.
- **Modify `app.py`** — `POST /telemetry` route (write to `output_telemetry/<date>/`, path-safe, size-capped).
- **Modify `tests/test_app.py`** — pytest for the endpoint (valid write + invalid JSON).
- **Modify `static/player.html`** — add the `telemetry-helpers.js` script include.
- **Modify `static/player.js`** — record `_arcadeEvents[]`; `_buildTelemetryPayload`; `_finalizeTelemetry`; refactor `_downloadTelemetry`; reorder `showEndModal` to finalize before the hi-score write; finalize on `stop()`; reset flags in `start()`; drop the debug auto-download in the `ended` handler.
- **Modify `CLAUDE.md`** — correct the telemetry note.

**Build order:** A (pure helper + tests) → B (server endpoint + test) → C (client wiring that uses A + B).

---

## Phase A — `telemetry-helpers.js` pure module (TDD)

### Task A1: Write the golden tests first

**Files:**
- Create: `tests/test_telemetry_helpers.cjs`

- [ ] **Step 1: Write the failing test file**

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

var T = loadBrowserCommonJs(path.join(__dirname, '..', 'static', 'telemetry-helpers.js'));

// --- median ---
assert.strictEqual(T.median([]), null, 'empty median is null');
assert.strictEqual(T.median([5]), 5, 'single');
assert.strictEqual(T.median([3, 1, 2]), 2, 'odd median (sorted middle)');
assert.strictEqual(T.median([4, 1, 2, 3]), 2.5, 'even median (avg of middle two)');

// Trace helper: a phrase trace with given lyricStatus and per-token sources.
function trace(lyricStatus, sources) {
    return { lyricStatus: lyricStatus, consumedTokens: (sources || []).map(function (s) { return { source: s }; }) };
}

// --- phraseOutcomes tally ---
var base = {
    difficulty: 'hard', karaokeeV2: true,
    scores: { v1Pct: 61, honestLyricPct: 68, composite: 72 },
    arcadeSummary: { points: 8400, maxMultiplier: 6, longestStreak: 9, perfects: 4, clears: 2 },
    grade: 'B',
    phraseTraces: [
        trace('confirmed', ['whisper', 'whisper', 'browser_sr']),
        trace('confirmed', ['browser_sr', 'browser_sr']),
        trace('partial', ['vad']),
        trace('missing', [])
    ],
    arcadeEvents: [{ outcome: 'clear' }, { outcome: 'clear' }, { outcome: 'partial' }, { outcome: 'miss' }],
    transitions: [{ earlyMs: 100, lateMs: null }, { earlyMs: null, lateMs: 300 }, { earlyMs: null, lateMs: 200 }],
    finalWordSourceCounts: { vad: 1, browser_sr: 3, whisper: 2, unknown: 0 },
    benchmarkIntent: 'good_expert_run',
    counts: { asr: 0, matches: 0, promotions: 0, transitions: 3, arcadeEvents: 4 }
};
var s = T.summarizeRun(base);
assert.deepStrictEqual(s.phraseOutcomes, { cleared: 2, partial: 1, missed: 1, total: 4 }, 'outcome tally');

// --- clearsBySource: dominant source per cleared phrase ---
// phrase 1 -> whisper (2 vs 1); phrase 2 -> browser_sr (2). partial/missing excluded.
assert.deepStrictEqual(s.recognizer.clearsBySource, { whisper: 1, browser_sr: 1, vad: 0 }, 'dominant source per clear');
assert.deepStrictEqual(s.recognizer.finalWordSourceCounts, base.finalWordSourceCounts, 'final word source counts passthrough');

// --- clearsBySource tie-break: whisper > browser_sr > vad ---
var tie = Object.assign({}, base, { phraseTraces: [trace('confirmed', ['browser_sr', 'whisper'])] });
assert.strictEqual(T.summarizeRun(tie).recognizer.clearsBySource.whisper, 1, 'tie breaks to whisper');

// --- sync ---
assert.strictEqual(s.sync.linesEarly, 1, 'one early line');
assert.strictEqual(s.sync.linesLate, 2, 'two late lines');
assert.strictEqual(s.sync.medianLineDriftMs, 200, 'median drift of [100,300,200] = 200');

// --- scores / arcade passthrough ---
assert.deepStrictEqual(s.scores, base.scores);
assert.strictEqual(s.arcade.points, 8400);
assert.strictEqual(s.arcade.grade, 'B');
assert.strictEqual(s.arcade.maxMultiplier, 6);

// --- honesty: honest intent + points -> not flagged ---
assert.strictEqual(s.honesty.pointsBuilt, true);
assert.strictEqual(s.honesty.suspectedCheeseInflation, false, 'good_expert_run is never cheese');

// --- honesty: cheese intent + points built -> FLAGGED ---
var cheese = Object.assign({}, base, { benchmarkIntent: 'humming_cheese' });
var cs = T.summarizeRun(cheese);
assert.strictEqual(cs.honesty.suspectedCheeseInflation, true, 'humming_cheese that scored points is flagged');

// --- honesty: cheese intent + zero points + 1x -> not flagged ---
var cleanCheese = Object.assign({}, base, {
    benchmarkIntent: 'humming_cheese',
    arcadeSummary: { points: 0, maxMultiplier: 1, longestStreak: 0, perfects: 0, clears: 0 }
});
var cc = T.summarizeRun(cleanCheese);
assert.strictEqual(cc.honesty.pointsBuilt, false);
assert.strictEqual(cc.honesty.suspectedCheeseInflation, false, 'cheese that built nothing is the PASS case');

// --- V1 run (no arcade state) -> arcade zeros, pointsBuilt false ---
var v1 = Object.assign({}, base, { karaokeeV2: false, arcadeSummary: null });
var v1s = T.summarizeRun(v1);
assert.strictEqual(v1s.arcade.points, 0, 'null arcade summary -> 0 points');
assert.strictEqual(v1s.honesty.pointsBuilt, false);
assert.strictEqual(v1s.counts.transitions, 3, 'counts passthrough');

console.log('test_telemetry_helpers.cjs: all assertions passed');
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/test_telemetry_helpers.cjs`
Expected: FAIL — `ENOENT` (module file missing).

### Task A2: Implement the module

**Files:**
- Create: `static/telemetry-helpers.js`

- [ ] **Step 1: Write the module** (string concatenation only — no template literals):

```javascript
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        root.KaraokeeTelemetry = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // Benchmark intent labels that mean "this run was deliberate cheese" — used to
    // flag runs where the arcade nonetheless built credit (a validation failure).
    var CHEESE_INTENTS = { humming_cheese: true, silent_section_test: true };

    // Source preference for breaking clearsBySource ties.
    var SOURCE_RANK = { whisper: 3, browser_sr: 2, vad: 1 };

    function median(nums) {
        if (!nums || nums.length === 0) return null;
        var arr = nums.slice().sort(function (a, b) { return a - b; });
        var mid = Math.floor(arr.length / 2);
        return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
    }

    function dominantSource(consumedTokens) {
        var counts = {};
        (consumedTokens || []).forEach(function (t) {
            var s = t && t.source;
            if (!s) return;
            counts[s] = (counts[s] || 0) + 1;
        });
        var best = null, bestN = -1;
        Object.keys(counts).forEach(function (s) {
            var n = counts[s];
            if (n > bestN || (n === bestN && (SOURCE_RANK[s] || 0) > (SOURCE_RANK[best] || 0))) {
                best = s; bestN = n;
            }
        });
        return best;
    }

    // inputs documented in the spec section 4.1. Pure: only derives.
    function summarizeRun(inputs) {
        inputs = inputs || {};
        var arc = inputs.arcadeSummary || { points: 0, maxMultiplier: 1, longestStreak: 0, perfects: 0, clears: 0 };
        var traces = inputs.phraseTraces || [];
        var transitions = inputs.transitions || [];

        var outcomes = { cleared: 0, partial: 0, missed: 0, total: traces.length };
        var clearsBySource = { whisper: 0, browser_sr: 0, vad: 0 };
        traces.forEach(function (tr) {
            if (tr.lyricStatus === 'confirmed') {
                outcomes.cleared++;
                var src = dominantSource(tr.consumedTokens);
                if (src && clearsBySource[src] != null) clearsBySource[src]++;
            } else if (tr.lyricStatus === 'partial') {
                outcomes.partial++;
            } else {
                outcomes.missed++;
            }
        });

        var drifts = [], early = 0, late = 0;
        transitions.forEach(function (t) {
            if (t.earlyMs != null) { drifts.push(Math.abs(t.earlyMs)); early++; }
            else if (t.lateMs != null) { drifts.push(Math.abs(t.lateMs)); late++; }
        });

        var pointsBuilt = (arc.points || 0) > 0;
        var maxMult = arc.maxMultiplier || 1;
        var intent = inputs.benchmarkIntent || '';
        var isCheeseIntent = !!CHEESE_INTENTS[intent];

        return {
            difficulty: inputs.difficulty || 'medium',
            karaokeeV2: !!inputs.karaokeeV2,
            scores: inputs.scores || { v1Pct: null, honestLyricPct: null, composite: null },
            arcade: {
                points: arc.points || 0,
                grade: inputs.grade || null,
                maxMultiplier: maxMult,
                longestStreak: arc.longestStreak || 0,
                perfects: arc.perfects || 0,
                clears: arc.clears || 0
            },
            phraseOutcomes: outcomes,
            recognizer: {
                clearsBySource: clearsBySource,
                finalWordSourceCounts: inputs.finalWordSourceCounts || {}
            },
            sync: {
                medianLineDriftMs: median(drifts),
                linesEarly: early,
                linesLate: late
            },
            honesty: {
                benchmarkIntent: intent,
                pointsBuilt: pointsBuilt,
                maxMultiplier: maxMult,
                suspectedCheeseInflation: isCheeseIntent && (pointsBuilt || maxMult > 1)
            },
            counts: inputs.counts || {}
        };
    }

    return {
        CHEESE_INTENTS: CHEESE_INTENTS,
        median: median,
        summarizeRun: summarizeRun
    };
});
```

- [ ] **Step 2: Run the tests**

Run: `node tests/test_telemetry_helpers.cjs`
Expected: `test_telemetry_helpers.cjs: all assertions passed`

- [ ] **Step 3: Syntax check**

Run: `node --check static/telemetry-helpers.js`
Expected: no output (exit 0).

- [ ] **Step 4: Commit**

```bash
git add static/telemetry-helpers.js tests/test_telemetry_helpers.cjs
git commit -m "feat(telemetry): pure summarizeRun digest module + golden tests"
```

---

## Phase B — `POST /telemetry` server endpoint

### Task B1: Add the route

**Files:**
- Modify: `app.py` (imports near top ~line 1-9; new route after the `/audio` route ~line 356)

- [ ] **Step 1: Add `json` and `re` imports** — extend the stdlib import block at the top of `app.py` (after `import mimetypes`):

```python
import json
import re
from datetime import datetime, timezone
```

- [ ] **Step 2: Add the route** after the `/audio` route (after its `return send_file(...)`, ~line 356):

```python
_TELEMETRY_MAX_BYTES = 8 * 1024 * 1024  # 8 MB safety cap


@app.route("/telemetry", methods=["POST"])
def save_telemetry():
    # Persist one session's telemetry JSON to output_telemetry/<YYYY-MM-DD>/.
    raw = request.get_data(cache=False)
    if len(raw) > _TELEMETRY_MAX_BYTES:
        return jsonify({"error": "Payload too large"}), 413
    try:
        payload = json.loads(raw)
    except Exception:
        return jsonify({"error": "Invalid JSON"}), 400
    if not isinstance(payload, dict):
        return jsonify({"error": "Expected a JSON object"}), 400

    meta = payload.get("meta") or {}
    started = str(meta.get("startedAt") or "")
    # Date folder: from the payload's startedAt if it's a clean ISO date, else server UTC date.
    date_folder = started[:10]
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", date_folder):
        date_folder = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    # Filename timestamp: from endedAt/startedAt, colon/dot -> dash, sanitized; else server time.
    ended = str(meta.get("endedAt") or started or "")
    ts = re.sub(r"[:.]", "-", ended)[:19]
    ts = re.sub(r"[^0-9A-Za-z\-T]", "", ts)
    if not ts:
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S")

    out_dir = os.path.join(_HERE, "output_telemetry", date_folder)
    os.makedirs(out_dir, exist_ok=True)
    fname = "karaokee-telemetry-" + ts + ".json"
    path = os.path.join(out_dir, fname)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    return jsonify({"ok": True, "path": os.path.relpath(path, _HERE)})
```

- [ ] **Step 3: Syntax check**

Run: `python -c "import ast; ast.parse(open('app.py').read())"`
Expected: no output (exit 0).

### Task B2: Endpoint tests

**Files:**
- Modify: `tests/test_app.py` (append; reuses the existing `client` fixture)

- [ ] **Step 1: Add tests** at the end of `tests/test_app.py` (add `import os` to the existing imports at the top if not present):

```python
def test_telemetry_rejects_invalid_json(client):
    resp = client.post("/telemetry", data=b"not json", content_type="application/json")
    assert resp.status_code == 400


def test_telemetry_writes_file(client):
    # Far-future date so the artifact is obviously test data; cleaned up below.
    payload = {
        "meta": {"startedAt": "2099-01-02T03:04:05.000Z", "endedAt": "2099-01-02T03:09:00.000Z"},
        "summary": {"scores": {"honestLyricPct": 50}},
    }
    resp = client.post("/telemetry", json=payload)
    assert resp.status_code == 200
    data = json.loads(resp.data)
    assert data["ok"] is True
    from app import _HERE
    full = os.path.join(_HERE, data["path"])
    try:
        assert os.path.exists(full)
        assert "2099-01-02" in data["path"]
        with open(full, encoding="utf-8") as f:
            saved = json.load(f)
        assert saved["meta"]["startedAt"] == "2099-01-02T03:04:05.000Z"
    finally:
        if os.path.exists(full):
            os.remove(full)
        d = os.path.dirname(full)
        if os.path.isdir(d) and not os.listdir(d):
            os.rmdir(d)
```

(The 8 MB cap is a defensive guard; not unit-tested to avoid an 8 MB request body.)

- [ ] **Step 2: Run the endpoint tests**

Run: `python -m pytest tests/test_app.py -q -k telemetry`
Expected: 2 passed.

- [ ] **Step 3: Commit**

```bash
git add app.py tests/test_app.py
git commit -m "feat(telemetry): POST /telemetry endpoint persists sessions to output_telemetry/<date>"
```

---

## Phase C — Wire the client (player.js) to build, finalize, and auto-save

### Task C1: Script include + arcade-event recording + flag resets

**Files:**
- Modify: `static/player.html` (script includes ~after `scoring-arcade.js`); `static/player.js` (`_commitNewlySettled`; `start()` arcade-state block; `_resetSessionCounters`)

- [ ] **Step 1: Add the module include** in `player.html` — after the `scoring-arcade.js` line:

```html
    <script src="/static/telemetry-helpers.js"></script>
```

- [ ] **Step 2: Record each commit into `_arcadeEvents`** — in `_commitNewlySettled` (`player.js`), inside the loop, right after the `var evt = KaraokeeArcade.commitPhrase(...)` call and before the `if (evt && routeEvents ...)` line, add capture:

```javascript
                if (evt) {
                    if (!this._arcadeEvents) this._arcadeEvents = [];
                    this._arcadeEvents.push({
                        phraseId: ph.phraseId,
                        lineIdx: ph.lineIdx,
                        settledAtSec: parseFloat((now != null ? now : 0).toFixed(2)),
                        outcome: evt.outcome,
                        perfect: evt.perfect,
                        anchorsRequired: ph.anchorsRequired,
                        anchorsTotal: (ph.anchors || []).length,
                        anchorsHit: Object.keys(pst.anchorHits).length,
                        pointsAwarded: evt.pointsAwarded,
                        multiplierAfter: evt.multiplier,
                        streakAfter: evt.streak,
                        onFire: evt.onFire
                    });
                }
```

`_commitNewlySettled` does not currently have `now` in scope — add it at the top of the method:

```javascript
    _commitNewlySettled(routeEvents) {
        if (!this._arcadeState || !window.KaraokeeArcade || !this._phrasePlan || !this._phraseSession) return;
        var now = (audio && isFinite(audio.currentTime)) ? audio.currentTime : 0;
        var phrases = this._phrasePlan.phrases || [];
```

- [ ] **Step 3: Initialise `_arcadeEvents` + `_telemetryFinalized` in `start()`** — in the arcade-state block (where `this._committedPhrases = {};` is set), add:

```javascript
            this._arcadeEvents = [];
            this._telemetryFinalized = false;
```

- [ ] **Step 4: Reset them in `_resetSessionCounters`** — alongside the existing `this._committedPhrases = {};` line there, add:

```javascript
        this._arcadeEvents = [];
        this._telemetryFinalized = false;
```

- [ ] **Step 5: Syntax check**

Run: `node --check static/player.js`
Expected: no output (exit 0).

- [ ] **Step 6: Commit**

```bash
git add static/player.html static/player.js
git commit -m "feat(telemetry): record per-phrase arcade commit events; include telemetry-helpers"
```

### Task C2: Shared payload builder + refactor `_downloadTelemetry`

**Files:**
- Modify: `static/player.js` (`_downloadTelemetry` ~line 2271)

- [ ] **Step 1: Extract `_buildTelemetryPayload`** — replace the body of `_downloadTelemetry` (the meta-assembly through the `var json = JSON.stringify(...)`/blob/download) so the assembly lives in a new builder and the download just serializes it. Replace from `_downloadTelemetry() {` through its closing brace with:

```javascript
    _buildTelemetryPayload(endReason) {
        if (!this._telemetry) return null;
        var meta = this._telemetry.meta;
        if (!meta.songDurationMs && audio && isFinite(audio.duration)) {
            meta.songDurationMs = Math.round(audio.duration * 1000);
        }
        if (meta.whisperAvailable === null) meta.whisperAvailable = !!(this._whisperStream);
        meta.whisperStatusAtStart  = this._whisperServerStatus ? Object.assign({}, this._whisperServerStatus) : null;
        meta.whisperStatusFinal    = {
            state: this._whisperServerStatus ? this._whisperServerStatus.state : 'unknown',
            reason: this._whisperServerStatus ? this._whisperServerStatus.reason : null,
            provider: this._whisperServerStatus ? this._whisperServerStatus.provider : null,
            model: this._whisperServerStatus ? this._whisperServerStatus.model : null
        };
        meta.whisperTrackStatus    = this._whisperTrackStatus ? Object.assign({}, this._whisperTrackStatus) : null;
        meta.whisperProvider       = this._whisperServerStatus ? this._whisperServerStatus.provider : null;
        meta.whisperModel          = this._whisperServerStatus ? this._whisperServerStatus.model : null;
        meta.whisperChunkCounters  = {
            dispatched:          this._chunksDispatched          || 0,
            succeeded:           this._chunksSucceeded           || 0,
            failed503:           this._chunksFailed503           || 0,
            failed500:           this._chunksFailed500           || 0,
            failedNetwork:       this._chunksFailedNetwork       || 0,
            droppedWhileLoading: this._chunksDroppedWhileLoading || 0,
            droppedNotReady:     this._chunksDroppedNotReady     || 0,
        };
        meta.whisperResponses          = this._whisperResponses          || 0;
        meta.whisperResponsesWithWords = this._whisperResponsesWithWords  || 0;
        meta.whisperWordsTotal         = this._whisperWordsTotal          || 0;
        meta.whisperRealtimeDeltas     = this._whisperRealtimeDeltas      || 0;
        meta.whisperRealtimeCompletions = this._whisperRealtimeCompletions || 0;
        meta.whisperRealtimeEvents     = this._whisperRealtimeEvents      || 0;
        meta.whisperRealtimeFailures   = this._whisperRealtimeFailures    || 0;
        meta.whisperRealtimeCommitsSent = this._whisperRealtimeCommitsSent || 0;
        meta.whisperRealtimeLastEvent  = this._whisperRealtimeLastEvent   || '';
        meta.whisperRealtimeLastError  = this._whisperRealtimeLastError   || '';
        meta.finalWordSourceCounts     = this._countWordSources(this.wordSourceMap);

        // v2 meta additions
        meta.schemaVersion = 2;
        meta.gameVersion   = '2.0';
        meta.karaokeeV2    = !!window.KARAOKEE_V2;
        meta.endedAt       = new Date().toISOString();
        meta.endReason     = endReason || 'manual';
        meta.completed     = !!(audio && isFinite(audio.duration) && audio.currentTime >= audio.duration - 0.5);

        var intentEl = document.getElementById('benchmarkIntent');
        var fairnessEl = document.getElementById('benchmarkFairness');
        var notesEl = document.getElementById('benchmarkNotes');
        var benchmark = {
            intent: intentEl ? intentEl.value : '',
            fairness: fairnessEl ? fairnessEl.value : '',
            notes: notesEl ? notesEl.value : ''
        };

        var traces = [];
        if (this._phraseSession && window.KaraokeePhraseEngine) {
            traces = KaraokeePhraseEngine.getPhraseTrace(this._phraseSession);
        }

        // Final scores
        var v1Pct = this.weightedTotal > 0 ? Math.round((this.weightedMatched / this.weightedTotal) * 100) : 0;
        var live = (this._phraseSession && window.KaraokeePhraseEngine)
            ? KaraokeePhraseEngine.getLiveScore(this._phraseSession) : { lyrics: 0, composite: 0 };
        var honestLyricPct = Math.round((live.lyrics || 0) * 100);
        var composite = Math.round((live.composite || 0) * 100);
        var grade = window.KaraokeeArcade ? KaraokeeArcade.gradeFor(honestLyricPct) : null;
        var arcadeSummary = (this._arcadeState && window.KaraokeeArcade)
            ? KaraokeeArcade.getArcadeSummary(this._arcadeState) : null;
        var difficulty = this._phraseDifficulty || 'medium';

        // High score context (read BEFORE showEndModal writes the new best — see finalize ordering)
        var hiKey = 'hiscore_' + _songKey() + '_' + difficulty;
        var prevHi = parseInt(localStorage.getItem(hiKey) || '0', 10) || 0;
        var runPoints = arcadeSummary ? arcadeSummary.points : 0;

        var arcadeEvents = this._arcadeEvents || [];
        var counts = {
            asr:         this._telemetry.asr.length,
            matches:     this._telemetry.matches.length,
            promotions:  this._telemetry.promotions.length,
            transitions: this._telemetry.transitions.length,
            arcadeEvents: arcadeEvents.length
        };

        var summary = window.KaraokeeTelemetry ? KaraokeeTelemetry.summarizeRun({
            difficulty: difficulty,
            karaokeeV2: !!window.KARAOKEE_V2,
            scores: { v1Pct: v1Pct, honestLyricPct: honestLyricPct, composite: composite },
            arcadeSummary: arcadeSummary,
            grade: grade,
            phraseTraces: traces,
            arcadeEvents: arcadeEvents,
            transitions: this._telemetry.transitions,
            finalWordSourceCounts: meta.finalWordSourceCounts,
            benchmarkIntent: benchmark.intent,
            counts: counts
        }) : null;

        var payload = {
            meta: meta,
            summary: summary,
            arcade: {
                tuning: (window.KaraokeeArcade && KaraokeeArcade.ARCADE_TUNING)
                    ? (KaraokeeArcade.ARCADE_TUNING[difficulty] || null) : null,
                summary: arcadeSummary,
                events: arcadeEvents,
                highScore: { key: hiKey, previous: prevHi, isNewBest: runPoints > prevHi }
            },
            phraseEngine: {
                version: 2,
                mode: window.KARAOKEE_V2 ? 'headline' : 'shadow',
                difficulty: difficulty,
                benchmark: benchmark,
                plan: this._telemetry.phraseEngine ? this._telemetry.phraseEngine.plan : null
            },
            transitions: this._telemetry.transitions
        };

        // Heavy data only under debug (press D).
        if (window._kDebug) {
            payload.phraseEngine.traces = traces;
            payload.asr = this._telemetry.asr;
            payload.matches = this._telemetry.matches;
            payload.promotions = this._telemetry.promotions;
        }
        return payload;
    }

    _downloadTelemetry() {
        var payload = this._buildTelemetryPayload('manual');
        if (!payload) return;
        try {
            var json = JSON.stringify(payload, null, 2);
            var ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            var name = 'karaokee-telemetry-' + ts + '.json';
            var blob = new Blob([json], { type: 'application/json' });
            var url  = URL.createObjectURL(blob);
            var a    = document.createElement('a');
            a.href = url; a.download = name;
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            URL.revokeObjectURL(url);
            console.log('[Telemetry] Downloaded:', name, '| arcadeEvents', payload.arcade.events.length,
                '| transitions', payload.transitions.length);
        } catch (e) {
            console.warn('[Telemetry] Download failed — raw JSON below:', e);
            console.warn(JSON.stringify(payload, null, 2));
        }
    }

    _finalizeTelemetry(endReason) {
        if (this._telemetryFinalized || !this._telemetry) return;
        this._telemetryFinalized = true;
        try {
            var payload = this._buildTelemetryPayload(endReason);
            if (!payload) return;
            fetch('/telemetry', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }).then(function (r) { return r.json(); })
              .then(function (d) { console.log('[Telemetry] Saved:', d && d.path); })
              .catch(function (e) { console.warn('[Telemetry] Save failed:', e); });
        } catch (e) { console.warn('[Telemetry] finalize error:', e); }
    }
```

- [ ] **Step 2: Syntax check**

Run: `node --check static/player.js`
Expected: no output (exit 0).

- [ ] **Step 3: Commit**

```bash
git add static/player.js
git commit -m "feat(telemetry): shared payload builder (scores+arcade+summary), v2 schema, lean/debug split"
```

### Task C3: Finalize on run end (showEndModal + stop) and drop the debug auto-download

**Files:**
- Modify: `static/player.js` (`showEndModal` ~line 2407; `stop()` ~line 595; the `ended` handler ~line 2758)

- [ ] **Step 1: Reorder `showEndModal` to finalize before the hi-score write.** At the very top of `showEndModal`, after the existing `this._hideArcadeHud();` line, insert the force-settle + finalize (so the saved payload sees fully-settled phrases and the pre-write high score):

```javascript
        // Force-settle trailing phrases, then persist telemetry BEFORE the hi-score write
        // below (so arcade.highScore.previous reflects the prior best).
        if (this._phraseSession && window.KaraokeePhraseEngine) {
            try {
                var _endNow = (audio && isFinite(audio.duration)) ? audio.duration + 5 : 1e9;
                KaraokeePhraseEngine.settlePhrases(this._phraseSession, _endNow);
            } catch (e) {}
            this._commitNewlySettled(false);
        }
        this._finalizeTelemetry('song_ended');
```

Then **remove** the now-duplicated force-settle block inside the existing `if (useArcade) {` branch (the `try { var endNow = ... settlePhrases ... } catch (e) {}` + `this._commitNewlySettled(false);` lines added in the arcade end-screen work) — settling now happens once, above, for both V2 and legacy ends.

- [ ] **Step 2: Finalize on manual stop.** In `stop()`, after the existing `this._hideArcadeHud();` line near the end, add:

```javascript
        this._finalizeTelemetry('stopped');
```

- [ ] **Step 3: Drop the debug auto-download in the `ended` handler.** Replace the line `if (window._kDebug) gameMode._downloadTelemetry();` (in the `audio.addEventListener('ended', ...)` block) with a comment — auto-save now happens via `showEndModal` → `_finalizeTelemetry`:

```javascript
        // Telemetry auto-saves via showEndModal -> _finalizeTelemetry (POST /telemetry).
```

- [ ] **Step 4: Syntax check**

Run: `node --check static/player.js`
Expected: no output (exit 0).

- [ ] **Step 5: Run all JS suites + pytest (no regressions)**

Run:
```bash
node tests/test_telemetry_helpers.cjs && node tests/test_scoring_arcade.cjs && node tests/test_phrase_engine.cjs && node tests/test_scoring.cjs && node tests/test_sync_helpers.cjs && node tests/test_match_helpers.cjs
python -m pytest tests/test_app.py -q
```
Expected: all pass.

- [ ] **Step 6: Verify in the browser** (`python app.py`, load a song, press V): play a run to the end → console logs `[Telemetry] Saved: output_telemetry/<date>/karaokee-telemetry-...json`; open that file and confirm `summary.scores`, `summary.arcade`, `summary.honesty`, and `arcade.events[]` are populated and the raw `asr`/`matches` are absent (debug off). Press D, play again → confirm the saved file now includes `asr`/`matches`/`phraseEngine.traces`. Hum through a run labeled `humming_cheese` → confirm `summary.honesty.suspectedCheeseInflation` is `false` only if points stayed 0.

- [ ] **Step 7: Commit**

```bash
git add static/player.js
git commit -m "feat(telemetry): auto-save every run end; finalize-once on song-end and stop"
```

### Task C4: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (the `### Telemetry` section)

- [ ] **Step 1: Replace the Telemetry note** with the current reality:

```markdown
### Telemetry
Each completed run auto-saves a JSON to `output_telemetry/<date>/` via `POST /telemetry` (Flask writes it; client builds it in `player.js` `_buildTelemetryPayload`). Schema v2 (`meta.schemaVersion: 2`) adds a `summary` block (final scores, arcade outcome, recognizer attribution, sync drift, and a cheese/honesty correlation) and an `arcade` block (per-phrase commit events + high score). Lean by default; the heavy raw arrays (`asr`/`matches`/`promotions`/`phraseEngine.traces`) are included only when debug is on (press `D`). The `summary` digest is derived by the pure `static/telemetry-helpers.js` (`summarizeRun`, golden-tested in `tests/test_telemetry_helpers.cjs`). Used for offline analysis of scoring honesty/economy and timing drift — not part of the production serving path.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md telemetry note for v2 (auto-save + summary/arcade schema)"
```

---

## Self-Review

- **Spec coverage:** §2 auto-save → B1 (`/telemetry`) + C3 (`_finalizeTelemetry` on end/stop); lean/debug split → C2 (`if (window._kDebug)`); additive `schemaVersion:2` → C2 meta block; pure `summarizeRun` → A; honesty correlation → A (`CHEESE_INTENTS`, `suspectedCheeseInflation`) + tests; §3.1 meta fields → C2; §3.2 summary → A; §3.3 arcade block + events + highScore → C1 (events) + C2 (block); §3.4 debug-gated heavy data incl. traces → C2; §4 files → all phases; §5 testing → A1/B2 + C3 step 5/6; CLAUDE.md → C4. All mapped.
- **Placeholder scan:** every step has complete code/commands. C3 step 1 references "the force-settle block added in the arcade end-screen work" — that block is concrete in the current `showEndModal` (the `var endNow = ... settlePhrases` + `_commitNewlySettled(false)` lines); the step says to delete it after adding the top-of-method version.
- **Type/name consistency:** `_arcadeEvents`, `_telemetryFinalized`, `_buildTelemetryPayload`, `_finalizeTelemetry`, `_commitNewlySettled`, `_songKey`, `KaraokeeTelemetry.summarizeRun`, `KaraokeeArcade.{getArcadeSummary,gradeFor,ARCADE_TUNING}`, `KaraokeePhraseEngine.{getLiveScore,getPhraseTrace,settlePhrases}` consistent across tasks. Endpoint returns `{ok, path}`; `summarizeRun` output keys (`scores/arcade/phraseOutcomes/recognizer/sync/honesty/counts`) match the tests in A1 and the payload reader in C2.

## Open Items
- `CHEESE_INTENTS = {humming_cheese, silent_section_test}`; widen if new benchmark intent labels appear.
- 8 MB cap is a guess (spec §7); revisit if a long full-debug run exceeds it.
- `fetch` (not `sendBeacon`) is used; the common end/stop flows keep the page open so the POST completes. If immediate tab-close drops saves in practice, switch `_finalizeTelemetry` to `navigator.sendBeacon`.
