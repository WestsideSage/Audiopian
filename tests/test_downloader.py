from unittest.mock import patch, MagicMock
from downloader import extract_metadata, download_audio


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
