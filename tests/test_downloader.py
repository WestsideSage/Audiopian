from unittest.mock import patch
from downloader import extract_metadata, download_audio, parse_title_artist, search_youtube


def test_extract_metadata_returns_title_and_artist():
    mock_info = {
        "title": "Bohemian Rhapsody",
        "artist": "Queen",
        "uploader": "Queen Official",
    }
    with patch("downloader.yt_dlp.YoutubeDL") as MockYDL:
        instance = MockYDL.return_value.__enter__.return_value
        instance.extract_info.return_value = mock_info
        result = extract_metadata("https://youtube.com/watch?v=fake")
    assert result["title"] == "Bohemian Rhapsody"
    assert result["artist"] == "Queen"


def test_extract_metadata_falls_back_to_uploader():
    mock_info = {
        "title": "Some Song",
        "uploader": "FallbackChannel",
    }
    with patch("downloader.yt_dlp.YoutubeDL") as MockYDL:
        instance = MockYDL.return_value.__enter__.return_value
        instance.extract_info.return_value = mock_info
        result = extract_metadata("https://youtube.com/watch?v=fake")
    assert result["artist"] == "FallbackChannel"


def test_parse_title_artist_with_dash():
    artist, title = parse_title_artist("Black Moon - Who Got Da Props", "SomeChannel")
    assert artist == "Black Moon"
    assert title == "Who Got Da Props"


def test_parse_title_artist_no_dash_falls_back_to_uploader():
    artist, title = parse_title_artist("WhoGotDaProps", "SomeChannel")
    assert artist == "SomeChannel"
    assert title == "WhoGotDaProps"


def test_parse_title_artist_multiple_dashes_splits_on_first():
    artist, title = parse_title_artist("Wu-Tang Clan - C.R.E.A.M.", "WuTangVEVO")
    assert artist == "Wu-Tang Clan"
    assert title == "C.R.E.A.M."


def test_extract_metadata_uses_dash_split_when_no_artist_field():
    mock_info = {
        "title": "Black Moon - Who Got Da Props",
        "uploader": "SomeChannel",
    }
    with patch("downloader.yt_dlp.YoutubeDL") as MockYDL:
        instance = MockYDL.return_value.__enter__.return_value
        instance.extract_info.return_value = mock_info
        result = extract_metadata("https://youtube.com/watch?v=fake")
    assert result["artist"] == "Black Moon"
    assert result["title"] == "Who Got Da Props"


def test_search_youtube_returns_results():
    mock_info = {
        "entries": [
            {
                "id": "abc123",
                "title": "Song One",
                "uploader": "Artist A",
                "duration": 200,
            },
            {
                "id": "def456",
                "title": "Song Two",
                "uploader": "Artist B",
                "duration": 180,
            },
        ]
    }
    with patch("downloader.yt_dlp.YoutubeDL") as MockYDL:
        instance = MockYDL.return_value.__enter__.return_value
        instance.extract_info.return_value = mock_info
        results = search_youtube("some query")
    assert len(results) == 2
    assert results[0]["id"] == "abc123"
    assert results[0]["title"] == "Song One"
    assert results[0]["uploader"] == "Artist A"
    assert results[0]["duration"] == 200
    assert results[0]["url"] == "https://www.youtube.com/watch?v=abc123"
    assert results[1]["id"] == "def456"


def test_search_youtube_returns_empty_on_none_info():
    with patch("downloader.yt_dlp.YoutubeDL") as MockYDL:
        instance = MockYDL.return_value.__enter__.return_value
        instance.extract_info.return_value = None
        results = search_youtube("some query")
    assert results == []


def test_search_youtube_falls_back_channel_when_no_uploader():
    mock_info = {
        "entries": [
            {
                "id": "ghi789",
                "title": "Song Three",
                "channel": "Channel C",
                "duration": 210,
            },
        ]
    }
    with patch("downloader.yt_dlp.YoutubeDL") as MockYDL:
        instance = MockYDL.return_value.__enter__.return_value
        instance.extract_info.return_value = mock_info
        results = search_youtube("some query")
    assert len(results) == 1
    assert results[0]["uploader"] == "Channel C"


def test_download_audio_enables_node_js_runtime():
    """download_audio must enable a JS runtime so YouTube nsig solving works (avoids HTTP 403)."""
    with patch("downloader.yt_dlp.YoutubeDL") as MockYDL:
        download_audio("https://youtube.com/watch?v=fake")
    opts = MockYDL.call_args[0][0]
    assert opts.get("js_runtimes") == {"node": {}}


def test_extract_metadata_enables_node_js_runtime():
    """extract_metadata enables a JS runtime too, for consistent nsig handling."""
    with patch("downloader.yt_dlp.YoutubeDL") as MockYDL:
        instance = MockYDL.return_value.__enter__.return_value
        instance.extract_info.return_value = {"title": "T", "uploader": "U"}
        extract_metadata("https://youtube.com/watch?v=fake")
    opts = MockYDL.call_args[0][0]
    assert opts.get("js_runtimes") == {"node": {}}


def test_download_audio_uses_cookies_when_env_set(monkeypatch):
    """Setting YTDLP_COOKIES_BROWSER opts into authenticated downloads (anti-SABR)."""
    monkeypatch.setenv("YTDLP_COOKIES_BROWSER", "chrome")
    with patch("downloader.yt_dlp.YoutubeDL") as MockYDL:
        download_audio("https://youtube.com/watch?v=fake")
    opts = MockYDL.call_args[0][0]
    assert opts.get("cookiesfrombrowser") == ("chrome",)


def test_download_audio_no_cookies_by_default(monkeypatch):
    """Without the env var, no browser cookies are used (default behavior unchanged)."""
    monkeypatch.delenv("YTDLP_COOKIES_BROWSER", raising=False)
    with patch("downloader.yt_dlp.YoutubeDL") as MockYDL:
        download_audio("https://youtube.com/watch?v=fake")
    opts = MockYDL.call_args[0][0]
    assert "cookiesfrombrowser" not in opts
