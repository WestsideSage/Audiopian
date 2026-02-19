import os
import yt_dlp


TEMP_DIR = os.path.join(os.path.dirname(__file__), "temp")
AUDIO_PATH = os.path.join(TEMP_DIR, "audio.webm")


def parse_title_artist(title: str, uploader: str) -> tuple[str, str]:
    """Parse artist and title from a YouTube title string.

    If title contains " - ", split on the first occurrence:
        "Black Moon - Who Got Da Props" -> ("Black Moon", "Who Got Da Props")
    Otherwise fall back to uploader as artist and full title as title.
    """
    if " - " in title:
        parts = title.split(" - ", 1)
        return parts[0].strip(), parts[1].strip()
    return uploader, title


def extract_metadata(url: str) -> dict:
    """Extract title and artist from a YouTube URL without downloading."""
    ydl_opts = {"quiet": True, "skip_download": True}
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)

    raw_title = info.get("title", "Unknown Title")
    uploader = info.get("uploader", "Unknown Artist")

    # Prefer explicit artist tag; fall back to title-dash-split; fall back to uploader
    if info.get("artist"):
        artist = info["artist"]
        title = raw_title
    else:
        artist, title = parse_title_artist(raw_title, uploader)

    return {"title": title, "artist": artist}


def download_audio(url: str) -> str:
    """Download audio from YouTube URL to temp/audio.webm. Returns file path."""
    os.makedirs(TEMP_DIR, exist_ok=True)
    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": AUDIO_PATH,
        "quiet": True,
        "overwrites": True,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([url])
    return AUDIO_PATH


def search_youtube(query: str) -> list[dict]:
    """Search YouTube for up to 5 results. Returns list of result dicts."""
    ydl_opts = {
        "quiet": True,
        "skip_download": True,
        "extract_flat": True,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(f"ytsearch5:{query}", download=False)

    results = []
    for entry in (info.get("entries") or []):
        if not entry:
            continue
        results.append({
            "id": entry.get("id", ""),
            "title": entry.get("title", ""),
            "uploader": entry.get("uploader") or entry.get("channel", ""),
            "duration": entry.get("duration") or 0,
            "url": f"https://www.youtube.com/watch?v={entry.get('id', '')}",
        })
    return results
