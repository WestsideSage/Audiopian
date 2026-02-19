import json
import pytest
from unittest.mock import patch
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
    with patch("app.extract_metadata") as mock_meta,          patch("app.download_audio") as mock_dl,          patch("app.fetch_lyrics") as mock_lyrics:
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
    with patch("app.extract_metadata") as mock_meta,          patch("app.download_audio") as mock_dl,          patch("app.fetch_lyrics") as mock_lyrics:
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
