# UX Redesign — Beat-Pulse Helper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure, DOM-free timing helper `static/beat-pulse-helpers.js` (`window.KaraokeeBeatPulse`) plus its `tests/test_beat_pulse_helpers.cjs` test, implementing the locked beat-pulse contract (`DEFAULT_PERIOD_MS`, `pulsePeriodMs`, `beatPhase`) used later by the Phase 2 on-fire pulse. This plan ships **only** the helper + its test — no `player.js` wiring, no CSS, no DOM.

**Architecture:** A single UMD helper module exposing three pure functions. `pulsePeriodMs(tempoClass)` maps a `sync-helpers.js` tempo class (`'slow'|'normal'|'fast'`) to a beat period in milliseconds, falling back to `DEFAULT_PERIOD_MS` for any unknown/empty class. `beatPhase(nowMs, periodMs, anchorMs)` returns the `0..1` fraction through the current beat, where `anchorMs` is a known beat instant (a sung word onset). It is computed as `((nowMs - anchorMs) mod periodMs) / periodMs` normalized into `[0, 1)`, with guards for non-positive periods, a missing anchor (treated as `0`), and `nowMs` many periods after the anchor. Pure timing only — the visual pulse is CSS, and `player.js` (a later phase) gates application behind `matchMedia('(prefers-reduced-motion: reduce)')`; **none of that lives here.**

**Tech Stack:** Plain JS (no build step), UMD helper-isolation pattern (`new Function`-loadable for `.cjs` tests **and** a browser `<script>` global `window.KaraokeeBeatPulse`), Node.js for the test (`node tests/test_beat_pulse_helpers.cjs`).

**Depends on:** None — parallel-safe. This helper is self-contained: it consumes the tempo-class *vocabulary* (`'slow'|'normal'|'fast'`) that `static/sync-helpers.js` already produces, but it does **not** import or require `sync-helpers.js` (the strings are passed in by the future caller). It does not depend on the Phase 0 foundation plan, the other two redesign helpers (`score-feedback-helpers.js`, `word-fill-helpers.js`), or any token/CSS work. It can be built and merged independently.

**Spec:** `docs/superpowers/specs/2026-06-28-ux-redesign-design.md` §3.4 (the "C, beat-synced" on-fire: "sustained pulse whose rate comes from the song's tempo class (`sync-helpers.js`) and whose phase is anchored to **word-onsets**") and §3.4's helper list ("`beat-pulse-helpers.js` — tempo-class → pulse period, word-onset phase anchor, reduced-motion gating"). The reduced-motion gating named in the spec is a **CSS/`player.js`** concern in Phase 2 — this helper stays pure timing.

**Contract (locked — implement exactly):**
- `DEFAULT_PERIOD_MS = 480`
- `pulsePeriodMs(tempoClass)`: `'slow'` → `700`, `'normal'` → `480`, `'fast'` → `350`, anything else → `DEFAULT_PERIOD_MS`.
- `beatPhase(nowMs, periodMs, anchorMs)`: `0..1` fraction through the current beat where `anchorMs` is a known beat instant. `((nowMs - anchorMs) mod periodMs) / periodMs` normalized to `[0, 1)`; `periodMs <= 0` → `0`; missing `anchorMs` → treat as `0`; correctly handles `nowMs` many periods after the anchor.

---

## Task 1: `beat-pulse-helpers.js` + test — the beat-pulse contract (TDD)

**Files:**
- Create: `static/beat-pulse-helpers.js`
- Create: `tests/test_beat_pulse_helpers.cjs`

This is the whole plan in one TDD task: a failing test that pins every clause of the contract, then the minimal implementation that satisfies it.

- [ ] **Step 1: Write the failing test**

Create `tests/test_beat_pulse_helpers.cjs` verbatim (mirrors the loader pattern in `tests/test_browser_support.cjs`: read the file, eval it via `new Function('module','exports', code)`, then assert with `node:assert`, ending with a single `All … tests passed.` line):

