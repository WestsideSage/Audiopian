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

// ── DEFAULT_PERIOD_MS ─────────────────────────────────────────────
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

// ── beatPhase: mid-beat fractions ─────────────────────────────────
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
