import io
import os
import glob
import json
import re
import mimetypes
import threading
from datetime import datetime, timezone
import requests
from flask import Flask, request, jsonify, send_file, send_from_directory
from downloader import extract_metadata, download_audio, AUDIO_PATH, TEMP_DIR, search_youtube
from lyrics import fetch_lyrics

_HERE = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__, static_folder=os.path.join(_HERE, "static"), static_url_path="/static")

# Audio file extensions accepted by the local-file upload path (/load-local).
ALLOWED_AUDIO_EXT = {".mp3", ".m4a", ".webm", ".ogg", ".opus", ".wav", ".flac", ".aac"}

WHISPER_MODEL   = os.environ.get('WHISPER_MODEL',   'large-v3-turbo')
WHISPER_DEVICE  = os.environ.get('WHISPER_DEVICE',  'cuda')
WHISPER_COMPUTE = os.environ.get('WHISPER_COMPUTE', 'float16')
WHISPER_CPU_COMPUTE = os.environ.get('WHISPER_CPU_COMPUTE', 'int8')
WHISPER_PROVIDER = os.environ.get('WHISPER_PROVIDER', 'auto').lower()
OPENAI_TRANSCRIBE_MODEL = os.environ.get('OPENAI_TRANSCRIBE_MODEL', 'gpt-realtime-whisper')
# gpt-realtime-whisper latency/accuracy tradeoff: minimal|low|medium|high|xhigh.
# Lower = earlier partial text (less lag); higher = more audio context (better word
# error rate). Opt-in — when empty, OpenAI's default applies. A/B lever for the
# fast-rap lag-vs-coverage tradeoff.
OPENAI_TRANSCRIBE_DELAY = os.environ.get('OPENAI_TRANSCRIBE_DELAY', '').strip()
OPENAI_API_KEY = os.environ.get('OPENAI_API_KEY')
OPENAI_TRANSCRIBE_URL = os.environ.get(
    'OPENAI_TRANSCRIBE_URL',
    'https://api.openai.com/v1/audio/transcriptions',
)
OPENAI_REALTIME_TRANSCRIPTION_URL = os.environ.get(
    'OPENAI_REALTIME_TRANSCRIPTION_URL',
    'https://api.openai.com/v1/realtime/client_secrets',
)
OPENAI_TRANSCRIBE_TIMEOUT = float(os.environ.get('OPENAI_TRANSCRIBE_TIMEOUT', '30'))

_last_duration = 0  # cached from last /load for use in /retry-lyrics
_duration_lock  = threading.Lock()

_whisper_model  = None
_whisper_state  = 'idle'    # 'idle' | 'loading' | 'ready' | 'error'
_whisper_error  = None      # full traceback string when state == 'error'
_whisper_active_device = WHISPER_DEVICE
_whisper_active_compute = WHISPER_COMPUTE
_whisper_active_provider = None
_whisper_lock   = threading.Lock()
_prewarm_once   = False     # ensures prewarm thread fires only once per process


def _resolve_whisper_provider():
    if WHISPER_PROVIDER == 'auto':
        return 'local'
    if WHISPER_PROVIDER in ('openai_realtime', 'realtime', 'gpt-realtime-whisper'):
        return 'openai_realtime'
    if WHISPER_PROVIDER in ('openai', 'api', 'hosted', 'openai_file'):
        return 'openai'
    return 'local'


def _mark_openai_realtime_ready():
    global _whisper_model, _whisper_state, _whisper_error, _whisper_active_device, _whisper_active_compute, _whisper_active_provider
    if not OPENAI_API_KEY:
        raise RuntimeError('OPENAI_API_KEY is required when WHISPER_PROVIDER=openai_realtime')
    with _whisper_lock:
        _whisper_model = None
        _whisper_error = None
        _whisper_active_provider = 'openai_realtime'
        _whisper_active_device = 'hosted'
        _whisper_active_compute = 'api'
        _whisper_state = 'ready'


def _load_whisper_model(device, compute_type):
    from faster_whisper import WhisperModel
    return WhisperModel(WHISPER_MODEL, device=device, compute_type=compute_type)


