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
var map = paint.buildAnchorSpanIndex(plan);

// Line 0 chunked into >= 2 phrases
var line0 = plan.phrases.filter(function (p) { return p.lineIdx === 0; });
assert.ok(line0.length >= 2, 'long line chunks into multiple phrases');
var p0 = line0[0], p1 = line0[1];
var offset1 = p0.words.length;
var entries0 = map[0] || [];

// First chunk: span index == anchor.wordIdx (offset 0)
p0.anchors.forEach(function (a) {
    var e = entries0.find(function (x) { return x.phraseId === p0.phraseId && x.anchorIdx === a.anchorIdx; });
    assert.ok(e, 'entry exists for first-chunk anchor');
    assert.strictEqual(e.wordIndex, a.wordIdx, 'first chunk uses offset 0');
});
// Second chunk: span index == first-chunk word count + anchor.wordIdx
p1.anchors.forEach(function (a) {
    var e = entries0.find(function (x) { return x.phraseId === p1.phraseId && x.anchorIdx === a.anchorIdx; });
    assert.ok(e, 'entry exists for second-chunk anchor');
    assert.strictEqual(e.wordIndex, offset1 + a.wordIdx, 'second chunk applies the chunk offset');
});
// All indices in bounds of the rendered word count
var nWords0 = scoring.normalizeWords(lyrics[0].text).length;
entries0.forEach(function (e) { assert.ok(e.wordIndex >= 0 && e.wordIndex < nWords0, 'wordIndex in bounds'); });

// Short line: single phrase, anchors map directly
var line1 = plan.phrases.filter(function (p) { return p.lineIdx === 1; });
assert.strictEqual(line1.length, 1, 'short line not chunked');
(map[1] || []).forEach(function (e) {
    var a = line1[0].anchors.find(function (x) { return x.anchorIdx === e.anchorIdx; });
    assert.ok(a && e.wordIndex === a.wordIdx, 'short line maps directly');
});

console.log('test_lyric_paint_helpers.cjs: all assertions passed');
