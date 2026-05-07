import logging
import re
import requests

log = logging.getLogger(__name__)

LRCLIB_SEARCH_URL = "https://lrclib.net/api/search"
LRCLIB_TIMEOUT_SECONDS = 10
LRCLIB_MAX_ATTEMPTS = 2


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


def _token_overlap(a: str, b: str) -> float:
    """Proportion of shared tokens between two strings (case-insensitive)."""
    ta = set(re.split(r'\W+', a.lower())) - {''}
    tb = set(re.split(r'\W+', b.lower())) - {''}
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / max(len(ta), len(tb))


def _score_candidate(result: dict, title: str, artist: str, duration: int) -> float:
    """Score a lrclib candidate by title/artist/duration match."""
    score = 0.0

    # Title similarity
    cand_title = result.get("trackName", "")
    if cand_title:
        score += _token_overlap(cand_title, title) * 3.0

    # Artist similarity
    cand_artist = result.get("artistName", "")
    if cand_artist:
        score += _token_overlap(cand_artist, artist) * 3.0

    # Duration proximity (within 10s = full credit, decays linearly)
    if duration and result.get("duration"):
        diff = abs(result["duration"] - duration)
        if diff <= 10:
            score += 2.0
        elif diff <= 30:
            score += 1.0 * (1 - (diff - 10) / 20)

    # Prefer synced lyrics over plain
    if result.get("syncedLyrics"):
        score += 1.0

    return score


def fetch_lyrics(title: str, artist: str, duration: int = 0) -> list[dict]:
    """Search lrclib.net for timed lyrics. Returns parsed list or empty list.

    Ranks candidates by title/artist/duration similarity instead of
    returning the first parseable result.
    """
    query = f"{title} {artist}".strip()
    last_error = None
    for attempt in range(1, LRCLIB_MAX_ATTEMPTS + 1):
        try:
            resp = requests.get(
                LRCLIB_SEARCH_URL,
                params={"q": query},
                timeout=LRCLIB_TIMEOUT_SECONDS,
            )
            break
        except requests.exceptions.RequestException as exc:
            last_error = exc
            if attempt >= LRCLIB_MAX_ATTEMPTS:
                log.exception("Failed to fetch lyrics for %s - %s", title, artist)
                return []
            log.warning("LRCLIB timed out for %s - %s; retrying", title, artist)
    else:
        if last_error:
            log.exception("Failed to fetch lyrics for %s - %s", title, artist)
        return []

    try:
        resp.raise_for_status()
        results = resp.json()

        # Score and rank candidates
        scored = []
        for result in results:
            lrc = result.get("syncedLyrics") or ""
            if not lrc:
                continue
            parsed = parse_lrc(lrc)
            if not parsed:
                continue
            s = _score_candidate(result, title, artist, duration)
            scored.append((s, parsed))

        if not scored:
            return []

        # Return the highest-scoring candidate
        scored.sort(key=lambda x: x[0], reverse=True)
        return scored[0][1]
    except Exception:
        log.exception("Failed to fetch lyrics for %s - %s", title, artist)
        return []
