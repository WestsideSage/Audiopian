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

    // Moved from player.js _setWordSource (753-761): source-rank bookkeeping. Pure.
    function setWordSource(s, wordIndex, source) {
        if (wordIndex === undefined || wordIndex === null || wordIndex < 0) return;
        var rank = { vad: 1, browser_sr: 2, whisper: 3 };
        var existing = s.wordSourceMap.get(wordIndex);
        if (!existing || (rank[source] || 0) >= (rank[existing] || 0)) {
            s.wordSourceMap.set(wordIndex, source);
        }
    }

    // Moved from player.js _addPhraseEvidence (1445-1466). Transform #2: audio.currentTime
    // -> now. Transform #3: each _paintPhraseCleared(...) -> phraseCleared event. The
    // browser_final/whisper late-evidence reconcile branch is preserved verbatim; the
    // vad-source feed (from the hot-word path) only adds evidence + settles (its source
    // is 'vad', so it never enters the reconcile branch). These vad flowEvents are what
    // the interim-reconcile energy gate (phrase-engine hasInWindowFlow) checks.
    function addPhraseEvidence(s, evidence, now, events) {
        if (!s.phraseSession || !phraseEngine) return;
        try {
            var nowSec = isFinite(now) ? now : 0;
            phraseEngine.addEvidence(s.phraseSession, evidence);
            phraseEngine.settlePhrases(s.phraseSession, nowSec);
            if (evidence.source === 'browser_final' || evidence.source === 'whisper') {
                var confirmed = phraseEngine.reconcileLateEvidence(s.phraseSession, evidence, nowSec);
                if (confirmed && confirmed.length && s.flags.KARAOKEE_V2) {
                    for (var ci = 0; ci < confirmed.length; ci++) {
                        ev(events, 'phraseCleared', { phraseId: confirmed[ci] });
                    }
                }
            }
        } catch (e) {
            // swallow (mirrors controller's console.warn-and-continue)
        }
    }

    // Moved from player.js _matchHotWord (1498-1533). Transform #1: this.->s.
    // Transform #3: the vad-confirmed _logMatch (1525-1527) -> wordMatched event;
    // _setWordSource -> setWordSource(s,...). Energy gate preserved verbatim: when
    // silent, edit-distance-only matches are skipped. Returns true if matched.
    function matchHotWord(s, transcript, now, events) {
        if (s.hotWordIndex < 0 || s.hotWordIndex >= s.lineWords.length) return false;
        if (s.asrConfirmedSet.has(s.hotWordIndex)) return false; // already fully confirmed by ASR

        var target = s.lineWords[s.hotWordIndex];
        var targetPhonetic = s.wordTimings[s.hotWordIndex] ? s.wordTimings[s.hotWordIndex].phonetic : undefined;
        var spoken = normalizeWords(transcript);

        var searchStart = Math.max(s.lineStartTranscriptPos, spoken.length - 10);
        for (var i = searchStart; i < spoken.length; i++) {
            if (wordsMatch(spoken[i], target, targetPhonetic)) {
                // Energy gate: if not speaking, require exact or phonetic match (not edit-distance)
                if (!s.isSpeaking) {
                    if (spoken[i] !== target) {
                        var sp = doubleMetaphone(spoken[i]);
                        var tp = doubleMetaphone(target);
                        var phonetic = sp[0] && tp[0] && (sp[0] === tp[0] || sp[0] === tp[1] || (sp[1] && (sp[1] === tp[0] || sp[1] === tp[1])));
                        if (!phonetic) continue; // skip edit-distance-only matches when silent
                    }
                }
                s.matchedSet.set(s.hotWordIndex, 1.0);
                setWordSource(s, s.hotWordIndex, 'browser_sr');
                if (s.vadMatchedSet.has(s.hotWordIndex)) {
                    s.asrConfirmedSet.add(s.hotWordIndex);
                    setWordSource(s, s.hotWordIndex, 'browser_sr');
                    ev(events, 'wordMatched', {
                        lineIdx: s.activeLineIdx, wordIndex: s.hotWordIndex,
                        spokenWord: spoken[i], targetWord: target, method: 'vad-confirmed',
                        editDistance: -1, phoneticMatch: false, score: 1.0, matched: true,
                        windowPosition: s.hotWordIndex, source: 'browser_sr'
                    });
                }
                return true;
            }
        }
        return false;
    }

    // Recompute the hot word + run the isSpeaking-gated VAD optimistic feed, then
    // attempt a hot-word match against the accumulated transcript+interim. Moved from
    // updateHotWord hot-index logic (player.js:1401-1442) + the SR-handler's
    // _matchHotWord call (423). Transform #2: audio.currentTime -> now. The VAD branch
    // (1423-1442) feeds vad-source evidence ONLY when s.isSpeaking — these flowEvents
    // gate interim reconciliation. The vad-provisional _logMatch (1429-1433) -> event.
    function updateHotWordAndMatch(s, now, events) {
        if (!s.wordTimings || s.wordTimings.length === 0) {
            s.hotWordIndex = -1;
            return;
        }
        var t = (isFinite(now) ? now : 0) - s.lrcOffset;
        var newHot = -1;
        for (var i = 0; i < s.wordTimings.length; i++) {
            if (s.matchedSet.has(i)) continue; // skip already-green words
            var wt = s.wordTimings[i];
            var winOpen = (s.wordTimings.useVad) ? (wt.estimatedTime - 0.05) : wt.windowStart;
            if (t >= winOpen && t <= wt.windowEnd) {
                newHot = i;
                break;  // first unmatched window wins
            }
        }
        s.hotWordIndex = newHot;

        // VAD optimistic scoring: provisional amber + vad flow-event evidence, gated on
        // isSpeaking (this is the 06dfde5 energy gate's flow source).
        if (newHot >= 0 && s.isSpeaking && s.wordTimings.useVad && !s._suspended) {
            if (!s.matchedSet.has(newHot)) {
                s.matchedSet.set(newHot, 0.25);       // provisional — amber; upgradeable by ASR
                s.vadMatchedSet.set(newHot, 0.25);
                setWordSource(s, newHot, 'vad');
                ev(events, 'wordMatched', {
                    lineIdx: s.activeLineIdx, wordIndex: newHot,
                    spokenWord: s.wordTimings[newHot] ? s.wordTimings[newHot].word : '',
                    targetWord: s.lineWords[newHot] || '', method: 'vad-provisional',
                    editDistance: -1, phoneticMatch: false, score: 0.25, matched: true,
                    windowPosition: newHot, source: 'vad'
                });
                addPhraseEvidence(s, {
                    source: 'vad',
                    text: '',
                    words: [],
                    receivedAtSec: now,
                    audioTimeSec: isFinite(now) ? now : null
                }, now, events);
            }
        }

        // Hot-word priority match against the accumulated transcript + interim. The SR
        // handler used `transcript + interim` (no space; finals self-terminate with a
        // trailing space). Mirror that concatenation here.
        var hotMatched = matchHotWord(s, (s.transcript || '') + (s.latestInterim || ''), now, events);
        if (hotMatched) ev(events, 'wordSpans', {});
    }

    function ingestFinal(s, text, source) {}
    // Moved from player.js SR onresult (399, 413): latest interim is stored verbatim
    // and any ASR event marks the line as having had ASR activity.
    function ingestInterim(s, text) {
        s.latestInterim = text || '';
        s.lineHadAsrEvent = true;
    }
    function setEnergy(s, isSpeaking) { s.isSpeaking = !!isSpeaking; }
    function tick(s, now) {
        var events = [];
        updateHotWordAndMatch(s, now, events);
        return events;
    }
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
