/**
 * Match-helpers: contraction matching, phrase matching, and filler skipping.
 * Loaded before player.js via <script> tag.
 */

// --- Contraction Map (moved from player.js) ---
var CONTRACTION_MAP = {
    'gonna':   'going to',
    'wanna':   'want to',
    'gotta':   'got to',
    'kinda':   'kind of',
    'sorta':   'sort of',
    'coulda':  'could have',
    'shoulda': 'should have',
    'woulda':  'would have',
    'ima':     'i am going to',
    'tryna':   'trying to',
    'dunno':   'do not know',
    "ain't":   'is not',
    'ain':     'is not',
    "y'all":   'you all',
    'yall':    'you all',
    'finna':   'fixing to',
    'bouta':   'about to',
    'outta':   'out of',
    'lotta':   'lot of',
    'cmon':    'come on',
    'nah':     'no',
    'bruh':    'brother',
    'bro':     'brother',
    'fam':     'family',
    'fasho':   'for sure',
    'fosho':   'for sure',
    'sho':     'sure',
    'deadass': 'seriously',
    'lowkey':  'low key',
    'highkey': 'high key',
    'ong':     'on god',
    'fr':      'for real',
    'ngl':     'not gonna lie',
    'rn':      'right now',
    'smh':     'shaking my head',
    'aight':   'alright',
    'ight':    'alright',
    'prolly':  'probably',
    'sumn':    'something',
    'sumthin': 'something',
    'nothin':  'nothing',
    'nuthin':  'nothing',
    'cuz':     'because',
    'cus':     'because',
    'wit':     'with',
    'da':      'the',
    'dem':     'them',
    'dey':     'they',
    'dat':     'that',
    'dis':     'this',
    'em':      'them',
    'til':     'until',
    'bout':    'about',
    'ops':     'opposition',
    'lil':     'little',
};

// --- Slang / ASR-mishearing dictionary ---
// Bidirectional: if ASR hears key, it can match value, and vice versa.
// These handle cases where ASR sanitizes, mishears, or normalizes slang.
var SLANG_MAP = {};
(function() {
    var pairs = [
        // Profanity ASR sanitization
        ['nigga', 'n***a'], ['nigga', 'ninja'], ['nigga', 'miga'],
        ['niggas', 'ninjas'], ['shit', 'shoot'], ['shit', 'ship'],
        ['fuck', 'fudge'], ['fuck', 'fk'], ['fuckin', 'freaking'],
        ['fucking', 'freaking'], ['ass', 'as'], ['bitch', 'beach'],
        ['bitches', 'beaches'], ['damn', 'dang'], ['hell', 'heck'],
        // Common ASR mishearings
        ['ya', 'you'], ['yo', 'you'], ['yuh', 'yeah'],
        ['nah', 'no'], ['na', 'no'], ['aye', 'hey'],
        ['em', 'them'], ['im', "i'm"], ['ur', 'your'],
        ['cuz', 'because'], ['cause', 'because'],
        ['bout', 'about'], ['wit', 'with'],
        ['da', 'the'], ['tha', 'the'],
        ['dat', 'that'], ['dis', 'this'],
        ['dem', 'them'], ['dey', 'they'],
        ['lil', 'little'], ['til', 'until'],
        // Ad-lib / interjection normalization
        ['ooh', 'oh'], ['oooh', 'oh'], ['ooo', 'oh'],
        ['ahh', 'ah'], ['ahhh', 'ah'],
        ['yeah', 'yea'], ['yea', 'yeah'],
        ['huh', 'ha'], ['hmm', 'hm'],
        ['ayy', 'hey'], ['ey', 'hey'], ['ay', 'hey'],
        ['woo', 'whoo'], ['woah', 'whoa'],
        // Numbers / abbreviations
        ['2', 'two'], ['to', 'two'], ['too', 'two'],
        ['4', 'four'], ['for', 'four'],
    ];
    for (var i = 0; i < pairs.length; i++) {
        var a = pairs[i][0], b = pairs[i][1];
        if (!SLANG_MAP[a]) SLANG_MAP[a] = new Set();
        SLANG_MAP[a].add(b);
        if (!SLANG_MAP[b]) SLANG_MAP[b] = new Set();
        SLANG_MAP[b].add(a);
    }
})();

/**
 * Check if spoken word matches target via slang/ASR-mishearing dictionary.
 * Returns true if spoken is a known synonym of target.
 */
function slangMatch(spoken, target) {
    var alts = SLANG_MAP[spoken];
    return !!(alts && alts.has(target));
}

