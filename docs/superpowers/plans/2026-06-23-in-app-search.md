# In-App Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace "paste a YouTube URL" as the way into a song with an in-app, lyrics-first search: type a song → pick from real lrclib results (guaranteed synced lyrics) → pick the right video from a smart picker → sing. Plus a curated starter row and a paste fallback that only appears when search fails.

**Architecture:** The browser searches lrclib directly (keyless, CORS-open — already in `lyrics-client.js`) and renders the song results. Picking a song calls a **standalone Cloudflare Worker** (`/api/resolve`) that holds the YouTube Data API key server-side, finds the best embeddable videos (ranked by duration-match + channel + title-sanity), and returns the top candidates. The browser shows a best-first picker; on pick it assembles the existing `songData` shape and navigates to `/player`. A pure `metadata-clean.js` helper hardens the paste-fallback's title/artist parsing.

**Tech Stack:** Plain browser JS (UMD helper modules, no build step), Flask dev harness (`app.py`), Cloudflare Workers (`wrangler`), YouTube Data API v3 (`search.list` + `videos.list`), lrclib.net search API. Tests: Node `.cjs` for pure logic; manual/Playwright for DOM wiring.

---

## Context the implementing engineer needs

- **No build step.** Browser helper files use a UMD tail so they load as `<script>` globals **and** `require()` in Node `.cjs` tests:
  ```js
  if (typeof window !== 'undefined') window.KaraokeeX = KaraokeeX;
  if (typeof module !== 'undefined' && module.exports) module.exports = KaraokeeX;
  ```
- **JS tests run with plain Node:** `node tests/test_<name>.cjs` (no test framework; the files assert and throw). Follow the style of the existing `tests/*.cjs`.
- **The `songData` contract** (what `/player` consumes from `sessionStorage`):
  ```js
  { videoId: "abc123", artist: "Special Ed", title: "I Got It Made",
    lyrics: [{time: 12.34, text: "..."}], lyricsError?: "..." }
  ```
  index.html writes it with `sessionStorage.setItem('songData', JSON.stringify(data))` then `window.location.href = '/player'`. Every search/pick/starter path produces this shape and navigates the same way.
- **lrclib search** (`lyrics-client.js`) hits `https://lrclib.net/api/search?q=<query>` and gets back an array of `{ trackName, artistName, duration, syncedLyrics, ... }`. Today `fetchLyrics` keeps only the single best match; we will add a function that returns the **list** (each with parsed lyrics) so it can drive search results.
- **Reuse, don't reinvent:** the result-list CSS already exists — `.search-results`, `.search-result-item`, `.search-result-title`, `.search-result-meta` in `static/style.css:230-247`. The song list and the video picker both use it.
- **index.html has no automated test harness** (the `.cjs` suites are pure-logic only). Pure helpers (Tasks 1–5) are TDD'd with `.cjs`. DOM wiring (Tasks 6–10) is verified by running the app and a short manual/Playwright checklist given in each task.
- **Commit after every green step.** Branch for this work: `feat/in-app-search`.

```bash
git checkout -b feat/in-app-search
```

---

## Phase 1 — Metadata cleaning (robustness win; unblocks the paste fallback)

### Task 1: `metadata-clean.js` pure helper

Fixes two real bugs in the current paste path: (a) the title/artist split only matches an ASCII `" - "`, so an en-dash title like `"Rick Astley – Never Gonna Give You Up"` falls through and the **channel** becomes the artist; (b) noise like `(Official Audio)` / `ft. X` rides along in the title and breaks the lrclib match. **Targeted** noise removal only — never blanket-strip parentheses (that would destroy `"(I Can't Get No) Satisfaction"`).

**Files:**
- Create: `static/metadata-clean.js`
- Test: `tests/test_metadata_clean.cjs`

- [ ] **Step 1: Write the failing test**

```js
// tests/test_metadata_clean.cjs
const assert = require('assert');
const { cleanMetadata, stripNoise } = require('../static/metadata-clean.js');

// --- separator handling: prefer an in-title "Artist - Title" over the channel ---
let r = cleanMetadata('Rick Astley – Never Gonna Give You Up', 'CookieMonsta53'); // en-dash
assert.strictEqual(r.artist, 'Rick Astley', 'en-dash: artist from title, not channel');
assert.strictEqual(r.title, 'Never Gonna Give You Up', 'en-dash: title is the right half');

r = cleanMetadata('Rick Astley - Never Gonna Give You Up', 'CookieMonsta53'); // ascii hyphen
assert.strictEqual(r.artist, 'Rick Astley');
assert.strictEqual(r.title, 'Never Gonna Give You Up');

r = cleanMetadata('Special Ed — I Got It Made', 'Some Uploader'); // em-dash
assert.strictEqual(r.artist, 'Special Ed');
assert.strictEqual(r.title, 'I Got It Made');

// --- no separator in title: fall back to channel as artist, cleaned of "- Topic" ---
r = cleanMetadata('I Got It Made', 'Special Ed - Topic');
assert.strictEqual(r.artist, 'Special Ed', 'Topic suffix stripped from channel');
assert.strictEqual(r.title, 'I Got It Made');

// --- targeted noise removal from the title ---
assert.strictEqual(stripNoise('Never Gonna Give You Up (Official Video)'), 'Never Gonna Give You Up');
assert.strictEqual(stripNoise('Juicy (Official Audio)'), 'Juicy');
assert.strictEqual(stripNoise('Song [Official Music Video]'), 'Song');
assert.strictEqual(stripNoise('Song (Lyrics)'), 'Song');
assert.strictEqual(stripNoise('Song (Visualizer)'), 'Song');
assert.strictEqual(stripNoise('Hotline Bling ft. Drake'), 'Hotline Bling');
assert.strictEqual(stripNoise('Song feat. Someone'), 'Song');
assert.strictEqual(stripNoise('Song (Remastered 2009)'), 'Song');
assert.strictEqual(stripNoise('Song (HD)'), 'Song');

// --- DO NOT over-strip: legitimate parenthetical titles survive ---
assert.strictEqual(stripNoise("(I Can't Get No) Satisfaction"), "(I Can't Get No) Satisfaction");
assert.strictEqual(stripNoise('(Sittin\' On) The Dock of the Bay'), '(Sittin\' On) The Dock of the Bay');

// --- end to end: noisy title with a dash and a feat ---
r = cleanMetadata('Special Ed - I Got It Made (Official Audio)', 'RandomChannel');
assert.strictEqual(r.artist, 'Special Ed');
assert.strictEqual(r.title, 'I Got It Made');

console.log('test_metadata_clean: OK');
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node tests/test_metadata_clean.cjs`
Expected: FAIL — `Cannot find module '../static/metadata-clean.js'`.

