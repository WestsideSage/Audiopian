// Tests for static/stage-helpers.js — pure presentation helpers (range fill %,
// results grade tier). Run: node tests/test_stage_helpers.cjs
var assert = require('node:assert');
var stage = require('../static/stage-helpers.js');

// --- rangeFillPercent ---
assert.strictEqual(stage.rangeFillPercent(0, 100), 0, 'empty bar paints nothing');
assert.strictEqual(stage.rangeFillPercent(50, 100), 50, 'half bar');
assert.strictEqual(stage.rangeFillPercent(100, 100), 100, 'full bar');
assert.strictEqual(stage.rangeFillPercent(0.5, 1), 50, 'fractional max (volume)');
assert.strictEqual(stage.rangeFillPercent('25', '100'), 25, 'string inputs coerce');
assert.strictEqual(stage.rangeFillPercent(150, 100), 100, 'clamps overflow');
assert.strictEqual(stage.rangeFillPercent(-5, 100), 0, 'clamps underflow');
assert.strictEqual(stage.rangeFillPercent(10, 0), 0, 'zero max -> 0 (no NaN)');
assert.strictEqual(stage.rangeFillPercent(10, -1), 0, 'negative max -> 0');
assert.strictEqual(stage.rangeFillPercent('abc', 100), 0, 'NaN value -> 0');
assert.strictEqual(stage.rangeFillPercent(10, 'abc'), 0, 'NaN max -> 0');

// --- gradeTier ---
assert.strictEqual(stage.gradeTier('S'), 's', 'S celebrates');
assert.strictEqual(stage.gradeTier('A'), 'a', 'A celebrates');
assert.strictEqual(stage.gradeTier('B'), 'b', 'B known, quiet');
assert.strictEqual(stage.gradeTier('C'), 'c', 'C known, quiet');
assert.strictEqual(stage.gradeTier('D'), 'd', 'D known, quiet');
assert.strictEqual(stage.gradeTier('s'), 's', 'lowercase accepted');
assert.strictEqual(stage.gradeTier(' S '), 's', 'whitespace trimmed');
assert.strictEqual(stage.gradeTier('F'), '', 'unknown grade -> empty');
assert.strictEqual(stage.gradeTier(''), '', 'empty -> empty');
assert.strictEqual(stage.gradeTier(null), '', 'null -> empty');
assert.strictEqual(stage.gradeTier(undefined), '', 'undefined -> empty');

console.log('All stage-helpers tests passed.');
