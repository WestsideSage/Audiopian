const audio = document.getElementById('audio');
const playBtn = document.getElementById('playBtn');
const seekBar = document.getElementById('seek');
const volumeBar = document.getElementById('volume');
const timeDisplay = document.getElementById('time-display');
const lyricsScroll = document.getElementById('lyrics-scroll');
const noLyricsEl = document.getElementById('no-lyrics');

let lyrics = [];
let currentLineIndex = -1;

// --- Game mode utilities ---

const CONTRACTION_MAP = {
    // Original entries
    'gonna':   'going to',
    'wanna':   'want to',
    'gotta':   'got to',
    'kinda':   'kind of',
    'sorta':   'sort of',
    'coulda':  'could have',
    'shoulda': 'should have',
    'woulda':  'would have',
    'ima':     'i am going to',
    'tryna':   'trying to',
    'dunno':   'do not know',
    'ain\'t':  'is not',
    'ain':     'is not',
    'y\'all':  'you all',
    'yall':    'you all',
    // Rap / AAVE slang additions
    'finna':   'fixing to',
    'bouta':   'about to',
    'outta':   'out of',
    'lotta':   'lot of',
    'cmon':    'come on',
    'nah':     'no',
    'bruh':    'brother',
    'bro':     'brother',
    'fam':     'family',
    'fasho':   'for sure',
    'fosho':   'for sure',
    'sho':     'sure',
    'deadass': 'seriously',
    'lowkey':  'low key',
    'highkey': 'high key',
    'ong':     'on god',
    'fr':      'for real',
    'ngl':     'not gonna lie',
    'rn':      'right now',
    'smh':     'shaking my head',
    'aight':   'alright',
    'ight':    'alright',
    'prolly':  'probably',
    'sumn':    'something',
    'sumthin': 'something',
    'nothin':  'nothing',
    'nuthin':  'nothing',
    'cuz':     'because',
    'cus':     'because',
    'wit':     'with',
    'da':      'the',
    'dem':     'them',
    'dey':     'they',
    'dat':     'that',
    'dis':     'this',
    'em':      'them',
    'til':     'until',
    'bout':    'about',
    'ops':     'opposition',
    'lil':     'little',
};

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
function wordsMatch(spoken, target) {
    if (spoken === target) return true;
    const [sp, ss] = doubleMetaphone(spoken);
    const [tp, ts] = doubleMetaphone(target);
    if (sp && tp && (sp === tp || sp === ts || (ss && (ss === tp || ss === ts)))) return true;
    if (Math.abs(spoken.length - target.length) <= 1 && editDistance(spoken, target) <= 1) return true;
    return false;
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
    return w.toLowerCase().replace(/[''`,.!?;:\-"*]/g, '').trim();
}

function normalizeWords(text) {
    return text.split(/\s+/)
        .map(normalizeWord)
        .filter(w => w.length > 0);
}

function expandContractions(words) {
    const out = [];
    for (const w of words) {
        if (CONTRACTION_MAP[w]) {
            out.push(...CONTRACTION_MAP[w].split(' '));
        } else {
            out.push(w);
        }
    }
    return out;
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

        // Compute syllable weights
        var syllables = words.map(function(w) { return estimateSyllables(normalizeWord(w)); });
        var totalSyllables = 0;
        for (var s = 0; s < syllables.length; s++) totalSyllables += syllables[s];
        if (totalSyllables === 0) totalSyllables = 1; // defensive guard

        // Distribute time proportionally by syllable count
        var wordTimings = [];
        var cursor = lineStart;
        for (var wi = 0; wi < words.length; wi++) {
            var wordDuration = (syllables[wi] / totalSyllables) * lineDuration;
            var estimatedTime = cursor;
            wordTimings.push({
                word: normalizeWord(words[wi]),
                estimatedTime: estimatedTime,
                windowStart: estimatedTime + params.windowStart,
                windowEnd: estimatedTime + params.windowEnd
            });
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
        this.matchedSet        = new Set(); // indices of matched words in lineWords
        this.transcript        = '';      // accumulated final transcript (never reset)
        this.lineStartWordCount = 0;      // word count in transcript when current line started
        this.lineStartTranscriptPos = 0;  // transcript word index when current line started (fence)
        this.latestInterim     = '';      // most recent interim, used to anchor fast-song lines

        // Scoring
        this.totalWords   = 0;
        this.matchedWords = 0;
        this.linesScored  = 0;
        this.perfectLines = 0;
        this.currentStreak = 0;
        this.bestStreak   = 0;

        // Recognition watchdog
        this._lastResultTime = 0;
        this._watchdogInterval = null;

        // Whisper Track 2 state
        this._whisperStream = null;
        this._whisperCtx    = null;
        this._whisperNode   = null;
        this.whisperBuffer  = '';

        // Diagnostic
        this._dbBuf = [];

        // Predictive timing state
        this.allWordTimings = [];    // interpolated word timings for all lines
        this.wordTimings    = [];    // word timings for current active line
        this.hotWordIndex   = -1;    // index of word whose time window contains audio.currentTime
        this.isSpeaking     = false; // true when mic energy exceeds threshold
        this._energyThreshold = 0.01; // RMS threshold for voice activity detection
        this.currentParams = getWindowParams('normal'); // adaptive window params for active line

        // Soft boundary: previous line overlay during overlap zone
        this.prevLine = null;  // { lineIdx, lineWords, matchedSet, lineStartWordCount, lineStartTranscriptPos, wordTimings, params, overlapEnd, whisperBuffer }
    }

    start() {
        if (this.active) return;
        this.active = true;
        this.activeLineIdx = -1;
        this.lineWords = [];
        this.matchedSet = new Set();
        this.transcript = '';
        this.lineStartWordCount = 0;
        this.lineStartTranscriptPos = 0;
        this.latestInterim = '';
        this.totalWords = 0;
        this.matchedWords = 0;
        this.linesScored = 0;
        this.perfectLines = 0;
        this.currentStreak = 0;
        this.bestStreak = 0;
        this.whisperBuffer = '';
        this.prevLine = null;
        this._lastResultTime = Date.now();
        this.allWordTimings = interpolateWordTimings(lyrics);
        this.wordTimings = [];
        this.hotWordIndex = -1;
        this.isSpeaking = false;

        renderLyricsGameMode();
        this._setupRecognition();
        this._startWhisperTrack(); // async — Track 2 starts in background

        document.getElementById('score-display').style.display = 'flex';
        document.getElementById('score-pct').textContent = '0%';
        document.getElementById('gameBtn').classList.add('active');
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
            if (finalText) self.transcript += finalText;
            self.latestInterim = interim;

            // HOT-WORD PRIORITY: check predicted word first for instant green
            var hotMatched = self._matchHotWord(self.transcript + interim);
            if (hotMatched) self._updateWordSpans();

            // Match against previous line during overlap zone (Track 1)
            self._matchPrevLine(self.transcript + interim, 'track1');

            // Match primary transcript
            var unionSet = new Set();
            self._collectMatches(self.transcript + interim, unionSet);

            // Union with alternative transcripts from latest result
            var latest = e.results[e.results.length - 1];
            for (var a = 1; a < latest.length; a++) {
                self._collectMatches(self.transcript + latest[a].transcript, unionSet);
            }

            // Sticky: once matched, stay matched. Prevents interim→final regression
            // where a word flashes green then reverts to grey.
            unionSet.forEach(i => self.matchedSet.add(i));
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
                self._debugLog('MATCH', {
                    lineIdx:     self.activeLineIdx,
                    targets:     self.lineWords.slice(),
                    spokenWindow: spokenFull.slice(scanFrom, scanFrom + 20),
                    matchedIdxs: [...unionSet],
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
        try {
            this._whisperStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this._whisperCtx    = new AudioContext({ sampleRate: 16000 });
            await this._whisperCtx.audioWorklet.addModule('/static/audio-processor.js');
            const src  = this._whisperCtx.createMediaStreamSource(this._whisperStream);
            this._whisperNode = new AudioWorkletNode(this._whisperCtx, 'chunk-processor');
            this._whisperNode.port.onmessage = (e) => {
                if (!this.active) return;
                var msg = e.data;
                if (msg && msg.type === 'energy') {
                    // Update voice activity detection flag
                    this.isSpeaking = msg.rms > this._energyThreshold;
                } else if (msg && msg.type === 'chunk') {
                    this._sendChunkToWhisper(msg.data);
                } else if (msg instanceof Float32Array) {
                    // Backward compat: raw Float32Array (shouldn't happen but safe)
                    this._sendChunkToWhisper(msg);
                }
            };
            src.connect(this._whisperNode);
        } catch (err) {
            console.warn('[Whisper track] unavailable — running on Track 1 only:', err.message);
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
        if (this._whisperStream) {
            this._whisperStream.getTracks().forEach(t => t.stop());
            this._whisperStream = null;
        }
    }

    async _sendChunkToWhisper(float32) {
        const wav = encodeWav(float32, 16000);
        try {
            const resp = await fetch('/transcribe', {
                method: 'POST',
                body: wav,
                headers: { 'Content-Type': 'audio/wav' }
            });
            if (!resp.ok) return;
            const { transcript } = await resp.json();
            if (transcript && this.active) {
                this.whisperBuffer = (this.whisperBuffer + ' ' + transcript).trim();
                this._collectMatchesWhisper(this.whisperBuffer);
            }
        } catch (_) { /* fire-and-forget: ignore network errors */ }
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
            this._scoreLine(prev.lineIdx, prev.lineWords, prev.matchedSet);
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
            for (var si = cursor; si < Math.min(cursor + driftWindow, spoken.length); si++) {
                if (wordsMatch(spoken[si], target)) {
                    prev.matchedSet.add(li);
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
        const whisperSet = new Set();
        let spokenIdx = 0;
        var now = audio.currentTime;
        var driftWindow = this.currentParams.driftTrack2;
        for (let li = 0; li < this.lineWords.length; li++) {
            if (li < this.wordTimings.length) {
                if (now < this.wordTimings[li].windowStart) continue;
            }
            const target = this.lineWords[li];
            for (let si = spokenIdx; si < Math.min(spokenIdx + driftWindow, spoken.length); si++) {
                if (wordsMatch(spoken[si], target)) {
                    whisperSet.add(li);
                    spokenIdx = si + 1;
                    break;
                }
            }
        }
        whisperSet.forEach(i => this.matchedSet.add(i));
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
            var overlapDuration = getOverlapDuration(outgoingTempoClass);
            var scoreDelay = getScoreDelay(outgoingTempoClass);

            this.prevLine = {
                lineIdx:                this.activeLineIdx,
                lineWords:              this.lineWords.slice(),
                matchedSet:             new Set(this.matchedSet),
                lineStartWordCount:     this.lineStartWordCount,
                lineStartTranscriptPos: this.lineStartTranscriptPos,
                wordTimings:            this.wordTimings,
                params:                 this.currentParams,
                overlapEnd:             performance.now() + (overlapDuration * 1000),
                whisperBuffer:          this.whisperBuffer,
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
        }

        // --- Set up new line ---
        this.activeLineIdx = lineIdx;
        this.lineStartWordCount = normalizeWords(this.transcript).length;
        this.lineStartTranscriptPos = this.lineStartWordCount;
        this.matchedSet = new Set();
        this.whisperBuffer = '';

        // Load interpolated word timings for this line
        this.wordTimings = (lineIdx >= 0 && lineIdx < this.allWordTimings.length)
            ? this.allWordTimings[lineIdx]
            : [];
        this.hotWordIndex = -1;

        // Load adaptive window params for this line's tempo
        this.currentParams = (this.wordTimings && this.wordTimings.tempoClass)
            ? getWindowParams(this.wordTimings.tempoClass)
            : getWindowParams('normal');

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
        this.lineWords = rawWords.map(function(w) { return normalizeWord(w); });

        // Reset spans to grey for new active line
        var lines = lyricsScroll.querySelectorAll('.lyric-line');
        if (lines[lineIdx]) {
            lines[lineIdx].querySelectorAll('.word-span').forEach(function(s) {
                s.classList.remove('matched', 'missed');
            });
        }
    }

    _collectMatches(transcript, resultSet) {
        if (this.lineWords.length === 0) return;
        var spoken = normalizeWords(transcript);
        var spokenIdx = this.lineStartTranscriptPos;
        var now = audio.currentTime;
        var driftWindow = this.currentParams.driftTrack1;
        for (var li = 0; li < this.lineWords.length; li++) {
            if (li < this.wordTimings.length) {
                if (now < this.wordTimings[li].windowStart) continue;
            }
            var target = this.lineWords[li];
            for (var si = spokenIdx; si < Math.min(spokenIdx + driftWindow, spoken.length); si++) {
                if (wordsMatch(spoken[si], target)) {
                    resultSet.add(li);
                    spokenIdx = si + 1;
                    break;
                }
            }
        }
    }

    _matchTranscript(transcript) {
        var unionSet = new Set();
        this._collectMatches(transcript, unionSet);
        this.matchedSet = unionSet;
        this._updateWordSpans();
    }

    _updateWordSpans() {
        const lines = lyricsScroll.querySelectorAll('.lyric-line');
        const lineEl = lines[this.activeLineIdx];
        if (!lineEl) return;

        const spans = lineEl.querySelectorAll('.word-span');
        spans.forEach((span, wi) => {
            span.classList.remove('matched', 'missed');
            if (this.matchedSet.has(wi)) {
                span.classList.add('matched');
            }
        });
    }

    /**
     * Update hotWordIndex based on current audio time.
     * Called every 100ms from the updateLyrics poll.
     * The hot word is the word whose predicted time window contains
     * the current audio time — matching this word gets priority.
     */
    updateHotWord() {
        if (!this.active || this.wordTimings.length === 0) {
            this.hotWordIndex = -1;
            return;
        }
        var t = audio.currentTime;
        var newHot = -1;
        for (var i = 0; i < this.wordTimings.length; i++) {
            if (this.matchedSet.has(i)) continue; // skip already-green words
            var wt = this.wordTimings[i];
            if (t >= wt.windowStart && t <= wt.windowEnd) {
                newHot = i;
                break;  // first unmatched window wins
            }
        }
        this.hotWordIndex = newHot;
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
        if (this.matchedSet.has(this.hotWordIndex)) return false; // already matched

        var target = this.lineWords[this.hotWordIndex];
        var spoken = normalizeWords(transcript);

        // Fence: only search words spoken since the current line started
        // (within that, only look at recent 10)
        var searchStart = Math.max(this.lineStartTranscriptPos, spoken.length - 10);
        for (var i = searchStart; i < spoken.length; i++) {
            if (wordsMatch(spoken[i], target)) {
                // Energy gate: if not speaking, require exact or phonetic match (not edit-distance)
                if (!this.isSpeaking) {
                    if (spoken[i] !== target) {
                        var sp = doubleMetaphone(spoken[i]);
                        var tp = doubleMetaphone(target);
                        var phonetic = sp[0] && tp[0] && (sp[0] === tp[0] || sp[0] === tp[1] || (sp[1] && (sp[1] === tp[0] || sp[1] === tp[1])));
                        if (!phonetic) continue; // skip edit-distance-only matches when silent
                    }
                }
                this.matchedSet.add(this.hotWordIndex);
                return true;
            }
        }
        return false;
    }

    /**
     * Score an outgoing line. Accepts explicit params so delayed calls can pass
     * a snapshot rather than relying on this.* (which will have advanced by then).
     */
    _scoreLine(lineIdx, lineWords, matchedSet) {
        lineIdx    = (lineIdx    !== undefined) ? lineIdx    : this.activeLineIdx;
        lineWords  = (lineWords  !== undefined) ? lineWords  : this.lineWords;
        matchedSet = (matchedSet !== undefined) ? matchedSet : this.matchedSet;

        const total = lineWords.length;
        if (total === 0) return;

        const matched = matchedSet.size;

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

        this.totalWords   += total;
        this.matchedWords += matched;
        this.linesScored++;

        if (matched === total) {
            this.perfectLines++;
            this.currentStreak++;
            if (this.currentStreak > this.bestStreak) this.bestStreak = this.currentStreak;
        } else {
            this.currentStreak = 0;
        }

        this._updateRunningScore();
    }

    _updateRunningScore() {
        if (this.totalWords === 0) return;
        const pct = Math.round((this.matchedWords / this.totalWords) * 100);
        document.getElementById('score-pct').textContent = pct + '%';
    }

    /**
     * Called 500ms after a line advances. Re-runs word matching against the
     * latest transcript snapshot so that speech-recognition finals that arrived
     * after the line change (the last-word timing race) can still be captured.
     * Any newly-matched words are lit green before scoring.
     */
    _lateScoreLine(lineIdx, lineWords, matchedSet, lineStartWordCount) {
        if (lineWords.length === 0) return;

        const spokenNow = normalizeWords(this.transcript);
        // Intentionally retains the -4 lookback (unlike _collectMatches which uses a
        // strict fence). This method runs 800ms after line change, so it needs slack
        // to catch late-arriving recognition finals from the transition boundary.
        const startOff  = Math.max(0, lineStartWordCount - 4);
        let   spokenIdx = startOff;

        for (let li = 0; li < lineWords.length; li++) {
            if (matchedSet.has(li)) { spokenIdx++; continue; }
            const target = lineWords[li];
            for (let si = spokenIdx; si < Math.min(spokenIdx + 20, spokenNow.length); si++) {
                if (wordsMatch(spokenNow[si], target)) {
                    matchedSet.add(li);
                    spokenIdx = si + 1;
                    // Light the span green — this word just arrived late
                    const allLines = lyricsScroll.querySelectorAll('.lyric-line');
                    const lineEl   = allLines[lineIdx];
                    if (lineEl) {
                        const span = lineEl.querySelectorAll('.word-span')[li];
                        if (span) { span.classList.remove('missed'); span.classList.add('matched'); }
                    }
                    break;
                }
            }
        }

        this._scoreLine(lineIdx, lineWords, matchedSet);
    }

    // ── Diagnostics ───────────────────────────────────────────────────

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
        hud.innerHTML = html;
    }

    showEndModal() {
        if (!this.active || this.totalWords === 0) return;
        const pct = Math.round((this.matchedWords / this.totalWords) * 100);
        document.getElementById('modalScore').textContent = pct + '%';
        document.getElementById('modalWords').textContent = `${this.matchedWords}/${this.totalWords}`;
        document.getElementById('modalLines').textContent = `${this.perfectLines}/${this.linesScored}`;
        document.getElementById('modalStreak').textContent = this.bestStreak;
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

        const words = line.text.split(' ');
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

    const t = audio.currentTime;
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
    } else {
        audio.pause();
        playBtn.textContent = '▶';
    }
}

// Skip ±10s
function skipBack() { audio.currentTime = Math.max(0, audio.currentTime - 10); }
function skipFwd() { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 10); }

// Seek bar
audio.addEventListener('timeupdate', () => {
    if (!audio.duration) return;
    seekBar.value = (audio.currentTime / audio.duration) * 100;
    timeDisplay.textContent = `${fmt(audio.currentTime)} / ${fmt(audio.duration)}`;
});

seekBar.addEventListener('input', () => {
    if (audio.duration) {
        audio.currentTime = (seekBar.value / 100) * audio.duration;
    }
});

// Volume
volumeBar.addEventListener('input', () => { audio.volume = volumeBar.value; });

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
            var _lastMatched   = new Set(gameMode.matchedSet);
            setTimeout(function() {
                gameMode._lateScoreLine(
                    _lastLineIdx, _lastLineWords, _lastMatched, _lastLineStart
                );
            }, 800);
        }
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
    audio.currentTime = 0;
    audio.play().then(() => { playBtn.textContent = '⏸'; }).catch(() => {});
    gameMode.start();
}
