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
            _score: scoreCandidate(row, q, q, 0),
            lyrics: lyrics,
        });
    }
    out.sort(function (a, b) { return b._score - a._score; });
    return dedupeSongs(out);
}

// Collapse near-duplicate entries — the same song re-listed under many albums / remasters /
// re-uploads — so the user sees DISTINCT songs (differentiated by artist), not 8 rows of the
// same one. Keeps the highest-scored entry per (artist + base-title), preserving rank order.
function dedupeSongs(list) {
    var seen = {}, out = [];
    for (var i = 0; i < list.length; i++) {
        var s = list[i];
        var artist = String(s.artistName || '').toLowerCase().replace(/\s+/g, ' ').trim();
        var title = String(s.trackName || '').toLowerCase()
            .replace(/[\(\[][^\)\]]*[\)\]]/g, '')   // drop "(Remaster)", "[Live]", "(feat …)" for grouping
            .replace(/\s+/g, ' ').trim();
        var key = artist + '|' + title;
        if (seen[key]) continue;
        seen[key] = true;
        out.push(s);
    }
    return out;
}

var KaraokeeLyricsClient = { parseLrc: parseLrc, tokenOverlap: tokenOverlap, scoreCandidate: scoreCandidate, fetchLyrics: fetchLyrics, searchSongs: searchSongs, dedupeSongs: dedupeSongs };
if (typeof window !== 'undefined') window.KaraokeeLyricsClient = KaraokeeLyricsClient;
if (typeof module !== 'undefined' && module.exports) module.exports = KaraokeeLyricsClient;
