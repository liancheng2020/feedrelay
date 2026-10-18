import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("uploads", Path(__file__).resolve().parents[1] / "scripts/youtube-uploads.py")
uploads = importlib.util.module_from_spec(spec)
spec.loader.exec_module(uploads)


class UploadTests(unittest.TestCase):
    def test_metadata_only(self):
        channel = "UC" + "a" * 22
        options = {}
        calls = []
        info = {"channel_id": channel, "entries": [
            {"id": "abcdefghijk", "channel_id": channel, "title": "Synthetic", "timestamp": 1700000000},
            {"id": "lmnopqrstuv", "channel_id": channel, "live_status": "is_upcoming"},
        ]}

        class FakeYoutubeDL:
            def __init__(self, value): options.update(value)
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def extract_info(self, url, download):
                calls.append((url, download))
                return info

        modules = {"yt_dlp": types.SimpleNamespace(YoutubeDL=FakeYoutubeDL),
                   "yt_dlp.globals": types.SimpleNamespace(plugin_dirs=types.SimpleNamespace(value=[]))}
        with patch.dict(sys.modules, modules):
            result = uploads.extract({"channel": channel, "node": "/trusted/node", "proxy": ""})
            self.assertEqual(len(result["entries"]), 1)
            self.assertEqual(calls, [("https://www.youtube.com/playlist?list=UU" + channel[2:], False)])
            self.assertTrue(options["skip_download"])
            self.assertEqual(options["playlistend"], 15)
            self.assertFalse(options["ignoreerrors"])
            self.assertIsNone(options["cookiefile"])
            self.assertIsNone(options["cookiesfrombrowser"])
            self.assertEqual(options["remote_components"], [])
            info["channel_id"] = "other"
            with self.assertRaises(ValueError):
                uploads.extract({"channel": channel, "node": "/trusted/node"})
            with self.assertRaises(ValueError):
                uploads.extract({"channel": "https://evil.test", "node": "/trusted/node"})


if __name__ == "__main__":
    unittest.main()
