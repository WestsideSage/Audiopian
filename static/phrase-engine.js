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

    // Lazy profanity resolver (load-order robust): require() in Node, window global in browser.
    function _profanity() {
        if (typeof module !== 'undefined' && module.exports) {
            try { return require('./profanity.js'); } catch (e) { return null; }
        }
        return (root && root.KaraokeeProfanity) || null;
    }
    function _isProfane(w)    { var p = _profanity(); return !!(p && p.isProfane && p.isProfane(w)); }
    function _isNeverScore(w) { var p = _profanity(); return !!(p && p.isNeverScore && p.isNeverScore(w)); }

    var DIFFICULTY = {
        easy:   { requiredAnchorRatio: 0.20, timingToleranceMs: 1400, settlementMs: 1800, minFlowCoverage: 0.20 },
        medium: { requiredAnchorRatio: 0.45, timingToleranceMs: 1000, settlementMs: 1400, minFlowCoverage: 0.45 },
        hard:   { requiredAnchorRatio: 0.65, timingToleranceMs: 750,  settlementMs: 1100, minFlowCoverage: 0.65 },
        expert: { requiredAnchorRatio: 0.80, timingToleranceMs: 500,  settlementMs: 900,  minFlowCoverage: 0.80 },
        // Insane: a 5th tier, strictly harder than expert (more required key words, tighter
        // timing). Paired with the collapsed-lyrics display (player.js gates on 'insane').
        insane: { requiredAnchorRatio: 0.90, timingToleranceMs: 400,  settlementMs: 800,  minFlowCoverage: 0.90 }
    };
    var REPEATED_FILLER = {
        yeah: true, uh: true, oh: true, ay: true, aye: true, la: true,
        yea: true, hey: true, ah: true, ooh: true, na: true, da: true
    };
    var MAX_REJECTED_PER_PHRASE = 24;
    var MAX_EVIDENCE_PER_PHRASE = 24;
    var MAX_TOKENS_PER_PHRASE = 64;
    var MAX_FLOW_EVENTS_PER_PHRASE = 64;
    // Recognizer lag (browser SR / realtime Whisper) means a phrase's words can be
    // transcribed ~1-2s after the phrase ended. Widen evidence acceptance past
    // settlement by this grace so late anchor hits still count — mirrors the line
    // scorer's boundary fix. Without it the phrase engine (and V2 score) undercounts
    // vs the headline on songs with lagged recognition.
    var LATE_EVIDENCE_GRACE_MS = 1000;
    // How far back (in audio seconds) reconciliation will look when crediting a
    // late recognition result to an already-ended phrase. Sized to the browser
    // speech-rec batch latency observed in telemetry (it can batch ~8 lines into
    // one late `final`). Tunable; see the design spec §7.
    var RECONCILE_LOOKBACK_SEC = 18;
    // Fast-tempo recognition allowance: on high-WPS (>= FAST_WPS_THRESHOLD) lines the
    // recognizer demonstrably drops words (a hard ASR limit, not a wrong performance), so
    // demanding the full anchor ratio is unfair and frustrating. buildPhrasePlan lowers
    // anchorsRequired on such lines toward ~half the anchors, FLOORED at FAST_RECOGNIZED_FLOOR
    // genuinely-RECOGNIZED anchors. anchorHits only come from real recognition/reconcile
    // (never bare VAD energy), so humming/cheese (0-1 recognized) still fails the floor.
    var FAST_WPS_THRESHOLD = 4.0;
    var FAST_RECOGNIZED_FLOOR = 2;
    // Interim reconciliation credits a line purely by word content (a repeated hook
    // anchor from the NEXT line can match a SKIPPED middle line whose true owner has
    // not yet ended — the forward-only floor only guards lines BEFORE the last
    // confirmed one). The only signal that separates "sang it, recognized late" from
    // "skipped it, next line bled back" is whether the singer vocalized DURING the
    // line: contiguous lines share a boundary, so a word's timestamp cannot. So an
    // interim credit requires an in-window flow event (live vad/content) for that
    // line. Default STRICT (0ms): on the honest-play telemetry a grace recovered only
    // ~4/462 lines (95% either way — within noise), while any grace opens a bleed
    // window on BOTH edges of a skipped line (its start == prev line's end, its end ==
    // next line's start), the exact direction this gate guards against. Kept as a knob:
    // raise only if a sing-test shows honest sub-second bars dropping to partial.
    var RECONCILE_FLOW_GRACE_MS = 0;

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

    // Split a raw lyric line into normalized words, tagging each with whether it was
    // inside parentheses in the ORIGINAL text. Mirrors the inParen walk that
    // scoring.interpolateWordTimings already does (scoring.js ~401-409), so the phrase
    // engine classifies parenthetical content as adlib instead of treating it as a
    // required anchor. Bare "(" / ")" tokens normalize to "" and are dropped, but still
    // toggle the inParen state (handles spaced parentheses).
    function splitLyricWordsWithParens(text) {
        var raw = String(text || '').trim().split(/\s+/);
        var out = [];
        var inParen = false;
        for (var i = 0; i < raw.length; i++) {
            var tok = raw[i];
            if (!tok) continue;
            if (tok.indexOf('(') >= 0) inParen = true;
            var word = scoring.normalizeWord(tok);
            if (word) out.push({ word: word, inParen: inParen });
            if (tok.indexOf(')') >= 0) inParen = false;
        }
        return out;
    }

    function selectAnchors(words, difficultyProfile, opts) {
        var clean = !!(opts && opts.clean);
        var anchors = [];
        for (var i = 0; i < words.length; i++) {
            var word = words[i] ? words[i].word : '';
            var inParen = !!(words[i] && words[i].inParen);
            var wordClass = classifyWord ? classifyWord(word, inParen) : 'core';
            if (!word || word.length < 3) continue;
            if (wordClass === 'function' || wordClass === 'adlib') continue;
            if (REPEATED_FILLER[word] || isAdlibWord(word)) continue;
            if (_isNeverScore(word)) continue;             // hard-R slur: never an anchor, any mode
            if (clean && _isProfane(word)) continue;        // clean mode: profanity is not a key word
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
        // No fallback for filler-only lines. If a phrase is entirely adlibs/fillers/
        // short tokens (e.g. "Ah ah ah", "uh uh", "la la la"), it keeps ZERO anchors,
        // so anchorsRequired stays 0 and the line is excluded from scoring: getHonestPct
        // skips req<=0 phrases, and no anchor spans means no key-word red on a "miss".
        // Adlibs are structurally unwinnable (recognizers don't reliably return them),
        // so they must neither help nor hurt the score.
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

    function chunkWords(wordObjs, startSec, endSec) {
        function mk(slice, s, e) {
            return { words: slice.map(function (o) { return o.word; }), wordObjs: slice, startSec: s, endSec: e };
        }
        if (wordObjs.length <= 14) return [mk(wordObjs, startSec, endSec)];
        var chunkSize = wordObjs.length <= 20 ? Math.ceil(wordObjs.length / 2) : 8;
        chunkSize = Math.max(6, Math.min(10, chunkSize));
        var duration = Math.max(0, endSec - startSec);
        var chunks = [];
        for (var i = 0; i < wordObjs.length; i += chunkSize) {
            var part = wordObjs.slice(i, i + chunkSize);
            var partStart = startSec + duration * (i / wordObjs.length);
            var partEnd = startSec + duration * (Math.min(i + chunkSize, wordObjs.length) / wordObjs.length);
            chunks.push(mk(part, partStart, partEnd));
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
            var wordObjs = splitLyricWordsWithParens(line.text || '');
            var words = wordObjs.map(function (o) { return o.word; });
            var duration = Math.max(0.001, endSec - startSec);
            var shouldSplit = words.length > 14 || (words.length / duration) > 3.5;
            var chunks = shouldSplit
                ? chunkWords(wordObjs, startSec, endSec)
                : [{ words: words, wordObjs: wordObjs, startSec: startSec, endSec: endSec }];
            for (var c = 0; c < chunks.length; c++) {
                var chunk = chunks[c];
                var anchors = selectAnchors(chunk.wordObjs, difficulty, { clean: !!options.clean });
                var anchorsRequired = anchors.length > 0 ? Math.max(1, Math.ceil(anchors.length * difficulty.requiredAnchorRatio)) : 0;
                // Force-all relief: a line big enough to spare one anchor shouldn't require
                // EVERY one of them, so a single ASR-impossible word (e.g. "greaze", "velour")
                // can't sink a correctly-sung line. Only triggers when the ratio rounds up to
                // all N AND there are >=4 anchors (short 2-3 anchor lines keep needing all, so
                // they can't collapse). Auto-scales by difficulty: force-all only happens at
                // high ratios, so Easy/Medium never reach it. Lowers only, never raises.
                if (anchors.length >= 4 && anchorsRequired >= anchors.length) {
                    anchorsRequired = anchors.length - 1;
                }
                // Fast-tempo recognition allowance (cheese-floored): lower the bar on
                // high-WPS lines the recognizer can't fully transcribe, but never below
                // FAST_RECOGNIZED_FLOOR genuinely-recognized anchors. Only lowers, never raises.
                var chunkWps = chunk.words.length / Math.max(0.001, chunk.endSec - chunk.startSec);
                if (anchorsRequired > 0 && chunkWps >= FAST_WPS_THRESHOLD) {
                    var fastBar = Math.max(FAST_RECOGNIZED_FLOOR, Math.ceil(anchors.length * 0.5));
                    anchorsRequired = Math.min(anchorsRequired, fastBar);
                }
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
        var settlement = (profile.settlementMs + LATE_EVIDENCE_GRACE_MS) / 1000;
        // Strict early edge (no pre-start tolerance). Adjacent/repeated hook lines
        // share a boundary (next.start == this.end), so ANY early grace lets the
        // previous identical line's still-streaming tokens pre-credit — and the live
        // painter pre-green — this phrase before the singer has reached it. Mirrors
        // the RECONCILE_FLOW_GRACE_MS=0 reasoning. The late side stays generous
        // (endSec + settlement + grace) so lagged recognition still lands.
        return t >= phrase.startSec && t <= phrase.endSec + settlement;
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
                now <= phrase.endSec + ((profile.settlementMs + LATE_EVIDENCE_GRACE_MS) / 1000);
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

    // Compound-word bridge: a single lyric token (e.g. "throwdown") that the
    // recognizer splits into two ("throw down") would never match its anchor. When
    // the single token doesn't match, try it merged with the NEXT token and accept
    // ONLY a near-exact hit (>= COMPOUND_MERGE_MIN) on a LONGER (compound) anchor --
    // so unrelated adjacent words can't manufacture a credit. Returns the match
    // result plus how many tokens it consumed (1 normally, 2 on a compound merge).
    var COMPOUND_MERGE_MIN = 0.9;
    function anchorMatchResult(token, nextToken, anchor) {
        var single = scoring.wordsMatchScore(token.word, anchor.word, anchor.phonetic);
        if (single && single.score >= 0.75) return { result: single, span: 1 };
        if (nextToken && token.word && nextToken.word && anchor.word &&
            anchor.word.length > token.word.length) {
            var merged = scoring.wordsMatchScore(token.word + nextToken.word, anchor.word, anchor.phonetic);
            if (merged && merged.score >= COMPOUND_MERGE_MIN) {
                return { result: { score: merged.score, method: 'compound' }, span: 2 };
            }
        }
        return { result: single || { score: 0, method: null }, span: 1 };
    }

    function candidateFor(session, evidence, token, nextToken, state, anchor) {
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
        var m = anchorMatchResult(token, nextToken, anchor);
        if (!m.result || m.result.score < 0.75) {
            return { rejected: true, reason: 'low_score', score: m.result ? m.result.score : 0 };
        }
        return {
            tokenId: tokenId,
            token: token,
            span: m.span,
            nextTokenIdx: (m.span === 2 && nextToken) ? nextToken.idx : null,
            state: state,
            anchor: anchor,
            source: evidence.source,
            score: m.result.score,
            method: m.result.method,
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
        tokens.forEach(function(token, ti) {
            if (session.consumedTokenIds[evidence.id + ':' + token.idx]) return; // merged into a prior compound
            var nextTok = (ti + 1 < tokens.length && !session.consumedTokenIds[evidence.id + ':' + tokens[ti + 1].idx]) ? tokens[ti + 1] : null;
            var candidates = [];
            states.forEach(function(state) {
                var phrase = state.phrase;
                (phrase.anchors || []).forEach(function(anchor) {
                    var candidate = candidateFor(session, evidence, token, nextTok, state, anchor);
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
            if (best.nextTokenIdx != null) session.consumedTokenIds[evidence.id + ':' + best.nextTokenIdx] = true; // compound merge consumed two tokens
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

    // Did the singer produce real-time energy/content inside this phrase's window?
    // Gates interim reconciliation: boundary-bleed flow from an adjacent line lands
    // OUTSIDE the strict window, so a line the singer skipped reads as silent here.
    // Reuses the flow events the live path already records — no separate energy stream.
    function hasInWindowFlow(state, phrase) {
        if (!state || !phrase) return false;
        var grace = RECONCILE_FLOW_GRACE_MS / 1000;
        var lo = phrase.startSec - grace;
        var hi = phrase.endSec + grace;
        return (state.flowEvents || []).some(function(fe) {
            return fe && fe.timeSec != null && fe.timeSec >= lo && fe.timeSec <= hi;
        });
    }

    // Content-based catch-up for late recognition. Runs AFTER the live addEvidence
    // path. For each token in spoken order, finds the first un-hit anchor in a
    // not-yet-cleared phrase whose endSec is inside the look-back window, scanning
    // candidates forward from a monotonic pointer so a repeated anchor word cannot
    // be pulled back to an earlier line and a single token cannot inflate multiple
    // lines. Returns the phraseIds that reached 'confirmed' during this pass.
    function reconcileLateEvidence(session, evidence, nowSec, options) {
        if (!session || !session.plan || !evidence) return [];
        var source = evidence.source || 'browser_final';
        var tokens = evidenceTokens(evidence);
        if (tokens.length === 0) return [];

        var lookbackStart = nowSec - RECONCILE_LOOKBACK_SEC;
        // Optional forward-only floor (interim path): never credit a line that starts
        // before the latest line interim has already confirmed, so a browser-SR
        // revision re-presenting an already-credited word can't reach back to an
        // earlier, un-sung line. The late-final path passes no floor (unchanged).
        var minStartSec = (options && options.minStartSec != null) ? options.minStartSec : -Infinity;
        var requireInWindowFlow = !!(options && options.requireInWindowFlow);
        var candidates = (session.plan.phrases || []).filter(function(phrase) {
            var state = session.states[phrase.phraseId];
            if (!state || state.cleared) return false;
            if (!(phrase.anchorsRequired > 0)) return false;
            if (phrase.startSec < minStartSec) return false;
            // Interim path only: a line the singer was silent through (no in-window
            // flow) must not be credited by content bleeding from an adjacent sung line.
            if (requireInWindowFlow && !hasInWindowFlow(state, phrase)) return false;
            return phrase.endSec >= lookbackStart && phrase.endSec <= nowSec;
        }).sort(function(a, b) { return a.startSec - b.startSec; });
        // Candidate set for the cheese-safe UNIQUE-anchor catch-up pass below: same filter
        // as `candidates` but WITHOUT the forward-only floor (minStartSec). A distinctive
        // anchor recognized late/out-of-order can credit its (in-window-flow / sung) line
        // even below the floor, because uniqueness removes the mis-credit ambiguity the
        // floor guards against. Built BEFORE the main loop so it captures phrases the
        // monotonic pass clears (its filter drops only already-cleared phrases).
        var flowCandidates = (session.plan.phrases || []).filter(function(phrase) {
            var st = session.states[phrase.phraseId];
            if (!st || st.cleared) return false;
            if (!(phrase.anchorsRequired > 0)) return false;
            if (requireInWindowFlow && !hasInWindowFlow(st, phrase)) return false;
            return phrase.endSec >= lookbackStart && phrase.endSec <= nowSec;
        });
        if (candidates.length === 0 && flowCandidates.length === 0) return [];

        var minIdx = 0;
        for (var ti = 0; ti < tokens.length; ti++) {
            var token = tokens[ti];
            var tokenId = evidence.id + ':' + token.idx;
            if (session.consumedTokenIds[tokenId]) continue;
            var isFiller = REPEATED_FILLER[token.word] || isAdlibWord(token.word);
            var nextTok = (ti + 1 < tokens.length && !session.consumedTokenIds[evidence.id + ':' + tokens[ti + 1].idx]) ? tokens[ti + 1] : null;

            for (var ci = minIdx; ci < candidates.length; ci++) {
                var state = session.states[candidates[ci].phraseId];
                var anchors = state.phrase.anchors || [];
                var creditedAnchor = null;
                var creditedScore = 0;
                var creditedSpan = 1;
                for (var ai = 0; ai < anchors.length; ai++) {
                    var anchor = anchors[ai];
                    if (state.anchorHits[anchor.anchorIdx]) continue;
                    if (isFiller && !anchor.fillerOnly) continue;
                    var m = anchorMatchResult(token, nextTok, anchor);
                    if (m.result && m.result.score >= 0.75) {
                        creditedAnchor = anchor;
                        creditedScore = m.result.score;
                        creditedSpan = m.span;
                        break;
                    }
                }
                if (creditedAnchor) {
                    session.consumedTokenIds[tokenId] = true;
                    if (creditedSpan === 2 && nextTok) session.consumedTokenIds[evidence.id + ':' + nextTok.idx] = true; // compound merge consumed two tokens
                    state.anchorHits[creditedAnchor.anchorIdx] = {
                        word: creditedAnchor.word,
                        source: source + '_reconciled',
                        evidenceId: evidence.id,
                        score: creditedScore
                    };
                    pushBounded(state, 'evidence', {
                        evidenceId: evidence.id,
                        source: source + '_reconciled',
                        text: evidence.text || '',
                        score: creditedScore,
                        method: 'reconciled'
                    }, MAX_EVIDENCE_PER_PHRASE);
                    pushBounded(state, 'consumedTokens', {
                        evidenceId: evidence.id,
                        tokenIdx: token.idx,
                        word: token.word,
                        anchor: creditedAnchor.word,
                        source: source + '_reconciled',
                        timeSec: tokenTime(evidence, token),
                        score: creditedScore
                    }, MAX_TOKENS_PER_PHRASE);
                    updatePhraseResult(session, state);
                    minIdx = ci;
                    break;
                }
            }
        }

        // --- Unique-anchor out-of-order catch-up (cheese-safe) ---
        // The monotonic pass + the interim floor are forward-only: they stop a repeated/
        // shared word reaching back to credit an earlier (often un-sung) line. But they
        // also SKIP a clearly-recognized, distinctive anchor presented out of order or
        // after a later line confirmed (observed Class-2: words the matcher matched yet
        // never credited; empty rejectedCandidates). Safe relaxation: credit an un-consumed
        // token to an un-hit anchor ONLY when that anchor word is UNIQUE among the un-hit
        // anchors of the in-window-flow candidate set — a unique word maps to exactly one
        // line, so it cannot mis-credit another, and the repeated-hook cheese case is
        // non-unique by construction (stays guarded). consumedTokenIds + the flow gate
        // still apply; the floor and minIdx do not.
        if (flowCandidates.length > 0) {
            var unhitWordCount = {};
            flowCandidates.forEach(function(phrase) {
                var st = session.states[phrase.phraseId];
                (st.phrase.anchors || []).forEach(function(anchor) {
                    if (st.anchorHits[anchor.anchorIdx]) return;
                    unhitWordCount[anchor.word] = (unhitWordCount[anchor.word] || 0) + 1;
                });
            });
            for (var uti = 0; uti < tokens.length; uti++) {
                var utoken = tokens[uti];
                var utokenId = evidence.id + ':' + utoken.idx;
                if (session.consumedTokenIds[utokenId]) continue;
                if (REPEATED_FILLER[utoken.word] || isAdlibWord(utoken.word)) continue;
                for (var uci = 0; uci < flowCandidates.length; uci++) {
                    var ustate = session.states[flowCandidates[uci].phraseId];
                    var uanchors = ustate.phrase.anchors || [];
                    var ucredited = null, uscore = 0;
                    for (var uai = 0; uai < uanchors.length; uai++) {
                        var uanchor = uanchors[uai];
                        if (ustate.anchorHits[uanchor.anchorIdx]) continue;
                        if (unhitWordCount[uanchor.word] !== 1) continue;   // ambiguous -> stay guarded
                        var ures = scoring.wordsMatchScore(utoken.word, uanchor.word, uanchor.phonetic);
                        if (ures && ures.score >= 0.8) { ucredited = uanchor; uscore = ures.score; break; }
                    }
                    if (ucredited) {
                        session.consumedTokenIds[utokenId] = true;
                        unhitWordCount[ucredited.word] = 0;   // consumed; no longer creditable
                        ustate.anchorHits[ucredited.anchorIdx] = {
                            word: ucredited.word, source: source + '_reconciled',
                            evidenceId: evidence.id, score: uscore
                        };
                        pushBounded(ustate, 'evidence', {
                            evidenceId: evidence.id, source: source + '_reconciled',
                            text: evidence.text || '', score: uscore, method: 'reconciled_unique'
                        }, MAX_EVIDENCE_PER_PHRASE);
                        pushBounded(ustate, 'consumedTokens', {
                            evidenceId: evidence.id, tokenIdx: utoken.idx, word: utoken.word,
                            anchor: ucredited.word, source: source + '_reconciled',
                            timeSec: tokenTime(evidence, utoken), score: uscore
                        }, MAX_TOKENS_PER_PHRASE);
                        updatePhraseResult(session, ustate);
                        break;
                    }
                }
            }
        }

        var newlyConfirmed = [];
        flowCandidates.forEach(function(phrase) {   // superset of `candidates` — covers both passes
            if (session.states[phrase.phraseId].cleared) newlyConfirmed.push(phrase.phraseId);
        });
        return newlyConfirmed;
    }

    // Interim-snapshot catch-up. Chrome's Web Speech endpointer rarely fires
    // `isFinal` during continuous singing over a track, so the correctly-heard
    // words live in the interim hypothesis. That hypothesis is NOT one monotonic
    // string for the whole song: Web Speech grows a recognition segment by
    // appending, then resets to a fresh (often short) segment when it finalizes or
    // aborts (real telemetry: a long verse hypothesis, then a bare " ya ya " outro).
    //
    // We detect segment continuity by prefix: a snapshot that still begins with the
    // prior one is the SAME segment (token indices stay stable as it appends) and
    // reuses its evidence id, so the engine's `consumedTokenIds` naturally dedups the
    // re-presented prefix — without it a shared anchor would inflate lines the singer
    // never reached. A snapshot that no longer extends the prior one is a NEW segment
    // (the reset), so it gets a fresh id: post-reset words still credit their line
    // (the fence cannot desync), and a legitimately re-sung word in a later segment
    // is credited as its own utterance rather than falsely deduped. Crediting is the
    // same monotonic one-token-one-line, ended-lines-only pass as a real late `final`.
    function reconcileInterimSnapshot(session, text, nowSec) {
        if (!session || !session.plan) return [];
        var words = normalizedWords(text);
        if (words.length === 0) return [];
        var prev = session._interimPrevWords || [];
        var extendsPrev = words.length >= prev.length;
        for (var i = 0; extendsPrev && i < prev.length; i++) {
            if (words[i] !== prev[i]) extendsPrev = false;
        }
        if (!extendsPrev || session._interimSegmentId == null) {
            session._interimSegmentId = (session._interimSegmentId || 0) + 1;
        }
        session._interimPrevWords = words;
        var floor = (session._interimFloorSec != null) ? session._interimFloorSec : -Infinity;
        var confirmed = reconcileLateEvidence(session, {
            id: 'bsr-int-' + session._interimSegmentId,
            source: 'browser_interim',
            text: words.join(' '),
            words: [],
            receivedAtSec: nowSec,
            audioTimeSec: nowSec
        }, nowSec, { minStartSec: floor, requireInWindowFlow: true });
        // Advance the forward-only floor past every line interim just confirmed, so a
        // later snapshot (esp. a revision that mints a fresh segment id) cannot reach
        // back and re-credit an earlier line the singer skipped.
        for (var ci = 0; ci < confirmed.length; ci++) {
            var cst = session.states[confirmed[ci]];
            if (cst && cst.phrase && (session._interimFloorSec == null || cst.phrase.startSec > session._interimFloorSec)) {
                session._interimFloorSec = cst.phrase.startSec;
            }
        }
        return confirmed;
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
        var conviction = 1;
        if (session && session.states) {
            var sumHit = 0;
            var sumReq = 0;
            var confirmedCount = 0;
            var engagedCount = 0;
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
                // Conviction: of the phrases you ENGAGED (hit >=1 anchor), how many did
                // you fully clear? Source-independent — a Whisper-rescued clear counts
                // exactly like a browser clear. Timing is intentionally NOT scored:
                // clearing is in-window by definition and "late" evidence is recognizer
                // lag, not the singer — a fair timing axis needs real word onsets
                // (forced alignment), a later stage.
                if (state.lyricStatus === 'confirmed') { confirmedCount++; engagedCount++; }
                else if (state.lyricStatus === 'partial') { engagedCount++; }
            });
            lyrics = sumReq > 0 ? clamp01(sumHit / sumReq) : 1;
            conviction = engagedCount > 0 ? confirmedCount / engagedCount : 1;
        }
        var composite = 0.75 * lyrics + 0.25 * conviction;
        return {
            lyrics: lyrics,
            conviction: conviction,
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
                anchors: (phrase.anchors || []).map(function (a) {
                    return {
                        word: a.word,
                        wordClass: a.wordClass,
                        weight: a.weight,
                        hit: !!state.anchorHits[a.anchorIdx]
                    };
                }),
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
        splitLyricWordsWithParens: splitLyricWordsWithParens,
        getDifficultyProfile: getDifficultyProfile,
        selectAnchors: selectAnchors,
        createPhraseSession: createPhraseSession,
        addEvidence: addEvidence,
        reconcileLateEvidence: reconcileLateEvidence,
        reconcileInterimSnapshot: reconcileInterimSnapshot,
        settlePhrases: settlePhrases,
        getPhraseTrace: getPhraseTrace,
        getLiveScore: getLiveScore
    };
});
