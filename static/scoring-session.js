(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory(require('./scoring.js'), require('./phrase-engine.js'),
                                 require('./scoring-arcade.js'), require('./sync-helpers.js'),
                                 require('./match-helpers.js'), root || globalThis);
    } else {
        // In the browser, scoring lives on KaraokeeScoring; sync-helpers and
        // match-helpers attach their functions as bare globals on window, so pass
        // `root` for both — the factory resolves them by name with a global fallback.
        root.KaraokeeScoringSession = factory(root.KaraokeeScoring, root.KaraokeePhraseEngine,
                                              root.KaraokeeArcade, root, root, root);
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (scoring, phraseEngine, arcade, sync, match, root) {
    'use strict';
    function ev(list, type, fields) { fields.type = type; list.push(fields); return list; }

    // Resolve a named helper from an injected module, falling back to a global of
    // the same name (browser bare-global helpers). Bound once at factory time.
    function pick(mod, name) {
        if (mod && typeof mod[name] === 'function') return mod[name];
        if (root && typeof root[name] === 'function') return root[name];
        return undefined;
    }
    // scoring.js exports (also browser globals via KaraokeeScoring / window).
    var normalizeWord = pick(scoring, 'normalizeWord');
    var normalizeWords = pick(scoring, 'normalizeWords');
    var wordsMatch = pick(scoring, 'wordsMatch');
    var doubleMetaphone = pick(scoring, 'doubleMetaphone');
    var wordsMatchScore = pick(scoring, 'wordsMatchScore');
    var mergeConfirmedMatches = pick(scoring, 'mergeConfirmedMatches');
    var findMatchInWindow = pick(scoring, 'findMatchInWindow');
    var computeLineScore = pick(scoring, 'computeLineScore');
    // match-helpers exports (browser bare globals).
    var multiWordContractionMatch = pick(match, 'multiWordContractionMatch');
    var phraseMatch = pick(match, 'phraseMatch');
    var FILLER_WORDS = (match && match.FILLER_WORDS) || (root && root.FILLER_WORDS) || new Set();
    // sync-helpers exports (browser bare globals).
    var getSpokenWindowSize = pick(sync, 'getSpokenWindowSize');
    var getWindowParams = pick(sync, 'getWindowParams');

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
            currentParams: getWindowParams('normal'),
            // Controller clock/state surfaced as plain session fields so moved methods
            // evaluate identically: lrcOffset shifts the media clock; _suspended gates
            // the live vad feed (player.js:1423). The session never reads a real clock.
            lrcOffset: config.lrcOffset || 0, _suspended: false,
            whisperBuffer: '', _lineComparisonCount: 0,
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

    // --- Task 1.1: line/session reset (moved from player.js _resetLineState/_resetSessionCounters) ---
    // Transform #1 only (this.->s.); the controller-only fields touched by the
    // original (whisperBuffer, _lineComparisonCount, _lineStartAudioTime) are kept
    // as session state because moved scoring methods consume them.
    function resetLineState(s, lineStartAudioTime, discardPrevLine) {
        s.matchedSet = new Map();
        s.vadMatchedSet = new Map();
        s.asrConfirmedSet = new Set();
        s.wordSourceMap = new Map();
        s.lineStartWordCount = s.transcriptWords.length;
        s.lineStartTranscriptPos = s.lineStartWordCount;
        s.hotWordIndex = -1;
        s.whisperBuffer = '';
        s.lineHadAsrEvent = false;
        s._lineComparisonCount = 0;
        s._lineStartAudioTime = lineStartAudioTime;
        if (discardPrevLine) s.prevLine = null;
    }

    function resetSessionCounters(s) {
        s.activeLineIdx = -1;
        s.lineWords = [];
        resetLineState(s, 0, true);
        s.transcript = '';
        s.transcriptWords = [];
        s.lineStartWordCount = 0;
        s.lineStartTranscriptPos = 0;
        s.latestInterim = '';
        s.totalWords = 0;
        s.matchedWords = 0;
        s.weightedTotal = 0;
        s.weightedMatched = 0;
        if (arcade && arcade.createArcadeState && s.phrasePlan) {
            s.arcadeState = arcade.createArcadeState(s.difficulty);
        }
        s.committedPhrases = {};
        s.arcadeEvents = [];
        s.linesScored = 0;
        s.perfectLines = 0;
        s.currentStreak = 0;
        s.bestStreak = 0;
        s.wordTimings = [];
        s.hotWordIndex = -1;
        s.isSpeaking = false;
    }

    // setActiveLine new-line setup (player.js:1188-1227 non-DOM parts). The outgoing
    // snapshot/score/transition + worklet-port + DOM-span-reset are added in Phase 3.
    function setActiveLine(s, lineIdx, now) {
        var events = [];
        // --- Set up new line ---
        s.activeLineIdx = lineIdx;
        resetLineState(s, (isFinite(now) ? now : 0), false);

        // Load interpolated word timings for this line
        s.wordTimings = (lineIdx >= 0 && lineIdx < s.allWordTimings.length)
            ? s.allWordTimings[lineIdx]
            : [];
        // Load adaptive window params for this line's tempo
        s.currentParams = (s.wordTimings && s.wordTimings.tempoClass)
            ? getWindowParams(s.wordTimings.tempoClass)
            : getWindowParams('normal');

        if (lineIdx < 0 || lineIdx >= s.lyrics.length) {
            s.lineWords = [];
            return events;
        }

        var lineText = (s.lyrics[lineIdx].text || '').trim();
        if (!lineText || lineText === '♪' || lineText === '♫') {
            s.lineWords = [];
            return events;
        }

        var rawWords = lineText.split(' ');
        s.lineWords = rawWords.map(function (w) { return normalizeWord(w); })
                              .filter(function (w) { return w.length > 0; });
        return events;
    }

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

    // Moved from player.js _liveHonestPct (1606-1621): pure read over phraseSession.states.
    function getHonestPct(s) {
        if (!s.phraseSession || !s.phraseSession.states) return null;
        var sumHit = 0, sumReq = 0;
        var states = s.phraseSession.states;
        for (var id in states) {
            var st = states[id];
            if (!st || st.status === 'open') continue;
            var req = (st.phrase && st.phrase.anchorsRequired) || 0;
            if (req <= 0) continue;
            var hit = Object.keys(st.anchorHits).length;
            if (hit > req) hit = req;
            sumHit += hit; sumReq += req;
        }
        if (sumReq === 0) return null;
        return Math.round((sumHit / sumReq) * 100);
    }

    return { createSession: createSession, setActiveLine: setActiveLine,
             ingestFinal: ingestFinal, ingestInterim: ingestInterim, setEnergy: setEnergy,
             tick: tick, endRun: endRun, getScores: getScores, getHonestPct: getHonestPct };
});
