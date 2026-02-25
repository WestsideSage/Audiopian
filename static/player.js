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
};

function normalizeWord(w) {
    return w.toLowerCase().replace(/[''`,.!?;:\-"]/g, '').trim();
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

class GameMode {
    constructor() {
        this.active       = false;
        this.recognition  = null;
        this.activeLineIdx = -1;

        // Current line tracking
        this.lineWords    = [];   // normalized words for active line
        this.matchedSet   = new Set(); // indices of matched words in lineWords
        this.transcript   = '';   // accumulated transcript for current line

        // Scoring
        this.totalWords   = 0;
        this.matchedWords = 0;
        this.linesScored  = 0;
        this.perfectLines = 0;
        this.currentStreak = 0;
        this.bestStreak   = 0;
    }

    start() {
        if (this.active) return;
        this.active = true;
        this.activeLineIdx = -1;
        this.lineWords = [];
        this.matchedSet = new Set();
        this.transcript = '';
        this.totalWords = 0;
        this.matchedWords = 0;
        this.linesScored = 0;
        this.perfectLines = 0;
        this.currentStreak = 0;
        this.bestStreak = 0;

        renderLyricsGameMode();
        this._setupRecognition();

        document.getElementById('score-display').style.display = 'flex';
        document.getElementById('score-pct').textContent = '0%';
        document.getElementById('gameBtn').classList.add('active');
    }

    stop() {
        if (!this.active) return;
        this.active = false;
        if (this.recognition) {
            this.recognition.onend = null;
            this.recognition.stop();
            this.recognition = null;
        }
        renderLyrics(); // restore normal lyric rendering
        document.getElementById('score-display').style.display = 'none';
        document.getElementById('gameBtn').classList.remove('active');
    }

    _setupRecognition() {
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

        this.recognition.onresult = (e) => {
            let interim = '';
            let final = '';
            for (let i = e.resultIndex; i < e.results.length; i++) {
                if (e.results[i].isFinal) {
                    final += e.results[i][0].transcript + ' ';
                } else {
                    interim += e.results[i][0].transcript + ' ';
                }
            }
            if (final) this.transcript += final;
            this._matchTranscript(this.transcript + interim);
        };

        // Auto-restart so recognition doesn't stop on silence
        this.recognition.onend = () => {
            if (this.active) this.recognition.start();
        };

        this.recognition.onerror = (e) => {
            if (e.error === 'not-allowed') {
                alert('Microphone access denied. Enable mic permission and try again.');
                this.stop();
            }
        };

        this.recognition.start();
    }

    setActiveLine(lineIdx) {
        // Score the outgoing line before switching
        if (this.activeLineIdx >= 0 && this.lineWords.length > 0) {
            this._scoreLine();
        }

        this.activeLineIdx = lineIdx;
        this.transcript = '';
        this.matchedSet = new Set();

        if (lineIdx < 0 || lineIdx >= lyrics.length) {
            this.lineWords = [];
            return;
        }

        const lineText = lyrics[lineIdx].text.trim();
        // Skip empty lines and music notation lines
        if (!lineText || lineText === '♪' || lineText === '♫') {
            this.lineWords = [];
            return;
        }

        const rawWords = lineText.split(' ');
        this.lineWords = rawWords.map(w => {
            const nw = normalizeWord(w);
            return expandContractions([nw]).join(' ');
        });

        // Reset spans to grey for new active line
        const lines = lyricsScroll.querySelectorAll('.lyric-line');
        if (lines[lineIdx]) {
            lines[lineIdx].querySelectorAll('.word-span').forEach(s => {
                s.classList.remove('matched', 'missed');
            });
        }
    }

    _matchTranscript(transcript) {
        if (this.lineWords.length === 0) return;

        const spokenRaw = normalizeWords(transcript);
        const spoken = expandContractions(spokenRaw);

        const newMatched = new Set();
        let spokenIdx = 0;

        for (let li = 0; li < this.lineWords.length; li++) {
            const target = this.lineWords[li];
            // Look ahead up to 3 positions for cadence drift
            const window = 3;
            for (let si = spokenIdx; si < Math.min(spokenIdx + window, spoken.length); si++) {
                if (spoken[si] === target) {
                    newMatched.add(li);
                    spokenIdx = si + 1;
                    break;
                }
            }
        }

        this.matchedSet = newMatched;
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

    _scoreLine() {
        const total = this.lineWords.length;
        if (total === 0) return;

        const matched = this.matchedSet.size;

        // Mark unmatched spans as red
        const lines = lyricsScroll.querySelectorAll('.lyric-line');
        const lineEl = lines[this.activeLineIdx];
        if (lineEl) {
            lineEl.querySelectorAll('.word-span').forEach((span, wi) => {
                if (!this.matchedSet.has(wi)) span.classList.add('missed');
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

// Format seconds as m:ss
function fmt(s) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
}

// Auto-play when audio is ready
audio.addEventListener('canplay', () => {
    audio.play().then(() => { playBtn.textContent = '⏸'; }).catch(() => {});
});

audio.addEventListener('ended', () => {
    if (gameMode.active) {
        // Score the final line
        if (gameMode.activeLineIdx >= 0 && gameMode.lineWords.length > 0) {
            gameMode._scoreLine();
        }
        setTimeout(() => gameMode.showEndModal(), 600);
    }
});

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
        alert('No lyrics available for this song — game mode requires synced lyrics.');
        return;
    }
    if (gameMode.active) {
        gameMode.stop();
    } else {
        // Auto-enable vocal removal for cleaner mic input
        if (!usingInstrumental) {
            toggleVocals();
        }
        gameMode.start();
    }
}

function replayGame() {
    document.getElementById('gameModal').style.display = 'none';
    audio.currentTime = 0;
    audio.play().then(() => { playBtn.textContent = '⏸'; }).catch(() => {});
    gameMode.start();
}
