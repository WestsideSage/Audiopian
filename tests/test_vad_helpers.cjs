var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

// Load vad-helpers.js as a plain script (simulates browser <script> loading).
// We cannot use require() directly because the parent package.json has
// "type": "module", which makes Node treat .js files as ESM (no `module`).
var filePath = path.join(__dirname, '..', 'static', 'vad-helpers.js');
var code = fs.readFileSync(filePath, 'utf8');
var fakeModule = { exports: {} };
var fn = new Function('module', 'exports', code);
fn(fakeModule, fakeModule.exports);

var createVadState = fakeModule.exports.createVadState;
var updateVad = fakeModule.exports.updateVad;
var calibrate = fakeModule.exports.calibrate;
var neuralVadToggleAction = fakeModule.exports.neuralVadToggleAction;

function approx(a, b, eps, msg) {
    eps = eps != null ? eps : 1e-9;
    assert.ok(Math.abs(a - b) <= eps, (msg || '') + ' expected ' + b + ' got ' + a);
}

// ---------------------------------------------------------------------------
// Defaults sanity
// ---------------------------------------------------------------------------
var d = createVadState();
assert.strictEqual(d.floorAlpha, 0.05);
assert.strictEqual(d.openMargin, 0.02);
assert.strictEqual(d.closeMargin, 0.01);
assert.strictEqual(d.openFrames, 2);
assert.strictEqual(d.closeFrames, 5);
assert.strictEqual(d.noiseFloor, 0);
assert.strictEqual(d.isSpeaking, false);
assert.strictEqual(d.openCounter, 0);
assert.strictEqual(d.closeCounter, 0);
assert.strictEqual(d.calibrated, false);
// hysteresis invariant must hold for defaults
assert.ok(d.closeMargin < d.openMargin, 'closeMargin must be < openMargin');

// opts override + null-coalescing (explicit 0 honored)
var o = createVadState({ floorAlpha: 0.1, openMargin: 0.05, closeMargin: 0.02, openFrames: 3, closeFrames: 7 });
assert.strictEqual(o.floorAlpha, 0.1);
assert.strictEqual(o.openMargin, 0.05);
assert.strictEqual(o.closeMargin, 0.02);
assert.strictEqual(o.openFrames, 3);
assert.strictEqual(o.closeFrames, 7);

// ---------------------------------------------------------------------------
// (a) Noise floor rises (EMA) toward a sustained moderate rms while SILENT.
//     rms = 0.015 stays below openThreshold (= floor + 0.02 >= 0.02), so the
//     gate never opens and the floor adapts every frame.
//     EMA: floor_{n} = floor_{n-1} + 0.05*(0.015 - floor_{n-1})
//       F1 = 0 + 0.05*0.015                = 0.00075
//       F2 = 0.00075 + 0.05*(0.01425)      = 0.0014625
//       F3 = 0.0014625 + 0.05*(0.0135375)  = 0.002139375
// ---------------------------------------------------------------------------
(function testFloorRisesWhileSilent() {
    var s = createVadState();
    var rms = 0.015;

    var r1 = updateVad(s, rms);
    assert.strictEqual(r1.isSpeaking, false, '(a) frame1 must stay silent');
    approx(r1.noiseFloor, 0.00075, 1e-12, '(a) F1 floor');

    var r2 = updateVad(s, rms);
    assert.strictEqual(r2.isSpeaking, false, '(a) frame2 must stay silent');
    approx(r2.noiseFloor, 0.0014625, 1e-12, '(a) F2 floor');

    var r3 = updateVad(s, rms);
    assert.strictEqual(r3.isSpeaking, false, '(a) frame3 must stay silent');
    approx(r3.noiseFloor, 0.002139375, 1e-12, '(a) F3 floor');

    // Monotonic rise + convergence toward 0.015 over many frames.
    var prev = s.noiseFloor;
    for (var i = 0; i < 500; i++) {
        var r = updateVad(s, rms);
        assert.strictEqual(r.isSpeaking, false, '(a) must never open at rms=0.015');
        assert.ok(s.noiseFloor > prev, '(a) floor must rise monotonically');
        assert.ok(s.noiseFloor < rms, '(a) floor must stay below the target rms');
        prev = s.noiseFloor;
    }
    approx(s.noiseFloor, 0.015, 1e-4, '(a) floor converges toward sustained rms');
    assert.strictEqual(s.calibrated, true, '(a) calibrated flag set after updates');
})();

