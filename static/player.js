const audio = document.getElementById('audio');
const playBtn = document.getElementById('playBtn');
const seekBar = document.getElementById('seek');
const volumeBar = document.getElementById('volume');
const timeDisplay = document.getElementById('time-display');
const lyricsScroll = document.getElementById('lyrics-scroll');
const noLyricsEl = document.getElementById('no-lyrics');

let lyrics = [];
let currentLineIndex = -1;

// Derive a stable per-song key for localStorage (offset, etc.)
function _songKey() {
    var sd = JSON.parse(sessionStorage.getItem('songData') || '{}');
    var key = (sd.artist || '') + '::' + (sd.title || '');
    return key || '_unknown';
}

// --- Word-matching, normalization & timing helpers ---
// Single source of truth: static/scoring.js (tested in tests/test_scoring.cjs),
// bound from window.KaraokeeScoring below. encodeWav stays inline (audio I/O).

/**
 * Encode a Float32Array of mono audio samples as a standard WAV buffer.
 * @param {Float32Array} float32 - Raw audio samples in [-1, 1]
 * @param {number} sampleRate - Sample rate (16000 for Whisper)
 * @returns {ArrayBuffer} - Valid WAV file bytes ready to POST
 */
function encodeWav(float32, sampleRate) {
    const pcm = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
        pcm[i] = Math.max(-32768, Math.min(32767, float32[i] * 32768));
    }
    const buf = new ArrayBuffer(44 + pcm.byteLength);
    const v = new DataView(buf);
    const w = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
    w(0, 'RIFF');  v.setUint32(4, 36 + pcm.byteLength, true);
    w(8, 'WAVE');  w(12, 'fmt ');
    v.setUint32(16, 16, true);          // PCM chunk size
    v.setUint16(20, 1, true);           // PCM format
    v.setUint16(22, 1, true);           // 1 channel (mono)
    v.setUint32(24, sampleRate, true);  // sample rate
    v.setUint32(28, sampleRate * 2, true); // byte rate
    v.setUint16(32, 2, true);           // block align
    v.setUint16(34, 16, true);          // bits per sample
    w(36, 'data'); v.setUint32(40, pcm.byteLength, true);
    new Int16Array(buf, 44).set(pcm);
    return buf;
}

var scoringHelpers = window.KaraokeeScoring;
var editDistance = scoringHelpers.editDistance;
var doubleMetaphone = scoringHelpers.doubleMetaphone;
var wordsMatch = scoringHelpers.wordsMatch;
var wordsMatchScore = scoringHelpers.wordsMatchScore;
var normalizeWord = scoringHelpers.normalizeWord;
var normalizeWords = scoringHelpers.normalizeWords;
var estimateSyllables = scoringHelpers.estimateSyllables;
var interpolateWordTimings = scoringHelpers.interpolateWordTimings;
var computeLineScore = scoringHelpers.computeLineScore;
var mergeConfirmedMatches = scoringHelpers.mergeConfirmedMatches;
var findMatchInWindow = scoringHelpers.findMatchInWindow;

class GameMode {
    constructor() {
        this.active       = false;
        this.recognition  = null;
        this.activeLineIdx = -1;

        // Current line tracking
        this.lineWords         = [];      // normalized words for active line
        this.matchedSet        = new Map(); // word index → match score (0.0–1.0)
        this.vadMatchedSet  = new Map(); // indices matched via VAD (optimistic)
        this.asrConfirmedSet = new Set(); // VAD-matched words later confirmed by ASR
        this.wordSourceMap     = new Map(); // word index -> vad | browser_sr | whisper
        this.transcript        = '';      // accumulated final transcript (never reset)
        this.transcriptWords   = [];      // normalized final transcript cached at append time
        this.lineStartWordCount = 0;      // word count in transcript when current line started
        this.lineStartTranscriptPos = 0;  // transcript word index when current line started (fence)
        this.latestInterim     = '';      // most recent interim, used to anchor fast-song lines

        // Scoring
        this.totalWords      = 0;
        this.matchedWords    = 0;
        this.weightedTotal   = 0;
        this.weightedMatched = 0;
        this.linesScored     = 0;
        this.perfectLines    = 0;
        this.currentStreak   = 0;
        this.bestStreak      = 0;

        // ASR activity tracking (zero-ASR line fencing)
        this.lineHadAsrEvent = false;

        // Recognition watchdog
        this._lastResultTime = 0;
        this._watchdogInterval = null;

        // Whisper Track 2 state
        this._whisperStream = null;
        this._whisperCtx    = null;
        this._whisperNode   = null;
        this._whisperRealtimeWs = null;
        this._whisperRealtimePc = null;
        this._whisperRealtimeDc = null;
        this._whisperRealtimeSession = null;
        this._whisperRealtimeTranscript = new Map();
        this._whisperRealtimeCallsUrl = 'https://api.openai.com/v1/realtime/calls';
        this.whisperBuffer  = '';
        this._whisperInFlight = 0;

        // Whisper server state (populated from /whisper-status at game start)
        this._whisperServerStatus = { state: 'unknown', reason: null, checkedAt: null, provider: null, model: null };
        this._whisperNextStatusPollAt = 0;
        this._whisperBackoffUntil = 0;

        // Whisper client track state (populated by _startWhisperTrack outcome)
        this._whisperTrackStatus  = { state: 'idle', reason: null, startAttempts: 0, startFailures: 0, provider: null };

        // Whisper chunk telemetry counters
        this._chunksDispatched          = 0;
        this._chunksSucceeded           = 0;
        this._chunksFailed503           = 0;
        this._chunksFailed500           = 0;
        this._chunksDroppedWhileLoading = 0;
        this._chunksFailedNetwork       = 0;
        this._chunksDroppedNotReady     = 0;
        this._whisperResponses          = 0;
        this._whisperResponsesWithWords = 0;
        this._whisperWordsTotal         = 0;
        this._whisperRealtimeDeltas     = 0;
        this._whisperRealtimeCompletions = 0;
        this._whisperRealtimeEvents     = 0;
        this._whisperRealtimeFailures   = 0;
        this._whisperRealtimeCommitsSent = 0;
        this._whisperRealtimeCommitTimer = null;
        this._whisperRealtimeLastEvent  = '';
        this._whisperRealtimeLastError  = '';
        this._lastWhisperTranscriptText = '';
        this._lastWhisperTranscriptAt   = null;

        // Diagnostic
        this._dbBuf = [];
        this._telemetry = null;   // populated by _initTelemetry() when debug mode is on
        this._lineStartAudioTime = null;
        this._phrasePlan = null;
        this._phraseSession = null;
        this._phraseDifficulty = 'medium';

        // Predictive timing state
        this.allWordTimings = [];    // interpolated word timings for all lines
        this.songTempoProfile = null; // per-song { p50, p80 } computed at start
        this.wordTimings    = [];    // word timings for current active line
        this.hotWordIndex   = -1;    // index of word whose time window contains audio.currentTime
        this.isSpeaking     = false; // true when mic energy exceeds threshold
        this._energyThreshold = 0.01; // RMS threshold for voice activity detection
        this._vadBaseline = 0;
        this._vadBaselineReady = false;
        this._vadBaselineSamples = [];
        this._vadAnalyser = null;        // AnalyserNode for real-time VAD
        this._vadAnalyserBuf = null;     // Float32Array reused each tick
        this._micVad = null;             // @ricky0123/vad-web MicVAD instance (V2 neural VAD)
        this._neuralVadActive = false;   // true once MicVAD inits OK (else fall back to RMS)
        this._commitState = null;        // KaraokeeCommitHelpers state machine
        this._vadInitError = null;       // last neural-VAD init error (telemetry/HUD)
        this.currentParams = getWindowParams('normal'); // adaptive window params for active line

        this.lrcOffset = 0;   // seconds to add to all LRC timestamps (positive = delay lyrics)
        this._suspended = false;

        // Soft boundary: previous line overlay during overlap zone
        this.prevLine = null;  // { lineIdx, lineWords, matchedSet, lineStartWordCount, lineStartTranscriptPos, wordTimings, params, overlapEnd, whisperBuffer }
    }

    start() {
        if (this.active) return;
        this.active = true;
        this._suspended = false;
        this._resetSessionCounters();
        this._vadState = (typeof createVadState === 'function') ? createVadState() : null;
        this.allWordTimings = interpolateWordTimings(lyrics);
        this.songTempoProfile = computeSongTempoProfile(this.allWordTimings);
        this._initTelemetry();   // always init so download button works whenever D is pressed
        this._phraseDifficulty = localStorage.getItem('arcadeDifficulty') || 'medium';
        if (window.KaraokeePhraseEngine) {
            this._phrasePlan = KaraokeePhraseEngine.buildPhrasePlan(lyrics, {
                difficulty: this._phraseDifficulty,
                audioDuration: playback ? (playback.duration() || null) : null
            });
            // The scoring session owns the per-run state machine (match -> reconcile ->
            // score -> commit). It builds its own phraseSession/arcadeState from the plan;
            // we alias the controller's _phraseSession/_arcadeState/_committedPhrases/
            // _arcadeEvents to the session's copies so the kept renderers/loggers/telemetry
            // (which read this.*) see the same objects the session mutates in place.
            this._session = KaraokeeScoringSession.createSession({
                lyrics: lyrics,
                allWordTimings: this.allWordTimings,
                phrasePlan: this._phrasePlan,
                difficulty: this._phraseDifficulty,
                flags: { KARAOKEE_V2: !!window.KARAOKEE_V2 }
            });
            this._phraseSession   = this._session.phraseSession;
            this._arcadeState     = this._session.arcadeState;
            this._committedPhrases = this._session.committedPhrases;
            this._arcadeEvents    = this._session.arcadeEvents;
            this._telemetryFinalized = false;
            if (this._telemetry && this._telemetry.phraseEngine) {
                this._telemetry.phraseEngine.difficulty = this._phraseDifficulty;
                this._telemetry.phraseEngine.plan = this._phrasePlan;
            }
        }
        var _dpShow = document.getElementById('diff-pill');
        if (_dpShow) { _dpShow.textContent = (this._phraseDifficulty || 'medium').toUpperCase(); _dpShow.style.display = 'inline-block'; }
        for (var li = 0; li < this.allWordTimings.length; li++) {
            var lt = this.allWordTimings[li];
            var relClass = classifyLineTempoRelative(lt.wps || 0, this.songTempoProfile);
            lt.useVad = true; // all tempo classes get provisional VAD; slow lines use stricter energy gate in updateHotWord
            lt.vadTempoClass = relClass;
        }
        // Restore per-song LRC offset from localStorage
        this.lrcOffset = parseFloat(localStorage.getItem('lrcOffset_' + _songKey()) || '0');
        if (this._session) this._session.lrcOffset = this.lrcOffset;
        _updateOffsetDisplay();

        renderLyricsGameMode();
        this._setupRecognition();
        this._startMicAnalysis(); // async — mic + VAD always; realtime attaches only with a key

        // Recognizer state is local now (no server): browser SR is the free default; a
        // stored OpenAI key promotes to realtime whisper. Drives the HUD + downstream gating.
        var _premium = !!(window.KaraokeeKeyStore && window.KaraokeeKeyStore.recognizerMode() === 'premium');
        this._whisperServerStatus = _premium
            ? { state: 'ready', reason: null, provider: 'openai_realtime', model: 'gpt-realtime-whisper', checkedAt: Date.now() }
            : { state: 'ready', reason: null, provider: 'browser_sr', model: 'Web Speech API', checkedAt: Date.now() };
        this._renderAsrProviderStatus();

        document.getElementById('score-display').style.display = 'flex';
        document.getElementById('score-pct').textContent = '0%';
        document.getElementById('gameBtn').classList.add('active');
        document.getElementById('lrc-offset-control').style.display = 'flex';
        this._renderV2Panel();
        if (window.KARAOKEE_V2 && this._arcadeState) this._renderArcadeHud(null);
    }

    stop() {
        if (!this.active) return;
        this.active = false;
        if (this._watchdogInterval) {
            clearInterval(this._watchdogInterval);
            this._watchdogInterval = null;
        }
        if (this.recognition) {
            this.recognition.onend = null;
            this.recognition.stop();
            this.recognition = null;
        }
        this._stopWhisperTrack();
        this.prevLine = null;
        renderLyrics(); // restore normal lyric rendering
        document.getElementById('score-display').style.display = 'none';
        document.getElementById('gameBtn').classList.remove('active');
        document.getElementById('lrc-offset-control').style.display = 'none';
        var _v2 = document.getElementById('v2-panel'); if (_v2) _v2.style.display = 'none';
        var _dpHide = document.getElementById('diff-pill'); if (_dpHide) _dpHide.style.display = 'none';
        this._hideArcadeHud();
        // Flush the session (final collect + score active line + settle/commit) before
        // telemetry so getScores/arcadeEvents reflect the last line. Manual stop uses the
        // current media time (not duration+5) so only already-closed phrases settle.
        if (this._session) this._renderEvents(KaraokeeScoringSession.endRun(this._session, this._now()));
        this._finalizeTelemetry('stopped');
    }

    /**
     * Suspend judging (on pause). Stops recognition and VAD but keeps game active.
     */
    suspend() {
        if (!this.active || this._suspended) return;
        this._suspended = true;
        if (this._session) this._session._suspended = true;
        if (this.recognition) {
            try { this.recognition.stop(); } catch(e) {}
        }
        this.isSpeaking = false;
        if (this._session) KaraokeeScoringSession.setEnergy(this._session, false);
    }

    /**
     * Resume judging (on play after pause). Restarts recognition.
     */
    resume() {
        if (!this.active || !this._suspended) return;
        this._suspended = false;
        if (this._session) this._session._suspended = false;
        if (this.recognition) {
            try { this.recognition.start(); } catch(e) {}
        }
    }

