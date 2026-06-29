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

console.log('All word-fill-helpers tests passed.');
