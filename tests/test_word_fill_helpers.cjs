var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

// Load word-fill-helpers.js as a plain script (simulates browser <script> loading).
// Parent package.json is "type": "module", so require() would treat .js as ESM.
var filePath = path.join(__dirname, '..', 'static', 'word-fill-helpers.js');
var code = fs.readFileSync(filePath, 'utf8');
var m = { exports: {} };
new Function('module', 'exports', code)(m, m.exports);
var WF = m.exports;

assert.strictEqual(typeof WF.wordFillProgress, 'function', 'wordFillProgress is exported');

// --- wordFillProgress: a 2-second word from t=10 to t=12 -------------------
var w = { start: 10, end: 12 };

// Before start -> 0.
assert.strictEqual(WF.wordFillProgress(w, 9), 0, 'before start -> 0');
assert.strictEqual(WF.wordFillProgress(w, 0), 0, 'well before start -> 0');

// Exactly at start -> 0.
assert.strictEqual(WF.wordFillProgress(w, 10), 0, 'at start -> 0');

// Mid-word linearity.
assert.strictEqual(WF.wordFillProgress(w, 11), 0.5, 'halfway -> 0.5');
assert.strictEqual(WF.wordFillProgress(w, 10.5), 0.25, 'quarter -> 0.25');
assert.strictEqual(WF.wordFillProgress(w, 11.5), 0.75, 'three-quarter -> 0.75');

// Exactly at end -> 1.
assert.strictEqual(WF.wordFillProgress(w, 12), 1, 'at end -> 1');

// After end -> 1 (clamped, never overshoots).
assert.strictEqual(WF.wordFillProgress(w, 13), 1, 'after end -> 1');
assert.strictEqual(WF.wordFillProgress(w, 999), 1, 'well after end -> 1');

// --- zero-duration word (end === start) -> step function ------------------
var zero = { start: 5, end: 5 };
assert.strictEqual(WF.wordFillProgress(zero, 4.9), 0, 'zero-dur before -> 0');
assert.strictEqual(WF.wordFillProgress(zero, 5), 1, 'zero-dur at boundary -> 1 (nowSec >= start)');
assert.strictEqual(WF.wordFillProgress(zero, 5.1), 1, 'zero-dur after -> 1');

// --- negative-duration word (end < start) -> step function ----------------
var neg = { start: 8, end: 6 };
assert.strictEqual(WF.wordFillProgress(neg, 7.9), 0, 'neg-dur before start -> 0');
assert.strictEqual(WF.wordFillProgress(neg, 8), 1, 'neg-dur at start -> 1');
assert.strictEqual(WF.wordFillProgress(neg, 8.5), 1, 'neg-dur after start -> 1');

// --- result is always within [0, 1] ---------------------------------------
var samples = [-100, 9, 10, 10.7, 12, 50];
for (var i = 0; i < samples.length; i++) {
    var p = WF.wordFillProgress(w, samples[i]);
    assert.ok(p >= 0 && p <= 1, 'clamped to [0,1] at nowSec=' + samples[i] + ' got ' + p);
}

// --- does not mutate the input --------------------------------------------
var frozen = { start: 1, end: 3 };
WF.wordFillProgress(frozen, 2);
assert.deepStrictEqual(frozen, { start: 1, end: 3 }, 'input word is not mutated');

// --- lineFillProgress ------------------------------------------------------
assert.strictEqual(typeof WF.lineFillProgress, 'function', 'lineFillProgress is exported');

// Empty array -> empty array.
assert.deepStrictEqual(WF.lineFillProgress([], 5), [], 'empty words -> []');

// A 3-word line; each word delegates to wordFillProgress.
var line = [
    { start: 0, end: 2 },   // word 0: [0,2]
    { start: 2, end: 4 },   // word 1: [2,4]
    { start: 4, end: 6 }    // word 2: [4,6]
];

// nowSec = 3 -> word0 fully filled (1), word1 halfway (0.5), word2 not started (0).
assert.deepStrictEqual(WF.lineFillProgress(line, 3), [1, 0.5, 0], 'mid-line: [1, 0.5, 0]');

// Before the whole line -> all zeros.
assert.deepStrictEqual(WF.lineFillProgress(line, -1), [0, 0, 0], 'before line -> all 0');

// After the whole line -> all ones.
assert.deepStrictEqual(WF.lineFillProgress(line, 100), [1, 1, 1], 'after line -> all 1');

// Result length always matches input length.
assert.strictEqual(WF.lineFillProgress(line, 3).length, line.length, 'length preserved');

// Single-word line.
assert.deepStrictEqual(WF.lineFillProgress([{ start: 10, end: 20 }], 15), [0.5], 'single word -> [0.5]');

// Mixed: a zero-duration word inside the line steps, neighbors interpolate.
var mixed = [
    { start: 0, end: 2 },   // halfway at t=1 -> 0.5
    { start: 2, end: 2 },   // zero-dur; at t=1 (< start) -> 0
    { start: 1, end: 5 }    // at t=1 (== start) -> 0
];
assert.deepStrictEqual(WF.lineFillProgress(mixed, 1), [0.5, 0, 0], 'mixed zero-dur line at t=1');

// Does not mutate the input array or its elements.
var src = [{ start: 1, end: 3 }, { start: 3, end: 5 }];
WF.lineFillProgress(src, 4);
assert.deepStrictEqual(src, [{ start: 1, end: 3 }, { start: 3, end: 5 }], 'input line not mutated');

// --- hardening: missing / non-finite timings -> 0, never NaN, never throws ---
// (a degenerate interpolateWordTimings entry must not write the string "NaN"
//  into the --fill CSS var, which silently kills that word's sweep — see
//  player.js _paintWordFill.)
assert.strictEqual(WF.wordFillProgress(null, 5), 0, 'null word -> 0 (no throw)');
assert.strictEqual(WF.wordFillProgress(undefined, 5), 0, 'undefined word -> 0 (no throw)');
assert.strictEqual(WF.wordFillProgress({}, 5), 0, 'no timings -> 0');
assert.strictEqual(WF.wordFillProgress({ start: 10 }, 5), 0, 'missing end -> 0');
assert.strictEqual(WF.wordFillProgress({ end: 10 }, 5), 0, 'missing start -> 0');
assert.strictEqual(WF.wordFillProgress({ start: NaN, end: 10 }, 5), 0, 'NaN start -> 0');
assert.strictEqual(WF.wordFillProgress({ start: 0, end: NaN }, 5), 0, 'NaN end -> 0');
assert.strictEqual(WF.wordFillProgress({ start: 0, end: Infinity }, 5), 0, 'Infinity end -> 0');
assert.strictEqual(WF.wordFillProgress(w, NaN), 0, 'NaN nowSec -> 0');
assert.strictEqual(WF.wordFillProgress(w, undefined), 0, 'undefined nowSec -> 0');
var bad = WF.wordFillProgress({ start: NaN, end: NaN }, NaN);
assert.ok(!Number.isNaN(bad), 'never returns NaN');

// lineFillProgress tolerates degenerate elements (each bad slot -> 0, no throw).
assert.deepStrictEqual(
    WF.lineFillProgress([{ start: 0, end: 2 }, null, {}], 1),
    [0.5, 0, 0],
    'degenerate elements -> 0 in that slot'
);
assert.deepStrictEqual(WF.lineFillProgress(null, 5), [], 'null words -> []');
assert.deepStrictEqual(WF.lineFillProgress(undefined, 5), [], 'undefined words -> []');

console.log('All word-fill-helpers tests passed.');