def _is_cuda_runtime_error(exc):
    message = str(exc).lower()
    return (
        'cublas64_12.dll' in message
        or 'cudnn' in message
        or ('cuda' in message and ('not found' in message or 'cannot be loaded' in message))
    )


def _transcribe_with_model(model, wav_bytes):
    audio_buf = io.BytesIO(wav_bytes)
    # No lyric prompt: priming the decoder with the target line makes it emit
    # that line on hum/music/silence (answer-key injection). vad_filter +
    # no_speech_threshold reject non-vocal chunks; condition_on_previous_text=False
    # stops hallucinated text carrying across chunks.
    kwargs = dict(
        language='en',
        beam_size=1,
        word_timestamps=True,
        vad_filter=True,
        no_speech_threshold=0.6,
        condition_on_previous_text=False,
    )

    segments, _ = model.transcribe(audio_buf, **kwargs)
    segments = list(segments)

    text = ' '.join(s.text for s in segments).strip()
    words = []
    for seg in segments:
        if seg.words:
            for w in seg.words:
                words.append({
                    'text':  w.word.strip(),
                    'start': round(w.start, 3),
                    'end':   round(w.end,   3),
                })

    return text, words


def _transcribe_with_openai(wav_bytes):
    if not OPENAI_API_KEY:
        raise RuntimeError('OPENAI_API_KEY is required when WHISPER_PROVIDER=openai')

    data = {
        'model': OPENAI_TRANSCRIBE_MODEL,
        'response_format': 'json',
    }

    response = requests.post(
        OPENAI_TRANSCRIBE_URL,
        headers={'Authorization': f'Bearer {OPENAI_API_KEY}'},
        data=data,
        files={'file': ('audio.wav', wav_bytes, 'audio/wav')},
        timeout=OPENAI_TRANSCRIBE_TIMEOUT,
    )
    response.raise_for_status()
    payload = response.json()

    if isinstance(payload, dict):
        return (payload.get('text') or payload.get('transcript') or '').strip(), []
    return str(payload).strip(), []


def _create_openai_realtime_transcription_session(prompt=None):
    if not OPENAI_API_KEY:
        raise RuntimeError('OPENAI_API_KEY is required when WHISPER_PROVIDER=openai_realtime')

    transcription = {
        'model': OPENAI_TRANSCRIBE_MODEL,
        'language': 'en',
    }
    if prompt and OPENAI_TRANSCRIBE_MODEL != 'gpt-realtime-whisper':
        transcription['prompt'] = prompt
    if OPENAI_TRANSCRIBE_DELAY and OPENAI_TRANSCRIBE_MODEL == 'gpt-realtime-whisper':
        transcription['delay'] = OPENAI_TRANSCRIBE_DELAY

    audio_input = {
        'format': {
            'type': 'audio/pcm',
            'rate': 24000,
        },
        'transcription': transcription,
    }
    if OPENAI_TRANSCRIBE_MODEL != 'gpt-realtime-whisper':
        audio_input['turn_detection'] = {
            'type': 'server_vad',
            'threshold': 0.5,
            'prefix_padding_ms': 300,
            'silence_duration_ms': 500,
        }

    response = requests.post(
        OPENAI_REALTIME_TRANSCRIPTION_URL,
        headers={
            'Authorization': f'Bearer {OPENAI_API_KEY}',
            'Content-Type': 'application/json',
        },
        json={
            'expires_after': {
                'anchor': 'created_at',
                'seconds': 600,
            },
            'session': {
                'type': 'transcription',
                'audio': {
                    'input': audio_input,
                },
                'include': ['item.input_audio_transcription.logprobs'],
            },
        },
        timeout=OPENAI_TRANSCRIBE_TIMEOUT,
    )
    response.raise_for_status()
    return response.json()


