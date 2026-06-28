# UX Redesign Helper — `score-feedback-helpers.js` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure, DOM-free helper `static/score-feedback-helpers.js` (exposing `window.KaraokeeScoreFeedback`) plus its Node test `tests/test_score_feedback_helpers.cjs`, implementing the six scoring-feedback functions exactly as specced — `formatPointsGain`, `countUpValue`, `countUpDurationMs`, `lineVerdict`, `milestoneForStreak`, `tierUpLabel`. This is the reward-math layer that the Phase 2 re-skin consumes to render the `+points` popup, the score count-up animation, tier-up beats, streak-milestone callouts, and per-line PERFECT/NICE/partial verdicts. **No `player.js` wiring happens here** — this plan delivers a tested, parallel-safe helper only.

**Architecture:** One UMD helper module following the project's helper-isolation pattern (a `static/*-helpers.js` file that is simultaneously a browser `<script>` global *and* `new Function`-loadable for a `.cjs` test). Every function is **pure** — deterministic, no DOM, no clock, no I/O — so the entire surface is unit-testable in Node with `node:assert`. The consuming render layer (`player.js`, built in the Phase 2 plan) drives an animation frame loop and calls `countUpValue(from, to, t)` with its own `t = clamp(elapsed / countUpDurationMs(delta), 0, 1)`; the helper itself stays clock-free. The functions correspond directly to data `scoring-arcade.js` already computes (`points`, `pointsAwarded`, `multiplier`, `streak`) — see spec §3.4 — which this redesign *surfaces* without touching the frozen scoring logic.

