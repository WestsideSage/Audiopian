var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

var code = fs.readFileSync(path.join(__dirname, '..', 'static', 'youtube-source.js'), 'utf8');
var m = { exports: {} };
new Function('module', 'exports', code)(m, m.exports);
var ytStateToString = m.exports.ytStateToString;
var isEmbedDisabledError = m.exports.isEmbedDisabledError;
var YouTubeIframeSource = m.exports.YouTubeIframeSource;

// --- pure state mapping ---
assert.strictEqual(ytStateToString(1), 'playing');
assert.strictEqual(ytStateToString(2), 'paused');
assert.strictEqual(ytStateToString(3), 'buffering');
assert.strictEqual(ytStateToString(0), 'ended');
assert.strictEqual(ytStateToString(5), 'cued');
assert.strictEqual(ytStateToString(-1), 'unstarted');
assert.strictEqual(ytStateToString(99), 'unstarted');

// --- embed-disabled error codes ---
assert.strictEqual(isEmbedDisabledError(150), true);
assert.strictEqual(isEmbedDisabledError(101), true);
assert.strictEqual(isEmbedDisabledError(2), false);
assert.strictEqual(isEmbedDisabledError(100), false);

// --- YouTubeIframeSource against a fake YT API ---
var calls = [];
var captured = {};
function FakePlayer(container, cfg) {
    captured.cfg = cfg;
    this.playVideo = function () { calls.push('play'); };
    this.pauseVideo = function () { calls.push('pause'); };
    this.seekTo = function (t, allow) { calls.push('seek:' + t + ':' + allow); };
    this.getCurrentTime = function () { return 42.0; };
    this.getDuration = function () { return 180.0; };
    this.getPlayerState = function () { return 1; };
    this.setVolume = function (v) { calls.push('vol:' + v); };
    this.destroy = function () { calls.push('destroy'); };
}
var fakeYT = { Player: FakePlayer };

var states = [], ended = 0, errs = [];
var src = YouTubeIframeSource('VID', 'ytplayer', { YT: fakeYT });
src.onState(function (s) { states.push(s); });
src.onEnded(function () { ended++; });
src.onEmbedError(function (c) { errs.push(c); });

// config passes the videoId and disables autoplay (gesture-initiated play, Task 5).
assert.strictEqual(captured.cfg.videoId, 'VID');
assert.strictEqual(captured.cfg.playerVars.autoplay, 0);

// delegation
src.play(); src.pause(); src.seek(30); src.setVolume(0.5);
assert.deepStrictEqual(calls, ['play', 'pause', 'seek:30:true', 'vol:50']);
assert.strictEqual(src.currentTime(), 42.0);
assert.strictEqual(src.duration(), 180.0);
assert.strictEqual(src.isPaused(), false); // state 1 = playing

// events: drive the fake's onStateChange / onError through the captured config.
captured.cfg.events.onStateChange({ data: 1 });
captured.cfg.events.onStateChange({ data: 0 }); // ended
assert.deepStrictEqual(states, ['playing', 'ended']);
assert.strictEqual(ended, 1);
captured.cfg.events.onError({ data: 150 });
assert.deepStrictEqual(errs, [150]);

console.log('All youtube-source tests passed.');