// --- Reverse Contraction Map (auto-generated) ---
var REVERSE_CONTRACTION_MAP = {};
(function() {
    var seen = {};
    for (var contraction in CONTRACTION_MAP) {
        var expansion = CONTRACTION_MAP[contraction];
        if (!seen[expansion]) {
            REVERSE_CONTRACTION_MAP[expansion] = contraction;
            seen[expansion] = true;
        }
    }
})();

// Pre-split expansions for multi-word matching lookups
var _expansionIndex = {};
(function() {
    for (var contraction in CONTRACTION_MAP) {
        var words = CONTRACTION_MAP[contraction].split(' ');
        if (words.length >= 2) {
            if (!_expansionIndex[words[0]]) _expansionIndex[words[0]] = [];
            _expansionIndex[words[0]].push({ words: words, contraction: contraction });
        }
    }
    for (var key in _expansionIndex) {
        _expansionIndex[key].sort(function(a, b) { return b.words.length - a.words.length; });
    }
})();

/**
 * Check if a spoken word matches a target word via contraction expansion.
 * Handles the case where spoken="gonna" and target="going" (first word of expansion).
 */
function contractionsMatch(spoken, target) {
    var expansion = CONTRACTION_MAP[spoken];
    if (expansion) {
        var expWords = expansion.split(' ');
        if (expWords[0] === target) return true;
    }
    return false;
}

/**
 * Try to match a multi-word spoken sequence against a single target contraction.
 * Returns number of spoken words consumed (0 = no match).
 */
function multiWordContractionMatch(spokenWords, startIdx, target) {
    var firstWord = spokenWords[startIdx];
    var candidates = _expansionIndex[firstWord];
    if (!candidates) return 0;

    for (var c = 0; c < candidates.length; c++) {
        var entry = candidates[c];
        if (entry.contraction !== target) continue;
        if (startIdx + entry.words.length > spokenWords.length) continue;
        var match = true;
        for (var w = 0; w < entry.words.length; w++) {
            if (spokenWords[startIdx + w] !== entry.words[w]) { match = false; break; }
        }
        if (match) return entry.words.length;
    }
    return 0;
}

// --- Equivalent Phrase Map ---
var _PHRASE_PAIRS = [
    ['alright', 'all right'],
    ['altogether', 'all together'],
    ['everyday', 'every day'],
    ['everyone', 'every one'],
    ['everything', 'every thing'],
    ['cannot', 'can not'],
    ['into', 'in to'],
    ['onto', 'on to'],
    ['anymore', 'any more'],
    ['anyone', 'any one'],
    ['anyway', 'any way'],
    ['outside', 'out side'],
    ['tonight', 'to night'],
    ['without', 'with out'],
    ['maybe', 'may be'],
    ['goodbye', 'good bye'],
    ['throughout', 'through out'],
    ['wherever', 'where ever'],
    ['whatever', 'what ever'],
    ['whenever', 'when ever'],
];

var PHRASE_EQUIV_MAP = {};
(function() {
    for (var i = 0; i < _PHRASE_PAIRS.length; i++) {
        PHRASE_EQUIV_MAP[_PHRASE_PAIRS[i][0]] = _PHRASE_PAIRS[i][1];
        PHRASE_EQUIV_MAP[_PHRASE_PAIRS[i][1]] = _PHRASE_PAIRS[i][0];
    }
})();

var _phraseIndex = {};
(function() {
    for (var key in PHRASE_EQUIV_MAP) {
        var words = key.split(' ');
        if (words.length >= 2) {
            if (!_phraseIndex[words[0]]) _phraseIndex[words[0]] = [];
            _phraseIndex[words[0]].push({ words: words, equiv: PHRASE_EQUIV_MAP[key] });
        }
    }
    for (var k in _phraseIndex) {
        _phraseIndex[k].sort(function(a, b) { return b.words.length - a.words.length; });
    }
})();

