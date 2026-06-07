# Pure-Static Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Karaokee as a free, zero-server static site (Cloudflare Pages) where the browser does all former server work — lyric ranking, YouTube metadata, free browser-SR recognition, and an optional client-side BYO-key premium recognizer.

**Architecture:** Thin-seams migration. Four new pure UMD helper modules replace the `/load`, `/search`, `/retry-lyrics` server routes; `player.js`'s recognizer is split so mic/VAD always runs (free lane) and OpenAI realtime attaches only with a user key. The frozen scoring path (`scoring-session.js` / `phrase-engine.js` / `scoring.js`) is untouched. Python stays as a local dev/test harness. **Phase 3 reaches a live, validated free-lane demo; Phase 4 is polish.**

**Tech Stack:** Plain HTML/JS (no build step), UMD helper modules (`var` + `window.Karaokee*` + `module.exports`), Node `.cjs` tests via `new Function` eval, Cloudflare Pages, OpenAI Realtime API (client-side), lrclib + YouTube oEmbed.

**Spec:** [docs/superpowers/specs/2026-06-06-pure-static-deployment-design.md](../specs/2026-06-06-pure-static-deployment-design.md)

---

## Phase 0 — De-risk (must pass before building)

These two tasks are **manual spikes with decision gates**, not TDD. They protect against building four modules on a false premise.

### Task 0A: Validate free-lane (browser-SR-only) scoring

**Why:** every honest score we've banked (93–97% / S) used the premium whisper path. The deployed free lane is browser-SR + VAD only, and [ADR-0001](../../adr/0001-tiered-recognizer-byo-key-deploy.md) notes browser SR "rarely fires `final` during continuous singing." If honest singing under-scores on browser-SR alone, free-lane tuning — not this migration — is the real work.

**Files:** temporary throwaway edit to `static/player.js` (reverted at the end).

- [ ] **Step 1: Force a browser-SR-only run (temporary).** In [player.js](../../../static/player.js), temporarily edit `_startWhisperTrack` ([player.js:797](../../../static/player.js)) so it sets up the mic + VAD but skips the realtime/worklet recognizer — i.e. after `src.connect(this._vadAnalyser);` ([player.js:813](../../../static/player.js)), replace the `if (this._isRealtimeWhisperProvider()) { … } else { … }` block with just `await this._startNeuralVad();`. This mimics the Phase-2 split (mic+VAD on, no whisper). Save.

- [ ] **Step 2: Run the validation matrix.** `python app.py`, open `http://localhost:5000`, press `V` to enable arcade if not on, and play **four** songs end-to-end singing honestly: (a) a fast/dense rap track, (b) a slow ballad, (c) one where you deliberately sing wrong words / hum (anti-cheese), (d) a normal pop song you replay twice. Record the headline % and grade for each, and note whether honest runs *feel* fairly scored.

- [ ] **Step 3: Decision gate.** PASS if honest runs (a,b,d) score in a defensible range and feel honest, and (c) stays low (~0). Write the four results into this task as a comment.
  - **If PASS:** revert the Step-1 edit (`git checkout -- static/player.js`) and continue to Task 0B.
  - **If FAIL (honest singing tanks on browser-SR):** STOP. Revert the edit and report back — the milestone pivots to free-lane recognizer/threshold tuning before the static migration is worth doing.

- [ ] **Step 4: Revert the temporary edit.**

Run: `git checkout -- static/player.js`
Expected: `git status` shows no change to `static/player.js`.

### Task 0B: Spike the Cloudflare `_redirects` rewrite

**Why:** `/static/* /:splat 200` is the one unverified deploy-critical assumption (does an existing-asset lookup pre-empt the rewrite? rewrite vs redirect?).

**Files:** throwaway Cloudflare Pages project; temporary `static/_redirects`.

- [ ] **Step 1: Create the temp redirects file.**

Create `static/_redirects`:
```
/static/* /:splat 200
/player /player.html 200
```

- [ ] **Step 2: Deploy the current `static/` to a CF preview.** Either via the Cloudflare dashboard (Workers & Pages → Create → Pages → Direct upload, upload the `static/` folder) or `npx wrangler pages deploy static --project-name=karaokee-spike`. Note the `*.pages.dev` preview URL.

- [ ] **Step 3: Verify on the preview URL.** Confirm: (a) `/` loads index.html, (b) the page's `/static/style.css` and `/static/player.js` requests return 200 (DevTools Network), (c) visiting `/player` serves player.html, (d) a known-missing path like `/static/does-not-exist.js` returns **404** (the rewrite must not mask it).

- [ ] **Step 4: Decision gate.**
  - **If all pass:** keep the `_redirects` approach (Task 8 reuses it). Delete the spike project. `git checkout -- static/_redirects` is not needed (we re-add it in Task 8); for now `rm static/_redirects` to keep the tree clean until Task 8.
  - **If the rewrite misbehaves:** fall back — Task 5/Task 8 will instead rewrite the ~16 `/static/` references to root-relative and add a Flask dev route. Record which path was chosen as a comment here.

---

## Phase 1 — Core browser modules (TDD)

All four follow the repo pattern: top-level functions, a `window.Karaokee*` namespace, a Node `module.exports` block; tests `eval` the file via `new Function('module','exports', code)`.

### Task 1: `lyrics-client.js` — port of `lyrics.py`

**Files:**
- Create: `static/lyrics-client.js`
- Test: `tests/test_lyrics_client.cjs`

- [ ] **Step 1: Write the failing test.**

