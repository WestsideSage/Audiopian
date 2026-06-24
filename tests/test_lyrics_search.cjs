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

    const none = await client.searchSongs('', { fetch: fakeFetch([]) });
    assert.deepStrictEqual(none, []);
    console.log('test_lyrics_search: OK');
})();