    _resetLineState(lineStartAudioTime, discardPrevLine) {
        this.matchedSet = new Map();
        this.vadMatchedSet = new Map();
        this.asrConfirmedSet = new Set();
        this.wordSourceMap = new Map();
        this.lineStartWordCount = this.transcriptWords.length;
        this.lineStartTranscriptPos = this.lineStartWordCount;
        this.hotWordIndex = -1;
        this.whisperBuffer = '';
        this.lineHadAsrEvent = false;
        this._lineComparisonCount = 0;
        this._telemetryLoggedMatches = new Set();
        this._lineStartAudioTime = lineStartAudioTime;
        if (discardPrevLine) this.prevLine = null;
    }

    _resetSessionCounters() {
        this._reachedEnd = false;   // set true when playback fires onEnded; feeds meta.completed
        this._endShown = false;     // idempotency latch for showEndModal (reset per song)
        this._lastEndCheckT = null; // end-of-song stall detector (poll-based completion)
        this._endStallTicks = 0;
        this.activeLineIdx = -1;
        this.lineWords = [];
        this._resetLineState(0, true);
        this.transcript = '';
        this.transcriptWords = [];
        this.lineStartWordCount = 0;
        this.lineStartTranscriptPos = 0;
        this.latestInterim = '';
        this.totalWords = 0;
        this.matchedWords = 0;
        this.weightedTotal = 0;
        this.weightedMatched = 0;
        if (window.KaraokeeArcade && this._phraseDifficulty) {
            this._arcadeState = KaraokeeArcade.createArcadeState(this._phraseDifficulty);
        }
        this._committedPhrases = {};
        this._arcadeEvents = [];
        this._telemetryFinalized = false;
        document.body.classList.remove('arcade-onfire');
        this.linesScored = 0;
        this.perfectLines = 0;
        this.currentStreak = 0;
        this.bestStreak = 0;
        this._lastResultTime = Date.now();
        this._dbBuf = [];
        this._telemetry = null;
        this._phrasePlan = null;
        this._phraseSession = null;
        this._phraseDifficulty = 'medium';
        this.wordTimings = [];
        this.hotWordIndex = -1;
        this.isSpeaking = false;
        this._vadBaseline = 0;
        this._vadBaselineReady = false;
        this._vadBaselineSamples = [];
        this._vadAnalyser = null;
        this._vadAnalyserBuf = null;
        this._micVad = null;
        this._neuralVadActive = false;
        this._commitState = null;
        this._vadInitError = null;
        this._energyThreshold = 0.01;
        this._whisperInFlight = 0;
        this._whisperServerStatus = { state: 'unknown', reason: null, checkedAt: null, provider: null, model: null };
        this._whisperNextStatusPollAt = 0;
        this._whisperBackoffUntil = 0;
        this._whisperTrackStatus = { state: 'idle', reason: null, startAttempts: 0, startFailures: 0, provider: null };
        this._chunksDispatched = 0;
        this._chunksSucceeded = 0;
        this._chunksFailed503 = 0;
        this._chunksFailed500 = 0;
        this._chunksDroppedWhileLoading = 0;
        this._chunksFailedNetwork = 0;
        this._chunksDroppedNotReady = 0;
        this._whisperResponses = 0;
        this._whisperResponsesWithWords = 0;
        this._whisperWordsTotal = 0;
        this._whisperRealtimeDeltas = 0;
        this._whisperRealtimeCompletions = 0;
        this._whisperRealtimeEvents = 0;
        this._whisperRealtimeFailures = 0;
        this._whisperRealtimeCommitsSent = 0;
        this._whisperRealtimeLastEvent = '';
        this._whisperRealtimeLastError = '';
        this._lastWhisperTranscriptText = '';
        this._lastWhisperTranscriptAt = null;
        this.allWordTimings = [];
        this.songTempoProfile = null;
    }

    /**
     * Handle seek/skip during game mode. Resets current line scoring state
     * so that pre-seek transcript doesn't count toward the new position.
     */
    onSeek() {
        if (!this.active) return;
        // Seek handling is intentionally minimal in the seam refactor. The session owns
        // the scoring state and exposes no "discard current line without scoring" primitive
        // (setActiveLine snapshots + scores the outgoing line, which on a backward in-line
        // seek would double-count). When the seek crosses a line boundary, the next
        // updateLyrics poll calls setActiveLine for the new position, which resets the
        // session's line state (matchedSet, fence, prevLine) and re-fences the transcript.
        // Discard the current line's accumulated match state and re-fence the transcript
        // to NOW so pre-seek words cannot credit the post-seek position: a backward in-line
        // seek drops stale matches, and a boundary-crossing seek won't score the seeked-away
        // line (resetActiveLine clears lineHadAsrEvent -> the next setActiveLine hits
        // scoreLine's zero-ASR fence). Then repaint for immediate visual feedback.
        if (this._session) KaraokeeScoringSession.resetActiveLine(this._session, this._now());
        this._updateWordSpans();
    }

    _setupRecognition() {
        var self = this;
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) {
            alert('Speech recognition is not supported in this browser. Use Chrome.');
            this.stop();
            return;
        }

        this.recognition = new SR();
        this.recognition.continuous = true;
        this.recognition.interimResults = true;
        this.recognition.lang = 'en-US';
        this.recognition.maxAlternatives = 3;

        this.recognition.onresult = function(e) {
            self._lastResultTime = Date.now();
            var interim = '';
            var finalText = '';
            for (var i = e.resultIndex; i < e.results.length; i++) {
                if (e.results[i].isFinal) {
                    finalText += e.results[i][0].transcript + ' ';
                } else {
                    interim += e.results[i][0].transcript + ' ';
                }
            }
            // Feed the session (feed-only — rendering happens on the next tick). A single
            // SR event can carry BOTH a final and an interim: ingest the final first (if
            // any), then always set the interim (mirrors the old append at 423-427).
            if (self._session) {
                if (finalText) KaraokeeScoringSession.ingestFinal(self._session, finalText, 'browser_sr');
                KaraokeeScoringSession.ingestInterim(self._session, interim);
            }

            // Diagnostic: log what the recognition heard (ASR telemetry feeds the payload).
            if (window._kDebug) {
                self._debugLog('RESULT', {
                    lineIdx:   self.activeLineIdx,
                    finalText: finalText || null,
                    interim:   interim   || null,
                });
                self._logAsr(finalText ? 'final' : 'interim', finalText || interim, [], 'browser_sr');
            }
        };

        // Auto-restart so recognition doesn't stop on silence
        this.recognition.onend = () => {
            if (this.active) {
                this.recognition.start();
                this._lastResultTime = Date.now();
            }
        };

        this.recognition.onerror = (e) => {
            if (e.error === 'not-allowed') {
                alert('Microphone access denied. Enable mic permission and try again.');
                this.stop();
            }
        };

        this.recognition.start();