- [ ] **Step 3: Write the minimal implementation**

```js
// static/metadata-clean.js
/**
 * Pure title/artist cleanup for the paste-fallback + video-picker ranking.
 * - Splits "Artist - Title" on several dash variants (and prefers that split
 *   over the uploader/channel, fixing the "channel-as-artist" bug).
 * - Removes a DENYLIST of known junk tokens from titles. Never blanket-strips
 *   parentheses, so legitimate titles like "(I Can't Get No) Satisfaction" survive.
 */
var SEPARATORS = [' - ', ' – ', ' — ', ' -', '- ', '–', '—', ' | ', ' : '];

// Parenthetical/bracketed junk: (official audio), [official music video], (lyrics)…
var NOISE_PAREN = /[\(\[]\s*(?:official\s*)?(?:music\s*)?(?:audio|video|lyric|lyrics|lyric video|visualizer|visualiser|hd|hq|4k|explicit|clean|remaster(?:ed)?(?:\s*\d{2,4})?|audio only)\s*[\)\]]/gi;
// Trailing "ft./feat. ..." to end of string (only when not inside the core title).
var NOISE_FEAT = /\s*[\(\[]?\s*(?:ft\.?|feat\.?)\s+[^\)\]]*[\)\]]?\s*$/i;

function stripNoise(title) {
    var t = String(title || '');
    t = t.replace(NOISE_PAREN, ' ');
    t = t.replace(NOISE_FEAT, ' ');
    return t.replace(/\s{2,}/g, ' ').trim();
}

function splitArtistTitle(title) {
    var t = String(title || '');
    for (var i = 0; i < SEPARATORS.length; i++) {
        var idx = t.indexOf(SEPARATORS[i]);
        if (idx > 0 && idx < t.length - SEPARATORS[i].length) {
            return { artist: t.slice(0, idx).trim(), title: t.slice(idx + SEPARATORS[i].length).trim() };
        }
    }
    return null;
}

function cleanChannel(author) {
    return String(author || '').replace(/\s*-\s*topic\s*$/i, '').replace(/\s*vevo\s*$/i, '').trim();
}

function cleanMetadata(rawTitle, rawAuthor) {
    var split = splitArtistTitle(rawTitle);
    if (split) return { artist: split.artist, title: stripNoise(split.title) };
    return { artist: cleanChannel(rawAuthor), title: stripNoise(rawTitle) };
}

var KaraokeeMetadataClean = { cleanMetadata: cleanMetadata, stripNoise: stripNoise, splitArtistTitle: splitArtistTitle, cleanChannel: cleanChannel };
if (typeof window !== 'undefined') window.KaraokeeMetadataClean = KaraokeeMetadataClean;
if (typeof module !== 'undefined' && module.exports) module.exports = KaraokeeMetadataClean;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node tests/test_metadata_clean.cjs`
Expected: `test_metadata_clean: OK`. If a `stripNoise` case fails, adjust the denylist regex — do **not** loosen it to a blanket `\(.*\)` strip.

- [ ] **Step 5: Commit**

```bash
git add static/metadata-clean.js tests/test_metadata_clean.cjs
git commit -m "feat(search): add metadata-clean helper (multi-separator + targeted noise denylist)"
```

### Task 2: Wire `youtube-meta.js` to use the cleaner

`parseTitleArtist` in `static/youtube-meta.js:19-27` is the buggy split. Replace its body with a delegation to `cleanMetadata` so the paste path inherits the fix.

**Files:**
- Modify: `static/youtube-meta.js:19-27` (the `parseTitleArtist` function) and the `<script>` load order note below
- Test: `tests/test_youtube_meta.cjs` (create if absent; otherwise extend)

- [ ] **Step 1: Write/extend the failing test**

```js
// tests/test_youtube_meta.cjs
const assert = require('assert');
const meta = require('../static/youtube-meta.js');

// videoIdFromUrl unchanged — keep a smoke check
assert.strictEqual(meta.videoIdFromUrl('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');

// parseTitleArtist now fixes the en-dash channel-as-artist bug
let r = meta.parseTitleArtist('Rick Astley – Never Gonna Give You Up', 'CookieMonsta53');
assert.strictEqual(r.artist, 'Rick Astley');
assert.strictEqual(r.title, 'Never Gonna Give You Up');

// and strips noise
r = meta.parseTitleArtist('Special Ed - I Got It Made (Official Audio)', 'X');
assert.strictEqual(r.artist, 'Special Ed');
assert.strictEqual(r.title, 'I Got It Made');

console.log('test_youtube_meta: OK');
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node tests/test_youtube_meta.cjs`
Expected: FAIL — current `parseTitleArtist` returns `artist: 'CookieMonsta53'` for the en-dash case.

- [ ] **Step 3: Edit `youtube-meta.js`**

Replace the `parseTitleArtist` function (lines 19-27) with:

