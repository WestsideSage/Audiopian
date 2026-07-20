var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

var filePath = path.join(__dirname, '..', 'static', 'vad-health-helpers.js');
var code = fs.readFileSync(filePath, 'utf8');
var fakeModule = { exports: {} };
var fn = new Function('module', 'exports', code);
fn(fakeModule, fakeModule.exports);

var vadHealthVerdict = fakeModule.exports.vadHealthVerdict;
var GRACE = fakeModule.exports.VAD_HEALTH_GRACE_SEC;

assert.strictEqual(typeof vadHealthVerdict, 'function', 'vadHealthVerdict exported');
assert.strictEqual(typeof GRACE, 'number', 'grace constant exported');

// The discriminating signal for a DEAD sensor (2026-07-20 incident): the
// recognizer is producing text — someone is audibly vocalizing — while the energy
// sensor has never fired. Silence alone must never be flagged.

// Not in active gameplay -> never warn.
assert.strictEqual(vadHealthVerdict({ gameActive: false, vadEverFired: false, asrActive: true, secsSinceFirstAsrText: 60 }),
    'pending', 'no warning outside active gameplay');

// Active but the recognizer has heard nothing -> silence, not sensor death.
assert.strictEqual(vadHealthVerdict({ gameActive: true, vadEverFired: false, asrActive: false, secsSinceFirstAsrText: null }),
    'pending', 'pure silence is never flagged');

// ASR active but still inside the grace window -> pending.
assert.strictEqual(vadHealthVerdict({ gameActive: true, vadEverFired: false, asrActive: true, secsSinceFirstAsrText: 2 }),
    'pending', 'inside the grace window');

// ASR active past the grace window with no VAD ever -> the incident signature.
assert.strictEqual(vadHealthVerdict({ gameActive: true, vadEverFired: false, asrActive: true, secsSinceFirstAsrText: 6 }),
    'sensor-dead', 'ASR text + no VAD past grace = dead sensor');

// The sensor has fired at least once -> proven alive, sticky ok.
assert.strictEqual(vadHealthVerdict({ gameActive: true, vadEverFired: true, asrActive: true, secsSinceFirstAsrText: 60 }),
    'ok', 'a sensor that has fired is proven alive');

// Recovery: once VAD fires, a prior sensor-dead state clears.
assert.strictEqual(vadHealthVerdict({ gameActive: true, vadEverFired: true, asrActive: true, secsSinceFirstAsrText: 10 }),
    'ok', 'vad firing clears the warning');

// Custom grace override.
assert.strictEqual(vadHealthVerdict({ gameActive: true, vadEverFired: false, asrActive: true, secsSinceFirstAsrText: 3 }, { graceSec: 2 }),
    'sensor-dead', 'custom graceSec is honored');
assert.strictEqual(vadHealthVerdict({ gameActive: true, vadEverFired: false, asrActive: true, secsSinceFirstAsrText: 3 }, { graceSec: 4 }),
    'pending', 'custom graceSec is honored (below)');

// Defensive: missing/garbage input never throws, never warns.
assert.strictEqual(vadHealthVerdict(null), 'pending', 'null input is pending');
assert.strictEqual(vadHealthVerdict({ gameActive: true, vadEverFired: false, asrActive: true, secsSinceFirstAsrText: Infinity }),
    'sensor-dead', 'Infinity elapsed counts as past grace');
assert.strictEqual(vadHealthVerdict({ gameActive: true, vadEverFired: false, asrActive: true }),
    'pending', 'missing elapsed stays pending');

console.log('vad-health verdict: all tests passed');
