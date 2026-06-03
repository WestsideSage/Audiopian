import json
import os
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


def test_load_local_saves_file_and_returns_lyrics(client):
    import os
    import app as _am
    with patch("app.fetch_lyrics") as mock_lyrics:
        mock_lyrics.return_value = [{"time": 0.5, "text": "yo"}]
        resp = client.post(
            "/load-local",
            data={"title": "Local Song", "artist": "Me",
                  "file": (io.BytesIO(b"ID3 fake audio bytes"), "mysong.mp3")},
            content_type="multipart/form-data",
        )
    assert resp.status_code == 200
    data = json.loads(resp.data)
    assert data["title"] == "Local Song"
    assert data["artist"] == "Me"
    assert data["lyrics"] == [{"time": 0.5, "text": "yo"}]
    assert data["audioUrl"] == "/audio"
    saved = os.path.join(_am.TEMP_DIR, "audio.mp3")
    assert os.path.exists(saved)
    os.remove(saved)


def test_load_local_missing_file_returns_400(client):
    resp = client.post("/load-local", data={"title": "X", "artist": "Y"},
                       content_type="multipart/form-data")
    assert resp.status_code == 400


def test_load_local_rejects_unsupported_extension(client):
    resp = client.post(
        "/load-local",
        data={"title": "X", "artist": "Y",
              "file": (io.BytesIO(b"data"), "notes.txt")},
        content_type="multipart/form-data",
    )
    assert resp.status_code == 400


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


def test_transcribe_ignores_lyric_hint(client, monkeypatch):
    """A lyric hint header must NOT be passed to the model (no answer-key prompt)."""
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
    call_kwargs = mock_model.transcribe.call_args[1]
    assert 'initial_prompt' not in call_kwargs
    assert call_kwargs.get('vad_filter') is True
    assert call_kwargs.get('condition_on_previous_text') is False


def test_transcribe_sets_no_speech_guards(client, monkeypatch):
    """Transcription enables vad_filter / no_speech_threshold and disables cross-chunk conditioning."""
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
    call_kwargs = mock_model.transcribe.call_args[1]
    assert 'initial_prompt' not in call_kwargs
    assert call_kwargs.get('vad_filter') is True
    assert call_kwargs.get('no_speech_threshold') == 0.6
    assert call_kwargs.get('condition_on_previous_text') is False


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
    orig_state = _app_module._whisper_state
    orig_error = _app_module._whisper_error
    _app_module._whisper_state = 'loading'
    _app_module._whisper_error = None
    try:
        resp = client.get('/whisper-status')
        assert resp.status_code == 200
        data = resp.get_json()
        assert data['status'] == 'loading'
        assert 'model' in data
        assert 'device' in data
        assert data['error'] is None
    finally:
        _app_module._whisper_state = orig_state
        _app_module._whisper_error = orig_error

def test_whisper_status_returns_ready(client):
    orig_state = _app_module._whisper_state
    orig_error = _app_module._whisper_error
    _app_module._whisper_state = 'ready'
    _app_module._whisper_error = None
    try:
        resp = client.get('/whisper-status')
        data = resp.get_json()
        assert data['status'] == 'ready'
        assert data['error'] is None
    finally:
        _app_module._whisper_state = orig_state
        _app_module._whisper_error = orig_error

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


def test_whisper_status_reports_prewarm_failure_from_first_request(client, monkeypatch):
    orig_state = _app_module._whisper_state
    orig_error = _app_module._whisper_error
    orig_once = _app_module._prewarm_once

    _app_module._whisper_state = 'idle'
    _app_module._whisper_error = None
    _app_module._prewarm_once = False

    def fake_prewarm():
        _app_module._whisper_state = 'error'
        _app_module._whisper_error = 'prewarm failed in test'

    class ImmediateThread:
        def __init__(self, target=None, daemon=None):
            self._target = target

        def start(self):
            self._target()

    monkeypatch.setattr(_app_module, "_prewarm_whisper", fake_prewarm)
    monkeypatch.setattr(_app_module.threading, "Thread", ImmediateThread)

    try:
        resp = client.get('/whisper-status')
        assert resp.status_code == 200
        data = resp.get_json()
        assert data['status'] == 'error'
        assert data['error'] == 'prewarm failed in test'
    finally:
        _app_module._whisper_state = orig_state
        _app_module._whisper_error = orig_error
        _app_module._prewarm_once = orig_once


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