```js
function parseTitleArtist(title, author) {
    // Delegate to the shared cleaner so the paste path gets multi-separator
    // handling + targeted noise removal. (UMD: require in Node, global in browser.)
    var clean = (typeof require !== 'undefined')
        ? require('./metadata-clean.js')
        : (typeof window !== 'undefined' ? window.KaraokeeMetadataClean : null);
    if (clean && clean.cleanMetadata) return clean.cleanMetadata(title, author);
    // Fallback (helper missing): original behavior.
    var t = String(title || '');
    var cleanAuthor = String(author || '').replace(/\s*-\s*topic\s*$/i, '').trim();
    var idx = t.indexOf(' - ');
    if (idx !== -1) return { artist: t.slice(0, idx).trim(), title: t.slice(idx + 3).trim() };
    return { artist: cleanAuthor, title: t.trim() };
}
```

- [ ] **Step 4: Add the script tag so the browser loads the cleaner first**

In `static/index.html`, add **before** the `youtube-meta.js` script tag (currently index.html:64):

```html
    <script src="/static/metadata-clean.js"></script>
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node tests/test_youtube_meta.cjs && node tests/test_metadata_clean.cjs`
Expected: both print `: OK`.

- [ ] **Step 6: Commit**

```bash
git add static/youtube-meta.js static/index.html tests/test_youtube_meta.cjs
git commit -m "fix(search): parse title/artist via metadata-clean (kills channel-as-artist bug)"
```

---

## Phase 2 — lrclib song search (expose the result list)

### Task 3: `searchSongs()` in `lyrics-client.js`

Add a function that returns the **ranked list** of synced-lyric songs for a free-text query (the thing `fetchLyrics` currently throws away). Each result carries its already-parsed lyrics, so picking a song needs no second lyrics call.

**Files:**
- Modify: `static/lyrics-client.js` (add `searchSongs`; reuse existing `parseLrc` / `scoreCandidate`)
- Test: `tests/test_lyrics_search.cjs`

- [ ] **Step 1: Write the failing test**

```js
// tests/test_lyrics_search.cjs
const assert = require('assert');
const client = require('../static/lyrics-client.js');

// Fake fetch returning two lrclib hits (one synced, one not) + a junk row
function fakeFetch(rows) {
    return async function () {
        return { ok: true, json: async () => rows };
    };
}

(async () => {
    const rows = [
        { trackName: 'I Got It Made', artistName: 'Special Ed', duration: 211,
          syncedLyrics: '[00:12.00] line one\n[00:15.00] line two' },
        { trackName: 'I Got It Made (Live)', artistName: 'Special Ed', duration: 250,
          syncedLyrics: '' }, // no synced lyrics -> excluded
        { trackName: 'Other', artistName: 'Nobody', duration: 100,
          syncedLyrics: '[00:01.00] x' },
    ];
    const out = await client.searchSongs('i got it made special ed', { fetch: fakeFetch(rows) });

    // only synced rows survive; best match (token overlap) is first
    assert.strictEqual(out.length, 2, 'unsynced rows excluded');
    assert.strictEqual(out[0].trackName, 'I Got It Made');
    assert.strictEqual(out[0].artistName, 'Special Ed');
    assert.strictEqual(out[0].duration, 211);
    assert.ok(Array.isArray(out[0].lyrics) && out[0].lyrics.length === 2, 'lyrics pre-parsed');
    assert.strictEqual(out[0].lyrics[0].time, 12);

    // empty query -> empty list, no fetch crash
    const none = await client.searchSongs('', { fetch: fakeFetch([]) });
    assert.deepStrictEqual(none, []);

    console.log('test_lyrics_search: OK');
})();
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node tests/test_lyrics_search.cjs`
Expected: FAIL — `client.searchSongs is not a function`.

- [ ] **Step 3: Add `searchSongs` to `lyrics-client.js`**

Insert this function just before the `var KaraokeeLyricsClient = {...}` line, and add `searchSongs` to that export object:

```js
async function searchSongs(query, deps) {
    var q = String(query || '').trim();
    if (!q) return [];
    var doFetch = (deps && deps.fetch) || (typeof fetch !== 'undefined' ? fetch : null);
    if (!doFetch) throw new Error('searchSongs requires a fetch implementation');
    var url = LRCLIB_SEARCH_URL + '?q=' + encodeURIComponent(q);

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

    var out = [];
    for (var i = 0; i < results.length; i++) {
        var row = results[i];
        if (!row || !row.syncedLyrics) continue;          // synced only — guarantees singable
        var lyrics = parseLrc(row.syncedLyrics);
        if (!lyrics.length) continue;
        out.push({
            trackName: row.trackName || '',
            artistName: row.artistName || '',
            duration: row.duration || 0,
            // rank against the user's free-text query so the best match floats up
            _score: scoreCandidate(row, q, q, 0),
            lyrics: lyrics,
        });
    }
    out.sort(function (a, b) { return b._score - a._score; });
    return out;
}
```

Then change the export line to include it:

```js
var KaraokeeLyricsClient = { parseLrc: parseLrc, tokenOverlap: tokenOverlap, scoreCandidate: scoreCandidate, fetchLyrics: fetchLyrics, searchSongs: searchSongs };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node tests/test_lyrics_search.cjs`
Expected: `test_lyrics_search: OK`.

- [ ] **Step 5: Run the existing lyrics test to confirm no regression**

Run: `node tests/test_lyrics_client.cjs` (if present)
Expected: still passes. If that filename differs, run the lyrics-related `.cjs` that already exists.

- [ ] **Step 6: Commit**

```bash
git add static/lyrics-client.js tests/test_lyrics_search.cjs
git commit -m "feat(search): searchSongs() returns ranked synced-lyric candidates from lrclib"
```

---

## Phase 3 — The resolver Worker (standalone, deploy-type-agnostic)

### Task 4: `rank.js` — pure ranking + ISO-8601 duration parse