        // Watchdog: detect when recognition silently dies and force restart
        this._watchdogInterval = setInterval(() => {
            if (!this.active || !playback || playback.isPaused()) return;
            if (Date.now() - this._lastResultTime > 5000) {
                console.warn('[GAME] Recognition watchdog: no results for 5s, restarting');
                this._lastResultTime = Date.now();
                try { this.recognition.abort(); } catch(e) {}
                // onend handler will restart
            }
        }, 2000);
    }

    _renderAsrProviderStatus() {
        var el = document.getElementById('asr-provider-display');
        if (!el) return;
        var status = this._whisperServerStatus || {};
        var provider = status.provider || 'unknown';
        var model = status.model || 'unknown';
        var state = status.state || 'unknown';
        if (provider === 'openai_realtime') {
            el.textContent = 'ASR: GPT Realtime Whisper (' + model + ') - ' + state;
            el.style.color = state === 'ready' ? '#00e676' : '#f5a623';
        } else if (provider === 'local') {
            el.textContent = 'ASR: local Whisper (' + model + ') - ' + state;
            el.style.color = state === 'ready' ? '#aaa' : '#f5a623';
        } else {
            el.textContent = 'ASR: ' + provider + ' (' + model + ') - ' + state;
            el.style.color = '#aaa';
        }
    }

    _isRealtimeWhisperProvider() {
        // Static build: recognizer mode is local — a stored OpenAI key promotes to realtime.
        return !!(window.KaraokeeKeyStore && window.KaraokeeKeyStore.recognizerMode() === 'premium');
    }

    _buildRealtimeWhisperPrompt() {
        var bits = [];
        var titleEl = document.getElementById('song-title');
        if (titleEl && titleEl.textContent) bits.push(titleEl.textContent);
        // Bias the recognizer toward the song's vocabulary (spelling hint for uncommon
        // words) using a DEDUPED whole-song vocabulary rather than the lyric sequence: the
        // sequence lets the model predict the next expected word (a honesty risk), whereas
        // the deduped vocab only nudges spelling. Covers the whole song, not just the open.
        if (lyrics && lyrics.length && typeof buildLyricVocabulary === 'function') {
            bits.push(buildLyricVocabulary(lyrics, 800));
        }
        return bits.join(' ').slice(0, 900);
    }

    _openRealtimeWhisperConnection() {
        if (!window.KaraokeeRealtimeWhisper) {
            return Promise.reject(new Error('Realtime Whisper helper is unavailable'));
        }
        var prompt = this._buildRealtimeWhisperPrompt();
        var key = window.KaraokeeKeyStore && window.KaraokeeKeyStore.getKey();
        if (!key) return Promise.reject(new Error('No OpenAI key for premium recognition'));
        // BYO-key: mint the ephemeral client secret DIRECTLY from the browser with the
        // user's key (no server broker on the static deploy). The key is sent only to
        // OpenAI; the returned short-lived secret authorizes the /v1/realtime/calls WebRTC
        // connection below. Body mirrors app.py _create_openai_realtime_transcription_session.
        var mintBody = KaraokeeRealtimeWhisper.buildClientSecretBody({
            model: 'gpt-realtime-whisper', language: 'en', prompt: prompt,
        });
        return fetch('https://api.openai.com/v1/realtime/client_secrets', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
            body: JSON.stringify(mintBody),
        })
            .then(function(resp) {
                if (!resp.ok) {
                    throw new Error('Realtime transcription session failed with HTTP ' + resp.status);
                }
                return resp.json();
            })
            .then(function(session) {
                this._whisperRealtimeSession = session;
                var secret = KaraokeeRealtimeWhisper.extractClientSecret(session);
                var pc = new RTCPeerConnection();
                var dc = pc.createDataChannel('oai-events');
                this._whisperRealtimePc = pc;
                this._whisperRealtimeDc = dc;

                if (!this._whisperStream) {
                    throw new Error('Realtime Whisper mic stream is not available');
                }
                this._whisperStream.getAudioTracks().forEach(function(track) {
                    pc.addTrack(track, this._whisperStream);
                }.bind(this));

                dc.addEventListener('message', function(event) {
                    this._handleRealtimeWhisperRawEvent(event.data);
                }.bind(this));
                dc.addEventListener('open', function() {
                    this._whisperRealtimeLastEvent = 'data_channel.open';
                    this._startRealtimeWhisperCommitTimer();
                    this._renderAsrProviderStatus();
                }.bind(this));
                dc.addEventListener('close', function() {
                    this._whisperRealtimeLastEvent = 'data_channel.close';
                    this._stopRealtimeWhisperCommitTimer();
                }.bind(this));
                dc.addEventListener('error', function() {
                    this._chunksFailedNetwork++;
                    this._whisperRealtimeLastError = 'data channel error';
                }.bind(this));

                return pc.createOffer()
                    .then(function(offer) {
                        return pc.setLocalDescription(offer).then(function() { return offer; });
                    })
                    .then(function(offer) {
                        return fetch(this._whisperRealtimeCallsUrl, {
                            method: 'POST',
                            headers: {
                                'Authorization': 'Bearer ' + secret,
                                'Content-Type': 'application/sdp',
                            },
                            body: offer.sdp,
                        });
                    }.bind(this))
                    .then(function(resp) {
                        if (!resp.ok) {
                            return resp.text().then(function(text) {
                                throw new Error('Realtime WebRTC answer failed with HTTP ' + resp.status + ': ' + text.slice(0, 240));
                            });
                        }
                        return resp.text();
                    })
                    .then(function(answerSdp) {
                        return pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
                    })
                    .then(function() {
                        return pc;
                    });
            }.bind(this));
    }

    _startRealtimeWhisperCommitTimer() {
        this._stopRealtimeWhisperCommitTimer();
        var self = this;
        this._whisperRealtimeCommitTimer = setInterval(function() {
            var dc = self._whisperRealtimeDc;
            if (!dc || dc.readyState !== 'open') return;
            if (!window.KaraokeeRealtimeWhisper) return;
            // V2 with neural VAD active: commits are VAD-driven (onSpeechEnd) + the tempo
            // cap (updateHotWord). The blind timer stays inert. If neural VAD failed to
            // init (_neuralVadActive false), this 700ms fallback keeps the path alive.
            if (window.KARAOKEE_V2 && self._neuralVadActive) return;
            try {
                dc.send(JSON.stringify(KaraokeeRealtimeWhisper.buildCommitEvent()));
                self._whisperRealtimeCommitsSent++;
            } catch (err) {
                self._whisperRealtimeLastError = err && err.message ? err.message : 'commit send failed';
            }
        // 700ms (was 1500): commit the realtime audio buffer more often so a line's
        // last words are transcribed and returned before the line is finalized.
        }, 700);
    }

    _stopRealtimeWhisperCommitTimer() {
        if (this._whisperRealtimeCommitTimer) {
            clearInterval(this._whisperRealtimeCommitTimer);
            this._whisperRealtimeCommitTimer = null;
        }
    }

    // V2 neural VAD: Silero via @ricky0123/vad-web, reusing the existing mic stream.
    // MicVAD owns Silero + hysteresis and emits speech-start/end; we drive isSpeaking
    // and the commit cadence (commit-helpers) from those edges. Falls back silently
    // to the RMS path if the library/model fails to load.
    async _startNeuralVad() {
        if (!window.KARAOKEE_V2) return;
        if (!window.vad || !window.vad.MicVAD || !window.KaraokeeCommitHelpers) {
            this._vadInitError = 'vad-web/commit-helpers not loaded';
            return;
        }
        if (!this._whisperStream) { this._vadInitError = 'no mic stream'; return; }
        var self = this;
        this._commitState = KaraokeeCommitHelpers.createCommitState();
        try {
            // ort's threaded wasm needs SharedArrayBuffer (cross-origin isolation); without
            // COOP/COEP headers that's unavailable, so force single-threaded to avoid an init
            // throw. Silero is tiny (RTF << 1), so one thread is plenty.
            if (window.ort && window.ort.env && window.ort.env.wasm) {
                window.ort.env.wasm.numThreads = 1;
            }
            this._micVad = await window.vad.MicVAD.new({
                // Reuse Karaokee's already-open stream; never let MicVAD stop its tracks.
                getStream: function () { return Promise.resolve(self._whisperStream); },
                pauseStream: function () { return Promise.resolve(); },
                resumeStream: function () { return Promise.resolve(self._whisperStream); },
                baseAssetPath: '/static/vendor/vad/',
                onnxWASMBasePath: '/static/vendor/vad/',
                onSpeechStart: function () {
                    self.isSpeaking = true;
                    KaraokeeCommitHelpers.noteSpeechStart(self._commitState, performance.now());
                },
                onSpeechEnd: function () {
                    self.isSpeaking = false;
                    var r = KaraokeeCommitHelpers.noteSpeechEnd(self._commitState, performance.now());
                    if (r.commit) self._commitRealtimeBuffer();
                }
            });
            this._micVad.start();
            this._neuralVadActive = true;
        } catch (err) {
            this._vadInitError = (err && err.message) ? err.message : 'vad init failed';
            this._neuralVadActive = false;
            this._micVad = null;
        }
    }

    // Send one input_audio_buffer.commit on the realtime data channel and advance the
    // commit-cadence state. Shared by the speech-end edge and the tempo cap.
    _commitRealtimeBuffer() {
        var dc = this._whisperRealtimeDc;
        if (!dc || dc.readyState !== 'open') return;
        if (!window.KaraokeeRealtimeWhisper) return;
        try {
            dc.send(JSON.stringify(KaraokeeRealtimeWhisper.buildCommitEvent()));
            this._whisperRealtimeCommitsSent++;
            if (this._commitState && window.KaraokeeCommitHelpers) {
                KaraokeeCommitHelpers.noteCommitted(this._commitState, performance.now());
            }
        } catch (err) {
            this._whisperRealtimeLastError = (err && err.message) ? err.message : 'commit send failed';
        }
    }

    _handleRealtimeWhisperRawEvent(rawEvent) {
        if (typeof Blob !== 'undefined' && rawEvent instanceof Blob) {
            rawEvent.text().then(function(text) {
                this._handleRealtimeWhisperEvent(text);
            }.bind(this)).catch(function(err) {
                this._whisperRealtimeLastError = err.message || String(err);
            }.bind(this));
            return;
        }
        this._handleRealtimeWhisperEvent(rawEvent);
    }

    _handleRealtimeWhisperEvent(rawEvent) {
        var event = null;
        try { event = JSON.parse(rawEvent); } catch (_err) {
            this._whisperRealtimeLastError = 'unparseable event';
            return;
        }
        if (!event || !event.type) return;
        this._whisperRealtimeEvents++;
        this._whisperRealtimeLastEvent = event.type;
        if (window._kDebug) console.log('[Realtime Whisper event]', event);
        if (event.type === 'conversation.item.input_audio_transcription.delta') {
            this._whisperRealtimeDeltas++;
            if (event.item_id) {
                var current = this._whisperRealtimeTranscript.get(event.item_id) || '';
                this._whisperRealtimeTranscript.set(event.item_id, current + (event.delta || ''));
            }
            return;
        }
        if (event.type === 'conversation.item.input_audio_transcription.completed') {
            var transcript = event.transcript || '';
            if (!transcript && event.item_id) {
                transcript = this._whisperRealtimeTranscript.get(event.item_id) || '';
            }
            if (event.item_id) this._whisperRealtimeTranscript.delete(event.item_id);
            this._chunksSucceeded++;
            this._whisperRealtimeCompletions++;
            this._lastWhisperTranscriptText = transcript;
            this._lastWhisperTranscriptAt = performance.now();
            this._handleWhisperTranscript(transcript, [], null);
            return;
        }
        if (event.type === 'conversation.item.input_audio_transcription.failed') {
            this._whisperRealtimeFailures++;
            this._whisperRealtimeLastError = event.error && event.error.message ? event.error.message : 'transcription failed';
            this._chunksFailed500++;
            return;
        }
        if (event.type === 'error') {
            var message = event.error && event.error.message ? event.error.message : 'Realtime Whisper error';
            this._whisperRealtimeFailures++;
            this._whisperRealtimeLastError = message;
            this._whisperServerStatus = {
                state: 'error',
                reason: message,
                provider: 'openai_realtime',
                model: this._whisperServerStatus.model || 'gpt-realtime-whisper',
                checkedAt: Date.now()
            };
            this._chunksFailed500++;
            this._renderAsrProviderStatus();
        }
    }

    _handleWhisperTranscript(transcript, words, dispatchedLineIdx) {
        if (!transcript || !this.active) return;
        // Feed Track-2 (whisper) finals to the session as 'whisper' evidence. The session
        // accumulates the whisperBuffer, runs collectMatchesWhisper on the next tick, and
        // feeds phrase evidence (incl. late-evidence reconcile) with the tick clock.
        // Route gate preserved: a chunk dispatched for the CURRENT active line is ingested;
        // a stale-line chunk is left to the engine's late-evidence reconcile (the old
        // prevLine track-2 _matchPrevLine path has no session equivalent — see report).
        var routeToActive = (dispatchedLineIdx === null || dispatchedLineIdx === undefined || dispatchedLineIdx === this.activeLineIdx);
        if (routeToActive && this._session) {
            KaraokeeScoringSession.ingestFinal(this._session, transcript, 'whisper');
        }
        this._logAsr('final', transcript, words || [], 'whisper');
        this._whisperResponses++;
        if (words && words.length > 0) {
            this._whisperResponsesWithWords++;
            this._whisperWordsTotal += words.length;
            this._lastWhisperWords = words;
        }
    }

    _countWordSources(sourceMap) {
        var counts = { vad: 0, browser_sr: 0, whisper: 0, unknown: 0 };
        var map = sourceMap || this.wordSourceMap;
        if (!map) return counts;
        map.forEach(function(source) {
            if (counts[source] === undefined) counts.unknown++;
            else counts[source]++;
        });
        return counts;
    }

    async _startMicAnalysis() {
        this._whisperTrackStatus.startAttempts++;
        try {
            this._whisperTrackStatus.state = 'starting';
            var premium = this._isRealtimeWhisperProvider();
            this._whisperTrackStatus.provider = premium ? 'openai_realtime' : 'browser_sr';
            this._whisperStream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
            });
            var sampleRate = premium ? 24000 : 16000;
            this._whisperCtx    = new AudioContext({ sampleRate: sampleRate });
            const src  = this._whisperCtx.createMediaStreamSource(this._whisperStream);
            // VAD AnalyserNode — polled every 100ms, decoupled from Whisper chunks
            this._vadAnalyser = this._whisperCtx.createAnalyser();
            this._vadAnalyser.fftSize = 256;
            this._vadAnalyserBuf = new Float32Array(this._vadAnalyser.fftSize);
            src.connect(this._vadAnalyser);
            // Neural VAD always runs (it self-gates on KARAOKEE_V2) so the free lane keeps
            // its voice-energy edges feeding the (unchanged) scoring path.
            await this._startNeuralVad();
            // Premium only: attach the OpenAI realtime recognizer to the SAME mic stream.
            if (premium) {
                await this._openRealtimeWhisperConnection();
            }
            this._whisperTrackStatus.state = 'ready';
            this._renderAsrProviderStatus();
        } catch (err) {
            this._whisperTrackStatus.state = 'error';
            this._whisperTrackStatus.reason = err.message || String(err);
            this._whisperTrackStatus.startFailures++;
            this._renderAsrProviderStatus();
            console.warn('[Whisper track] unavailable:', this._whisperTrackStatus.reason);
            this._whisperStream = null;
            this._whisperCtx    = null;
            this._whisperNode   = null;
        }
    }

    _stopWhisperTrack() {
        this._stopRealtimeWhisperCommitTimer();
        if (this._whisperRealtimeWs) {
            try { this._whisperRealtimeWs.close(); } catch(e) {}
            this._whisperRealtimeWs = null;
        }
        if (this._whisperRealtimeDc) {
            try { this._whisperRealtimeDc.close(); } catch(e) {}
            this._whisperRealtimeDc = null;
        }
        if (this._whisperRealtimePc) {
            try { this._whisperRealtimePc.close(); } catch(e) {}
            this._whisperRealtimePc = null;
        }
        this._whisperRealtimeSession = null;
        this._whisperRealtimeTranscript.clear();
        if (this._whisperNode) {
            this._whisperNode.disconnect();
            this._whisperNode = null;
        }
        if (this._whisperCtx) {
            this._whisperCtx.close();
            this._whisperCtx = null;
        }
        if (this._micVad) {
            try { this._micVad.destroy(); } catch (e) {}
            this._micVad = null;
        }
        this._neuralVadActive = false;
        this._commitState = null;
        this._vadAnalyser    = null;
        this._vadAnalyserBuf = null;
        if (this._whisperStream) {
            this._whisperStream.getTracks().forEach(t => t.stop());
            this._whisperStream = null;
        }
    }

    /** Poll /whisper-status and update _whisperServerStatus. Returns a Promise. */
    _checkWhisperServerStatus() {
        // Static build: no server to poll. Status is derived from key-store at start();
        // kept as a resolved no-op so any legacy caller/poller is inert.
        return Promise.resolve();
    }

    _pollWhisperStatusThrottled(intervalMs) {
        var now = Date.now();
        intervalMs = intervalMs || 3000;
        if (now < this._whisperNextStatusPollAt) return;
        this._whisperNextStatusPollAt = now + intervalMs;
        this._checkWhisperServerStatus();
    }

    _canDispatchWhisperChunk() {
        var now = Date.now();
        if (now < this._whisperBackoffUntil) return false;
        if (this._isRealtimeWhisperProvider()) {
            return !!(this._whisperServerStatus
                && this._whisperServerStatus.state === 'ready'
                && this._whisperRealtimeWs
                && this._whisperRealtimeWs.readyState === WebSocket.OPEN);
        }
        return !!(this._whisperServerStatus && this._whisperServerStatus.state === 'ready');
    }

    _dropWhisperChunkNotReady() {
        var state = this._whisperServerStatus ? this._whisperServerStatus.state : 'unknown';
        if (state === 'loading') this._chunksDroppedWhileLoading++;
        else this._chunksDroppedNotReady++;
        this._pollWhisperStatusThrottled(state === 'loading' ? 2000 : 5000);
    }

    async _sendChunkToWhisper(float32) {
        if (!this._canDispatchWhisperChunk()) {
            this._dropWhisperChunkNotReady();
            return;
        }

        this._chunksDispatched++;
        if (this._isRealtimeWhisperProvider()) {
            try {
                var encoded = KaraokeeRealtimeWhisper.float32ToPcm16Base64(float32);
                this._whisperRealtimeWs.send(JSON.stringify(KaraokeeRealtimeWhisper.buildAppendAudioEvent(encoded)));
            } catch (_err) {
                this._chunksFailedNetwork++;
            }
            return;
        }

        this._whisperInFlight++;
        const wav = encodeWav(float32, 16000);
        const dispatchedLineIdx = this.activeLineIdx;
        try {
            const resp = await fetch('/transcribe', {
                method: 'POST',
                body: wav,
                headers: { 'Content-Type': 'audio/wav' },
            });

            if (resp.status === 503) {
                this._chunksFailed503++;
                var statusPayload = null;
                try { statusPayload = await resp.json(); } catch (_jsonErr) {}
                this._whisperServerStatus = {
                    state: statusPayload && statusPayload.status ? statusPayload.status : 'loading',
                    reason: statusPayload && statusPayload.error ? statusPayload.error : 'model not ready',
                    provider: this._whisperServerStatus.provider || null,
                    model: this._whisperServerStatus.model || null,
                    checkedAt: Date.now()
                };
                this._whisperBackoffUntil = Date.now() + 5000;
                this._pollWhisperStatusThrottled(5000);
                return;
            }
            if (resp.status === 500) {
                this._chunksFailed500++;
                console.warn('[Whisper] transcription error (500) — continuing');
                return;
            }
            if (!resp.ok) {
                this._chunksFailed500++;
                console.warn('[Whisper] unexpected HTTP', resp.status);
                return;
            }

            const data = await resp.json();
            this._chunksSucceeded++;
            this._whisperServerStatus.state = 'ready'; // confirmed working
            this._whisperBackoffUntil = 0;

            this._handleWhisperTranscript(data.transcript, data.words || [], dispatchedLineIdx);
        } catch (_err) {
            this._chunksFailedNetwork++;
            /* fire-and-forget — network errors are expected on flaky connections */
        } finally {
            this._whisperInFlight = Math.max(0, this._whisperInFlight - 1);
        }
    }

    // Media-time clock injected into the session (seconds). The session reads no real
    // clock; every advance call passes _now() so behavior is identical to the old
    // audio.currentTime reads but testable.
    _now() {
        return playback ? playback.currentTime() : 0;
    }

    // Trigger point: the 100ms updateLyrics loop calls this on every line change.
    // Delegates the whole line-transition state machine to the session and renders the
    // returned events (the old body now lives in scoring-session.js setActiveLine).
    setActiveLine(lineIdx) {
        if (!this._session) return;
        this._renderEvents(KaraokeeScoringSession.setActiveLine(this._session, lineIdx, this._now()));
    }

    _updateWordSpans() {
        const lines = lyricsScroll.querySelectorAll('.lyric-line');
        const lineEl = lines[this.activeLineIdx];
        if (!lineEl) return;

        if (window.KARAOKEE_V2) { this._paintAnchorSpansLive(lineEl); return; }

        const spans = lineEl.querySelectorAll('.word-span');
        spans.forEach((span, wi) => {
            span.classList.remove('matched', 'matched-partial', 'missed');
            var _wScore = this.matchedSet.get(wi);
            if (_wScore !== undefined) {
                span.classList.add(_wScore >= 0.75 ? 'matched' : 'matched-partial');
                // Only add asr-confirmed if not already present — avoids replaying the animation
                if (this.asrConfirmedSet.has(wi) && !span.classList.contains('asr-confirmed')) {
                    span.classList.add('asr-confirmed');
                }
            } else {
                // Word is unmatched — clear any stale asr-confirmed class
                span.classList.remove('asr-confirmed');
            }
        });
    }

    // V2: green a key-word span the moment the engine credits its anchor (anchorHits).
    // Reds are applied at settle (see _commitNewlySettled). Non-key spans untouched.
    _paintAnchorSpansLive(lineEl) {
        var states = this._phraseSession && this._phraseSession.states;
        if (!states) return;
        lineEl.querySelectorAll('.word-span[data-phrase-id]').forEach(function (span) {
            var st = states[span.dataset.phraseId];
            if (!st) return;
            if (st.lyricStatus === 'confirmed') {
                // Passed the line — light the whole phrase green.
                span.classList.add('matched');
                span.classList.remove('missed');
            } else if (span.classList.contains('key-word')) {
                // Not yet passed — green individual key words as they're hit.
                var hit = st.anchorHits && st.anchorHits[span.dataset.anchorIdx];
                if (hit) { span.classList.add('matched'); span.classList.remove('missed'); }
            }
        });
    }

    // V2: paint every span of a cleared phrase green (whole-line-green on pass).
    // Shared by _commitNewlySettled (settle-time) and late-evidence reconciliation
    // (a missed line flips green a few seconds late when its batched words arrive).
    _paintPhraseCleared(phraseId) {
        if (!window.KARAOKEE_V2) return;
        var sel = '.word-span[data-phrase-id="' + phraseId + '"]';
        document.querySelectorAll(sel).forEach(function (span) {
            span.classList.remove('matched-partial', 'missed');
            span.classList.add('matched');
        });
    }

    // V2: red the key words of a missed phrase at settle (non-key spans untouched).
    // Extracted verbatim from the old _commitNewlySettled else-branch (1695-1700).
    _paintPhraseMissed(phraseId) {
        if (!window.KARAOKEE_V2) return;
        var _sel = '.word-span[data-phrase-id="' + phraseId + '"]';
        document.querySelectorAll(_sel).forEach(function (span) {
            span.classList.remove('matched', 'matched-partial', 'missed');
            if (span.classList.contains('key-word')) span.classList.add('missed');
        });
    }

    // V2: a PARTIAL phrase (some anchors hit — the lenient streak survives) paints amber,
    // not full red. Hit key words keep their green; un-hit key words go amber (.matched-partial)
    // instead of red, so the line reads as "partial credit" rather than "failure".
    _paintPhrasePartial(phraseId) {
        if (!window.KARAOKEE_V2) return;
        var sel = '.word-span[data-phrase-id="' + phraseId + '"]';
        document.querySelectorAll(sel).forEach(function (span) {
            span.classList.remove('missed');
            if (span.classList.contains('key-word') && !span.classList.contains('matched')) {
                span.classList.add('matched-partial');
            }
        });
    }

    // Render a scored line: mark unmatched spans red (V1 only) and flash the per-line
    // score. Extracted verbatim from the old _scoreLine DOM block (1563-1580); reads the
    // event payload (e.lineIdx / e.missedWordIndices / e.matched / e.scoredTotal) so it
    // never depends on this.activeLineIdx (which the session, not the controller, owns).
    _renderLineScored(e) {
        var lines = lyricsScroll.querySelectorAll('.lyric-line');
        var lineEl = lines[e.lineIdx];
        if (lineEl) {
            if (!window.KARAOKEE_V2) {
                lineEl.querySelectorAll('.word-span').forEach(function (span, wi) {
                    if (e.missedWordIndices.indexOf(wi) >= 0) span.classList.add('missed');
                });
            }
            // Flash per-line score
            var flash = document.createElement('div');
            flash.className = 'line-score-flash';
            flash.textContent = '+' + e.matched + '/' + e.scoredTotal;
            flash.style.top = lineEl.offsetTop + 'px';
            document.getElementById('lyrics-container').appendChild(flash);
            setTimeout(function () { flash.remove(); }, 1300);
        }
    }

    // Reset a new active line's spans to grey. Extracted verbatim from the old
    // setActiveLine span-reset (1229-1235); reads e.lineIdx (session-owned line index).
    _resetLineSpans(lineIdx) {
        var lines = lyricsScroll.querySelectorAll('.lyric-line');
        if (lines[lineIdx]) {
            lines[lineIdx].querySelectorAll('.word-span').forEach(function (s) {
                s.classList.remove('matched', 'matched-partial', 'missed', 'asr-confirmed');
            });
        }
    }

    // Resize the Whisper chunk for the new line's tempo. Extracted verbatim from the
    // old setActiveLine _whisperNode.port.postMessage block (1201-1213). No-op when the
    // realtime-Whisper provider is active (no AudioWorklet node / port).
    _applyChunkTempo(tempoClass) {
        if (this._whisperNode && this._whisperNode.port) {
            this._whisperNode.port.postMessage({ type: 'flush' });
            this._whisperNode.port.postMessage({
                type: 'setChunkSize',
                samples: getChunkSamples(tempoClass)
            });
            this._whisperNode.port.postMessage({
                type: 'enableOverlap',
                enabled: tempoClass === 'fast'
            });
        }
    }

    // Dispatch the render-intent events returned by the scoring session to the existing
    // DOM/telemetry renderers. The session owns the scoring state machine and reads no
    // DOM/clock; the controller renders here. Each case maps 1:1 to the inline DOM the
    // moved methods used to do (see the scoring-session-seam plan, Task 4.1).
    //
    // READ-MODEL SYNC (top of render): the kept renderers/loggers
    // (_updateWordSpans, _logMatch, _logPromotion, _updateRunningScore, telemetry) read
    // controller instance fields the session now owns. Fields the session REASSIGNS
    // (matchedSet = new Map() each line, tallies) must be re-mirrored every render or a
    // one-time alias goes stale. Objects the session only mutates in place
    // (phraseSession/arcadeState/committedPhrases/arcadeEvents) are aliased once in
    // start() instead. Event-painting helpers read the event payload, not this.*, so the
    // mid-setActiveLine frame (where activeLineIdx has already advanced to the new line)
    // misattributes only the cosmetic V1 promotion/wordSpans repaint — never the
    // phraseId-keyed V2 paint or the lineIdx-carrying lineScored/resetSpans.
    _renderEvents(events) {
        if (this._session) {
            var s = this._session;
            this.activeLineIdx  = s.activeLineIdx;
            this.matchedSet     = s.matchedSet;
            this.vadMatchedSet  = s.vadMatchedSet;
            this.asrConfirmedSet = s.asrConfirmedSet;
            this.wordSourceMap  = s.wordSourceMap;
            this.weightedTotal  = s.weightedTotal;
            this.weightedMatched = s.weightedMatched;
            this.lineWords      = s.lineWords;
        }
        if (!events) return;
        for (var i = 0; i < events.length; i++) {
            var e = events[i];
            switch (e.type) {
                case 'lineScored': this._renderLineScored(e); break;
                case 'wordMatched': this._logMatch(e.spokenWord, e.targetWord, e.method, e.editDistance, e.phoneticMatch, e.score, e.matched, e.windowPosition); break;
                case 'promotion': this._logPromotion(e.source, e.wordIndex, e.score); break;
                case 'phraseCleared': this._paintPhraseCleared(e.phraseId); break;
                case 'phraseMissed': this._paintPhraseMissed(e.phraseId); break;
                case 'phrasePartial': this._paintPhrasePartial(e.phraseId); break;
                case 'arcade': this._onArcadeEvent(e.evt); break;
                case 'arcadeRecord': /* already in session.arcadeEvents; telemetry reads it at build time */ break;
                case 'honestPct': { var el = document.getElementById('score-pct'); if (el && e.pct != null) el.textContent = e.pct + '%'; break; }
                case 'runningScore': this._updateRunningScore(); break;
                case 'transition': if (window._kDebug) this._logTransition(e.fromIdx, e.toIdx, e.trigger, e.fromText, e.matchedCount, e.total, e.missedWords, e.lineStartAudioTime, e.sourceCounts); break;
                case 'resetSpans': this._resetLineSpans(e.lineIdx); break;
                case 'wordSpans': this._updateWordSpans(); break;
                case 'chunkTempo': this._applyChunkTempo(e.tempoClass); break;
            }
        }
    }

    /** Read current mic RMS from the AnalyserNode. Returns 0 if not ready. */
    _readVadRms() {
        if (!this._vadAnalyser || !this._vadAnalyserBuf) return 0;
        this._vadAnalyser.getFloatTimeDomainData(this._vadAnalyserBuf);
        var sum = 0;
        for (var i = 0; i < this._vadAnalyserBuf.length; i++) {
            sum += this._vadAnalyserBuf[i] * this._vadAnalyserBuf[i];
        }
        return Math.sqrt(sum / this._vadAnalyserBuf.length);
    }

    /**
     * Update hotWordIndex based on current audio time.
     * Called every 100ms from the updateLyrics poll.
     * The hot word is the word whose predicted time window contains
     * the current audio time — matching this word gets priority.
     */
    // Controller-side VAD: read the real AnalyserNode (the session has no audio),
    // compute isSpeaking, and feed it to the session via setEnergy. The hot-word index,
    // VAD-optimistic provisional scoring, and hot-word match are now done by the session
    // inside tick() (updateHotWordAndMatch); this method only owns the mic energy read.
    updateHotWord() {
        // V2 neural VAD: isSpeaking is maintained by MicVAD callbacks (not RMS). Run the
        // tempo-aware commit cap here (100ms granularity is fine for a 1.5-2.5s cap),
        // then relay isSpeaking to the session. Falls through to the RMS path if neural
        // VAD is not active (init failed) or V1.
        if (window.KARAOKEE_V2 && this._neuralVadActive && this._commitState && window.KaraokeeCommitHelpers) {
            var _tempoClass = (this.wordTimings && this.wordTimings.vadTempoClass) || 'normal';
            var _capRes = KaraokeeCommitHelpers.checkCap(this._commitState, performance.now(), _tempoClass);
            if (_capRes.commit) this._commitRealtimeBuffer();
            if (this._session) KaraokeeScoringSession.setEnergy(this._session, this.isSpeaking);
            return;
        }
        // Refresh isSpeaking from AnalyserNode — real-time, not tied to Whisper chunk rate
        var vadRms = this._readVadRms();
        if (window.KARAOKEE_V2 && this._vadState && typeof updateVad === 'function') {
            // Stage 2: adaptive noise floor + hysteresis + debounce. Continuously
            // recalibrates (frozen while speaking); no frozen _energyThreshold,
            // and single-frame spikes/dips can't flip the gate.
            this.isSpeaking = updateVad(this._vadState, vadRms).isSpeaking;
        } else {
            var _vadMultiplier = (this.wordTimings && this.wordTimings.vadTempoClass === 'slow') ? 1.3 : 1.0;
            this.isSpeaking = vadRms > (this._energyThreshold * _vadMultiplier);

            // Baseline calibration during first 2s of playback
            if (!this._vadBaselineReady) {
                var _ct = this._now();
                if (_ct > 0 && _ct < 2.0) {
                    this._vadBaselineSamples.push(vadRms);
                } else if (_ct >= 2.0) {
                    if (this._vadBaselineSamples.length > 0) {
                        var bSum = this._vadBaselineSamples.reduce(function(a, b) { return a + b; }, 0);
                        this._vadBaseline = bSum / this._vadBaselineSamples.length;
                        this._energyThreshold = Math.min(this._vadBaseline + 0.025, 0.06);
                    }
                    this._vadBaselineReady = true;
                }
            }
        }

        // Feed the energy gate to the session (drives the 06dfde5 in-window VAD flow that
        // gates interim reconciliation, and the provisional VAD match in updateHotWordAndMatch).
        if (this._session) KaraokeeScoringSession.setEnergy(this._session, this.isSpeaking);
    }

    _onArcadeEvent(evt) {
        this._renderArcadeHud(evt);
        if (window._kDebug) console.log('[ARCADE]', evt.outcome, '+' + evt.pointsAwarded,
            'pts=' + evt.points, 'x' + evt.multiplier, evt.onFire ? 'FIRE' : '');
    }

    _renderArcadeHud(evt) {
        var hud = document.getElementById('arcadeHud');
        if (!hud || !this._arcadeState || !window.KaraokeeArcade) return;
        if (!window.KARAOKEE_V2) { hud.style.display = 'none'; return; }
        hud.style.display = 'flex';

        var st = this._arcadeState;
        var ptsEl = document.getElementById('ahPoints');
        if (ptsEl) {
            ptsEl.textContent = String(st.points);
            if (evt && evt.pointsAwarded > 0) {
                ptsEl.classList.add('bump');
                setTimeout(function () { ptsEl.classList.remove('bump'); }, 130);
            }
        }
        var multEl = document.getElementById('ahMult');
        if (multEl) multEl.textContent = st.multiplier + '×';
        var fill = document.getElementById('ahRampFill');
        if (fill) fill.style.width = Math.round(KaraokeeArcade.rampProgress(st) * 100) + '%';

        var streak = document.getElementById('ahStreak');
        var streakVal = document.getElementById('ahStreakVal');
        if (streak && streakVal) {
            streakVal.textContent = String(st.streak);
            streak.style.visibility = st.streak >= 2 ? 'visible' : 'hidden';
        }
        var fire = document.getElementById('ahFire');
        if (fire) fire.style.display = st.onFire ? 'block' : 'none';
        document.body.classList.toggle('arcade-onfire', !!st.onFire);
    }

    _hideArcadeHud() {
        var hud = document.getElementById('arcadeHud');
        if (hud) hud.style.display = 'none';
        document.body.classList.remove('arcade-onfire');
    }

    _updateRunningScore() {
        this._renderV2Panel();
        if (window.KARAOKEE_V2) return;          // honest % headline owned by _tickArcade()
        if (this.weightedTotal === 0) return;
        const pct = Math.round((this.weightedMatched / this.weightedTotal) * 100);
        document.getElementById('score-pct').textContent = pct + '%';
    }

    /**
     * Stage 3 dual-display: render the experimental phrase-engine score (lyrics /
     * timing / stability / composite) beside the headline score, gated by the
     * karaokee_v2 flag (press V). Pure read of the live phrase session; never
     * mutates state and never affects the headline #score-pct.
     */
    _renderV2Panel() {
        var el = document.getElementById('v2-panel');
        if (!el) return;
        if (!window.KARAOKEE_V2 || !this.active || !this._phraseSession || !window.KaraokeePhraseEngine
            || typeof KaraokeePhraseEngine.getLiveScore !== 'function') {
            el.style.display = 'none';
            return;
        }
        try {
            var s = KaraokeePhraseEngine.getLiveScore(this._phraseSession);
            el.style.display = 'inline-block';
            el.textContent = 'V2 ' + Math.round(s.composite * 100) + '%  (lyrics ' + Math.round(s.lyrics * 100)
                + ' · conviction ' + Math.round(s.conviction * 100) + ')';
        } catch (e) {
            el.style.display = 'none';
        }
    }

    // ── Diagnostics ───────────────────────────────────────────────────

    /**
     * Initialise the telemetry log for this session.
     * Called from startGame() when debug mode is active.
     */
    _initTelemetry() {
        var sd = {};
        try { sd = JSON.parse(sessionStorage.getItem('songData') || '{}'); } catch (e) {}
        var title = (sd.artist && sd.title) ? sd.artist + ' — ' + sd.title : (document.title || 'unknown');
        this._telemetry = {
            meta: {
                songTitle:        title,
                songDurationMs:   playback && playback.duration() ? Math.round(playback.duration() * 1000) : null,
                lrcLines:         lyrics.length,
                whisperAvailable: null,   // updated at download time when Whisper state is known
                browserLang:      navigator.language || 'unknown',
                startedAt:        new Date().toISOString(),
                gameVersion:      '1.0'
            },
            asr:         [],
            matches:     [],
            promotions:  [],   // VAD→ASR upgrade events (both browser SR and Whisper paths)
            transitions: [],
            phraseEngine: {
                version: 1,
                mode: 'shadow',
                difficulty: this._phraseDifficulty || 'medium',
                benchmark: null,
                plan: null,
                traces: []
            }
        };
    }

    /**
     * Record a speech recognition result to the telemetry log.
     * @param {'final'|'interim'} type
     * @param {string} text
     * @param {Array} wordTimestamps  - Whisper word-level timestamps or []
     */
    _logAsr(type, text, wordTimestamps, source) {
        if (!this._telemetry) return;
        try {
            var tempoClass = 'medium';
            if (this.activeLineIdx >= 0 && this.allWordTimings[this.activeLineIdx]) {
                tempoClass = this.allWordTimings[this.activeLineIdx].vadTempoClass || 'medium';
            }
            this._telemetry.asr.push({
                ts:             parseFloat((performance.now() / 1000).toFixed(3)),
                lineIdx:        this.activeLineIdx,
                lineTempo:      tempoClass,
                type:           type,                           // still 'final' | 'interim'
                source:         source || 'browser_sr',        // 'browser_sr' | 'whisper'
                text:           text || '',
                wordTimestamps: wordTimestamps || []
            });
        } catch (e) { /* telemetry must never crash the game */ }
    }

    /**
     * Record a VAD→ASR promotion event.
     * Called when a word transitions from provisional VAD credit to ASR-confirmed.
     * Uses wordIndex (not word string) as key to handle repeated words on a line.
     * Not deduped — promotion events are inherently non-redundant (guarded by !asrConfirmedSet.has).
     * @param {'browser_sr'|'whisper'} source
     * @param {number} wordIndex   - index within lineWords
     * @param {number} score       - the ASR match score that triggered promotion
     */
    _logPromotion(source, wordIndex, score) {
        if (!this._telemetry) return;
        try {
            this._telemetry.promotions.push({
                ts:        parseFloat((performance.now() / 1000).toFixed(3)),
                lineIdx:   this.activeLineIdx,
                wordIndex: wordIndex,
                source:    source,
                score:     score,
            });
        } catch (e) { /* telemetry must never crash the game */ }
    }

    /**
     * Record a single word-match attempt to the telemetry log.
     */
    _logMatch(spokenWord, targetWord, method, editDistance, phoneticMatch, score, matched, windowPosition) {
        if (!this._telemetry) return;
        if (!window._kDebug) return;
        if (score <= 0) return;   // suppress noise — log only successful matches

        // Smart filtering: only log first-time matches for words already confirmed matched.
        // Skip redundant re-checks for words already confirmed matched.
        // Exempt vad-confirmed — a promotion is a distinct event from the earlier provisional.
        if (method !== 'vad-confirmed' && matched && this._telemetryLoggedMatches && this._telemetryLoggedMatches.has(this.activeLineIdx + ':' + targetWord)) {
            return;  // Already logged a match for this word on this line
        }

        try {
            var tempoClass = 'medium';
            if (this.activeLineIdx >= 0 && this.allWordTimings[this.activeLineIdx]) {
                tempoClass = this.allWordTimings[this.activeLineIdx].vadTempoClass || 'medium';
            }
            this._telemetry.matches.push({
                ts:            parseFloat((performance.now() / 1000).toFixed(3)),
                lineIdx:       this.activeLineIdx,
                lineTempo:     tempoClass,
                spokenWord:    spokenWord  || '',
                targetWord:    targetWord  || '',
                method:        method,
                editDistance:  editDistance,
                phoneticMatch: phoneticMatch,
                score:         score,
                matched:       matched,
                windowPosition: windowPosition
            });

            // Track logged matches to avoid duplicates
            if (matched) {
                if (!this._telemetryLoggedMatches) this._telemetryLoggedMatches = new Set();
                this._telemetryLoggedMatches.add(this.activeLineIdx + ':' + targetWord);
            }
        } catch (e) { /* telemetry must never crash the game */ }
    }

    _computeLineWeightedTotal(lineIdx) {
        var timings = (lineIdx >= 0 && lineIdx < this.allWordTimings.length)
            ? this.allWordTimings[lineIdx] : [];
        var total = 0;
        for (var i = 0; i < timings.length; i++) {
            total += (timings[i].weight || 1.0);
        }
        return parseFloat(total.toFixed(2));
    }

    _computeLineWeightedMatched(lineIdx) {
        var timings = (lineIdx >= 0 && lineIdx < this.allWordTimings.length)
            ? this.allWordTimings[lineIdx] : [];
        var matched = 0;
        for (var i = 0; i < timings.length; i++) {
            var score = this.matchedSet.get ? this.matchedSet.get(i) : (this.matchedSet.has(i) ? 1.0 : 0);
            if (score > 0) matched += (timings[i].weight || 1.0) * score;
        }
        return parseFloat(matched.toFixed(2));
    }

    /**
     * Record a line advance event to the telemetry log.
     * @param {number} fromIdx
     * @param {number} toIdx
     * @param {string} trigger  'score' | 'time' | 'forced'
     * @param {string} fromText
     * @param {number} matchedWords
     * @param {number} totalWords
     * @param {string[]} missedWords
     * @param {number} lineStartAudioTime  audio.currentTime when this line started
     */
    _logTransition(fromIdx, toIdx, trigger, fromText, matchedWords, totalWords, missedWords, lineStartAudioTime, sourceCounts) {
        if (!this._telemetry) return;
        try {
            var tempoClass = 'medium';
            if (fromIdx >= 0 && this.allWordTimings[fromIdx]) {
                tempoClass = this.allWordTimings[fromIdx].vadTempoClass || 'medium';
            }
            var nowAudio   = this._now();
            var timeSpentMs = lineStartAudioTime != null
                ? Math.round((nowAudio - lineStartAudioTime) * 1000)
                : null;

            // Expected duration = next LRC timestamp minus this line's timestamp
            var expectedMs = null;
            if (fromIdx >= 0 && fromIdx + 1 < lyrics.length) {
                expectedMs = Math.round((lyrics[fromIdx + 1].time - lyrics[fromIdx].time) * 1000);
            }

            var earlyMs = null;
            var lateMs  = null;
            if (timeSpentMs != null && expectedMs != null) {
                var diff = timeSpentMs - expectedMs;
                if (diff < 0) earlyMs = Math.abs(diff);
                else if (diff > 0) lateMs = diff;
            }

            this._telemetry.transitions.push({
                ts:           parseFloat((performance.now() / 1000).toFixed(3)),
                fromIdx:      fromIdx,
                toIdx:        toIdx,
                fromText:     fromText || '',
                trigger:      trigger,
                matchedWords:    matchedWords,
                totalWords:      totalWords,
                weightedMatched: this._computeLineWeightedMatched(fromIdx),
                weightedTotal:   this._computeLineWeightedTotal(fromIdx),
                missedWords:  missedWords || [],
                timeSpentMs:  timeSpentMs,
                lineTempo:    tempoClass,
                expectedTimeMs: expectedMs,
                earlyMs:      earlyMs,
                lateMs:       lateMs,
                totalComparisons: this._lineComparisonCount,
                sourceCounts: sourceCounts || { vad: 0, browser_sr: 0, whisper: 0, unknown: 0 },
            });
        } catch (e) { /* telemetry must never crash the game */ }
    }

    /**
     * Serialise the telemetry log to JSON and trigger a browser download.
     * Falls back to console.warn if the blob URL fails.
     */
    _buildTelemetryPayload(endReason) {
        if (!this._telemetry) return null;
        var meta = this._telemetry.meta;
        if (!meta.songDurationMs && playback && playback.duration()) {
            meta.songDurationMs = Math.round(playback.duration() * 1000);
        }
        if (meta.whisperAvailable === null) meta.whisperAvailable = !!(this._whisperStream);
        meta.whisperStatusAtStart  = this._whisperServerStatus ? Object.assign({}, this._whisperServerStatus) : null;
        meta.whisperStatusFinal    = {
            state: this._whisperServerStatus ? this._whisperServerStatus.state : 'unknown',
            reason: this._whisperServerStatus ? this._whisperServerStatus.reason : null,
            provider: this._whisperServerStatus ? this._whisperServerStatus.provider : null,
            model: this._whisperServerStatus ? this._whisperServerStatus.model : null
        };
        meta.whisperTrackStatus    = this._whisperTrackStatus ? Object.assign({}, this._whisperTrackStatus) : null;
        meta.whisperProvider       = this._whisperServerStatus ? this._whisperServerStatus.provider : null;
        meta.whisperModel          = this._whisperServerStatus ? this._whisperServerStatus.model : null;
        meta.whisperChunkCounters  = {
            dispatched:          this._chunksDispatched          || 0,
            succeeded:           this._chunksSucceeded           || 0,
            failed503:           this._chunksFailed503           || 0,
            failed500:           this._chunksFailed500           || 0,
            failedNetwork:       this._chunksFailedNetwork       || 0,
            droppedWhileLoading: this._chunksDroppedWhileLoading || 0,
            droppedNotReady:     this._chunksDroppedNotReady     || 0,
        };
        meta.whisperResponses          = this._whisperResponses          || 0;
        meta.whisperResponsesWithWords = this._whisperResponsesWithWords  || 0;
        meta.whisperWordsTotal         = this._whisperWordsTotal          || 0;
        meta.whisperRealtimeDeltas     = this._whisperRealtimeDeltas      || 0;
        meta.whisperRealtimeCompletions = this._whisperRealtimeCompletions || 0;
        meta.whisperRealtimeEvents     = this._whisperRealtimeEvents      || 0;
        meta.whisperRealtimeFailures   = this._whisperRealtimeFailures    || 0;
        meta.whisperRealtimeCommitsSent = this._whisperRealtimeCommitsSent || 0;
        meta.whisperRealtimeLastEvent  = this._whisperRealtimeLastEvent   || '';
        meta.whisperRealtimeLastError  = this._whisperRealtimeLastError   || '';
        meta.finalWordSourceCounts     = this._countWordSources(this.wordSourceMap);

        // v2 meta additions
        meta.schemaVersion = 2;
        meta.gameVersion   = '2.0';
        meta.karaokeeV2    = !!window.KARAOKEE_V2;
        meta.neuralVadActive = !!this._neuralVadActive;       // did Silero VAD init this run?
        meta.vadInitError    = this._vadInitError || null;    // why not, if it didn't
        meta.endedAt       = new Date().toISOString();
        meta.endReason     = endReason || 'manual';
        var _cDur = playback ? playback.duration() : 0;
        // On the IFrame path getCurrentTime() may not quite reach duration at the ENDED event,
        // so also honor the onEnded-set flag — a full playthrough is "completed" either way.
        meta.completed     = !!(this._reachedEnd || (_cDur && this._now() >= _cDur - 0.5));

        var intentEl = document.getElementById('benchmarkIntent');
        var fairnessEl = document.getElementById('benchmarkFairness');
        var notesEl = document.getElementById('benchmarkNotes');
        var benchmark = {
            intent: intentEl ? intentEl.value : '',
            fairness: fairnessEl ? fairnessEl.value : '',
            notes: notesEl ? notesEl.value : ''
        };

        var traces = [];
        if (this._phraseSession && window.KaraokeePhraseEngine) {
            traces = KaraokeePhraseEngine.getPhraseTrace(this._phraseSession);
        }

        // Final scores
        // V1 % from the session's authoritative tallies (the controller's weightedTotal/
        // weightedMatched are only a render-time mirror; read getScores directly here).
        var _ss = this._session ? KaraokeeScoringSession.getScores(this._session)
                                : { weightedTotal: this.weightedTotal, weightedMatched: this.weightedMatched };
        var v1Pct = _ss.weightedTotal > 0 ? Math.round((_ss.weightedMatched / _ss.weightedTotal) * 100) : 0;
        var live = (this._phraseSession && window.KaraokeePhraseEngine)
            ? KaraokeePhraseEngine.getLiveScore(this._phraseSession) : { lyrics: 0, composite: 0 };
        var honestLyricPct = Math.round((live.lyrics || 0) * 100);
        var composite = Math.round((live.composite || 0) * 100);
        var grade = window.KaraokeeArcade ? KaraokeeArcade.gradeFor(honestLyricPct, this._phraseDifficulty || 'medium') : null;
        var arcadeSummary = (this._arcadeState && window.KaraokeeArcade)
            ? KaraokeeArcade.getArcadeSummary(this._arcadeState) : null;
        var difficulty = this._phraseDifficulty || 'medium';

        // High score context (read BEFORE showEndModal writes the new best — see finalize ordering)
        var hiKey = 'hiscore_' + _songKey() + '_' + difficulty;
        var prevHi = parseInt(localStorage.getItem(hiKey) || '0', 10) || 0;
        var runPoints = arcadeSummary ? arcadeSummary.points : 0;

        // Arcade records come from the session (this._arcadeEvents is aliased to it in
        // start(), but read the session directly so telemetry is correct even if the alias
        // was reset).
        var arcadeEvents = (this._session && this._session.arcadeEvents) || this._arcadeEvents || [];
        var counts = {
            asr:         this._telemetry.asr.length,
            matches:     this._telemetry.matches.length,
            promotions:  this._telemetry.promotions.length,
            transitions: this._telemetry.transitions.length,
            arcadeEvents: arcadeEvents.length
        };

        var summary = window.KaraokeeTelemetry ? KaraokeeTelemetry.summarizeRun({
            difficulty: difficulty,
            karaokeeV2: !!window.KARAOKEE_V2,
            scores: { v1Pct: v1Pct, honestLyricPct: honestLyricPct, composite: composite },
            arcadeSummary: arcadeSummary,
            grade: grade,
            phraseTraces: traces,
            arcadeEvents: arcadeEvents,
            transitions: this._telemetry.transitions,
            finalWordSourceCounts: meta.finalWordSourceCounts,
            benchmarkIntent: benchmark.intent,
            counts: counts
        }) : null;

        var payload = {
            meta: meta,
            summary: summary,
            arcade: {
                tuning: (window.KaraokeeArcade && KaraokeeArcade.ARCADE_TUNING)
                    ? (KaraokeeArcade.ARCADE_TUNING[difficulty] || null) : null,
                summary: arcadeSummary,
                events: arcadeEvents,
                highScore: { key: hiKey, previous: prevHi, isNewBest: runPoints > prevHi }
            },
            phraseEngine: {
                version: 2,
                mode: window.KARAOKEE_V2 ? 'headline' : 'shadow',
                difficulty: difficulty,
                benchmark: benchmark,
                plan: this._telemetry.phraseEngine ? this._telemetry.phraseEngine.plan : null
            },
            transitions: this._telemetry.transitions
        };

        // Heavy data only under debug (press D).
        if (window._kDebug) {
            payload.phraseEngine.traces = traces;
            payload.asr = this._telemetry.asr;
            payload.matches = this._telemetry.matches;
            payload.promotions = this._telemetry.promotions;
        }
        return payload;
    }

    _downloadTelemetry() {
        var payload = this._buildTelemetryPayload('manual');
        if (!payload) return;
        try {
            var json = JSON.stringify(payload, null, 2);
            var ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            var name = 'karaokee-telemetry-' + ts + '.json';
            var blob = new Blob([json], { type: 'application/json' });
            var url  = URL.createObjectURL(blob);
            var a    = document.createElement('a');
            a.href = url; a.download = name;
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            URL.revokeObjectURL(url);
            console.log('[Telemetry] Downloaded:', name, '| arcadeEvents', payload.arcade.events.length,
                '| transitions', payload.transitions.length);
        } catch (e) {
            console.warn('[Telemetry] Download failed — raw JSON below:', e);
            console.warn(JSON.stringify(payload, null, 2));
        }
    }

    _finalizeTelemetry(endReason) {
        if (this._telemetryFinalized || !this._telemetry) return;
        this._telemetryFinalized = true;
        try {
            var payload = this._buildTelemetryPayload(endReason);
            if (!payload) return;
            // Telemetry is OFF online (ADR-0003); only persist to the dev harness on localhost.
            if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
                fetch('/telemetry', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                }).then(function (r) { return r.json(); })
                  .then(function (d) { console.log('[Telemetry] Saved:', d && d.path); })
                  .catch(function (e) { console.warn('[Telemetry] Save failed:', e); });
            }
        } catch (e) { console.warn('[Telemetry] finalize error:', e); }
    }

    /**
     * Log a debug event to the ring buffer, console, and HUD.
     * Only active when window._kDebug === true (press D to toggle).
     * @param {'LINE'|'RESULT'|'MATCH'} type
     * @param {object} data
     */
    _debugLog(type, data) {
        if (!window._kDebug) return;
        const ts = (performance.now() / 1000).toFixed(2);
        this._dbBuf.unshift({ ts, type, data });
        if (this._dbBuf.length > 20) this._dbBuf.length = 20;

        // Console output
        const lbl = `[GAME ${ts}s] ${type}`;
        if (type === 'LINE') {
            console.group(lbl);
            console.log('FROM line ' + data.fromIdx + ':', data.fromText);
            console.log('score at transition:', data.matched + '/' + data.total,
                        '| missed:', data.missedWords || '(none)');
            console.log('transcript tail:', '"' + data.transcriptTail + '"');
            console.log('interim at transition:', '"' + (data.interim || '') + '"');
            console.log('TO line ' + data.toIdx + ':', data.toText);
            console.groupEnd();
        } else if (type === 'RESULT') {
            const f = data.finalText ? 'FINAL:"' + data.finalText.trim() + '"' : '';
            const i = data.interim   ? 'INTERIM:"' + data.interim.trim() + '"' : '';
            console.log(lbl, '| line:' + data.lineIdx, f, i);
        } else if (type === 'MATCH') {
            console.log(lbl, '| line:' + data.lineIdx,
                        '| spoken:', data.spokenWindow,
                        '| targets:', data.targets,
                        '| matched indices:', data.matchedIdxs);
        }
        this._renderDebugHud();
    }

    /** Re-render the floating debug panel with current GameMode state. */
    _renderDebugHud() {
        const hud = document.getElementById('debug-hud');
        if (!hud || !window._kDebug) return;

        const lineNum  = this.activeLineIdx;
        const lineText = (lineNum >= 0 && lyrics[lineNum]) ? lyrics[lineNum].text : '—';
        const wordSpans = this.lineWords.map((w, i) => {
            const cls = this.matchedSet.has(i) ? 'dbg-matched' : 'dbg-pending';
            return `<span class="${cls}">[${w}]</span>`;
        }).join(' ');

        const finalWords = this.transcriptWords;
        const tail    = finalWords.slice(-10).join(' ') || '—';
        const interim = this.latestInterim.trim() || '—';
        const wBuf    = finalWords.length;
        const wStart  = this.lineStartWordCount;

        let html = '<div class="dbg-header">🎮 GAME DEBUG &mdash; press D to hide</div>';
        html += `<div class="dbg-row"><span class="dbg-label">Line  </span>#${lineNum}: ${lineText}</div>`;
        html += `<div class="dbg-row"><span class="dbg-label">Words </span>${wordSpans || '—'}</div>`;
        html += `<div class="dbg-row"><span class="dbg-label">Final </span><span class="dbg-final">&hellip;${tail}</span></div>`;
        html += `<div class="dbg-row"><span class="dbg-label">Intrm </span><span class="dbg-interim">${interim}</span></div>`;
        html += `<div class="dbg-row"><span class="dbg-label">wBuf  </span>${wBuf} | wStart ${wStart} | fence ${this.lineStartTranscriptPos}</div>`;
        html += `<div class="dbg-row"><span class="dbg-label">Hot   </span>word[${this.hotWordIndex}] ${this.hotWordIndex >= 0 && this.wordTimings[this.hotWordIndex] ? this.wordTimings[this.hotWordIndex].word : '\u2014'} | speaking: ${this.isSpeaking ? 'YES' : 'no'}</div>`;

        // Tempo classification
        const tc = (this.wordTimings && this.wordTimings.tempoClass) || '\u2014';
        const wpsVal = (this.wordTimings && this.wordTimings.wps) ? this.wordTimings.wps.toFixed(1) : '\u2014';
        html += `<div class="dbg-row"><span class="dbg-label">Tempo </span>${tc} (${wpsVal} wps)</div>`;

        // Song tempo profile and VAD state
        const p50 = this.songTempoProfile ? this.songTempoProfile.p50.toFixed(2) : '—';
        const p80 = this.songTempoProfile ? this.songTempoProfile.p80.toFixed(2) : '—';
        const vadMode = (this.wordTimings && this.wordTimings.useVad) ? `VAD:ON (${this.wordTimings.vadTempoClass})` : 'VAD:off';
        const vadThresh = this._vadBaselineReady ? `thr:${this._energyThreshold.toFixed(4)}` : 'calibrating…';
        html += `<div class="dbg-row"><span class="dbg-label">Song  </span>p50:${p50} | p80:${p80} | ${vadMode} | ${vadThresh}</div>`;

        // VAD hit and ASR confirmation count
        const vadHits = this.vadMatchedSet ? this.vadMatchedSet.size : 0;
        const confirmed = this.asrConfirmedSet ? this.asrConfirmedSet.size : 0;
        html += `<div class="dbg-row"><span class="dbg-label">VAD   </span>hits:${vadHits} | asr-conf:${confirmed}/${this.lineWords.length}</div>`;
        const sourceCounts = this._countWordSources(this.wordSourceMap);
        html += `<div class="dbg-row"><span class="dbg-label">Src   </span>vad:${sourceCounts.vad} browser:${sourceCounts.browser_sr} whisper:${sourceCounts.whisper} unknown:${sourceCounts.unknown}</div>`;
        // Whisper server + track state
        const wSrv   = (this._whisperServerStatus && this._whisperServerStatus.state) || 'unknown';
        const wTrk   = (this._whisperTrackStatus  && this._whisperTrackStatus.state)  || 'idle';
        const wDisp  = this._chunksDispatched          || 0;
        const wOk    = this._chunksSucceeded           || 0;
        const w503   = this._chunksFailed503           || 0;
        const w500   = this._chunksFailed500           || 0;
        const wNet   = this._chunksFailedNetwork       || 0;
        const wDrop  = this._chunksDroppedWhileLoading || 0;
        const wNotReady = this._chunksDroppedNotReady  || 0;
        const wReason = (this._whisperTrackStatus && this._whisperTrackStatus.reason) ? ` | reason:${this._whisperTrackStatus.reason}` : '';
        html += `<div class="dbg-row"><span class="dbg-label">Whisp </span>srv:${wSrv} trk:${wTrk} | sent:${wDisp} ok:${wOk} 503:${w503} 500:${w500} net:${wNet} drop:${wDrop} not-ready:${wNotReady}${wReason}</div>`;
        const dcState = this._whisperRealtimeDc ? this._whisperRealtimeDc.readyState : 'none';
        const pcState = this._whisperRealtimePc ? this._whisperRealtimePc.connectionState : 'none';
        html += `<div class="dbg-row"><span class="dbg-label">RT-W  </span>pc:${pcState} dc:${dcState} events:${this._whisperRealtimeEvents || 0} deltas:${this._whisperRealtimeDeltas || 0} complete:${this._whisperRealtimeCompletions || 0} commit:${this._whisperRealtimeCommitsSent || 0} fail:${this._whisperRealtimeFailures || 0}</div>`;
        html += `<div class="dbg-row"><span class="dbg-label">RT-E  </span>last:${this._whisperRealtimeLastEvent || '\u2014'} err:${this._whisperRealtimeLastError || '\u2014'}</div>`;
        html += `<div class="dbg-row"><span class="dbg-label">RT-T  </span>last:"${(this._lastWhisperTranscriptText || '\u2014').slice(-80)}"</div>`;

        // Overlap state
        const overlapActive = this.prevLine && performance.now() < this.prevLine.overlapEnd;
        const overlapInfo = overlapActive
            ? `OVERLAP line ${this.prevLine.lineIdx} (${((this.prevLine.overlapEnd - performance.now()) / 1000).toFixed(1)}s left, ${this.prevLine.matchedSet.size}/${this.prevLine.lineWords.length} matched)`
            : 'none';
        html += `<div class="dbg-row"><span class="dbg-label">Ovrlp </span>${overlapInfo}</div>`;

        html += '<div class="dbg-sep"></div>';

        for (const e of this._dbBuf) {
            let msg = '', cls = '';
            if (e.type === 'LINE') {
                msg = `[${e.ts}s] L${e.data.fromIdx}&rarr;L${e.data.toIdx} ${e.data.matched}/${e.data.total} missed:[${e.data.missedWords || '&mdash;'}] interim:"${(e.data.interim || '').trim()}"`;
                cls = 'dbg-ev-line';
            } else if (e.type === 'RESULT') {
                const f = e.data.finalText ? '[F:' + e.data.finalText.trim().split(/\s+/).slice(-5).join(' ') + ']' : '';
                const i = e.data.interim   ? '&lang;' + e.data.interim.trim().split(/\s+/).slice(-5).join(' ') + '&rang;' : '';
                msg = `[${e.ts}s] L${e.data.lineIdx} ${f} ${i}`;
                cls = 'dbg-ev-res';
            } else if (e.type === 'MATCH') {
                msg = `[${e.ts}s] L${e.data.lineIdx} matched:[${e.data.matchedIdxs.join(',')}]/${e.data.targets.length} spoken:${e.data.spokenWindow.slice(-8).join(' ')}`;
                cls = 'dbg-ev-match';
            }
            html += `<div class="dbg-row ${cls}">${msg}</div>`;
        }
        const dlBtn = `<div style="margin-top:6px"><button onclick="gameMode._downloadTelemetry()" style="font-size:11px;padding:2px 6px;cursor:pointer">📥 Download Telemetry</button></div>`;
        hud.innerHTML = html + dlBtn;
    }

    showEndModal() {
        if (this._endShown) return;   // idempotent: onEnded AND the poll-based fallback may both call this
        this._endShown = true;
        var self = this;
        var legacy = document.getElementById('legacyEnd');
        var hero = document.getElementById('gradeHero');
        var feedback = document.getElementById('benchmarkFeedback');
        document.getElementById('lrc-offset-control').style.display = 'none';

        // Flush the session at song end, then persist telemetry BEFORE the hi-score write
        // below (so arcade.highScore.previous reflects the prior best). Pass duration+5
        // (NOT _now()) so phrases whose windows only close after the audio ends still
        // settle, matching the old settlePhrases(_endNow). The 100ms poll's tick() is
        // frozen at currentTime≈duration, so it never reaches _endNow — we must run a
        // final tick(_endNow) HERE to (a) finalize any trailing prevLine overlay
        // (overlapEnd ∈ (duration, duration+5]) and (b) reconcile the converged interim
        // for the continuously-sung last line (the 06dfde5/5028f1f catch-up). endRun then
        // scores the active line; its commit-once guard prevents double-commit.
        if (this._session) {
            var _endNow = (playback && playback.duration()) ? playback.duration() + 5 : 1e9;
            this._renderEvents(KaraokeeScoringSession.tick(this._session, _endNow));
            this._renderEvents(KaraokeeScoringSession.endRun(this._session, _endNow));
        }
        // Hide the arcade HUD AFTER the flush: tick()'s commit routes arcade events
        // (routeEvents=true) which would otherwise re-show the HUD over the end screen.
        this._hideArcadeHud();
        this._finalizeTelemetry('song_ended');

        var useArcade = window.KARAOKEE_V2 && this._arcadeState && window.KaraokeeArcade
            && window.KaraokeePhraseEngine && this._phraseSession;

        if (useArcade) {
            var summary = KaraokeeArcade.getArcadeSummary(this._arcadeState);
            var live = KaraokeePhraseEngine.getLiveScore(this._phraseSession);
            var pct = Math.round((live.lyrics || 0) * 100);
            var grade = KaraokeeArcade.gradeFor(pct, this._phraseDifficulty || 'medium');
            var diff = (this._phraseDifficulty || 'medium');

            var key = 'hiscore_' + _songKey() + '_' + diff;
            var prev = parseInt(localStorage.getItem(key) || '0', 10) || 0;
            var isBest = summary.points > prev;
            if (isBest) localStorage.setItem(key, String(summary.points));

            document.getElementById('gradeLetter').textContent = grade;
            document.getElementById('gradePoints').textContent = String(summary.points);
            document.getElementById('gradeAcc').textContent = pct + '%';
            document.getElementById('gradeCombo').textContent = summary.maxMultiplier + '×';
            document.getElementById('gradeStreak').textContent = String(summary.longestStreak);
            document.getElementById('gradePerfects').textContent = String(summary.perfects);
            document.getElementById('gradeDiff').textContent = diff.toUpperCase();
            document.getElementById('gradeHiscore').textContent = String(Math.max(prev, summary.points));
            document.getElementById('nbRibbon').style.display = isBest ? 'block' : 'none';

            // Share-image: wire the end-screen button to render THIS run's card.
            var _shareBtn = document.getElementById('shareImgBtn');
            if (_shareBtn) {
                var _shareSummary = { grade: grade, points: summary.points, percent: pct, difficulty: diff };
                _shareBtn.style.display = 'inline-block';
                _shareBtn.onclick = function () { self._downloadShareImage(_shareSummary); };
            }

            if (hero) hero.style.display = 'block';
            if (legacy) legacy.style.display = 'none';
        } else {
            // Always show the end screen on song-end (was: early-return when nothing scored,
            // which hid the modal on skipped/instrumental runs). Guard the division for the
            // zero-scored case so it reads 0% instead of NaN%.
            var _wt = this.weightedTotal || 0;
            var lpct = _wt > 0 ? Math.round((this.weightedMatched / _wt) * 100) : 0;
            document.getElementById('modalScore').textContent = lpct + '%';
            document.getElementById('modalWords').textContent = (this.matchedWords || 0) + '/' + (this.totalWords || 0);
            document.getElementById('modalLines').textContent = (this.perfectLines || 0) + '/' + (this.linesScored || 0);
            document.getElementById('modalStreak').textContent = (this.bestStreak || 0);
            var _shareBtnLegacy = document.getElementById('shareImgBtn');
            if (_shareBtnLegacy) _shareBtnLegacy.style.display = 'none';  // share-image is arcade-only
            if (hero) hero.style.display = 'none';
            if (legacy) legacy.style.display = 'block';
        }

        if (feedback) feedback.style.display = window._kDebug ? 'block' : 'none';
        document.getElementById('gameModal').style.display = 'flex';
    }

    // Render the final grade/score/song to a 1080x1080 PNG and download it. The
    // pure line-building (truncation, DIFF · pts · % stat) is in share-card.js
    // (buildShareCardLines); this method only draws + triggers the download.
    _downloadShareImage(summary) {
        if (typeof buildShareCardLines !== 'function' || typeof document === 'undefined') return;
        var sd = (typeof songData !== 'undefined' && songData) ? songData : {};
        var L = buildShareCardLines(summary, sd);
        var c = document.createElement('canvas');
        c.width = 1080; c.height = 1080;
        var x = c.getContext('2d');
        if (!x) return;
        x.fillStyle = '#0b0b12'; x.fillRect(0, 0, 1080, 1080);
        x.textAlign = 'center';
        x.fillStyle = '#8b5cf6'; x.font = 'bold 64px sans-serif';  x.fillText(L.brand, 540, 170);
        x.fillStyle = '#ffffff'; x.font = 'bold 320px sans-serif'; x.fillText(L.grade, 540, 620);
        x.fillStyle = '#e5e7eb'; x.font = '52px sans-serif';       x.fillText(L.stat, 540, 770);
        x.fillStyle = '#9ca3af'; x.font = '40px sans-serif';       x.fillText(L.song, 540, 860);
        var a = document.createElement('a');
        a.href = c.toDataURL('image/png');
        a.download = 'karaokee-score.png';
        document.body.appendChild(a); a.click(); a.remove();
    }
}

