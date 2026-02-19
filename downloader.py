import os
import yt_dlp


TEMP_DIR = os.path.join(os.path.dirname(__file__), "temp")
AUDIO_PATH = os.path.join(TEMP_DIR, "audio.webm")


def extract_metadata(url: str) -> dict:
    """Extract title and artist from a YouTube URL without downloading."""
    ydl_opts = {"quiet": True, "skip_download": True}
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)
    return {
        "title": info.get("title", "Unknown Title"),
        "artist": info.get("artist") or info.get("uploader", "Unknown Artist"),
    }


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
