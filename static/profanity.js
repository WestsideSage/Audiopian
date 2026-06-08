/**
 * Pure helper: profanity classification + display masking for Clean mode.
 * No DOM / wall-clock / randomness — testable in Node.js. UMD (browser <script> + require()).
 *
 * - isProfane(word): clean-mode set (strong words + slurs, INCLUDING the song-standard
 *   "-a" n-word variant). Excludes mild words (damn/hell/ass). Used to exclude key words
 *   and to mask the displayed lyrics in clean mode.
 * - isNeverScore(word): strict subset = the hard-R n-word variant(s) only. Applied in ALL
 *   modes (never an anchor, never credits) — a content-policy guard.
 * - censorWord / censorLine: display masking only (scoring uses the raw normalized words).
 */
(function (root) {
    'use strict';
    function set(list) { var o = {}; for (var i = 0; i < list.length; i++) o[list[i]] = true; return o; }

    // Song-standard "-a" n-word variant: censored/excluded in clean mode, but a normal
    // creditable key word in explicit mode (the hard-R policy lives in NEVER_SCORE below).
    var N_A = ['nigga', 'niggas'];

    var PROFANE = set([
        'fuck', 'fucks', 'fucked', 'fuckin', 'fucking', 'fucker', 'fuckers', 'fuckboy',
        'motherfucker', 'motherfuckers', 'motherfuckin', 'motherfucking',
        'shit', 'shits', 'shitted', 'shitting', 'shitty', 'bullshit',
        'bitch', 'bitches', 'bitchin', 'bitching',
        'dick', 'dicks', 'cock', 'cocks', 'pussy', 'pussies', 'cunt', 'cunts',
        'whore', 'whores', 'slut', 'sluts', 'twat',
        'faggot', 'faggots', 'fag', 'fags'
    ].concat(N_A));

    // Hard-R variant(s) — DERIVED from the -a entries (trailing vowel -> "-er") so the slur
    // is never spelled literally in source. Never an anchor, never credits, in ANY mode.
    var NEVER_SCORE = set(N_A.map(function (w) { return w.replace(/a(s?)$/, 'er$1'); }));
    Object.keys(NEVER_SCORE).forEach(function (w) { PROFANE[w] = true; }); // also censored in clean mode

    function norm(word) { return String(word || '').toLowerCase().replace(/[^a-z]/g, ''); }

    function isProfane(word) { return !!PROFANE[norm(word)]; }
    function isNeverScore(word) { return !!NEVER_SCORE[norm(word)]; }

    // Keep the first character, replace remaining letters with '*', preserve other chars.
    function censorWord(word) {
        var w = String(word || '');
        if (w.length <= 1) return w;
        return w.charAt(0) + w.slice(1).replace(/[A-Za-z]/g, '*');
    }

    // Mask only profane tokens; preserve original whitespace.
    function censorLine(text) {
        return String(text || '').split(/(\s+)/).map(function (tok) {
            return isProfane(tok) ? censorWord(tok) : tok;
        }).join('');
    }

    var api = {
        isProfane: isProfane, isNeverScore: isNeverScore,
        censorWord: censorWord, censorLine: censorLine,
        PROFANE: PROFANE, NEVER_SCORE: NEVER_SCORE
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.KaraokeeProfanity = api;
})(typeof window !== 'undefined' ? window : globalThis);
