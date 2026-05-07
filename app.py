import io
import os
import threading
import requests
from flask import Flask, request, jsonify, send_file, send_from_directory
from downloader import extract_metadata, download_audio, AUDIO_PATH, search_youtube
from lyrics import fetch_lyrics

_HERE = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__, static_folder=os.path.join(_HERE, "static"), static_url_path="/static")

WHISPER_MODEL   = os.environ.get('WHISPER_MODEL',   'large-v3-turbo')
WHISPER_DEVICE  = os.environ.get('WHISPER_DEVICE',  'cuda')
WHISPER_COMPUTE = os.environ.get('WHISPER_COMPUTE', 'float16')
WHISPER_CPU_COMPUTE = os.environ.get('WHISPER_CPU_COMPUTE', 'int8')
WHISPER_PROVIDER = os.environ.get('WHISPER_PROVIDER', 'auto').lower()
OPENAI_TRANSCRIBE_MODEL = os.environ.get('OPENAI_TRANSCRIBE_MODEL', 'gpt-realtime-whisper')
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


def _transcribe_with_model(model, wav_bytes, hint):
    audio_buf = io.BytesIO(wav_bytes)
    kwargs = dict(language='en', beam_size=1, word_timestamps=True)
    if hint:
        kwargs['initial_prompt'] = hint

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


def _transcribe_with_openai(wav_bytes, hint):
    if not OPENAI_API_KEY:
        raise RuntimeError('OPENAI_API_KEY is required when WHISPER_PROVIDER=openai')

    data = {
        'model': OPENAI_TRANSCRIBE_MODEL,
        'response_format': 'json',
    }
    if hint:
        data['prompt'] = hint

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
        "audioUrl": "/audio",
        "lyrics": lyrics,
    }
    if not lyrics:
        response["lyricsError"] = "No lyrics found. Edit artist/title and retry."

    return jsonify(response)


@app.route("/audio")
def audio():
    if not os.path.exists(AUDIO_PATH):
        return jsonify({"error": "No audio loaded"}), 404
    return send_file(AUDIO_PATH, mimetype="audio/webm")



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

    hint = request.headers.get('X-Lyric-Hint')
    try:
        provider = _whisper_active_provider or _resolve_whisper_provider()
        if provider == 'openai_realtime':
            return jsonify(error='use realtime transcription session', status=_whisper_state), 409
        if provider == 'openai':
            text, words = _transcribe_with_openai(wav_bytes, hint)
        else:
            text, words = _transcribe_with_model(_whisper_model, wav_bytes, hint)
        return jsonify(transcript=text, words=words)
    except Exception as exc:
        if _whisper_active_device != 'cpu' and _is_cuda_runtime_error(exc):
            model = _switch_whisper_to_cpu(exc)
            if model is None:
                return jsonify(error='model not ready', status=_whisper_state), 503
            try:
                text, words = _transcribe_with_model(model, wav_bytes, hint)
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
