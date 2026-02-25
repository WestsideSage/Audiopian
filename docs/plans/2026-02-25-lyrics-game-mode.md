# Lyrics Game Mode Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a game mode to the karaoke player that scores the user's speech against synced lyrics using the browser's Web Speech API.

**Architecture:** Frontend-only. A `GameMode` class in `player.js` runs alongside the existing playback loop. Lyrics re-render as word `<span>` elements when game mode activates; the speech transcript is matched against the active line's words in real time, coloring spans green (matched) or red (missed).

**Tech Stack:** Vanilla JS, Web Speech API (`SpeechRecognition`), existing Flask backend (no changes needed)

---

### Task 1: Add HTML structure for game mode

**Files:**
- Modify: `static/player.html`

**Step 1: Add score display to the player header**

In `player.html`, find the `.player-header` div:
```html
<div class="player-header">
    <button class="back-btn ctrl-btn" onclick="window.location.href='/'">&#8592; Back</button>
    <div class="song-title" id="song-title">Loading...</div>
</div>
```

Replace with:
```html
<div class="player-header">
    <button class="back-btn ctrl-btn" onclick="window.location.href='/'">&#8592; Back</button>
    <div class="song-title" id="song-title">Loading...</div>
    <div class="score-display" id="score-display" style="display:none">Score: <span id="score-pct">0%</span></div>
</div>
```

**Step 2: Add Game button to controls bar**

In `player.html`, find the controls div. Add the game button as the first button (before `vocalBtn`):
```html
<button class="ctrl-btn game-btn" id="gameBtn" onclick="toggleGameMode()">🎮 Game</button>
```

So the controls line becomes:
```html
<div class="controls">
    <button class="ctrl-btn game-btn" id="gameBtn" onclick="toggleGameMode()">🎮 Game</button>
    <button class="ctrl-btn" id="vocalBtn" onclick="toggleVocals()">🎤 Remove Vocals</button>
    <button class="ctrl-btn" id="skipBackBtn" onclick="skipBack()">⏮</button>
    <button class="ctrl-btn" id="playBtn" onclick="togglePlay()">▶</button>
    <button class="ctrl-btn" id="skipFwdBtn" onclick="skipFwd()">⏭</button>
    <input type="range" id="seek" min="0" max="100" value="0" step="0.1">
    <div id="time-display">0:00 / 0:00</div>
    <span style="font-size:0.8rem;color:#aaa">🔊</span>
    <input type="range" id="volume" min="0" max="1" step="0.05" value="1">
</div>
```

**Step 3: Add end-of-song modal**

Before the closing `</body>` tag (after the `<audio>` element), add:
```html
<div class="game-modal" id="gameModal" style="display:none">
    <div class="game-modal-box">
        <div class="game-modal-title">🎤 Final Score</div>
        <div class="game-modal-score" id="modalScore">0%</div>
        <div class="game-modal-stats">
            <div>Words correct: <span id="modalWords">0/0</span></div>
            <div>Lines perfect: <span id="modalLines">0/0</span></div>
            <div>Best streak: <span id="modalStreak">0</span> lines</div>
        </div>
        <div class="game-modal-actions">
            <button class="ctrl-btn" onclick="replayGame()">Play Again</button>
            <button class="ctrl-btn" onclick="window.location.href='/'">Back</button>
        </div>
    </div>
</div>
```

**Step 4: Manually verify HTML renders without JS errors**

Open the player page in browser. Confirm:
- 🎮 Game button appears in controls
- No JS errors in console (modal is hidden, score display is hidden)

**Step 5: Commit**

```bash
git add static/player.html
git commit -m "feat: add game mode HTML structure (button, score display, modal)"
```

---

### Task 2: Add CSS for game mode

**Files:**
- Modify: `static/player.html` (inline styles section at top)

**Step 1: Add word span styles**

In the `<style>` block inside `player.html`, append:

