# Client-Side YouTube IFrame Playback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the server-fed `<audio>` backing track with the **client-side YouTube IFrame Player API** so any song plays straight from YouTube in the browser, with no per-user server audio download.

**Architecture:** Introduce a duck-typed **playback-source adapter** so `player.js` drives either a plain `<audio>` element (uploaded local files, dev) or the YouTube IFrame player behind one contract. Build the adapter + IFrame implementation + a pure scoring-gate helper as tested modules, then flip the load flow from `<audio src="/audio">` to an IFrame instantiated from a server-returned `videoId`. The whole scoring clock already funnels through one accessor (`_now()` at `static/player.js:1012`); the spike ([`spikes/youtube-clock/NOTES.md`](../../../spikes/youtube-clock/NOTES.md)) proved the IFrame clock is frame-grained and *smoother* than the `<audio>` clock scoring already trusts, so the clock swap is `player.getCurrentTime()` with **no interpolation layer**.

**Tech Stack:** Plain HTML/JS (no build step; UMD helper modules + `<script>` tags), Flask/Python backend, `node tests/*.cjs` for JS unit tests, `pytest` for Python. YouTube IFrame Player API (loaded from `https://www.youtube.com/iframe_api`).

**Source of truth:** This plan implements deployment build item #1 ([`docs/operations/deployment.md`](../../operations/deployment.md)) under [ADR-0002](../../adr/0002-any-song-client-side-youtube-iframe.md). The clock-precision gate is already cleared (provisional GREEN) by the spike; the **robustness axis** (ads / buffering / seek) is the residual risk and is closed by the final acceptance task, not by this plan's code alone.

---

## Scope

**In scope:** the playback-source swap, the `videoId` load-flow change (backend + frontend), embed-disabled (error 150) graceful fallback, and scoring-gating during non-playing states.

