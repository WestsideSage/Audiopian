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

// Node.js exports for testing; browser ignores this
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        CONTRACTION_MAP: CONTRACTION_MAP,
        REVERSE_CONTRACTION_MAP: REVERSE_CONTRACTION_MAP,
        contractionsMatch: contractionsMatch,
        multiWordContractionMatch: multiWordContractionMatch,
    };
}