// ---------------------------------------------------------------------------
// (b) DEBOUNCE: a single high-rms frame does NOT open; needs openFrames (=2)
//     CONSECUTIVE highs. A non-qualifying frame between highs resets the
//     counter, so the count must restart from zero.
//     We start from a seeded, settled-ish low floor so thresholds are stable
//     enough that 0.10 is clearly above openThreshold and 0.0 clearly below.
// ---------------------------------------------------------------------------
(function testDebounceOpen() {
    var s = createVadState();
    s.noiseFloor = 0.005; // settled ambient; openThreshold = 0.025
    var HIGH = 0.10;      // well above openThreshold
    var LOW = 0.0;        // below closeThreshold; will not open, drags floor down slightly

    // Single high frame -> must NOT open (only 1 consecutive).
    var r = updateVad(s, HIGH);
    assert.strictEqual(r.isSpeaking, false, '(b) single high frame must not open');
    assert.strictEqual(s.openCounter, 1, '(b) openCounter at 1 after one high');

    // A non-qualifying (low) frame resets the open counter back to 0.
    r = updateVad(s, LOW);
    assert.strictEqual(r.isSpeaking, false, '(b) low frame keeps gate closed');
    assert.strictEqual(s.openCounter, 0, '(b) low frame resets openCounter');

    // Now two CONSECUTIVE highs -> opens on the 2nd.
    r = updateVad(s, HIGH);
    assert.strictEqual(r.isSpeaking, false, '(b) 1st of consecutive highs: still closed');
    assert.strictEqual(s.openCounter, 1, '(b) openCounter=1');
    r = updateVad(s, HIGH);
    assert.strictEqual(r.isSpeaking, true, '(b) 2nd consecutive high opens the gate');
    assert.strictEqual(s.openCounter, 0, '(b) counters reset on open');
    assert.strictEqual(s.closeCounter, 0, '(b) counters reset on open');
})();

// Custom openFrames=3 variant: opens only on the 3rd consecutive high.
(function testDebounceOpenCustomFrames() {
    var s = createVadState({ openFrames: 3 });
    s.noiseFloor = 0.005;
    var HIGH = 0.10;
    assert.strictEqual(updateVad(s, HIGH).isSpeaking, false, '(b3) 1st high');
    assert.strictEqual(updateVad(s, HIGH).isSpeaking, false, '(b3) 2nd high');
    assert.strictEqual(updateVad(s, HIGH).isSpeaking, true, '(b3) 3rd high opens');
})();

