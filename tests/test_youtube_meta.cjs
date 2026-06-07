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
// YouTube "Topic" channels: strip the " - Topic" suffix from the channel name.
assert.deepStrictEqual(YM.parseTitleArtist('Silkk da Shocka', 'Isaiah Rashad - Topic'),
    { artist: 'Isaiah Rashad', title: 'Silkk da Shocka' });
assert.deepStrictEqual(YM.parseTitleArtist('Silkk da Shocka', 'Isaiah Rashad - Topic').artist, 'Isaiah Rashad');

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
