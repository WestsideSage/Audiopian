var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

function loadBrowserCommonJs(filePath, extraArgs) {
    var code = fs.readFileSync(filePath, 'utf8');
    var fakeModule = { exports: {} };
    var argNames = ['module', 'exports'].concat(Object.keys(extraArgs || {}));
    var argValues = [fakeModule, fakeModule.exports].concat(Object.values(extraArgs || {}));
    var fn = new Function(argNames.join(','), code);
    fn.apply(null, argValues);
    return fakeModule.exports;
}

var S = path.join(__dirname, '..', 'static');
var matchHelpers = loadBrowserCommonJs(path.join(S, 'match-helpers.js'));
var syncHelpers = loadBrowserCommonJs(path.join(S, 'sync-helpers.js'));
var scoring = loadBrowserCommonJs(path.join(S, 'scoring.js'), {
    require: function (specifier) {
        if (specifier === './match-helpers.js') return matchHelpers;
        if (specifier === './sync-helpers.js') return syncHelpers;
        throw new Error('Unexpected require: ' + specifier);
    },
    globalThis: globalThis
});
var lattice = loadBrowserCommonJs(path.join(S, 'lattice-align.js'), {
    require: function (specifier) {
        if (specifier === './scoring.js') return scoring;
        throw new Error('Unexpected require: ' + specifier);
    }
});

// The lattice owns an untruncated phonetic representation; the existing scorer's
// four-character Double Metaphone fast path remains a separate API.
(function () {
    var code = lattice.doubleMetaphoneFull('internationalization')[0];
    assert.ok(code.length > 4, 'full Metaphone code is not truncated to four characters');
})();

// A whole-line phoneme alignment can recover an anchor from an ASR substitution
// that a token-by-token matcher cannot safely generalize.
(function () {
    var result = lattice.alignPhonemeLattice({
        lyricWords: ['shiny', 'gold'],
        spokenWords: ['shiny', 'goat'],
        anchors: [{ anchorIdx: 0, wordIdx: 1, word: 'gold' }]
    });
    assert.strictEqual(result.accepted, true, 'similar complete line clears the line guard');
    assert.strictEqual(result.credits.length, 1, 'gold receives one lattice credit');
    assert.strictEqual(result.credits[0].anchorIdx, 0);
    assert.deepStrictEqual(result.credits[0].tokenIndices, [1],
        'credit identifies the ASR token span that supplied it');
})();

// Word-boundary drift: four lyric tokens may arrive as two different ASR words.
(function () {
    var result = lattice.alignPhonemeLattice({
        lyricWords: ['choppa', 'let', 'it', 'eat'],
        spokenWords: ['chocolate', 'lady'],
        anchors: [
            { anchorIdx: 0, wordIdx: 0, word: 'choppa' },
            { anchorIdx: 1, wordIdx: 1, word: 'let' },
            { anchorIdx: 2, wordIdx: 3, word: 'eat' }
        ]
    });
    assert.strictEqual(result.accepted, true, 'segmentation drift clears the whole-line guard');
    assert.ok(result.credits.some(function (credit) { return credit.anchorIdx === 0; }),
        'the choppa anchor is supported by the chocolate span');
})();

(function () {
    var result = lattice.alignPhonemeLattice({
        lyricWords: ['watch', 'me', 'do', 'my'],
        spokenWords: ['want', 'me', 'to', 'my'],
        anchors: [{ anchorIdx: 0, wordIdx: 0, word: 'watch' }]
    });
    assert.ok(result.accepted && result.credits.length === 1,
        'watch me do my -> want me to my recovers the watch anchor');
})();

(function () {
    var result = lattice.alignPhonemeLattice({
        lyricWords: ['i', 'skrrt'],
        spokenWords: ['oscar'],
        anchors: [{ anchorIdx: 0, wordIdx: 1, word: 'skrrt' }]
    });
    assert.ok(result.accepted && result.credits.length === 1,
        'I skrrt -> Oscar recovers across a fused ASR token');
    assert.deepStrictEqual(result.credits[0].tokenIndices, [0]);
})();

// Honesty guard: one exact word cannot carry an otherwise unrelated line.
(function () {
    var result = lattice.alignPhonemeLattice({
        lyricWords: ['shiny', 'gold', 'rocket', 'midnight'],
        spokenWords: ['shiny', 'banana', 'window', 'table'],
        anchors: [{ anchorIdx: 0, wordIdx: 0, word: 'shiny' }]
    });
    assert.strictEqual(result.accepted, false, 'garbage line fails the whole-line floor');
    assert.deepStrictEqual(result.credits, [], 'failed whole-line guard emits no anchor credit');
})();

// Browser SR often sends a cumulative verse window. Local alignment evaluates the
// supporting span, so unrelated prefix/suffix tokens do not dilute an honest line.
(function () {
    var result = lattice.alignPhonemeLattice({
        lyricWords: ['shiny', 'gold'],
        spokenWords: ['old', 'verse', 'words', 'shiny', 'goat', 'next', 'bar'],
        anchors: [{ anchorIdx: 0, wordIdx: 1, word: 'gold' }]
    });
    assert.ok(result.accepted && result.credits.length === 1,
        'cumulative ASR window recovers from its local supporting span');
    assert.deepStrictEqual(result.credits[0].tokenIndices, [4]);
})();

// Historical Nas cold-start noise: consonant-only Metaphone can make short words
// look deceptively similar. Retained vowel phonemes must reject this garbage span.
(function () {
    var result = lattice.alignPhonemeLattice({
        lyricWords: ['look', 'here', 'see'],
        spokenWords: ['putting', 'mike', 'shanked', 'twoface', 'al', 'over', 'some'],
        anchors: [
            { anchorIdx: 0, wordIdx: 0, word: 'look' },
            { anchorIdx: 1, wordIdx: 1, word: 'here' },
            { anchorIdx: 2, wordIdx: 2, word: 'see' }
        ]
    });
    assert.strictEqual(result.accepted, false, 'unrelated short-word window fails the line guard');
    assert.deepStrictEqual(result.credits, []);
})();

console.log('test_lattice_align.cjs: all assertions passed');