// ---------------------------------------------------------------------------
// (c) HYSTERESIS: once open, a frame that dips below openThreshold but stays
//     above closeThreshold KEEPS the gate open. The gate closes only after
//     closeFrames (=5) CONSECUTIVE frames below closeThreshold.
//     Seed a FROZEN floor by forcing the speaking state directly; while
//     speaking the floor never adapts, so:
//       openThreshold  = 0.10 + 0.02 = 0.12
//       closeThreshold = 0.10 + 0.01 = 0.11
// ---------------------------------------------------------------------------
(function testHysteresisHold() {
    var s = createVadState();
    s.noiseFloor = 0.10;
    s.isSpeaking = true; // already in speaking phase; floor frozen

    // Dip: 0.115 is below openThreshold(0.12) but above closeThreshold(0.11).
    // Must KEEP open and NOT start a close count.
    var r = updateVad(s, 0.115);
    assert.strictEqual(r.isSpeaking, true, '(c) dip below open but above close holds open');
    assert.strictEqual(s.closeCounter, 0, '(c) no close progress while above closeThreshold');
    approx(s.noiseFloor, 0.10, 1e-12, '(c) floor frozen while speaking');

    // Another in-between dip — still held open.
    r = updateVad(s, 0.111);
    assert.strictEqual(r.isSpeaking, true, '(c) 0.111 (>0.11) still holds open');
    assert.strictEqual(s.closeCounter, 0, '(c) closeCounter still 0');

    // Now drive 4 consecutive frames below closeThreshold (0.11): not yet 5.
    for (var i = 0; i < 4; i++) {
        r = updateVad(s, 0.05); // below closeThreshold
        assert.strictEqual(r.isSpeaking, true, '(c) below-close frame ' + (i + 1) + ' of 4: still open');
    }
    assert.strictEqual(s.closeCounter, 4, '(c) closeCounter at 4');

    // 5th consecutive below-close frame closes the gate.
    r = updateVad(s, 0.05);
    assert.strictEqual(r.isSpeaking, false, '(c) 5th consecutive below-close closes the gate');
    assert.strictEqual(s.closeCounter, 0, '(c) counters reset on close');
    assert.strictEqual(s.openCounter, 0, '(c) counters reset on close');
})();

// Hysteresis close-counter RESET: a frame >= closeThreshold mid-close resets
// the consecutive count, so the 5-in-a-row requirement restarts.
(function testHysteresisCloseReset() {
    var s = createVadState();
    s.noiseFloor = 0.10;
    s.isSpeaking = true; // close=0.11

    for (var i = 0; i < 4; i++) updateVad(s, 0.05); // 4 below-close
    assert.strictEqual(s.closeCounter, 4, '(c-reset) 4 below-close accumulated');

    // One frame above closeThreshold resets the counter.
    var r = updateVad(s, 0.12);
    assert.strictEqual(r.isSpeaking, true, '(c-reset) still open after reset frame');
    assert.strictEqual(s.closeCounter, 0, '(c-reset) closeCounter reset to 0');

    // Need a fresh run of 5 to close.
    for (var j = 0; j < 4; j++) {
        assert.strictEqual(updateVad(s, 0.05).isSpeaking, true, '(c-reset) below-close ' + (j + 1) + ': still open');
    }
    assert.strictEqual(updateVad(s, 0.05).isSpeaking, false, '(c-reset) 5th fresh below-close closes');
})();

// ---------------------------------------------------------------------------
// Speech does NOT inflate the floor: once open, sustained HIGH rms must leave
// noiseFloor unchanged (the !isSpeaking guard on the EMA). This is the
// assertion that proves the guard works.
// ---------------------------------------------------------------------------
(function testSpeechDoesNotInflateFloor() {
    var s = createVadState();
    s.noiseFloor = 0.03;
    s.isSpeaking = true;
    var frozen = s.noiseFloor;
    for (var i = 0; i < 50; i++) {
        var r = updateVad(s, 0.9); // very loud sustained speech
        assert.strictEqual(r.isSpeaking, true, 'loud speech keeps gate open');
        approx(r.noiseFloor, frozen, 1e-12, 'floor must not move while speaking');
    }
    assert.strictEqual(s.noiseFloor, frozen, 'floor strictly frozen across speech');
})();

// ---------------------------------------------------------------------------
// calibrate() seeds the floor unconditionally (EMA, no speaking guard).
//   F1 = 0 + 0.05*(0.02 - 0)   = 0.001
//   F2 = 0.001 + 0.05*(0.019)  = 0.00195
// ---------------------------------------------------------------------------
(function testCalibrate() {
    var s = createVadState();
    var f1 = calibrate(s, 0.02);
    approx(f1, 0.001, 1e-12, 'calibrate F1');
    assert.strictEqual(s.calibrated, true, 'calibrate sets calibrated flag');
    var f2 = calibrate(s, 0.02);
    approx(f2, 0.00195, 1e-12, 'calibrate F2');

    // calibrate runs the EMA even while "speaking" (unconditional).
    var s2 = createVadState();
    s2.isSpeaking = true;
    var before = s2.noiseFloor;
    var after = calibrate(s2, 0.1);
    assert.ok(after > before, 'calibrate updates floor unconditionally');
})();

