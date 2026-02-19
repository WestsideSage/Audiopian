from lyrics import parse_lrc, fetch_lyrics


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
