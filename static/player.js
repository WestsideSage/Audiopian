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

// --- Game mode utilities ---

// --- Phonetic + fuzzy matching ---

/**
 * Levenshtein edit distance (two-row DP). Returns integer >= 0.
 */
function editDistance(a, b) {
    const m = a.length, n = b.length;
    let prev = Array.from({length: n + 1}, (_, i) => i);
    let curr = new Array(n + 1);
    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        for (let j = 1; j <= n; j++) {
            curr[j] = a[i - 1] === b[j - 1]
                ? prev[j - 1]
                : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
        }
        [prev, curr] = [curr, prev];
    }
    return prev[n];
}

/**
 * Double Metaphone — returns [primary, secondary] phonetic codes (max 4 chars each).
 * Based on the Philips (2000) algorithm. Maps words to sound-alike codes so that
 * "night" and "knight" both produce ["NT","NT"], etc.
 */
function doubleMetaphone(word) {
    if (!word || typeof word !== 'string') return ['', ''];
    word = word.toUpperCase().replace(/[^A-Z]/g, '');
    if (!word) return ['', ''];

    const len = word.length;
    let p = '', s = '';
    let i = 0;

    function add(a, b) { p += a || ''; s += (b !== undefined ? b : a) || ''; }
    function at(pos) { return (pos >= 0 && pos < len) ? word[pos] : ''; }
    function sub(pos, n) { return word.substring(pos, pos + n); }
    function isV(c) { return 'AEIOU'.indexOf(c) >= 0; }
    function slavo() { return word.indexOf('W') > -1 || word.indexOf('K') > -1 || sub(0,2) === 'CZ'; }

    // Initial fixups
    if (/^(GN|KN|PN|AE|WR)/.test(sub(0, 2))) i = 1;
    if (at(0) === 'X') { add('S'); i = 1; }

    while (i < len) {
        const c = at(i);
        switch (c) {
            case 'A': case 'E': case 'I': case 'O': case 'U': case 'Y':
                if (i === 0) add('A');
                i++; break;
            case 'B':
                add('P'); i += (at(i+1) === 'B') ? 2 : 1; break;
            case 'C':
                if (sub(i,2) === 'CIA') { add('X'); i += 3; break; }
                if (sub(i,2) === 'CH') {
                    if (i > 0 && sub(i-2,6).match(/ORCHES|ARCHIT|ORCHID/)) { add('K'); }
                    else if (at(i+2).match(/[IEY]/)) { add('S'); }
                    else if (slavo() || sub(0,4).match(/VAN |VON |SCH/)) { add('K'); }
                    else { add('X', 'K'); }
                    i += 2; break;
                }
                if (sub(i,2).match(/CE|CI/)) { add('S'); i += 2; break; }
                if (sub(i,2) === 'CK') { add('K'); i += 2; break; }
                add('K');
                i += (at(i+1) === 'C') ? 2 : 1; break;
            case 'D':
                if (sub(i,2) === 'DG' && at(i+2).match(/[IEY]/)) { add('J'); i += 3; break; }
                add('T'); i += (sub(i,2).match(/DT|DD/)) ? 2 : 1; break;
            case 'F':
                add('F'); i += (at(i+1) === 'F') ? 2 : 1; break;
            case 'G':
                if (at(i+1) === 'H') {
                    if (i > 0 && !isV(at(i-1))) { add('K'); i += 2; break; }
                    if (i === 0) { add(at(i+2) === 'I' ? 'J' : 'K'); i += 2; break; }
                    i += 2; break;
                }
                if (at(i+1) === 'N') {
                    if (i === 1 && isV(at(0)) && !slavo()) add('KN', 'N');
                    else add('N');
                    i += 2; break;
                }
                if ('EIY'.includes(at(i+1))) { add('J', 'K'); i += 2; break; }
                add('K'); i += (at(i+1) === 'G') ? 2 : 1; break;
            case 'H':
                if (isV(at(i+1)) && (i === 0 || isV(at(i-1)))) { add('H'); i++; }
                i++; break;
            case 'J':
                add('J', 'H'); i += (at(i+1) === 'J') ? 2 : 1; break;
            case 'K':
                add('K'); i += (at(i+1) === 'K') ? 2 : 1; break;
            case 'L':
                add('L'); i += (at(i+1) === 'L') ? 2 : 1; break;
            case 'M':
                add('M'); i += (at(i+1) === 'M') ? 2 : 1; break;
            case 'N':
                add('N'); i += (at(i+1) === 'N') ? 2 : 1; break;
            case 'P':
                if (at(i+1) === 'H') { add('F'); i += 2; break; }
                add('P'); i += (at(i+1) === 'P') ? 2 : 1; break;
            case 'Q':
                add('K'); i += (at(i+1) === 'Q') ? 2 : 1; break;
            case 'R':
                add('R'); i += (at(i+1) === 'R') ? 2 : 1; break;
            case 'S':
                if (sub(i,2) === 'SH') { add('X'); i += 2; break; }
                if (sub(i,3).match(/SIO|SIA/)) { add('X'); i += 3; break; }
                if (sub(i,2) === 'SC') {
                    if (at(i+2).match(/[IEY]/)) { add('S'); i += 3; }
                    else { add('SK'); i += 3; }
                    break;
                }
                add('S'); i += (sub(i,2) === 'SS') ? 2 : 1; break;
            case 'T':
                if (sub(i,4) === 'TION' || sub(i,3).match(/TIA|TCH/)) { add('X'); i += 3; break; }
                if (sub(i,2) === 'TH') { add('0', 'T'); i += 2; break; }
                add('T'); i += (sub(i,2).match(/TT|TD/)) ? 2 : 1; break;
            case 'V':
                add('F'); i += (at(i+1) === 'V') ? 2 : 1; break;
            case 'W':
                if (sub(i,2) === 'WR') { add('R'); i += 2; break; }
                if (i === 0 && isV(at(i+1))) { add('A'); }
                i++; break;
            case 'X':
                add('KS'); i += (at(i+1).match(/[CX]/)) ? 2 : 1; break;
            case 'Z':
                if (at(i+1) === 'H') { add('J'); i += 2; break; }
                add('S'); i += (at(i+1) === 'Z') ? 2 : 1; break;
            default:
                i++; break;
        }
    }
    return [p.substring(0, 4), s.substring(0, 4)];
}

/**
 * Returns true if spoken word matches target word by:
 *  1. Exact equality (after normalizeWord has already been applied to both)
 *  2. Double Metaphone phonetic match (handles "fk" == "fuck", homophones, ASR substitutions)
 *  3. Levenshtein edit distance <= 1 (handles 1-char mishearings / typos in lyrics)
 */
var _spokenLRU = new MetaphoneLRU(50);

function wordsMatch(spoken, target, targetPhonetic) {
    if (spoken === target) return true;
    // -in/-ing suffix normalization
    if (spoken.length >= 4 && target.length >= 4) {
        var sBase = spoken.endsWith('ing') ? spoken.slice(0, -3) :
                    (spoken.endsWith('in') ? spoken.slice(0, -2) : null);
        var tBase = target.endsWith('ing') ? target.slice(0, -3) :
                    (target.endsWith('in') ? target.slice(0, -2) : null);
        if (sBase && tBase && sBase.length >= 3 && sBase === tBase) return true;
    }
    if (contractionsMatch(spoken, target)) return true;
    if (slangMatch(spoken, target)) return true;
    // Phonetic match (guarded: both ≥3 chars, same first letter or both ≥5 chars)
    if (spoken.length >= 3 && target.length >= 3) {
        var sp = _spokenLRU.get(spoken);
        var tp = targetPhonetic || doubleMetaphone(target);
        if (sp[0] && tp[0] && (sp[0] === tp[0] || sp[0] === tp[1] || (sp[1] && (sp[1] === tp[0] || sp[1] === tp[1])))) {
            var sameFirst = spoken[0] === target[0];
            var bothLong = spoken.length >= 5 && target.length >= 5 && Math.abs(spoken.length - target.length) <= 2;
            if (sameFirst || bothLong) return true;
        }
    }
    if (!skipFuzzyMatch(target) && !skipFuzzyMatch(spoken)) {
        var maxDist = maxEditDistance(Math.min(spoken.length, target.length));
        var edDist  = (Math.abs(spoken.length - target.length) <= maxDist)
                      ? editDistance(spoken, target) : Infinity;
        if (edDist === 1) return true;
        if (edDist === 2 && isEdit2PrefixTruncation(spoken, target)) return true;
    }
    return false;
}