const gameMode = new GameMode();

// Load song data from session storage
let songData = null;
try {
    songData = JSON.parse(sessionStorage.getItem('songData') || 'null');
} catch (e) {
    songData = null;
}
if (!songData) {
    window.location.href = '/';
}

// Playback source. YouTube songs (songData.videoId) play client-side via the IFrame
// player; uploaded local files (no videoId, dev) keep the <audio> element. Both implement
// the same playback-source contract, so the scoring/UI code is source-agnostic.
var playback = null;          // null until the source exists (IFrame is async); callers null-guard.
var _playbackReady = false;   // true once the source fires onReady (gates gesture-initiated play)
if (songData.videoId) {
    ensureYouTubeApi().then(function (YT) {
        playback = YouTubeIframeSource(songData.videoId, 'ytplayer', { YT: YT });
        _wirePlaybackCallbacks();
    });
} else {
    audio.src = '/audio?t=' + Date.now();   // cache-bust so the browser re-fetches each load
    audio.load();
    playback = AudioElementSource(audio);
    _wirePlaybackCallbacks();
}

document.getElementById('song-title').textContent =
    `${songData.artist} — ${songData.title}`;

lyrics = songData.lyrics || [];

if (lyrics.length === 0) {
    noLyricsEl.style.display = 'block';
} else {
    renderLyrics();
}

