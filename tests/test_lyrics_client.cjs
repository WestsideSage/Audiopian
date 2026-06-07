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