def _switch_whisper_to_cpu(reason):
    global _whisper_model, _whisper_state, _whisper_error, _whisper_active_device, _whisper_active_compute
    app.logger.warning('Whisper: CUDA runtime failed; retrying on CPU: %s', reason)
    with _whisper_lock:
        _whisper_state = 'loading'
        _whisper_error = None
    try:
        model = _load_whisper_model('cpu', WHISPER_CPU_COMPUTE)
        with _whisper_lock:
            _whisper_model = model
            _whisper_active_device = 'cpu'
            _whisper_active_compute = WHISPER_CPU_COMPUTE
            _whisper_state = 'ready'
            _whisper_error = None
        return model
    except Exception:
        import traceback as _tb
        with _whisper_lock:
            _whisper_model = None
            _whisper_state = 'error'
            _whisper_error = _tb.format_exc()
        app.logger.exception('Whisper: CPU fallback failed')
        return None


def _prewarm_whisper():
    """Load the Whisper model in a background thread. Updates module state."""
    global _whisper_model, _whisper_state, _whisper_error, _whisper_active_device, _whisper_active_compute, _whisper_active_provider
    try:
        provider = _resolve_whisper_provider()
        _whisper_state = 'loading'
        _whisper_active_provider = provider
        if provider in ('openai', 'openai_realtime'):
            if not OPENAI_API_KEY:
                raise RuntimeError(f'OPENAI_API_KEY is required when WHISPER_PROVIDER={provider}')
            if provider == 'openai_realtime':
                _mark_openai_realtime_ready()
                app.logger.info('Whisper: using OpenAI %s transcription model %s', provider, OPENAI_TRANSCRIBE_MODEL)
                return
            with _whisper_lock:
                _whisper_model = None
                _whisper_active_device = 'hosted'
                _whisper_active_compute = 'api'
                _whisper_state = 'ready'
            app.logger.info('Whisper: using OpenAI %s transcription model %s', provider, OPENAI_TRANSCRIBE_MODEL)
            return

        app.logger.info('Whisper: loading %s on %s ...', WHISPER_MODEL, WHISPER_DEVICE)
        model = _load_whisper_model(WHISPER_DEVICE, WHISPER_COMPUTE)
        with _whisper_lock:
            _whisper_model = model
            _whisper_active_device = WHISPER_DEVICE
            _whisper_active_compute = WHISPER_COMPUTE
            _whisper_state = 'ready'
        app.logger.info('Whisper: model ready')
    except Exception:
        import traceback as _tb
        _whisper_state = 'error'
        _whisper_error = _tb.format_exc()
        app.logger.exception('Whisper: model failed to load')


@app.before_request
def _ensure_prewarm():
    """Fire prewarm on first HTTP request. Runs only in the serving process,
    so Werkzeug's debug reloader parent (which never serves requests) stays clean."""
    global _prewarm_once
    if not _prewarm_once:
        with _whisper_lock:
            if not _prewarm_once and _whisper_state == 'idle':
                _prewarm_once = True
                threading.Thread(target=_prewarm_whisper, daemon=True).start()


@app.route("/")
def index():
    return send_from_directory(os.path.join(_HERE, "static"), "index.html")


@app.route("/player")
def player():
    return send_from_directory(os.path.join(_HERE, "static"), "player.html")


# Legal pages. On the deployed (Cloudflare Pages) static site these resolve via
# clean URLs automatically; these routes give the local Flask dev server parity.
@app.route("/terms")
def terms():
    return send_from_directory(os.path.join(_HERE, "static"), "terms.html")


@app.route("/privacy")
def privacy():
    return send_from_directory(os.path.join(_HERE, "static"), "privacy.html")


@app.route("/dmca")
def dmca():
    return send_from_directory(os.path.join(_HERE, "static"), "dmca.html")


@app.route("/load", methods=["POST"])
def load():
    data = request.get_json()
    url = (data or {}).get("url", "").strip()
    if not url:
        return jsonify({"error": "No URL provided"}), 400

    try:
        meta = extract_metadata(url)
    except Exception as e:
        return jsonify({"error": f"Could not load video: {str(e)}"}), 400

    title = (data.get("title") or meta["title"]).strip()
    artist = (data.get("artist") or meta["artist"]).strip()

    # Server-side audio download is dev-only now (online plays via the YouTube IFrame).
    # Opt in with KARAOKEE_SERVER_AUDIO=1 to test the <audio>/temp path locally.
    if os.environ.get("KARAOKEE_SERVER_AUDIO") == "1":
        try:
            download_audio(url)
        except Exception as e:
            return jsonify({"error": f"Could not download audio: {str(e)}"}), 400

    global _last_duration
    with _duration_lock:
        _last_duration = meta.get("duration", 0)
        duration = _last_duration
    lyrics = fetch_lyrics(title, artist, duration=duration)
    response = {
        "title": title,
        "artist": artist,
        "videoId": meta.get("id", ""),
        "audioUrl": "/audio",
        "lyrics": lyrics,
    }
    if not lyrics:
        response["lyricsError"] = "No lyrics found. Edit artist/title and retry."

    return jsonify(response)


