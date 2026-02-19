from unittest.mock import patch, MagicMock
from downloader import extract_metadata, download_audio, parse_title_artist


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