function renderLyrics() {
    lyricsScroll.innerHTML = '';
    lyrics.forEach((line, i) => {
        const el = document.createElement('div');
        el.className = 'lyric-line';
        el.textContent = line.text;
        el.dataset.index = i;
        lyricsScroll.appendChild(el);
    });
}

function renderLyricsGameMode() {
    lyricsScroll.innerHTML = '';
    lyrics.forEach((line, i) => {
        const el = document.createElement('div');
        el.className = 'lyric-line';
        el.dataset.index = i;

        const words = line.text.split(' ').filter(function(w) { return normalizeWord(w).length > 0; });
        words.forEach((word, wi) => {
            const span = document.createElement('span');
            span.className = 'word-span';
            span.dataset.wordIndex = wi;
            span.textContent = word;
            el.appendChild(span);
            if (wi < words.length - 1) el.appendChild(document.createTextNode(' '));
        });

        lyricsScroll.appendChild(el);
    });
    _tagAnchorSpans();
}

// Tag the spans that are phrase-engine anchors (the scored "key words") with their
// phrase + anchor identity, so V2 coloring can mirror the engine. Harmless under V1.
function _tagAnchorSpans() {
    if (!window.KaraokeeLyricPaint || !gameMode || !gameMode._phrasePlan) return;
    var map = KaraokeeLyricPaint.buildLinePhraseMap(gameMode._phrasePlan);
    var lines = lyricsScroll.querySelectorAll('.lyric-line');
    Object.keys(map).forEach(function (li) {
        var lineEl = lines[li];
        if (!lineEl) return;
        var spans = lineEl.querySelectorAll('.word-span');
        map[li].forEach(function (ph) {
            // Tag every word with its phrase so a pass can green the whole line.
            for (var i = 0; i < ph.wordCount; i++) {
                var w = spans[ph.startIndex + i];
                if (w) w.dataset.phraseId = ph.phraseId;
            }
            // Flag the anchor ("key") words as the target to aim for.
            ph.anchors.forEach(function (a) {
                var span = spans[a.wordIndex];
                if (span) { span.classList.add('key-word'); span.dataset.anchorIdx = a.anchorIdx; }
            });
        });
    });
}