def test_transcribe_cuda_runtime_error_retries_cpu(client, monkeypatch):
    class BadCudaModel:
        def transcribe(self, *args, **kwargs):
            raise RuntimeError('Library cublas64_12.dll is not found or cannot be loaded')

    class CpuModel:
        def transcribe(self, *args, **kwargs):
            segment = MagicMock()
            segment.text = 'cpu fallback worked'
            segment.words = []
            return [segment], None

    original_state = _app_module._whisper_state
    original_model = _app_module._whisper_model
    original_device = _app_module._whisper_active_device
    original_compute = _app_module._whisper_active_compute

    loaded = []

    def fake_load_model(device, compute_type):
        loaded.append((device, compute_type))
        return CpuModel()

    _app_module._whisper_state = 'ready'
    _app_module._whisper_model = BadCudaModel()
    _app_module._whisper_active_device = 'cuda'
    _app_module._whisper_active_compute = 'float16'
    monkeypatch.setattr(_app_module, '_load_whisper_model', fake_load_model)

    try:
        resp = client.post('/transcribe', data=_make_wav(),
                           content_type='audio/wav')
        data = resp.get_json()
        assert resp.status_code == 200
        assert data['transcript'] == 'cpu fallback worked'
        assert loaded == [('cpu', _app_module.WHISPER_CPU_COMPUTE)]
        assert _app_module._whisper_active_device == 'cpu'
        assert _app_module._whisper_state == 'ready'
    finally:
        _app_module._whisper_state = original_state
        _app_module._whisper_model = original_model
        _app_module._whisper_active_device = original_device
        _app_module._whisper_active_compute = original_compute


def test_realtime_transcription_session_disabled_for_local_provider(client):
    original_provider = _app_module._whisper_active_provider
    original_state = _app_module._whisper_state
    _app_module._whisper_active_provider = 'local'
    _app_module._whisper_state = 'ready'
    try:
        resp = client.post('/realtime-transcription-session', json={})
        assert resp.status_code == 404
    finally:
        _app_module._whisper_active_provider = original_provider
        _app_module._whisper_state = original_state


def test_realtime_transcription_session_returns_openai_session(client, monkeypatch):
    original_provider = _app_module._whisper_active_provider
    original_state = _app_module._whisper_state
    _app_module._whisper_active_provider = 'openai_realtime'
    _app_module._whisper_state = 'ready'

    def fake_create_session(prompt=None):
        assert prompt == 'test lyric hint'
        return {
            'id': 'sess_test',
            'client_secret': {
                'value': 'ek_test',
                'expires_at': 123,
            },
        }

    monkeypatch.setattr(_app_module, '_create_openai_realtime_transcription_session', fake_create_session)

    try:
        resp = client.post('/realtime-transcription-session', json={'prompt': 'test lyric hint'})
        data = resp.get_json()
        assert resp.status_code == 200
        assert data['id'] == 'sess_test'
        assert data['client_secret']['value'] == 'ek_test'
    finally:
        _app_module._whisper_active_provider = original_provider
        _app_module._whisper_state = original_state