Create `tests/test_lyrics_client.cjs`:
```js
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

var code = fs.readFileSync(path.join(__dirname, '..', 'static', 'lyrics-client.js'), 'utf8');
var fakeModule = { exports: {} };
new Function('module', 'exports', code)(fakeModule, fakeModule.exports);
var LC = fakeModule.exports;

// --- parseLrc ---
var p = LC.parseLrc('[00:12.34]Hello\n[01:00.00]World\n[00:05.00]   \ngarbage line');
assert.deepStrictEqual(p, [
    { time: 12.34, text: 'Hello' },
    { time: 60.0, text: 'World' },
], 'parseLrc keeps timed non-empty lines, drops empty/garbage');

// --- tokenOverlap ---
assert.strictEqual(LC.tokenOverlap('Hello world', 'hello WORLD'), 1.0);
assert.strictEqual(LC.tokenOverlap('a b', 'c d'), 0.0);
assert.strictEqual(LC.tokenOverlap('', 'x'), 0.0);
assert.strictEqual(LC.tokenOverlap('hello live', 'hello'), 0.5); // inter 1 / max(2,1)

// --- scoreCandidate ---
var s = LC.scoreCandidate(
    { trackName: 'Hello', artistName: 'Adele', duration: 295, syncedLyrics: 'x' },
    'Hello', 'Adele', 295);
assert.strictEqual(s, 9.0, 'title3 + artist3 + dur2 + synced1');
var sNoDur = LC.scoreCandidate(
    { trackName: 'Hello', artistName: 'Adele', duration: 295, syncedLyrics: 'x' },
    'Hello', 'Adele', 0);
assert.strictEqual(sNoDur, 7.0, 'durationless (oEmbed): no duration term');

// --- fetchLyrics: golden ranking (with duration) ---
var candidates = [
    { trackName: 'Hello', artistName: 'Adele', duration: 295, syncedLyrics: '[00:01.00]Hello\n[00:03.00]world' },
    { trackName: 'Hello (Live)', artistName: 'Adele', duration: 300, syncedLyrics: '[00:01.00]Hello live' },
    { trackName: 'Hi', artistName: 'Someone', duration: 200, syncedLyrics: '[00:01.00]Hi' },
];
var fakeFetch = function (url) {
    return Promise.resolve({ ok: true, json: function () { return Promise.resolve(candidates); } });
};
(async function () {
    var best = await LC.fetchLyrics({ title: 'Hello', artist: 'Adele', duration: 295 }, { fetch: fakeFetch });
    assert.deepStrictEqual(best, [{ time: 1, text: 'Hello' }, { time: 3, text: 'world' }], 'picks top-scored candidate');

    // durationless still picks candidate 1
    var best2 = await LC.fetchLyrics({ title: 'Hello', artist: 'Adele', duration: 0 }, { fetch: fakeFetch });
    assert.deepStrictEqual(best2, [{ time: 1, text: 'Hello' }, { time: 3, text: 'world' }], 'durationless picks same');

    // no synced lyrics anywhere -> []
    var none = await LC.fetchLyrics({ title: 'x', artist: 'y' },
        { fetch: function () { return Promise.resolve({ ok: true, json: function () { return Promise.resolve([{ trackName: 'x', syncedLyrics: '' }]); } }); } });
    assert.deepStrictEqual(none, [], 'no synced lyrics -> []');

    // network error -> [] after retries
    var errd = await LC.fetchLyrics({ title: 'x', artist: 'y' },
        { fetch: function () { return Promise.reject(new Error('net')); } });
    assert.deepStrictEqual(errd, [], 'network failure -> []');

    console.log('All lyrics-client tests passed.');
})();
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `node tests/test_lyrics_client.cjs`
Expected: FAIL — `ENOENT` (no `static/lyrics-client.js`) or `Cannot read properties of undefined`.

- [ ] **Step 3: Write the module.**

Create `static/lyrics-client.js`:
```js
/**
 * Browser-side lyrics client: fetch + rank time-synced LRC lyrics from lrclib.net.
 * Port of lyrics.py (parse_lrc / _token_overlap / _score_candidate / fetch_lyrics).
 * Pure except fetchLyrics, which takes an injected `fetch` for testability.
 * No DOM dependencies — testable in Node.js.
 */
var LRCLIB_SEARCH_URL = 'https://lrclib.net/api/search';
var LRCLIB_MAX_ATTEMPTS = 2;

function parseLrc(lrcText) {
    var lines = [];
    var re = /^\[(\d+):(\d+\.\d+)\]\s*(.*)$/;
    var raw = String(lrcText || '').split(/\r?\n/);
    for (var i = 0; i < raw.length; i++) {
        var m = re.exec(raw[i].trim());
        if (m) {
            var text = m[3].trim();
            if (text) lines.push({ time: parseInt(m[1], 10) * 60 + parseFloat(m[2]), text: text });
        }
    }
    return lines;
}

function tokenOverlap(a, b) {
    var ta = new Set(String(a || '').toLowerCase().split(/\W+/).filter(Boolean));
    var tb = new Set(String(b || '').toLowerCase().split(/\W+/).filter(Boolean));
    if (ta.size === 0 || tb.size === 0) return 0.0;
    var inter = 0;
    ta.forEach(function (t) { if (tb.has(t)) inter++; });
    return inter / Math.max(ta.size, tb.size);
}

function scoreCandidate(result, title, artist, duration) {
    var score = 0.0;
    if (result.trackName) score += tokenOverlap(result.trackName, title) * 3.0;
    if (result.artistName) score += tokenOverlap(result.artistName, artist) * 3.0;
    if (duration && result.duration) {
        var diff = Math.abs(result.duration - duration);
        if (diff <= 10) score += 2.0;
        else if (diff <= 30) score += 1.0 * (1 - (diff - 10) / 20);
    }
    if (result.syncedLyrics) score += 1.0;
    return score;
}