```css
/* Game mode word spans */
.word-span {
    display: inline-block;
    color: #555;
    transition: color 0.15s;
    cursor: default;
}

.word-span.matched {
    color: #00e676;
}

.word-span.missed {
    color: #ff5252;
}

/* Game button active state */
.game-btn.active {
    background: #7c4dff;
    box-shadow: 0 0 8px #7c4dff88;
}

/* Running score in header */
.score-display {
    margin-left: auto;
    font-size: 1rem;
    color: #00e676;
    font-weight: 600;
}

/* Per-line score flash */
.line-score-flash {
    position: absolute;
    right: 24px;
    font-size: 0.85rem;
    color: #00e676;
    pointer-events: none;
    animation: fadeOut 1.2s ease forwards;
}

@keyframes fadeOut {
    0%   { opacity: 1; transform: translateY(0); }
    100% { opacity: 0; transform: translateY(-16px); }
}

/* End-of-song modal */
.game-modal {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.75);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
}

.game-modal-box {
    background: #1a1a2e;
    border: 1px solid #2a2a4a;
    border-radius: 12px;
    padding: 40px;
    text-align: center;
    min-width: 280px;
}

.game-modal-title {
    font-size: 1.3rem;
    color: #e040fb;
    margin-bottom: 16px;
}

.game-modal-score {
    font-size: 3rem;
    font-weight: 700;
    color: #00e676;
    margin-bottom: 20px;
}

.game-modal-stats {
    color: #aaa;
    font-size: 0.95rem;
    line-height: 2;
    margin-bottom: 28px;
}

.game-modal-actions {
    display: flex;
    gap: 12px;
    justify-content: center;
}
```

**Step 2: Verify styles load**

Reload the player. No visual change expected yet (all game elements hidden), but confirm no CSS errors.

**Step 3: Commit**

```bash
git add static/player.html
git commit -m "feat: add game mode CSS (word spans, score display, modal)"
```

---

### Task 3: Add word normalization utilities to player.js

**Files:**
- Modify: `static/player.js`

**Step 1: Add normalization helpers at the top of player.js**

After the existing variable declarations (after `let currentLineIndex = -1;`), add:

```javascript
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
```

**Step 2: Verify no errors**

Reload the player page. Open browser console. Confirm no errors.

**Step 3: Commit**

```bash
git add static/player.js
git commit -m "feat: add word normalization utilities for game mode"
```

---

### Task 4: Implement the GameMode class — state + recognition

**Files:**
- Modify: `static/player.js`

**Step 1: Add GameMode class after the normalization utilities**

```javascript
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
}

const gameMode = new GameMode();
```

**Step 2: Verify no errors**

Reload player page. Check console — no errors expected.

**Step 3: Commit**

```bash
git add static/player.js
git commit -m "feat: add GameMode class with recognition setup"
```

---

### Task 5: Implement game mode lyric rendering

**Files:**
- Modify: `static/player.js`

**Step 1: Add renderLyricsGameMode() function**

After the existing `renderLyrics()` function, add:

```javascript
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
```

**Step 2: Add setActiveLine() to GameMode class**

Inside the `GameMode` class, before the closing `}`, add:

```javascript
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

        const rawWords = lyrics[lineIdx].text.split(' ');
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
```

**Step 3: Verify rendering**

In the browser console, test manually:
```javascript
// After a song is loaded:
renderLyricsGameMode();
```
Confirm the lyrics show as normal (word spans invisible without game mode active).

**Step 4: Commit**

```bash
git add static/player.js
git commit -m "feat: add game mode lyric rendering with word spans"
```

---

### Task 6: Implement word matching and span highlighting

**Files:**
- Modify: `static/player.js`

**Step 1: Add _matchTranscript() to GameMode class**

Inside the `GameMode` class, add:

```javascript
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
```

**Step 2: Verify matching in browser console**

After loading a song and calling `renderLyricsGameMode()`, test:
```javascript
gameMode.activeLineIdx = 0;
gameMode.lineWords = normalizeWords(lyrics[0].text).map(w => expandContractions([w]).join(' '));
gameMode._matchTranscript("is this the real life");
// Spans on line 0 should go green
```

**Step 3: Commit**

```bash
git add static/player.js
git commit -m "feat: add transcript matching and word span highlighting"
```

---

### Task 7: Implement line scoring and running score display

**Files:**
- Modify: `static/player.js`

**Step 1: Add _scoreLine() and _updateRunningScore() to GameMode class**

Inside the `GameMode` class, add:

