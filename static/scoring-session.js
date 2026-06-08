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
    var getAdjustedOverlapDuration = pick(sync, 'getAdjustedOverlapDuration');
    var getScoreDelay = pick(sync, 'getScoreDelay');

    function createSession(config) {
        var s = {
            lyrics: config.lyrics || [],
            allWordTimings: config.allWordTimings || [],
            phrasePlan: config.phrasePlan || null,
            phraseSession: null,
            arcadeState: null,
            difficulty: config.difficulty || 'medium',
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

    // Seek primitive: discard the CURRENT line's accumulated match state and realign the
    // transcript fence to NOW, WITHOUT scoring the line or snapshotting a prevLine. Used
    // when the playhead jumps (seek) so pre-seek transcript/interim cannot credit the
    // post-seek position. Keeps activeLineIdx/lineWords (a same-line backward seek stays
    // on the line; the singer re-sings from the seek point). lineHadAsrEvent is cleared,
    // so if a boundary-crossing seek then triggers setActiveLine, the seeked-away line
    // hits scoreLine's zero-ASR fence and is not scored.
    function resetActiveLine(s, now) {
        resetLineState(s, isFinite(now) ? now : 0, true);  // clear match sets + realign fence + drop prevLine
        s.latestInterim = '';                               // drop stale pre-seek interim
    }

    // Full setActiveLine transition (player.js:1099-1236 with three transforms).
    // Order preserved exactly: (1) finalize existing prevLine overlay, (2) outgoing
    // final pass BEFORE resetLineState (deferral-closure #1: credits a pre-boundary
    // final to the outgoing line), (3) build prevLine overlay with overlapEnd in media
    // seconds (NOT wall-clock ms) — setTimeout DELETED (tick-driven), (4) transition
    // diagnostic event, (5) resetLineState + new-line setup with chunkTempo and
    // resetSpans events (DOM/port calls DELETED).
    function setActiveLine(s, lineIdx, now) {
        var events = [];
        var nowSec = isFinite(now) ? now : 0;

        // Capture outgoing state for diagnostics BEFORE anything changes.
        var _dbgFromIdx  = s.activeLineIdx;
        var _dbgFromText = (_dbgFromIdx >= 0 && s.lyrics[_dbgFromIdx])
            ? s.lyrics[_dbgFromIdx].text : '—';

        // --- Soft boundary: finalize any existing prevLine overlay ---
        // (player.js:1106) If there's already a prevLine, finalize it first (fast succession).
        finalizePrevLine(s, nowSec, events);

        // --- Outgoing final pass (player.js:1110-1122): BEFORE resetLineState ---
        // Run the last available browser transcript/interim pass before snapshotting.
        // This is deferral-closure #1: credits a pre-boundary final to the outgoing line.
        if (s.lineWords.length > 0 && (s.transcript || s.latestInterim)) {
            var finalMap = new Map();
            collectMatches(s, (s.transcript || '') + ' ' + (s.latestInterim || ''), finalMap, nowSec, events);
            var finalBeforeConfirmed = new Set(s.asrConfirmedSet);
            mergeConfirmedMatches(s.matchedSet, s.vadMatchedSet, s.asrConfirmedSet, finalMap);
            finalMap.forEach(function (score, i) {
                if (!finalBeforeConfirmed.has(i) && s.asrConfirmedSet.has(i)) {
                    ev(events, 'promotion', { source: 'browser_sr', wordIndex: i, score: score });
                }
                setWordSource(s, i, 'browser_sr');
            });
            ev(events, 'wordSpans', {});
        }

        // --- Build prevLine overlay (player.js:1124-1148) ---
        // overlapEnd stored as MEDIA SECONDS (now + duration), NOT wall-clock ms.
        // setTimeout DELETED — finalization is tick-driven (Task 3.2).
        if (s.activeLineIdx >= 0 && s.lineWords.length > 0) {
            var outgoingTempoClass = (s.wordTimings && s.wordTimings.tempoClass) || 'normal';
            var overlapDuration = getAdjustedOverlapDuration
                ? getAdjustedOverlapDuration(outgoingTempoClass, s.lineWords.length)
                : 0.8;
            var scoreDelay = getScoreDelay ? getScoreDelay(outgoingTempoClass) : 0.3;

            s.prevLine = {
                lineIdx:                s.activeLineIdx,
                lineWords:              s.lineWords.slice(),
                matchedSet:             new Map(s.matchedSet),
                vadMatchedSet:          new Map(s.vadMatchedSet),
                asrConfirmedSet:        new Set(s.asrConfirmedSet),
                wordSourceMap:          new Map(s.wordSourceMap),
                lineStartWordCount:     s.lineStartWordCount,
                lineStartTranscriptPos: s.lineStartTranscriptPos,
                wordTimings:            s.wordTimings,
                params:                 s.currentParams,
                // Media seconds (not wall-clock ms): tick checks now >= overlapEnd.
                overlapEnd:             nowSec + overlapDuration + scoreDelay,
                whisperBuffer:          s.whisperBuffer,
                lineHadAsrEvent:        s.lineHadAsrEvent
            };
        }

        // --- Transition diagnostic (player.js:1163-1186) ---
        // _debugLog + _logTransition -> one transition event. Emitted regardless of
        // debug flag (the controller/renderer decides whether to log it).
        if (_dbgFromIdx >= 0 && s.lineWords.length > 0) {
            ev(events, 'transition', {
                fromIdx:           _dbgFromIdx,
                toIdx:             lineIdx,
                trigger:           'score',
                fromText:          _dbgFromText,
                matchedCount:      s.matchedSet.size,
                total:             s.lineWords.length,
                missedWords:       s.lineWords.filter(function (w, i) { return !s.matchedSet.has(i); }),
                lineStartAudioTime: s._lineStartAudioTime,
                sourceCounts:      countWordSources(s.wordSourceMap)
            });
        }

        // --- New-line setup (player.js:1188-1235) ---
        s.activeLineIdx = lineIdx;
        resetLineState(s, nowSec, false);

        // Load interpolated word timings for this line.
        s.wordTimings = (lineIdx >= 0 && lineIdx < s.allWordTimings.length)
            ? s.allWordTimings[lineIdx]
            : [];
        // Load adaptive window params for this line's tempo.
        s.currentParams = (s.wordTimings && s.wordTimings.tempoClass)
            ? getWindowParams(s.wordTimings.tempoClass)
            : getWindowParams('normal');

        // _whisperNode.port.postMessage block (1201-1213) DELETED — emit chunkTempo
        // event so controller can message the worklet.
        var tempoClass = (s.wordTimings && s.wordTimings.tempoClass) || 'normal';
        ev(events, 'chunkTempo', { tempoClass: tempoClass });

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

        // DOM span reset (1229-1235) DELETED — emit resetSpans event.
        ev(events, 'resetSpans', { lineIdx: lineIdx });

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

    // Moved from player.js _countWordSources (762-770). Pure read over a source map.
    function countWordSources(sourceMap) {
        var counts = { vad: 0, browser_sr: 0, whisper: 0, unknown: 0 };
        if (!sourceMap) return counts;
        sourceMap.forEach(function (source) {
            if (counts[source] === undefined) counts.unknown++;
            else counts[source]++;
        });
        return counts;
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
                if (confirmed && confirmed.length) {
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

    // Moved from player.js _collectMatches (1238-1299). Transform #1 (this.->s.),
    // #2 (audio.currentTime->now), #3 (each _logMatch -> wordMatched event). Populates
    // resultMap; the caller merges into matchedSet.
    function collectMatches(s, transcript, resultMap, now, events) {
        if (s.lineWords.length === 0) return;
        var spoken = normalizeWords(transcript);
        var windowSize = getSpokenWindowSize((s.wordTimings && s.wordTimings.tempoClass) || 'normal');
        var maxWindow = s.lineWords.length * 3;
        var spokenIdx = Math.max(s.lineStartTranscriptPos, spoken.length - Math.min(windowSize, maxWindow));
        var nowT = isFinite(now) ? now : 0;
        var driftWindow = s.currentParams.driftTrack1;
        for (var li = 0; li < s.lineWords.length; li++) {
            if (li < s.wordTimings.length) {
                if (nowT < s.wordTimings[li].windowStart) continue;
            }
            var target = s.lineWords[li];
            var targetPhonetic = s.wordTimings[li] ? s.wordTimings[li].phonetic : undefined;
            for (var si = spokenIdx; si < Math.min(spokenIdx + driftWindow, spoken.length); si++) {
                if (FILLER_WORDS.has(spoken[si]) && !FILLER_WORDS.has(target)) {
                    spokenIdx = si + 1; si = spokenIdx - 1; continue;
                }
                s._lineComparisonCount++;

                var consumed = multiWordContractionMatch(spoken, si, target);
                if (consumed > 0) {
                    resultMap.set(li, 1.0);
                    ev(events, 'wordMatched', { lineIdx: s.activeLineIdx, wordIndex: li,
                        spokenWord: spoken[si], targetWord: target, method: 'contraction',
                        editDistance: 0, phoneticMatch: false, score: 1.0, matched: true,
                        windowPosition: si, source: 'browser_sr' });
                    spokenIdx = si + consumed;
                    break;
                }

                var pm = phraseMatch(spoken, si, s.lineWords, li);
                if (pm) {
                    for (var pt = 0; pt < pm.targetConsumed; pt++) { resultMap.set(li + pt, 1.0); }
                    ev(events, 'wordMatched', { lineIdx: s.activeLineIdx, wordIndex: li,
                        spokenWord: spoken[si], targetWord: s.lineWords[li], method: 'phrase',
                        editDistance: 0, phoneticMatch: false, score: 1.0, matched: true,
                        windowPosition: si, source: 'browser_sr' });
                    spokenIdx = si + pm.spokenConsumed;
                    li += pm.targetConsumed - 1;
                    break;
                }

                var result = wordsMatchScore(spoken[si], target, targetPhonetic);
                if (result.score > 0) {
                    var prev = resultMap.get(li);
                    if (prev === undefined || result.score > prev) {
                        resultMap.set(li, result.score);
                    }
                    ev(events, 'wordMatched', { lineIdx: s.activeLineIdx, wordIndex: li,
                        spokenWord: spoken[si], targetWord: target, method: result.method,
                        editDistance: result.method === 'edit1' ? 1 : result.method === 'edit2' ? 2 : 0,
                        phoneticMatch: result.method === 'phonetic', score: result.score, matched: true,
                        windowPosition: si, source: 'browser_sr' });
                    spokenIdx = si + 1;
                    break;
                }

                ev(events, 'wordMatched', { lineIdx: s.activeLineIdx, wordIndex: li,
                    spokenWord: spoken[si], targetWord: target, method: 'none',
                    editDistance: -1, phoneticMatch: false, score: 0.0, matched: false,
                    windowPosition: si, source: 'browser_sr' });
            }
        }
    }

    // Moved from player.js _collectMatchesWhisper (1037-1097). Transforms #1/#2/#3.
    // Merges into matchedSet inline (whisper is authoritative); promotion -> event;
    // _setWordSource -> setWordSource. The prevLine track-2 match (1094-1096) is added
    // in Phase 3 (prevLine handling); a no-op here when s.prevLine is null.
    function collectMatchesWhisper(s, transcript, now, events) {
        if (s.lineWords.length === 0) return;
        var spoken = normalizeWords(transcript);
        var whisperMap = new Map();
        var windowSize = getSpokenWindowSize((s.wordTimings && s.wordTimings.tempoClass) || 'normal');
        var perLineCap = Math.max(windowSize, s.lineWords.length * 4);
        var spokenIdx = Math.max(0, spoken.length - perLineCap);
        var nowT = isFinite(now) ? now : 0;
        var driftWindow = s.currentParams.driftTrack2;
        for (var li = 0; li < s.lineWords.length; li++) {
            if (li < s.wordTimings.length) {
                if (nowT < s.wordTimings[li].windowStart) continue;
            }
            var target = s.lineWords[li];
            var targetPhonetic = s.wordTimings[li] ? s.wordTimings[li].phonetic : undefined;
            for (var si = spokenIdx; si < Math.min(spokenIdx + driftWindow, spoken.length); si++) {
                if (FILLER_WORDS.has(spoken[si]) && !FILLER_WORDS.has(target)) {
                    spokenIdx = si + 1; si = spokenIdx - 1; continue;
                }
                var consumed = multiWordContractionMatch(spoken, si, target);
                if (consumed > 0) {
                    whisperMap.set(li, 1.0);
                    spokenIdx = si + consumed;
                    break;
                }
                var pm = phraseMatch(spoken, si, s.lineWords, li);
                if (pm) {
                    for (var pt = 0; pt < pm.targetConsumed; pt++) { whisperMap.set(li + pt, 1.0); }
                    spokenIdx = si + pm.spokenConsumed;
                    li += pm.targetConsumed - 1;
                    break;
                }
                var result = wordsMatchScore(spoken[si], target, targetPhonetic);
                if (result.score > 0) {
                    whisperMap.set(li, result.score);
                    spokenIdx = si + 1;
                    break;
                }
            }
        }
        whisperMap.forEach(function (score, i) {
            var existing = s.matchedSet.get(i);
            if (existing === undefined || score > existing) {
                s.matchedSet.set(i, score);
            }
            if (s.vadMatchedSet.has(i) && !s.asrConfirmedSet.has(i)) {
                s.asrConfirmedSet.add(i);
                ev(events, 'promotion', { source: 'whisper', wordIndex: i, score: score });
            }
            setWordSource(s, i, 'whisper');
        });
        ev(events, 'wordSpans', {});
    }

    // Moved from player.js _trimTranscriptWindow (504-509): 200-word rolling window.
    function trimTranscriptWindow(buffer, text) {
        var words = normalizeWords(((buffer || '') + ' ' + (text || '')).trim());
        if (words.length > 200) {
            words = words.slice(words.length - 200);
        }
        return words.join(' ');
    }

    // Accumulate a final ASR result. Mirrors the SR onresult final branch (409-420)
    // for browser_sr/browser_final and _handleWhisperTranscript (722-743) for whisper:
    // append to the transcript/whisperBuffer, mark ASR activity, feed phrase evidence,
    // and flag a collect pass for the next tick (which carries the fresh `now`).
    function ingestFinal(s, text, source) {
        if (!text) return;
        if (source === 'whisper') {
            s.whisperBuffer = trimTranscriptWindow(s.whisperBuffer, text);
            s.lineHadAsrEvent = true;
            s._collectDirty = 'whisper';
            // Phrase evidence is fed at the next tick where `now` is available, so the
            // late-evidence reconcile uses the real media clock (see drainPendingFinals).
            s._pendingFinals = s._pendingFinals || [];
            s._pendingFinals.push({ source: 'whisper', text: text, words: [] });
        } else {
            // browser_sr / browser_final: append with a trailing space so the no-space
            // `transcript + interim` concat in the hot-word path still tokenizes (409-411).
            s.transcript += text + ' ';
            s.transcriptWords = s.transcriptWords.concat(normalizeWords(text));
            s.lineHadAsrEvent = true;
            s._collectDirty = 'browser_sr';
            s._pendingFinals = s._pendingFinals || [];
            s._pendingFinals.push({ source: 'browser_final', text: text, words: [] });
        }
        // Feed-only (contract): no return. The queued collect/evidence run on the next
        // tick, which carries the media clock the window guard / late-evidence need.
    }

    // Feed any queued final-evidence to the phrase engine using the current tick clock.
    function drainPendingFinals(s, now, events) {
        if (!s._pendingFinals || !s._pendingFinals.length) return;
        var pending = s._pendingFinals;
        s._pendingFinals = [];
        for (var i = 0; i < pending.length; i++) {
            addPhraseEvidence(s, {
                source: pending[i].source,
                text: pending[i].text || '',
                words: pending[i].words || [],
                receivedAtSec: now,
                audioTimeSec: isFinite(now) ? now : null
            }, now, events);
        }
    }

    // Run the queued collect pass (browser_sr or whisper) for newly-arrived text,
    // using the fresh tick clock. Mirrors the SR handler's collectMatches+merge (430-447)
    // / _handleWhisperTranscript's collectMatchesWhisper (724). Runs once per new text.
    function runDirtyCollect(s, now, events) {
        var dirty = s._collectDirty;
        if (!dirty) return;
        s._collectDirty = null;
        if (dirty === 'whisper') {
            collectMatchesWhisper(s, s.whisperBuffer, now, events);
            return;
        }
        // browser_sr: union map over transcript+interim, then merge + promotion (439-447).
        var unionMap = new Map();
        collectMatches(s, (s.transcript || '') + (s.latestInterim || ''), unionMap, now, events);
        var beforeConfirmed = new Set(s.asrConfirmedSet);
        mergeConfirmedMatches(s.matchedSet, s.vadMatchedSet, s.asrConfirmedSet, unionMap);
        unionMap.forEach(function (score, i) {
            if (!beforeConfirmed.has(i) && s.asrConfirmedSet.has(i)) {
                ev(events, 'promotion', { source: 'browser_sr', wordIndex: i, score: score });
            }
            setWordSource(s, i, 'browser_sr');
        });
        ev(events, 'wordSpans', {});
    }
    // Moved from player.js SR onresult (399, 413): latest interim is stored verbatim
    // and any ASR event marks the line as having had ASR activity.
    // Deferral-closure #2: also mark collect dirty so the next tick runs
    // runDirtyCollect with `transcript + latestInterim`, matching production's
    // _collectMatches call on every onresult (player.js:431).
    function ingestInterim(s, text) {
        s.latestInterim = text || '';
        if (text) {
            s.lineHadAsrEvent = true;
            // Mark dirty so runDirtyCollect runs on the next tick against the full
            // transcript+interim text (mirrors player.js:431 onresult collect).
            if (!s._collectDirty) s._collectDirty = 'browser_sr';
        }
    }
    // Moved from player.js _reconcileInterim (1475-1488). Transform #1 (this.->s.),
    // #3 (_paintPhraseCleared -> phraseCleared event). Calls reconcileInterimSnapshot
    // UNCHANGED (3-arg): the 06dfde5 energy gate is internal to phrase-engine
    // (hasInWindowFlow over flowEvents). Snapshot assembly preserved verbatim
    // (transcript + ' ' + latestInterim).
    function reconcileInterim(s, nowSec, events) {
        if (!s.phraseSession || !phraseEngine) return;
        try {
            var snapText = (s.transcript || '') + ' ' + (s.latestInterim || '');
            var confirmed = phraseEngine.reconcileInterimSnapshot(s.phraseSession, snapText, nowSec);
            if (confirmed && confirmed.length) {
                for (var ci = 0; ci < confirmed.length; ci++) {
                    ev(events, 'phraseCleared', { phraseId: confirmed[ci] });
                }
            }
        } catch (e) {
            // swallow (mirrors controller's console.warn-and-continue)
        }
    }

    function setEnergy(s, isSpeaking) { s.isSpeaking = !!isSpeaking; }

    // Moved from player.js _matchPrevLine (1001-1035). Transform #1 (this.->s.),
    // #2 (performance.now() -> now: the media-clock boundary check is now `now >=
    // s.prevLine.overlapEnd`, handled by the caller finalizePrevLine/finalizePrevLineIfDue;
    // this function does NOT re-check the boundary). Transform #3: the DOM span block
    // (1026-1031) -> wordSpans event (the controller repaints). Returns true if any
    // match was found (mirrors the original return value).
    function matchPrevLine(s, transcript, track, now, events) {
        if (!s.prevLine) return false;
        var prev = s.prevLine;
        var spoken = normalizeWords(transcript);
        var spokenIdx = (track === 'track1') ? prev.lineStartTranscriptPos : 0;
        var driftWindow = (track === 'track1') ? prev.params.driftTrack1 : prev.params.driftTrack2;
        var cursor = spokenIdx;
        var anyMatched = false;

        for (var li = 0; li < prev.lineWords.length; li++) {
            if (prev.matchedSet.has(li)) { cursor++; continue; }
            var target = prev.lineWords[li];
            var targetPhonetic = prev.wordTimings && prev.wordTimings[li] ? prev.wordTimings[li].phonetic : undefined;
            var m = findMatchInWindow(spoken, cursor, driftWindow, target, targetPhonetic);
            if (m) {
                prev.matchedSet.set(li, m.score);
                if (prev.wordSourceMap) prev.wordSourceMap.set(li, track === 'track2' ? 'whisper' : 'browser_sr');
                if (prev.vadMatchedSet && prev.vadMatchedSet.has(li) && prev.asrConfirmedSet && !prev.asrConfirmedSet.has(li)) {
                    prev.asrConfirmedSet.add(li);
                }
                cursor = m.spokenIdx + 1;
                anyMatched = true;
                // DOM span update (1026-1031) -> wordSpans repaint event.
                ev(events, 'wordSpans', {});
            }
        }
        return anyMatched;
    }

    // Moved from player.js _finalizePrevLine (983-993). Transform #1 (this.->s.),
    // #3: calls lateScoreLine (which emits lineScored) instead of _scoreLine, to match
    // the Phase-2 DRY delegation already in lateScoreLine. Nulls s.prevLine FIRST so
    // that recursive calls (fast succession) are safe, then delegates to lateScoreLine
    // for the snapshot scoring. Mirrors the original null-first-then-score order.
    function finalizePrevLine(s, now, events) {
        if (!s.prevLine) return;
        var prev = s.prevLine;
        s.prevLine = null;                          // null first (mirrors original)

        if (prev.lineWords.length > 0) {
            lateScoreLine(s, prev.lineIdx, prev.lineWords, prev.matchedSet,
                          prev.lineStartWordCount, prev.lineHadAsrEvent,
                          prev.vadMatchedSet, prev.asrConfirmedSet, events);
        }
    }

    // Tick-driven prevLine finalize hook (replaces the performance.now() + setTimeout
    // approach of production). Media seconds: finalize when now >= prevLine.overlapEnd.
    // Called at the TOP of tick so that the prevLine window expiry is always checked
    // before the arcade/reconcile block that might produce honestPct.
    function finalizePrevLineIfDue(s, now, events) {
        if (s.prevLine && now >= s.prevLine.overlapEnd) {
            finalizePrevLine(s, now, events);
        }
    }

    // Per-tick orchestration. First the SR-handler-analog work (phrase evidence ->
    // hot-word match -> collectMatches+merge), then the _tickArcade-analog work
    // (settle -> reconcile -> commit -> honestPct). This mirrors production's
    // `updateHotWord(); _tickArcade();` call order (player.js:2497) and, inside the
    // arcade block, _tickArcade's own order (settle -> reconcile -> commit -> honest %,
    // player.js:1628-1647).
    function tick(s, now) {
        var events = [];
        var nowSec = isFinite(now) ? now : 0;
        finalizePrevLineIfDue(s, now, events);  // tick-driven prevLine finalize (no-op until 3.2)
        drainPendingFinals(s, now, events);     // phrase evidence (uses fresh now)
        updateHotWordAndMatch(s, now, events);  // VAD provisional feed + hot-word match
        runDirtyCollect(s, now, events);        // collectMatches/whisper + merge + promotion
        // Live overlap crediting (#3): while the outgoing line is still in its overlap
        // window (prevLine not yet finalized by finalizePrevLineIfDue above), re-match it
        // against the current transcript so late boundary words green the OUTGOING line
        // LIVE — not only at finalize via lateScoreLine. Restores production's _matchPrevLine
        // (moved in Phase 3 but left unwired). Idempotent vs lateScoreLine's finalize collect
        // (same matchedSet keyed by index); track1 fences from prevLine.lineStartTranscriptPos.
        if (s.prevLine) {
            matchPrevLine(s, (s.transcript || '') + ' ' + (s.latestInterim || ''), 'track1', now, events);
        }
        // _tickArcade: settle phrases so ended lines are settling/settled, then catch up
        // ended-and-uncleared lines from the converged interim BEFORE commit, then commit
        // each newly-settled phrase exactly once, then refresh the honest % headline.
        if (s.phraseSession && phraseEngine) {
            try { phraseEngine.settlePhrases(s.phraseSession, nowSec); } catch (e) {}
            reconcileInterim(s, nowSec, events);
            commitNewlySettled(s, nowSec, true, events);
            ev(events, 'honestPct', { pct: getHonestPct(s) });
        }
        return events;
    }
    // Final flush when the song ends or the player stops. Mirrors the end-screen flush
    // at the controller level: collect any remaining active-line text, score the final
    // active line, settle pending phrases, commit newly-settled (routeEvents=false so
    // the HUD arcade banner is suppressed; the end screen renders from getScores/events).
    // Idempotency: a sentinel flag `_endRunDone` prevents double-scoring.
    function endRun(s, now) {
        var events = [];
        if (s._endRunDone) return events;
        s._endRunDone = true;
        var nowSec = isFinite(now) ? now : 0;

        // Final collect pass on the active line (catches any unprocessed interim/final).
        if (s.lineWords.length > 0 && s.lineHadAsrEvent) {
            var unionMap = new Map();
            collectMatches(s, (s.transcript || '') + (s.latestInterim || ''), unionMap, nowSec, events);
            mergeConfirmedMatches(s.matchedSet, s.vadMatchedSet, s.asrConfirmedSet, unionMap);
        }

        // Score the active line.
        if (s.activeLineIdx >= 0 && s.lineWords.length > 0) {
            scoreLine(s, s.activeLineIdx, s.lineWords, s.matchedSet, s.lineHadAsrEvent,
                      s.vadMatchedSet, s.asrConfirmedSet, events);
        }

        // Settle all remaining open phrases as of now.
        if (s.phraseSession && phraseEngine) {
            try { phraseEngine.settlePhrases(s.phraseSession, nowSec); } catch (e) {}
        }

        // Commit newly settled phrases (routeEvents=false: no HUD arcade event; end
        // screen reads from getScores and the phrase paint events).
        commitNewlySettled(s, nowSec, false, events);

        return events;
    }
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

    // --- Task 2.1: scoreLine (moved from player.js _scoreLine 1539-1597) ---
    // Transform #1 (this.->s.). Transform #3: the DOM block (1563-1580) — the .missed
    // span marking + .line-score-flash creation — becomes a single `lineScored` event;
    // _updateRunningScore() (1596) becomes a `runningScore` event (the controller
    // repaints from getScores). All guards preserved verbatim: the zero-ASR fence
    // (lineHadAsrEvent === false -> return) and the weightedTotal===0 early-return.
    // The tally mutations + streak logic are unchanged.
    function scoreLine(s, lineIdx, lineWords, matchedSet, lineHadAsrEvent, vadMatchedSet, asrConfirmedSet, events) {
        lineIdx    = (lineIdx    !== undefined) ? lineIdx    : s.activeLineIdx;
        lineWords  = (lineWords  !== undefined) ? lineWords  : s.lineWords;
        matchedSet = (matchedSet !== undefined) ? matchedSet : s.matchedSet;
        vadMatchedSet    = vadMatchedSet    || s.vadMatchedSet;
        asrConfirmedSet  = asrConfirmedSet  || s.asrConfirmedSet;

        var total = lineWords.length;
        if (total === 0) return;

        // Zero-ASR line fencing: skip scoring for lines with no ASR activity
        if (lineHadAsrEvent === false) return;

        var wordTimings = (lineIdx >= 0 && lineIdx < s.allWordTimings.length)
            ? s.allWordTimings[lineIdx] : [];
        var scoreSummary = computeLineScore(lineWords, wordTimings, matchedSet, vadMatchedSet, asrConfirmedSet);
        // A line with nothing scoreable (all "free" ad-libs/fillers) neither counts
        // toward the score nor breaks the streak.
        if (scoreSummary.weightedTotal === 0) return;
        var weightedTotal = scoreSummary.weightedTotal;
        var weightedMatched = scoreSummary.weightedMatched;
        var matched = scoreSummary.matchedWords;
        var scoredTotal = scoreSummary.totalWords;

        // DOM (.missed spans + .line-score-flash) -> render-intent event.
        ev(events, 'lineScored', {
            lineIdx: lineIdx, matched: matched, scoredTotal: scoredTotal,
            missedWordIndices: scoreSummary.missedWordIndices, perfect: scoreSummary.perfect,
            weightedTotal: weightedTotal, weightedMatched: weightedMatched
        });

        s.weightedTotal   += weightedTotal;
        s.weightedMatched += weightedMatched;
        s.totalWords      += scoredTotal;
        s.matchedWords    += matched;
        s.linesScored++;

        if (scoreSummary.perfect) {
            s.perfectLines++;
            s.currentStreak++;
            if (s.currentStreak > s.bestStreak) s.bestStreak = s.currentStreak;
        } else {
            s.currentStreak = 0;
        }

        ev(events, 'runningScore', {});
    }

    // --- Task 2.2: lateScoreLine (moved from player.js _lateScoreLine 1786-1833) ---
    // The 800ms late pass: re-match the line against the rolling transcriptWords with
    // a -4 boundary lookback (slack for finals that land just after the line change),
    // then delegate to scoreLine to tally (DRY — the original ends with _scoreLine).
    // Transform #1 (this.->s.). Transform #3: the per-word V1 span-light DOM block
    // (1817-1826) becomes a single wordSpans repaint hint (the original emitted no
    // telemetry here, so no wordMatched events are invented). The matchedSet /
    // asrConfirmedSet mutations and the -4 / 20-word window are preserved verbatim.
    function lateScoreLine(s, lineIdx, lineWords, matchedSet, lineStartWordCount, lineHadAsrEvent, vadMatchedSet, asrConfirmedSet, events) {
        if (lineWords.length === 0) return;

        var spokenNow = s.transcriptWords;
        // Intentionally retains the -4 lookback (unlike collectMatches which uses a
        // strict fence). This method runs 800ms after line change, so it needs slack
        // to catch late-arriving recognition finals from the transition boundary.
        var startOff  = Math.max(0, lineStartWordCount - 4);
        var spokenIdx = startOff;

        var lateWordTimings = s.allWordTimings[lineIdx];
        var lit = false;
        for (var li = 0; li < lineWords.length; li++) {
            if (matchedSet.has(li)) { spokenIdx++; continue; }
            var target = lineWords[li];
            var targetPhonetic = lateWordTimings && lateWordTimings[li] ? lateWordTimings[li].phonetic : undefined;
            for (var si = spokenIdx; si < Math.min(spokenIdx + 20, spokenNow.length); si++) {
                var result = wordsMatchScore(spokenNow[si], target, targetPhonetic);
                if (result.score > 0) {
                    var existing = matchedSet.get ? matchedSet.get(li) : undefined;
                    if (existing === undefined || result.score > existing) {
                        if (matchedSet.set) {
                            matchedSet.set(li, result.score);
                        } else {
                            matchedSet.add(li); // fallback for Set
                        }
                    }
                    // Promote VAD word to ASR-confirmed if late ASR just matched it
                    if (vadMatchedSet && vadMatchedSet.has(li) && asrConfirmedSet && !asrConfirmedSet.has(li)) {
                        asrConfirmedSet.add(li);
                    }
                    spokenIdx = si + 1;
                    // Light the span — this word just arrived late (DOM -> render hint).
                    lit = true;
                    break;
                }
            }
        }
        if (lit) ev(events, 'wordSpans', {});

        scoreLine(s, lineIdx, lineWords, matchedSet, lineHadAsrEvent, vadMatchedSet, asrConfirmedSet, events);
    }

    // --- Task 2.3: commitNewlySettled (moved from player.js _commitNewlySettled 1653-1703) ---
    // Commit each phrase exactly once, when it first reaches status 'settled'. Reads
    // the UNCAPPED anchor-hit count at that instant (spec 4.2): later grace-window
    // evidence still lifts the honest %, but never the live multiplier. routeEvents
    // drives the HUD; the end-screen flush passes false.
    // Transform #1 (this.->s.). Transform #2 (audio.currentTime -> now). The
    // s.committedPhrases commit-once guard and arcade.commitPhrase are preserved
    // verbatim. Transform #3: the _arcadeEvents.push record is still pushed to
    // s.arcadeEvents (for endRun/telemetry) AND emitted as an arcadeRecord event;
    // _onArcadeEvent(evt) -> arcade event (same evt && routeEvents && V2 gate); the V2
    // paint block -> phraseCleared (confirmed) / phraseMissed (else), same V2 gate.
    function commitNewlySettled(s, now, routeEvents, events) {
        if (!s.arcadeState || !arcade || !s.phrasePlan || !s.phraseSession) return;
        var nowSec = isFinite(now) ? now : 0;
        var phrases = s.phrasePlan.phrases || [];
        for (var pi = 0; pi < phrases.length; pi++) {
            var ph = phrases[pi];
            var pst = s.phraseSession.states[ph.phraseId];
            if (!pst || pst.status !== 'settled') continue;
            if (s.committedPhrases[ph.phraseId]) continue;
            s.committedPhrases[ph.phraseId] = true;
            var evt = arcade.commitPhrase(s.arcadeState, {
                phraseId: ph.phraseId,
                anchorsRequired: ph.anchorsRequired,
                anchorsTotal: (ph.anchors || []).length,
                anchorsHit: Object.keys(pst.anchorHits).length,
                rescuedByWhisper: pst.rescuedByWhisper
            });
            if (evt) {
                if (!s.arcadeEvents) s.arcadeEvents = [];
                var record = {
                    phraseId: ph.phraseId,
                    lineIdx: ph.lineIdx,
                    settledAtSec: parseFloat((nowSec != null ? nowSec : 0).toFixed(2)),
                    outcome: evt.outcome,
                    perfect: evt.perfect,
                    anchorsRequired: ph.anchorsRequired,
                    anchorsTotal: (ph.anchors || []).length,
                    anchorsHit: Object.keys(pst.anchorHits).length,
                    pointsAwarded: evt.pointsAwarded,
                    multiplierAfter: evt.multiplier,
                    streakAfter: evt.streak,
                    onFire: evt.onFire
                };
                s.arcadeEvents.push(record);
                ev(events, 'arcadeRecord', { record: record });
            }
            if (evt && routeEvents) ev(events, 'arcade', { evt: evt });

            // V2 coloring at settle: a passed line greens the whole phrase; a missed
            // line reds its key words only (non-key words stay neutral).
            if (pst.lyricStatus === 'confirmed') {
                ev(events, 'phraseCleared', { phraseId: ph.phraseId });
            } else if (Object.keys(pst.anchorHits).length > 0) {
                // Partial: some anchors landed (the lenient streak survives a partial),
                // so paint amber, not the full red of a true miss — the visual then
                // matches the streak instead of reading as a total failure.
                ev(events, 'phrasePartial', { phraseId: ph.phraseId });
            } else {
                ev(events, 'phraseMissed', { phraseId: ph.phraseId });
            }
        }
    }

    return { createSession: createSession, setActiveLine: setActiveLine,
             ingestFinal: ingestFinal, ingestInterim: ingestInterim, setEnergy: setEnergy,
             tick: tick, endRun: endRun, getScores: getScores, getHonestPct: getHonestPct,
             scoreLine: scoreLine, lateScoreLine: lateScoreLine,
             commitNewlySettled: commitNewlySettled, resetActiveLine: resetActiveLine };
});