The brains of the picker, isolated and fully tested. The Worker (Task 5) imports it; the test requires it.

**Files:**
- Create: `workers/resolve/rank.js`
- Test: `tests/test_resolve_rank.cjs`

- [ ] **Step 1: Write the failing test**

```js
// tests/test_resolve_rank.cjs
const assert = require('assert');
const { rankCandidates, parseIsoDuration } = require('../workers/resolve/rank.js');

// ISO 8601 -> seconds
assert.strictEqual(parseIsoDuration('PT3M31S'), 211);
assert.strictEqual(parseIsoDuration('PT1H2M3S'), 3723);
assert.strictEqual(parseIsoDuration('PT45S'), 45);
assert.strictEqual(parseIsoDuration(''), 0);

const target = { artist: 'Special Ed', title: 'I Got It Made', durationSec: 211 };
const cands = [
    { videoId: 'loop', title: 'I Got It Made [1 HOUR LOOP]', channelTitle: 'Loops', durationSec: 3600 },
    { videoId: 'right', title: 'I Got It Made', channelTitle: 'Special Ed - Topic', durationSec: 212 },
    { videoId: 'live', title: 'I Got It Made (Live)', channelTitle: 'Concerts', durationSec: 240 },
    { videoId: 'reup', title: 'Special Ed - I Got It Made', channelTitle: 'CookieMonsta53', durationSec: 209 },
];
const ranked = rankCandidates(cands, target);

assert.strictEqual(ranked[0].videoId, 'right', 'Topic channel + exact duration wins');
assert.strictEqual(ranked[ranked.length - 1].videoId, 'loop', 'hour-long loop sinks');
assert.ok(ranked.findIndex(c => c.videoId === 'live') > ranked.findIndex(c => c.videoId === 'right'),
    'live is penalized below the studio match');

console.log('test_resolve_rank: OK');
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node tests/test_resolve_rank.cjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `rank.js`**

```js
// workers/resolve/rank.js
// Pure ranking for resolved YouTube candidates. CommonJS so the .cjs test can
// require() it; wrangler/esbuild bundles it into the ES-module Worker fine.
var JUNK = /\b(live|remix|sped\s*up|nightcore|cover|instrumental|karaoke|8d|reverb|slowed|loop|1\s*hour|one\s*hour|reaction|tutorial)\b/i;

function parseIsoDuration(iso) {
    var m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(String(iso || ''));
    if (!m) return 0;
    return (parseInt(m[1] || 0, 10) * 3600) + (parseInt(m[2] || 0, 10) * 60) + parseInt(m[3] || 0, 10);
}

function scoreCandidate(c, target) {
    var score = 0;
    var dur = c.durationSec || 0;
    var want = target.durationSec || 0;
    if (want && dur) {
        var diff = Math.abs(dur - want);
        if (diff <= 3) score += 50;
        else if (diff <= 8) score += 35;
        else if (diff <= 20) score += 15;
        else score -= Math.min(40, diff); // far-off lengths (loops, edits) sink hard
    }
    var ch = String(c.channelTitle || '');
    if (/-\s*topic$/i.test(ch)) score += 25;
    else if (/vevo$/i.test(ch)) score += 20;
    else if (target.artist && ch.toLowerCase().indexOf(String(target.artist).toLowerCase()) !== -1) score += 15;

    // Penalize junk in the title UNLESS the user's target itself asked for it.
    if (JUNK.test(c.title || '') && !JUNK.test(target.title || '')) score -= 30;
    return score;
}

function rankCandidates(candidates, target) {
    var arr = (candidates || []).map(function (c) {
        return Object.assign({}, c, { _score: scoreCandidate(c, target) });
    });
    arr.sort(function (a, b) { return b._score - a._score; });
    return arr;
}

module.exports = { rankCandidates: rankCandidates, scoreCandidate: scoreCandidate, parseIsoDuration: parseIsoDuration };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node tests/test_resolve_rank.cjs`
Expected: `test_resolve_rank: OK`.

- [ ] **Step 5: Commit**

```bash
git add workers/resolve/rank.js tests/test_resolve_rank.cjs
git commit -m "feat(resolve): pure ranking + ISO-8601 duration parse for the video picker"
```

### Task 5: The resolver Worker (`/api/resolve`)

A standalone Worker: takes `?artist=&title=&duration=`, calls YouTube `search.list` (embeddable videos) + `videos.list` (durations), ranks with `rank.js`, returns the top 3 as JSON with CORS. The API key is a `wrangler secret`, never shipped to the browser.

**Files:**
- Create: `workers/resolve/index.js`
- Create: `workers/resolve/wrangler.toml`
- Create: `workers/resolve/.dev.vars` (gitignored — never committed)
- Modify: `.gitignore` (add the dev-vars rule)
- Test: `tests/test_resolve_worker.cjs` (handler with injected `fetch`)

- [ ] **Step 1: Make the handler testable by extracting a pure-ish core, then write the failing test**

```js
// tests/test_resolve_worker.cjs
const assert = require('assert');
const { resolveVideos } = require('../workers/resolve/index.js');

// Fake YouTube API: first call = search.list, second = videos.list
function fakeYouTube() {
    let call = 0;
    return async function (url) {
        call++;
        if (url.includes('/search?') || url.includes('/search&') || url.includes('youtube/v3/search')) {
            return { ok: true, json: async () => ({ items: [
                { id: { videoId: 'right' }, snippet: { title: 'I Got It Made', channelTitle: 'Special Ed - Topic' } },
                { id: { videoId: 'loop' },  snippet: { title: 'I Got It Made 1 HOUR LOOP', channelTitle: 'Loops' } },
            ] }) };
        }
        return { ok: true, json: async () => ({ items: [
            { id: 'right', contentDetails: { duration: 'PT3M32S' } }, // 212s
            { id: 'loop',  contentDetails: { duration: 'PT1H0M0S' } },
        ] }) };
    };
}

