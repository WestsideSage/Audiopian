# Audiopian

**Sing the songs you actually love — and find out how well you really know them.**

Audiopian is a karaoke game built around one frustration: every karaoke bar has thousands of songs, but never *the* song you can truly perform — the one you know cold and can pour yourself into. So Audiopian lets you bring **any** song. Paste a YouTube link, and it turns the lyrics into a live game: sing along, and it listens through your mic, follows the words in real time, and scores how well you nailed them — combos, grades, and all.

## How it works (the short version)

1. You search for, or paste, a YouTube song.
2. Audiopian grabs the audio and finds time-synced lyrics (the kind that scroll in time with the music).
3. The song plays, the lyrics light up line by line, and your microphone listens.
4. As you sing, it turns your voice into words and matches them to the lyrics — forgiving near-misses along the way (it knows "night" and "knight" sound identical).
5. You get a live score: an honest "how much did you actually sing" percentage, plus an arcade layer of combos, points, and a letter grade.

## Two ways it listens

- **Free (default):** your browser's built-in speech recognition. Works in **desktop Chrome or Edge**, costs nothing, needs no setup.
- **Sharper (optional):** set an OpenAI API key to switch on `gpt-realtime-whisper`, a more accurate live transcriber. (When Audiopian goes online, players will be able to bring their *own* key — kept in their browser — while everyone else uses the free option. The reasoning is in [the decision records](docs/adr/).)

## What's under the hood

- **Backend:** Python + Flask (a small web server), plus `yt-dlp` for YouTube and `faster-whisper` for on-device transcription.
- **Frontend:** plain HTML / CSS / JavaScript — no framework, no build step.
- **Hearing you:** a neural voice-activity detector (it knows when you're singing vs. silent) and two speech recognizers working together.
- **Want the full picture?** [`docs/architecture.md`](docs/architecture.md) explains every piece in plain English.

## Run it locally

You'll need **Python 3.10+**.

```bash
pip install -r requirements.txt
python app.py
```

Then open **http://localhost:5000** in Chrome or Edge. On Windows, `start.bat` does both steps for you.

> You need a microphone, and the free speech recognition needs **desktop Chrome or Edge** — the supported, tested targets. (Firefox has no speech-recognition support; other browsers are untested.)

### Settings (environment variables)

You don't need any of these to run it — they only tune transcription. The ones that matter most:

| Variable | What it does |
|---|---|
| `WHISPER_PROVIDER` | Which transcriber to use: `auto` (default — runs Whisper locally), `openai`, or `openai_realtime` (live OpenAI). |
| `OPENAI_API_KEY` | Required for the `openai` / `openai_realtime` options. |
| `OPENAI_TRANSCRIBE_MODEL` | The OpenAI model to use (default `gpt-realtime-whisper`). |
| `WHISPER_MODEL` | Which local Whisper model (default `large-v3-turbo`). |
| `WHISPER_DEVICE` | `cuda` by default; **automatically falls back to `cpu`** if there's no working GPU (the case on the dev machine). |

Full transcription and config details: [`docs/operations/whisper.md`](docs/operations/whisper.md).

## Where the project is headed

The current focus is **getting Audiopian online so other people can try it** — it only runs locally today. The plan, the blockers, and the decisions behind it are written up in [`docs/operations/deployment.md`](docs/operations/deployment.md) and the [decision records](docs/adr/).

## Project layout

```text
app.py            The web server + transcription lifecycle
downloader.py     YouTube audio + search
lyrics.py         Finding and parsing time-synced lyrics
static/           The actual game (HTML/JS/CSS) — see docs/architecture.md
tests/            Automated tests (Python + JavaScript)
docs/             Architecture, how-to guides, decisions, and design history
```

## Documentation

- [Architecture](docs/architecture.md) — how it all fits together, in plain English
- [Whisper / transcription](docs/operations/whisper.md) — recognizer setup and behavior
- [Scoring](docs/algorithms/scoring.md) · [Matching](docs/algorithms/matching.md) · [Sync](docs/algorithms/sync.md) — how the game judges your singing
- [Deployment](docs/operations/deployment.md) — the plan to put it online
- [Decisions (ADRs)](docs/adr/) · [Design history](docs/plans/README.md)

## License

MIT