```js
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

// Load beat-pulse-helpers.js as a plain script (simulates browser <script> loading).
// Parent package.json is "type": "module", so require() would treat .js as ESM —
// load it with new Function instead so it runs as a classic script.
var filePath = path.join(__dirname, '..', 'static', 'beat-pulse-helpers.js');
var code = fs.readFileSync(filePath, 'utf8');
var fakeModule = { exports: {} };
new Function('module', 'exports', code)(fakeModule, fakeModule.exports);
var BP = fakeModule.exports;

// ── DEFAULT_PERIOD_MS ───────────────────────────────────────────────
assert.strictEqual(BP.DEFAULT_PERIOD_MS, 480, 'DEFAULT_PERIOD_MS is 480');

// ── pulsePeriodMs: the three known tempo classes ───────────────────
assert.strictEqual(BP.pulsePeriodMs('slow'), 700, 'slow -> 700');
assert.strictEqual(BP.pulsePeriodMs('normal'), 480, 'normal -> 480');
assert.strictEqual(BP.pulsePeriodMs('fast'), 350, 'fast -> 350');

// ── pulsePeriodMs: unknown / empty / wrong-type -> DEFAULT_PERIOD_MS ─
assert.strictEqual(BP.pulsePeriodMs('medium'), 480, 'unknown class -> default');
assert.strictEqual(BP.pulsePeriodMs(''), 480, 'empty string -> default');
assert.strictEqual(BP.pulsePeriodMs(undefined), 480, 'undefined -> default');
assert.strictEqual(BP.pulsePeriodMs(null), 480, 'null -> default');
assert.strictEqual(BP.pulsePeriodMs('SLOW'), 480, 'case-sensitive: SLOW is unknown -> default');
assert.strictEqual(BP.pulsePeriodMs(123), 480, 'number -> default');
// And the default matches the named constant (no drift between the two).
assert.strictEqual(BP.pulsePeriodMs('anything'), BP.DEFAULT_PERIOD_MS, 'default branch === DEFAULT_PERIOD_MS');

// ── beatPhase: degenerate periods clamp to 0 ───────────────────────
assert.strictEqual(BP.beatPhase(1000, 0, 0), 0, 'periodMs 0 -> 0');
assert.strictEqual(BP.beatPhase(1000, -480, 0), 0, 'periodMs negative -> 0');

// ── beatPhase: missing anchor is treated as 0 ──────────────────────
// nowMs=240, period=480, anchor missing -> phase = (240 mod 480)/480 = 0.5
assert.strictEqual(BP.beatPhase(240, 480), 0.5, 'missing anchorMs (undefined) -> anchor 0');
assert.strictEqual(BP.beatPhase(240, 480, null), 0.5, 'null anchorMs -> anchor 0');
assert.strictEqual(BP.beatPhase(240, 480, undefined), 0.5, 'explicit undefined anchorMs -> anchor 0');

// ── beatPhase: exactly on a beat boundary -> 0 (start of beat, [0,1)) ──
assert.strictEqual(BP.beatPhase(0, 480, 0), 0, 'now == anchor -> 0');
assert.strictEqual(BP.beatPhase(480, 480, 0), 0, 'one full period later -> 0 (boundary)');
assert.strictEqual(BP.beatPhase(960, 480, 0), 0, 'two full periods later -> 0 (boundary)');
assert.strictEqual(BP.beatPhase(900, 480, 420), 0, 'now-anchor == one period -> 0 (boundary)');

// ── beatPhase: mid-beat fractions ──────────────────────────────────
assert.strictEqual(BP.beatPhase(120, 480, 0), 0.25, 'quarter through the beat');
assert.strictEqual(BP.beatPhase(240, 480, 0), 0.5, 'half through the beat');
assert.strictEqual(BP.beatPhase(360, 480, 0), 0.75, 'three-quarters through the beat');

// ── beatPhase: phase wraps across several periods ──────────────────
// 1080 ms after anchor at period 480 -> 1080 mod 480 = 120 -> 120/480 = 0.25
assert.strictEqual(BP.beatPhase(1080, 480, 0), 0.25, 'wraps after >2 periods');
// non-zero anchor: now=1500, anchor=300 -> delta 1200; 1200 mod 480 = 240 -> 0.5
assert.strictEqual(BP.beatPhase(1500, 480, 300), 0.5, 'non-zero anchor, many periods later');

// ── beatPhase: nowMs before the anchor (negative delta) stays in [0,1) ─
// now=300, anchor=480, period=480 -> delta -180; -180 mod 480 must normalize to 300 -> 0.625
assert.strictEqual(BP.beatPhase(300, 480, 480), 0.625, 'now before anchor normalizes into [0,1)');
// now=-120, anchor=0, period=480 -> -120 -> 360 -> 0.75
assert.strictEqual(BP.beatPhase(-120, 480, 0), 0.75, 'negative now normalizes into [0,1)');

// ── beatPhase: result is always within [0, 1) ──────────────────────
for (var t = 0; t < 2000; t += 37) {
    var ph = BP.beatPhase(t, 480, 130);
    assert.ok(ph >= 0 && ph < 1, 'phase in [0,1) at now=' + t + ' got ' + ph);
}

console.log('All beat-pulse-helpers tests passed.');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/test_beat_pulse_helpers.cjs`

