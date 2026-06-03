(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        root.KaraokeeLyricPaint = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // Map a phrase plan's anchors to displayed-word (span) indices per line.
    // The engine's per-line word list (normalizeWords) is the same 1:1 sequence the
    // renderer produces; for lines the engine chunks into multiple phrases, each
    // anchor's wordIdx is into its chunk, so add the chunk's offset within the line.
    // Returns { [lineIdx]: [ { wordIndex, phraseId, anchorIdx } ... ] }.
    function buildAnchorSpanIndex(phrasePlan) {
        var byLine = {};
        var offset = {};
        var phrases = (phrasePlan && phrasePlan.phrases) || [];
        phrases.forEach(function (p) {
            var li = p.lineIdx;
            if (offset[li] == null) offset[li] = 0;
            if (!byLine[li]) byLine[li] = [];
            (p.anchors || []).forEach(function (a) {
                byLine[li].push({
                    wordIndex: offset[li] + a.wordIdx,
                    phraseId: p.phraseId,
                    anchorIdx: a.anchorIdx
                });
            });
            offset[li] += (p.words || []).length;
        });
        return byLine;
    }

    return { buildAnchorSpanIndex: buildAnchorSpanIndex };
});
