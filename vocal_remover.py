import os
import glob
import shutil
import subprocess

TEMP_DIR = os.path.join(os.path.dirname(__file__), "temp")
DEMUCS_OUT_DIR = os.path.join(TEMP_DIR, "demucs_out")
INSTRUMENTAL_PATH = os.path.join(TEMP_DIR, "instrumental.wav")


def separate(input_path: str) -> str:
    """Run demucs htdemucs on input_path, return path to instrumental wav.

    Raises RuntimeError if demucs fails.
    """
    os.makedirs(DEMUCS_OUT_DIR, exist_ok=True)

    result = subprocess.run(
        [
            "python", "-m", "demucs",
            "--two-stems=vocals",
            "--name", "htdemucs",
            "--out", DEMUCS_OUT_DIR,
            input_path,
        ],
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        raise RuntimeError(f"demucs failed: {result.stderr}")

    # demucs outputs to: <out>/<model>/<stem_name>/no_vocals.wav
    pattern = os.path.join(DEMUCS_OUT_DIR, "htdemucs", "*", "no_vocals.wav")
    matches = glob.glob(pattern)
    if not matches:
        raise RuntimeError(f"demucs output not found at {pattern}")

    shutil.copy2(matches[0], INSTRUMENTAL_PATH)
    return INSTRUMENTAL_PATH
