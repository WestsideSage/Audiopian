const assert = require('assert');
const { resolveVideos } = require('../workers/resolve/core.cjs');

function fakeYouTube() {
    return async function (url) {
        if (url.indexOf('youtube/v3/search') !== -1) {
            return { ok: true, json: async () => ({ items: [
                { id: { videoId: 'right' }, snippet: { title: 'I Got It Made', channelTitle: 'Special Ed - Topic' } },
                { id: { videoId: 'loop' },  snippet: { title: 'I Got It Made 1 HOUR LOOP', channelTitle: 'Loops' } },
            ] }) };
        }
        return { ok: true, json: async () => ({ items: [
            { id: 'right', contentDetails: { duration: 'PT3M32S' } },
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
    assert.strictEqual(out[0].durationSec, 212);
    assert.ok(out.length <= 3, 'top 3 only');

    const empty = await resolveVideos({ artist: '', title: '' }, { fetch: fakeYouTube(), apiKey: 'K' });
    assert.deepStrictEqual(empty, []);
    console.log('test_resolve_worker: OK');
})();
