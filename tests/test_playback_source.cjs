var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

var code = fs.readFileSync(path.join(__dirname, '..', 'static', 'playback-source.js'), 'utf8');
var m = { exports: {} };
new Function('module', 'exports', code)(m, m.exports);
var AudioElementSource = m.exports.AudioElementSource;

// Fake <audio> element: settable props + event registry.
function fakeAudio() {
    return {
        currentTime: 0, duration: NaN, volume: 1, paused: true,
        _h: {},
        addEventListener: function (ev, cb) { (this._h[ev] = this._h[ev] || []).push(cb); },
        _fire: function (ev) { (this._h[ev] || []).forEach(function (f) { f(); }); },
        play: function () { this.paused = false; return Promise.resolve(); },
        pause: function () { this.paused = true; }
    };
}

var el = fakeAudio();
var src = AudioElementSource(el);

// NaN-safety: unknown time/duration report 0, not NaN.
assert.strictEqual(src.currentTime(), 0);
assert.strictEqual(src.duration(), 0);
el.currentTime = 12.5; el.duration = 200;
assert.strictEqual(src.currentTime(), 12.5);
assert.strictEqual(src.duration(), 200);

// seek / volume / pause delegate to the element.
src.seek(30); assert.strictEqual(el.currentTime, 30);
src.setVolume(0.4); assert.strictEqual(el.volume, 0.4);
assert.strictEqual(src.isPaused(), true);

// Callbacks fire on the element's events.
var readyN = 0, endN = 0, states = [];
src.onReady(function () { readyN++; });
src.onEnded(function () { endN++; });
src.onState(function (s) { states.push(s); });
el._fire('canplay'); assert.strictEqual(readyN, 1);
el._fire('ended'); assert.strictEqual(endN, 1);
el._fire('playing'); el._fire('pause'); el._fire('waiting');
assert.deepStrictEqual(states, ['playing', 'paused', 'buffering']);

console.log('All playback-source tests passed.');
