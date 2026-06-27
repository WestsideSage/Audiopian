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
    'whatchu': 'what you',
    'getchu':  'get you',
    'gotchu':  'got you',
    'letchu':  'let you',
    'lemme':   'let me',
    'gimme':   'give me',
    'imma':    'i am going to',
    'aint':    'is not',
};

// --- Homophone pairs ---
// True homophones (acoustically identical) that the metaphone path misses because one
// side is < 3 chars and/or the first letters differ, so the phonetic block's length gate
// and its sameFirst/bothLong sub-condition reject them (e.g. eye/I: both metaphone to
// 'A', but "i" is 1 char and the first letters differ). Registered bidirectionally into
// SLANG_MAP below. Honesty-safe: the two spellings sound identical, so crediting either
// for the other is correct, not cheese (the recognizer just picked the other spelling).
var HOMOPHONE_PAIRS = [
    ['eye', 'i'], ['eye', 'aye'],
    ['by', 'bye'], ['by', 'buy'], ['bye', 'buy'],
    ['be', 'bee'], ['no', 'know'], ['hi', 'high'],
    ['our', 'hour'], ['one', 'won'], ['oh', 'owe'],
    ['in', 'inn'], ['or', 'oar'], ['or', 'ore'],
    ['we', 'wee'], ['ad', 'add'], ['phase', 'faze'],
];

