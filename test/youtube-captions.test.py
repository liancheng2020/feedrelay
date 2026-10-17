"""Offline contract for the Python adapter; no yt-dlp dependency or network required."""
import importlib.util
import io
import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("captions", Path(__file__).resolve().parents[1] / "scripts/youtube-captions.py")
captions = importlib.util.module_from_spec(spec)
spec.loader.exec_module(captions)


class CaptionTests(unittest.TestCase):
    def test_tracks(self):
        row = {"ext": "json3", "url": "https://www.youtube.com/api/timedtext"}
        self.assertEqual(captions.select_track({"subtitles": {"en": [row]}})[:2], ("manual", "en"))
        self.assertEqual(captions.select_track({"automatic_captions": {"zh-Hans": [row], "en-orig": [row]}})[:2], ("automatic", "en-orig"))
        with self.assertRaisesRegex(captions.CaptionError, "YOUTUBE_NO_CAPTIONS"):
            captions.select_track({"subtitles": {"en": [{"ext": "vtt"}]}})

    def test_library_contract_and_stream_limit(self):
        options = {}
        info = {"id": "abcdefghijk", "duration": 120, "subtitles": {"en": [{"ext": "json3", "url": "https://www.youtube.com/api/timedtext"}]}}
        raw = json.dumps({"events": [{"tStartMs": 0, "dDurationMs": 1000, "segs": [{"utf8": "Synthetic"}]}]}).encode()

        class FakeYoutubeDL:
            def __init__(self, value): options.update(value)
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def extract_info(self, url, download):
                self.assert_url = url
                if download is not False: raise AssertionError("media forbidden")
                return info
            def urlopen(self, url): return io.BytesIO(raw)

        modules = {"yt_dlp": types.SimpleNamespace(YoutubeDL=FakeYoutubeDL), "yt_dlp.globals": types.SimpleNamespace(plugin_dirs=types.SimpleNamespace(value=["forbidden"]))}
        with patch.dict(sys.modules, modules), patch("importlib.metadata.version", side_effect=lambda name: "2026.8.19" if name == "yt-dlp" else "0.8.0"):
            value = captions.extract("abcdefghijk", "", "/trusted/node")
            self.assertEqual(value["cues"][0]["text"], "Synthetic")
            self.assertTrue(options["skip_download"])
            self.assertIsNone(options["cookiesfrombrowser"])
            self.assertEqual(options["remote_components"], [])
            self.assertEqual(options["proxy"], "")
            self.assertFalse(options["usenetrc"])
            raw = b"x" * 2_000_001
            with self.assertRaisesRegex(captions.CaptionError, "TOO_LARGE"):
                captions.extract("abcdefghijk", "", "/trusted/node")


if __name__ == "__main__":
    unittest.main()