@app.route("/load-local", methods=["POST"])
def load_local():
    """Load a user-provided local audio file (multipart upload) and fetch synced
    lyrics by title/artist. Lets the app be used (and the scoring tested) without
    YouTube. Saves to temp/audio.<ext>; /audio serves the most recent one."""
    file = request.files.get("file")
    if file is None or not file.filename:
        return jsonify(error="No audio file provided"), 400

    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in ALLOWED_AUDIO_EXT:
        return jsonify(error=f"Unsupported audio type: {ext or 'unknown'}"), 400

    title = (request.form.get("title") or "").strip()
    artist = (request.form.get("artist") or "").strip()
    if not title:
        title = os.path.splitext(os.path.basename(file.filename))[0].strip()

    os.makedirs(TEMP_DIR, exist_ok=True)
    file.save(os.path.join(TEMP_DIR, "audio" + ext))

    lyrics = fetch_lyrics(title, artist) if (title and artist) else []
    response = {"title": title, "artist": artist, "audioUrl": "/audio", "lyrics": lyrics}
    if not lyrics:
        response["lyricsError"] = "No lyrics found. Edit artist/title and retry."
    return jsonify(response)


@app.route("/audio")
def audio():
    # Serve the most recently loaded temp/audio.* file (a YouTube .webm download
    # or an uploaded local file of any supported type), with a guessed mimetype.
    matches = glob.glob(os.path.join(TEMP_DIR, "audio.*"))
    if not matches:
        return jsonify({"error": "No audio loaded"}), 404
    path = max(matches, key=os.path.getmtime)
    mime = mimetypes.guess_type(path)[0] or "audio/webm"
    return send_file(path, mimetype=mime)


_TELEMETRY_MAX_BYTES = 8 * 1024 * 1024  # 8 MB safety cap


@app.route("/telemetry", methods=["POST"])
def save_telemetry():
    # Persist one session's telemetry JSON to output_telemetry/<YYYY-MM-DD>/.
    raw = request.get_data(cache=False)
    if len(raw) > _TELEMETRY_MAX_BYTES:
        return jsonify({"error": "Payload too large"}), 413
    try:
        payload = json.loads(raw)
    except Exception:
        return jsonify({"error": "Invalid JSON"}), 400
    if not isinstance(payload, dict):
        return jsonify({"error": "Expected a JSON object"}), 400

    meta = payload.get("meta") or {}
    started = str(meta.get("startedAt") or "")
    # Date folder: from the payload's startedAt if it's a clean ISO date, else server UTC date.
    date_folder = started[:10]
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", date_folder):
        date_folder = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    # Filename timestamp: from endedAt/startedAt, colon/dot -> dash, sanitized; else server time.
    ended = str(meta.get("endedAt") or started or "")
    ts = re.sub(r"[:.]", "-", ended)[:19]
    ts = re.sub(r"[^0-9A-Za-z\-T]", "", ts)
    if not ts:
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S")

    out_dir = os.path.join(_HERE, "output_telemetry", date_folder)
    os.makedirs(out_dir, exist_ok=True)
    fname = "karaokee-telemetry-" + ts + ".json"
    path = os.path.join(out_dir, fname)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    return jsonify({"ok": True, "path": os.path.relpath(path, _HERE)})


