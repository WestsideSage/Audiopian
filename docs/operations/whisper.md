# Whisper Operations

Whisper is optional support for the browser recognition path.

## Defaults

Current runtime defaults in `app.py`:

- `WHISPER_PROVIDER=auto`
- `WHISPER_MODEL=large-v3-turbo`
- `WHISPER_DEVICE=cuda`
- `WHISPER_COMPUTE=float16`
- `WHISPER_CPU_COMPUTE=int8`
- `OPENAI_TRANSCRIBE_MODEL=gpt-realtime-whisper`

`WHISPER_PROVIDER=auto` currently resolves to the local `faster-whisper` path. Set
`WHISPER_PROVIDER=openai_realtime` and `OPENAI_API_KEY` to enable the hosted
Realtime transcription session path.

The server creates browser-safe ephemeral tokens through
`POST /v1/realtime/client_secrets`; it does not send the long-lived API key to
the browser.

`gpt-realtime-whisper` rejects the transcription `prompt` and `turn_detection`
parameters, so the app does not send lyric hints or server VAD settings for that
model.

PowerShell test launch:

```powershell
$env:WHISPER_PROVIDER = "openai_realtime"
$env:OPENAI_TRANSCRIBE_MODEL = "gpt-realtime-whisper"
$env:OPENAI_API_KEY = "<your key>"
python app.py
```

## Lifecycle

1. First HTTP request triggers `_ensure_prewarm()`.
2. A background thread loads the model.
3. `/whisper-status` reports `idle`, `loading`, `ready`, or `error`.
4. `/transcribe` rejects requests with `503` until the model is `ready`.

When `WHISPER_PROVIDER=openai_realtime`, the server does not load a local model.
It marks the hosted path ready when `OPENAI_API_KEY` is configured and exposes
`/realtime-transcription-session` to mint an ephemeral OpenAI Realtime
transcription session using `gpt-realtime-whisper`.

## Failure Modes

- CUDA runtime missing or misconfigured
- slow CPU inference
- `503` while the model is still loading
- `500` from transcription-time failures

## Frontend Behavior

- `player.js` polls `/whisper-status`.
- Chunk dispatch pauses while the backend reports `loading`.
- Late Whisper results are routed using the line index captured at dispatch time.
- Active-line Whisper transcript buffering is capped to the most recent 200 words.
- `gpt-realtime-whisper` is a streaming model, not a drop-in replacement for the
  existing `/transcribe` chunk endpoint. The browser path uses WebRTC with an
  ephemeral token and consumes transcript delta/completion events from the
  `oai-events` data channel.
- The player controls show the active lane explicitly. Look for
  `ASR: GPT Realtime Whisper (gpt-realtime-whisper) - ready` when testing the
  hosted model, or `ASR: local Whisper (...) - ready` when testing the old path.
- Downloaded telemetry includes `meta.whisperProvider`, `meta.whisperModel`,
  `meta.whisperStatusAtStart`, `meta.whisperStatusFinal`, and
  `meta.whisperTrackStatus` so runs can be grouped by recognizer.

## Practical Guidance

- Treat browser SR as the real-time source.
- Treat Whisper as supplemental confirmation or observability.
- If the machine stays CPU-only, leave the defaults CPU-first instead of pretending CUDA is the normal path.

## Dual-Track Decision

Keep the browser SR + Whisper model for now.

The retrospective showed Whisper was sparse and late on this machine, so it should not be promoted to the primary scorer. Removing it immediately would still be a product behavior change, not a cleanup. The current direction is:

- keep browser SR as the scoring-critical real-time path
- keep Whisper as an optional late-confirmation and observability layer
- use fresh manual tests and telemetry exports to decide later whether Whisper's contribution justifies its complexity