(async () => {
    const out = await resolveVideos(
        { artist: 'Special Ed', title: 'I Got It Made', duration: 211 },
        { fetch: fakeYouTube(), apiKey: 'TEST_KEY' }
    );
    assert.ok(Array.isArray(out) && out.length >= 1);
    assert.strictEqual(out[0].videoId, 'right', 'best match first');
    assert.ok(out[0].durationSec === 212);
    assert.ok(out.length <= 3, 'top 3 only');

    // missing params -> empty (caller turns this into a 400)
    const empty = await resolveVideos({ artist: '', title: '' }, { fetch: fakeYouTube(), apiKey: 'K' });
    assert.deepStrictEqual(empty, []);
    console.log('test_resolve_worker: OK');
})();
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node tests/test_resolve_worker.cjs`
Expected: FAIL — module not found / `resolveVideos` undefined.

- [ ] **Step 3: Write the Worker**

```js
// workers/resolve/index.js
import { rankCandidates, parseIsoDuration } from './rank.js';

var YT_SEARCH = 'https://www.googleapis.com/youtube/v3/search';
var YT_VIDEOS = 'https://www.googleapis.com/youtube/v3/videos';

// Core logic, fetch + key injected so it is unit-testable (see test_resolve_worker.cjs).
export async function resolveVideos(params, deps) {
    var artist = String(params.artist || '').trim();
    var title = String(params.title || '').trim();
    var durationSec = parseInt(params.duration || 0, 10) || 0;
    if (!artist && !title) return [];

    var doFetch = deps.fetch;
    var key = deps.apiKey;
    var q = (artist + ' ' + title).trim();

    var searchUrl = YT_SEARCH + '?part=snippet&type=video&videoEmbeddable=true&maxResults=8'
        + '&q=' + encodeURIComponent(q) + '&key=' + encodeURIComponent(key);
    var sResp = await doFetch(searchUrl);
    if (!sResp.ok) return [];
    var sData = await sResp.json();
    var items = (sData && sData.items) || [];
    var bald = items
        .filter(function (it) { return it && it.id && it.id.videoId; })
        .map(function (it) {
            return {
                videoId: it.id.videoId,
                title: (it.snippet && it.snippet.title) || '',
                channelTitle: (it.snippet && it.snippet.channelTitle) || '',
                thumbnail: it.snippet && it.snippet.thumbnails && it.snippet.thumbnails.medium
                    && it.snippet.thumbnails.medium.url || '',
            };
        });
    if (!bald.length) return [];

    // One cheap videos.list (1 unit) for durations.
    var ids = bald.map(function (c) { return c.videoId; }).join(',');
    var vUrl = YT_VIDEOS + '?part=contentDetails&id=' + encodeURIComponent(ids) + '&key=' + encodeURIComponent(key);
    var vResp = await doFetch(vUrl);
    if (vResp.ok) {
        var vData = await vResp.json();
        var byId = {};
        ((vData && vData.items) || []).forEach(function (v) {
            byId[v.id] = parseIsoDuration(v.contentDetails && v.contentDetails.duration);
        });
        bald.forEach(function (c) { c.durationSec = byId[c.videoId] || 0; });
    }

    var ranked = rankCandidates(bald, { artist: artist, title: title, durationSec: durationSec });
    return ranked.slice(0, 3).map(function (c) {
        return { videoId: c.videoId, title: c.title, channelTitle: c.channelTitle,
                 durationSec: c.durationSec || 0, thumbnail: c.thumbnail || '' };
    });
}

function cors(resp) {
    resp.headers.set('Access-Control-Allow-Origin', '*');
    resp.headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    return resp;
}

export default {
    async fetch(request, env) {
        if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
        var url = new URL(request.url);
        if (url.pathname !== '/api/resolve') return cors(new Response('Not found', { status: 404 }));

        var params = {
            artist: url.searchParams.get('artist') || '',
            title: url.searchParams.get('title') || '',
            duration: url.searchParams.get('duration') || '0',
        };
        if (!params.artist && !params.title) {
            return cors(Response.json({ error: 'artist or title required' }, { status: 400 }));
        }
        try {
            var candidates = await resolveVideos(params, { fetch: fetch, apiKey: env.YOUTUBE_API_KEY });
            return cors(Response.json({ candidates: candidates }));
        } catch (e) {
            return cors(Response.json({ error: 'resolve failed', candidates: [] }, { status: 502 }));
        }
    },
};
```

- [ ] **Step 4: Write the Worker config and dev-secret files**

```toml
# workers/resolve/wrangler.toml
name = "vocalz-resolve"
main = "index.js"
compatibility_date = "2026-06-23"
```

```dotenv
# workers/resolve/.dev.vars   (LOCAL ONLY — never commit)
YOUTUBE_API_KEY="paste-your-dev-key-here"
```

Add to `.gitignore` (create the line if the file lacks it):

```gitignore
workers/resolve/.dev.vars
.dev.vars
```

- [ ] **Step 5: Run the handler test to verify it passes**

Run: `node tests/test_resolve_worker.cjs`
Expected: `test_resolve_worker: OK`.

> Note: the `.cjs` test `require()`s `index.js`, which uses ESM `import`/`export`. Node will refuse to `require` an ESM file. To keep the unit test simple, put the pure core (`resolveVideos`, and the `import` of rank) in a sibling **`core.cjs`** instead and have `index.js` re-export it. If you prefer not to split: change the test to import via dynamic `import()` and run with `node --experimental-vm-modules`. **Recommended:** the split below — it keeps the test a plain `.cjs`.

- [ ] **Step 5a: Split core out for clean testing (do this if Step 5 errored on ESM/CJS)**

Create `workers/resolve/core.cjs`:
```js
const { rankCandidates, parseIsoDuration } = require('./rank.js');
async function resolveVideos(params, deps) { /* …exact body from Step 3 resolveVideos… */ }
module.exports = { resolveVideos };
```
Change `index.js` to: `import core from './core.cjs';` then call `core.resolveVideos(...)` in `fetch`, and delete the inline `resolveVideos`/rank import from `index.js`. Update the test's require to `../workers/resolve/core.cjs`. Re-run: `node tests/test_resolve_worker.cjs` → `OK`.

- [ ] **Step 6: Manual smoke test against the real API (one-time, needs a key)**

Get a key: Google Cloud Console → new project → "APIs & Services" → enable **YouTube Data API v3** → Credentials → **Create API key**. Paste it into `workers/resolve/.dev.vars`.

Run locally and curl it:
```bash
cd workers/resolve
npx wrangler dev
# in another shell:
curl "http://localhost:8787/api/resolve?artist=Special%20Ed&title=I%20Got%20It%20Made&duration=211"
```
Expected: JSON `{ "candidates": [ { "videoId": "...", "durationSec": ~211, ... }, ... ] }` with the studio version first. If you get `403`/`quotaExceeded`, the key works but quota is gated; if `400 keyInvalid`, recheck the key/API enablement.

- [ ] **Step 7: Commit**

```bash
git add workers/resolve/index.js workers/resolve/rank.js workers/resolve/wrangler.toml .gitignore tests/test_resolve_worker.cjs
# NOTE: do NOT add .dev.vars
git commit -m "feat(resolve): standalone vocalz-resolve Worker (YouTube search+rank, key server-side)"
```

- [ ] **Step 8: Deploy the Worker + set the production secret (one-time)**

```bash
cd workers/resolve
npx wrangler deploy
npx wrangler secret put YOUTUBE_API_KEY   # paste the key when prompted (stored encrypted, server-side)
```
Note the deployed URL it prints (e.g. `https://vocalz-resolve.<your-subdomain>.workers.dev`). You'll paste it into Task 7.

