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
