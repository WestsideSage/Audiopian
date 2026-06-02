(function(root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory(require('./scoring.js'), require('./match-helpers.js'), root || globalThis);
    } else {
        root.KaraokeePhraseEngine = factory(root.KaraokeeScoring, root, root);
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function(scoring, matchHelpers, root) {
    var classifyWord = matchHelpers.classifyWord || root.classifyWord;
    var WORD_WEIGHTS = matchHelpers.WORD_WEIGHTS || root.WORD_WEIGHTS || { core: 1.0, function: 0.5, adlib: 0.25 };
    var ADLIB_WORDS = matchHelpers.ADLIB_WORDS || root.ADLIB_WORDS;

    var DIFFICULTY = {
        easy:   { requiredAnchorRatio: 0.20, timingToleranceMs: 1400, settlementMs: 1800, minFlowCoverage: 0.20 },
        medium: { requiredAnchorRatio: 0.45, timingToleranceMs: 1000, settlementMs: 1400, minFlowCoverage: 0.45 },
        hard:   { requiredAnchorRatio: 0.65, timingToleranceMs: 750,  settlementMs: 1100, minFlowCoverage: 0.65 },
        expert: { requiredAnchorRatio: 0.80, timingToleranceMs: 500,  settlementMs: 900,  minFlowCoverage: 0.80 }
    };
    var REPEATED_FILLER = {
        yeah: true, uh: true, oh: true, ay: true, aye: true, la: true,
        yea: true, hey: true, ah: true, ooh: true, na: true, da: true
    };
    var MAX_REJECTED_PER_PHRASE = 24;
    var MAX_EVIDENCE_PER_PHRASE = 24;
    var MAX_TOKENS_PER_PHRASE = 64;
    var MAX_FLOW_EVENTS_PER_PHRASE = 64;

    function cloneProfile(profile) {
        return {
            requiredAnchorRatio: profile.requiredAnchorRatio,
            timingToleranceMs: profile.timingToleranceMs,
            settlementMs: profile.settlementMs,
            minFlowCoverage: profile.minFlowCoverage
        };
    }

    function getDifficultyProfile(difficulty) {
        return cloneProfile(DIFFICULTY[difficulty] || DIFFICULTY.medium);
    }

    function normalizedWords(text) {
        return scoring.normalizeWords(String(text || ''));
    }

    function isAdlibWord(word) {
        return !!(ADLIB_WORDS && typeof ADLIB_WORDS.has === 'function' && ADLIB_WORDS.has(word));
    }

    function selectAnchors(words, difficultyProfile) {
        var anchors = [];
        for (var i = 0; i < words.length; i++) {
            var word = words[i];
            var wordClass = classifyWord ? classifyWord(word, false) : 'core';
            if (!word || word.length < 3) continue;
            if (wordClass === 'function' || wordClass === 'adlib') continue;
            if (REPEATED_FILLER[word] || isAdlibWord(word)) continue;
            var weight = WORD_WEIGHTS[wordClass] || 1.0;
            if (i === words.length - 1 || i === words.length - 2) weight += 0.2;
            if (word.length >= 6) weight += 0.15;
            anchors.push({
                anchorIdx: anchors.length,
                wordIdx: i,
                word: word,
                wordClass: wordClass,
                weight: parseFloat(weight.toFixed(3)),
                phonetic: scoring.doubleMetaphone ? scoring.doubleMetaphone(word) : undefined
            });
        }
        // Fallback: if a phrase consists entirely of filler/short words (e.g. "uh uh"),
        // include those words as low-weight anchors so the phrase can still be scored
        // when Whisper transcribes them. Without this, anchorsRequired stays 0 and the
        // line is permanently unscoreable in the phrase engine.
        if (anchors.length === 0 && words.length > 0) {
            for (var fi = 0; fi < words.length; fi++) {
                var fw = words[fi];
                if (!fw) continue;
                anchors.push({
                    anchorIdx: anchors.length,
                    wordIdx: fi,
                    word: fw,
                    wordClass: 'adlib',
                    weight: WORD_WEIGHTS.adlib || 0.25,
                    phonetic: scoring.doubleMetaphone ? scoring.doubleMetaphone(fw) : undefined,
                    fillerOnly: true
                });
            }
        }
        anchors.sort(function(a, b) {
            if (b.weight !== a.weight) return b.weight - a.weight;
            return a.wordIdx - b.wordIdx;
        });
        return anchors;
    }

    function phraseEndForLine(lyrics, lineIdx, audioDuration) {
        var start = Number(lyrics[lineIdx].time) || 0;
        if (lineIdx + 1 < lyrics.length) return Number(lyrics[lineIdx + 1].time) || start;
        if (audioDuration != null && isFinite(audioDuration)) return Math.max(start, Number(audioDuration));
        return start + 8;
    }

    function chunkWords(words, startSec, endSec) {
        var chunks = [];
        if (words.length <= 14) return [{ words: words, startSec: startSec, endSec: endSec }];
        var chunkSize = words.length <= 20 ? Math.ceil(words.length / 2) : 8;
        chunkSize = Math.max(6, Math.min(10, chunkSize));
        var duration = Math.max(0, endSec - startSec);
        for (var i = 0; i < words.length; i += chunkSize) {
            var part = words.slice(i, i + chunkSize);
            var partStart = startSec + duration * (i / words.length);
            var partEnd = startSec + duration * (Math.min(i + chunkSize, words.length) / words.length);
            chunks.push({ words: part, startSec: partStart, endSec: partEnd });
        }
        return chunks;
    }

    function buildPhrasePlan(lyrics, options) {
        options = options || {};
        var difficultyName = options.difficulty || 'medium';
        var difficulty = getDifficultyProfile(difficultyName);
        var phrases = [];
        for (var lineIdx = 0; lineIdx < (lyrics || []).length; lineIdx++) {
            var line = lyrics[lineIdx] || {};
            var startSec = Number(line.time) || 0;
            var endSec = phraseEndForLine(lyrics, lineIdx, options.audioDuration);
            var words = normalizedWords(line.text || '');
            var duration = Math.max(0.001, endSec - startSec);
            var shouldSplit = words.length > 14 || (words.length / duration) > 3.5;
            var chunks = shouldSplit ? chunkWords(words, startSec, endSec) : [{ words: words, startSec: startSec, endSec: endSec }];
            for (var c = 0; c < chunks.length; c++) {
                var chunk = chunks[c];
                var anchors = selectAnchors(chunk.words, difficulty);
                var anchorsRequired = anchors.length > 0 ? Math.max(1, Math.ceil(anchors.length * difficulty.requiredAnchorRatio)) : 0;
                phrases.push({
                    phraseId: 'p' + phrases.length,
                    lineIdx: lineIdx,
                    chunkIdx: c,
                    text: chunk.words.join(' '),
                    words: chunk.words,
                    startSec: parseFloat(chunk.startSec.toFixed(3)),
                    endSec: parseFloat(chunk.endSec.toFixed(3)),
                    anchors: anchors,
                    anchorsRequired: anchorsRequired
                });
            }
        }
        return {
            version: 1,
            difficultyName: difficultyName,
            difficulty: difficulty,
            phrases: phrases
        };
    }

    function createPhraseState(phrase) {
        return {
            phrase: phrase,
            status: 'open',
            lyricStatus: 'missing',
            accuracyStatus: 'missing',
            flowStatus: 'silent',
            cleared: false,
            rescuedByWhisper: false,
            liveClean: false,
            anchorHits: {},
            evidence: [],
            consumedTokens: [],
            rejectedCandidates: [],
            flowEvents: [],
            overflow: {
                evidence: 0,
                consumedTokens: 0,
                rejectedCandidates: 0,
                flowEvents: 0
            }
        };
    }

    function createPhraseSession(phrasePlan) {
        var states = {};
        (phrasePlan.phrases || []).forEach(function(phrase) {
            states[phrase.phraseId] = createPhraseState(phrase);
        });
        return {
            plan: phrasePlan,
            states: states,
            consumedTokenIds: {},
            evidenceCount: 0
        };
    }

    function evidenceTokens(evidence) {
        var tokens = [];
        if (evidence.words && evidence.words.length) {
            evidence.words.forEach(function(item, idx) {
                var word = normalizedWords(item.word || item.text || '')[0];
                if (!word) return;
                tokens.push({
                    idx: idx,
                    word: word,
                    start: item.start,
                    end: item.end
                });
            });
        }
        if (tokens.length === 0) {
            normalizedWords(evidence.text || '').forEach(function(word, idx) {
                tokens.push({ idx: idx, word: word });
            });
        }
        return tokens;
    }

    function tokenTime(evidence, token) {
        if (token && token.start != null && isFinite(token.start)) return Number(token.start);
        if (evidence.audioTimeSec != null && isFinite(evidence.audioTimeSec)) return Number(evidence.audioTimeSec);
        if (evidence.receivedAtSec != null && isFinite(evidence.receivedAtSec)) return Number(evidence.receivedAtSec);
        return 0;
    }

    function timingDistance(phrase, evidence, token) {
        var t = tokenTime(evidence, token);
        if (t < phrase.startSec) return phrase.startSec - t;
        if (t > phrase.endSec) return t - phrase.endSec;
        return 0;
    }

    function isInsideReviewWindow(session, phrase, evidence, token) {
        var profile = session.plan.difficulty;
        var t = tokenTime(evidence, token);
        var tolerance = profile.timingToleranceMs / 1000;
        var settlement = profile.settlementMs / 1000;
        return t >= phrase.startSec - tolerance && t <= phrase.endSec + settlement;
    }

    function updatePhraseResult(session, state) {
        var phrase = state.phrase;
        var hitCount = Object.keys(state.anchorHits).length;
        state.lyricStatus = hitCount >= phrase.anchorsRequired && phrase.anchorsRequired > 0
            ? 'confirmed'
            : (hitCount > 0 ? 'partial' : 'missing');
        state.accuracyStatus = state.lyricStatus;
        state.cleared = state.lyricStatus === 'confirmed';

        if (state.flowEvents.length > 0 || state.consumedTokens.length > 0) {
            var latest = null;
            state.consumedTokens.forEach(function(token) {
                if (latest == null || token.timeSec > latest) latest = token.timeSec;
            });
            state.flowEvents.forEach(function(event) {
                if (latest == null || event.timeSec > latest) latest = event.timeSec;
            });
            if (latest != null) {
                if (latest < phrase.startSec - (session.plan.difficulty.timingToleranceMs / 1000)) state.flowStatus = 'early';
                else if (latest > phrase.endSec) state.flowStatus = 'late';
                else state.flowStatus = 'clean';
            }
        }
        state.liveClean = state.cleared && state.flowStatus === 'clean' && !state.rescuedByWhisper;
    }

    function pushBounded(state, key, value, limit) {
        if (state[key].length < limit) {
            state[key].push(value);
        } else {
            state.overflow[key]++;
        }
    }

    function reject(state, reason, source, token, anchor) {
        pushBounded(state, 'rejectedCandidates', {
            reason: reason,
            source: source || '',
            word: token ? token.word : '',
            anchor: anchor ? anchor.word : ''
        }, MAX_REJECTED_PER_PHRASE);
    }

    function activePhraseStates(session, evidence) {
        var now = evidence.audioTimeSec != null && isFinite(evidence.audioTimeSec)
            ? Number(evidence.audioTimeSec)
            : Number(evidence.receivedAtSec || 0);
        var profile = session.plan.difficulty;
        return (session.plan.phrases || []).filter(function(phrase) {
            return now >= phrase.startSec - (profile.timingToleranceMs / 1000) &&
                now <= phrase.endSec + (profile.settlementMs / 1000);
        }).map(function(phrase) {
            return session.states[phrase.phraseId];
        });
    }

    function addVadEvidence(session, evidence) {
        var states = activePhraseStates(session, evidence);
        states.forEach(function(state) {
            pushBounded(state, 'flowEvents', {
                evidenceId: evidence.id,
                source: 'vad',
                timeSec: tokenTime(evidence, null)
            }, MAX_FLOW_EVENTS_PER_PHRASE);
            reject(state, 'weak_source', 'vad', null, null);
            updatePhraseResult(session, state);
        });
    }

    function candidateFor(session, evidence, token, state, anchor) {
        var tokenId = evidence.id + ':' + token.idx;
        if (session.consumedTokenIds[tokenId]) {
            return { rejected: true, reason: 'already_consumed' };
        }
        if (state.anchorHits[anchor.anchorIdx]) {
            return { rejected: true, reason: 'already_consumed' };
        }
        // Generic filler tokens are normally rejected as evidence — but if the anchor
        // itself is a filler-only fallback ("uh uh" lines), we need to accept them.
        if ((REPEATED_FILLER[token.word] || isAdlibWord(token.word)) && !anchor.fillerOnly) {
            return { rejected: true, reason: 'generic_word' };
        }
        if (!isInsideReviewWindow(session, state.phrase, evidence, token)) {
            return { rejected: true, reason: 'outside_window' };
        }
        if (evidence.source === 'browser_interim') {
            return { rejected: true, reason: 'weak_source' };
        }
        var result = scoring.wordsMatchScore(token.word, anchor.word, anchor.phonetic);
        if (!result || result.score < 0.75) {
            return { rejected: true, reason: 'low_score', score: result ? result.score : 0 };
        }
        return {
            tokenId: tokenId,
            token: token,
            state: state,
            anchor: anchor,
            source: evidence.source,
            score: result.score,
            method: result.method,
            timingDistance: timingDistance(state.phrase, evidence, token)
        };
    }

    function addEvidence(session, evidence) {
        if (!session || !session.plan || !evidence) return session;
        evidence = Object.assign({}, evidence);
        evidence.id = evidence.id || ('ev-' + (++session.evidenceCount));
        evidence.source = evidence.source || 'browser_final';

        if (evidence.source === 'vad') {
            addVadEvidence(session, evidence);
            return session;
        }

        var tokens = evidenceTokens(evidence);
        var accepted = [];
        var states = activePhraseStates(session, evidence);
        tokens.forEach(function(token) {
            var candidates = [];
            states.forEach(function(state) {
                var phrase = state.phrase;
                (phrase.anchors || []).forEach(function(anchor) {
                    var candidate = candidateFor(session, evidence, token, state, anchor);
                    if (candidate.rejected) {
                        if (candidate.reason !== 'low_score') reject(state, candidate.reason, evidence.source, token, anchor);
                    } else {
                        candidates.push(candidate);
                    }
                });
            });
            if (candidates.length === 0) return;
            candidates.sort(function(a, b) {
                if (b.score !== a.score) return b.score - a.score;
                if (a.timingDistance !== b.timingDistance) return a.timingDistance - b.timingDistance;
                return a.state.phrase.startSec - b.state.phrase.startSec;
            });
            var best = candidates[0];
            session.consumedTokenIds[best.tokenId] = true;
            best.state.anchorHits[best.anchor.anchorIdx] = {
                word: best.anchor.word,
                source: evidence.source,
                evidenceId: evidence.id,
                score: best.score
            };
            pushBounded(best.state, 'evidence', {
                evidenceId: evidence.id,
                source: evidence.source,
                text: evidence.text || '',
                score: best.score,
                method: best.method
            }, MAX_EVIDENCE_PER_PHRASE);
            pushBounded(best.state, 'consumedTokens', {
                evidenceId: evidence.id,
                tokenIdx: token.idx,
                word: token.word,
                anchor: best.anchor.word,
                source: evidence.source,
                timeSec: tokenTime(evidence, token),
                score: best.score
            }, MAX_TOKENS_PER_PHRASE);
            pushBounded(best.state, 'flowEvents', {
                evidenceId: evidence.id,
                source: evidence.source,
                timeSec: tokenTime(evidence, token)
            }, MAX_FLOW_EVENTS_PER_PHRASE);
            if (evidence.source === 'whisper') best.state.rescuedByWhisper = true;
            accepted.push(best);
        });
        accepted.forEach(function(candidate) {
            updatePhraseResult(session, candidate.state);
        });
        return session;
    }

    function settlePhrases(session, nowSec) {
        if (!session || !session.plan) return session;
        var profile = session.plan.difficulty;
        (session.plan.phrases || []).forEach(function(phrase) {
            var state = session.states[phrase.phraseId];
            if (nowSec >= phrase.endSec + (profile.settlementMs / 1000)) state.status = 'settled';
            else if (nowSec >= phrase.endSec) state.status = 'settling';
            else state.status = 'open';
            updatePhraseResult(session, state);
        });
        return session;
    }

    function clamp01(value) {
        if (!isFinite(value)) return 0;
        if (value < 0) return 0;
        if (value > 1) return 1;
        return value;
    }

    function getLiveScore(session) {
        var lyrics = 1;
        var timing = 1;
        var stability = 1;
        if (session && session.states) {
            var sumHit = 0;
            var sumReq = 0;
            var clearedCount = 0;
            var cleanCount = 0;
            var rescuedCount = 0;
            Object.keys(session.states).forEach(function(phraseId) {
                var state = session.states[phraseId];
                var phrase = state.phrase || {};
                var required = phrase.anchorsRequired || 0;
                if (required > 0) {
                    var hit = Object.keys(state.anchorHits).length;
                    if (hit > required) hit = required;
                    sumHit += hit;
                    sumReq += required;
                }
                if (state.cleared) {
                    clearedCount++;
                    if (state.flowStatus === 'clean') cleanCount++;
                    if (state.rescuedByWhisper) rescuedCount++;
                }
            });
            lyrics = sumReq > 0 ? clamp01(sumHit / sumReq) : 1;
            timing = clearedCount > 0 ? cleanCount / clearedCount : 1;
            stability = clearedCount > 0 ? 1 - (rescuedCount / clearedCount) : 1;
        }
        var composite = 0.6 * lyrics + 0.25 * timing + 0.15 * stability;
        return {
            lyrics: lyrics,
            timing: timing,
            stability: stability,
            composite: composite
        };
    }

    function getPhraseTrace(session) {
        if (!session || !session.plan) return [];
        return (session.plan.phrases || []).map(function(phrase) {
            var state = session.states[phrase.phraseId];
            var anchorsHit = Object.keys(state.anchorHits).length;
            return {
                phraseId: phrase.phraseId,
                lineIdx: phrase.lineIdx,
                text: phrase.text,
                status: state.status,
                lyricStatus: state.lyricStatus,
                accuracyStatus: state.accuracyStatus,
                flowStatus: state.flowStatus,
                cleared: state.cleared,
                rescuedByWhisper: state.rescuedByWhisper,
                liveClean: state.liveClean,
                anchorsHit: anchorsHit,
                anchorsRequired: phrase.anchorsRequired,
                evidence: state.evidence.slice(),
                consumedTokens: state.consumedTokens.slice(),
                rejectedCandidates: state.rejectedCandidates.slice(),
                flowEvents: state.flowEvents.slice(),
                overflow: Object.assign({}, state.overflow)
            };
        });
    }

    return {
        buildPhrasePlan: buildPhrasePlan,
        getDifficultyProfile: getDifficultyProfile,
        selectAnchors: selectAnchors,
        createPhraseSession: createPhraseSession,
        addEvidence: addEvidence,
        settlePhrases: settlePhrases,
        getPhraseTrace: getPhraseTrace,
        getLiveScore: getLiveScore
    };
});