// ---------------------------------------------------------------------------
// (d) DETERMINISM: same input sequence -> identical output sequences.
// ---------------------------------------------------------------------------
(function testDeterminism() {
    // Opens early (consecutive 0.2 highs), then a long tail of 0.0 frames that
    // sit below the frozen closeThreshold long enough (>= closeFrames) to close.
    var seq = [0.0, 0.01, 0.2, 0.2, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];

    function run() {
        var s = createVadState();
        var out = [];
        for (var i = 0; i < seq.length; i++) {
            var r = updateVad(s, seq[i]);
            out.push([r.isSpeaking, r.noiseFloor]);
        }
        return out;
    }

    var a = run();
    var b = run();
    assert.deepStrictEqual(a, b, '(d) identical input must yield identical output');

    // Confirm the sequence genuinely opens and then closes again afterward,
    // so the determinism check is exercising a real open->close cycle.
    var firstOpenIdx = a.findIndex(function (x) { return x[0] === true; });
    assert.ok(firstOpenIdx >= 0, '(d) sequence should open at some point');
    var closedAfterOpen = a.slice(firstOpenIdx).some(function (x) { return x[0] === false; });
    assert.ok(closedAfterOpen, '(d) sequence should close again after opening');
})();

// ---------------------------------------------------------------------------
// (e) neuralVadToggleAction: pure decision for re-evaluating the Silero neural
//     VAD when the V2 flag is toggled mid-session. Neural-VAD init is otherwise
//     one-shot at song-start (gated on the flag at that instant), so a later
//     flip never started/stopped it. start when V2 turns on with a live mic and
//     VAD not yet active; stop when V2 turns off but VAD is still active; none
//     otherwise (already in the desired state, or no mic to attach to).
// ---------------------------------------------------------------------------
(function testNeuralVadToggleAction() {
    var f = neuralVadToggleAction;
    // START: V2 on, mic live, not yet active — the bug this fixes (toggling V ON now inits).
    assert.strictEqual(f({ v2Enabled: true, hasMicStream: true, active: false }), 'start', '(e) on+mic+inactive -> start');
    // NO DOUBLE-INIT: already active -> none.
    assert.strictEqual(f({ v2Enabled: true, hasMicStream: true, active: true }), 'none', '(e) already active -> none');
    // NO MIC (no game running): nothing to attach to -> none (will init at next song-start).
    assert.strictEqual(f({ v2Enabled: true, hasMicStream: false, active: false }), 'none', '(e) on but no mic -> none');
    // STOP: V2 off while still active -> tear down, hand back to the RMS gate.
    assert.strictEqual(f({ v2Enabled: false, hasMicStream: true, active: true }), 'stop', '(e) off while active -> stop');
    // STOP is safe even if the mic stream is already gone (active implies a stale MicVAD).
    assert.strictEqual(f({ v2Enabled: false, hasMicStream: false, active: true }), 'stop', '(e) off+active+no-mic -> stop');
    // OFF + already inactive -> none (idempotent).
    assert.strictEqual(f({ v2Enabled: false, hasMicStream: true, active: false }), 'none', '(e) off+inactive -> none');
    assert.strictEqual(f({ v2Enabled: false, hasMicStream: false, active: false }), 'none', '(e) off+inactive+no-mic -> none');
    // Defensive: missing/empty ctx -> none (no throw).
    assert.strictEqual(f({}), 'none', '(e) empty ctx -> none');
    assert.strictEqual(f(), 'none', '(e) no ctx -> none');
})();

console.log('All vad-helpers tests passed.');
