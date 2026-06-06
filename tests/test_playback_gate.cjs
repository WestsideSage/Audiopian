var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

var code = fs.readFileSync(path.join(__dirname, '..', 'static', 'playback-gate.js'), 'utf8');
var m = { exports: {} };
new Function('module', 'exports', code)(m, m.exports);
var decide = m.exports.playbackGateDecision;

// Only 'playing' credits scoring.
assert.strictEqual(decide('playing').scoringActive, true);
['buffering', 'unstarted', 'cued', 'paused', 'ended'].forEach(function (s) {
    assert.strictEqual(decide(s).scoringActive, false, s + ' must freeze scoring');
});

// No fallback in the normal states.
assert.strictEqual(decide('playing').fallback, false);
assert.strictEqual(decide('buffering').fallback, false);

// Embed-disabled overrides everything -> fallback UI, scoring off.
var ed = decide('unstarted', { embedDisabled: true });
assert.strictEqual(ed.fallback, true);
assert.strictEqual(ed.scoringActive, false);
assert.strictEqual(ed.reason, 'embed-disabled');

// reason is the state name for the normal path.
assert.strictEqual(decide('buffering').reason, 'buffering');

console.log('All playback-gate tests passed.');