**Tech Stack:** Plain JS, no build step (UMD wrapper, `new Function`-loadable for `.cjs` tests). Node for the test runner (`node tests/test_score_feedback_helpers.cjs`). Flask static serving in dev (`python app.py` → http://localhost:5000), but this helper has no DOM/preview surface to verify in Phase 0 — it's verified entirely by its unit test plus the existing-suite regression guard.

**Depends on:** None — parallel-safe. This helper is self-contained pure math with no dependency on the Phase 0 token/component layer, on the other two new helpers (`beat-pulse-helpers.js`, `word-fill-helpers.js`), or on any scoring module. It can be built and merged independently and in parallel with those plans.

**Spec:** `docs/superpowers/specs/2026-06-28-ux-redesign-design.md` (this implements the `score-feedback-helpers.js` bullet of §3.4 + the helper-isolation requirement of §4). The canonical function contract is reproduced verbatim in Task 2 below.

**Contract (authoritative — implement EXACTLY):**

- `formatPointsGain(pointsAwarded)`: integer `> 0` → `'+'` + thousands-grouped string (`250` → `'+250'`, `1250` → `'+1,250'`); `<= 0` or non-finite → `''`.
- `countUpValue(from, to, t)`: ease-out interpolated **integer** for `t` in `[0,1]`; `countUpValue(from, to, 0) === from`; `countUpValue(from, to, 1) === to`.
- `countUpDurationMs(delta)`: `clamp(round(300 + abs(delta) * 0.4), 300, 1200)`.
- `lineVerdict(score, maxScore)`: `r = (maxScore > 0 ? score / maxScore : 0)`; `r >= 1` → `'perfect'`; `r >= 0.75` → `'nice'`; `r > 0` → `'partial'`; else → `'miss'`.
- `milestoneForStreak(streak)`: exactly `10|25|50` → `String(streak) + ' STREAK'`; else `null`.
- `tierUpLabel(prevMultiplier, multiplier)`: `multiplier > prevMultiplier` → `String(multiplier) + 'x'`; else `null`.

**Pattern notes (read before writing code):**
- Helper-isolation + UMD wrapper: mirror `static/theme-helpers.js` / `static/mic-check-helpers.js`. The file is BOTH a browser global (`window.KaraokeeScoreFeedback`) AND `module.exports` for the test.
- Test-loader: mirror `tests/test_browser_support.cjs` — read the file, `new Function('module','exports',code)(m, m.exports)`, then assert against `m.exports`, ending with a single `'All score-feedback-helpers tests passed.'` `console.log`. (The repo's root `package.json` is `"type": "module"`, so a plain `require()` of a `static/*.js` would misparse it as ESM — the `new Function` loader is why this pattern exists; do not switch to `require('../static/score-feedback-helpers.js')`.)
- `player.js` is the ONLY DOM-bound file; this helper must never reach for `document`/`window` beyond the UMD `root` assignment.

---

## Task 1: Write the failing test for `score-feedback-helpers.js`

**Files:**
- Create: `tests/test_score_feedback_helpers.cjs`

This is the full test up front (TDD); it will FAIL on the first run because the helper file does not exist yet. It pins every function's contract including the requested edge cases: 0/negative/NaN points, count-up exact endpoints + monotonic ease-out, verdict boundary values (exactly `0.75`, exactly `1.0`, `maxScore <= 0`), streak non-milestones (`9/10/11/24/25/50/51`), and multiplier equal-and-decrease.

- [ ] **Step 1: Write the failing test**

Create `tests/test_score_feedback_helpers.cjs` with this exact content:

```js
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

// Load score-feedback-helpers.js as a plain script (simulates browser <script>
// loading). Parent package.json is "type": "module", so require() would treat
// a static/*.js file as ESM — mirror the new Function loader from
// tests/test_browser_support.cjs instead.
var filePath = path.join(__dirname, '..', 'static', 'score-feedback-helpers.js');
var code = fs.readFileSync(filePath, 'utf8');
var fakeModule = { exports: {} };
new Function('module', 'exports', code)(fakeModule, fakeModule.exports);
var SF = fakeModule.exports;

// ── formatPointsGain ────────────────────────────────────────────────
// positive ints -> '+' + thousands-grouped
assert.strictEqual(SF.formatPointsGain(250), '+250', '250 -> +250');
assert.strictEqual(SF.formatPointsGain(1250), '+1,250', '1250 -> +1,250');
assert.strictEqual(SF.formatPointsGain(1), '+1', '1 -> +1');
assert.strictEqual(SF.formatPointsGain(999), '+999', '999 -> +999 (no group under 1000)');
assert.strictEqual(SF.formatPointsGain(1000), '+1,000', '1000 -> +1,000 (group boundary)');
assert.strictEqual(SF.formatPointsGain(1234567), '+1,234,567', 'multi-group grouping');
// zero / negative / non-finite -> '' (nothing to celebrate)
assert.strictEqual(SF.formatPointsGain(0), '', '0 -> empty');
assert.strictEqual(SF.formatPointsGain(-5), '', 'negative -> empty');
assert.strictEqual(SF.formatPointsGain(NaN), '', 'NaN -> empty');
assert.strictEqual(SF.formatPointsGain(Infinity), '', 'Infinity -> empty');
assert.strictEqual(SF.formatPointsGain(-Infinity), '', '-Infinity -> empty');
assert.strictEqual(SF.formatPointsGain(undefined), '', 'undefined -> empty');
assert.strictEqual(SF.formatPointsGain(null), '', 'null -> empty');
// fractional positive -> floored, then grouped (defensive; awarded points are ints)
assert.strictEqual(SF.formatPointsGain(250.9), '+250', 'fractional floored to +250');

// ── countUpValue ────────────────────────────────────────────────────
// exact endpoints (contract)
assert.strictEqual(SF.countUpValue(0, 1000, 0), 0, 't=0 -> from');
assert.strictEqual(SF.countUpValue(0, 1000, 1), 1000, 't=1 -> to');
assert.strictEqual(SF.countUpValue(500, 500, 0), 500, 'equal endpoints, t=0');
assert.strictEqual(SF.countUpValue(500, 500, 1), 500, 'equal endpoints, t=1');
assert.strictEqual(SF.countUpValue(200, 1700, 0), 200, 'nonzero from, t=0');
assert.strictEqual(SF.countUpValue(200, 1700, 1), 1700, 'nonzero from, t=1');
// result is an integer at intermediate t
var midVal = SF.countUpValue(0, 1000, 0.5);
assert.strictEqual(midVal, Math.round(midVal), 'mid value is an integer');
// ease-out: at the midpoint, an out-curve is already PAST halfway
assert.ok(midVal > 500, 'ease-out is past halfway at t=0.5 (got ' + midVal + ')');
assert.ok(midVal < 1000, 'mid value below the endpoint');
// monotonic non-decreasing across the sweep
var prev = SF.countUpValue(0, 1000, 0);
for (var i = 1; i <= 10; i++) {
    var cur = SF.countUpValue(0, 1000, i / 10);
    assert.ok(cur >= prev, 'monotonic non-decreasing at t=' + (i / 10) + ' (' + cur + ' >= ' + prev + ')');
    prev = cur;
}
// clamps t outside [0,1] back to the endpoints
assert.strictEqual(SF.countUpValue(0, 1000, -0.5), 0, 't<0 clamps to from');
assert.strictEqual(SF.countUpValue(0, 1000, 1.5), 1000, 't>1 clamps to to');

// ── countUpDurationMs ───────────────────────────────────────────────
assert.strictEqual(SF.countUpDurationMs(0), 300, 'delta 0 -> floor 300');
assert.strictEqual(SF.countUpDurationMs(250), 400, '300 + 250*0.4 = 400');
assert.strictEqual(SF.countUpDurationMs(-250), 400, 'abs() -> negative delta same as positive');
assert.strictEqual(SF.countUpDurationMs(1000), 700, '300 + 1000*0.4 = 700');
assert.strictEqual(SF.countUpDurationMs(2250), 1200, '300 + 2250*0.4 = 1200 (exact cap)');
assert.strictEqual(SF.countUpDurationMs(100000), 1200, 'huge delta clamps to 1200');
assert.strictEqual(SF.countUpDurationMs(1), 300, 'round(300.4)=300');
assert.strictEqual(SF.countUpDurationMs(2), 301, 'round(300.8)=301');

// ── lineVerdict ─────────────────────────────────────────────────────
// boundaries
assert.strictEqual(SF.lineVerdict(4, 4), 'perfect', 'full score -> perfect');
assert.strictEqual(SF.lineVerdict(5, 4), 'perfect', 'over-full (r>1) -> perfect');
assert.strictEqual(SF.lineVerdict(3, 4), 'nice', 'exactly 0.75 -> nice');
assert.strictEqual(SF.lineVerdict(0.75, 1), 'nice', 'r=0.75 boundary -> nice');
assert.strictEqual(SF.lineVerdict(74, 100), 'partial', 'just under 0.75 -> partial');
assert.strictEqual(SF.lineVerdict(1, 100), 'partial', 'r just above 0 -> partial');
assert.strictEqual(SF.lineVerdict(0, 4), 'miss', 'zero score -> miss');
// maxScore <= 0 -> r forced to 0 -> miss (no divide-by-zero)
assert.strictEqual(SF.lineVerdict(0, 0), 'miss', 'maxScore 0 -> miss');
assert.strictEqual(SF.lineVerdict(3, 0), 'miss', 'maxScore 0 with score -> miss (r=0)');
assert.strictEqual(SF.lineVerdict(3, -4), 'miss', 'negative maxScore -> miss (r=0)');

// ── milestoneForStreak ──────────────────────────────────────────────
assert.strictEqual(SF.milestoneForStreak(9), null, '9 -> no milestone');
assert.strictEqual(SF.milestoneForStreak(10), '10 STREAK', '10 -> milestone');
assert.strictEqual(SF.milestoneForStreak(11), null, '11 -> no milestone');
assert.strictEqual(SF.milestoneForStreak(24), null, '24 -> no milestone');
assert.strictEqual(SF.milestoneForStreak(25), '25 STREAK', '25 -> milestone');
assert.strictEqual(SF.milestoneForStreak(50), '50 STREAK', '50 -> milestone');
assert.strictEqual(SF.milestoneForStreak(51), null, '51 -> no milestone');
assert.strictEqual(SF.milestoneForStreak(0), null, '0 -> no milestone');
assert.strictEqual(SF.milestoneForStreak(100), null, '100 (not in set) -> no milestone');

// ── tierUpLabel ─────────────────────────────────────────────────────
assert.strictEqual(SF.tierUpLabel(1, 2), '2x', 'increase -> "2x"');
assert.strictEqual(SF.tierUpLabel(2, 4), '4x', 'increase to 4x');
assert.strictEqual(SF.tierUpLabel(2, 2), null, 'equal -> null (no tier-up)');
assert.strictEqual(SF.tierUpLabel(4, 2), null, 'decrease -> null');
assert.strictEqual(SF.tierUpLabel(1, 1), null, 'equal at 1 -> null');
assert.strictEqual(SF.tierUpLabel(0, 1), '1x', 'rise from 0 -> "1x"');

console.log('All score-feedback-helpers tests passed.');
```

- [ ] **Step 2: Run the test to verify it FAILS**

Run: `node tests/test_score_feedback_helpers.cjs`
Expected: **FAIL** — `ENOENT: no such file or directory, open '...static/score-feedback-helpers.js'` (the helper does not exist yet). This confirms the test actually exercises the file under test.

- [ ] **Step 3: Commit the failing test**

```bash
git add tests/test_score_feedback_helpers.cjs
git commit -m "test(score-feedback): add failing spec for KaraokeeScoreFeedback helpers"
```

---

## Task 2: Implement `score-feedback-helpers.js` to pass the test

**Files:**
- Create: `static/score-feedback-helpers.js`

This implements all six functions exactly to contract. The UMD wrapper mirrors `static/theme-helpers.js` so the file is both `window.KaraokeeScoreFeedback` in the browser and `module.exports` for the test.

> **Windows note:** this file contains no backtick template literals, so a heredoc would be safe — but per project convention, write it with the Write/Edit tool anyway. (CLAUDE.md: backtick contents get stripped in Windows shell heredocs; the safe habit is to always use the editor for JS files.)

- [ ] **Step 1: Write the helper implementation**

Create `static/score-feedback-helpers.js` with this exact content:

```js
/**
 * Pure scoring-feedback math for the Phase 2 reward layer. DOM-free, clock-free,
 * deterministic — the render layer (player.js) drives animation frames and feeds
 * t / deltas in; this module only computes. Browser pages also get
 * window.KaraokeeScoreFeedback. Mirrors data scoring-arcade.js already produces
 * (points / pointsAwarded / multiplier / streak); does NOT touch scoring logic.
 *
 * Contract (see docs/superpowers/specs/2026-06-28-ux-redesign-design.md §3.4):
 *   formatPointsGain(pointsAwarded)        -> '+1,250' | ''
 *   countUpValue(from, to, t)              -> ease-out integer; t in [0,1]
 *   countUpDurationMs(delta)               -> clamp(round(300 + |delta|*0.4), 300, 1200)
 *   lineVerdict(score, maxScore)           -> 'perfect' | 'nice' | 'partial' | 'miss'
 *   milestoneForStreak(streak)             -> '10 STREAK' | '25 STREAK' | '50 STREAK' | null
 *   tierUpLabel(prevMultiplier, multiplier)-> '2x' | null
 */
(function (root) {
    var COUNT_UP_MIN_MS = 300;
    var COUNT_UP_MAX_MS = 1200;
    var COUNT_UP_PER_DELTA = 0.4;
    var STREAK_MILESTONES = [10, 25, 50];

    function clamp(n, lo, hi) {
        if (n < lo) return lo;
        if (n > hi) return hi;
        return n;
    }

    /**
     * Format an awarded-points gain as a "+N" badge with thousands grouping.
     * Non-positive or non-finite input yields '' (nothing to celebrate).
     * @param {number} pointsAwarded
     * @returns {string}
     */
    function formatPointsGain(pointsAwarded) {
        var n = Number(pointsAwarded);
        if (!isFinite(n) || n <= 0) return '';
        var whole = Math.floor(n);
        return '+' + whole.toLocaleString('en-US');
    }

    /**
     * Ease-out interpolated INTEGER from `from` to `to` for t in [0,1].
     * t is clamped to [0,1]; t=0 -> from, t=1 -> to exactly.
     * @param {number} from
     * @param {number} to
     * @param {number} t
     * @returns {number}
     */
    function countUpValue(from, to, t) {
        var clamped = clamp(Number(t) || 0, 0, 1);
        // ease-out cubic: fast start, settling finish. eased(0)=0, eased(1)=1.
        var eased = 1 - Math.pow(1 - clamped, 3);
        return Math.round(from + (to - from) * eased);
    }

    /**
     * Animation duration for a count-up of magnitude `delta` (points jumped).
     * clamp(round(300 + |delta|*0.4), 300, 1200).
     * @param {number} delta
     * @returns {number}
     */
    function countUpDurationMs(delta) {
        var d = Math.abs(Number(delta) || 0);
        return clamp(Math.round(COUNT_UP_MIN_MS + d * COUNT_UP_PER_DELTA), COUNT_UP_MIN_MS, COUNT_UP_MAX_MS);
    }

    /**
     * Per-line verdict from a line's score vs its max possible score.
     * r = maxScore>0 ? score/maxScore : 0.
     *   r>=1 -> 'perfect'; r>=0.75 -> 'nice'; r>0 -> 'partial'; else 'miss'.
     * @param {number} score
     * @param {number} maxScore
     * @returns {'perfect'|'nice'|'partial'|'miss'}
     */
    function lineVerdict(score, maxScore) {
        var r = (maxScore > 0) ? (score / maxScore) : 0;
        if (r >= 1) return 'perfect';
        if (r >= 0.75) return 'nice';
        if (r > 0) return 'partial';
        return 'miss';
    }

    /**
     * Streak callout label for the milestone streak lengths (10/25/50), else null.
     * @param {number} streak
     * @returns {string|null}
     */
    function milestoneForStreak(streak) {
        return STREAK_MILESTONES.indexOf(streak) !== -1 ? (String(streak) + ' STREAK') : null;
    }

    /**
     * One-shot tier-up label when the multiplier rises; null when flat/falling.
     * @param {number} prevMultiplier
     * @param {number} multiplier
     * @returns {string|null}
     */
    function tierUpLabel(prevMultiplier, multiplier) {
        return (multiplier > prevMultiplier) ? (String(multiplier) + 'x') : null;
    }

    var api = {
        formatPointsGain: formatPointsGain,
        countUpValue: countUpValue,
        countUpDurationMs: countUpDurationMs,
        lineVerdict: lineVerdict,
        milestoneForStreak: milestoneForStreak,
        tierUpLabel: tierUpLabel
    };
    if (root) root.KaraokeeScoreFeedback = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
```

- [ ] **Step 2: Run the test to verify it PASSES**

Run: `node tests/test_score_feedback_helpers.cjs`
Expected: **PASS** — prints `All score-feedback-helpers tests passed.` with exit code 0.

If any assertion trips, read the failing message and fix the implementation (not the test) — the test encodes the spec. Likely first-attempt mismatches and their fixes:
- `countUpValue` mid-point not `> 500`: confirm the ease curve is ease-**out** (`1 - (1-t)^3`), not linear or ease-in.
- `formatPointsGain(1250)` not `'+1,250'`: confirm `toLocaleString('en-US')` (locale pinned so the test is environment-independent — do not rely on the default locale).
- `countUpDurationMs(2)` not `301`: confirm `Math.round` (round-half-up) wraps `300 + 2*0.4 = 300.8`.

- [ ] **Step 3: Commit the implementation**

```bash
git add static/score-feedback-helpers.js
git commit -m "feat(score-feedback): add pure KaraokeeScoreFeedback reward-math helpers"
```

---

## Task 3: Regression guard + browser-global sanity check

**Files:** none (verification only)

Confirm the new helper does not disturb the existing suite and that the UMD wrapper exposes the expected browser global (the Phase 2 plan will rely on `window.KaraokeeScoreFeedback`).

- [ ] **Step 1: Re-run the new test plus a representative sibling helper test**

```bash
node tests/test_score_feedback_helpers.cjs
node tests/test_mic_check_helpers.cjs
node tests/test_browser_support.cjs
```

Expected: each prints its `All … tests passed.` line; all exit 0. (These confirm the loader pattern still works and nothing global leaked.)

- [ ] **Step 2: Run the full JS `.cjs` suite (no regressions)**

```bash
for f in tests/*.cjs; do echo "== $f =="; node "$f" || break; done
```

Expected: every file prints its "All … passed." line; the loop completes without breaking. The new helper is additive and imported by nothing yet, so all pre-existing tests stay green.

- [ ] **Step 3: Run the Python suite (defensive; this helper cannot touch it)**

```bash
python -m pytest tests/test_app.py tests/test_downloader.py tests/test_lyrics.py -q
```

Expected: PASS. (A pure new static JS file cannot affect Python, but run it to confirm a clean tree before handing off.)

- [ ] **Step 4: Verify the browser global resolves (UMD sanity)**

Confirm the file assigns the browser global as well as `module.exports`. Run:

Run: `grep -n "KaraokeeScoreFeedback" static/score-feedback-helpers.js`
Expected: two references — the JSDoc mention and `root.KaraokeeScoreFeedback = api;`. (No `<script>` is added to any HTML page in this plan — that wiring belongs to the Phase 2 plan. This step only proves the global *name* is correct for that future consumer.)

- [ ] **Step 5: Final commit (only if Steps 1–3 surfaced any fixup; otherwise skip)**

If everything passed with no edits, there is nothing to commit here — the helper and test are already committed in Tasks 1–2. If a regression fix was required, commit it:

```bash
git add -A
git commit -m "test(score-feedback): regression-guard fixup"
```

---

## Done — what this delivers and what consumes it

This plan produces exactly two files — `static/score-feedback-helpers.js` (the pure `window.KaraokeeScoreFeedback` helper) and `tests/test_score_feedback_helpers.cjs` (its golden test) — implementing the six reward-math functions to spec. It is **parallel-safe** (depends on nothing) and changes no existing behavior: the helper is imported by nothing until the Phase 2 re-skin wires it.

**Downstream (NOT in this plan):** the Phase 2 scoring-feedback plan adds a `<script src="/static/score-feedback-helpers.js">` to `player.html` and calls these functions from `player.js`'s render layer to drive:
- the floating **+250** popup on each clear (`formatPointsGain`),
- the score **count-up** on the total instead of the hard `textContent` snap (`countUpValue` + `countUpDurationMs`, driven by `player.js`'s own `requestAnimationFrame` clock),
- the one-shot **tier-up** beat (`tierUpLabel`),
- the **streak-milestone** callouts at 10/25/50 (`milestoneForStreak`),
- the per-line **PERFECT / NICE / partial** verdict replacing the bare `+3/4` fraction (`lineVerdict`).

The frozen scoring modules (`scoring-arcade.js` / `scoring-session.js` / `scoring.js` / `phrase-engine.js`) remain untouched throughout — this helper only *formats and animates* data those modules already emit.