---

## Phase 4 — Search UI + smart picker (index.html)

> These tasks touch `index.html` DOM wiring, which has no automated harness. Each ends with a **manual verification checklist** run against `python app.py` (or `npx wrangler dev`). Keep the existing paste flow intact until Task 8 demotes it.

### Task 6: Search box + lrclib song results

**Files:**
- Modify: `static/index.html` (markup in the `.card`, a new script block, and the script-load list)

- [ ] **Step 1: Add the search markup** at the top of `.card`, directly under the `<h1 class="wordmark">` (index.html:23):

```html
        <label for="songSearch">Search for a song</label>
        <input type="text" id="songSearch" placeholder="e.g. Special Ed I Got It Made" autofocus autocomplete="off" />
        <button id="searchBtn" onclick="runSearch()">Search</button>
        <div id="searchStatus"></div>
        <div id="songResults" class="search-results" style="display:none"></div>
```

- [ ] **Step 2: Demote the old paste block** — wrap the existing `label[for=url]` + `#url` input + `#loadBtn` (index.html:30-40) in a hidden container so Task 8 can reveal it on failure:

```html
        <div id="pasteFallback" style="display:none">
          <!-- existing URL label/input/Load button stay here, unchanged -->
        </div>
```

- [ ] **Step 3: Add the search script** (new `<script>` block near the bottom inline script). Render results into the existing CSS classes:

```html
<script>
async function runSearch() {
    var q = document.getElementById('songSearch').value.trim();
    var status = document.getElementById('searchStatus');
    var box = document.getElementById('songResults');
    if (!q) { status.textContent = 'Type a song to search.'; status.className = 'error'; return; }
    status.textContent = 'Searching…'; status.className = '';
    box.style.display = 'none'; box.innerHTML = '';

    var songs = [];
    try { songs = await KaraokeeLyricsClient.searchSongs(q); }
    catch (e) { songs = []; }

    if (!songs.length) {
        status.textContent = 'No songs found for "' + q + '".';
        status.className = 'error';
        revealPasteFallback();   // defined in Task 8
        return;
    }
    status.textContent = '';
    window._lastSongResults = songs;            // stash for pickSong()
    renderSongResults(songs);
}

function renderSongResults(songs) {
    var box = document.getElementById('songResults');
    box.innerHTML = '';
    songs.slice(0, 8).forEach(function (s, i) {
        var div = document.createElement('div');
        div.className = 'search-result-item';
        div.onclick = function () { pickSong(i); };
        var mins = Math.floor((s.duration || 0) / 60), secs = ('0' + ((s.duration || 0) % 60)).slice(-2);
        div.innerHTML = '<div class="search-result-title"></div><div class="search-result-meta"></div>';
        div.querySelector('.search-result-title').textContent = s.trackName;
        div.querySelector('.search-result-meta').textContent = s.artistName + ' · ' + mins + ':' + secs;
        box.appendChild(div);
    });
    box.style.display = 'block';
}
</script>
```

- [ ] **Step 4: Enter-to-search** — the page already has a global Enter handler (index.html:197). Update its guard so Enter in `#songSearch` triggers `runSearch()` instead of `loadSong()`:

```js
document.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    if (e.target && e.target.closest && e.target.closest('.byok')) return;
    if (e.target && e.target.id === 'songSearch') { runSearch(); return; }
    if (e.target && e.target.id === 'url') { loadSong(); return; }
});
```

- [ ] **Step 5: Manual verification**

Run: `python app.py`, open `http://localhost:5000`.
Checklist:
- The search box is focused on load; typing a song + Enter (or Search) shows a list.
- Results show track title + "Artist · m:ss".
- A nonsense query shows "No songs found" and reveals the paste box (after Task 8).

- [ ] **Step 6: Commit**

