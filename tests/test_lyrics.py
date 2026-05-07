from lyrics import parse_lrc, fetch_lyrics, _score_candidate
from unittest.mock import MagicMock, patch
import requests


def test_parse_lrc_basic():
    lrc = "[00:10.00] Hello world\n[00:20.50] Goodbye world"
    result = parse_lrc(lrc)
    assert result == [
        {"time": 10.0, "text": "Hello world"},
        {"time": 20.5, "text": "Goodbye world"},
    ]


def test_parse_lrc_skips_metadata():
    lrc = "[ti:My Song]\n[ar:Artist]\n[00:05.00] First line"
    result = parse_lrc(lrc)
    assert result == [{"time": 5.0, "text": "First line"}]


def test_parse_lrc_empty():
    assert parse_lrc("") == []


def test_parse_lrc_ignores_blank_text():
    lrc = "[00:01.00] \n[00:02.00] Real line"
    result = parse_lrc(lrc)
    assert result == [{"time": 2.0, "text": "Real line"}]


def test_score_candidate_prefers_title_artist_overlap_and_synced_bonus():
    strong = {
        "trackName": "Free Your Mind",
        "artistName": "Wale",
        "duration": 180,
        "syncedLyrics": "[00:01.00] Free your mind",
    }
    weak = {
        "trackName": "Mind Games",
        "artistName": "Someone Else",
        "duration": 205,
        "syncedLyrics": "[00:01.00] Mind games",
    }

    assert _score_candidate(strong, "Free Your Mind", "Wale", 182) > _score_candidate(
        weak, "Free Your Mind", "Wale", 182
    )


def test_score_candidate_duration_credit_is_full_within_ten_seconds():
    candidate = {
        "trackName": "My Boy",
        "artistName": "Wale",
        "duration": 190,
        "syncedLyrics": "[00:01.00] My boy",
    }
    base = _score_candidate(candidate, "My Boy", "Wale", 200)
    farther = _score_candidate({**candidate, "duration": 220}, "My Boy", "Wale", 200)
    assert base > farther


def test_fetch_lyrics_prefers_best_ranked_synced_candidate():
    better_synced = {
        "trackName": "Read Your Mind",
        "artistName": "Avant",
        "duration": 200,
        "syncedLyrics": "[00:01.00] Read your mind",
    }
    worse_synced = {
        "trackName": "Mind Reader",
        "artistName": "Another Artist",
        "duration": 160,
        "syncedLyrics": "[00:01.00] Wrong lyrics",
    }
    plain_only = {
        "trackName": "Read Your Mind",
        "artistName": "Avant",
        "duration": 200,
        "plainLyrics": "Read your mind",
    }

    mock_response = MagicMock()
    mock_response.json.return_value = [worse_synced, plain_only, better_synced]
    mock_response.raise_for_status.return_value = None

    with patch("lyrics.requests.get", return_value=mock_response) as mock_get:
        result = fetch_lyrics("Read Your Mind", "Avant", duration=198)

    mock_get.assert_called_once()
    assert result == [{"time": 1.0, "text": "Read your mind"}]


def test_fetch_lyrics_returns_empty_when_no_synced_candidates_parse():
    mock_response = MagicMock()
    mock_response.json.return_value = [
        {"trackName": "No Sync", "artistName": "Artist", "plainLyrics": "plain only"},
        {"trackName": "Bad Sync", "artistName": "Artist", "syncedLyrics": "[ti:meta only]"},
    ]
    mock_response.raise_for_status.return_value = None

    with patch("lyrics.requests.get", return_value=mock_response):
        assert fetch_lyrics("Song", "Artist", duration=120) == []


def test_fetch_lyrics_retries_after_lrclib_timeout():
    mock_response = MagicMock()
    mock_response.json.return_value = [
        {
            "trackName": "Let It Fly",
            "artistName": "Lil Wayne",
            "duration": 210,
            "syncedLyrics": "[00:01.00] Let it fly",
        }
    ]
    mock_response.raise_for_status.return_value = None

    with patch(
        "lyrics.requests.get",
        side_effect=[requests.exceptions.ReadTimeout("timed out"), mock_response],
    ) as mock_get:
        result = fetch_lyrics("Let It Fly", "Lil Wayne", duration=210)

    assert mock_get.call_count == 2
    assert result == [{"time": 1.0, "text": "Let it fly"}]
