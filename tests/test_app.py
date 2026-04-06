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


def test_load_does_not_trigger_separation_when_disabled(client):
    """Vocal separation is temporarily disabled — POST /load should leave status idle
    and not start any background thread.
    TODO: rename back to test_load_triggers_separation_automatically and restore
    assertions when re-enabling separation."""
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
    assert not mock_thread.called, "Thread should NOT start while separation is disabled"
    assert app_module.separation_state["status"] == "idle"


@pytest.mark.skip(reason="Vocal separation disabled temporarily — re-enable with separation thread")
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


def test_transcribe_returns_transcript(client, monkeypatch):
    """Valid WAV body → 200 with transcript key."""
    mock_model = MagicMock()
    mock_segment = MagicMock()
    mock_segment.text = 'hello world'
    mock_segment.words = []
    mock_model.transcribe.return_value = ([mock_segment], None)

    _app_module._whisper_state = 'ready'
    monkeypatch.setattr(_app_module, '_whisper_model', mock_model)
    try:
        resp = client.post('/transcribe', data=_make_wav(),
                           content_type='audio/wav')
    finally:
        _app_module._whisper_state = 'idle'

    assert resp.status_code == 200
    data = json.loads(resp.data)
    assert data['transcript'] == 'hello world'


def test_transcribe_empty_body_returns_empty(client, monkeypatch):
    """Body shorter than 100 bytes → 200 with empty transcript (model is not called)."""
    mock_model = MagicMock()
    _app_module._whisper_state = 'ready'
    monkeypatch.setattr(_app_module, '_whisper_model', mock_model)
    try:
        resp = client.post('/transcribe', data=b'tooshort',
                           content_type='audio/wav')
    finally:
        _app_module._whisper_state = 'idle'
    assert resp.status_code == 200
    data = json.loads(resp.data)
    assert data['transcript'] == ''
    mock_model.transcribe.assert_not_called()


def test_transcribe_whisper_exception_returns_500(client, monkeypatch):
    """If the model raises during transcription, return 500 (not 503)."""
    mock_model = MagicMock()
    mock_model.transcribe.side_effect = RuntimeError('CUDA OOM')

    _app_module._whisper_state = 'ready'
    monkeypatch.setattr(_app_module, '_whisper_model', mock_model)
    try:
        resp = client.post('/transcribe', data=_make_wav(),
                           content_type='audio/wav')
    finally:
        _app_module._whisper_state = 'idle'

    assert resp.status_code == 500


def test_transcribe_with_hint(client, monkeypatch):
    """When hint is provided via header, it should be passed as initial_prompt."""
    mock_model = MagicMock()
    mock_segment = MagicMock()
    mock_segment.text = 'gonna be alright'
    mock_segment.words = []
    mock_model.transcribe.return_value = ([mock_segment], None)

    _app_module._whisper_state = 'ready'
    monkeypatch.setattr(_app_module, '_whisper_model', mock_model)
    try:
        resp = client.post('/transcribe', data=_make_wav(),
                           content_type='audio/wav',
                           headers={'X-Lyric-Hint': 'gonna be alright'})
    finally:
        _app_module._whisper_state = 'idle'

    assert resp.status_code == 200
    call_kwargs = mock_model.transcribe.call_args
    assert call_kwargs[1].get('initial_prompt') == 'gonna be alright'


def test_transcribe_without_hint(client, monkeypatch):
    """Without hint header, initial_prompt should not be passed."""
    mock_model = MagicMock()
    mock_segment = MagicMock()
    mock_segment.text = 'going to be all right'
    mock_segment.words = []
    mock_model.transcribe.return_value = ([mock_segment], None)

    _app_module._whisper_state = 'ready'
    monkeypatch.setattr(_app_module, '_whisper_model', mock_model)
    try:
        resp = client.post('/transcribe', data=_make_wav(),
                           content_type='audio/wav')
    finally:
        _app_module._whisper_state = 'idle'

    assert resp.status_code == 200
    call_kwargs = mock_model.transcribe.call_args
    assert 'initial_prompt' not in call_kwargs[1] or call_kwargs[1]['initial_prompt'] is None


