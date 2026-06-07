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