function updateLyrics() {
    if (lyrics.length === 0) return;

    const t = (playback ? playback.currentTime() : 0) - (gameMode ? gameMode.lrcOffset : 0);
    let idx = -1;
    for (let i = 0; i < lyrics.length; i++) {
        if (lyrics[i].time <= t) idx = i;
        else break;
    }

    // Update hot word tracking every poll even if line hasn't changed
    // 100ms drive: updateHotWord() reads mic energy and feeds setEnergy; tick() advances
    // the session (hot-word match, VAD provisional, settle -> reconcile -> commit ->
    // honest %) and returns render-intent events. Same order as the old
    // updateHotWord(); _tickArcade(); pair.
    if (gameMode.active) {
        gameMode.updateHotWord();
        if (gameMode._session) gameMode._renderEvents(KaraokeeScoringSession.tick(gameMode._session, gameMode._now()));
        // Robust end-of-song completion. The YouTube IFrame is unreliable here: its ENDED
        // event may not reach us, and getCurrentTime() can plateau ~1s+ short of getDuration()
        // (the "replay arrow shows but the timer is frozen at 2:46/2:47" case). So instead of a
        // fixed time threshold, detect that the clock has STALLED near the end. Fires once.
        if (!gameMode._reachedEnd && playback) {
            var _dur = playback.duration();
            var _ct = playback.currentTime();
            if (_dur && _ct >= _dur - 2.0) {
                if (gameMode._lastEndCheckT != null && Math.abs(_ct - gameMode._lastEndCheckT) < 0.05) {
                    gameMode._endStallTicks = (gameMode._endStallTicks || 0) + 1;
                } else {
                    gameMode._endStallTicks = 0;
                }
                gameMode._lastEndCheckT = _ct;
                // clean end (reached duration) OR ~0.8s of a frozen clock near the end
                if (_ct >= _dur - 0.4 || gameMode._endStallTicks >= 8) {
                    gameMode._reachedEnd = true;
                    setTimeout(function () { gameMode.showEndModal(); }, 1500);
                }
            }
        }
    }

    if (idx === currentLineIndex) return;
    currentLineIndex = idx;

    // Notify game mode of line change
    if (gameMode.active) {
        gameMode.setActiveLine(idx);
    }

    const container = document.getElementById('lyrics-container');
    const lines = lyricsScroll.querySelectorAll('.lyric-line');
    lines.forEach((el, i) => {
        el.classList.remove('active', 'upcoming');
        if (i === idx) el.classList.add('active');
        else if (i > idx && i <= idx + 2) el.classList.add('upcoming');
    });

    // Scroll active line to vertical center of container
    if (idx >= 0) {
        const activeLine = lines[idx];
        const containerHeight = container.offsetHeight;
        const lineTop = activeLine.offsetTop;
        const lineHeight = activeLine.offsetHeight;
        container.scrollTop = lineTop - containerHeight / 2 + lineHeight / 2;
    }
}

