/**
 * Pure helper: pick the best browser Speech-Recognition alternative for a final result.
 *
 * Chrome's Web Speech returns up to `maxAlternatives` transcriptions of the SAME audio
 * for a final result. The app only ever read alt[0] and discarded the rest. When the
 * recognizer's top guess fumbles a word it actually sang (e.g. alt[0]="tasteful" for
 * "distasteful"), the correct word is often sitting in alt[1]/alt[2].
 *
 * This helper picks, among those real hypotheses, the one that matches the most of the
 * line we're currently hoping to hear — but ONLY switches away from alt[0] when an
 * alternative matches STRICTLY more expected words. So:
 *   - it can never invent a word the singer didn't vocalize (alternatives are bounded by
 *     the actual audio), and
 *   - if nothing matches the expected line (humming / wrong words / silence), it returns
 *     alt[0] unchanged — no honesty bias.
 * The chosen transcript still flows through the full timing/anchor/consume-gated matcher
 * downstream; this only widens the recognizer's OUTPUT, it does not loosen the gate.
 *
 * No DOM / wall-clock / randomness — testable in Node.js. The lexical matcher is INJECTED
 * (`matchFn`) so this stays pure and decoupled from scoring.js.
 */
(function (root) {
    function toText(alt) {
        if (typeof alt === 'string') return alt;
        return (alt && alt.transcript) || '';
    }

    // Local normalize: lowercase, strip punctuation, split on whitespace. Mirrors
    // scoring.normalizeWord closely enough for token comparison; kept inline so the
    // helper has no scoring.js dependency.
    function tokens(text) {
        return String(text || '')
            .toLowerCase()
            .replace(/[^a-z0-9'\s]/g, ' ')
            .split(/\s+/)
            .filter(function (w) { return w.length > 0; });
    }

    function expectedMatchCount(text, expectedWords, matchFn) {
        var toks = tokens(text);
        var score = 0;
        for (var i = 0; i < toks.length; i++) {
            for (var j = 0; j < expectedWords.length; j++) {
                if (matchFn(toks[i], expectedWords[j])) { score++; break; }
            }
        }
        return score;
    }

    /**
     * @param {Array<string|{transcript:string}>} alternatives - recognizer hypotheses (alt[0] = top).
     * @param {string[]} expectedWords - normalized words of the line we hope to hear.
     * @param {(spoken:string, expected:string)=>boolean} matchFn - lexical matcher (e.g. KaraokeeScoring.wordsMatch).
     * @returns {string} the chosen transcript (verbatim). alt[0] unless an alternative strictly beats it.
     */
    function pickBestTranscript(alternatives, expectedWords, matchFn) {
        if (!alternatives || alternatives.length === 0) return '';
        var top = toText(alternatives[0]);
        if (alternatives.length === 1) return top;
        if (!expectedWords || expectedWords.length === 0 || typeof matchFn !== 'function') return top;

        var bestText = top;
        var bestScore = expectedMatchCount(top, expectedWords, matchFn);
        for (var i = 1; i < alternatives.length; i++) {
            var text = toText(alternatives[i]);
            var score = expectedMatchCount(text, expectedWords, matchFn);
            if (score > bestScore) {   // STRICT: ties keep the earlier (recognizer-preferred) pick
                bestScore = score;
                bestText = text;
            }
        }
        return bestText;
    }

    var api = { pickBestTranscript: pickBestTranscript };
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    root.KaraokeeAlternatives = api;
})(typeof window !== 'undefined' ? window : globalThis);
