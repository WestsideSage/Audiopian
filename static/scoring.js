(function(root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory(require('./match-helpers.js'), require('./sync-helpers.js'), root || globalThis);
    } else {
        root.KaraokeeScoring = factory(root, root, root);
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function(matchHelpers, syncHelpers, root) {
    var contractionsMatch = matchHelpers.contractionsMatch;
    var slangMatch = matchHelpers.slangMatch;
    var skipFuzzyMatch = matchHelpers.skipFuzzyMatch;
    var isEdit2PrefixTruncation = matchHelpers.isEdit2PrefixTruncation;
    var classifyWord = matchHelpers.classifyWord;
    var WORD_WEIGHTS = matchHelpers.WORD_WEIGHTS;
    var MetaphoneLRU = matchHelpers.MetaphoneLRU;

    var classifyTempo = syncHelpers.classifyTempo;
    var getWindowParams = syncHelpers.getWindowParams;

    function editDistance(a, b) {
        var m = a.length;
        var n = b.length;
        var prev = Array.from({ length: n + 1 }, function(_, i) { return i; });
        var curr = new Array(n + 1);

        for (var i = 1; i <= m; i++) {
            curr[0] = i;
            for (var j = 1; j <= n; j++) {
                curr[j] = a[i - 1] === b[j - 1]
                    ? prev[j - 1]
                    : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
            }
            var tmp = prev;
            prev = curr;
            curr = tmp;
        }
        return prev[n];
    }

    function doubleMetaphone(word) {
        if (!word || typeof word !== 'string') return ['', ''];
        word = word.toUpperCase().replace(/[^A-Z]/g, '');
        if (!word) return ['', ''];

        var len = word.length;
        var p = '';
        var s = '';
        var i = 0;

        function add(a, b) {
            p += a || '';
            s += (b !== undefined ? b : a) || '';
        }
        function at(pos) {
            return (pos >= 0 && pos < len) ? word[pos] : '';
        }
        function sub(pos, n) {
            return word.substring(pos, pos + n);
        }
        function isV(c) {
            return 'AEIOU'.indexOf(c) >= 0;
        }
        function slavo() {
            return word.indexOf('W') > -1 || word.indexOf('K') > -1 || sub(0, 2) === 'CZ';
        }

        if (/^(GN|KN|PN|AE|WR)/.test(sub(0, 2))) i = 1;
        if (at(0) === 'X') {
            add('S');
            i = 1;
        }

        while (i < len) {
            var c = at(i);
            switch (c) {
                case 'A': case 'E': case 'I': case 'O': case 'U': case 'Y':
                    if (i === 0) add('A');
                    i++;
                    break;
                case 'B':
                    add('P');
                    i += (at(i + 1) === 'B') ? 2 : 1;
                    break;
                case 'C':
                    if (sub(i, 2) === 'CIA') {
                        add('X');
                        i += 3;
                        break;
                    }
                    if (sub(i, 2) === 'CH') {
                        if (i > 0 && sub(i - 2, 6).match(/ORCHES|ARCHIT|ORCHID/)) add('K');
                        else if (at(i + 2).match(/[IEY]/)) add('S');
                        else if (slavo() || sub(0, 4).match(/VAN |VON |SCH/)) add('K');
                        else add('X', 'K');
                        i += 2;
                        break;
                    }
                    if (sub(i, 2).match(/CE|CI/)) {
                        add('S');
                        i += 2;
                        break;
                    }
                    if (sub(i, 2) === 'CK') {
                        add('K');
                        i += 2;
                        break;
                    }
                    add('K');
                    i += (at(i + 1) === 'C') ? 2 : 1;
                    break;
                case 'D':
                    if (sub(i, 2) === 'DG' && at(i + 2).match(/[IEY]/)) {
                        add('J');
                        i += 3;
                        break;
                    }
                    add('T');
                    i += (sub(i, 2).match(/DT|DD/)) ? 2 : 1;
                    break;
                case 'F':
                    add('F');
                    i += (at(i + 1) === 'F') ? 2 : 1;
                    break;
                case 'G':
                    if (at(i + 1) === 'H') {
                        if (i > 0 && !isV(at(i - 1))) {
                            add('K');
                            i += 2;
                            break;
                        }
                        if (i === 0) {
                            add(at(i + 2) === 'I' ? 'J' : 'K');
                            i += 2;
                            break;
                        }
                        i += 2;
                        break;
                    }
                    if (at(i + 1) === 'N') {
                        if (i === 1 && isV(at(0)) && !slavo()) add('KN', 'N');
                        else add('N');
                        i += 2;
                        break;
                    }
                    if ('EIY'.includes(at(i + 1))) {
                        add('J', 'K');
                        i += 2;
                        break;
                    }
                    add('K');
                    i += (at(i + 1) === 'G') ? 2 : 1;
                    break;
                case 'H':
                    if (isV(at(i + 1)) && (i === 0 || isV(at(i - 1)))) {
                        add('H');
                        i++;
                    }
                    i++;
                    break;
                case 'J':
                    add('J', 'H');
                    i += (at(i + 1) === 'J') ? 2 : 1;
                    break;
                case 'K':
                    add('K');
                    i += (at(i + 1) === 'K') ? 2 : 1;
                    break;
                case 'L':
                    add('L');
                    i += (at(i + 1) === 'L') ? 2 : 1;
                    break;
                case 'M':
                    add('M');
                    i += (at(i + 1) === 'M') ? 2 : 1;
                    break;
                case 'N':
                    add('N');
                    i += (at(i + 1) === 'N') ? 2 : 1;
                    break;
                case 'P':
                    if (at(i + 1) === 'H') {
                        add('F');
                        i += 2;
                        break;
                    }
                    add('P');
                    i += (at(i + 1) === 'P') ? 2 : 1;
                    break;
                case 'Q':
                    add('K');
                    i += (at(i + 1) === 'Q') ? 2 : 1;
                    break;
                case 'R':
                    add('R');
                    i += (at(i + 1) === 'R') ? 2 : 1;
                    break;
                case 'S':
                    if (sub(i, 2) === 'SH') {
                        add('X');
                        i += 2;
                        break;
                    }
                    if (sub(i, 3).match(/SIO|SIA/)) {
                        add('X');
                        i += 3;
                        break;
                    }
                    if (sub(i, 2) === 'SC') {
                        if (at(i + 2).match(/[IEY]/)) add('S');
                        else add('SK');
                        i += 3;
                        break;
                    }
                    add('S');
                    i += (sub(i, 2) === 'SS') ? 2 : 1;
                    break;
                case 'T':
                    if (sub(i, 4) === 'TION' || sub(i, 3).match(/TIA|TCH/)) {
                        add('X');
                        i += 3;
                        break;
                    }
                    if (sub(i, 2) === 'TH') {
                        add('0', 'T');
                        i += 2;
                        break;
                    }
                    add('T');
                    i += (sub(i, 2).match(/TT|TD/)) ? 2 : 1;
                    break;
                case 'V':
                    add('F');
                    i += (at(i + 1) === 'V') ? 2 : 1;
                    break;
                case 'W':
                    if (sub(i, 2) === 'WR') {
                        add('R');
                        i += 2;
                        break;
                    }
                    if (i === 0 && isV(at(i + 1))) add('A');
                    i++;
                    break;
                case 'X':
                    add('KS');
                    i += (at(i + 1).match(/[CX]/)) ? 2 : 1;
                    break;
                case 'Z':
                    if (at(i + 1) === 'H') {
                        add('J');
                        i += 2;
                        break;
                    }
                    add('S');
                    i += (at(i + 1) === 'Z') ? 2 : 1;
                    break;
                default:
                    i++;
                    break;
            }
        }

        return [p.substring(0, 4), s.substring(0, 4)];
    }

    root.doubleMetaphone = doubleMetaphone;

    var spokenMetaphoneLRU = new MetaphoneLRU(50);

    var SILENT_PREFIX_RE = /^(GN|KN|PN|WR|AE)/i;
    function hasSilentPrefix(word) {
        return SILENT_PREFIX_RE.test(word);
    }

    function wordsMatch(spoken, target, targetPhonetic) {
        if (spoken === target) return true;

        if (spoken.length >= 4 && target.length >= 4) {
            var sBase = spoken.endsWith('ing') ? spoken.slice(0, -3)
                : (spoken.endsWith('in') ? spoken.slice(0, -2) : null);
            var tBase = target.endsWith('ing') ? target.slice(0, -3)
                : (target.endsWith('in') ? target.slice(0, -2) : null);
            if (sBase && tBase && sBase.length >= 3 && sBase === tBase) return true;
        }

        if (contractionsMatch(spoken, target)) return true;
        if (slangMatch(spoken, target)) return true;

        if (spoken.length >= 3 && target.length >= 3) {
            var sp = spokenMetaphoneLRU.get(spoken);
            var tp = targetPhonetic || doubleMetaphone(target);
            if (sp[0] && tp[0] && (sp[0] === tp[0] || sp[0] === tp[1] || (sp[1] && (sp[1] === tp[0] || sp[1] === tp[1])))) {
                var sameFirst = spoken[0] === target[0];
                var bothLong = spoken.length >= 5 && target.length >= 5 && Math.abs(spoken.length - target.length) <= 2;
                var silentPrefix = hasSilentPrefix(spoken) || hasSilentPrefix(target);
                if (sameFirst || bothLong || silentPrefix) return true;
            }
        }

        if (!skipFuzzyMatch(target) && !skipFuzzyMatch(spoken)) {
            var maxDist = matchHelpers.maxEditDistance(Math.min(spoken.length, target.length));
            var edDist = (Math.abs(spoken.length - target.length) <= maxDist)
                ? editDistance(spoken, target)
                : Infinity;
            if (edDist === 1) return true;
            if (edDist === 2 && isEdit2PrefixTruncation(spoken, target)) return true;
        }

        return false;
    }

    function wordsMatchScore(spoken, target, targetPhonetic) {
        if (spoken === target) return { score: 1.0, method: 'exact' };

        if (spoken.length >= 4 && target.length >= 4) {
            var sBase = spoken.endsWith('ing') ? spoken.slice(0, -3)
                : (spoken.endsWith('in') ? spoken.slice(0, -2) : null);
            var tBase = target.endsWith('ing') ? target.slice(0, -3)
                : (target.endsWith('in') ? target.slice(0, -2) : null);
            if (sBase && tBase && sBase.length >= 3 && sBase === tBase) {
                return { score: 1.0, method: 'exact' };
            }
        }

        if (contractionsMatch(spoken, target)) return { score: 1.0, method: 'contraction' };
        if (slangMatch(spoken, target)) return { score: 0.9, method: 'slang' };

        if (spoken.length >= 3 && target.length >= 3) {
            var sp = spokenMetaphoneLRU.get(spoken);
            var tp = targetPhonetic || doubleMetaphone(target);
            if (sp[0] && tp[0] && (sp[0] === tp[0] || sp[0] === tp[1] || (sp[1] && (sp[1] === tp[0] || sp[1] === tp[1])))) {
                var sameFirst = spoken[0] === target[0];
                var bothLong = spoken.length >= 5 && target.length >= 5 && Math.abs(spoken.length - target.length) <= 2;
                var silentPrefix = hasSilentPrefix(spoken) || hasSilentPrefix(target);
                if (sameFirst || bothLong || silentPrefix) {
                    return { score: 0.8, method: 'phonetic' };
                }
            }
        }

        if (!skipFuzzyMatch(target) && !skipFuzzyMatch(spoken)) {
            var maxDist = matchHelpers.maxEditDistance(Math.min(spoken.length, target.length));
            var dist = (Math.abs(spoken.length - target.length) <= maxDist) ? editDistance(spoken, target) : Infinity;
            if (dist === 1) return { score: 0.75, method: 'edit1' };
            if (dist === 2 && isEdit2PrefixTruncation(spoken, target)) return { score: 0.4, method: 'edit2' };
        }

        return { score: 0.0, method: 'none' };
    }

    function normalizeWord(w) {
        return w.toLowerCase().replace(/[''`,.!?;:\-"*()]/g, '').trim();
    }

    function normalizeWords(text) {
        return text.split(/\s+/)
            .map(normalizeWord)
            .filter(function(w) { return w.length > 0; });
    }

    function estimateSyllables(word) {
        if (!word) return 1;
        var w = word.replace(/e$/, '') || word;
        var matches = w.match(/[aeiouy]+/gi);
        var count = matches ? matches.length : 1;
        return Math.max(1, count);
    }

    function interpolateWordTimings(lyricsArr) {
        var allTimings = [];

        for (var i = 0; i < lyricsArr.length; i++) {
            var line = lyricsArr[i];
            var words = line.text.trim().split(/\s+/);

            if (words.length === 0 || !words[0]) {
                var empty = [];
                empty.wps = 0;
                empty.tempoClass = 'slow';
                empty.lineStart = line.time;
                empty.lineEnd = line.time;
                allTimings.push(empty);
                continue;
            }

            var lineStart = line.time;
            var lineEnd;
            if (i + 1 < lyricsArr.length) {
                lineEnd = lyricsArr[i + 1].time;
            } else {
                var audioDur = (typeof root.audio !== 'undefined' && root.audio.duration && isFinite(root.audio.duration))
                    ? root.audio.duration
                    : lineStart + 4.0;
                lineEnd = Math.min(audioDur, lineStart + 8.0);
            }

            var lineDuration = lineEnd - lineStart;
            var wps = lineDuration > 0 ? words.length / lineDuration : 0;
            var tempoClass = classifyTempo(wps);
            var params = getWindowParams(tempoClass);

            var inParen = false;
            var wordClasses = [];
            var syllables = words.map(function(w) {
                var nw = normalizeWord(w);
                if (w.indexOf('(') >= 0) inParen = true;
                wordClasses.push(classifyWord(nw, inParen));
                if (w.indexOf(')') >= 0) inParen = false;
                return estimateSyllables(nw);
            });

            var totalSyllables = 0;
            for (var s = 0; s < syllables.length; s++) totalSyllables += syllables[s];
            if (totalSyllables === 0) totalSyllables = 1;

            var wordTimings = [];
            var cursor = lineStart;
            for (var wi = 0; wi < words.length; wi++) {
                var wordDuration = (syllables[wi] / totalSyllables) * lineDuration;
                var estimatedTime = cursor;
                var wStart = tempoClass === 'slow'
                    ? lineStart + (words.length <= 3 ? -0.5 : params.windowStart)
                    : estimatedTime + params.windowStart;
                var normalizedWord = normalizeWord(words[wi]);
                var timing = {
                    word: normalizedWord,
                    estimatedTime: estimatedTime,
                    windowStart: wStart,
                    windowEnd: estimatedTime + params.windowEnd,
                    wordClass: wordClasses[wi],
                    weight: WORD_WEIGHTS[wordClasses[wi]]
                };
                timing.phonetic = doubleMetaphone(normalizedWord);
                wordTimings.push(timing);
                cursor += wordDuration;
            }

            wordTimings.wps = wps;
            wordTimings.tempoClass = tempoClass;
            wordTimings.lineStart = lineStart;
            wordTimings.lineEnd = lineEnd;

            allTimings.push(wordTimings);
        }

        return allTimings;
    }

    function rawMatchScore(matchedSet, idx) {
        if (!matchedSet) return 0;
        if (typeof matchedSet.get === 'function') {
            var value = matchedSet.get(idx);
            return typeof value === 'number' ? value : (value ? 1.0 : 0);
        }
        return (matchedSet.has && matchedSet.has(idx)) ? 1.0 : 0;
    }

    function effectiveMatchScore(rawScore, idx, vadMatchedSet, asrConfirmedSet) {
        // VAD energy proves sound was made, not that the right word was sung.
        // A word matched only by VAD (not yet ASR-confirmed) earns NO lyric credit;
        // its "engagement" value is accounted separately by the phrase-engine flow score.
        if (rawScore > 0 && vadMatchedSet && vadMatchedSet.has && vadMatchedSet.has(idx) &&
            !(asrConfirmedSet && asrConfirmedSet.has && asrConfirmedSet.has(idx))) {
            return 0;
        }
        return rawScore;
    }

    function computeLineScore(lineWords, wordTimings, matchedSet, vadMatchedSet, asrConfirmedSet) {
        var weightedTotal = 0;
        var weightedMatched = 0;
        var matchedWords = 0;
        var missedWords = [];
        var missedWordIndices = [];

        for (var i = 0; i < lineWords.length; i++) {
            var weight = (wordTimings[i] && wordTimings[i].weight) || 1.0;
            weightedTotal += weight;

            var rawScore = rawMatchScore(matchedSet, i);
            var effectiveScore = effectiveMatchScore(rawScore, i, vadMatchedSet, asrConfirmedSet);
            if (effectiveScore > 0) {
                matchedWords++;
                weightedMatched += weight * effectiveScore;
            } else {
                missedWordIndices.push(i);
                missedWords.push(lineWords[i]);
            }
        }

        return {
            totalWords: lineWords.length,
            matchedWords: matchedWords,
            weightedTotal: weightedTotal,
            weightedMatched: weightedMatched,
            missedWords: missedWords,
            missedWordIndices: missedWordIndices,
            perfect: weightedTotal > 0 && weightedMatched >= weightedTotal * 0.9
        };
    }

    function collectSequentialWordMatches(spokenWords, lineWords, wordTimings) {
        var matches = new Map();
        var spokenIdx = 0;

        for (var li = 0; li < lineWords.length; li++) {
            var target = lineWords[li];
            var targetPhonetic = wordTimings && wordTimings[li] ? wordTimings[li].phonetic : undefined;

            for (var si = spokenIdx; si < spokenWords.length; si++) {
                var result = wordsMatchScore(spokenWords[si], target, targetPhonetic);
                if (result.score > 0) {
                    matches.set(li, result.score);
                    spokenIdx = si + 1;
                    break;
                }
            }
        }

        return matches;
    }

    function findMatchInWindow(spokenWords, startIdx, windowSize, target, targetPhonetic) {
        var end = Math.min(startIdx + windowSize, spokenWords.length);
        for (var si = startIdx; si < end; si++) {
            var r = wordsMatchScore(spokenWords[si], target, targetPhonetic);
            if (r.score > 0) return { spokenIdx: si, score: r.score, method: r.method };
        }
        return null;
    }

    function mergeConfirmedMatches(matchedSet, vadMatchedSet, asrConfirmedSet, scoreMap) {
        scoreMap.forEach(function(score, idx) {
            var existing = matchedSet.get(idx);
            if (existing === undefined || score > existing) {
                matchedSet.set(idx, score);
            }
            if (vadMatchedSet && vadMatchedSet.has(idx) && asrConfirmedSet && !asrConfirmedSet.has(idx)) {
                asrConfirmedSet.add(idx);
            }
        });
    }

    function resetSpokenMatchCache() {
        spokenMetaphoneLRU.reset();
    }

    return {
        editDistance: editDistance,
        doubleMetaphone: doubleMetaphone,
        wordsMatch: wordsMatch,
        wordsMatchScore: wordsMatchScore,
        normalizeWord: normalizeWord,
        normalizeWords: normalizeWords,
        estimateSyllables: estimateSyllables,
        interpolateWordTimings: interpolateWordTimings,
        effectiveMatchScore: effectiveMatchScore,
        computeLineScore: computeLineScore,
        collectSequentialWordMatches: collectSequentialWordMatches,
        findMatchInWindow: findMatchInWindow,
        mergeConfirmedMatches: mergeConfirmedMatches,
        resetSpokenMatchCache: resetSpokenMatchCache
    };
});