@app.route("/retry-lyrics", methods=["POST"])
def retry_lyrics():
    data = request.get_json()
    title = (data or {}).get("title", "").strip()
    artist = (data or {}).get("artist", "").strip()
    if not title or not artist:
        return jsonify({"error": "Title and artist required"}), 400
    with _duration_lock:
        duration = _last_duration
    lyrics = fetch_lyrics(title, artist, duration=duration)
    if not lyrics:
        return jsonify({"lyrics": [], "lyricsError": "Still no lyrics found."}), 200
    return jsonify({"lyrics": lyrics})

@app.route('/whisper-status')
def whisper_status():
    provider = _whisper_active_provider or _resolve_whisper_provider()
    return jsonify(
        status=_whisper_state,
        error=_whisper_error,
        model=OPENAI_TRANSCRIBE_MODEL if provider in ('openai', 'openai_realtime') else WHISPER_MODEL,
        provider=provider,
        device=_whisper_active_device,
        compute_type=_whisper_active_compute,
        # Active gpt-realtime-whisper latency setting (or null = OpenAI default), so
        # an A/B of OPENAI_TRANSCRIBE_DELAY is verifiable at a glance.
        delay=(OPENAI_TRANSCRIBE_DELAY or None) if provider == 'openai_realtime' else None,
    )


@app.route('/realtime-transcription-session', methods=['POST'])
def realtime_transcription_session():
    """Create an OpenAI Realtime transcription session for browser streaming."""
    if (_whisper_active_provider or _resolve_whisper_provider()) != 'openai_realtime':
        return jsonify(error='realtime transcription is not enabled'), 404
    if _whisper_state in ('idle', 'loading'):
        try:
            _mark_openai_realtime_ready()
        except Exception:
            app.logger.exception('OpenAI realtime transcription provider is not configured')
            return jsonify(error='realtime transcription is not configured'), 503
    if _whisper_state != 'ready':
        return jsonify(error='model not ready', status=_whisper_state), 503

    payload = request.get_json(silent=True) or {}
    prompt = payload.get('prompt')
    try:
        session = _create_openai_realtime_transcription_session(prompt=prompt)
        return jsonify(session)
    except requests.HTTPError as exc:
        status = exc.response.status_code if exc.response is not None else 502
        body = exc.response.text if exc.response is not None else ''
        app.logger.exception('OpenAI realtime transcription session error: %s', body[:1000])
        return jsonify(error='realtime transcription session failed', detail=body[:1000]), status
    except Exception:
        app.logger.exception('OpenAI realtime transcription session error')
        return jsonify(error='realtime transcription session failed'), 500


@app.route('/transcribe', methods=['POST'])
def transcribe():
    """Accept a raw WAV body, transcribe with Whisper, return {transcript, words}."""
    # Strict readiness gate: never touch the model object if not confirmed ready
    if _whisper_state != 'ready':
        return jsonify(error='model not ready', status=_whisper_state), 503

    wav_bytes = request.data
    if len(wav_bytes) < 100:
        return jsonify(transcript='', words=[])

    try:
        provider = _whisper_active_provider or _resolve_whisper_provider()
        if provider == 'openai_realtime':
            return jsonify(error='use realtime transcription session', status=_whisper_state), 409
        if provider == 'openai':
            text, words = _transcribe_with_openai(wav_bytes)
        else:
            text, words = _transcribe_with_model(_whisper_model, wav_bytes)
        return jsonify(transcript=text, words=words)
    except Exception as exc:
        if _whisper_active_device != 'cpu' and _is_cuda_runtime_error(exc):
            model = _switch_whisper_to_cpu(exc)
            if model is None:
                return jsonify(error='model not ready', status=_whisper_state), 503
            try:
                text, words = _transcribe_with_model(model, wav_bytes)
                return jsonify(transcript=text, words=words)
            except Exception:
                app.logger.exception('Whisper transcription error after CPU fallback')
                return jsonify(transcript='', words=[]), 500

        app.logger.exception('Whisper transcription error on current request')
        return jsonify(transcript='', words=[]), 500


@app.route("/search")
def search():
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify({"error": "Query required"}), 400
    results = search_youtube(q)
    return jsonify(results)


if __name__ == "__main__":
    app.run(debug=os.environ.get("FLASK_DEBUG", "0") == "1", port=5000)