```javascript
    _scoreLine() {
        const total = this.lineWords.length;
        if (total === 0) return;

        const matched = this.matchedSet.size;
        const missed = total - matched;

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
```

**Step 2: Commit**

```bash
git add static/player.js
git commit -m "feat: add line scoring, running score, and end modal logic"
```

---

### Task 8: Hook game mode into the playback loop

**Files:**
- Modify: `static/player.js`

**Step 1: Modify updateLyrics() to notify GameMode on line change**

Find the existing `updateLyrics()` function. After the `if (idx === currentLineIndex) return;` and `currentLineIndex = idx;` lines, add a game mode notification:

```javascript
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
```

**Step 2: Add end-of-song handler**

Find the `audio.addEventListener('canplay', ...)` block. After it, add:

```javascript
audio.addEventListener('ended', () => {
    if (gameMode.active) {
        // Score the final line
        if (gameMode.activeLineIdx >= 0 && gameMode.lineWords.length > 0) {
            gameMode._scoreLine();
        }
        setTimeout(() => gameMode.showEndModal(), 600);
    }
});
```

**Step 3: Add toggleGameMode() and replayGame() functions**

After the existing `toggleVocals()` related functions, add:

```javascript
function toggleGameMode() {
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
```

**Step 4: Verify end-to-end in browser**

1. Load a song with lyrics
2. Click 🎮 Game — confirm mic permission prompt appears, vocal removal starts, button glows
3. Press play — confirm lyric words appear as spans
4. Speak some lyrics into the mic — confirm words go green in real time
5. Let the line pass — confirm unspoken words go red, score flashes, header % updates
6. Let song finish — confirm end modal appears with stats

**Step 5: Commit**

```bash
git add static/player.js
git commit -m "feat: wire game mode into playback loop and add toggle/replay"
```

---

### Task 9: Handle edge cases

**Files:**
- Modify: `static/player.js`

**Step 1: Skip empty/instrumental lines in scoring**

In `GameMode.setActiveLine()`, after setting `this.lineWords`, add a check:

```javascript
    setActiveLine(lineIdx) {
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

        const lines = lyricsScroll.querySelectorAll('.lyric-line');
        if (lines[lineIdx]) {
            lines[lineIdx].querySelectorAll('.word-span').forEach(s => {
                s.classList.remove('matched', 'missed');
            });
        }
    }
```

**Step 2: Dismiss modal on Back button**

The Back button in the modal already calls `window.location.href='/'`, which navigates away — no extra handling needed.

**Step 3: Guard toggleGameMode when no lyrics loaded**

In `toggleGameMode()`, add a guard:

```javascript
function toggleGameMode() {
    if (lyrics.length === 0) {
        alert('No lyrics available for this song — game mode requires synced lyrics.');
        return;
    }
    if (gameMode.active) {
        gameMode.stop();
    } else {
        if (!usingInstrumental) {
            toggleVocals();
        }
        gameMode.start();
    }
}
```

**Step 4: Verify edge cases**

- Load a song without lyrics → clicking 🎮 Game shows alert, does not activate
- Play a song with instrumental gaps (no lyric lines) → score doesn't count those gaps
- Toggle game mode off mid-song → lyrics revert to normal view, mic stops

**Step 5: Commit**

```bash
git add static/player.js
git commit -m "feat: handle edge cases (empty lines, no lyrics, mid-song toggle)"
```

---

## Manual Test Checklist

Before considering this complete:

- [ ] 🎮 Game button visible in controls
- [ ] Clicking 🎮 triggers mic permission prompt (Chrome only)
- [ ] Vocal removal activates automatically
- [ ] Lyrics re-render as word spans when game mode starts
- [ ] Speaking correct words turns them green in real time
- [ ] When line advances, unspoken words turn red
- [ ] Per-line score flashes briefly (`+N/M`)
- [ ] Running score % updates in header after each line
- [ ] Song ends → modal appears with final %, words, lines, streak
- [ ] Play Again resets and restarts
- [ ] Toggling game mode off reverts to normal lyric view
- [ ] No-lyrics guard works (alert shown)
- [ ] No JS errors in browser console throughout

---

## Out of Scope (not in this plan)

- Memory mode (lyrics hidden — future v2)
- Score persistence / leaderboard
- Mobile support