// Poll every 100ms for lyric sync
setInterval(updateLyrics, 100);

// Play/pause
function togglePlay() {
    if (!playback) return;
    if (playback.isPaused()) {
        playback.play();
        playBtn.textContent = '⏸';
        if (gameMode.active) gameMode.resume();
    } else {
        playback.pause();
        playBtn.textContent = '▶';
        if (gameMode.active) gameMode.suspend();
    }
}

// Skip ±10s
function skipBack() {
    if (!playback) return;
    playback.seek(Math.max(0, playback.currentTime() - 10));
    if (gameMode.active) gameMode.onSeek();
}
function skipFwd() {
    if (!playback) return;
    playback.seek(Math.min(playback.duration() || 0, playback.currentTime() + 10));
    if (gameMode.active) gameMode.onSeek();
}

// Seek bar / time display — polled (works for both <audio> and the IFrame, which has no 'timeupdate').
setInterval(function () {
    if (!playback) return;            // null on the IFrame path until ensureYouTubeApi() resolves (Task 5)
    var dur = playback.duration();
    if (!dur) return;
    var t = playback.currentTime();
    seekBar.value = (t / dur) * 100;
    timeDisplay.textContent = `${fmt(t)} / ${fmt(dur)}`;
}, 100);

seekBar.addEventListener('input', () => {
    if (!playback) return;
    var dur = playback.duration();
    if (dur) {
        playback.seek((seekBar.value / 100) * dur);
        if (gameMode.active) gameMode.onSeek();
    }
});

