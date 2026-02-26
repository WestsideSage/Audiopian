import json
import pytest
from unittest.mock import patch, MagicMock
from app import app


@pytest.fixture
def client():
    app.config["TESTING"] = True
    with app.test_client() as client:
        yield client


def test_index_returns_200(client):
    resp = client.get("/")
    assert resp.status_code == 200


def test_load_missing_url(client):
    resp = client.post("/load", json={})
    assert resp.status_code == 400
    data = json.loads(resp.data)
    assert "error" in data


def test_load_success(client):
    with patch("app.extract_metadata") as mock_meta, \
         patch("app.download_audio") as mock_dl, \
         patch("app.fetch_lyrics") as mock_lyrics, \
         patch("threading.Thread"):          # prevent real thread
        mock_meta.return_value = {"title": "Test Song", "artist": "Test Artist"}
        mock_dl.return_value = "/fake/path/audio.webm"
        mock_lyrics.return_value = [{"time": 1.0, "text": "Hello"}]
        resp = client.post("/load", json={"url": "https://youtube.com/watch?v=fake"})
    assert resp.status_code == 200
    data = json.loads(resp.data)
    assert data["title"] == "Test Song"
    assert data["artist"] == "Test Artist"
    assert data["lyrics"] == [{"time": 1.0, "text": "Hello"}]
    assert data["audioUrl"] == "/audio"


def test_load_no_lyrics(client):
    with patch("app.extract_metadata") as mock_meta, \
         patch("app.download_audio") as mock_dl, \
         patch("app.fetch_lyrics") as mock_lyrics, \
         patch("threading.Thread"):          # prevent real thread
        mock_meta.return_value = {"title": "Obscure Song", "artist": "Nobody"}
        mock_dl.return_value = "/fake/path/audio.webm"
        mock_lyrics.return_value = []
        resp = client.post("/load", json={"url": "https://youtube.com/watch?v=fake"})
    assert resp.status_code == 200
    data = json.loads(resp.data)
    assert data["lyrics"] == []
    assert "lyricsError" in data


def test_retry_lyrics_success(client):
    with patch("app.fetch_lyrics") as mock_lyrics:
        mock_lyrics.return_value = [{"time": 1.0, "text": "Line one"}]
        resp = client.post("/retry-lyrics", json={"title": "My Song", "artist": "Me"})
    assert resp.status_code == 200
    data = json.loads(resp.data)
    assert data["lyrics"] == [{"time": 1.0, "text": "Line one"}]


def test_retry_lyrics_missing_params(client):
    resp = client.post("/retry-lyrics", json={})
    assert resp.status_code == 400


def test_separate_starts_processing(client):
    with patch("app.separate") as mock_sep:
        mock_sep.return_value = "/fake/instrumental.wav"
        resp = client.post("/separate")
    assert resp.status_code == 200
    data = json.loads(resp.data)
    assert data["status"] == "processing"


def test_separate_status_returns_state(client):
    import app as app_module
    app_module.separation_state["status"] = "done"
    resp = client.get("/separate-status")
    assert resp.status_code == 200
    data = json.loads(resp.data)
    assert data["status"] == "done"
    assert data["audioUrl"] == "/instrumental"
    # Reset
    app_module.separation_state["status"] = "idle"


def test_search_returns_results(client):
    with patch("app.search_youtube") as mock_search:
        mock_search.return_value = [
            {"id": "abc", "title": "Test Song", "uploader": "TestChannel",
             "duration": 200, "url": "https://youtube.com/watch?v=abc"}
        ]
        resp = client.get("/search?q=test+song")
    assert resp.status_code == 200
    data = json.loads(resp.data)
    assert len(data) == 1
    assert data[0]["title"] == "Test Song"


def test_search_missing_query(client):
    resp = client.get("/search")
    assert resp.status_code == 400