**Explicitly NOT in this plan** (separate deployment items / plans): arcade default-on flip (#2), BYO-key flow (#3), Chrome-only gate page (#4), share-image (#5), production server + hosting (#6). A client-side `youtube-url.js` URL→id parser is **deferred** — the server already extracts metadata, so it returns the `videoId` authoritatively; a client parser is only needed for the future fully-static path.

## File Structure

| File | New/Modify | Responsibility |
|---|---|---|
| `static/playback-source.js` | **Create** | Playback-source contract + `AudioElementSource` (wraps `<audio>`). Pure-ish; unit-tested with a fake element. |
| `static/youtube-source.js` | **Create** | `YouTubeIframeSource` (IFrame impl of the contract) + pure `ytStateToString` / `isEmbedDisabledError` + `ensureYouTubeApi()`. Unit-tested with a fake `YT`. |
| `static/playback-gate.js` | **Create** | Pure `playbackGateDecision(state, opts)` — whether scoring is credited; embed-disabled → fallback. Unit-tested. |
| `tests/test_playback_source.cjs` | **Create** | Tests for `AudioElementSource`. |
| `tests/test_youtube_source.cjs` | **Create** | Tests for `ytStateToString`, `isEmbedDisabledError`, `YouTubeIframeSource` (fake YT). |
| `tests/test_playback_gate.cjs` | **Create** | Tests for `playbackGateDecision`. |
| `static/player.js` | **Modify** | Replace the ~12 direct `audio.*` touch points with a `playback` adapter; choose source by `songData.videoId`; gesture-initiated play; seekbar polling; wire the gate. |
| `static/player.html` | **Modify** | Add a visible `#ytplayer` container + IFrame-API/helper `<script>` tags. |
| `app.py` | **Modify** | `/load` returns `videoId`; download gated behind `KARAOKEE_SERVER_AUDIO` (dev opt-in). |
| `downloader.py` | **Modify** | `extract_metadata` returns `id`. |
| `tests/test_app.py`, `tests/test_downloader.py` | **Modify** | Cover `videoId` in the response + `id` in metadata. |

**The contract (every source returns this exact shape — names are used identically across all tasks):**

```
play(): Promise|void   // begin playback. For UNMUTED audio, MUST be called from a user gesture.
pause(): void
seek(seconds): void
currentTime(): number  // seconds; 0 when unknown
duration(): number     // seconds; 0 when not yet loaded
isPaused(): boolean
setVolume(v): void     // v in [0,1]
onReady(cb): void      // cb() once ready to play
onEnded(cb): void      // cb() at end of media
onState(cb): void      // cb(state); state ∈ 'unstarted'|'playing'|'paused'|'buffering'|'cued'|'ended'
destroy(): void
```

---

## Task 1: Playback-source contract + `AudioElementSource`

**Files:**
- Create: `static/playback-source.js`
- Test: `tests/test_playback_source.cjs`
- Modify: `static/player.html` (add `<script src="/static/playback-source.js">`), `static/player.js` (rewire `audio.*` to a `playback` adapter)

This is a **regression-safe pure refactor**: after this task the app still plays via `<audio>` exactly as before; we have only inserted an adapter seam.

- [ ] **Step 1: Write the failing test** (`tests/test_playback_source.cjs`)

```js
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
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node tests/test_playback_source.cjs`
Expected: FAILS — `playback-source.js` does not exist / `AudioElementSource` is undefined.

- [ ] **Step 3: Implement `static/playback-source.js`**

```js
/**
 * Playback-source adapter. Lets player.js drive either a plain <audio> element
 * (uploaded local files, dev) or the YouTube IFrame player behind one duck-typed
 * contract, so the scoring/UI code is source-agnostic. See the contract in
 * docs/superpowers/plans/2026-06-05-youtube-iframe-playback.md.
 */
function AudioElementSource(el) {
    var ready = [], ended = [], stateCbs = [];
    function emit(list, arg) { for (var i = 0; i < list.length; i++) list[i](arg); }
    el.addEventListener('canplay', function () { emit(ready); });
    el.addEventListener('ended', function () { emit(ended); });
    el.addEventListener('playing', function () { emit(stateCbs, 'playing'); });
    el.addEventListener('pause', function () { emit(stateCbs, 'paused'); });
    el.addEventListener('waiting', function () { emit(stateCbs, 'buffering'); });
    return {
        play: function () { return el.play(); },
        pause: function () { el.pause(); },
        seek: function (t) { el.currentTime = t; },
        currentTime: function () { return isFinite(el.currentTime) ? el.currentTime : 0; },
        duration: function () { return isFinite(el.duration) ? el.duration : 0; },
        isPaused: function () { return !!el.paused; },
        setVolume: function (v) { el.volume = v; },
        onReady: function (cb) { ready.push(cb); },
        onEnded: function (cb) { ended.push(cb); },
        onState: function (cb) { stateCbs.push(cb); },
        destroy: function () { try { el.pause(); } catch (e) {} }
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { AudioElementSource };
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `node tests/test_playback_source.cjs`
Expected: `All playback-source tests passed.`

- [ ] **Step 5: Load the module in `static/player.html`**

Add **before** the `player.js` script tag (after the other helpers, near line 533):

```html
    <script src="/static/playback-source.js"></script>
```

- [ ] **Step 6: Introduce the `playback` adapter in `player.js` and rewire the clock + load**

In `static/player.js`, the element is `const audio = document.getElementById('audio');` (line 1). Immediately after the song-load block that sets the src (currently lines 1935–1937):

```js
// Cache-bust audio src so the browser re-fetches on every page load
audio.src = '/audio?t=' + Date.now();
audio.load();
```

replace with:

```js
// Playback adapter. Task 5 swaps this to a YouTube IFrame source when songData.videoId
// is present; for now (and for uploaded local files) it wraps the <audio> element.
audio.src = '/audio?t=' + Date.now();
audio.load();
var playback = AudioElementSource(audio);
```

Then change the clock accessor `_now()` (lines 1012–1014) from:

```js
    _now() {
        return (audio && isFinite(audio.currentTime)) ? audio.currentTime : 0;
    }
```

to:

```js
    _now() {
        return playback ? playback.currentTime() : 0;
    }
```

- [ ] **Step 7: Rewire the transport controls to `playback`**

Replace `togglePlay`/`skipBack`/`skipFwd` (lines 2058–2078):

```js
function togglePlay() {
    if (playback.isPaused()) {
        playback.play();
        playBtn.textContent = '⏸';
        if (gameMode.active) gameMode.resume();
    } else {
        playback.pause();
        playBtn.textContent = '▶';
        if (gameMode.active) gameMode.suspend();
    }
}

function skipBack() {
    playback.seek(Math.max(0, playback.currentTime() - 10));
    if (gameMode.active) gameMode.onSeek();
}
function skipFwd() {
    playback.seek(Math.min(playback.duration() || 0, playback.currentTime() + 10));
    if (gameMode.active) gameMode.onSeek();
}
```

Replace the seekbar `timeupdate` listener + seek `input` + volume (lines 2081–2095). The IFrame has no `timeupdate` event, so drive the seekbar from a 100ms poll instead of an audio event:

```js
// Seek bar / time display — polled (works for both <audio> and the IFrame, which has no 'timeupdate').
setInterval(function () {
    if (!playback) return;            // null on the IFrame path until ensureYouTubeApi() resolves (Task 5 Step 2)
    var dur = playback.duration();
    if (!dur) return;
    var t = playback.currentTime();
    seekBar.value = (t / dur) * 100;
    timeDisplay.textContent = `${fmt(t)} / ${fmt(dur)}`;
}, 100);

seekBar.addEventListener('input', () => {
    var dur = playback.duration();
    if (dur) {
        playback.seek((seekBar.value / 100) * dur);
        if (gameMode.active) gameMode.onSeek();
    }
});

// Volume
volumeBar.addEventListener('input', () => { playback.setVolume(parseFloat(volumeBar.value)); });
```

- [ ] **Step 8: Rewire the remaining `audio.*` reads (paused check, duration reads, end detection, prep/play)**

Make these exact replacements:

- Line 481 `if (!this.active || audio.paused) return;` → `if (!this.active || playback.isPaused()) return;`
- Line 188 `audioDuration: audio && isFinite(audio.duration) ? audio.duration : null` → `audioDuration: playback ? (playback.duration() || null) : null`
- Lines 1357 / 1555–1556 (`audio.duration`) → use `playback.duration()` (already NaN-safe; `|| null` where a null is expected, e.g. `var d = playback.duration(); meta.songDurationMs = d ? Math.round(d * 1000) : null;`)
- Line 1598 `meta.completed = !!(audio && isFinite(audio.duration) && audio.currentTime >= audio.duration - 0.5);` → `var _d = playback.duration(); meta.completed = !!(_d && playback.currentTime() >= _d - 0.5);`
- Line 1870 `var _endNow = (audio && isFinite(audio.duration)) ? audio.duration + 5 : 1e9;` → `var _endNow = playback.duration() ? playback.duration() + 5 : 1e9;`
- `canplay` autoplay (2154–2158) — replace the audio-event listener with the adapter callback:

```js
playback.onReady(function () {
    if (overlayDismissed) {
        playback.play();
        playBtn.textContent = '⏸';
    }
});
```

- `ended` (2160–2174) — replace the audio-event listener with the adapter callback (keep the body identical):

```js
playback.onEnded(function () {
    if (gameMode.active) {
        setTimeout(function () { gameMode.showEndModal(); }, 1500);
    }
});
```

- `openDifficultyGate` (2249) `audio.pause()` → `playback.pause()`
- `startRunWithDifficulty` (2263–2264) `audio.currentTime = 0; audio.play()...` →

```js
    playback.seek(0);
    playback.play().then(function () { playBtn.textContent = '⏸'; }).catch(function () {});
```

(Note: `playback.play()` may return `undefined` for the IFrame source; guard with `Promise.resolve(playback.play())` — see Task 2 Step 3 where the IFrame `play()` returns nothing. Use: `Promise.resolve(playback.play()).then(...)` here and in `justListen`.)

- `justListen` (2273) and any other `audio.play()` → `Promise.resolve(playback.play()).then(function () { playBtn.textContent = '⏸'; }).catch(function () {});`

- [ ] **Step 9: Verify the regression-safe refactor**

Run the full JS suite (no behavior should change):

Run: `node tests/test_playback_source.cjs && node tests/test_scoring_session.cjs && node tests/test_scoring.cjs`
Expected: all pass.

Then start the app (`python app.py`), load via **local upload** (`/load-local`) to exercise the `<audio>` path, and confirm: play/pause, skip ±10s, seekbar drag, volume, and that lyrics scroll/score exactly as before.

- [ ] **Step 10: Commit**

```bash
git add static/playback-source.js tests/test_playback_source.cjs static/player.html static/player.js
git commit -m "refactor(player): introduce playback-source adapter (AudioElementSource)"
```

---

## Task 2: `YouTubeIframeSource` (IFrame implementation of the contract)

**Files:**
- Create: `static/youtube-source.js`
- Test: `tests/test_youtube_source.cjs`

Built and tested in isolation here (a fake `YT` API is injected); not wired into the app until Task 5.

- [ ] **Step 1: Write the failing test** (`tests/test_youtube_source.cjs`)

```js
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
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node tests/test_youtube_source.cjs`
Expected: FAILS — `youtube-source.js` does not exist.

- [ ] **Step 3: Implement `static/youtube-source.js`**

```js
/**
 * YouTube IFrame implementation of the playback-source contract (see
 * static/playback-source.js). The spike (spikes/youtube-clock/NOTES.md) proved
 * getCurrentTime() is frame-grained and smoother than <audio>.currentTime, so the
 * clock is player.getCurrentTime() with NO performance.now() interpolation layer.
 */
function ytStateToString(code) {
    switch (code) {
        case 1:  return 'playing';
        case 2:  return 'paused';
        case 3:  return 'buffering';
        case 0:  return 'ended';
        case 5:  return 'cued';
        case -1: return 'unstarted';
        default: return 'unstarted';
    }
}

// YouTube onError 101 and 150 both mean "embedding disabled by the video owner".
function isEmbedDisabledError(code) { return code === 101 || code === 150; }

function YouTubeIframeSource(videoId, containerId, opts) {
    opts = opts || {};
    var YT_ = opts.YT || (typeof window !== 'undefined' ? window.YT : null);
    var ready = [], ended = [], stateCbs = [], errCbs = [];
    var isReady = false;
    function emit(list, arg) { for (var i = 0; i < list.length; i++) list[i](arg); }

    var player = new YT_.Player(containerId, {
        videoId: videoId,
        playerVars: {
            autoplay: 0,            // gesture-initiated play (Task 5); unmuted autoplay is blocked
            controls: 1, playsinline: 1, enablejsapi: 1, rel: 0, modestbranding: 1, fs: 0,
            origin: (typeof location !== 'undefined' ? location.origin : undefined)
        },
        events: {
            onReady: function () { isReady = true; emit(ready); },
            onStateChange: function (e) {
                var s = ytStateToString(e.data);
                emit(stateCbs, s);
                if (s === 'ended') emit(ended);   // ENDED(0) is more reliable than <audio>'s 'ended'
            },
            onError: function (e) { emit(errCbs, e.data); }
        }
    });

    function num(v) { return isFinite(v) ? v : 0; }
    return {
        play: function () { if (player.playVideo) player.playVideo(); },
        pause: function () { if (player.pauseVideo) player.pauseVideo(); },
        seek: function (t) { if (player.seekTo) player.seekTo(t, true); },
        currentTime: function () { return player.getCurrentTime ? num(player.getCurrentTime()) : 0; },
        duration: function () { return player.getDuration ? num(player.getDuration()) : 0; },
        isPaused: function () { return !player.getPlayerState || player.getPlayerState() !== 1; },
        setVolume: function (v) { if (player.setVolume) player.setVolume(Math.round(v * 100)); },
        onReady: function (cb) { if (isReady) cb(); else ready.push(cb); },
        onEnded: function (cb) { ended.push(cb); },
        onState: function (cb) { stateCbs.push(cb); },
        onEmbedError: function (cb) { errCbs.push(cb); },
        destroy: function () { try { if (player.destroy) player.destroy(); } catch (e) {} }
    };
}

/**
 * Load the IFrame API <script> once and resolve when window.YT is ready.
 * Browser-only. Idempotent.
 */
function ensureYouTubeApi() {
    return new Promise(function (resolve) {
        if (window.YT && window.YT.Player) { resolve(window.YT); return; }
        var prev = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = function () {
            if (typeof prev === 'function') { try { prev(); } catch (e) {} }
            resolve(window.YT);
        };
        if (!document.getElementById('yt-iframe-api')) {
            var tag = document.createElement('script');
            tag.id = 'yt-iframe-api';
            tag.src = 'https://www.youtube.com/iframe_api';
            document.head.appendChild(tag);
        }
    });
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ytStateToString, isEmbedDisabledError, YouTubeIframeSource, ensureYouTubeApi };
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `node tests/test_youtube_source.cjs`
Expected: `All youtube-source tests passed.`

- [ ] **Step 5: Commit**

```bash
git add static/youtube-source.js tests/test_youtube_source.cjs
git commit -m "feat(player): add YouTubeIframeSource (IFrame playback adapter)"
```

---

## Task 3: `playbackGateDecision` (pure scoring-gate helper)

**Files:**
- Create: `static/playback-gate.js`
- Test: `tests/test_playback_gate.cjs`

**Why this is load-bearing:** when the IFrame buffers or shows a pre-roll ad, `getCurrentTime()` **freezes** while the mic and wall clock keep advancing. Crediting scoring during those windows would compare live sung words against a frozen song clock (false misses/over-credits). This helper decides when scoring is live, and routes embed-disabled to a graceful fallback.

- [ ] **Step 1: Write the failing test** (`tests/test_playback_gate.cjs`)

```js
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

// Embed-disabled overrides everything → fallback UI, scoring off.
var ed = decide('unstarted', { embedDisabled: true });
assert.strictEqual(ed.fallback, true);
assert.strictEqual(ed.scoringActive, false);
assert.strictEqual(ed.reason, 'embed-disabled');

// reason is the state name for the normal path.
assert.strictEqual(decide('buffering').reason, 'buffering');

console.log('All playback-gate tests passed.');
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node tests/test_playback_gate.cjs`
Expected: FAILS — `playback-gate.js` does not exist.

- [ ] **Step 3: Implement `static/playback-gate.js`**

```js
/**
 * Pure decision: given the current playback state, should scoring be credited, and
 * should the embed-disabled fallback UI be shown? Buffering/ads/unstarted FREEZE the
 * song clock while the mic keeps advancing, so scoring must be OFF unless 'playing'.
 */
function playbackGateDecision(state, opts) {
    opts = opts || {};
    if (opts.embedDisabled) {
        return { scoringActive: false, fallback: true, reason: 'embed-disabled' };
    }
    if (state === 'playing') {
        return { scoringActive: true, fallback: false, reason: 'playing' };
    }
    return { scoringActive: false, fallback: false, reason: state || 'unknown' };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { playbackGateDecision };
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `node tests/test_playback_gate.cjs`
Expected: `All playback-gate tests passed.`

- [ ] **Step 5: Commit**

```bash
git add static/playback-gate.js tests/test_playback_gate.cjs
git commit -m "feat(player): add playbackGateDecision (scoring gate for non-playing states)"
```

---

## Task 4: Backend returns `videoId`

**Files:**
- Modify: `downloader.py` (`extract_metadata` returns `id`)
- Modify: `app.py` (`/load` returns `videoId`)
- Modify: `tests/test_downloader.py`, `tests/test_app.py`

This step is **non-breaking**: `/load` still downloads audio (so the `<audio>` path keeps working through Task 5); it only *adds* `videoId` to the response.

- [ ] **Step 1: Write the failing downloader test** (add to `tests/test_downloader.py`)

```python
def test_extract_metadata_returns_id(monkeypatch):
    class FakeYDL:
        def __init__(self, opts): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def extract_info(self, url, download=False):
            return {"title": "Black Moon - Who Got Da Props", "uploader": "Nervous", "duration": 200, "id": "abc123XYZ_-"}
    monkeypatch.setattr(downloader.yt_dlp, "YoutubeDL", FakeYDL)
    meta = downloader.extract_metadata("https://youtu.be/abc123XYZ_-")
    assert meta["id"] == "abc123XYZ_-"
    assert meta["title"] == "Who Got Da Props"
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `python -m pytest tests/test_downloader.py::test_extract_metadata_returns_id -v`
Expected: FAIL — `KeyError: 'id'`.

- [ ] **Step 3: Add `id` to `extract_metadata`** (`downloader.py`, the return at line 55)

```python
    return {"title": title, "artist": artist, "duration": info.get("duration") or 0, "id": info.get("id") or ""}
```

- [ ] **Step 4: Run the downloader test to confirm it passes**

Run: `python -m pytest tests/test_downloader.py::test_extract_metadata_returns_id -v`
Expected: PASS.

- [ ] **Step 5: Write the failing app test** (add to `tests/test_app.py`)

Mirror the existing `/load` test pattern (mock `extract_metadata`, `download_audio`, `fetch_lyrics`). Assert the response includes `videoId`:

```python
def test_load_returns_video_id(client, monkeypatch):
    monkeypatch.setattr(app_module, "extract_metadata",
                        lambda url: {"title": "T", "artist": "A", "duration": 100, "id": "VID123"})
    monkeypatch.setattr(app_module, "download_audio", lambda url: "temp/audio.webm")
    monkeypatch.setattr(app_module, "fetch_lyrics", lambda *a, **k: [{"time": 0.0, "text": "hi"}])
    resp = client.post("/load", json={"url": "https://youtu.be/VID123"})
    assert resp.status_code == 200
    assert resp.get_json()["videoId"] == "VID123"
```

(Use the same import alias / client fixture the file already uses; match the existing `/load` test's mocking exactly.)

- [ ] **Step 6: Run it to confirm it fails**

Run: `python -m pytest tests/test_app.py::test_load_returns_video_id -v`
Expected: FAIL — response has no `videoId`.

- [ ] **Step 7: Add `videoId` to the `/load` response** (`app.py`, the response dict at lines 310–315)

```python
    response = {
        "title": title,
        "artist": artist,
        "videoId": meta.get("id", ""),
        "audioUrl": "/audio",
        "lyrics": lyrics,
    }
```

- [ ] **Step 8: Run both backend tests to confirm they pass**

Run: `python -m pytest tests/test_app.py::test_load_returns_video_id tests/test_downloader.py::test_extract_metadata_returns_id -v`
Expected: both PASS.

- [ ] **Step 9: Commit**

```bash
git add downloader.py app.py tests/test_downloader.py tests/test_app.py
git commit -m "feat(load): return videoId from /load for client-side IFrame embedding"
```

---

## Task 5: Wire the IFrame into the load flow (the cutover)

**Files:**
- Modify: `static/player.html` (add `#ytplayer` container + helper scripts)
- Modify: `static/player.js` (choose source by `videoId`; gesture-initiated play; wire the gate)
- Modify: `app.py` (gate the server download behind `KARAOKEE_SERVER_AUDIO`, default off)

After this task the app plays YouTube songs via the IFrame; uploaded files still use `<audio>`.

- [ ] **Step 1: Add the player container + scripts to `player.html`**

Add the IFrame mount next to the `<audio>` element (line 465). **It must be visible (not `display:none`)** — YouTube pauses hidden players and its ToS requires the embed be visible; a pre-roll ad also needs to render. Keep it small/unobtrusive:

```html
    <audio id="audio"></audio>
    <div id="ytplayer-wrap" style="position:fixed; right:12px; bottom:64px; width:200px; height:113px; z-index:80; border-radius:8px; overflow:hidden;">
        <div id="ytplayer"></div>
    </div>
```

Add the helper + IFrame-API scripts before `player.js` (after line 533, `playback-source.js` was added in Task 1):

```html
    <script src="/static/youtube-source.js"></script>
    <script src="/static/playback-gate.js"></script>
```

- [ ] **Step 2: Choose the playback source by `songData.videoId`**

In `player.js`, replace the Task-1 adapter line (`var playback = AudioElementSource(audio);`) and the `audio.src`/`audio.load()` lines (1935–1937) with a source selection. YouTube songs → IFrame (no `/audio` fetch); uploads (no `videoId`) → `<audio>`:

```js
var playback;
if (songData.videoId) {
    // YouTube IFrame path: no server audio fetch.
    playback = null;  // assigned once the API + player are ready (below)
    ensureYouTubeApi().then(function (YT) {
        playback = YouTubeIframeSource(songData.videoId, 'ytplayer', { YT: YT });
        _wirePlaybackCallbacks();   // defined in Step 4
    });
} else {
    // Uploaded local file path (dev): keep the <audio> element.
    audio.src = '/audio?t=' + Date.now();
    audio.load();
    playback = AudioElementSource(audio);
    _wirePlaybackCallbacks();
}
```

Guard `_now()` and any synchronous `playback.*` call for the brief window before the IFrame is ready: `_now()` already returns `0` when `playback` is falsy (Task 1 Step 6 wrote `return playback ? playback.currentTime() : 0;`). Audit the controls added in Task 1 to no-op when `playback` is null (e.g. `togglePlay`/`skipBack`/`skipFwd`/seek handlers: early-return `if (!playback) return;`). The difficulty gate is not enabled until `onReady` (Step 3), so the user cannot start a run before `playback` exists.

- [ ] **Step 3: Gate the difficulty cards on `onReady` (the gesture prerequisite)**

The prep overlay already shows "Preparing audio…". Keep the cards disabled until the source is ready so the **card click is a valid user gesture for unmuted play**. In `_wirePlaybackCallbacks()` (Step 4), on ready, flip `prepStatus` text and mark the gate ready; have `startRunWithDifficulty`/`justListen` early-return if not ready. Minimal approach: a module flag `var _playbackReady = false;` set true in the ready callback, and:

```js
function startRunWithDifficulty(d) {
    if (!playback || !_playbackReady) return;     // wait for onReady
    localStorage.setItem('arcadeDifficulty', d);
    if (gameMode) gameMode._phraseDifficulty = d;
    _paintDiffPill(d);
    overlayDismissed = true;
    document.getElementById('prepOverlay').style.display = 'none';
    if (gameMode.active) gameMode.stop();
    playback.seek(0);
    Promise.resolve(playback.play()).then(function () { playBtn.textContent = '⏸'; }).catch(function () {});
    gameMode.start();
}
```

(Apply the same `if (!playback || !_playbackReady) return;` guard to `justListen`.)

- [ ] **Step 4: Wire ready / ended / gate callbacks once the source exists**

**Prerequisite — read `gameMode.resume()` and `gameMode.suspend()` before wiring `onState`.** They were built for *user* pause/play; here they fire automatically on every buffering/ad transition (possibly several times mid-song). If either does UI work (overlay/HUD), emits telemetry, or resets timers — i.e. is not idempotent + side-effect-light — do NOT auto-thrash them on buffer flaps. Instead set a lightweight `_scoringFrozen` boolean that the 100ms scoring tick checks (freeze credit without touching the user-pause path). The handler below shows the simple form; switch to the `_scoringFrozen` flag if the method bodies warrant it.

Define `_wirePlaybackCallbacks()` (called from Step 2 for both paths). It moves the `onReady`/`onEnded` wiring from Task 1 Step 8 here (so it attaches to whichever source was built), and adds the gate:

```js
function _wirePlaybackCallbacks() {
    _playbackReady = false;
    playback.onReady(function () {
        _playbackReady = true;
        var ps = document.getElementById('prepStatus');
        if (ps) ps.textContent = 'Ready — pick a difficulty';
        if (overlayDismissed) { playback.play(); playBtn.textContent = '⏸'; }
    });
    playback.onEnded(function () {
        if (gameMode.active) setTimeout(function () { gameMode.showEndModal(); }, 1500);
    });
    playback.onState(function (state) {
        // Freeze scoring whenever the song clock is frozen (buffering/ad/unstarted/paused).
        // Reuse gameMode.resume()/suspend() ONLY if they are idempotent + side-effect-light
        // (see the prerequisite above); otherwise set `_scoringFrozen` and check it in the tick loop.
        var dec = playbackGateDecision(state, { embedDisabled: false });
        if (gameMode && gameMode.active) {
            if (dec.scoringActive) gameMode.resume(); else gameMode.suspend();
        }
    });
    if (playback.onEmbedError) {
        playback.onEmbedError(function (code) {
            if (isEmbedDisabledError(code)) _showEmbedFallback();
        });
    }
}
```

(`gameMode.resume()`/`suspend()` already exist — they are the same hooks `togglePlay` uses. Gating scoring on buffering/ads reuses them, so the freeze is consistent with a manual pause.)

- [ ] **Step 5: Implement the embed-disabled fallback UI**

ADR-0002 requires graceful degradation — tell the user, let them pick another version. Add:

```js
function _showEmbedFallback() {
    var ps = document.getElementById('prepStatus');
    if (ps) ps.textContent = "This video can't be embedded. Go back and try another version (a “… - Topic” upload usually works).";
    var gate = document.getElementById('diffGateCards');
    if (gate) gate.style.display = 'none';
}
```

- [ ] **Step 6: Gate the server audio download behind a dev flag** (`app.py`, lines 300–303)

Now that YouTube playback is client-side, stop the per-user download (it's slow, 403-prone from cloud IPs, and unused for the IFrame path). Keep it as a dev opt-in:

```python
    if os.environ.get("KARAOKEE_SERVER_AUDIO") == "1":
        try:
            download_audio(url)
        except Exception as e:
            return jsonify({"error": f"Could not download audio: {str(e)}"}), 400
```

(`/load-local` uploads and `/audio` are untouched — the `<audio>` dev path still works.)

- [ ] **Step 7: Verify end to end in the browser**

Run `python app.py`, go through `index.html`, paste an **embeddable** YouTube URL (a "… - Topic" upload), and confirm:
1. The prep overlay shows "Preparing audio…" then "Ready — pick a difficulty" (onReady).
2. Clicking a difficulty card starts **unmuted** playback (gesture) and scoring begins. **This is the one assumption the spike never tested** — it proved *muted* autoplay only, and Chrome gesture-gates unmuted autoplay. If it fails, the fallback is the same "click to start" gesture pattern already hit with the `<audio>.play()` `NotAllowedError` during this session — a known, cheap recovery, not a redesign.
3. Seekbar/time-display track; skip ±10s and seek work; volume works.
4. Pause/buffering suspends scoring; resuming continues it.
5. Pasting an embed-disabled video shows the fallback message (not a broken page).
6. An uploaded local file still plays via `<audio>` (regression).

- [ ] **Step 8: Run the full suite**

Run: `node tests/test_playback_source.cjs && node tests/test_youtube_source.cjs && node tests/test_playback_gate.cjs && python -m pytest tests/test_app.py tests/test_downloader.py -v`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add static/player.html static/player.js app.py
git commit -m "feat(player): play backing track via client-side YouTube IFrame; <audio> fallback for uploads"
```

---

## Task 6: Acceptance — the ADR-0002 cutover gate

**This is a verification task, not code.** It closes the robustness axis the spike deliberately left open. Do not mark build item #1 done until this passes.

- [ ] **Step 1: Robustness measurement run (the spike's deferred test)**

In normal desktop Chrome (logged in / no ad-blocker, so a pre-roll ad actually fires), play a real **"… - Topic" rap upload** (fast tempo = worst case for timing) through the *real app* (not the spike harness). Then re-run the spike harness on that same video to capture numbers:

```
python -m http.server 8765 --directory 'spikes/youtube-clock'   # PowerShell-quoted path on Windows
# open http://localhost:8765/?v=<that video id>&secs=90 in normal Chrome; let the pre-roll ad play
```

Record `window.__SPIKE_RESULT`. **Pass criteria:** jump-error p99 < 50ms (GREEN band), AND review `stallCount` / `worstStallMs` / `forwardJumps` / `errors`. A pre-roll ad or buffering that desyncs scoring by hundreds of ms is a fail → add ad/stall handling to `playbackGateDecision` (heuristic: `getCurrentTime()` not advancing while state `playing` for > ~400ms ⇒ treat as non-scoring) before shipping.

- [ ] **Step 2: Anti-cheese sing-test (the standing gate)**

Run the human sing-test in the real app on the IFrame path: an honest expert run scores correctly, and a skip-a-line attempt does **not** over-credit. Then scan the saved telemetry JSON (`output_telemetry/<date>/`) for `*_reconciled` credits on skipped lines. (This is the standing gate from the arcade work — the playback swap must not regress it.)

- [ ] **Step 3: Record the verdict and retire the spike**

Update [`spikes/youtube-clock/NOTES.md`](../../../spikes/youtube-clock/NOTES.md) "Real verdict" with the ad-surviving numbers, then either delete `spikes/youtube-clock/` or migrate the final verdict into [ADR-0002](../../adr/0002-any-song-client-side-youtube-iframe.md). Tear down the leftover dev server / automation browser.

- [ ] **Step 4: Commit the cleanup**

```bash
git add -A
git commit -m "chore(spike): retire youtube-clock spike; record IFrame cutover verdict"
```

---

## Self-Review (completed by plan author)

- **Spec coverage:** client-side IFrame playback (Tasks 1–5) ✓; any-song via `videoId` (Task 4) ✓; embed-disabled graceful fallback (Task 5 Steps 5 + Task 3) ✓; no server audio download (Task 5 Step 6) ✓; `<audio>` survives dev/uploads (Task 1 + Task 5 Step 2) ✓; clock-precision (spike, referenced; Task 2 no-interpolation) ✓; robustness/ads/seek cutover gate (Task 6) ✓. Out-of-scope items (#2–#6) explicitly excluded.
- **Placeholders:** none — every code step shows complete code; verification steps name exact commands/criteria.
- **Type/name consistency:** the contract methods (`play/pause/seek/currentTime/duration/isPaused/setVolume/onReady/onEnded/onState/destroy`, plus `onEmbedError` on the IFrame source) are used identically in Tasks 1, 2, 5; `playbackGateDecision`, `ytStateToString`, `isEmbedDisabledError`, `ensureYouTubeApi`, `YouTubeIframeSource`, `AudioElementSource` match across tasks and tests.
- **Known soft spot:** ad **detection** has no public IFrame event; Task 3 ships the clear-state gate and Task 6 Step 1 specifies the `getCurrentTime`-stalled heuristic to add *only if* the ad-surviving run shows a desync (YAGNI until measured).