Expected: FAIL — `ENOENT: no such file or directory, open '…static/beat-pulse-helpers.js'` (the helper does not exist yet), thrown from the `fs.readFileSync` line.

- [ ] **Step 3: Write the minimal implementation**

Create `static/beat-pulse-helpers.js`. Follow the exact UMD wrapper used across the other redesign helpers — a browser `<script>` global `window.KaraokeeBeatPulse` AND a `module.exports` for the `.cjs` test:

```js
/**
 * Pure beat-pulse timing helpers for the on-fire "C, beat-synced" treatment.
 *
 * No DOM, no AudioContext, no clock of its own — every input (now, period,
 * anchor) is passed in, so the whole module is testable in Node.js. The visual
 * pulse itself is CSS; player.js (a later phase) drives these numbers into a
 * CSS variable and gates the animation behind
 * matchMedia('(prefers-reduced-motion: reduce)'). None of that lives here.
 *
 * Tempo classes are the same vocabulary sync-helpers.js produces
 * ('slow' | 'normal' | 'fast'); the caller passes the class string — this
 * module does not import sync-helpers.js.
 */
(function (root) {
    // Beat period (ms) for an unknown/empty tempo class. Also the 'normal' value.
    var DEFAULT_PERIOD_MS = 480;

    /**
     * Map a tempo class to a beat period in milliseconds.
     * @param {'slow'|'normal'|'fast'|*} tempoClass
     * @returns {number} period in ms (700 slow, 480 normal, 350 fast, 480 default)
     */
    function pulsePeriodMs(tempoClass) {
        switch (tempoClass) {
            case 'slow':   return 700;
            case 'normal': return 480;
            case 'fast':   return 350;
            default:       return DEFAULT_PERIOD_MS;
        }
    }

    /**
     * Fraction (0..1) through the current beat at time `nowMs`, given a beat
     * `periodMs` and a known beat instant `anchorMs` (e.g. a sung word onset).
     *
     * phase = ((nowMs - anchorMs) mod periodMs) / periodMs, normalized to [0, 1).
     *
     * - periodMs <= 0 (or non-finite) -> 0 (degenerate; no pulse).
     * - anchorMs missing/null/undefined (or non-finite) -> treated as 0.
     * - nowMs many periods after (or before) the anchor wraps correctly into
     *   [0, 1): JS `%` keeps the sign of the dividend, so a negative remainder is
     *   shifted up by one period before dividing.
     * - exactly on a beat boundary -> 0 (start of the next beat).
     *
     * @param {number} nowMs
     * @param {number} periodMs
     * @param {number} [anchorMs=0]
     * @returns {number} phase in [0, 1)
     */
    function beatPhase(nowMs, periodMs, anchorMs) {
        if (!(periodMs > 0)) return 0; // 0, negative, NaN, undefined -> no pulse
        var anchor = (typeof anchorMs === 'number' && isFinite(anchorMs)) ? anchorMs : 0;
        var rem = (nowMs - anchor) % periodMs;
        if (rem < 0) rem += periodMs; // JS % keeps dividend sign; lift into [0, periodMs)
        return rem / periodMs;
    }

    var api = {
        DEFAULT_PERIOD_MS: DEFAULT_PERIOD_MS,
        pulsePeriodMs: pulsePeriodMs,
        beatPhase: beatPhase
    };
    if (root) root.KaraokeeBeatPulse = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
```

