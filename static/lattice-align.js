(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory(require('./scoring.js'));
    } else {
        root.KaraokeeLatticeAlign = factory(root.KaraokeeScoring);
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (scoring) {
    'use strict';

    function doubleMetaphoneFull(word) {
        return scoring && scoring.doubleMetaphoneFull
            ? scoring.doubleMetaphoneFull(word) : ['', ''];
    }

    // The existing Double Metaphone implementation intentionally drops most
    // vowels, which is excellent for a fast per-word lookup but too lossy for a
    // line lattice (short unrelated words collide). Retain a compact vowel stream
    // while folding consonants into the same broad acoustic families.
    function phonemeSequence(word) {
        var value = String(word || '').toUpperCase().replace(/[^A-Z]/g, '');
        value = value.replace(/TCH/g, 'X').replace(/CH/g, 'X').replace(/SH/g, 'X')
            .replace(/TH/g, '0').replace(/PH/g, 'F').replace(/CK/g, 'K')
            .replace(/QU/g, 'K').replace(/NG/g, 'N');
        var out = '';
        for (var i = 0; i < value.length; i++) {
            var c = value[i];
            var mapped = c;
            if (c === 'Y') mapped = 'I';
            else if (c === 'B' || c === 'P') mapped = 'P';
            else if (c === 'C' || c === 'K' || c === 'Q') mapped = 'K';
            else if (c === 'D' || c === 'T') mapped = 'T';
            else if (c === 'V' || c === 'F') mapped = 'F';
            else if (c === 'Z' || c === 'S') mapped = 'S';
            if (!out || out[out.length - 1] !== mapped) out += mapped;
        }
        if (out) return out;
        var fallback = doubleMetaphoneFull(word);
        return fallback[0] || fallback[1] || '';
    }

    function encodeWords(words) {
        var phonemes = '';
        var charToWord = [];
        (words || []).forEach(function (word, wordIdx) {
            var normalized = String(word || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            var code = phonemeSequence(normalized);
            for (var ci = 0; ci < code.length; ci++) {
                phonemes += code[ci];
                charToWord.push(wordIdx);
            }
        });
        return { phonemes: phonemes, charToWord: charToWord };
    }

    var NEAR_CLASSES = ['TD', 'PB', 'SXZ', 'KGQ', 'FV', 'JX', 'MN'];
    function phonemeScore(a, b) {
        if (a === b) return 2;
        for (var i = 0; i < NEAR_CLASSES.length; i++) {
            if (NEAR_CLASSES[i].indexOf(a) >= 0 && NEAR_CLASSES[i].indexOf(b) >= 0) return 1;
        }
        return -1;
    }

    function smithWaterman(lyric, spoken) {
        var rows = lyric.length + 1;
        var cols = spoken.length + 1;
        var scores = new Array(rows);
        var dirs = new Array(rows);
        var best = { score: 0, i: 0, j: 0 };
        for (var i = 0; i < rows; i++) {
            scores[i] = new Array(cols).fill(0);
            dirs[i] = new Array(cols).fill(0);
        }
        for (var li = 1; li < rows; li++) {
            for (var sj = 1; sj < cols; sj++) {
                var diag = scores[li - 1][sj - 1] + phonemeScore(lyric[li - 1], spoken[sj - 1]);
                // Cheap gaps are the point of the lattice: ASR may fuse/split words,
                // so a missing phoneme boundary must not terminate an otherwise
                // coherent local path. The whole-line Dice guard limits scatter.
                var up = scores[li - 1][sj] - 0.5;
                var left = scores[li][sj - 1] - 0.5;
                var value = Math.max(0, diag, up, left);
                scores[li][sj] = value;
                // Prefer a character alignment on ties, then a lyric gap, so the
                // traceback retains the most useful word/token span mapping.
                dirs[li][sj] = value === 0 ? 0 : (value === diag ? 1 : (value === up ? 2 : 3));
                // On equal maxima prefer the later cell: it retains a trailing
                // recovery after an internal gap (gold -> goat aligns K, gap L, T).
                if (value >= best.score) best = { score: value, i: li, j: sj };
            }
        }

        var aligned = new Array(lyric.length);
        var spokenEnd = best.j;
        var ti = best.i, tj = best.j;
        while (ti > 0 && tj > 0 && scores[ti][tj] > 0) {
            var dir = dirs[ti][tj];
            if (dir === 1) {
                var raw = phonemeScore(lyric[ti - 1], spoken[tj - 1]);
                aligned[ti - 1] = { quality: raw > 0 ? raw : 0, spokenCharIdx: tj - 1 };
                ti--; tj--;
            } else if (dir === 2) {
                ti--;
            } else if (dir === 3) {
                tj--;
            } else {
                break;
            }
        }
        return { score: best.score, aligned: aligned, spokenStart: tj, spokenEnd: spokenEnd };
    }

    function alignPhonemeLattice(options) {
        options = options || {};
        var lyric = encodeWords(options.lyricWords || []);
        var spoken = encodeWords(options.spokenWords || []);
        if (!lyric.phonemes || !spoken.phonemes) {
            return { accepted: false, lineScore: 0, lineCoverage: 0, credits: [] };
        }
        var alignment = smithWaterman(lyric.phonemes, spoken.phonemes);
        var positive = alignment.aligned.filter(function (hit) { return hit && hit.quality > 0; });
        var lineQuality = positive.reduce(function (sum, hit) { return sum + hit.quality; }, 0);
        // Dice-style normalization is segmentation-neutral: a shorter ASR phoneme
        // string is not punished twice merely because it fused several lyric words.
        // Smith-Waterman is local, so cumulative browser-SR prefix/suffix text is
        // excluded; the COMPLETE lyric side remains in the denominator as the guard.
        var spokenSpanLength = Math.max(1, alignment.spokenEnd - alignment.spokenStart);
        var lineScore = lineQuality / (lyric.phonemes.length + spokenSpanLength);
        var lineCoverage = positive.length / Math.min(lyric.phonemes.length, spokenSpanLength);
        var lyricWordCount = Object.keys(lyric.charToWord.reduce(function (set, idx) {
            set[idx] = true; return set;
        }, {})).length;
        var supportWords = {};
        for (var swi = alignment.spokenStart; swi < alignment.spokenEnd; swi++) {
            if (spoken.charToWord[swi] != null) supportWords[spoken.charToWord[swi]] = true;
        }
        var supportWordCount = Object.keys(supportWords).length;
        // Ordinary substitutions need a strong 0.70 whole-line fit. The explicit
        // fusion class (ASR used at most half as many tokens) gets a 0.60 floor so
        // “choppa let it eat” -> “chocolate lady” and “I skrrt” -> “Oscar” survive.
        var fusedSegmentation = supportWordCount <= Math.ceil(lyricWordCount * 0.5);
        var lineFloor = options.lineFloor != null ? options.lineFloor
            : (fusedSegmentation ? 0.60 : 0.70);
        var lineCoverageFloor = options.lineCoverageFloor != null ? options.lineCoverageFloor : 0.60;
        var anchorFloor = options.anchorFloor != null ? options.anchorFloor : 0.50;
        var anchorCoverageFloor = options.anchorCoverageFloor != null ? options.anchorCoverageFloor : 0.50;
        var accepted = lineScore >= lineFloor && lineCoverage >= lineCoverageFloor;
        var credits = [];

        if (accepted) {
            (options.anchors || []).forEach(function (anchor) {
                var positions = [];
                for (var pi = 0; pi < lyric.charToWord.length; pi++) {
                    if (lyric.charToWord[pi] === anchor.wordIdx) positions.push(pi);
                }
                if (positions.length === 0) return;
                var quality = 0;
                var anchorAligned = 0;
                var tokenSet = {};
                positions.forEach(function (pos) {
                    var hit = alignment.aligned[pos];
                    if (!hit) return;
                    if (hit.quality > 0) anchorAligned++;
                    quality += hit.quality;
                    var tokenIdx = spoken.charToWord[hit.spokenCharIdx];
                    if (tokenIdx != null) tokenSet[tokenIdx] = true;
                });
                var score = quality / (2 * positions.length);
                var coverage = anchorAligned / positions.length;
                if (score < anchorFloor || coverage < anchorCoverageFloor) return;
                credits.push({
                    anchorIdx: anchor.anchorIdx,
                    wordIdx: anchor.wordIdx,
                    score: score,
                    coverage: coverage,
                    tokenIndices: Object.keys(tokenSet).map(Number).sort(function (a, b) { return a - b; })
                });
            });
        }

        return {
            accepted: accepted,
            lineScore: lineScore,
            lineCoverage: lineCoverage,
            credits: credits
        };
    }

    return {
        doubleMetaphoneFull: doubleMetaphoneFull,
        alignPhonemeLattice: alignPhonemeLattice
    };
});
