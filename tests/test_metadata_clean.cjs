const assert = require('assert');
const { cleanMetadata, stripNoise } = require('../static/metadata-clean.js');

// --- separator handling: prefer an in-title "Artist - Title" over the channel ---
let r = cleanMetadata('Rick Astley – Never Gonna Give You Up', 'CookieMonsta53'); // en-dash
assert.strictEqual(r.artist, 'Rick Astley', 'en-dash: artist from title, not channel');
assert.strictEqual(r.title, 'Never Gonna Give You Up', 'en-dash: title is the right half');

r = cleanMetadata('Rick Astley - Never Gonna Give You Up', 'CookieMonsta53'); // ascii hyphen
assert.strictEqual(r.artist, 'Rick Astley');
assert.strictEqual(r.title, 'Never Gonna Give You Up');

r = cleanMetadata('Special Ed — I Got It Made', 'Some Uploader'); // em-dash
assert.strictEqual(r.artist, 'Special Ed');
assert.strictEqual(r.title, 'I Got It Made');

// --- no separator in title: fall back to channel as artist, cleaned of "- Topic" ---
r = cleanMetadata('I Got It Made', 'Special Ed - Topic');
assert.strictEqual(r.artist, 'Special Ed', 'Topic suffix stripped from channel');
assert.strictEqual(r.title, 'I Got It Made');

// --- targeted noise removal from the title ---
assert.strictEqual(stripNoise('Never Gonna Give You Up (Official Video)'), 'Never Gonna Give You Up');
assert.strictEqual(stripNoise('Juicy (Official Audio)'), 'Juicy');
assert.strictEqual(stripNoise('Song [Official Music Video]'), 'Song');
assert.strictEqual(stripNoise('Song (Lyrics)'), 'Song');
assert.strictEqual(stripNoise('Song (Visualizer)'), 'Song');
assert.strictEqual(stripNoise('Hotline Bling ft. Drake'), 'Hotline Bling');
assert.strictEqual(stripNoise('Song feat. Someone'), 'Song');
assert.strictEqual(stripNoise('Song (Remastered 2009)'), 'Song');
assert.strictEqual(stripNoise('Song (HD)'), 'Song');

// --- DO NOT over-strip: legitimate parenthetical titles survive ---
assert.strictEqual(stripNoise("(I Can't Get No) Satisfaction"), "(I Can't Get No) Satisfaction");
assert.strictEqual(stripNoise('(Sittin\' On) The Dock of the Bay'), '(Sittin\' On) The Dock of the Bay');

// --- end to end: noisy title with a dash and a feat ---
r = cleanMetadata('Special Ed - I Got It Made (Official Audio)', 'RandomChannel');
assert.strictEqual(r.artist, 'Special Ed');
assert.strictEqual(r.title, 'I Got It Made');

console.log('test_metadata_clean: OK');
