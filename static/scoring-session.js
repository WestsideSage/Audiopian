(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory(require('./scoring.js'), require('./phrase-engine.js'),
                                 require('./scoring-arcade.js'), require('./sync-helpers.js'), root || globalThis);
    } else {
        root.KaraokeeScoringSession = factory(root.KaraokeeScoring, root.KaraokeePhraseEngine,
                                              root.KaraokeeArcade, root, root);
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (scoring, phraseEngine, arcade, sync, root) {
    'use strict';
    function ev(list, type, fields) { fields.type = type; list.push(fields); return list; }

    function createSession(config) {
        var s = {
            lyrics: config.lyrics || [],
            allWordTimings: config.allWordTimings || [],
            phrasePlan: config.phrasePlan || null,
            phraseSession: null,
            arcadeState: null,
            difficulty: config.difficulty || 'medium',
            flags: config.flags || {},
            activeLineIdx: -1, lineWords: [], matchedSet: new Map(),
            vadMatchedSet: new Map(), asrConfirmedSet: new Set(), wordSourceMap: new Map(),
            transcript: '', transcriptWords: [], latestInterim: '',
            lineStartWordCount: 0, lineStartTranscriptPos: 0, lineHadAsrEvent: false,
            isSpeaking: false, hotWordIndex: -1, wordTimings: [],
            currentParams: sync.getWindowParams('normal'),
            weightedTotal: 0, weightedMatched: 0, totalWords: 0, matchedWords: 0,
            linesScored: 0, perfectLines: 0, currentStreak: 0, bestStreak: 0,
            committedPhrases: {}, arcadeEvents: [], prevLine: null, _lineStartAudioTime: null
        };
        if (s.phrasePlan && phraseEngine && phraseEngine.createPhraseSession) {
            s.phraseSession = phraseEngine.createPhraseSession(s.phrasePlan);
        }
        if (s.phrasePlan && arcade && arcade.createArcadeState) {
            s.arcadeState = arcade.createArcadeState(s.difficulty);
        }
        return s;
    }

    // Stubs — filled in by later tasks. Each returns an event list.
    function setActiveLine(s, lineIdx, now) { return []; }
    function ingestFinal(s, text, source) {}
    function ingestInterim(s, text) {}
    function setEnergy(s, isSpeaking) { s.isSpeaking = !!isSpeaking; }
    function tick(s, now) { return []; }
    function endRun(s, now) { return []; }
    function getScores(s) {
        return { weightedTotal: s.weightedTotal, weightedMatched: s.weightedMatched,
                 totalWords: s.totalWords, matchedWords: s.matchedWords, linesScored: s.linesScored,
                 perfectLines: s.perfectLines, currentStreak: s.currentStreak, bestStreak: s.bestStreak };
    }
    function getHonestPct(s) { return null; }

    return { createSession: createSession, setActiveLine: setActiveLine,
             ingestFinal: ingestFinal, ingestInterim: ingestInterim, setEnergy: setEnergy,
             tick: tick, endRun: endRun, getScores: getScores, getHonestPct: getHonestPct };
});