async function fetchLyrics(opts, deps) {
    opts = opts || {};
    var title = opts.title || '', artist = opts.artist || '', duration = opts.duration || 0;
    var doFetch = (deps && deps.fetch) || (typeof fetch !== 'undefined' ? fetch : null);
    if (!doFetch) throw new Error('fetchLyrics requires a fetch implementation');
    var url = LRCLIB_SEARCH_URL + '?q=' + encodeURIComponent((title + ' ' + artist).trim());

    var results = null;
    for (var attempt = 1; attempt <= LRCLIB_MAX_ATTEMPTS; attempt++) {
        try {
            var resp = await doFetch(url);
            if (!resp.ok) return [];
            results = await resp.json();
            break;
        } catch (err) {
            if (attempt >= LRCLIB_MAX_ATTEMPTS) return [];
        }
    }
    if (!Array.isArray(results)) return [];

    var scored = [];
    for (var i = 0; i < results.length; i++) {
        if (!results[i].syncedLyrics) continue;
        var parsed = parseLrc(results[i].syncedLyrics);
        if (!parsed.length) continue;
        scored.push({ score: scoreCandidate(results[i], title, artist, duration), parsed: parsed });
    }
    if (!scored.length) return [];
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored[0].parsed;
}

var KaraokeeLyricsClient = { parseLrc: parseLrc, tokenOverlap: tokenOverlap, scoreCandidate: scoreCandidate, fetchLyrics: fetchLyrics };
if (typeof window !== 'undefined') window.KaraokeeLyricsClient = KaraokeeLyricsClient;
if (typeof module !== 'undefined' && module.exports) module.exports = KaraokeeLyricsClient;
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `node tests/test_lyrics_client.cjs`
Expected: `All lyrics-client tests passed.`

- [ ] **Step 5: Commit.**

```bash
git add static/lyrics-client.js tests/test_lyrics_client.cjs
git commit -m "feat(static): lyrics-client.js — browser port of lyrics.py ranking"
```

### Task 2: `youtube-meta.js` — videoId + oEmbed metadata

**Files:**
- Create: `static/youtube-meta.js`
- Test: `tests/test_youtube_meta.cjs`

- [ ] **Step 1: Write the failing test.**

Create `tests/test_youtube_meta.cjs`:
```js
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

var code = fs.readFileSync(path.join(__dirname, '..', 'static', 'youtube-meta.js'), 'utf8');
var fakeModule = { exports: {} };
new Function('module', 'exports', code)(fakeModule, fakeModule.exports);
var YM = fakeModule.exports;

// --- videoIdFromUrl ---
assert.strictEqual(YM.videoIdFromUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
assert.strictEqual(YM.videoIdFromUrl('https://youtu.be/dQw4w9WgXcQ?t=10'), 'dQw4w9WgXcQ');
assert.strictEqual(YM.videoIdFromUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
assert.strictEqual(YM.videoIdFromUrl('https://www.youtube.com/watch?list=x&v=dQw4w9WgXcQ&t=1'), 'dQw4w9WgXcQ');
assert.strictEqual(YM.videoIdFromUrl('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
assert.strictEqual(YM.videoIdFromUrl('https://example.com/not-youtube'), null);
assert.strictEqual(YM.videoIdFromUrl(''), null);

// --- parseTitleArtist (port of downloader.parse_title_artist) ---
assert.deepStrictEqual(YM.parseTitleArtist('Black Moon - Who Got Da Props', 'SomeChannel'),
    { artist: 'Black Moon', title: 'Who Got Da Props' });
assert.deepStrictEqual(YM.parseTitleArtist('Just A Title', 'CoolArtistVEVO'),
    { artist: 'CoolArtistVEVO', title: 'Just A Title' });

// --- fetchMeta ---
(async function () {
    var fakeFetch = function (url) {
        assert.ok(url.indexOf('youtube.com/oembed') !== -1, 'calls oEmbed');
        assert.ok(url.indexOf('dQw4w9WgXcQ') !== -1, 'with the videoId');
        return Promise.resolve({ ok: true, json: function () {
            return Promise.resolve({ title: 'Rick Astley - Never Gonna Give You Up', author_name: 'RickAstleyVEVO' });
        } });
    };
    var meta = await YM.fetchMeta('https://youtu.be/dQw4w9WgXcQ', { fetch: fakeFetch });
    assert.deepStrictEqual(meta, { videoId: 'dQw4w9WgXcQ', artist: 'Rick Astley', title: 'Never Gonna Give You Up' });

    await assert.rejects(YM.fetchMeta('https://example.com/x', { fetch: fakeFetch }), /YouTube URL/);

    console.log('All youtube-meta tests passed.');
})();
```

- [ ] **Step 2: Run to verify it fails.**

Run: `node tests/test_youtube_meta.cjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module.**

Create `static/youtube-meta.js`:
```js
/**
 * Browser-side YouTube metadata: extract videoId from a URL and fetch title/artist
 * via the (CORS-open) YouTube oEmbed endpoint. parseTitleArtist ports
 * downloader.parse_title_artist. fetchMeta takes an injected `fetch`.
 */
