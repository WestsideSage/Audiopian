const assert = require('assert');
const {
    isSpeakerLabel, isSectionHeader, isNonLyricLine, stripNonLyricLines,
} = require('../static/lyric-annotations.js');

// --- speaker labels (trailing colon, short, no sentence stopword) -> DROP ---
assert.strictEqual(isSpeakerLabel('Shawty e demoni:'), true, 'multi-word demon name label');
assert.strictEqual(isSpeakerLabel("Lil'D:"), true, 'single-token rapper label');
assert.strictEqual(isSpeakerLabel('MC:'), true, 'short label');

// --- NOT speaker labels -> KEEP ---
assert.strictEqual(isSpeakerLabel('and then she said:'), false, 'sentence stopword guard keeps real lyric');
assert.strictEqual(isSpeakerLabel('Soul? Shawty I got that'), false, 'no trailing colon');
assert.strictEqual(isSpeakerLabel('Ah Lil D! Welcome to "soul stack records".'), false, 'ends in period, name is mid-lyric');
assert.strictEqual(isSpeakerLabel('Get em Shawty'), false, 'no colon');
assert.strictEqual(isSpeakerLabel('I want to tell you all something right now please:'), false, 'too many words to be a label');

// --- section headers (entire line is a section tag) -> DROP ---
assert.strictEqual(isSectionHeader('[Chorus]'), true);
assert.strictEqual(isSectionHeader('(Verse 1)'), true);
assert.strictEqual(isSectionHeader('[Bridge]'), true);
assert.strictEqual(isSectionHeader('(Intro)'), true);
assert.strictEqual(isSectionHeader('{Hook}'), true);
assert.strictEqual(isSectionHeader('(Pre-Chorus 2)'), true);

// --- NOT section headers -> KEEP (sung parentheticals / partial wraps) ---
assert.strictEqual(isSectionHeader('(Soul) Ah ah ah ah!'), false, 'wrap does not span whole line');
assert.strictEqual(isSectionHeader("(I Can't Get No) Satisfaction"), false, 'text continues past paren');
assert.strictEqual(isSectionHeader('(Ooh)'), false, 'fully wrapped but not a section word');
assert.strictEqual(isSectionHeader('(Soul)'), false, 'backing vocal, not a section word');

// --- combined predicate ---
assert.strictEqual(isNonLyricLine("Lil'D:"), true);
assert.strictEqual(isNonLyricLine('[Chorus]'), true);
assert.strictEqual(isNonLyricLine('Get em Shawty'), false);

// --- stripNonLyricLines: removes annotations, keeps lyrics, preserves order ---
const lines = [
    { time: 1, text: 'Ah Lil D! Welcome to "soul stack records".' },
    { time: 2, text: 'Shawty e demoni:' },
    { time: 3, text: 'But all we want is your soul' },
    { time: 4, text: '[Chorus]' },
    { time: 5, text: '(Soul) Ah ah ah ah!' },
];
const kept = stripNonLyricLines(lines);
assert.strictEqual(kept.length, 3, 'two annotation lines removed');
assert.deepStrictEqual(kept.map(l => l.time), [1, 3, 5], 'order preserved, labels/headers gone');

// --- fail-safe: an all-annotations list returns the ORIGINAL unchanged ---
const allAnn = [{ time: 1, text: 'Lil D:' }, { time: 2, text: '[Verse]' }];
assert.strictEqual(stripNonLyricLines(allAnn).length, 2, 'never blank out the whole sheet');

console.log('test_lyric_annotations: OK');
