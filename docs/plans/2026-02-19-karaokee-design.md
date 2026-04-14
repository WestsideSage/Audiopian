# Karaokee — Design Document
**Date:** 2026-02-19

## Overview

A personal desktop karaoke app. Paste a YouTube URL, get the audio and synced lyrics automatically, sing along with classic karaoke-style line highlighting.

---

## Architecture

**Stack:**
- Backend: Python + Flask on `localhost:5000`
- Audio: `yt-dlp` extracts audio from YouTube URL, saved to `temp/audio.webm`, served as static file
- Lyrics: [lrclib.net](https://lrclib.net) — free, no API key, LRC timed lyrics searched by artist + title
- Frontend: Plain HTML/CSS/JS served by Flask

**User flow:**
1. Launch via `start.bat` — opens Flask + browser automatically
2. Paste YouTube URL → yt-dlp extracts title/artist metadata and downloads audio
3. lrclib.net fetched using title + artist → returns LRC lyrics
4. User hits Play → browser `<audio>` plays audio, JS syncs lyrics highlighting

---

## UI Layout

### Screen 1 — Song Setup
```
┌─────────────────────────────────────────┐
│           🎤 Karaokee                   │
│                                         │
│  YouTube URL: [_______________________] │
│                                         │
│  Artist: [____________] (auto-filled)   │
│  Title:  [____________] (auto-filled)   │
│                                         │
│         [ Load Song ]                   │
│                                         │
│  Status: "Fetching audio..."            │
└─────────────────────────────────────────┘
```

### Screen 2 — Karaoke Player
```
┌─────────────────────────────────────────┐
│  ← Back          Bohemian Rhapsody      │
│─────────────────────────────────────────│
│                                         │
│     Is this the real life?              │
│     Is this just fantasy?               │
│  ▶  Caught in a landslide,              │  ← current line (highlighted)
│     No escape from reality.             │
│                                         │
│─────────────────────────────────────────│
│  ◀◀  ▶/⏸  ▶▶     0:42 / 5:55  🔊───  │
└─────────────────────────────────────────┘
```

- 3–5 lines visible at once, current line highlighted in bright color
- Lines scroll upward as song progresses
- Controls: play/pause, seek bar, volume

---

## Data Flow & Key Logic

### Loading a song (backend)
1. POST `/load` with YouTube URL
2. Flask calls yt-dlp → downloads `temp/audio.webm`, extracts title + artist
3. Flask calls lrclib.net: `GET https://lrclib.net/api/search?q={title} {artist}`
4. Returns JSON: `{ audioUrl: "/audio", lyrics: [{time: 83.45, text: "Some lyric line"}, ...] }`

### LRC parsing
LRC format: `[01:23.45] Some lyric line`
Parsed into: `[{ time: 83.45, text: "Some lyric line" }, ...]`

### Playback sync (frontend)
- Browser `<audio>` element plays `/audio`
- JS polls `audio.currentTime` every 100ms
- Finds last lyric entry where `time <= currentTime` → highlights that line, scrolls into view

### Error handling
- yt-dlp fails (private/unavailable video) → error shown on setup screen
- lrclib.net returns no results → "Lyrics not found — edit artist/title and retry" with retry button
- Artist/title editable on setup screen to allow manual correction before retry

---

## Project Structure

```
Karaokee/
├── app.py                 # Flask app, all routes
├── lyrics.py              # lrclib.net fetching + LRC parsing
├── downloader.py          # yt-dlp wrapper
├── start.bat              # Double-click launcher
├── requirements.txt       # Flask, yt-dlp, requests
├── temp/                  # Downloaded audio files (gitignored)
└── static/
    ├── index.html         # Setup screen
    ├── player.html        # Karaoke player screen
    ├── style.css          # Shared styles
    └── player.js          # Playback sync logic
```

### `start.bat`
```bat
python app.py & timeout 2 & start http://localhost:5000
```

### `requirements.txt`
```
flask
yt-dlp
requests
```

---

## Out of Scope (v1)
- Song queue / playlist management
- Vocal removal / music processing
- Mobile support
- User accounts or persistence
