# Whisper Operations

Whisper is optional support for the browser recognition path.

## Defaults

Current runtime defaults in `app.py`:

- `WHISPER_MODEL=large-v3-turbo`
- `WHISPER_DEVICE=cpu`
- `WHISPER_COMPUTE=int8`
- `WHISPER_COMPUTE_CPU=int8`

## Lifecycle

1. First HTTP request triggers `_ensure_prewarm()`.
2. A background thread loads the model.
3. `/whisper-status` reports `idle`, `loading`, `ready`, or `error`.
4. `/transcribe` rejects requests with `503` until the model is `ready`.

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

## Practical Guidance

- Treat browser SR as the real-time source.
- Treat Whisper as supplemental confirmation or observability.
- If the machine stays CPU-only, leave the defaults CPU-first instead of pretending CUDA is the normal path.
