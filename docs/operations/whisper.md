# Transcription (Whisper & the OpenAI options)

"Transcription" means turning recorded singing into text. This page covers the Whisper / OpenAI side of that — the setup, the options, and what happens when things go wrong.

> Karaokee also runs the **browser's** built-in speech recognition in parallel with this; that's the *other* recognizer lane, covered in [`architecture.md`](../architecture.md). This page is about the Whisper / OpenAI lane. The overall recognizer strategy for going online is recorded in [ADR-0001](../adr/0001-tiered-recognizer-byo-key-deploy.md).

## The three options

Picked by the `WHISPER_PROVIDER` setting (`app.py`, `_resolve_whisper_provider`):

- **`local`** (the `auto` default) — runs the open-source **Whisper** model on your own computer via `faster-whisper`. Free, private, no internet — but slower without a GPU.
- **`openai`** — sends recorded chunks to OpenAI's cloud transcription.
- **`openai_realtime`** — streams your voice *live* from the browser to OpenAI's `gpt-realtime-whisper`. Fastest and most accurate, but it costs money and needs an API key. In this mode the server's `/transcribe` route is unused (it returns `409`) — the browser talks to OpenAI directly.

## Settings and their defaults

All from `app.py`, all overridable by environment variable:

| Setting | Default | Meaning |
|---|---|---|
| `WHISPER_PROVIDER` | `auto` | Which option above (`auto` = `local`). |
| `WHISPER_MODEL` | `large-v3-turbo` | Which local Whisper model. |
| `WHISPER_DEVICE` | `cuda` | Where the local model runs. **If no working GPU is found, Karaokee automatically falls back to CPU** — which is what happens on the current dev machine (it's missing a CUDA library), so in practice it runs on CPU here. |
| `WHISPER_COMPUTE` | `float16` | Number precision when on GPU. |
| `WHISPER_CPU_COMPUTE` | `int8` | Precision used on the CPU fallback. |
| `OPENAI_API_KEY` | — | Required for the two OpenAI options. |
| `OPENAI_TRANSCRIBE_MODEL` | `gpt-realtime-whisper` | The OpenAI model. |
| `OPENAI_TRANSCRIBE_DELAY` | — | Latency-vs-accuracy knob for `gpt-realtime-whisper` (`minimal`…`xhigh`); set it low to cut lag on fast, dense songs (small accuracy cost). |

Trying the live OpenAI path locally (PowerShell):

```powershell
$env:WHISPER_PROVIDER = "openai_realtime"
$env:OPENAI_API_KEY = "<your key>"
python app.py
```

## How the live (realtime) path works

When `WHISPER_PROVIDER=openai_realtime`:

1. The browser asks the server for a **short-lived access token** (`/realtime-transcription-session`). The server mints it from your real API key via OpenAI's `client_secrets` endpoint and hands the browser only the temporary token — **your real key never reaches the browser.**
2. The browser opens a live connection (WebRTC) and streams microphone audio, getting transcription text back as you sing.
3. `gpt-realtime-whisper` is picky about two options, and Karaokee respects that (`realtime-whisper.js`): it does **not** send a lyric "prompt" hint, and it does **not** send server-side voice-activity (`turn_detection`) settings — those are only sent for *other* models. Karaokee decides "when to send audio" itself (see `commit-helpers.js` in [`architecture.md`](../architecture.md)).

## Loading and status

1. The first web request starts the model loading in a background thread.
2. `/whisper-status` reports `idle`, `loading`, `ready`, or `error`; the browser polls it.
3. While loading, `/transcribe` returns `503` (not ready yet).
4. For `openai_realtime`, no local model loads — the path is marked ready as soon as an API key is configured.

## When things go wrong

- **No working CUDA** → automatic fallback to CPU (slower, but it works).
- **A CUDA error mid-song** → Karaokee switches that run to CPU on the fly.
- **Slow CPU** → transcription lags on dense/fast songs; the live OpenAI path avoids this.
- **`503`** → the local model is still loading. **`500`** → a transcription error.

## Telling which lane is active

The player UI shows the active recognizer (e.g. `ASR: GPT Realtime Whisper (gpt-realtime-whisper) - ready`, or `ASR: local Whisper (...) - ready`). Saved telemetry also tags each run with the provider and model, so runs can be grouped by recognizer later.
