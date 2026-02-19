import re
import requests


def parse_lrc(lrc_text: str) -> list[dict]:
    """Parse LRC format string into list of {time: float, text: str} dicts."""
    lines = []
    pattern = re.compile(r'^\[(\d+):(\d+\.\d+)\]\s*(.*)$')
    for line in lrc_text.splitlines():
        match = pattern.match(line.strip())
        if match:
            minutes = int(match.group(1))
            seconds = float(match.group(2))
            text = match.group(3).strip()
            if text:
                lines.append({"time": minutes * 60 + seconds, "text": text})
    return lines


def fetch_lyrics(title: str, artist: str) -> list[dict]:
    """Search lrclib.net for timed lyrics. Returns parsed list or empty list."""
    try:
        query = f"{title} {artist}".strip()
        resp = requests.get(
            "https://lrclib.net/api/search",
            params={"q": query},
            timeout=10
        )
        resp.raise_for_status()
        results = resp.json()
        for result in results:
            lrc = result.get("syncedLyrics") or result.get("plainLyrics", "")
            if lrc:
                parsed = parse_lrc(lrc)
                if parsed:
                    return parsed
        return []
    except Exception:
        return []