```bash
git add static/index.html
git commit -m "feat(search): in-app song search box + lrclib result list on the home page"
```

### Task 7: Smart video picker (calls the resolver)

**Files:**
- Modify: `static/index.html` (add `pickSong`, `renderVideoPicker`, `pickVideo`, and a `RESOLVE_URL` constant)

- [ ] **Step 1: Add the resolver URL constant** near the top of the inline script (use the URL from Task 5 Step 8):

```js
var RESOLVE_URL = 'https://vocalz-resolve.<your-subdomain>.workers.dev/api/resolve';
```

- [ ] **Step 2: Add the pick + picker functions**

```js
async function pickSong(i) {
    var song = window._lastSongResults[i];
    var status = document.getElementById('searchStatus');
    status.textContent = 'Finding the video…'; status.className = '';
    document.getElementById('songResults').style.display = 'none';

    var candidates = [];
    try {
        var u = RESOLVE_URL + '?artist=' + encodeURIComponent(song.artistName)
              + '&title=' + encodeURIComponent(song.trackName)
              + '&duration=' + encodeURIComponent(song.duration || 0);
        var resp = await fetch(u);
        var data = await resp.json();
        candidates = (data && data.candidates) || [];
    } catch (e) { candidates = []; }

    if (!candidates.length) {
        status.textContent = 'Couldn’t find a playable video for "' + song.trackName + '".';
        status.className = 'error';
        revealPasteFallback(song);   // pre-fills artist/title (Task 8)
        return;
    }
    status.textContent = '';
    renderVideoPicker(candidates, song);
}

function renderVideoPicker(candidates, song) {
    var box = document.getElementById('songResults');
    box.innerHTML = '<div class="search-result-meta" style="padding:6px 12px">Pick the right version:</div>';
    candidates.forEach(function (c, idx) {
        var div = document.createElement('div');
        div.className = 'search-result-item' + (idx === 0 ? ' is-best' : '');
        div.onclick = function () { pickVideo(c.videoId, song); };
        var mins = Math.floor((c.durationSec || 0) / 60), secs = ('0' + ((c.durationSec || 0) % 60)).slice(-2);
        div.innerHTML = '<div class="search-result-title"></div><div class="search-result-meta"></div>';
        div.querySelector('.search-result-title').textContent = c.title + (idx === 0 ? '  ✓' : '');
        div.querySelector('.search-result-meta').textContent = c.channelTitle + ' · ' + mins + ':' + secs;
        box.appendChild(div);
    });
    box.style.display = 'block';
}

function pickVideo(videoId, song) {
    var data = { videoId: videoId, artist: song.artistName, title: song.trackName, lyrics: song.lyrics };
    sessionStorage.setItem('songData', JSON.stringify(data));
    window.location.href = '/player';
}
```

- [ ] **Step 3: (Optional) highlight the best pick** — add to `style.css`:

```css
.search-result-item.is-best { background: var(--surface-3); }
```

- [ ] **Step 4: Manual verification**

Run the app (and `npx wrangler dev` in `workers/resolve/`, pointing `RESOLVE_URL` at `http://localhost:8787/api/resolve` for local testing). Search → pick a song → the picker lists 2–3 videos, best first with a ✓ → picking one loads `/player` and the song plays with synced lyrics. Verify with "Special Ed — I Got It Made" that the studio version is on top.

- [ ] **Step 5: Commit**

```bash
git add static/index.html static/style.css
git commit -m "feat(search): smart video picker wired to the resolver Worker"
```

### Task 8: Paste fallback, revealed only on failure

**Files:**
- Modify: `static/index.html` (`revealPasteFallback`, and ensure `loadSong` still works inside `#pasteFallback`)

- [ ] **Step 1: Add the reveal function**

```js
function revealPasteFallback(song) {
    var fb = document.getElementById('pasteFallback');
    if (fb) fb.style.display = 'block';
    // If we already know the song (resolver miss), pre-fill artist/title so the
    // user only needs to supply a link; the cleaned metadata parse handles the rest.
    if (song) {
        var a = document.getElementById('artist'), t = document.getElementById('title');
        if (a) a.value = song.artistName || '';
        if (t) t.value = song.trackName || '';
    }
    var label = document.createElement('div');
    label.className = 'search-result-meta';
    label.style.cssText = 'margin:8px 0 4px';
    label.textContent = 'Can’t find it? Paste a YouTube link instead:';
    var fbParent = document.getElementById('pasteFallback');
    if (fbParent && !document.getElementById('pasteHint')) { label.id = 'pasteHint'; fbParent.prepend(label); }
}
```

- [ ] **Step 2: Confirm the `pageshow` reset re-hides the fallback** — extend the existing `pageshow` handler (index.html:214) so returning to a clean menu hides the paste box again:

```js
var fb = document.getElementById('pasteFallback'); if (fb) fb.style.display = 'none';
var box = document.getElementById('songResults'); if (box) { box.style.display = 'none'; box.innerHTML = ''; }
var ss = document.getElementById('searchStatus'); if (ss) { ss.textContent = ''; ss.className = ''; }
```

- [ ] **Step 3: Manual verification**

- Fresh load: no paste box visible (only search).
- Search nonsense → "No songs found" → paste box appears → paste a real URL → loads (proving the cleaned-metadata path: try a known en-dash/`(Official Audio)` title and confirm the lyrics resolve without manual trimming).
- Pick a song whose videos don't resolve (simulate by temporarily pointing `RESOLVE_URL` at a bad path) → paste box appears pre-filled with artist/title.
- Browser Back to the menu → paste box hidden again.

- [ ] **Step 4: Commit**

```bash
git add static/index.html
git commit -m "feat(search): reveal paste fallback only on search/resolve failure (pre-filled)"
```

---

## Phase 5 — Curated starter row

### Task 9: "Popular picks" row of verified songs

