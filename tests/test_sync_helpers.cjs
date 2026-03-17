var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

// Load sync-helpers.js as a plain script (simulates browser <script> loading).
// We cannot use require() directly because the parent package.json has "type": "module",
// which causes Node to treat .js files as ESM where `module` is not defined.
var filePath = path.join(__dirname, '..', 'static', 'sync-helpers.js');
var code = fs.readFileSync(filePath, 'utf8');

// Create a module-like context so the CommonJS exports block works
var fakeModule = { exports: {} };
var fn = new Function('module', 'exports', code);
fn(fakeModule, fakeModule.exports);

var classifyTempo = fakeModule.exports.classifyTempo;
var getWindowParams = fakeModule.exports.getWindowParams;
var getOverlapDuration = fakeModule.exports.getOverlapDuration;
var getScoreDelay = fakeModule.exports.getScoreDelay;

// --- classifyTempo ---
assert.strictEqual(classifyTempo(1.0), 'slow');
assert.strictEqual(classifyTempo(1.9), 'slow');
assert.strictEqual(classifyTempo(2.0), 'normal');
assert.strictEqual(classifyTempo(5.0), 'normal');
assert.strictEqual(classifyTempo(5.1), 'fast');
assert.strictEqual(classifyTempo(10.0), 'fast');
assert.strictEqual(classifyTempo(0), 'slow');       // edge: zero
assert.strictEqual(classifyTempo(-1), 'slow');       // edge: negative

// --- getWindowParams ---
var slow = getWindowParams('slow');
assert.strictEqual(slow.windowStart, -0.3);
assert.strictEqual(slow.windowEnd, 1.5);
assert.strictEqual(slow.driftTrack1, 14);
assert.strictEqual(slow.driftTrack2, 12);

var normal = getWindowParams('normal');
assert.strictEqual(normal.windowStart, -0.3);
assert.strictEqual(normal.windowEnd, 1.5);
assert.strictEqual(normal.driftTrack1, 18);
assert.strictEqual(normal.driftTrack2, 15);

var fast = getWindowParams('fast');
assert.strictEqual(fast.windowStart, -0.5);
assert.strictEqual(fast.windowEnd, 2.5);
assert.strictEqual(fast.driftTrack1, 25);
assert.strictEqual(fast.driftTrack2, 20);

// fallback: unknown class defaults to normal
var unknown = getWindowParams('unknown');
assert.deepStrictEqual(unknown, normal);

// --- getOverlapDuration ---
assert.strictEqual(getOverlapDuration('slow'), 1.0);
assert.strictEqual(getOverlapDuration('normal'), 0.8);
assert.strictEqual(getOverlapDuration('fast'), 0.5);
assert.strictEqual(getOverlapDuration('unknown'), 0.8);

// --- getScoreDelay ---
assert.strictEqual(getScoreDelay('slow'), 1.2);
assert.strictEqual(getScoreDelay('normal'), 0.8);
assert.strictEqual(getScoreDelay('fast'), 0.5);
assert.strictEqual(getScoreDelay('unknown'), 0.8);

// --- interpolateWordTimings tempo metadata ---
// We test the WPS calculation formula that interpolateWordTimings will use.
// The actual integration is: interpolateWordTimings calls classifyTempo(wps).

// Verify WPS calculation formula
function computeWps(wordCount, lineStart, lineEnd) {
    var duration = lineEnd - lineStart;
    if (duration <= 0) return 0;
    return wordCount / duration;
}

// Slow: 3 words in 4 seconds = 0.75 wps
assert.strictEqual(classifyTempo(computeWps(3, 0, 4)), 'slow');
// Normal: 6 words in 2 seconds = 3.0 wps
assert.strictEqual(classifyTempo(computeWps(6, 10, 12)), 'normal');
// Fast: 12 words in 1.5 seconds = 8.0 wps
assert.strictEqual(classifyTempo(computeWps(12, 20, 21.5)), 'fast');
// Edge: last line with audio.duration fallback (8s clamp)
assert.strictEqual(classifyTempo(computeWps(4, 180, 188)), 'slow');

// --- getChunkSamples ---
var getChunkSamples = fakeModule.exports.getChunkSamples;
assert.strictEqual(getChunkSamples('slow'), 32000);
assert.strictEqual(getChunkSamples('normal'), 24000);
assert.strictEqual(getChunkSamples('fast'), 12000);
assert.strictEqual(getChunkSamples('unknown'), 24000);

// --- computeSongTempoProfile ---
var computeSongTempoProfile = fakeModule.exports.computeSongTempoProfile;

// Empty / all-zero input → fallback defaults
var emptyProfile = computeSongTempoProfile([]);
assert.strictEqual(emptyProfile.p50, 2.0);
assert.strictEqual(emptyProfile.p80, 5.0);

// Single line
var single = [{ wps: 3.0 }];
var sp = computeSongTempoProfile(single);
assert.strictEqual(sp.p50, 3.0);
assert.strictEqual(sp.p80, 3.0);

// Five lines: [1.0, 2.0, 3.0, 4.0, 5.0]
// p50 = 3.0, p80 = 4.2 (interpolated between index 3 and 4)
var fiveLines = [
    { wps: 5.0 }, { wps: 1.0 }, { wps: 3.0 }, { wps: 2.0 }, { wps: 4.0 }
];
var fp = computeSongTempoProfile(fiveLines);
assert.strictEqual(fp.p50, 3.0);
assert.ok(fp.p80 > 4.0 && fp.p80 < 5.0, 'p80 should be between 4 and 5');

// Lines with wps=0 are filtered out
var withZero = [{ wps: 0 }, { wps: 2.0 }, { wps: 4.0 }];
var wzp = computeSongTempoProfile(withZero);
assert.strictEqual(wzp.p50, 3.0); // median of [2.0, 4.0] = 3.0

// --- classifyLineTempoRelative ---
var classifyLineTempoRelative = fakeModule.exports.classifyLineTempoRelative;

var profile = { p50: 2.0, p80: 4.0 };

// below p50 → slow
assert.strictEqual(classifyLineTempoRelative(1.0, profile), 'slow');
assert.strictEqual(classifyLineTempoRelative(1.9, profile), 'slow');

// at or above p50, below p80 → medium
assert.strictEqual(classifyLineTempoRelative(2.0, profile), 'medium');
assert.strictEqual(classifyLineTempoRelative(3.5, profile), 'medium');
assert.strictEqual(classifyLineTempoRelative(3.99, profile), 'medium');

// at or above p80 → fast
assert.strictEqual(classifyLineTempoRelative(4.0, profile), 'fast');
assert.strictEqual(classifyLineTempoRelative(8.0, profile), 'fast');

// edge: p50 === p80 (all lines same tempo) → fast if at/above, slow otherwise
var flatProfile = { p50: 3.0, p80: 3.0 };
assert.strictEqual(classifyLineTempoRelative(3.0, flatProfile), 'fast');
assert.strictEqual(classifyLineTempoRelative(2.9, flatProfile), 'slow');

console.log('All sync-helpers tests passed.');

var getSpokenWindowSize = fakeModule.exports.getSpokenWindowSize;

assert.strictEqual(getSpokenWindowSize('slow'), 20);
assert.strictEqual(getSpokenWindowSize('normal'), 15);
assert.strictEqual(getSpokenWindowSize('fast'), 12);
assert.strictEqual(getSpokenWindowSize('unknown'), 15);

console.log('All getSpokenWindowSize tests passed.');
