const assert = require('assert');
const client = require('../static/lyrics-client.js');

function fakeFetch(rows) {
    return async function () { return { ok: true, json: async () => rows }; };
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
    assert.strictEqual(out.length, 2, 'unsynced rows excluded');
    assert.strictEqual(out[0].trackName, 'I Got It Made');
    assert.strictEqual(out[0].artistName, 'Special Ed');
    assert.strictEqual(out[0].duration, 211);
    assert.ok(Array.isArray(out[0].lyrics) && out[0].lyrics.length === 2, 'lyrics pre-parsed');
    assert.strictEqual(out[0].lyrics[0].time, 12);

    // --- dedup: the same song re-listed under remaster/album variants collapses to one row,
    //     but a different-artist cover stays distinct ---
    const dupRows = [
        { trackName: 'Never Gonna Give You Up', artistName: 'Rick Astley', duration: 213, syncedLyrics: '[00:18.00] never' },
        { trackName: 'Never Gonna Give You Up (2022 Remaster)', artistName: 'Rick Astley', duration: 214, syncedLyrics: '[00:18.00] never' },
        { trackName: 'Never Gonna Give You Up', artistName: 'Reinaeiry', duration: 200, syncedLyrics: '[00:18.00] never' },
    ];
    const dd = await client.searchSongs('never gonna give you up', { fetch: fakeFetch(dupRows) });
    assert.strictEqual(dd.filter(s => s.artistName === 'Rick Astley').length, 1, 'remaster collapses into the base Rick Astley entry');
    assert.ok(dd.some(s => s.artistName === 'Reinaeiry'), 'a different-artist cover stays distinct');
    assert.strictEqual(dd.length, 2, 'two distinct songs after dedup');

    const ded = client.dedupeSongs([
        { trackName: 'X', artistName: 'A', _score: 5 },
        { trackName: 'X (Live)', artistName: 'A', _score: 4 },
        { trackName: 'X', artistName: 'B', _score: 3 },
    ]);
    assert.strictEqual(ded.length, 2, 'dedupeSongs collapses A/X variants, keeps B/X');

    const none = await client.searchSongs('', { fetch: fakeFetch([]) });
    assert.deepStrictEqual(none, []);
    console.log('test_lyrics_search: OK');
})();
