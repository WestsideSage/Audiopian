import io
import os
import threading
import threading as _threading
from flask import Flask, request, jsonify, send_file, send_from_directory
from downloader import extract_metadata, download_audio, AUDIO_PATH, search_youtube
from lyrics import fetch_lyrics
from vocal_remover import separate, INSTRUMENTAL_PATH

_HERE = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__, static_folder=os.path.join(_HERE, "static"), static_url_path="/static")

separation_state = {"status": "idle"}
separation_gen = 0  # incremented on each new song load; threads check before writing state
_last_duration = 0  # cached from last /load for use in /retry-lyrics

_whisper_model  = None
_whisper_state  = 'idle'    # 'idle' | 'loading' | 'ready' | 'error'
_whisper_error  = None      # full traceback string when state == 'error'
_whisper_lock   = _threading.Lock()
_prewarm_once   = False     # ensures prewarm thread fires only once per process


def _prewarm_whisper():
    """Load the Whisper model in a background thread. Updates module state."""
    global _whisper_model, _whisper_state, _whisper_error
    try:
        _whisper_state = 'loading'
        app.logger.info('Whisper: loading large-v3-turbo on cuda ...')
        from faster_whisper import WhisperModel
        model = WhisperModel('large-v3-turbo', device='cuda', compute_type='float16')
        with _whisper_lock:
            _whisper_model = model
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
            if not _prewarm_once:
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

    # Vocal separation disabled for rapid testing — re-enable by restoring the block below.
    separation_state["status"] = "idle"
    separation_state.pop("error", None)
    # --- re-enable block start ---
    # global separation_gen
    # separation_gen += 1
    # my_gen = separation_gen
    # separation_state["status"] = "processing"
    # separation_state.pop("error", None)
    # def run():
    #     try:
    #         separate(AUDIO_PATH)
    #         if separation_gen == my_gen:
    #             separation_state["status"] = "done"
    #     except Exception as e:
    #         if separation_gen == my_gen:
    #             separation_state["status"] = "error"
    #             separation_state["error"] = str(e)
    # threading.Thread(target=run, daemon=True).start()
    # --- re-enable block end ---

    global _last_duration
    _last_duration = meta.get("duration", 0)
    lyrics = fetch_lyrics(title, artist, duration=_last_duration)
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
    lyrics = fetch_lyrics(title, artist, duration=_last_duration)
    if not lyrics:
        return jsonify({"lyrics": [], "lyricsError": "Still no lyrics found."}), 200
    return jsonify({"lyrics": lyrics})

@app.route("/separate", methods=["POST"])
def start_separate():
    separation_state["status"] = "processing"

    def run():
        try:
            separate(AUDIO_PATH)
            separation_state["status"] = "done"
        except Exception as e:
            separation_state["status"] = "error"
            separation_state["error"] = str(e)

    threading.Thread(target=run, daemon=True).start()
    return jsonify({"status": "processing"})


@app.route("/separate-status")
def separate_status():
    status = separation_state.get("status", "idle")
    resp = {"status": status}
    if status == "done":
        resp["audioUrl"] = "/instrumental"
    if status == "error":
        resp["error"] = separation_state.get("error", "Unknown error")
    return jsonify(resp)


@app.route('/whisper-status')
def whisper_status():
    return jsonify(
        status=_whisper_state,
        error=_whisper_error,
        model='large-v3-turbo',
        device='cuda',
    )


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
        audio_buf = io.BytesIO(wav_bytes)
        hint = request.headers.get('X-Lyric-Hint')
        kwargs = dict(language='en', beam_size=1, word_timestamps=True)
        if hint:
            kwargs['initial_prompt'] = hint

        segments, _ = _whisper_model.transcribe(audio_buf, **kwargs)
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

        return jsonify(transcript=text, words=words)
    except Exception:
        app.logger.exception('Whisper transcription error on current request')
        return jsonify(transcript='', words=[]), 500


@app.route("/instrumental")
def instrumental():
    if not os.path.exists(INSTRUMENTAL_PATH):
        return jsonify({"error": "No instrumental available"}), 404
    return send_file(INSTRUMENTAL_PATH, mimetype="audio/wav")


@app.route("/search")
def search():
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify({"error": "Query required"}), 400
    results = search_youtube(q)
    return jsonify(results)


if __name__ == "__main__":
    app.run(debug=True, port=5000)