function phraseMatch(spokenWords, spokenIdx, targetWords, targetIdx) {
    var spokenWord = spokenWords[spokenIdx];
    var targetWord = targetWords[targetIdx];

    // Direction 1: multiple spoken words → single target word
    var spokenCandidates = _phraseIndex[spokenWord];
    if (spokenCandidates) {
        for (var i = 0; i < spokenCandidates.length; i++) {
            var entry = spokenCandidates[i];
            if (spokenIdx + entry.words.length > spokenWords.length) continue;
            var match = true;
            for (var w = 0; w < entry.words.length; w++) {
                if (spokenWords[spokenIdx + w] !== entry.words[w]) { match = false; break; }
            }
            if (match && entry.equiv === targetWord) {
                return { spokenConsumed: entry.words.length, targetConsumed: 1 };
            }
        }
    }

    // Direction 2: single spoken word → multiple target words
    var equivOfSpoken = PHRASE_EQUIV_MAP[spokenWord];
    if (equivOfSpoken) {
        var equivWords = equivOfSpoken.split(' ');
        if (equivWords.length >= 2 && targetIdx + equivWords.length <= targetWords.length) {
            var match2 = true;
            for (var w2 = 0; w2 < equivWords.length; w2++) {
                if (targetWords[targetIdx + w2] !== equivWords[w2]) { match2 = false; break; }
            }
            if (match2) {
                return { spokenConsumed: 1, targetConsumed: equivWords.length };
            }
        }
    }

    return null;
}

var FILLER_WORDS = new Set(['uh', 'um', 'ah', 'er', 'hm', 'hmm', 'mhm', 'ugh']);

// --- Word classification for weighted scoring ---
var FUNCTION_WORDS = new Set([
    'a', 'an', 'the', 'i', 'me', 'my', 'we', 'us', 'our',
    'you', 'your', 'he', 'him', 'his', 'she', 'her',
    'it', 'its', 'they', 'them', 'their',
    'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
    'in', 'on', 'at', 'to', 'of', 'for', 'with', 'by', 'from',
    'and', 'or', 'but', 'so', 'if', 'as', 'than', 'that',
    'do', 'does', 'did', 'has', 'have', 'had',
    'not', 'no', 'up', 'out',
]);

var ADLIB_WORDS = new Set([
    'ooh', 'oh', 'ah', 'uh', 'yeah', 'yea', 'hey', 'huh',
    'wow', 'woo', 'whoo', 'whoa', 'woah', 'ayy', 'aye', 'ay',
    'la', 'na', 'da', 'ba', 'sha', 'ra',
    'hmm', 'hm', 'mm', 'mmm',
    'oo', 'ooo', 'oooh', 'ahh', 'ahhh',
    'skrrt', 'brr', 'grr', 'pew', 'pow', 'bang',
    'yuh', 'yah', 'aye',
]);

var WORD_WEIGHTS = { core: 1.0, function: 0.5, adlib: 0.25 };

/**
 * Classify a word for scoring weight.
 * @param {string} normalizedWord - already lowercased, punctuation-stripped
 * @param {boolean} inParentheses - true if the word was inside parentheses in the original lyric
 * @returns {'core'|'function'|'adlib'}
 */
function classifyWord(normalizedWord, inParentheses) {
    if (inParentheses) return 'adlib';
    if (ADLIB_WORDS.has(normalizedWord)) return 'adlib';
    if (FUNCTION_WORDS.has(normalizedWord)) return 'function';
    return 'core';
}

function maxEditDistance(len) {
    if (len <= 6) return 1;
    return 2;
}

function skipFuzzyMatch(word) {
    return word.length <= 2;
}

function MetaphoneLRU(capacity) {
    this._capacity = capacity || 50;
    this._cache = new Map();
}

MetaphoneLRU.prototype.get = function(word) {
    if (this._cache.has(word)) {
        var val = this._cache.get(word);
        this._cache.delete(word);
        this._cache.set(word, val);
        return val;
    }
    var result = (typeof doubleMetaphone === 'function') ? doubleMetaphone(word) : [word, ''];
    if (this._cache.size >= this._capacity) {
        var oldest = this._cache.keys().next().value;
        this._cache.delete(oldest);
    }
    this._cache.set(word, result);
    return result;
};

MetaphoneLRU.prototype.reset = function() {
    this._cache.clear();
};

// Node.js exports for testing; browser ignores this
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        CONTRACTION_MAP: CONTRACTION_MAP,
        REVERSE_CONTRACTION_MAP: REVERSE_CONTRACTION_MAP,
        contractionsMatch: contractionsMatch,
        multiWordContractionMatch: multiWordContractionMatch,
        PHRASE_EQUIV_MAP: PHRASE_EQUIV_MAP,
        phraseMatch: phraseMatch,
        FILLER_WORDS: FILLER_WORDS,
        maxEditDistance: maxEditDistance,
        skipFuzzyMatch: skipFuzzyMatch,
        MetaphoneLRU: MetaphoneLRU,
        SLANG_MAP: SLANG_MAP,
        slangMatch: slangMatch,
        FUNCTION_WORDS: FUNCTION_WORDS,
        ADLIB_WORDS: ADLIB_WORDS,
        WORD_WEIGHTS: WORD_WEIGHTS,
        classifyWord: classifyWord,
    };
}
