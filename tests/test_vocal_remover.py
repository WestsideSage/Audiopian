import os
from unittest.mock import patch, MagicMock
from vocal_remover import separate, INSTRUMENTAL_PATH


def test_separate_returns_instrumental_path():
    """separate() should return the path to the instrumental file."""
    with patch("vocal_remover.subprocess.run") as mock_run, \
         patch("vocal_remover.shutil.copy2") as mock_copy, \
         patch("vocal_remover.glob.glob") as mock_glob:
        mock_run.return_value = MagicMock(returncode=0)
        mock_glob.return_value = ["temp/demucs_out/htdemucs_ft/audio/no_vocals.wav"]
        result = separate("temp/audio.webm")
    assert result == INSTRUMENTAL_PATH
    assert mock_copy.called


def test_separate_raises_on_demucs_failure():
    """separate() should raise RuntimeError if demucs exits non-zero."""
    with patch("vocal_remover.subprocess.run") as mock_run:
        mock_run.return_value = MagicMock(returncode=1, stderr="error")
        try:
            separate("temp/audio.webm")
            assert False, "Should have raised"
        except RuntimeError:
            pass
