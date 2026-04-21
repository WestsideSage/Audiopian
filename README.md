# Karaokee

Karaokee is a Flask-served karaoke scoring app. It loads audio from YouTube metadata/download flow, fetches synced lyrics from lrclib, and scores live singing with browser speech recognition plus optional server-side Whisper support.

## How It Works

1. Search or paste a YouTube URL.
2. The backend downloads audio and fetches synced lyrics.
3. The browser plays the track and runs game mode against the lyric timeline.
4. Matching uses exact, contraction, slang, phonetic, and edit-distance strategies.
5. Scoring uses weighted lyric words and adaptive timing windows by tempo.

## Tech Stack

- Backend: Python, Flask, faster-whisper, yt-dlp
- Frontend: plain HTML, CSS, and JavaScript served from `static/`
- ASR: browser Web Speech API plus optional server-side Whisper
- Audio: Web Audio API with an AudioWorklet for mic sampling and VAD

## Setup

### Prerequisites

- Python 3.10+
- `yt-dlp` via `pip install -r requirements.txt`

Optional:

- NVIDIA GPU with a working CUDA runtime if you want to opt Whisper into `cuda`

### Install

```bash
pip install -r requirements.txt
```

### Run

```bash
python app.py
```

Then open `http://localhost:5000`.

On Windows, `start.bat` launches the server and opens the browser.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `FLASK_DEBUG` | `0` | Set to `1` for Flask debug mode |
| `WHISPER_MODEL` | `large-v3-turbo` | Whisper model name |
| `WHISPER_DEVICE` | `cpu` | Default runtime on this machine |
| `WHISPER_COMPUTE` | `int8` | Compute type for the configured device |
| `WHISPER_COMPUTE_CPU` | `int8` | CPU fallback compute type |

Note: older docs and plans may mention CUDA defaults. The current shipped runtime is CPU-first on this machine unless you explicitly override it.

## Project Structure

```text
app.py                 Flask server and Whisper lifecycle
downloader.py          YouTube metadata extraction and audio download
lyrics.py              lrclib fetch and candidate ranking
static/                Production frontend served by Flask
tests/                 Pytest and Node regression suites
docs/                  Audits, plans, retrospectives, architecture, operations
output_telemetry/      Exported gameplay telemetry for offline analysis
```

## Documentation

- `docs/architecture.md`: runtime overview and main data flow
- `docs/algorithms/scoring.md`: scoring rules and line arithmetic
- `docs/algorithms/matching.md`: word-level matching strategies
- `docs/algorithms/sync.md`: tempo classes and timing windows
- `docs/operations/whisper.md`: Whisper config, fallback behavior, and failure modes
- `docs/operations/telemetry.md`: telemetry schema and replay notes
- `docs/plans/README.md`: historical plan timeline
- `docs/audits/`: audit history

## Notes

- `static/` is the shipped frontend. The old `src/` tree was an abandoned rewrite and is not part of the runtime.
- Browser speech recognition drives the real-time path. Whisper is supplemental and can be slower on CPU.
- VAD-only hints are visual only until ASR confirms them.

## License

MIT