def test_create_openai_realtime_transcription_session_uses_client_secret_schema(monkeypatch):
    captured = {}

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {'value': 'ek_direct', 'session': {'type': 'transcription'}}

    def fake_post(url, headers=None, json=None, timeout=None):
        captured['url'] = url
        captured['headers'] = headers
        captured['json'] = json
        captured['timeout'] = timeout
        return FakeResponse()

    monkeypatch.setattr(_app_module, 'OPENAI_API_KEY', 'sk-test')
    monkeypatch.setattr(_app_module.requests, 'post', fake_post)

    result = _app_module._create_openai_realtime_transcription_session(prompt='test lyric hint')

    assert result['value'] == 'ek_direct'
    assert captured['url'].endswith('/v1/realtime/client_secrets')
    assert captured['json']['session']['type'] == 'transcription'
    assert captured['json']['session']['audio']['input']['transcription']['model'] == _app_module.OPENAI_TRANSCRIBE_MODEL
    assert 'prompt' not in captured['json']['session']['audio']['input']['transcription']
    assert 'turn_detection' not in captured['json']['session']['audio']['input']
    assert captured['json']['expires_after']['seconds'] == 600


def test_realtime_transcription_session_sets_delay_when_configured(monkeypatch):
    """OPENAI_TRANSCRIBE_DELAY (minimal|low|medium|high|xhigh) tunes gpt-realtime-whisper's
    latency/accuracy tradeoff. Opt-in: omitted from the request unless configured."""
    captured = {}

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {'value': 'ek', 'session': {'type': 'transcription'}}

    def fake_post(url, headers=None, json=None, timeout=None):
        captured['json'] = json
        return FakeResponse()

    monkeypatch.setattr(_app_module, 'OPENAI_API_KEY', 'sk-test')
    monkeypatch.setattr(_app_module.requests, 'post', fake_post)

    # default (unset) -> field omitted; OpenAI's default delay applies
    monkeypatch.setattr(_app_module, 'OPENAI_TRANSCRIBE_DELAY', '')
    _app_module._create_openai_realtime_transcription_session()
    assert 'delay' not in captured['json']['session']['audio']['input']['transcription']

    # configured -> passed through
    monkeypatch.setattr(_app_module, 'OPENAI_TRANSCRIBE_DELAY', 'low')
    _app_module._create_openai_realtime_transcription_session()
    assert captured['json']['session']['audio']['input']['transcription']['delay'] == 'low'


def test_transcribe_returns_409_for_realtime_provider(client):
    original_provider = _app_module._whisper_active_provider
    original_state = _app_module._whisper_state
    _app_module._whisper_active_provider = 'openai_realtime'
    _app_module._whisper_state = 'ready'
    try:
        resp = client.post('/transcribe', data=_make_wav(), content_type='audio/wav')
        data = resp.get_json()
        assert resp.status_code == 409
        assert data['error'] == 'use realtime transcription session'
    finally:
        _app_module._whisper_active_provider = original_provider
        _app_module._whisper_state = original_state


def test_telemetry_rejects_invalid_json(client):
    resp = client.post("/telemetry", data=b"not json", content_type="application/json")
    assert resp.status_code == 400


def test_telemetry_writes_file(client):
    # Far-future date so the artifact is obviously test data; cleaned up below.
    payload = {
        "meta": {"startedAt": "2099-01-02T03:04:05.000Z", "endedAt": "2099-01-02T03:09:00.000Z"},
        "summary": {"scores": {"honestLyricPct": 50}},
    }
    resp = client.post("/telemetry", json=payload)
    assert resp.status_code == 200
    data = json.loads(resp.data)
    assert data["ok"] is True
    from app import _HERE
    full = os.path.join(_HERE, data["path"])
    try:
        assert os.path.exists(full)
        assert "2099-01-02" in data["path"]
        with open(full, encoding="utf-8") as f:
            saved = json.load(f)
        assert saved["meta"]["startedAt"] == "2099-01-02T03:04:05.000Z"
    finally:
        if os.path.exists(full):
            os.remove(full)
        d = os.path.dirname(full)
        if os.path.isdir(d) and not os.listdir(d):
            os.rmdir(d)
