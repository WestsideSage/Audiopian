const assert = require('assert');
const { micCheckVerdict } = require('../static/mic-check-helpers.js');

// recognizer missing -> hard fail, regardless of level
let v = micCheckVerdict({ recognizerAvailable: false, peakLevel: 0.5, transcript: 'x', elapsedMs: 1000 });
assert.strictEqual(v.status, 'no-recognizer');
assert.strictEqual(v.ok, false);

// just started, no level yet -> listening (within grace)
v = micCheckVerdict({ recognizerAvailable: true, peakLevel: 0, transcript: '', elapsedMs: 500 });
assert.strictEqual(v.status, 'listening');
assert.strictEqual(v.ok, false);

// long silence below the floor -> silent (mic/permission problem)
v = micCheckVerdict({ recognizerAvailable: true, peakLevel: 0.001, transcript: '', elapsedMs: 5000 });
assert.strictEqual(v.status, 'silent');
assert.strictEqual(v.ok, false);

// level above the floor but no words yet -> capturing
v = micCheckVerdict({ recognizerAvailable: true, peakLevel: 0.1, transcript: '', elapsedMs: 2000 });
assert.strictEqual(v.status, 'capturing');
assert.strictEqual(v.ok, false);

// transcript present -> recognized + ok (the whole pipeline works)
v = micCheckVerdict({ recognizerAvailable: true, peakLevel: 0.1, transcript: 'the quick brown fox', elapsedMs: 2500 });
assert.strictEqual(v.status, 'recognized');
assert.strictEqual(v.ok, true);

// a heard transcript wins even if the metered level looks low (recognizer is the proof)
v = micCheckVerdict({ recognizerAvailable: true, peakLevel: 0.0, transcript: 'testing', elapsedMs: 3000 });
assert.strictEqual(v.status, 'recognized');
assert.strictEqual(v.ok, true);

// whitespace-only transcript is NOT "heard"
v = micCheckVerdict({ recognizerAvailable: true, peakLevel: 0.1, transcript: '   ', elapsedMs: 2000 });
assert.strictEqual(v.status, 'capturing');

// custom levelFloor respected
v = micCheckVerdict({ recognizerAvailable: true, peakLevel: 0.05, transcript: '', elapsedMs: 1000, levelFloor: 0.1 });
assert.strictEqual(v.status, 'listening'); // 0.05 < 0.1 floor, still within grace
v = micCheckVerdict({ recognizerAvailable: true, peakLevel: 0.2, transcript: '', elapsedMs: 1000, levelFloor: 0.1 });
assert.strictEqual(v.status, 'capturing'); // 0.2 >= 0.1 floor

console.log('test_mic_check_helpers: OK');