/**
 * Scored word matching. Returns { score, method } where:
 *   score:  0.0 to 1.0
 *   method: 'exact' | 'phonetic' | 'slang' | 'edit1' | 'edit2' | 'contraction' | 'none'
 */
function wordsMatchScore(spoken, target, targetPhonetic) {
    // 1. Exact
    if (spoken === target) return { score: 1.0, method: 'exact' };

    // 1b. -in/-ing suffix normalization ("livin"↔"living", "smokin"↔"smoking")
    if (spoken.length >= 4 && target.length >= 4) {
        var sBase = spoken.endsWith('ing') ? spoken.slice(0, -3) :
                    (spoken.endsWith('in') ? spoken.slice(0, -2) : null);
        var tBase = target.endsWith('ing') ? target.slice(0, -3) :
                    (target.endsWith('in') ? target.slice(0, -2) : null);
        if (sBase && tBase && sBase.length >= 3 && sBase === tBase) return { score: 1.0, method: 'exact' };
    }

    // 2. Contraction (single-word)
    if (contractionsMatch(spoken, target)) return { score: 1.0, method: 'contraction' };

    // 3. Slang dictionary
    if (slangMatch(spoken, target)) return { score: 0.9, method: 'slang' };

    // 4. Phonetic match (guarded: both ≥3 chars, same first letter or both ≥5 chars)
    if (spoken.length >= 3 && target.length >= 3) {
        var sp = _spokenLRU.get(spoken);
        var tp = targetPhonetic || doubleMetaphone(target);
        if (sp[0] && tp[0] && (sp[0] === tp[0] || sp[0] === tp[1] || (sp[1] && (sp[1] === tp[0] || sp[1] === tp[1])))) {
            var sameFirst = spoken[0] === target[0];
            var bothLong = spoken.length >= 5 && target.length >= 5 && Math.abs(spoken.length - target.length) <= 2;
            if (sameFirst || bothLong) {
                return { score: 0.8, method: 'phonetic' };
            }
        }
    }

    // 5. Edit distance (only for words >= 3 chars)
    if (!skipFuzzyMatch(target) && !skipFuzzyMatch(spoken)) {
        var dist = (Math.abs(spoken.length - target.length) <= 3) ? editDistance(spoken, target) : Infinity;
        if (dist === 1) return { score: 0.75, method: 'edit1' };
        if (dist === 2 && isEdit2PrefixTruncation(spoken, target)) return { score: 0.4, method: 'edit2' };
    }

    return { score: 0.0, method: 'none' };
}

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