// Volume
volumeBar.addEventListener('input', () => { if (playback) playback.setVolume(parseFloat(volumeBar.value)); });

// LRC offset buttons
function _updateOffsetDisplay() {
    document.getElementById('offsetDisplay').textContent =
        (gameMode ? gameMode.lrcOffset : 0).toFixed(1) + 's';
}

document.getElementById('offsetMinus').addEventListener('click', function() {
    if (!gameMode) return;
    gameMode.lrcOffset = Math.max(-10, gameMode.lrcOffset - 0.5);
    if (gameMode._session) gameMode._session.lrcOffset = gameMode.lrcOffset;
    localStorage.setItem('lrcOffset_' + _songKey(), gameMode.lrcOffset);
    _updateOffsetDisplay();
});

document.getElementById('offsetPlus').addEventListener('click', function() {
    if (!gameMode) return;
    gameMode.lrcOffset = Math.min(10, gameMode.lrcOffset + 0.5);
    if (gameMode._session) gameMode._session.lrcOffset = gameMode.lrcOffset;
    localStorage.setItem('lrcOffset_' + _songKey(), gameMode.lrcOffset);
    _updateOffsetDisplay();
});

// Experimental Scoring V2 (adaptive VAD + phrase-engine dual-display panel).
// Off by default; the current scorer stays the headline. Press V to A/B it.
window.KARAOKEE_V2 = (localStorage.getItem('karaokee_v2') !== '0'); // arcade is the default; press V to opt out

// Debug HUD — press D to toggle (works any time, not just in Game Mode)
document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'd' || e.key === 'D') {
        window._kDebug = !window._kDebug;
        const hud = document.getElementById('debug-hud');
        if (hud) hud.style.display = window._kDebug ? 'block' : 'none';
        if (window._kDebug) gameMode._renderDebugHud();
        console.log('[DEBUG HUD]', window._kDebug ? 'ON — start Game Mode and rap to see events' : 'OFF');
    } else if (e.key === 'v' || e.key === 'V') {
        window.KARAOKEE_V2 = !window.KARAOKEE_V2;
        localStorage.setItem('karaokee_v2', window.KARAOKEE_V2 ? '1' : '0');
        if (gameMode) gameMode._renderV2Panel();
        console.log('[SCORING V2]', window.KARAOKEE_V2 ? 'ON — adaptive VAD + phrase-engine panel' : 'OFF');
    }
});

// (Difficulty selection moved to the load-time difficulty gate — see initDifficultyGate below.)

// Format seconds as m:ss
function fmt(s) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
}

// Suppress autoplay while loading overlay is active
let overlayDismissed = false;
let prepTimer = null;

// Wire the source's lifecycle callbacks once the source exists (called from both load
// paths). gameMode.suspend()/resume() are guarded no-ops (idempotent + side-effect-light),
// so gating scoring on buffering/ad transitions via onState is safe (no flicker/thrash).
function _wirePlaybackCallbacks() {
    _playbackReady = false;
    playback.onReady(function () {
        _playbackReady = true;
        var ps = document.getElementById('prepStatus');
        if (ps) ps.textContent = 'Ready — pick a difficulty';
        if (overlayDismissed) {
            Promise.resolve(playback.play()).then(function () { playBtn.textContent = '⏸'; }).catch(function () {});
        }
    });
    playback.onEnded(function () {
        gameMode._reachedEnd = true;   // playback reached the end (IFrame ENDED / <audio> 'ended') -> completed
        // showEndModal -> endRun does the final collect + score + settle/commit; the 1500ms
        // delay lets late-arriving SR/whisper finals land first (each queues a dirty collect).
        if (gameMode.active) setTimeout(function () { gameMode.showEndModal(); }, 1500);
    });
    playback.onState(function (state) {
        // Freeze scoring whenever the song clock is frozen (buffering/ad/unstarted/paused) —
        // the mic keeps advancing, so crediting then would mis-score. suspend()/resume() are
        // guarded no-ops, so flapping states don't thrash recognition/UI.
        var dec = playbackGateDecision(state, { embedDisabled: false });
        if (gameMode && gameMode.active) {
            if (dec.scoringActive) gameMode.resume(); else gameMode.suspend();
        }
    });
    if (playback.onEmbedError) {
        playback.onEmbedError(function (code) {
            if (isEmbedDisabledError(code)) _showEmbedFallback();
        });
    }
}

// ADR-0002 graceful degradation: a video the owner blocks from embedding (error 101/150)
// shows a friendly "pick another version" message instead of a broken page.
function _showEmbedFallback() {
    var ps = document.getElementById('prepStatus');
    if (ps) ps.textContent = "This video can't be embedded — go back and try another version (a Topic-style upload usually works).";
    var gate = document.getElementById('diffGateCards');
    if (gate) gate.style.display = 'none';
}

// --- Difficulty gate / loading overlay ---

function _paintDiffPill(d) {
    var pill = document.getElementById('diff-pill');
    if (pill) pill.textContent = (d || 'medium').toUpperCase();
}

function _markSelectedCard(d) {
    var cards = document.querySelectorAll('#diffGateCards .diff-card');
    for (var i = 0; i < cards.length; i++) {
        cards[i].classList.toggle('selected', cards[i].getAttribute('data-diff') === d);
    }
}

// Show, per difficulty, a sample song line with its required "notes" (anchor words)
// highlighted — the top `anchorsRequired` anchors by weight are bright targets, other
// anchors dim, the rest faint. Illustrates the count; the engine accepts ANY of them.
function renderDifficultyPreview(d) {
    var box = document.getElementById('diffPreview');
    var lineEl = document.getElementById('dpLine');
    var capEl = document.getElementById('dpCaption');
    if (!box || !lineEl || !capEl) return;
    if (!lyrics || lyrics.length === 0 || !window.KaraokeePhraseEngine) { box.style.display = 'none'; return; }

    var plan;
    try {
        plan = KaraokeePhraseEngine.buildPhrasePlan(lyrics, {
            difficulty: d,
            audioDuration: playback ? (playback.duration() || null) : null
        });
    } catch (e) { box.style.display = 'none'; return; }

    var phrases = (plan && plan.phrases) || [];
    if (!phrases.length) { box.style.display = 'none'; return; }
    // Representative phrase: first with >=4 words and >=2 anchors, else the longest.
    var phrase = null;
    for (var i = 0; i < phrases.length; i++) {
        if (phrases[i].words.length >= 4 && phrases[i].anchors.length >= 2) { phrase = phrases[i]; break; }
    }
    if (!phrase) {
        phrase = phrases[0];
        for (var j = 1; j < phrases.length; j++) {
            if (phrases[j].words.length > phrase.words.length) phrase = phrases[j];
        }
    }

    var anchorIdx = {};
    phrase.anchors.forEach(function (a) { anchorIdx[a.wordIdx] = true; });
    var byWeight = phrase.anchors.slice().sort(function (a, b) { return b.weight - a.weight; });
    var targetIdx = {};
    for (var t = 0; t < phrase.anchorsRequired && t < byWeight.length; t++) targetIdx[byWeight[t].wordIdx] = true;

    lineEl.innerHTML = '';
    phrase.words.forEach(function (w, wi) {
        var span = document.createElement('span');
        span.className = 'dp-word' + (targetIdx[wi] ? ' dp-target' : (anchorIdx[wi] ? ' dp-anchor' : ''));
        span.textContent = w + ' ';
        lineEl.appendChild(span);
    });

    var tolSec = ((plan.difficulty && plan.difficulty.timingToleranceMs) || 1000) / 1000;
    capEl.textContent = d.toUpperCase() + ' — hit any ' + phrase.anchorsRequired + ' of '
        + phrase.anchors.length + ' key words per line · ' + tolSec + 's timing window';
    box.style.display = 'block';
}

// Show the gate (used on load, Play Again, and the Game button from passive mode).
function openDifficultyGate() {
    var overlay = document.getElementById('prepOverlay');
    if (!overlay) return;
    var sd = JSON.parse(sessionStorage.getItem('songData') || 'null');
    if (sd) document.getElementById('prepSongTitle').textContent = sd.artist + ' \u2014 ' + sd.title;
    _markSelectedCard(localStorage.getItem('arcadeDifficulty') || 'medium');
    try { if (playback) playback.pause(); playBtn.textContent = '\u25B6'; } catch (e) {}
    renderDifficultyPreview(localStorage.getItem('arcadeDifficulty') || 'medium');
    overlayDismissed = false;
    overlay.style.display = 'flex';
}

// Begin a scored run on the chosen difficulty.
function startRunWithDifficulty(d) {
    if (!playback || !_playbackReady) return;   // wait for onReady so the click is the play() gesture
    localStorage.setItem('arcadeDifficulty', d);
    if (gameMode) gameMode._phraseDifficulty = d;
    _paintDiffPill(d);
    overlayDismissed = true;
    document.getElementById('prepOverlay').style.display = 'none';
    if (gameMode.active) gameMode.stop();
    playback.seek(0);
    Promise.resolve(playback.play()).then(function () { playBtn.textContent = '\u23F8'; }).catch(function () {});
    gameMode.start();
}

// Escape hatch \u2014 passive karaoke, no scoring.
function justListen() {
    if (!playback || !_playbackReady) return;   // wait for onReady (gesture-initiated play)
    clearInterval(prepTimer);
    overlayDismissed = true;
    document.getElementById('prepOverlay').style.display = 'none';
    Promise.resolve(playback.play()).then(function () { playBtn.textContent = '\u23F8'; }).catch(function () {});
}

// Back-compat shim (existing callers): behaves like "just listen".
function skipPrep() { justListen(); }

// Wire the gate cards once.
(function initDifficultyGate() {
    var cards = document.getElementById('diffGateCards');
    if (!cards) return;
    cards.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('button[data-diff]') : null;
        if (!btn) return;
        startRunWithDifficulty(btn.getAttribute('data-diff'));
    });
    function previewFrom(e) {
        var btn = e.target.closest ? e.target.closest('button[data-diff]') : null;
        if (btn) renderDifficultyPreview(btn.getAttribute('data-diff'));
    }
    cards.addEventListener('mouseover', previewFrom);
    cards.addEventListener('focusin', previewFrom);
    cards.addEventListener('mouseleave', function () {
        renderDifficultyPreview(localStorage.getItem('arcadeDifficulty') || 'medium');
    });
})();

function initPrepOverlay() {
    var sd = JSON.parse(sessionStorage.getItem('songData') || 'null');
    if (sd) document.getElementById('prepSongTitle').textContent = sd.artist + ' \u2014 ' + sd.title;
    if (lyrics.length === 0) { justListen(); return; }   // no lyrics -> can't score; just play
    _markSelectedCard(localStorage.getItem('arcadeDifficulty') || 'medium');
    _paintDiffPill(localStorage.getItem('arcadeDifficulty') || 'medium');
    renderDifficultyPreview(localStorage.getItem('arcadeDifficulty') || 'medium');
    // Overlay stays open showing the gate; user picks a difficulty or "Just listen".
}

initPrepOverlay();

function toggleGameMode() {
    if (lyrics.length === 0) {
        alert('No lyrics available for this song \u2014 game mode requires synced lyrics.');
        return;
    }
    if (gameMode.active) {
        gameMode.stop();
    } else {
        openDifficultyGate();   // pick difficulty, then the run starts from the top
    }
}

function replayGame() {
    document.getElementById('gameModal').style.display = 'none';
    if (gameMode.active) gameMode.stop();
    openDifficultyGate();
}