A hand-picked, static list with **pinned `videoId`s** (you have personally confirmed each plays + has synced lyrics). One tap → fetch lyrics → play. No resolver call (the video is pre-verified).

**Files:**
- Modify: `static/index.html` (markup + `renderStarterRow` + `playStarter`)

- [ ] **Step 1: Add the markup** under `#songResults`:

```html
        <div id="starterRow">
          <div class="search-divider">Popular picks</div>
          <div id="starterList" class="search-results"></div>
        </div>
```

- [ ] **Step 2: Add the list + handlers.** Replace the placeholder entries with songs you've verified (the `videoId` is the part after `v=` in the YouTube URL):

```js
var STARTER_SONGS = [
    { videoId: 'REPLACE_ME', artist: 'Special Ed', title: 'I Got It Made' },
    { videoId: 'REPLACE_ME', artist: 'Rick Astley', title: 'Never Gonna Give You Up' },
    // …6–10 total, spanning eras/genres. VERIFY each plays + has lrclib synced lyrics.
];

function renderStarterRow() {
    var list = document.getElementById('starterList');
    list.innerHTML = '';
    STARTER_SONGS.forEach(function (s, i) {
        var div = document.createElement('div');
        div.className = 'search-result-item';
        div.onclick = function () { playStarter(i); };
        div.innerHTML = '<div class="search-result-title"></div><div class="search-result-meta"></div>';
        div.querySelector('.search-result-title').textContent = s.title;
        div.querySelector('.search-result-meta').textContent = s.artist;
        list.appendChild(div);
    });
}

async function playStarter(i) {
    var s = STARTER_SONGS[i];
    var status = document.getElementById('searchStatus');
    status.textContent = 'Loading ' + s.title + '…'; status.className = '';
    var lyrics = [];
    try { lyrics = await KaraokeeLyricsClient.fetchLyrics({ title: s.title, artist: s.artist }); }
    catch (e) { lyrics = []; }
    if (!lyrics.length) { status.textContent = 'Lyrics unavailable right now — try search.'; status.className = 'error'; return; }
    sessionStorage.setItem('songData', JSON.stringify({ videoId: s.videoId, artist: s.artist, title: s.title, lyrics: lyrics }));
    window.location.href = '/player';
}

renderStarterRow();   // call on load
```

- [ ] **Step 3: Verify each starter song** — for every entry: open `https://youtube.com/watch?v=<videoId>`, confirm it's the right studio recording and embeddable, then load it in the app and confirm synced lyrics + playback. Replace any that fail.

- [ ] **Step 4: Manual verification**

Fresh load shows the "Popular picks" row; tapping one goes straight into the player with synced lyrics, no picker. Hide the row on dev/local only if desired (it's fine to show everywhere).

- [ ] **Step 5: Commit**

```bash
git add static/index.html
git commit -m "feat(search): curated 'Popular picks' starter row (pinned, verified videoIds)"
```

---

## Phase 6 — Full-suite check + finish

### Task 10: Run everything, update docs

- [ ] **Step 1: Run the entire JS suite**

```bash
for f in tests/test_metadata_clean.cjs tests/test_youtube_meta.cjs tests/test_lyrics_search.cjs tests/test_resolve_rank.cjs tests/test_resolve_worker.cjs; do node "$f"; done
```
Expected: each prints `: OK`. Also run the pre-existing `.cjs` suites to confirm no regressions.

- [ ] **Step 2: Run the Python suite** (the dev harness is untouched, but confirm green)

```bash
python -m pytest tests/test_app.py tests/test_downloader.py tests/test_lyrics.py -q
```

- [ ] **Step 3: Update `CLAUDE.md`** — add `metadata-clean.js` to the helper-module list, note `lyrics-client.searchSongs`, and add a short "In-app search" subsection under Frontend describing the lrclib-search → resolver-Worker → picker flow and the standalone `workers/resolve/` Worker.

- [ ] **Step 4: Update the deployment doc** — in `docs/operations/deployment.md`, add a line that search depends on the `vocalz-resolve` Worker + a `YOUTUBE_API_KEY` secret, deployed separately via `npx wrangler deploy`.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/operations/deployment.md
git commit -m "docs(search): document in-app search, searchSongs, and the resolve Worker"
```

- [ ] **Step 6: Deploy** — push the site (`git push`, auto-deploys per your Cloudflare git integration). The resolver Worker was already deployed in Task 5 Step 8; confirm `RESOLVE_URL` in `index.html` points at the **deployed** Worker URL (not localhost) before pushing.

---

## Self-review checklist (run before handing off)

- [ ] **Spec coverage:** lyrics-first search (T3, T6) ✓ · resolver Worker w/ hidden key (T4, T5) ✓ · smart best-first picker (T4 rank, T7 UI) ✓ · curated starter row (T9) ✓ · paste fallback revealed only on failure (T8) ✓ · metadata cleaning, multi-separator + targeted denylist (T1, T2) ✓ · autofocus/Enter/loading/clear (T6) — autofocus ✓, Enter ✓, loading status ✓; **clear (✕) button is omitted for brevity — add if desired or drop (the page resets on `pageshow`).**
- [ ] **Type/name consistency:** `cleanMetadata`, `stripNoise`, `searchSongs`, `rankCandidates`, `parseIsoDuration`, `resolveVideos`, `renderSongResults`/`pickSong`/`renderVideoPicker`/`pickVideo`/`revealPasteFallback`/`renderStarterRow`/`playStarter` — used consistently across tasks.
- [ ] **No placeholders left in code** except the **intentional** `REPLACE_ME` starter `videoId`s and `<your-subdomain>` in `RESOLVE_URL`, both of which require your real values (called out in T7/T9).
- [ ] **Out of scope (confirm not started):** type-ahead, recents, trending, Safari/paid-ASR, leaderboards, pitch. Mic Check is a **separate plan**.
```
