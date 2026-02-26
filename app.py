import io
import os
import threading
import threading as _threading
from flask import Flask, request, jsonify, send_file, send_from_directory
from downloader import extract_metadata, download_audio, AUDIO_PATH, search_youtube
from lyrics import fetch_lyrics
from vocal_remover import separate, INSTRUMENTAL_PATH

app = Flask(__name__, static_folder="static", static_url_path="/static")

separation_state = {"status": "idle"}
separation_gen = 0  # incremented on each new song load; threads check before writing state

_whisper_model = None
_whisper_lock = _threading.Lock()


def get_whisper_model():
    """Lazy-load faster-whisper large-v3-turbo on CUDA. Thread-safe."""
    global _whisper_model
    with _whisper_lock:
        if _whisper_model is None:
            from faster_whisper import WhisperModel
            _whisper_model = WhisperModel(
                "large-v3-turbo",
                device="cuda",
                compute_type="float16"
            )
    return _whisper_model


@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/player")
def player():
    return send_from_directory("static", "player.html")


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

    # Always reset and auto-kick separation for the new song
    global separation_gen
    separation_gen += 1
    my_gen = separation_gen
    separation_state["status"] = "processing"
    separation_state.pop("error", None)

    def run():
        try:
            separate(AUDIO_PATH)
            if separation_gen == my_gen:
                separation_state["status"] = "done"
        except Exception as e:
            if separation_gen == my_gen:
                separation_state["status"] = "error"
                separation_state["error"] = str(e)

    threading.Thread(target=run, daemon=True).start()

    lyrics = fetch_lyrics(title, artist)
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
    lyrics = fetch_lyrics(title, artist)
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


@app.route('/transcribe', methods=['POST'])
def transcribe():
    """Accept a raw WAV body, transcribe with Whisper, return {transcript}."""
    wav_bytes = request.data
    if len(wav_bytes) < 100:
        return jsonify(transcript='')
    try:
        model = get_whisper_model()
        audio_buf = io.BytesIO(wav_bytes)
        segments, _ = model.transcribe(audio_buf, language='en', beam_size=1)
        text = ' '.join(s.text for s in segments).strip()
        return jsonify(transcript=text)
    except Exception:
        return jsonify(transcript=''), 503


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
