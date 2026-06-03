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
    require: function (s) { if (s === './match-helpers.js') return matchHelpers; if (s === './sync-helpers.js') return syncHelpers; throw new Error(s); },
    globalThis: globalThis
});
var phraseEngine = loadBrowserCommonJs(path.join(S, 'phrase-engine.js'), {
    require: function (s) { if (s === './scoring.js') return scoring; if (s === './match-helpers.js') return matchHelpers; throw new Error(s); },
    globalThis: globalThis
});
var paint = loadBrowserCommonJs(path.join(S, 'lyric-paint-helpers.js'));

// A long line (>14 words) forces chunking into multiple phrases; a short line does not.
var lyrics = [
    { time: 0, text: 'morning sunlight breaks mountain valley rivers flowing gently distant oceans calling sailors homeward bound forever onward' },
    { time: 8, text: 'love conquers everything' }
];
var plan = phraseEngine.buildPhrasePlan(lyrics, { difficulty: 'hard', audioDuration: 20 });
var map = paint.buildLinePhraseMap(plan);

// --- Line 0: chunked into >= 2 phrases; phrase ranges tile the line ---
var l0 = map[0] || [];
assert.ok(l0.length >= 2, 'long line chunks into >= 2 phrases');
assert.strictEqual(l0[0].startIndex, 0, 'first chunk starts at index 0');
assert.strictEqual(l0[1].startIndex, l0[0].wordCount, 'second chunk starts after the first');
var totalWc = l0.reduce(function (s, p) { return s + p.wordCount; }, 0);
assert.strictEqual(totalWc, scoring.normalizeWords(lyrics[0].text).length, 'phrase word counts cover every word in the line');

// Anchors carry absolute (line) word indices, with the chunk offset applied.
var planL0 = plan.phrases.filter(function (p) { return p.lineIdx === 0; });
planL0[0].anchors.forEach(function (a) {
    var e = l0[0].anchors.find(function (x) { return x.anchorIdx === a.anchorIdx; });
    assert.ok(e && e.wordIndex === a.wordIdx, 'first-chunk anchor: wordIndex == wordIdx (offset 0)');
});
planL0[1].anchors.forEach(function (a) {
    var e = l0[1].anchors.find(function (x) { return x.anchorIdx === a.anchorIdx; });
    assert.ok(e && e.wordIndex === l0[0].wordCount + a.wordIdx, 'second-chunk anchor: chunk offset applied');
});
// Every anchor wordIndex falls inside its phrase's range.
l0.forEach(function (p) {
    p.anchors.forEach(function (a) {
        assert.ok(a.wordIndex >= p.startIndex && a.wordIndex < p.startIndex + p.wordCount, 'anchor index within phrase range');
    });
});

// --- Short line: single phrase covering all words; anchors map directly ---
var l1 = map[1] || [];
assert.strictEqual(l1.length, 1, 'short line is a single phrase');
assert.strictEqual(l1[0].startIndex, 0);
assert.strictEqual(l1[0].wordCount, scoring.normalizeWords(lyrics[1].text).length, 'phrase covers the whole short line');
l1[0].anchors.forEach(function (e) {
    var a = plan.phrases.filter(function (p) { return p.lineIdx === 1; })[0].anchors.find(function (x) { return x.anchorIdx === e.anchorIdx; });
    assert.ok(a && e.wordIndex === a.wordIdx, 'short-line anchor maps directly');
});

console.log('test_lyric_paint_helpers.cjs: all assertions passed');