> This file contains no backtick template literals, so it is safe to write with shell tools — but per the project convention, write it with the Write/Edit tool anyway. (Note for future helpers that DO use backticks: write them with the Write/Edit tool, never a Bash/PowerShell heredoc — Windows strips backtick contents in heredocs.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `node tests/test_beat_pulse_helpers.cjs`

Expected: PASS — prints `All beat-pulse-helpers tests passed.` and exits 0.

- [ ] **Step 5: Sanity-check the UMD global path (browser side) without a browser**

The `.cjs` test exercises the `module.exports` branch. Confirm the `window.KaraokeeBeatPulse` branch also wires up, so the future `<script>` include works:

Run:
```bash
node -e "global.window = {}; var fs=require('fs'); new Function('module','exports',fs.readFileSync('static/beat-pulse-helpers.js','utf8'))({exports:{}},{}); console.log('global:', typeof window.KaraokeeBeatPulse, window.KaraokeeBeatPulse && window.KaraokeeBeatPulse.DEFAULT_PERIOD_MS);"
```

Expected: `global: object 480` (the helper attached `KaraokeeBeatPulse` to the fake `window` and `DEFAULT_PERIOD_MS` reads back as `480`).

- [ ] **Step 6: Commit**

```bash
git add static/beat-pulse-helpers.js tests/test_beat_pulse_helpers.cjs
git commit -m "feat(beat-pulse): add pure beat-pulse timing helpers + tests"
```

---

## Task 2: Regression guard — full JS + Python suites stay green

**Files:** none (verification only). This task adds no source; it only proves the new pure helper did not disturb anything (it shares no globals and is not yet imported anywhere, so this should be clean).

- [ ] **Step 1: Run the new test plus a representative existing helper test**

```bash
node tests/test_beat_pulse_helpers.cjs
node tests/test_browser_support.cjs
node tests/test_sync_helpers.cjs
```

Expected: each prints its `All … tests passed.` line; no failures.

- [ ] **Step 2: Run every JS `.cjs` test (no shared-state regressions)**

Run all the helper tests (the full list is in CLAUDE.md "Run JS tests"):

```bash
for f in tests/*.cjs; do echo "== $f =="; node "$f" || break; done
```

Expected: every file prints its "All … tests passed." line; the loop completes without an early `break`.

- [ ] **Step 3: Run the Python suite (confirm nothing else moved)**

```bash
python -m pytest tests/test_app.py tests/test_downloader.py tests/test_lyrics.py -q
```

Expected: PASS. (This helper is frontend-only and cannot affect Python, but confirm the tree is clean.)

- [ ] **Step 4: Confirm the working tree is clean and the helper is self-contained**

```bash
git status
grep -n "require(" static/beat-pulse-helpers.js
grep -rn "KaraokeeBeatPulse\|beat-pulse-helpers" static/player.js static/player.html
```

Expected:
- `git status` → clean (the Task 1 commit is the only change).
- The first `grep` → no output (the helper `require()`s nothing; it is dependency-free).
- The second `grep` → no output (this plan deliberately does **not** wire the helper into `player.js`/`player.html`; that lands in the Phase 2 on-fire plan).

---

## Done — what this delivers and what's next

This plan delivers the standalone, fully-tested `beat-pulse-helpers.js` (`window.KaraokeeBeatPulse`) implementing the locked contract exactly:

- `DEFAULT_PERIOD_MS = 480`
- `pulsePeriodMs('slow'|'normal'|'fast')` → `700 | 480 | 350`, everything else → `DEFAULT_PERIOD_MS`
- `beatPhase(nowMs, periodMs, anchorMs)` → `0..1` beat fraction, with the degenerate-period, missing-anchor, boundary, multi-period-wrap, and negative-delta edges all covered.

It is pure timing only — **no** DOM, **no** CSS, **no** `player.js` wiring, **no** reduced-motion gating (those are render-layer concerns in the Phase 2 on-fire plan, which will `<script src="/static/beat-pulse-helpers.js">` it, feed `pulsePeriodMs(tempoClass)` from `sync-helpers.js`, anchor `beatPhase` to a tracked word-onset, and gate the CSS pulse behind `matchMedia('(prefers-reduced-motion: reduce)')`).

**Beat-phase boundary note (for the Phase 2 consumer):** `beatPhase` is a saw wave in `[0, 1)` — at an exact downbeat it returns `0`, not `1`. If the on-fire visual wants a symmetric "swell-and-settle" pulse, derive it in the consumer (e.g. `Math.sin(phase * Math.PI)` or `1 - Math.abs(2*phase - 1)`), not by expecting `beatPhase` to peak at `1`.
