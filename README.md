# Karaokee

A real-time karaoke scoring engine that matches your singing against song lyrics using dual-track automatic speech recognition (ASR), phonetic matching, and adaptive timing.

## How It Works

1. **Search & Load** — Paste a YouTube URL or search by song name. The backend extracts audio via yt-dlp and fetches synced lyrics from lrclib.net.

2. **Dual-Track ASR** — Two speech recognition systems run in parallel:
   - **Browser SpeechRecognition** for low-latency interim results
   - **Whisper** (server-side, via faster-whisper) for high-accuracy word-level timestamps

3. **Fuzzy Matching** — Words are matched using multiple strategies:
   - Exact match
   - Double Metaphone phonetic codes ("night" ≈ "knight")
   - Levenshtein edit distance with length-adaptive thresholds
   - Contraction expansion ("gonna" ↔ "going to")
   - Slang normalization (76+ bidirectional mappings)

4. **Adaptive Sync** — Timing windows adjust based on song tempo:
   - Slow songs (< 2 wps): wider windows, longer overlap
   - Fast songs (> 5 wps): tighter windows, shorter chunks

5. **Scoring** — Per-word scoring with positional accuracy, streak tracking, and VAD-assisted provisional credit for words the mic picks up but ASR hasn't confirmed yet.

## Tech Stack

- **Backend:** Python, Flask, faster-whisper, yt-dlp
- **Frontend:** Vanilla HTML/JS/CSS (no framework)
- **ASR:** Browser Web Speech API + server-side Whisper (large-v3-turbo on CUDA)
- **Audio:** Web Audio API (AudioWorklet for real-time mic processing)

## Setup

### Prerequisites

- Python 3.10+
- NVIDIA GPU with CUDA support (for Whisper)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) (installed via pip)

### Install

```bash
pip install -r requirements.txt
```

### Run

```bash
python app.py
```

Then open http://localhost:5000.

On Windows, you can also use `start.bat` which launches the server and opens the browser.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `FLASK_DEBUG` | `0` | Set to `1` for Flask debug mode |
| `WHISPER_MODEL` | `large-v3-turbo` | Whisper model name |
| `WHISPER_DEVICE` | `cuda` | Device for Whisper inference |
| `WHISPER_COMPUTE` | `float16` | Compute type for Whisper |

## Project Structure

```
├── app.py              # Flask server — API endpoints, Whisper lifecycle
├── downloader.py       # YouTube metadata extraction and audio download
├── lyrics.py           # LRC lyrics fetching and candidate ranking
├── requirements.txt    # Python dependencies
├── start.bat           # Windows launcher
├── static/
│   ├── index.html          # Search page
│   ├── player.html         # Playback + game mode UI
│   ├── player.js           # Core game engine — matching, scoring, telemetry
│   ├── match-helpers.js    # Contraction/slang/phonetic matching
│   ├── sync-helpers.js     # Tempo classification, adaptive timing
│   ├── audio-processor.js  # AudioWorklet for mic sampling + VAD
│   └── style.css
├── tests/              # pytest + Node.js test suites
└── docs/plans/         # Design docs showing iterative development
```

## Design Documents

The [docs/plans/](docs/plans/) directory contains paired design specs and implementation plans for each feature iteration, showing how the scoring algorithm evolved through telemetry-driven tuning. See the [index](docs/plans/README.md) for the full timeline.

## License

MIT
