(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        root.KaraokeeLyricPaint = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // Map a phrase plan to per-line phrase ranges over the displayed words, so the
    // renderer can tag every word with its phrase (to green the whole line on a pass)
    // and flag the anchor ("key") words. The engine's per-line word list
    // (normalizeWords) is the same 1:1 sequence the renderer produces; lines the
    // engine chunks into multiple phrases occupy contiguous span ranges, so each
    // phrase's words start at the running offset within the line and each anchor's
    // wordIdx is relative to its chunk.
    // Returns:
    //   { [lineIdx]: [ { phraseId, startIndex, wordCount,
    //                    anchors: [ { wordIndex, anchorIdx } ] } ] }
    function buildLinePhraseMap(phrasePlan) {
        var byLine = {};
        var offset = {};
        var phrases = (phrasePlan && phrasePlan.phrases) || [];
        phrases.forEach(function (p) {
            var li = p.lineIdx;
            if (offset[li] == null) offset[li] = 0;
            if (!byLine[li]) byLine[li] = [];
            var start = offset[li];
            var count = (p.words || []).length;
            var anchors = (p.anchors || []).map(function (a) {
                return { wordIndex: start + a.wordIdx, anchorIdx: a.anchorIdx };
            });
            byLine[li].push({ phraseId: p.phraseId, startIndex: start, wordCount: count, anchors: anchors });
            offset[li] += count;
        });
        return byLine;
    }

    return { buildLinePhraseMap: buildLinePhraseMap };
});