def test_transcribe_returns_word_timestamps(client, monkeypatch):
    """Response should include words array with text, start, end."""
    mock_model = MagicMock()
    mock_segment = MagicMock()
    mock_segment.text = 'hello world'
    mock_word1 = MagicMock()
    mock_word1.word = 'hello'
    mock_word1.start = 0.0
    mock_word1.end = 0.5
    mock_word2 = MagicMock()
    mock_word2.word = 'world'
    mock_word2.start = 0.5
    mock_word2.end = 1.0
    mock_segment.words = [mock_word1, mock_word2]
    mock_model.transcribe.return_value = ([mock_segment], None)

    _app_module._whisper_state = 'ready'
    monkeypatch.setattr(_app_module, '_whisper_model', mock_model)
    try:
        resp = client.post('/transcribe', data=_make_wav(),
                           content_type='audio/wav')
    finally:
        _app_module._whisper_state = 'idle'

    assert resp.status_code == 200
    data = json.loads(resp.data)
    assert 'words' in data
    assert len(data['words']) == 2
    assert data['words'][0] == {'text': 'hello', 'start': 0.0, 'end': 0.5}
    assert data['words'][1] == {'text': 'world', 'start': 0.5, 'end': 1.0}


# ---------------------------------------------------------------------------
# /whisper-status tests
# ---------------------------------------------------------------------------
import app as _app_module

def test_whisper_status_returns_loading(client):
    original = _app_module._whisper_state
    _app_module._whisper_state = 'loading'
    try:
        resp = client.get('/whisper-status')
        assert resp.status_code == 200
        data = resp.get_json()
        assert data['status'] == 'loading'
        assert 'model' in data
        assert 'device' in data
        assert data['error'] is None
    finally:
        _app_module._whisper_state = original

def test_whisper_status_returns_ready(client):
    original = _app_module._whisper_state
    _app_module._whisper_state = 'ready'
    try:
        resp = client.get('/whisper-status')
        data = resp.get_json()
        assert data['status'] == 'ready'
        assert data['error'] is None
    finally:
        _app_module._whisper_state = original

def test_whisper_status_returns_error_with_reason(client):
    orig_state = _app_module._whisper_state
    orig_err   = _app_module._whisper_error
    _app_module._whisper_state = 'error'
    _app_module._whisper_error = 'CUDA not available'
    try:
        resp = client.get('/whisper-status')
        data = resp.get_json()
        assert data['status'] == 'error'
        assert 'CUDA' in data['error']
    finally:
        _app_module._whisper_state = orig_state
        _app_module._whisper_error = orig_err


# ---------------------------------------------------------------------------
# /transcribe readiness gate + 503/500 split tests
# ---------------------------------------------------------------------------
def test_transcribe_returns_503_when_model_not_ready(client):
    original = _app_module._whisper_state
    _app_module._whisper_state = 'loading'
    try:
        resp = client.post('/transcribe', data=b'\x00' * 200,
                           content_type='audio/wav')
        assert resp.status_code == 503
        data = resp.get_json()
        assert data['status'] == 'loading'
    finally:
        _app_module._whisper_state = original

def test_transcribe_returns_500_on_transcription_error(client, monkeypatch):
    _app_module._whisper_state = 'ready'
    bad_model = type('M', (), {'transcribe': staticmethod(lambda *a, **k: (_ for _ in ()).throw(RuntimeError('GPU OOM')))})()
    monkeypatch.setattr(_app_module, '_whisper_model', bad_model)
    try:
        resp = client.post('/transcribe', data=b'\x00' * 200,
                           content_type='audio/wav')
        assert resp.status_code == 500
    finally:
        _app_module._whisper_state = 'idle'
