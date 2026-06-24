var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

// Load metadata-clean first (it's a dependency)
var cleanCode = fs.readFileSync(path.join(__dirname, '..', 'static', 'metadata-clean.js'), 'utf8');
var cleanModule = { exports: {} };
new Function('module', 'exports', cleanCode)(cleanModule, cleanModule.exports);

// Load youtube-meta with metadata-clean available in scope
var code = fs.readFileSync(path.join(__dirname, '..', 'static', 'youtube-meta.js'), 'utf8');
var fakeModule = { exports: {} };
// Make require work so youtube-meta can load metadata-clean
var mockRequire = function(dep) {
    if (dep === './metadata-clean.js') return cleanModule.exports;
    throw new Error('Unknown module: ' + dep);
};
new Function('module', 'exports', 'require', code)(fakeModule, fakeModule.exports, mockRequire);
var YM = fakeModule.exports;

// --- videoIdFromUrl ---
assert.strictEqual(YM.videoIdFromUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
assert.strictEqual(YM.videoIdFromUrl('https://youtu.be/dQw4w9WgXcQ?t=10'), 'dQw4w9WgXcQ');
assert.strictEqual(YM.videoIdFromUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
assert.strictEqual(YM.videoIdFromUrl('https://www.youtube.com/watch?list=x&v=dQw4w9WgXcQ&t=1'), 'dQw4w9WgXcQ');
assert.strictEqual(YM.videoIdFromUrl('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
assert.strictEqual(YM.videoIdFromUrl('https://example.com/not-youtube'), null);
assert.strictEqual(YM.videoIdFromUrl(''), null);

// --- parseTitleArtist (now delegates to cleanMetadata) ---
assert.deepStrictEqual(YM.parseTitleArtist('Black Moon - Who Got Da Props', 'SomeChannel'),
    { artist: 'Black Moon', title: 'Who Got Da Props' });
// cleanMetadata also removes VEVO suffix from channels (it's a label, not part of the artist name)
assert.deepStrictEqual(YM.parseTitleArtist('Just A Title', 'CoolArtistVEVO'),
    { artist: 'CoolArtist', title: 'Just A Title' });
// YouTube "Topic" channels: strip the " - Topic" suffix from the channel name.
assert.deepStrictEqual(YM.parseTitleArtist('Silkk da Shocka', 'Isaiah Rashad - Topic'),
    { artist: 'Isaiah Rashad', title: 'Silkk da Shocka' });
assert.deepStrictEqual(YM.parseTitleArtist('Silkk da Shocka', 'Isaiah Rashad - Topic').artist, 'Isaiah Rashad');

// parseTitleArtist now delegates to cleanMetadata: test en-dash separator handling
// (the old code only split on ASCII " - ", so en-dashes defaulted to channel-as-artist)
assert.deepStrictEqual(YM.parseTitleArtist('Rick Astley – Never Gonna Give You Up', 'CookieMonsta53'),
    { artist: 'Rick Astley', title: 'Never Gonna Give You Up' });

// and noise removal from titles (e.g., "(Official Audio)" suffix)
assert.deepStrictEqual(YM.parseTitleArtist('Special Ed - I Got It Made (Official Audio)', 'X'),
    { artist: 'Special Ed', title: 'I Got It Made' });

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