function normalizeWord(w) {
    return w.toLowerCase().replace(/[''`,.!?;:\-"*()]/g, '').trim();
}

function normalizeWords(text) {
    return text.split(/\s+/)
        .map(normalizeWord)
        .filter(w => w.length > 0);
}

/**
 * Estimate syllable count for a word using vowel-cluster heuristic.
 * Used to weight word-level timestamp interpolation so longer words
 * get proportionally more time.
 * @param {string} word - lowercase, already normalized
 * @returns {number} estimated syllable count (minimum 1)
 */
function estimateSyllables(word) {
    if (!word) return 1;
    // Remove trailing silent-e
    var w = word.replace(/e$/, '') || word;
    // Count vowel clusters
    var matches = w.match(/[aeiouy]+/gi);
    var count = matches ? matches.length : 1;
    return Math.max(1, count);
}

/**
 * Compute estimated per-word timestamps for all lyrics lines.
 * Each word gets {estimatedTime, windowStart, windowEnd} based on
 * syllable-weighted distribution within its line's time span.
 * Each line's array also gets metadata: wps, tempoClass, lineStart, lineEnd.
 *
 * @param {Array<{time: number, text: string}>} lyricsArr - parsed LRC lines
 * @returns {Array<Array<{word: string, estimatedTime: number, windowStart: number, windowEnd: number}>>}
 *          One array per line, each containing per-word timing data.
 */
function interpolateWordTimings(lyricsArr) {
    var allTimings = [];
    for (var i = 0; i < lyricsArr.length; i++) {
        var line = lyricsArr[i];
        var words = line.text.trim().split(/\s+/);
        if (words.length === 0 || !words[0]) {
            var empty = [];
            empty.wps = 0;
            empty.tempoClass = 'slow';
            empty.lineStart = line.time;
            empty.lineEnd = line.time;
            allTimings.push(empty);
            continue;
        }

        // Line duration: time to next line, or audio.duration for last line (clamped to 8s)
        var lineStart = line.time;
        var lineEnd;
        if (i + 1 < lyricsArr.length) {
            lineEnd = lyricsArr[i + 1].time;
        } else {
            // Last line: use audio duration if available, else fallback to +4s
            var audioDur = (typeof audio !== 'undefined' && audio.duration && isFinite(audio.duration))
                ? audio.duration : lineStart + 4.0;
            lineEnd = Math.min(audioDur, lineStart + 8.0);
        }
        var lineDuration = lineEnd - lineStart;

        // Compute per-line tempo
        var wps = lineDuration > 0 ? words.length / lineDuration : 0;
        var tempoClass = classifyTempo(wps);
        var params = getWindowParams(tempoClass);

        // Compute syllable weights and word classifications
        var inParen = false;
        var wordClasses = [];
        var syllables = words.map(function(w, wi) {
            var nw = normalizeWord(w);
            // Track parentheses — a word starting with '(' opens, ending with ')' closes
            if (w.indexOf('(') >= 0) inParen = true;
            wordClasses.push(classifyWord(nw, inParen));
            if (w.indexOf(')') >= 0) inParen = false;
            return estimateSyllables(nw);
        });
        var totalSyllables = 0;
        for (var s = 0; s < syllables.length; s++) totalSyllables += syllables[s];
        if (totalSyllables === 0) totalSyllables = 1; // defensive guard

        // Distribute time proportionally by syllable count
        var wordTimings = [];
        var cursor = lineStart;
        for (var wi = 0; wi < words.length; wi++) {
            var wordDuration = (syllables[wi] / totalSyllables) * lineDuration;
            var estimatedTime = cursor;
            // Slow lines: all words share line-level windowStart so the
            // entire phrase is matchable as soon as the line activates.
            // Normal/fast lines keep per-word gates for positional accuracy.
            var wStart = tempoClass === 'slow'
                ? lineStart + (words.length <= 3 ? -0.5 : params.windowStart)
                : estimatedTime + params.windowStart;
            var timing = {
                word: normalizeWord(words[wi]),
                estimatedTime: estimatedTime,
                windowStart: wStart,
                windowEnd: estimatedTime + params.windowEnd,
                wordClass: wordClasses[wi],
                weight: WORD_WEIGHTS[wordClasses[wi]]
            };
            timing.phonetic = doubleMetaphone(normalizeWord(words[wi]));
            wordTimings.push(timing);
            cursor += wordDuration;
        }

        // Attach line-level metadata to the array
        wordTimings.wps = wps;
        wordTimings.tempoClass = tempoClass;
        wordTimings.lineStart = lineStart;
        wordTimings.lineEnd = lineEnd;

        allTimings.push(wordTimings);
    }
    return allTimings;
}

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
        this.transcript        = '';      // accumulated final transcript (never reset)
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
        this.whisperBuffer  = '';
        this._whisperInFlight = 0;

        // Whisper server state (populated from /whisper-status at game start)
        this._whisperServerStatus = { state: 'unknown', reason: null, checkedAt: null };

        // Whisper client track state (populated by _startWhisperTrack outcome)
        this._whisperTrackStatus  = { state: 'idle', reason: null, startAttempts: 0, startFailures: 0 };

        // Whisper chunk telemetry counters
        this._chunksDispatched          = 0;
        this._chunksSucceeded           = 0;
        this._chunksFailed503           = 0;
        this._chunksFailed500           = 0;
        this._chunksDroppedWhileLoading = 0;
        this._chunksFailedNetwork       = 0;
        this._whisperResponses          = 0;
        this._whisperResponsesWithWords = 0;
        this._whisperWordsTotal         = 0;

        // Diagnostic
        this._dbBuf = [];
        this._telemetry = null;   // populated by _initTelemetry() when debug mode is on
        this._lineStartAudioTime = null;

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
        this.activeLineIdx = -1;
        this.lineWords = [];
        this.matchedSet = new Map();
        this.vadMatchedSet = new Map();
        this.asrConfirmedSet = new Set();
        this._lineComparisonCount = 0;   // total word comparisons attempted this line
        this.transcript = '';
        this.lineStartWordCount = 0;
        this.lineStartTranscriptPos = 0;
        this.latestInterim = '';
        this.totalWords      = 0;
        this.matchedWords    = 0;
        this.weightedTotal   = 0;
        this.weightedMatched = 0;
        this.linesScored     = 0;
        this.perfectLines    = 0;
        this.currentStreak   = 0;
        this.bestStreak      = 0;
        this.whisperBuffer = '';
        this.prevLine = null;
        this._lineStartAudioTime = 0;
        this._lastResultTime = Date.now();
        this.allWordTimings = interpolateWordTimings(lyrics);
        this.songTempoProfile = computeSongTempoProfile(this.allWordTimings);
        this._initTelemetry();   // always init so download button works whenever D is pressed
        for (var li = 0; li < this.allWordTimings.length; li++) {
            var lt = this.allWordTimings[li];
            var relClass = classifyLineTempoRelative(lt.wps || 0, this.songTempoProfile);
            lt.useVad = true; // all tempo classes get provisional VAD; slow lines use stricter energy gate in updateHotWord
            lt.vadTempoClass = relClass;
        }
        // Restore per-song LRC offset from localStorage
        this.lrcOffset = parseFloat(localStorage.getItem('lrcOffset_' + _songKey()) || '0');
        _updateOffsetDisplay();
        this.wordTimings = [];
        this.hotWordIndex = -1;
        this.isSpeaking = false;
        this._vadBaseline = 0;
        this._vadBaselineReady = false;
        this._vadBaselineSamples = [];
        this._vadAnalyser = null;
        this._vadAnalyserBuf = null;
        this._energyThreshold = 0.01; // reset to default until baseline computed

        renderLyricsGameMode();
        this._setupRecognition();
        this._startWhisperTrack(); // async — Track 2 starts in background

        // Fetch server Whisper state and store for telemetry and HUD
        fetch('/whisper-status')
            .then(function(r) { return r.json(); })
            .then(function(data) {
                this._whisperServerStatus = {
                    state:     data.status || 'unknown',
                    reason:    data.error  || null,
                    checkedAt: Date.now(),
                };
            }.bind(this))
            .catch(function() {
                this._whisperServerStatus = { state: 'error', reason: 'status fetch failed', checkedAt: Date.now() };
            }.bind(this));

        document.getElementById('score-display').style.display = 'flex';
        document.getElementById('score-pct').textContent = '0%';
        document.getElementById('gameBtn').classList.add('active');
        document.getElementById('lrc-offset-control').style.display = 'flex';
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
    }

    /**
     * Suspend judging (on pause). Stops recognition and VAD but keeps game active.
     */
    suspend() {
        if (!this.active || this._suspended) return;
        this._suspended = true;
        if (this.recognition) {
            try { this.recognition.stop(); } catch(e) {}
        }
        this.isSpeaking = false;
    }

    /**
     * Resume judging (on play after pause). Restarts recognition.
     */
    resume() {
        if (!this.active || !this._suspended) return;
        this._suspended = false;
        if (this.recognition) {
            try { this.recognition.start(); } catch(e) {}
        }
    }

    /**
     * Handle seek/skip during game mode. Resets current line scoring state
     * so that pre-seek transcript doesn't count toward the new position.
     */
    onSeek() {
        if (!this.active) return;
        // Discard current line's match state — it will be re-established
        // when updateLyrics fires and calls setActiveLine for the new position.
        this.matchedSet = new Map();
        this.vadMatchedSet = new Map();
        this.asrConfirmedSet = new Set();
        this.lineStartWordCount = normalizeWords(this.transcript).length;
        this.lineStartTranscriptPos = this.lineStartWordCount;
        this.hotWordIndex = -1;
        this.whisperBuffer = '';
        this.prevLine = null;   // discard any pending overlap scoring
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
            self.lineHadAsrEvent = true;
            var interim = '';
            var finalText = '';
            for (var i = e.resultIndex; i < e.results.length; i++) {
                if (e.results[i].isFinal) {
                    finalText += e.results[i][0].transcript + ' ';
                } else {
                    interim += e.results[i][0].transcript + ' ';
                }
            }
            if (finalText) self.transcript += finalText;
            self.latestInterim = interim;

            // HOT-WORD PRIORITY: check predicted word first for instant green
            var hotMatched = self._matchHotWord(self.transcript + interim);
            if (hotMatched) self._updateWordSpans();

            // Match against previous line during overlap zone (Track 1)
            self._matchPrevLine(self.transcript + interim, 'track1');

            // Match primary transcript
            var unionMap = new Map();
            self._collectMatches(self.transcript + interim, unionMap);

            // Union with alternative transcripts from latest result
            var latest = e.results[e.results.length - 1];
            for (var a = 1; a < latest.length; a++) {
                self._collectMatches(self.transcript + latest[a].transcript, unionMap);
            }

            // Sticky: once matched, stay matched. Only upgrade scores, never downgrade.
            unionMap.forEach(function(score, i) {
                var existing = self.matchedSet.get(i);
                if (existing === undefined || score > existing) {
                    self.matchedSet.set(i, score);
                }
                if (self.vadMatchedSet.has(i) && !self.asrConfirmedSet.has(i)) {
                    self.asrConfirmedSet.add(i);
                    self._logPromotion('browser_sr', i, score);
                }
            });
            self._updateWordSpans();

            // Diagnostic: log what the recognition heard and what matched
            if (window._kDebug) {
                const spokenFull = normalizeWords(self.transcript + interim);
                const scanFrom   = self.lineStartTranscriptPos;
                self._debugLog('RESULT', {
                    lineIdx:   self.activeLineIdx,
                    finalText: finalText || null,
                    interim:   interim   || null,
                });
                self._logAsr(finalText ? 'final' : 'interim', finalText || interim, [], 'browser_sr');
                self._debugLog('MATCH', {
                    lineIdx:     self.activeLineIdx,
                    targets:     self.lineWords.slice(),
                    spokenWindow: spokenFull.slice(scanFrom, scanFrom + 20),
                    matchedIdxs: [...unionMap.keys()],
                    hotIdx:      self.hotWordIndex,
                    hotWindow:   self.hotWordIndex >= 0 && self.wordTimings[self.hotWordIndex]
                                    ? [self.wordTimings[self.hotWordIndex].windowStart.toFixed(2),
                                       self.wordTimings[self.hotWordIndex].windowEnd.toFixed(2)]
                                    : null,
                    audioTime:   audio.currentTime.toFixed(2),
                    fencePos:    self.lineStartTranscriptPos,
                });
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
            if (!this.active || audio.paused) return;
            if (Date.now() - this._lastResultTime > 5000) {
                console.warn('[GAME] Recognition watchdog: no results for 5s, restarting');
                this._lastResultTime = Date.now();
                try { this.recognition.abort(); } catch(e) {}
                // onend handler will restart
            }
        }, 2000);
    }

    async _startWhisperTrack() {
        this._whisperTrackStatus.startAttempts++;
        try {
            this._whisperTrackStatus.state = 'starting';
            this._whisperStream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
            });
            this._whisperCtx    = new AudioContext({ sampleRate: 16000 });
            await this._whisperCtx.audioWorklet.addModule('/static/audio-processor.js');
            const src  = this._whisperCtx.createMediaStreamSource(this._whisperStream);
            this._whisperNode = new AudioWorkletNode(this._whisperCtx, 'chunk-processor');
            // VAD AnalyserNode — polled every 100ms, decoupled from Whisper chunks
            this._vadAnalyser = this._whisperCtx.createAnalyser();
            this._vadAnalyser.fftSize = 256;
            this._vadAnalyserBuf = new Float32Array(this._vadAnalyser.fftSize);
            src.connect(this._vadAnalyser);
            this._whisperNode.port.onmessage = (e) => {
                if (!this.active) return;
                var msg = e.data;
                if (msg && msg.type === 'energy') {
                    // isSpeaking and baseline calibration are now handled in updateHotWord via AnalyserNode
                } else if (msg && msg.type === 'chunk') {
                    this._sendChunkToWhisper(msg.data);
                } else if (msg && msg.type === 'overlap-chunk') {
                    if (this._whisperInFlight < 2) {
                        this._sendChunkToWhisper(msg.data);
                    }
                } else if (msg instanceof Float32Array) {
                    // Backward compat: raw Float32Array (shouldn't happen but safe)
                    this._sendChunkToWhisper(msg);
                }
            };
            src.connect(this._whisperNode);
            this._whisperTrackStatus.state = 'ready';
        } catch (err) {
            this._whisperTrackStatus.state = 'error';
            this._whisperTrackStatus.reason = err.message || String(err);
            this._whisperTrackStatus.startFailures++;
            console.warn('[Whisper track] unavailable:', this._whisperTrackStatus.reason);
            this._whisperStream = null;
            this._whisperCtx    = null;
            this._whisperNode   = null;
        }
    }

    _stopWhisperTrack() {
        if (this._whisperNode) {
            this._whisperNode.disconnect();
            this._whisperNode = null;
        }
        if (this._whisperCtx) {
            this._whisperCtx.close();
            this._whisperCtx = null;
        }
        this._vadAnalyser    = null;
        this._vadAnalyserBuf = null;
        if (this._whisperStream) {
            this._whisperStream.getTracks().forEach(t => t.stop());
            this._whisperStream = null;
        }
    }

    /** Poll /whisper-status and update _whisperServerStatus. Returns a Promise. */
    _checkWhisperServerStatus() {
        return fetch('/whisper-status')
            .then(function(r) { return r.json(); })
            .then(function(data) {
                this._whisperServerStatus = {
                    state:     data.status || 'unknown',
                    reason:    data.error  || null,
                    checkedAt: Date.now(),
                };
            }.bind(this))
            .catch(function() { /* silent — best effort */ }.bind(this));
    }

    async _sendChunkToWhisper(float32) {
        // Circuit breaker: if server said it's loading, drop chunk and poll instead
        if (this._whisperServerStatus.state === 'loading') {
            this._chunksDroppedWhileLoading++;
            // Poll once per dropped chunk (rate-limited by chunk cadence ~2s)
            this._checkWhisperServerStatus();
            return;
        }

        this._chunksDispatched++;
        this._whisperInFlight++;
        const wav = encodeWav(float32, 16000);
        try {
            var headers = { 'Content-Type': 'audio/wav' };
            if (this.activeLineIdx >= 0 && lyrics[this.activeLineIdx]) {
                headers['X-Lyric-Hint'] = lyrics[this.activeLineIdx].text;
            }
            const resp = await fetch('/transcribe', {
                method: 'POST',
                body: wav,
                headers: headers,
            });

            if (resp.status === 503) {
                this._chunksFailed503++;
                // Enter circuit-breaker: server model not ready, pause dispatch
                this._whisperServerStatus.state = 'loading';
                this._checkWhisperServerStatus(); // async poll to detect when ready
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

            if (data.transcript && this.active) {
                this.whisperBuffer = (this.whisperBuffer + ' ' + data.transcript).trim();
                this.lineHadAsrEvent = true;
                this._collectMatchesWhisper(this.whisperBuffer);
                this._logAsr('final', data.transcript, data.words || [], 'whisper');
                this._whisperResponses++;
                if (data.words && data.words.length > 0) {
                    this._whisperResponsesWithWords++;
                    this._whisperWordsTotal += data.words.length;
                }
            }
            if (data.words && data.words.length > 0 && this.active) {
                this._lastWhisperWords = data.words;
            }
        } catch (_err) {
            this._chunksFailedNetwork++;
            /* fire-and-forget — network errors are expected on flaky connections */
        } finally {
            this._whisperInFlight = Math.max(0, this._whisperInFlight - 1);
        }
    }

    /**
     * Finalize and score the previous line's overlay, then discard it.
     * Called when the overlap zone expires or when a new overlap begins.
     */
    _finalizePrevLine() {
        if (!this.prevLine) return;
        var prev = this.prevLine;
        this.prevLine = null;

        // Score the previous line with its final match state
        if (prev.lineWords.length > 0) {
            this._scoreLine(prev.lineIdx, prev.lineWords, prev.matchedSet, prev.lineHadAsrEvent,
                            prev.vadMatchedSet, prev.asrConfirmedSet);
        }
    }

    /**
     * During the overlap zone, attempt to match ASR words against the
     * previous line's unmatched words. Returns true if any match was found.
     * @param {string} transcript - full transcript (Track 1) or whisper buffer (Track 2)
     * @param {'track1'|'track2'} track
     */
    _matchPrevLine(transcript, track) {
        if (!this.prevLine) return false;
        if (performance.now() > this.prevLine.overlapEnd) return false;

        var prev = this.prevLine;
        var spoken = normalizeWords(transcript);
        var spokenIdx = (track === 'track1') ? prev.lineStartTranscriptPos : 0;
        var driftWindow = (track === 'track1') ? prev.params.driftTrack1 : prev.params.driftTrack2;
        var cursor = spokenIdx;
        var anyMatched = false;

        for (var li = 0; li < prev.lineWords.length; li++) {
            if (prev.matchedSet.has(li)) { cursor++; continue; }
            var target = prev.lineWords[li];
            var targetPhonetic = prev.wordTimings && prev.wordTimings[li] ? prev.wordTimings[li].phonetic : undefined;
            for (var si = cursor; si < Math.min(cursor + driftWindow, spoken.length); si++) {
                if (wordsMatch(spoken[si], target, targetPhonetic)) {
                    prev.matchedSet.set(li, 1.0);
                    cursor = si + 1;
                    anyMatched = true;
                    // Light the span green on the previous line
                    var allLines = lyricsScroll.querySelectorAll('.lyric-line');
                    var lineEl = allLines[prev.lineIdx];
                    if (lineEl) {
                        var span = lineEl.querySelectorAll('.word-span')[li];
                        if (span) { span.classList.remove('missed'); span.classList.add('matched'); }
                    }
                    break;
                }
            }
        }
        return anyMatched;
    }

    _collectMatchesWhisper(transcript) {
        if (this.lineWords.length === 0) return;
        const spoken = normalizeWords(transcript);
        const whisperMap = new Map();
        const windowSize = getSpokenWindowSize((this.wordTimings && this.wordTimings.tempoClass) || 'normal');
        var maxWindow = this.lineWords.length * 3;
        let spokenIdx = Math.max(0, spoken.length - Math.min(windowSize, maxWindow));
        var now = audio.currentTime;
        var driftWindow = this.currentParams.driftTrack2;
        for (let li = 0; li < this.lineWords.length; li++) {
            if (li < this.wordTimings.length) {
                if (now < this.wordTimings[li].windowStart) continue;
            }
            const target = this.lineWords[li];
            const targetPhonetic = this.wordTimings[li] ? this.wordTimings[li].phonetic : undefined;
            for (let si = spokenIdx; si < Math.min(spokenIdx + driftWindow, spoken.length); si++) {
                if (FILLER_WORDS.has(spoken[si])) { spokenIdx = si + 1; si = spokenIdx - 1; continue; }

                var consumed = multiWordContractionMatch(spoken, si, target);
                if (consumed > 0) {
                    whisperMap.set(li, 1.0);
                    spokenIdx = si + consumed;
                    break;
                }
                var pm = phraseMatch(spoken, si, this.lineWords, li);
                if (pm) {
                    for (var pt = 0; pt < pm.targetConsumed; pt++) { whisperMap.set(li + pt, 1.0); }
                    spokenIdx = si + pm.spokenConsumed;
                    li += pm.targetConsumed - 1;
                    break;
                }
                var result = wordsMatchScore(spoken[si], target, targetPhonetic);
                if (result.score > 0) {
                    whisperMap.set(li, result.score);
                    // If the next target word is the same, allow reusing this spoken position
                    var nextTarget = (li + 1 < this.lineWords.length) ? this.lineWords[li + 1] : null;
                    if (nextTarget !== target) {
                        spokenIdx = si + 1;
                    }
                    break;
                }
            }
        }
        whisperMap.forEach(function(score, i) {
            var existing = this.matchedSet.get(i);
            if (existing === undefined || score > existing) {
                this.matchedSet.set(i, score);
            }
            if (this.vadMatchedSet.has(i) && !this.asrConfirmedSet.has(i)) {
                this.asrConfirmedSet.add(i);
                this._logPromotion('whisper', i, score);
            }
        }.bind(this));
        this._updateWordSpans();

        // Match against previous line during overlap zone (Track 2)
        if (this.prevLine) {
            this._matchPrevLine(this.prevLine.whisperBuffer + ' ' + transcript, 'track2');
        }
    }

    setActiveLine(lineIdx) {
        // Capture outgoing state for diagnostics BEFORE anything changes
        var _dbgFromIdx  = this.activeLineIdx;
        var _dbgFromText = (_dbgFromIdx >= 0 && lyrics[_dbgFromIdx]) ? lyrics[_dbgFromIdx].text : '—';

        // --- Soft boundary: preserve outgoing line as prevLine overlay ---
        // If there's already a prevLine overlay, finalize it first (fast succession)
        this._finalizePrevLine();

        // Create overlay for the outgoing line (if it had words to match)
        if (this.activeLineIdx >= 0 && this.lineWords.length > 0) {
            var outgoingTempoClass = (this.wordTimings && this.wordTimings.tempoClass) || 'normal';
            var overlapDuration = getAdjustedOverlapDuration(outgoingTempoClass, this.lineWords.length);
            var scoreDelay = getScoreDelay(outgoingTempoClass);

            this.prevLine = {
                lineIdx:                this.activeLineIdx,
                lineWords:              this.lineWords.slice(),
                matchedSet:             new Map(this.matchedSet),
                vadMatchedSet:          new Map(this.vadMatchedSet),
                asrConfirmedSet:        new Set(this.asrConfirmedSet),
                lineStartWordCount:     this.lineStartWordCount,
                lineStartTranscriptPos: this.lineStartTranscriptPos,
                wordTimings:            this.wordTimings,
                params:                 this.currentParams,
                overlapEnd:             performance.now() + (overlapDuration * 1000),
                whisperBuffer:          this.whisperBuffer,
                lineHadAsrEvent:        this.lineHadAsrEvent,
            };

            // Schedule finalization after overlap + score delay
            var totalDelay = (overlapDuration + scoreDelay) * 1000;
            var capturedLineIdx = this.activeLineIdx;
            var self = this;
            setTimeout(function() {
                // Only finalize if this prevLine is still the active overlay
                if (self.prevLine && self.prevLine.lineIdx === capturedLineIdx) {
                    self._finalizePrevLine();
                }
            }, totalDelay);
        }

        // --- Final match pass on outgoing line before transition ---
        if (this.lineWords.length > 0 && this.transcript) {
            var finalMap = new Map();
            this._collectMatches(this.transcript + ' ' + this.latestInterim, finalMap);
            // Merge any new matches into matchedSet (upgrade only)
            finalMap.forEach(function(score, idx) {
                var existing = this.matchedSet.get(idx);
                if (existing === undefined || score > existing) {
                    this.matchedSet.set(idx, score);
                }
            }.bind(this));
            this._updateWordSpans();
        }

        // Diagnostic: log transition
        if (window._kDebug && _dbgFromIdx >= 0 && this.lineWords.length > 0) {
            this._debugLog('LINE', {
                fromIdx:       _dbgFromIdx,
                fromText:      _dbgFromText,
                toIdx:         lineIdx,
                toText:        (lineIdx >= 0 && lyrics[lineIdx]) ? lyrics[lineIdx].text : '—',
                matched:       this.matchedSet.size,
                total:         this.lineWords.length,
                missedWords:   this.lineWords.filter(function(w, i) { return !this.matchedSet.has(i); }.bind(this)).join(', '),
                transcriptTail: normalizeWords(this.transcript).slice(-8).join(' '),
                interim:       this.latestInterim,
            });
            this._logTransition(
                _dbgFromIdx,
                lineIdx,
                'score',       // default trigger — time-gate advances also pass through here
                _dbgFromText,
                this.matchedSet.size,
                this.lineWords.length,
                this.lineWords.filter(function(w, i) { return !this.matchedSet.has(i); }.bind(this)),
                this._lineStartAudioTime
            );
        }

        // --- Set up new line ---
        this.activeLineIdx = lineIdx;
        this._lineStartAudioTime = (audio && isFinite(audio.currentTime)) ? audio.currentTime : 0;
        this.lineStartWordCount = normalizeWords(this.transcript).length;
        this.lineStartTranscriptPos = this.lineStartWordCount;
        this.matchedSet = new Map();
        this.vadMatchedSet = new Map();
        this.asrConfirmedSet = new Set();
        this.lineHadAsrEvent = false;
        this._lineComparisonCount = 0;
        this.whisperBuffer = '';
        this._telemetryLoggedMatches = new Set();

        // Load interpolated word timings for this line
        this.wordTimings = (lineIdx >= 0 && lineIdx < this.allWordTimings.length)
            ? this.allWordTimings[lineIdx]
            : [];
        this.hotWordIndex = -1;

        // Load adaptive window params for this line's tempo
        this.currentParams = (this.wordTimings && this.wordTimings.tempoClass)
            ? getWindowParams(this.wordTimings.tempoClass)
            : getWindowParams('normal');

        // Dynamic Whisper chunk size: flush current buffer, then resize and enable overlap for fast
        if (this._whisperNode && this._whisperNode.port) {
            var tempoClass = (this.wordTimings && this.wordTimings.tempoClass) || 'normal';
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

        if (lineIdx < 0 || lineIdx >= lyrics.length) {
            this.lineWords = [];
            return;
        }

        var lineText = lyrics[lineIdx].text.trim();
        if (!lineText || lineText === '\u266a' || lineText === '\u266b') {
            this.lineWords = [];
            return;
        }

        var rawWords = lineText.split(' ');
        this.lineWords = rawWords.map(function(w) { return normalizeWord(w); }).filter(function(w) { return w.length > 0; });

        // Reset spans to grey for new active line
        var lines = lyricsScroll.querySelectorAll('.lyric-line');
        if (lines[lineIdx]) {
            lines[lineIdx].querySelectorAll('.word-span').forEach(function(s) {
                s.classList.remove('matched', 'matched-partial', 'missed', 'asr-confirmed');
            });
        }
    }

    _collectMatches(transcript, resultMap) {
        if (this.lineWords.length === 0) return;
        var spoken = normalizeWords(transcript);
        var windowSize = getSpokenWindowSize((this.wordTimings && this.wordTimings.tempoClass) || 'normal');
        // Sliding window: cap spoken scan to lineWords.length * 3
        var maxWindow = this.lineWords.length * 3;
        var spokenIdx = Math.max(this.lineStartTranscriptPos, spoken.length - Math.min(windowSize, maxWindow));
        var now = audio.currentTime;
        var driftWindow = this.currentParams.driftTrack1;
        for (var li = 0; li < this.lineWords.length; li++) {
            if (li < this.wordTimings.length) {
                if (now < this.wordTimings[li].windowStart) continue;
            }
            var target = this.lineWords[li];
            var targetPhonetic = this.wordTimings[li] ? this.wordTimings[li].phonetic : undefined;
            for (var si = spokenIdx; si < Math.min(spokenIdx + driftWindow, spoken.length); si++) {
                if (FILLER_WORDS.has(spoken[si])) { spokenIdx = si + 1; si = spokenIdx - 1; continue; }
                this._lineComparisonCount++;

                // Try multi-word contraction first (consumes multiple spoken words)
                var consumed = multiWordContractionMatch(spoken, si, target);
                if (consumed > 0) {
                    resultMap.set(li, 1.0);
                    this._logMatch(spoken[si], target, 'contraction', 0, false, 1.0, true, si);
                    spokenIdx = si + consumed;
                    break;
                }

                // Try phrase match (consumes multiple target or spoken words)
                var pm = phraseMatch(spoken, si, this.lineWords, li);
                if (pm) {
                    for (var pt = 0; pt < pm.targetConsumed; pt++) { resultMap.set(li + pt, 1.0); }
                    this._logMatch(spoken[si], this.lineWords[li], 'phrase', 0, false, 1.0, true, si);
                    spokenIdx = si + pm.spokenConsumed;
                    li += pm.targetConsumed - 1;
                    break;
                }

                // Scored single-word match
                var result = wordsMatchScore(spoken[si], target, targetPhonetic);
                if (result.score > 0) {
                    // Only upgrade, never downgrade a previously matched word
                    var prev = resultMap.get(li);
                    if (prev === undefined || result.score > prev) {
                        resultMap.set(li, result.score);
                    }
                    this._logMatch(spoken[si], target, result.method,
                        result.method === 'edit1' ? 1 : result.method === 'edit2' ? 2 : 0,
                        result.method === 'phonetic', result.score, true, si);
                    // If the next target word is the same, allow reusing this spoken position
                    var nextTarget = (li + 1 < this.lineWords.length) ? this.lineWords[li + 1] : null;
                    if (nextTarget !== target) {
                        spokenIdx = si + 1;
                    }
                    break;
                }

                // Log unmatched attempt
                this._logMatch(spoken[si], target, 'none', -1, false, 0.0, false, si);
            }
        }
    }

    _matchTranscript(transcript) {
        var unionMap = new Map();
        this._collectMatches(transcript, unionMap);
        this.matchedSet = unionMap;
        this._updateWordSpans();
    }

    _updateWordSpans() {
        const lines = lyricsScroll.querySelectorAll('.lyric-line');
        const lineEl = lines[this.activeLineIdx];
        if (!lineEl) return;

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
    updateHotWord() {
        // Refresh isSpeaking from AnalyserNode — real-time, not tied to Whisper chunk rate
        var vadRms = this._readVadRms();
        var _vadMultiplier = (this.wordTimings && this.wordTimings.vadTempoClass === 'slow') ? 1.3 : 1.0;
        this.isSpeaking = vadRms > (this._energyThreshold * _vadMultiplier);

        // Baseline calibration during first 2s of playback
        if (!this._vadBaselineReady) {
            if (audio.currentTime > 0 && audio.currentTime < 2.0) {
                this._vadBaselineSamples.push(vadRms);
            } else if (audio.currentTime >= 2.0) {
                if (this._vadBaselineSamples.length > 0) {
                    var bSum = this._vadBaselineSamples.reduce(function(a, b) { return a + b; }, 0);
                    this._vadBaseline = bSum / this._vadBaselineSamples.length;
                    this._energyThreshold = Math.min(this._vadBaseline + 0.025, 0.06);
                }
                this._vadBaselineReady = true;
            }
        }

        if (!this.active || this.wordTimings.length === 0) {
            this.hotWordIndex = -1;
            return;
        }
        var t = audio.currentTime - this.lrcOffset;
        var newHot = -1;
        for (var i = 0; i < this.wordTimings.length; i++) {
            if (this.matchedSet.has(i)) continue; // skip already-green words
            var wt = this.wordTimings[i];
            // VAD mode: use estimatedTime - 0.05s instead of windowStart (-0.5s)
            // so words don't score green 500ms before they're actually said.
            // ASR mode keeps the wide negative offset to give transcription time to catch up.
            var winOpen = (this.wordTimings.useVad) ? (wt.estimatedTime - 0.05) : wt.windowStart;
            if (t >= winOpen && t <= wt.windowEnd) {
                newHot = i;
                break;  // first unmatched window wins
            }
        }
        this.hotWordIndex = newHot;

        // VAD optimistic scoring: if this line uses VAD mode and mic is active,
        // mark the hot word as hit immediately without waiting for ASR.
        if (newHot >= 0 && this.isSpeaking && this.wordTimings.useVad && !this._suspended) {
            if (!this.matchedSet.has(newHot)) {
                this.matchedSet.set(newHot, 0.25);       // provisional — shows amber; upgradeable by ASR
                this.vadMatchedSet.set(newHot, 0.25);
                this.lineHadAsrEvent = true;             // VAD activity counts as "user was trying"
                this._updateWordSpans();
                this._logMatch(
                    this.wordTimings[newHot] ? this.wordTimings[newHot].word : '',
                    this.lineWords[newHot] || '',
                    'vad-provisional', -1, false, 0.25, true, newHot
                );
            }
        }
    }

    /**
     * Attempt to match the current hot word against spoken words.
     * Uses more aggressive matching: accepts any word in the recent
     * spoken buffer that phonetically matches the hot word.
     * Only matches if isSpeaking is true (energy gate) OR if the
     * match is an exact/phonetic match (not just edit-distance).
     * Returns true if the hot word was matched.
     */
    _matchHotWord(transcript) {
        if (this.hotWordIndex < 0 || this.hotWordIndex >= this.lineWords.length) return false;
        if (this.asrConfirmedSet.has(this.hotWordIndex)) return false; // already fully confirmed by ASR

        var target = this.lineWords[this.hotWordIndex];
        var targetPhonetic = this.wordTimings[this.hotWordIndex] ? this.wordTimings[this.hotWordIndex].phonetic : undefined;
        var spoken = normalizeWords(transcript);

        // Fence: only search words spoken since the current line started
        // (within that, only look at recent 10)
        var searchStart = Math.max(this.lineStartTranscriptPos, spoken.length - 10);
        for (var i = searchStart; i < spoken.length; i++) {
            if (wordsMatch(spoken[i], target, targetPhonetic)) {
                // Energy gate: if not speaking, require exact or phonetic match (not edit-distance)
                if (!this.isSpeaking) {
                    if (spoken[i] !== target) {
                        var sp = doubleMetaphone(spoken[i]);
                        var tp = doubleMetaphone(target);
                        var phonetic = sp[0] && tp[0] && (sp[0] === tp[0] || sp[0] === tp[1] || (sp[1] && (sp[1] === tp[0] || sp[1] === tp[1])));
                        if (!phonetic) continue; // skip edit-distance-only matches when silent
                    }
                }
                this.matchedSet.set(this.hotWordIndex, 1.0);
                if (this.vadMatchedSet.has(this.hotWordIndex)) {
                    this.asrConfirmedSet.add(this.hotWordIndex);
                    this._logMatch(
                        spoken[i], target, 'vad-confirmed', -1, false, 1.0, true, this.hotWordIndex
                    );
                }
                return true;
            }
        }
        return false;
    }

    /**
     * Score an outgoing line. Accepts explicit params so delayed calls can pass
     * a snapshot rather than relying on this.* (which will have advanced by then).
     */
    _scoreLine(lineIdx, lineWords, matchedSet, lineHadAsrEvent, vadMatchedSet, asrConfirmedSet) {
        lineIdx    = (lineIdx    !== undefined) ? lineIdx    : this.activeLineIdx;
        lineWords  = (lineWords  !== undefined) ? lineWords  : this.lineWords;
        matchedSet = (matchedSet !== undefined) ? matchedSet : this.matchedSet;
        vadMatchedSet    = vadMatchedSet    || this.vadMatchedSet;
        asrConfirmedSet  = asrConfirmedSet  || this.asrConfirmedSet;

        const total = lineWords.length;
        if (total === 0) return;

        // Zero-ASR line fencing: skip scoring for lines with no ASR activity
        if (lineHadAsrEvent === false) return;

        // Compute weighted score
        var wordTimings = (lineIdx >= 0 && lineIdx < this.allWordTimings.length)
            ? this.allWordTimings[lineIdx] : [];
        var weightedTotal = 0;
        var weightedMatched = 0;
        for (var i = 0; i < lineWords.length; i++) {
            var weight = (wordTimings[i] && wordTimings[i].weight) || 1.0;
            weightedTotal += weight;
            var matchScore = matchedSet.get ? matchedSet.get(i) : (matchedSet.has(i) ? 1.0 : 0);
            // Downgrade VAD-only hits that were never confirmed by ASR
            if (matchScore > 0 && vadMatchedSet && vadMatchedSet.has(i) && !asrConfirmedSet.has(i)) {
                matchScore = 0.25;
            }
            if (matchScore > 0) {
                weightedMatched += weight * matchScore;
            }
        }

        // For display: count matched words (any score > 0)
        var matched = 0;
        for (var j = 0; j < lineWords.length; j++) {
            if (matchedSet.has(j)) matched++;
        }

        // Mark unmatched spans as red
        const lines = lyricsScroll.querySelectorAll('.lyric-line');
        const lineEl = lines[lineIdx];
        if (lineEl) {
            lineEl.querySelectorAll('.word-span').forEach((span, wi) => {
                if (!matchedSet.has(wi)) span.classList.add('missed');
            });

            // Flash per-line score
            const flash = document.createElement('div');
            flash.className = 'line-score-flash';
            flash.textContent = `+${matched}/${total}`;
            flash.style.top = lineEl.offsetTop + 'px';
            document.getElementById('lyrics-container').appendChild(flash);
            setTimeout(() => flash.remove(), 1300);
        }

        this.weightedTotal   += weightedTotal;
        this.weightedMatched += weightedMatched;
        this.totalWords      += total;
        this.matchedWords    += matched;
        this.linesScored++;

        if (weightedTotal > 0 && weightedMatched >= weightedTotal * 0.9) {
            this.perfectLines++;
            this.currentStreak++;
            if (this.currentStreak > this.bestStreak) this.bestStreak = this.currentStreak;
        } else {
            this.currentStreak = 0;
        }

        this._updateRunningScore();
    }

    _updateRunningScore() {
        if (this.weightedTotal === 0) return;
        const pct = Math.round((this.weightedMatched / this.weightedTotal) * 100);
        document.getElementById('score-pct').textContent = pct + '%';
    }

    /**
     * Called 500ms after a line advances. Re-runs word matching against the
     * latest transcript snapshot so that speech-recognition finals that arrived
     * after the line change (the last-word timing race) can still be captured.
     * Any newly-matched words are lit green before scoring.
     */
    _lateScoreLine(lineIdx, lineWords, matchedSet, lineStartWordCount, lineHadAsrEvent, vadMatchedSet, asrConfirmedSet) {
        if (lineWords.length === 0) return;

        const spokenNow = normalizeWords(this.transcript);
        // Intentionally retains the -4 lookback (unlike _collectMatches which uses a
        // strict fence). This method runs 800ms after line change, so it needs slack
        // to catch late-arriving recognition finals from the transition boundary.
        const startOff  = Math.max(0, lineStartWordCount - 4);
        let   spokenIdx = startOff;

        const lateWordTimings = this.allWordTimings[lineIdx];
        for (let li = 0; li < lineWords.length; li++) {
            if (matchedSet.has(li)) { spokenIdx++; continue; }
            const target = lineWords[li];
            const targetPhonetic = lateWordTimings && lateWordTimings[li] ? lateWordTimings[li].phonetic : undefined;
            for (let si = spokenIdx; si < Math.min(spokenIdx + 20, spokenNow.length); si++) {
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
                    // If the next target word is the same, allow reusing this spoken position
                    var nextTarget = (li + 1 < lineWords.length) ? lineWords[li + 1] : null;
                    if (nextTarget !== target) {
                        spokenIdx = si + 1;
                    }
                    // Light the span — this word just arrived late
                    const allLines = lyricsScroll.querySelectorAll('.lyric-line');
                    const lineEl   = allLines[lineIdx];
                    if (lineEl) {
                        const span = lineEl.querySelectorAll('.word-span')[li];
                        if (span) {
                            span.classList.remove('missed');
                            span.classList.add(result.score >= 0.75 ? 'matched' : 'matched-partial');
                        }
                    }
                    break;
                }
            }
        }

        this._scoreLine(lineIdx, lineWords, matchedSet, lineHadAsrEvent, vadMatchedSet, asrConfirmedSet);
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
                songDurationMs:   (audio && isFinite(audio.duration)) ? Math.round(audio.duration * 1000) : null,
                lrcLines:         lyrics.length,
                whisperAvailable: null,   // updated at download time when Whisper state is known
                browserLang:      navigator.language || 'unknown',
                startedAt:        new Date().toISOString(),
                gameVersion:      '1.0'
            },
            asr:         [],
            matches:     [],
            promotions:  [],   // VAD→ASR upgrade events (both browser SR and Whisper paths)
            transitions: []
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
    _logTransition(fromIdx, toIdx, trigger, fromText, matchedWords, totalWords, missedWords, lineStartAudioTime) {
        if (!this._telemetry) return;
        try {
            var tempoClass = 'medium';
            if (fromIdx >= 0 && this.allWordTimings[fromIdx]) {
                tempoClass = this.allWordTimings[fromIdx].vadTempoClass || 'medium';
            }
            var nowAudio   = (audio && isFinite(audio.currentTime)) ? audio.currentTime : 0;
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
            });
        } catch (e) { /* telemetry must never crash the game */ }
    }

    /**
     * Serialise the telemetry log to JSON and trigger a browser download.
     * Falls back to console.warn if the blob URL fails.
     */
    _downloadTelemetry() {
        if (!this._telemetry) return;
        try {
            // Fill in songDurationMs now if audio is ready and it was null at startGame
            if (!this._telemetry.meta.songDurationMs && audio && isFinite(audio.duration)) {
                this._telemetry.meta.songDurationMs = Math.round(audio.duration * 1000);
            }
            // Fill in whisperAvailable now that async setup has completed
            if (this._telemetry.meta.whisperAvailable === null) {
                this._telemetry.meta.whisperAvailable = !!(this._whisperStream);
            }
            // Richer Whisper observability fields (supplement, not replace, whisperAvailable)
            this._telemetry.meta.whisperStatusAtStart  = this._whisperServerStatus ? Object.assign({}, this._whisperServerStatus) : null;
            this._telemetry.meta.whisperStatusFinal    = { state: this._whisperServerStatus ? this._whisperServerStatus.state : 'unknown', reason: this._whisperServerStatus ? this._whisperServerStatus.reason : null };
            this._telemetry.meta.whisperTrackStatus    = this._whisperTrackStatus ? Object.assign({}, this._whisperTrackStatus) : null;
            this._telemetry.meta.whisperChunkCounters  = {
                dispatched:          this._chunksDispatched          || 0,
                succeeded:           this._chunksSucceeded           || 0,
                failed503:           this._chunksFailed503           || 0,
                failed500:           this._chunksFailed500           || 0,
                failedNetwork:       this._chunksFailedNetwork       || 0,
                droppedWhileLoading: this._chunksDroppedWhileLoading || 0,
            };
            this._telemetry.meta.whisperResponses          = this._whisperResponses          || 0;
            this._telemetry.meta.whisperResponsesWithWords = this._whisperResponsesWithWords  || 0;
            this._telemetry.meta.whisperWordsTotal         = this._whisperWordsTotal          || 0;
            var json = JSON.stringify(this._telemetry, null, 2);
            var ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            var name = 'karaokee-telemetry-' + ts + '.json';
            var blob = new Blob([json], { type: 'application/json' });
            var url  = URL.createObjectURL(blob);
            var a    = document.createElement('a');
            a.href     = url;
            a.download = name;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            console.log('[Telemetry] Downloaded:', name,
                '|', this._telemetry.asr.length, 'asr,',
                this._telemetry.matches.length, 'matches,',
                this._telemetry.transitions.length, 'transitions');
        } catch (e) {
            console.warn('[Telemetry] Download failed — raw JSON below:', e);
            console.warn(JSON.stringify(this._telemetry, null, 2));
        }
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

        const finalWords = normalizeWords(this.transcript);
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
        // Whisper server + track state
        const wSrv   = (this._whisperServerStatus && this._whisperServerStatus.state) || 'unknown';
        const wTrk   = (this._whisperTrackStatus  && this._whisperTrackStatus.state)  || 'idle';
        const wDisp  = this._chunksDispatched          || 0;
        const wOk    = this._chunksSucceeded           || 0;
        const w503   = this._chunksFailed503           || 0;
        const w500   = this._chunksFailed500           || 0;
        const wNet   = this._chunksFailedNetwork       || 0;
        const wDrop  = this._chunksDroppedWhileLoading || 0;
        html += `<div class="dbg-row"><span class="dbg-label">Whisp </span>srv:${wSrv} trk:${wTrk} | sent:${wDisp} ok:${wOk} 503:${w503} 500:${w500} net:${wNet} drop:${wDrop}</div>`;

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
        if (!this.active || this.totalWords === 0) return;
        const pct = Math.round((this.weightedMatched / this.weightedTotal) * 100);
        document.getElementById('modalScore').textContent = pct + '%';
        document.getElementById('modalWords').textContent = `${this.matchedWords}/${this.totalWords}`;
        document.getElementById('modalLines').textContent = `${this.perfectLines}/${this.linesScored}`;
        document.getElementById('modalStreak').textContent = this.bestStreak;
        document.getElementById('lrc-offset-control').style.display = 'none';
        document.getElementById('gameModal').style.display = 'flex';
    }
}

const gameMode = new GameMode();

// Load song data from session storage
const songData = JSON.parse(sessionStorage.getItem('songData') || 'null');
if (!songData) {
    window.location.href = '/';
}

// Cache-bust audio src so the browser re-fetches on every page load
audio.src = '/audio?t=' + Date.now();
audio.load();

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
}

function updateLyrics() {
    if (lyrics.length === 0) return;

    const t = audio.currentTime - (gameMode ? gameMode.lrcOffset : 0);
    let idx = -1;
    for (let i = 0; i < lyrics.length; i++) {
        if (lyrics[i].time <= t) idx = i;
        else break;
    }

    // Update hot word tracking every poll even if line hasn't changed
    if (gameMode.active) gameMode.updateHotWord();

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
    if (audio.paused) {
        audio.play();
        playBtn.textContent = '⏸';
        if (gameMode.active) gameMode.resume();
    } else {
        audio.pause();
        playBtn.textContent = '▶';
        if (gameMode.active) gameMode.suspend();
    }
}

// Skip ±10s
function skipBack() {
    audio.currentTime = Math.max(0, audio.currentTime - 10);
    if (gameMode.active) gameMode.onSeek();
}
function skipFwd() {
    audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 10);
    if (gameMode.active) gameMode.onSeek();
}

// Seek bar
audio.addEventListener('timeupdate', () => {
    if (!audio.duration) return;
    seekBar.value = (audio.currentTime / audio.duration) * 100;
    timeDisplay.textContent = `${fmt(audio.currentTime)} / ${fmt(audio.duration)}`;
});

seekBar.addEventListener('input', () => {
    if (audio.duration) {
        audio.currentTime = (seekBar.value / 100) * audio.duration;
        if (gameMode.active) gameMode.onSeek();
    }
});

// Volume
volumeBar.addEventListener('input', () => { audio.volume = volumeBar.value; });

// LRC offset buttons
function _updateOffsetDisplay() {
    document.getElementById('offsetDisplay').textContent =
        (gameMode ? gameMode.lrcOffset : 0).toFixed(1) + 's';
}

document.getElementById('offsetMinus').addEventListener('click', function() {
    if (!gameMode) return;
    gameMode.lrcOffset = Math.max(-10, gameMode.lrcOffset - 0.5);
    localStorage.setItem('lrcOffset_' + _songKey(), gameMode.lrcOffset);
    _updateOffsetDisplay();
});

document.getElementById('offsetPlus').addEventListener('click', function() {
    if (!gameMode) return;
    gameMode.lrcOffset = Math.min(10, gameMode.lrcOffset + 0.5);
    localStorage.setItem('lrcOffset_' + _songKey(), gameMode.lrcOffset);
    _updateOffsetDisplay();
});

// Debug HUD — press D to toggle (works any time, not just in Game Mode)
document.addEventListener('keydown', (e) => {
    if ((e.key === 'd' || e.key === 'D') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        window._kDebug = !window._kDebug;
        const hud = document.getElementById('debug-hud');
        if (hud) hud.style.display = window._kDebug ? 'block' : 'none';
        if (window._kDebug) gameMode._renderDebugHud();
        console.log('[DEBUG HUD]', window._kDebug ? 'ON — start Game Mode and rap to see events' : 'OFF');
    }
});

// Format seconds as m:ss
function fmt(s) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
}

// Suppress autoplay while loading overlay is active
let overlayDismissed = false;
let prepTimer = null;

// Auto-play when audio is ready (only after overlay dismisses)
audio.addEventListener('canplay', () => {
    if (overlayDismissed) {
        audio.play().then(() => { playBtn.textContent = '⏸'; }).catch(() => {});
    }
});

audio.addEventListener('ended', function() {
    if (gameMode.active) {
        // Finalize any active prevLine overlay
        if (gameMode.prevLine) {
            setTimeout(function() { gameMode._finalizePrevLine(); }, 500);
        }
        // Score the final line
        if (gameMode.activeLineIdx >= 0 && gameMode.lineWords.length > 0) {
            var _lastLineIdx   = gameMode.activeLineIdx;
            var _lastLineWords = gameMode.lineWords.slice();
            var _lastLineStart = gameMode.lineStartWordCount;
            var _lastMatched   = new Map(gameMode.matchedSet);
            var _lastHadAsr    = gameMode.lineHadAsrEvent;
            var _lastVadMatched = new Map(gameMode.vadMatchedSet);
            var _lastAsrConfirmed = new Set(gameMode.asrConfirmedSet);
            setTimeout(function() {
                gameMode._lateScoreLine(
                    _lastLineIdx, _lastLineWords, _lastMatched, _lastLineStart, _lastHadAsr,
                    _lastVadMatched, _lastAsrConfirmed
                );
            }, 800);
        }
        if (window._kDebug) gameMode._downloadTelemetry();
        setTimeout(function() { gameMode.showEndModal(); }, 1500);
    }
});

// --- Loading overlay ---

function initPrepOverlay() {
    var sd = JSON.parse(sessionStorage.getItem('songData') || 'null');
    if (sd) {
        document.getElementById('prepSongTitle').textContent =
            sd.artist + ' \u2014 ' + sd.title;
    }
    // Vocal separation disabled — skip overlay immediately.
    // To re-enable: replace skipPrep() with pollPrep() and restore the timer block.
    skipPrep();
    // --- re-enable block start ---
    // var startTime = Date.now();
    // prepTimer = setInterval(function() {
    //     var elapsed = Math.floor((Date.now() - startTime) / 1000);
    //     var m = Math.floor(elapsed / 60);
    //     var s = (elapsed % 60).toString().padStart(2, '0');
    //     var el = document.getElementById('prepStatus');
    //     if (el) el.textContent = 'Preparing audio\u2026 (' + m + ':' + s + ')';
    // }, 1000);
    // pollPrep();
    // --- re-enable block end ---
}

function pollPrep() {
    fetch('/separate-status')
        .then(function(r) { return r.json(); })
        .then(function(data) {
            if (data.status === 'done') {
                finishPrep(true);
            } else if (data.status === 'error') {
                finishPrep(false);
            } else {
                setTimeout(pollPrep, 2000);
            }
        })
        .catch(function() { setTimeout(pollPrep, 2000); });
}

function finishPrep(success) {
    clearInterval(prepTimer);
    if (success) {
        instrumentalReady = true;
    }
    overlayDismissed = true;
    var overlay = document.getElementById('prepOverlay');
    overlay.style.opacity = '0';
    setTimeout(function() {
        overlay.style.display = 'none';
        audio.play().then(function() { playBtn.textContent = '\u23F8'; }).catch(function() {});
    }, 400);
}

function skipPrep() {
    clearInterval(prepTimer);
    overlayDismissed = true;
    document.getElementById('prepOverlay').style.display = 'none';
    audio.play().then(function() { playBtn.textContent = '\u23F8'; }).catch(function() {});
}

initPrepOverlay();

// Vocal removal toggle
let instrumentalReady = false;
let usingInstrumental = false;
const vocalBtn = document.getElementById('vocalBtn');

function toggleVocals() {
    if (usingInstrumental) {
        // Switch back to full mix
        const pos = audio.currentTime;
        audio.src = '/audio?t=' + Date.now();
        audio.load();
        audio.addEventListener('canplay', () => {
            audio.currentTime = pos;
            audio.play().catch(() => {});
        }, { once: true });
        usingInstrumental = false;
        vocalBtn.textContent = '🎤 Remove Vocals';
        return;
    }

    if (instrumentalReady) {
        // Already processed — just switch
        switchToInstrumental();
        return;
    }

    // Start processing
    vocalBtn.textContent = '⏳ Processing...';
    vocalBtn.disabled = true;

    fetch('/separate', { method: 'POST' })
        .then(() => pollSeparation())
        .catch(() => {
            vocalBtn.textContent = '🎤 Remove Vocals';
            vocalBtn.disabled = false;
        });
}

function pollSeparation() {
    fetch('/separate-status')
        .then(r => r.json())
        .then(data => {
            if (data.status === 'done') {
                instrumentalReady = true;
                switchToInstrumental();
            } else if (data.status === 'error') {
                vocalBtn.textContent = '❌ Failed';
                vocalBtn.disabled = false;
            } else {
                setTimeout(pollSeparation, 2000);
            }
        });
}

function switchToInstrumental() {
    const pos = audio.currentTime;
    audio.src = '/instrumental?t=' + Date.now();
    audio.load();
    audio.addEventListener('canplay', () => {
        audio.currentTime = pos;
        audio.play().catch(() => {});
    }, { once: true });
    usingInstrumental = true;
    vocalBtn.textContent = '🎵 Full Mix';
    vocalBtn.disabled = false;
}

function toggleGameMode() {
    if (lyrics.length === 0) {
        alert('No lyrics available for this song \u2014 game mode requires synced lyrics.');
        return;
    }
    // Vocal separation disabled — removed instrumentalReady guard and auto-switch.
    // To re-enable: restore the two blocks marked below.
    if (gameMode.active) {
        gameMode.stop();
    } else {
        // --- re-enable block start (auto-switch to instrumental) ---
        // if (!instrumentalReady) {
        //     alert('Vocal separation is still processing. Please wait or click Skip.');
        //     return;
        // }
        // if (!usingInstrumental) { toggleVocals(); }
        // --- re-enable block end ---
        gameMode.start();
    }
}

function replayGame() {
    document.getElementById('gameModal').style.display = 'none';
    gameMode.stop();  // reset active flag so start() doesn't no-op
    audio.currentTime = 0;
    audio.play().then(() => { playBtn.textContent = '⏸'; }).catch(() => {});
    gameMode.start();
}
