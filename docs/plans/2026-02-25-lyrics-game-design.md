# Karaokee — Lyrics Game Mode Design
**Date:** 2026-02-25

## Overview

Add a game mode to the karaoke player where the user sings/raps along and the app scores them based on how accurately their spoken words match the lyrics. Uses the browser's built-in Web Speech API for real-time speech recognition — no backend changes required.

Primary use case: songs the user can already recite nearly word-for-word (rap, spoken word). Game provides honest feedback on lyric accuracy.

---

## Architecture

**Scope:** Frontend-only change. No new routes, no new Python dependencies.

**Files changed:**
- `static/player.js` — new `GameMode` class, activated alongside existing playback
- `static/player.html` — "Game" button in controls bar, score display in header
- `static/style.css` — word span states (grey/green/red), score UI, end-of-song modal

**Activation flow:**
1. User clicks "Game Mode" button on player
2. Vocal removal triggers automatically (instrumental track loaded via existing `/separate` + `/instrumental` routes)
3. Browser requests mic via `SpeechRecognition`
4. Lyrics re-render: each word becomes its own `<span>` element
5. Game loop runs alongside existing 100ms `updateLyrics()` poll

The existing lyric sync logic is untouched. Game mode is a layer on top.

---

## UI

### Player in game mode
```
┌─────────────────────────────────────────────────────┐
│  ← Back          Lose Yourself            Score: 87%│
│─────────────────────────────────────────────────────│
│                                                     │
│     his palms are sweaty knees weak arms are heavy  │  ← past line (words colored)
│                                                     │
│  ▶  there's  vomit  on  his  sweater  already       │  ← active line
│     [grey]  [green] [grey] [green]  [grey]  [red]   │
│                                                     │
│     mom's spaghetti                                 │  ← upcoming (grey)
│                                                     │
│─────────────────────────────────────────────────────│
│  🎮 Game  ⏮  ⏸  ⏭  ────────────  2:14/5:26  🔊── │
└─────────────────────────────────────────────────────┘
```

### Word states
| State | Color | Meaning |
|---|---|---|
| Grey | `#555` | Not yet said |
| Green | `#00e676` | Recognized and matched |
| Red | `#ff5252` | Line passed, word missed |

### End-of-song modal
```
┌─────────────────────────────┐
│        🎤 Final Score       │
│                             │
│           87%               │
│                             │
│   Words correct:  142/163   │
│   Lines perfect:  6/18      │
│   Best streak:    4 lines   │
│                             │
│  [ Play Again ]  [ Back ]   │
└─────────────────────────────┘
```

Score displays in the header as a running percentage, updated after each line.

---

## Speech Recognition

**API:** `window.SpeechRecognition` (Chrome) / `window.webkitSpeechRecognition`

**Config:**
- `continuous: true`
- `interimResults: true`
- Auto-restarts on `onend` if game mode still active (API stops after silence)

**Normalization (both transcript and lyric words):**
- Lowercase
- Strip punctuation: `'`, `,`, `.`, `!`, `?`, `-`
- Contraction normalization: `gonna → going to`, `i'm → im`, `wanna → want to`, etc.

**Matching:**
- Order-sensitive within the active line (left to right)
- Window of ±2 words allowed for rap cadence drift
- Interim results used for in-progress green highlighting
- Final results used to confirm matches

---

## Line Lifecycle

1. **Line becomes active** (timestamp fires) → words render as grey `<span>` elements
2. **During active window** → speech transcript compared continuously against line words
3. **Line becomes inactive** (next timestamp fires) → unmatched words turn red; line scored
4. **Line score** = `matched words / total words` — brief "+8/10" flash near the line

Instrumental break lines (empty text or `♪`) are skipped from scoring.

---

## Scoring

- **Running score:** `total matched words / total words passed` — shown as % in header
- **Per-line flash:** `+N/M` appears briefly as each line exits
- **Perfect line streak:** consecutive lines with 100% accuracy, tracked for end screen
- **End modal stats:** final %, words correct, lines perfect, best streak

---

## Out of Scope (v1)

- Memory mode (lyrics hidden, recite from memory) — second mode, added after testing karaoke-along
- Phonetic / sounds-like matching
- Leaderboards or score persistence
- Mobile support
