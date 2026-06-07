var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

var filePath = path.join(__dirname, '..', 'static', 'share-card.js');
var code = fs.readFileSync(filePath, 'utf8');
var fakeModule = { exports: {} };
new Function('module', 'exports', code)(fakeModule, fakeModule.exports);
var buildShareCardLines = fakeModule.exports.buildShareCardLines;

// Full arcade summary + song -> brand/grade/stat/song lines.
var full = buildShareCardLines(
    { grade: 'S', points: 1234, percent: 97, difficulty: 'expert' },
    { artist: 'Isaiah Rashad', title: 'Silkk da Shocka' }
);
assert.strictEqual(full.brand, 'KARAOKEE', 'brand line');
assert.strictEqual(full.grade, 'S', 'grade letter');
assert.strictEqual(full.stat, 'EXPERT · 1234 pts · 97%', 'stat: DIFF · pts · %');
assert.strictEqual(full.song, 'Isaiah Rashad — Silkk da Shocka', 'song: artist — title');

// Missing artist -> song is just the title (no dangling em-dash).
assert.strictEqual(buildShareCardLines({ grade: 'A', points: 1, percent: 5 }, { title: 'Solo' }).song, 'Solo', 'title-only song');
// Missing title -> song is just the artist.
assert.strictEqual(buildShareCardLines({}, { artist: 'OnlyArtist' }).song, 'OnlyArtist', 'artist-only song');

// No difficulty -> stat has no DIFF prefix.
assert.strictEqual(buildShareCardLines({ points: 10, percent: 20 }, {}).stat, '10 pts · 20%', 'stat without difficulty prefix');

// Missing summary fields default to grade '' and 0 pts · 0%.
var empty = buildShareCardLines({}, {});
assert.strictEqual(empty.grade, '', 'missing grade -> empty');
assert.strictEqual(empty.stat, '0 pts · 0%', 'missing points/percent -> zeros');
assert.strictEqual(empty.song, '', 'missing song -> empty');

// Long song line is truncated to <= 48 chars with an ellipsis.
var longSong = buildShareCardLines(
    { grade: 'B', points: 5, percent: 50, difficulty: 'easy' },
    { artist: 'A Very Long Artist Name Indeed', title: 'And An Equally Long Song Title Here Too' }
);
assert.ok(longSong.song.length <= 48, 'song truncated to <= 48 chars, got ' + longSong.song.length);
assert.ok(longSong.song.endsWith('…'), 'truncated song ends with an ellipsis');

// Defensive: no args at all -> safe defaults, no throw.
var none = buildShareCardLines();
assert.strictEqual(none.brand, 'KARAOKEE', 'no-arg brand');
assert.strictEqual(none.stat, '0 pts · 0%', 'no-arg stat');
assert.strictEqual(none.song, '', 'no-arg song');

console.log('All share-card tests passed.');