// --- Slang / ASR-mishearing dictionary ---
// Bidirectional: if ASR hears key, it can match value, and vice versa.
// These handle cases where ASR sanitizes, mishears, or normalizes slang.
var SLANG_MAP = {};
(function() {
    var pairs = [
        // Profanity ASR sanitization
        ['nigga', 'n***a'], ['nigga', 'ninja'], ['nigga', 'miga'],
        ['nigga', 'neighbor'], ['niggas', 'ninjas'], ['niggas', 'neighbors'],
        ['shit', 'shoot'], ['shit', 'ship'], ['shit', 'sht'], ['shit', 's***'], ['shit', 'sit'],
        ['fuck', 'fudge'], ['fuck', 'fk'], ['fuck', 'duck'], ['fuck', 'f***'],
        ['fuckin', 'freaking'], ['fucking', 'freaking'],
        ['fucking', 'ducking'], ['fucking', 'f***ing'], ['fucking', 'fing'],
        ['fucked', 'ducked'], ['fucked', 'f***ed'],
        ['ass', 'as'], ['ass', 'a**'],
        ['bitch', 'beach'], ['bitch', 'b***h'], ['bitch', 'witch'],
        ['bitches', 'beaches'], ['damn', 'dang'], ['hell', 'heck'],
        ['hoe', 'ho'], ['hoes', 'hos'],
        ['dick', 'rick'], ['dick', 'd***'],
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
        ['0', 'zero'], ['1', 'one'], ['2', 'two'], ['3', 'three'],
        ['4', 'four'], ['5', 'five'], ['6', 'six'], ['7', 'seven'],
        ['8', 'eight'], ['9', 'nine'], ['10', 'ten'],
        ['11', 'eleven'], ['12', 'twelve'], ['13', 'thirteen'],
        ['20', 'twenty'], ['30', 'thirty'], ['38', 'thirtyeight'],
        ['40', 'forty'], ['48', 'fortyeight'], ['50', 'fifty'],
        ['100', 'hundred'], ['911', 'nineoneone'],
        ['to', 'two'], ['too', 'two'], ['for', 'four'],
    ];
    pairs = pairs.concat(HOMOPHONE_PAIRS);   // homophones share the same bidirectional registration
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

// --- ASR-mishearing dictionary (target-directional) ---
// Unlike SLANG_MAP (bidirectional), this is keyed by the LYRIC word -> the set of
// tokens the recognizer is known to emit when that word is sung with non-standard
// stress. It fires ONLY when the lyric target is a registered key, so a curated
// substitution can credit the real word without polluting other songs: e.g. a
// drawn-out 2-beat "Go-rilla" is transcribed by Web Speech as "really" (metaphone
// RL vs gorilla's KRL — too far for the phonetic/edit paths). Honesty-safe because
// the bridge is one-directional: "really" can credit "gorilla" only on a line whose
// lyric is literally "gorilla"; it never credits a "really" lyric (exact handles
// those), and singing "gorilla" never credits "really". Add new entries here.
var ASR_MISHEARINGS = {
    gorilla: ['really'],   // drawn-out "Go-rilla" -> Web Speech hears "really"
};

/**
 * Check if a recognizer-mishearing of the lyric target should be credited.
 * Target-directional: only fires when `target` is a registered lyric key.
 */
function mishearingMatch(spoken, target) {
    var subs = ASR_MISHEARINGS[target];
    return !!(subs && subs.indexOf(spoken) !== -1);
}

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
 * Symmetric in both directions:
 *  - spoken is the contraction, target is the first word of its expansion
 *    (spoken="gonna", target="going").
 *  - target is the contraction, spoken is the first word of its expansion
 *    (spoken="want", target="wanna"). The recognizer splits a sung contraction
 *    into its expansion ("wanna" -> "want to") and the leading word arrives one
 *    interim before the rest, so it must credit the target on its own.
 */
function contractionsMatch(spoken, target) {
    var expansion = CONTRACTION_MAP[spoken];
    if (expansion && expansion.split(' ')[0] === target) return true;

    // Reverse: target is a multi-word contraction; spoken is its expansion's
    // leading word. Restricted to multi-word expansions because only those have
    // the recognizer-splits-then-streams-incrementally problem ("want to"); a
    // single-word slang expansion (e.g. wit->with) is already handled elsewhere.
    var targetExpansion = CONTRACTION_MAP[target];
    if (targetExpansion && targetExpansion.indexOf(' ') !== -1 &&
        targetExpansion.split(' ')[0] === spoken) return true;

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
    // Hyphenated interjections collapse to one token once the hyphen is stripped
    // ("Uh-oh" -> "uhoh"), so they slip past the single-word entries above and
    // would otherwise be scored as required `core` anchors the recognizer can
    // never satisfy. Keep them free (weight 0) like every other interjection.
    'uhoh', 'uhhuh', 'uhuh', 'ohoh',
]);

// adlib = 0 ("free"): non-lexical ad-libs/fillers ("uh", "hm", "oh", "yeah", and
// anything in parentheses) are essentially never returned by speech recognizers, so
// they're structurally unwinnable — they must neither help nor hurt the score.
var WORD_WEIGHTS = { core: 1.0, function: 0.5, adlib: 0 };

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

/**
 * Returns true only when the spoken word is a pure ASR trailing-truncation of the target:
 * target must start with spoken AND exactly 1 trailing character is missing.
 * Used to gate edit-distance-2 matches so false positives like "less→lesson" are rejected
 * while genuine truncations like "singin→singing" are accepted.
 * @param {string} spoken
 * @param {string} target
 * @returns {boolean}
 */
function isEdit2PrefixTruncation(spoken, target) {
    if (spoken.length >= target.length) return false;       // spoken must be shorter
    if (target.length - spoken.length !== 1) return false; // exactly 1 char missing
    return target.startsWith(spoken);
}

// Build a deduplicated vocabulary string from lyric lines, for biasing the realtime
// recognizer toward the song's words (a spelling hint). Deduped and stripped of short
// common words, and NOT the lyric sequence — it nudges spelling of uncommon words without
// handing the model the next expected word to predict (which would inflate honesty rather
// than transcribe). Capped (with no partial trailing word) for the realtime prompt budget.
function buildLyricVocabulary(lyrics, maxChars) {
    maxChars = maxChars || 800;
    var seen = {};
    var vocab = [];
    for (var i = 0; i < (lyrics ? lyrics.length : 0); i++) {
        var text = (lyrics[i] && lyrics[i].text) || '';
        var words = String(text).split(/\s+/);
        for (var w = 0; w < words.length; w++) {
            var word = words[w].toLowerCase().replace(/[^a-z']/g, '');
            if (word.length < 4) continue;          // skip short common words (already well-recognized)
            if (seen[word]) continue;
            seen[word] = true;
            vocab.push(word);
        }
    }
    var out = vocab.join(' ');
    return out.length > maxChars ? out.slice(0, maxChars).replace(/\s+\S*$/, '') : out;
}

// Node.js exports for testing; browser ignores this
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        buildLyricVocabulary: buildLyricVocabulary,
        CONTRACTION_MAP: CONTRACTION_MAP,
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
        ASR_MISHEARINGS: ASR_MISHEARINGS,
        mishearingMatch: mishearingMatch,
        FUNCTION_WORDS: FUNCTION_WORDS,
        ADLIB_WORDS: ADLIB_WORDS,
        WORD_WEIGHTS: WORD_WEIGHTS,
        classifyWord: classifyWord,
        isEdit2PrefixTruncation: isEdit2PrefixTruncation,
    };
}
