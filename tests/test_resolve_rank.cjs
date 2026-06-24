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