def test_load_triggers_separation_automatically(client):
    """POST /load should auto-start vocal separation in the background."""
    import app as app_module
    app_module.separation_state["status"] = "idle"
    with patch("app.extract_metadata") as mock_meta, \
         patch("app.download_audio") as mock_dl, \
         patch("app.fetch_lyrics") as mock_lyrics, \
         patch("threading.Thread") as mock_thread:
        mock_meta.return_value = {"title": "Test", "artist": "Artist"}
        mock_dl.return_value = "/fake/path"
        mock_lyrics.return_value = []
        resp = client.post("/load", json={"url": "https://youtube.com/watch?v=fake"})
    assert resp.status_code == 200
    assert mock_thread.called, "Thread should have been started for separation"
    assert app_module.separation_state["status"] == "processing"
    # Reset for other tests
    app_module.separation_state["status"] = "idle"


def test_stale_separation_thread_does_not_overwrite_new_song_status(client):
    """When a second song is loaded, the first song's separation thread completing
    should NOT set separation_state to 'done' (stale generation must be ignored)."""
    import app as app_module

    run_fns = []

    def fake_thread(target=None, daemon=None):
        run_fns.append(target)
        return MagicMock()

    # Load Song A
    with patch("app.extract_metadata") as meta, \
         patch("app.download_audio"), \
         patch("app.fetch_lyrics") as lyrics, \
         patch("threading.Thread", side_effect=fake_thread):
        meta.return_value = {"title": "Song A", "artist": "Artist A"}
        lyrics.return_value = []
        client.post("/load", json={"url": "https://youtube.com/watch?v=a"})

    # Load Song B (should increment generation counter)
    with patch("app.extract_metadata") as meta, \
         patch("app.download_audio"), \
         patch("app.fetch_lyrics") as lyrics, \
         patch("threading.Thread", side_effect=fake_thread):
        meta.return_value = {"title": "Song B", "artist": "Artist B"}
        lyrics.return_value = []
        client.post("/load", json={"url": "https://youtube.com/watch?v=b"})

    assert len(run_fns) == 2, "Two threads should have been created"

    # Song A's thread completes (stale) — must NOT set status to 'done'
    with patch("app.separate"):
        run_fns[0]()

    assert app_module.separation_state["status"] == "processing", \
        "Stale thread should not have set status='done' after a newer song was loaded"

    # Cleanup
    app_module.separation_state["status"] = "idle"


import struct
import wave
import io


def _make_wav(num_samples=32000, sample_rate=16000):
    """Create a minimal valid 16kHz mono WAV with silence."""
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(b'\x00\x00' * num_samples)
    return buf.getvalue()


def test_transcribe_returns_transcript(client):
    """Valid WAV body → 200 with transcript key."""
    mock_model = MagicMock()
    mock_segment = MagicMock()
    mock_segment.text = 'hello world'
    mock_model.transcribe.return_value = ([mock_segment], None)

    with patch('app.get_whisper_model', return_value=mock_model):
        resp = client.post('/transcribe', data=_make_wav(),
                           content_type='audio/wav')

    assert resp.status_code == 200
    data = json.loads(resp.data)
    assert data['transcript'] == 'hello world'


def test_transcribe_empty_body_returns_empty(client):
    """Body shorter than 100 bytes → 200 with empty transcript, no model call."""
    with patch('app.get_whisper_model') as mock_get:
        resp = client.post('/transcribe', data=b'tooshort',
                           content_type='audio/wav')

    assert resp.status_code == 200
    data = json.loads(resp.data)
    assert data['transcript'] == ''
    mock_get.assert_not_called()


def test_transcribe_whisper_exception_returns_503(client):
    """If the model raises, return 503 with empty transcript."""
    mock_model = MagicMock()
    mock_model.transcribe.side_effect = RuntimeError('CUDA OOM')

    with patch('app.get_whisper_model', return_value=mock_model):
        resp = client.post('/transcribe', data=_make_wav(),
                           content_type='audio/wav')

    assert resp.status_code == 503
    data = json.loads(resp.data)
    assert data['transcript'] == ''