function videoIdFromUrl(url) {
    if (!url) return null;
    var s = String(url).trim();
    var m = s.match(/(?:youtu\.be\/)([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
    m = s.match(/[?&]v=([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
    m = s.match(/\/(?:shorts|embed)\/([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
    if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
    return null;
}

function parseTitleArtist(title, author) {
    var t = String(title || '');
    var idx = t.indexOf(' - ');
    if (idx !== -1) return { artist: t.slice(0, idx).trim(), title: t.slice(idx + 3).trim() };
    return { artist: String(author || '').trim(), title: t.trim() };
}

async function fetchMeta(url, deps) {
    var doFetch = (deps && deps.fetch) || (typeof fetch !== 'undefined' ? fetch : null);
    if (!doFetch) throw new Error('fetchMeta requires a fetch implementation');
    var videoId = videoIdFromUrl(url);
    if (!videoId) throw new Error('Not a recognizable YouTube URL');
    var oembedUrl = 'https://www.youtube.com/oembed?url=' +
        encodeURIComponent('https://www.youtube.com/watch?v=' + videoId) + '&format=json';
    var resp = await doFetch(oembedUrl);
    if (!resp.ok) throw new Error('YouTube metadata lookup failed (' + resp.status + ')');
    var data = await resp.json();
    var ta = parseTitleArtist(data.title, data.author_name);
    return { videoId: videoId, artist: ta.artist, title: ta.title };
}

var KaraokeeYouTubeMeta = { videoIdFromUrl: videoIdFromUrl, parseTitleArtist: parseTitleArtist, fetchMeta: fetchMeta };
if (typeof window !== 'undefined') window.KaraokeeYouTubeMeta = KaraokeeYouTubeMeta;
if (typeof module !== 'undefined' && module.exports) module.exports = KaraokeeYouTubeMeta;
```

- [ ] **Step 4: Run to verify it passes.**

Run: `node tests/test_youtube_meta.cjs`
Expected: `All youtube-meta tests passed.`

- [ ] **Step 5: Commit.**

```bash
git add static/youtube-meta.js tests/test_youtube_meta.cjs
git commit -m "feat(static): youtube-meta.js — videoId parse + oEmbed title/artist"
```

### Task 3: `key-store.js` — BYO-key storage + recognizer mode

**Files:**
- Create: `static/key-store.js`
- Test: `tests/test_key_store.cjs`

- [ ] **Step 1: Write the failing test.**

Create `tests/test_key_store.cjs`:
```js
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

var code = fs.readFileSync(path.join(__dirname, '..', 'static', 'key-store.js'), 'utf8');
var fakeModule = { exports: {} };
new Function('module', 'exports', code)(fakeModule, fakeModule.exports);
var KS = fakeModule.exports;

// fake localStorage
function makeStorage() {
    var m = {};
    return {
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
        setItem: function (k, v) { m[k] = String(v); },
        removeItem: function (k) { delete m[k]; },
    };
}
var st = makeStorage();
var deps = { storage: st };

assert.strictEqual(KS.getKey(deps), '');
assert.strictEqual(KS.recognizerMode(deps), 'free');

KS.setKey('  sk-abc123  ', deps);
assert.strictEqual(KS.getKey(deps), 'sk-abc123', 'trims on set');
assert.strictEqual(KS.recognizerMode(deps), 'premium');

KS.clearKey(deps);
assert.strictEqual(KS.getKey(deps), '');
assert.strictEqual(KS.recognizerMode(deps), 'free');

console.log('All key-store tests passed.');
```

- [ ] **Step 2: Run to verify it fails.**

Run: `node tests/test_key_store.cjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module.**

Create `static/key-store.js`:
```js
/**
 * BYO-key store + recognizer-mode decision. Replaces server provider resolution
 * for the deployed app: a stored OpenAI key -> 'premium', else 'free'.
 * `deps.storage` injectable for tests; defaults to window.localStorage.
 */
var KEY_STORAGE = 'openai_api_key';

function _store(deps) {
    if (deps && deps.storage) return deps.storage;
    if (typeof localStorage !== 'undefined') return localStorage;
    return null;
}

function getKey(deps) {
    var s = _store(deps);
    return s ? (s.getItem(KEY_STORAGE) || '') : '';
}

function setKey(k, deps) {
    var s = _store(deps);
    if (s) s.setItem(KEY_STORAGE, String(k || '').trim());
}

function clearKey(deps) {
    var s = _store(deps);
    if (s) s.removeItem(KEY_STORAGE);
}

function recognizerMode(deps) {
    return getKey(deps) ? 'premium' : 'free';
}

var KaraokeeKeyStore = { getKey: getKey, setKey: setKey, clearKey: clearKey, recognizerMode: recognizerMode };
if (typeof window !== 'undefined') window.KaraokeeKeyStore = KaraokeeKeyStore;
if (typeof module !== 'undefined' && module.exports) module.exports = KaraokeeKeyStore;
```

- [ ] **Step 4: Run to verify it passes.**

Run: `node tests/test_key_store.cjs`
Expected: `All key-store tests passed.`

- [ ] **Step 5: Commit.**

```bash
git add static/key-store.js tests/test_key_store.cjs
git commit -m "feat(static): key-store.js — BYO-key storage + recognizer mode"
```

### Task 4: `song-loader.js` — orchestrate URL → songData

**Files:**
- Create: `static/song-loader.js`
- Test: `tests/test_song_loader.cjs`

- [ ] **Step 1: Write the failing test.**

Create `tests/test_song_loader.cjs`:
```js
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

var code = fs.readFileSync(path.join(__dirname, '..', 'static', 'song-loader.js'), 'utf8');
var fakeModule = { exports: {} };
new Function('module', 'exports', code)(fakeModule, fakeModule.exports);
var SL = fakeModule.exports;

var fakeMeta = { fetchMeta: function () { return Promise.resolve({ videoId: 'vid12345678', artist: 'A', title: 'T' }); } };

(async function () {
    // happy path: lyrics found
    var lyricsOk = { fetchLyrics: function () { return Promise.resolve([{ time: 1, text: 'la' }]); } };
    var sd = await SL.loadFromUrl('https://youtu.be/vid12345678', { meta: fakeMeta, lyrics: lyricsOk });
    assert.deepStrictEqual(sd, { videoId: 'vid12345678', artist: 'A', title: 'T', lyrics: [{ time: 1, text: 'la' }] });

    // no lyrics: lyricsError set, still returns videoId/title/artist
    var lyricsNone = { fetchLyrics: function () { return Promise.resolve([]); } };
    var sd2 = await SL.loadFromUrl('https://youtu.be/vid12345678', { meta: fakeMeta, lyrics: lyricsNone });
    assert.strictEqual(sd2.videoId, 'vid12345678');
    assert.deepStrictEqual(sd2.lyrics, []);
    assert.ok(/no synced lyrics/i.test(sd2.lyricsError), 'lyricsError set when none found');

    console.log('All song-loader tests passed.');
})();
```

- [ ] **Step 2: Run to verify it fails.**

Run: `node tests/test_song_loader.cjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module.**

Create `static/song-loader.js`:
```js
/**
 * Orchestrates a paste-a-URL load entirely in the browser: youtube-meta (oEmbed)
 * then lyrics-client (lrclib), returning the exact songData shape index.html
 * writes to sessionStorage. deps.{meta,lyrics,fetch} injectable for tests;
 * defaults to the window.Karaokee* globals.
 */
async function loadFromUrl(url, deps) {
    deps = deps || {};
    var meta = deps.meta || (typeof window !== 'undefined' && window.KaraokeeYouTubeMeta);
    var lyricsClient = deps.lyrics || (typeof window !== 'undefined' && window.KaraokeeLyricsClient);
    if (!meta || !lyricsClient) throw new Error('song-loader requires youtube-meta and lyrics-client');

    var info = await meta.fetchMeta(url, deps);
    var lyrics = await lyricsClient.fetchLyrics({ title: info.title, artist: info.artist }, deps);
    var songData = { videoId: info.videoId, artist: info.artist, title: info.title, lyrics: lyrics || [] };
    if (!songData.lyrics.length) {
        songData.lyricsError = 'No synced lyrics found for "' + info.artist + ' — ' + info.title +
            '". Correct the title/artist below and retry.';
    }
    return songData;
}

var KaraokeeSongLoader = { loadFromUrl: loadFromUrl };
if (typeof window !== 'undefined') window.KaraokeeSongLoader = KaraokeeSongLoader;
if (typeof module !== 'undefined' && module.exports) module.exports = KaraokeeSongLoader;
```

- [ ] **Step 4: Run to verify it passes.**

Run: `node tests/test_song_loader.cjs`
Expected: `All song-loader tests passed.`

- [ ] **Step 5: Commit.**

```bash
git add static/song-loader.js tests/test_song_loader.cjs
git commit -m "feat(static): song-loader.js — URL -> songData orchestrator"
```

---

## Phase 2 — Wire into the app + recognizer split

### Task 5: Rewire `index.html` to the browser modules

**Files:**
- Modify: `static/index.html` (head: add scripts; body lines 1–41: remove search markup; inline script lines 42–235)

- [ ] **Step 1: Load the modules.** In [index.html](../../../static/index.html), immediately before the inline `<script>` at [index.html:42](../../../static/index.html), add:
```html
    <script src="/static/lyrics-client.js"></script>
    <script src="/static/youtube-meta.js"></script>
    <script src="/static/key-store.js"></script>
    <script src="/static/song-loader.js"></script>
```

- [ ] **Step 2: Replace `loadSong()`'s server call.** Replace the `fetch('/load', …)` block ([index.html:114-131](../../../static/index.html)) and its error handling with a `song-loader` call. The function keeps reading `#url`/`#artist`/`#title`; replace the body from `setStatus('Fetching metadata...', '');` through `const data = await metaResp.json();` with:
```js
            setStatus('Fetching song…', '');
            let data;
            try {
                data = await KaraokeeSongLoader.loadFromUrl(url);
            } catch (e) {
                setStatus(e.message || 'Could not load that URL.', 'error');
                loadBtn.disabled = false;
                return;
            }
            // user-typed title/artist override oEmbed
            const aOv = document.getElementById('artist').value.trim();
            const tOv = document.getElementById('title').value.trim();
            if (aOv) data.artist = aOv;
            if (tOv) data.title = tOv;
            if (!aOv) document.getElementById('artist').value = data.artist;
            if (!tOv) document.getElementById('title').value = data.title;
```
The existing `if (data.lyricsError) { … }` and the `sessionStorage.setItem` / navigate block below it stay, except: change `window.location.href = '/player'` ([index.html:154](../../../static/index.html)) to `window.location.href = 'player.html'`.

- [ ] **Step 3: Replace `retryLyrics()`'s server call.** Replace the `fetch('/retry-lyrics', …)` block ([index.html:161-166](../../../static/index.html)) with:
```js
            let data;
            try {
                const lyrics = await KaraokeeLyricsClient.fetchLyrics({ title, artist });
                data = lyrics.length ? { lyrics } : { lyricsError: 'Still no synced lyrics for that title/artist.' };
            } catch (e) {
                data = { lyricsError: 'Lyrics lookup failed.' };
            }
```
Change `window.location.href = '/player'` ([index.html:177](../../../static/index.html)) to `'player.html'`.

- [ ] **Step 4: Remove server search, add paste-URL helper.** Delete `searchSongs`, `renderResults`, `selectResult` ([index.html:46-85](../../../static/index.html)) and the duplicate local `parseTitleArtist` ([index.html:87-93](../../../static/index.html)). In the body markup (index.html lines 1–41 — read them first), remove the `#searchQ` input and `#searchResults` container, and add near the URL field:
```html
    <p class="hint">Paste a YouTube link. Don't have one?
       <a id="ytSearchLink" href="https://www.youtube.com/results" target="_blank" rel="noopener">Search YouTube ↗</a></p>
```
In the keydown handler ([index.html:226-234](../../../static/index.html)), remove the `searchQ` branch so Enter always calls `loadSong()`.

- [ ] **Step 5: Hide local upload outside dev.** Local upload is dev-only ([spec §7](../specs/2026-06-06-pure-static-deployment-design.md)). At the end of the inline script (before `</script>`), add:
```js
        // Local-file upload is a dev-harness feature; hide it on the deployed CDN.
        (function () {
            var isDev = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
            if (!isDev) {
                ['localFile', 'loadLocalBtn'].forEach(function (id) {
                    var el = document.getElementById(id);
                    if (el) { var row = el.closest('.upload-row') || el; row.style.display = 'none'; }
                });
            }
        })();
```
(If the upload controls have no `.upload-row` wrapper, wrap them in one in the markup so a single hide covers them.)

- [ ] **Step 6: Smoke-test against the dev harness.** `python app.py`; open `http://localhost:5000`; paste a real YouTube URL; confirm it loads metadata + lyrics and navigates to the player and plays. (This still works because `localhost` keeps upload visible and the modules call lrclib/oEmbed directly — `/load` is no longer used.)
Expected: song loads and plays; DevTools shows calls to `lrclib.net` and `youtube.com/oembed`, **no** `/load` or `/search` request.

- [ ] **Step 7: Commit.**

```bash
git add static/index.html
git commit -m "feat(static): index.html loads via browser modules; paste-URL; upload dev-only"
```

### Task 6: Split `player.js` recognizer (mic/VAD always-on, realtime key-gated)

**Files:**
- Modify: `static/player.js` (`_startWhisperTrack` [797-859](../../../static/player.js); call site [227](../../../static/player.js); `_isRealtimeWhisperProvider`; status fetch [230](../../../static/player.js); arcade default [2147](../../../static/player.js); telemetry POST)

- [ ] **Step 1: Make recognizer mode local (not server).** Find `_isRealtimeWhisperProvider()` and change its body to read the key store instead of `_whisperServerStatus`:
```js
    _isRealtimeWhisperProvider() {
        return (window.KaraokeeKeyStore && window.KaraokeeKeyStore.recognizerMode() === 'premium');
    }
```

- [ ] **Step 2: Split the track method.** Replace `_startWhisperTrack` ([player.js:797-859](../../../static/player.js)) with two methods. `_startMicAnalysis` always runs (mic + `_vadAnalyser` + neural VAD); `_startRealtimeWhisper` runs only in premium mode and **reuses `this._whisperStream`**:
```js
    async _startMicAnalysis() {
        this._whisperTrackStatus.startAttempts++;
        try {
            this._whisperTrackStatus.state = 'starting';
            var premium = this._isRealtimeWhisperProvider();
            this._whisperTrackStatus.provider = premium ? 'openai_realtime' : 'browser_sr';
            this._whisperStream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
            });
            var sampleRate = premium ? 24000 : 16000;
            this._whisperCtx = new AudioContext({ sampleRate: sampleRate });
            var src = this._whisperCtx.createMediaStreamSource(this._whisperStream);
            this._vadAnalyser = this._whisperCtx.createAnalyser();
            this._vadAnalyser.fftSize = 256;
            this._vadAnalyserBuf = new Float32Array(this._vadAnalyser.fftSize);
            src.connect(this._vadAnalyser);
            await this._startNeuralVad();              // hoisted: free lane needs neural VAD too
            if (premium) await this._startRealtimeWhisper();
            this._whisperTrackStatus.state = 'ready';
            this._renderAsrProviderStatus();
        } catch (err) {
            this._whisperTrackStatus.state = 'error';
            this._whisperTrackStatus.reason = err.message || String(err);
            this._whisperTrackStatus.startFailures++;
            this._renderAsrProviderStatus();
            console.warn('[Mic analysis] unavailable:', this._whisperTrackStatus.reason);
            this._whisperStream = null; this._whisperCtx = null; this._whisperNode = null;
        }
    }

    async _startRealtimeWhisper() {
        await this._openRealtimeWhisperConnection();   // reuses this._whisperStream
    }
```
(The old local-whisper `AudioWorklet`/`/transcribe` branch at [player.js:818-846](../../../static/player.js) is intentionally dropped — the browser is never in server `local` mode. `_openRealtimeWhisperConnection` already uses `this._whisperStream`/`_whisperCtx`.)

- [ ] **Step 2b: Verify `_openRealtimeWhisperConnection` uses the existing stream/context.** Read [player.js:529-600](../../../static/player.js). It must add tracks from `this._whisperStream` and use `this._whisperCtx` (created in `_startMicAnalysis`), not create its own. If it currently created its own, adjust it to use the instance fields. (Pre-split it ran after they were set, so this generally holds.)

- [ ] **Step 3: Update the call site + drop the status probe.** At [player.js:227](../../../static/player.js) change `this._startWhisperTrack();` to `this._startMicAnalysis();`. Remove the `fetch('/whisper-status')` block ([player.js:230-245](../../../static/player.js)) and any `_checkWhisperServerStatus` call inside the recognizer path (the mode is now local). If `_renderAsrProviderStatus` reads `_whisperServerStatus`, point it at `_whisperTrackStatus.provider` instead.

- [ ] **Step 4: Disable the telemetry POST online.** Find the `fetch('/telemetry', …)` call (in `_buildTelemetryPayload`/finalize). Guard it so it only posts on localhost:
```js
        if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
            fetch('/telemetry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).catch(function(){});
        }
```
(The `D`-key client-side debug download stays unchanged.)

- [ ] **Step 5: Flip the arcade default ON.** At [player.js:2147](../../../static/player.js) change:
```js
window.KARAOKEE_V2 = (localStorage.getItem('karaokee_v2') !== '0');
```
so a fresh visitor (no stored value) gets arcade ON; pressing `V` to set `'0'` still opts out.

- [ ] **Step 6: VAD-parity harness check.** Save a fixed mono WAV to `spikes/vad-parity/fixed.wav` (any ~15s vocal clip). Launch Chrome with `--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=spikes/vad-parity/fixed.wav --autoplay-policy=no-user-gesture-required`, open the dev player, and in DevTools console sample `window._kGame._getMicEnergy()` (or the RMS accessor) ~20×/sec for 5s into an array; compare the series to a capture taken on `main` (pre-split) with the same WAV. They should match within float noise.
Expected: energy series effectively identical — confirms the free lane's VAD/energy inputs are unchanged.

- [ ] **Step 7: Run the JS suite + a dev smoke run.** Run every `node tests/*.cjs` (per [CLAUDE.md](../../../CLAUDE.md)); all pass. Then `python app.py`, play a song with **no key set** (free lane): confirm browser-SR greens appear, VAD energy drives highlighting, and the song scores.
Expected: all `.cjs` tests pass; free-lane run scores and highlights normally; no `/whisper-status` request in DevTools.

- [ ] **Step 8: Commit.**

```bash
git add static/player.js
git commit -m "feat(static): split mic/VAD from realtime; local recognizer mode; arcade default ON"
```

---

## Phase 3 — Deploy + validate live (the free-lane checkpoint)

### Task 7: Cloudflare Pages deploy

**Files:**
- Create: `static/_redirects` (if Task 0B chose the rewrite path)

- [ ] **Step 1: Add `_redirects`** (rewrite path from Task 0B). Create `static/_redirects`:
```
/static/* /:splat 200
/player /player.html 200
```
(If Task 0B chose the fallback, instead apply the root-relative asset-path edits + Flask dev route here and skip this file.)

- [ ] **Step 2: Create the Pages project.** Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git → select `WestsideSage/Vocalz`. Build command: *(none)*. Build output directory: `static`. Production branch: `feat/pure-static-deployment` for the first preview (switch to `main` after merge).

- [ ] **Step 3: Deploy + record the URL.** Trigger the first deployment; record the `*.pages.dev` URL in this task.

- [ ] **Step 4: Commit.**

```bash
git add static/_redirects
git commit -m "feat(deploy): Cloudflare Pages _redirects (static/* rewrite, /player)"
```

### Task 8: Validate the live free-lane demo

**Files:** none (manual validation on the deployed URL).

- [ ] **Step 1: Asset + routing check.** On the `*.pages.dev` URL, confirm `/` loads, all `/static/*.js` + `/static/style.css` return 200, `/player` serves the player, mic permission prompts (HTTPS), and the upload UI is **hidden** (non-localhost).

- [ ] **Step 2: Free-lane scoring matrix (no key).** Repeat Task 0A's four-song matrix on the **deployed** site with no key set: fast/dense, slow, wrong-lyrics/silence (~0), normal replay. Confirm honest singing scores honestly and anti-cheese holds.

- [ ] **Step 3: Network check.** DevTools Network shows direct calls to `youtube.com/oembed`, `lrclib.net`, and the YouTube IFrame — and **no** calls to any first-party API route (`/load`, `/search`, `/transcribe`, `/whisper-status`, `/telemetry`).

- [ ] **Step 4: Decision gate.** If the matrix passes, this is a shippable free demo — proceed to Phase 4. If scoring is weak live, stop and tune the free lane before polishing. Record results here.

---

## Phase 4 — Polish

### Task 9: Desktop-Chrome interstitial

**Files:**
- Modify: `static/index.html` (markup + an early inline guard)

- [ ] **Step 1: Add the interstitial markup.** In index.html body, add a hidden overlay:
```html
    <div id="unsupported" style="display:none;position:fixed;inset:0;background:#111;color:#eee;
         display:none;align-items:center;justify-content:center;text-align:center;padding:2rem;z-index:9999">
      <div>
        <h2>Karaokee needs desktop Chrome or Edge</h2>
        <p>The free voice recognition only runs in desktop Chrome/Edge with a microphone.
           Open this link on a desktop Chrome or Edge browser to play.</p>
      </div>
    </div>
```

- [ ] **Step 2: Add the guard** at the very top of the inline `<script>`:
```js
        (function () {
            var hasSR = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
            var isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
            if (!hasSR || isMobile) {
                var el = document.getElementById('unsupported');
                if (el) { el.style.display = 'flex'; }
            }
        })();
```

- [ ] **Step 3: Manual check.** Load normally in Chrome desktop → no overlay. Use DevTools device toolbar (mobile UA) or Firefox → overlay shows.

- [ ] **Step 4: Commit.**

```bash
git add static/index.html
git commit -m "feat(static): desktop-Chrome-only interstitial for unsupported browsers"
```

### Task 10: BYO-key premium lane (client-side mint)

**Files:**
- Modify: `static/index.html` (key field), `static/player.js` (`_openRealtimeWhisperConnection` [529](../../../static/player.js))

- [ ] **Step 1: Add the key field** to index.html (a settings disclosure). Markup:
```html
    <details class="byok">
      <summary>Sharper recognition (optional) — bring your own OpenAI key</summary>
      <input id="openaiKey" type="password" placeholder="sk-…" autocomplete="off">
      <button id="saveKeyBtn" type="button">Save</button>
      <button id="clearKeyBtn" type="button">Clear</button>
      <p class="hint">Stored in this browser and sent only to OpenAI — never to Karaokee.</p>
    </details>
```
Wire it in the inline script:
```js
        (function () {
            var inp = document.getElementById('openaiKey');
            if (inp && window.KaraokeeKeyStore) {
                inp.value = window.KaraokeeKeyStore.getKey();
                document.getElementById('saveKeyBtn').onclick = function () { window.KaraokeeKeyStore.setKey(inp.value); setStatus('Key saved (premium recognition on).', 'success'); };
                document.getElementById('clearKeyBtn').onclick = function () { window.KaraokeeKeyStore.clearKey(); inp.value=''; setStatus('Key cleared (free recognition).', ''); };
            }
        })();
```

- [ ] **Step 2: Confirm the mint payload (Context7).** Fetch current OpenAI Realtime docs via Context7 (`/openai/openai-realtime` or resolve "OpenAI Realtime API") for the `client_secrets` transcription-session body, and cross-check against [app.py:182-194](../../../app.py).

- [ ] **Step 3: Mint directly with the user key.** In `_openRealtimeWhisperConnection` ([player.js:534](../../../static/player.js)), replace the `fetch('/realtime-transcription-session', …)` with a direct OpenAI mint using the stored key (payload mirrors [app.py:182-194](../../../app.py)):
```js
        var key = window.KaraokeeKeyStore && window.KaraokeeKeyStore.getKey();
        if (!key) return Promise.reject(new Error('No OpenAI key for premium recognition'));
        return fetch('https://api.openai.com/v1/realtime/client_secrets', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                expires_after: { anchor: 'created_at', seconds: 600 },
                session: {
                    type: 'transcription',
                    audio: { input: {
                        format: { type: 'audio/pcm', rate: 24000 },
                        transcription: { model: 'gpt-realtime-whisper', language: 'en' }
                    } },
                    include: ['item.input_audio_transcription.logprobs']
                }
            })
        })
```
Keep the rest of the method (it consumes the returned client-secret and connects to `/v1/realtime/calls` via [realtime-whisper.js](../../../static/realtime-whisper.js)) unchanged.

- [ ] **Step 4: Real-key smoke.** With a real OpenAI key pasted, play a song; confirm DevTools shows a 200 from `client_secrets` then a `/v1/realtime/calls` session, and that whisper-attributed words appear (telemetry/HUD). With the key cleared, confirm it cleanly falls back to the free lane.
Expected: premium transcript streams with a key; free lane with none; an invalid key surfaces a 401 and drops to free without crashing.

- [ ] **Step 5: Commit.**

```bash
git add static/index.html static/player.js
git commit -m "feat(static): client-side BYO-key realtime mint (premium recognizer lane)"
```

### Task 11: Score share-image

**Files:**
- Modify: `static/player.js` (end-screen / `showEndModal` area, around [player.js:1634](../../../static/player.js))

- [ ] **Step 1: Add a canvas share-card generator.** Add a method that renders the final grade/score/song to an offscreen canvas and triggers a PNG download:
```js
    _downloadShareImage(summary) {
        var c = document.createElement('canvas'); c.width = 1080; c.height = 1080;
        var x = c.getContext('2d');
        x.fillStyle = '#0b0b12'; x.fillRect(0, 0, 1080, 1080);
        x.fillStyle = '#fff'; x.textAlign = 'center';
        x.font = 'bold 64px sans-serif'; x.fillText('KARAOKEE', 540, 160);
        x.font = 'bold 220px sans-serif'; x.fillText(String(summary.grade || ''), 540, 560);
        x.font = '56px sans-serif'; x.fillText((summary.points || 0) + ' pts · ' + (summary.percent || 0) + '%', 540, 700);
        var sd = {}; try { sd = JSON.parse(sessionStorage.getItem('songData') || '{}'); } catch (e) {}
        x.font = '40px sans-serif'; x.fillStyle = '#aab';
        x.fillText(((sd.artist || '') + ' — ' + (sd.title || '')).slice(0, 48), 540, 800);
        var a = document.createElement('a');
        a.href = c.toDataURL('image/png'); a.download = 'karaokee-score.png'; a.click();
    }
```

- [ ] **Step 2: Add a "Share image" button** to the end modal that calls `_downloadShareImage` with the final summary object used there (match the property names already in scope — `grade`/`points`/`percent`; adjust to the actual summary field names at [player.js:1634](../../../static/player.js)).

- [ ] **Step 3: Manual check.** Finish a song; click "Share image"; confirm a 1080×1080 PNG downloads with grade/score/song.

- [ ] **Step 4: Commit.**

```bash
git add static/player.js
git commit -m "feat(static): downloadable score share-image on the end screen"
```

---

## Phase 5 — Docs + finish

### Task 12: Update docs + merge

- [ ] **Step 1: Update CLAUDE.md + deployment.md.** Note the deployed app is pure-static (no server routes), the four new modules, the recognizer split, and the live URL. Mark the build items in [deployment.md](../../operations/deployment.md) done.

- [ ] **Step 2: Full test pass.** `python -m pytest tests/test_app.py tests/test_downloader.py tests/test_lyrics.py -v` (dev harness still green) and every `node tests/*.cjs`.
Expected: all green.

- [ ] **Step 3: Commit + finish the branch.** Use superpowers:finishing-a-development-branch to choose merge/PR for `feat/pure-static-deployment`.

```bash
git add CLAUDE.md docs/operations/deployment.md
git commit -m "docs: pure-static deployment is live; update architecture + deployment notes"
```

---

## Notes for the executor
- **Frozen path is off-limits:** do not edit `scoring-session.js`, `phrase-engine.js`, `scoring.js`, `scoring-arcade.js` logic. Tasks 5–6 only change *inputs/triggering*, never scoring math.
- **Windows + template literals:** write JS with the Write/Edit tools directly (never via Bash heredocs) — backtick content gets stripped (see [CLAUDE.md](../../../CLAUDE.md)).
- **Stop gates are real:** Task 0A and Task 8 have decision gates. If the free lane fails honest scoring, stop and report — the migration isn't the bottleneck, tuning is.
