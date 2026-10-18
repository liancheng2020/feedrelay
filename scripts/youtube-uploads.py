"""Bounded public upload metadata fallback; no media, cookies or account access."""
import json
import re
import sys
from urllib.parse import urlparse


def extract(request):
    channel = request["channel"]
    proxy = request.get("proxy", "")
    if not re.fullmatch(r"UC[a-zA-Z0-9_-]{22}", channel):
        raise ValueError("invalid channel")
    if proxy:
        parsed = urlparse(proxy)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("invalid proxy")
    from yt_dlp import YoutubeDL
    from yt_dlp.globals import plugin_dirs
    plugin_dirs.value = []

    class Quiet:
        def debug(self, *_): pass
        def warning(self, *_): pass
        def error(self, *_): pass

    with YoutubeDL({
        "logger": Quiet(), "quiet": True, "skip_download": True,
        "extract_flat": False, "playlistend": 15, "lazy_playlist": True,
        "cachedir": False, "cookiefile": None, "cookiesfrombrowser": None,
        "usenetrc": False, "proxy": proxy, "socket_timeout": 8,
        "retries": 0, "extractor_retries": 0, "ignoreerrors": False,
        "remote_components": [], "ignore_no_formats_error": True,
        "js_runtimes": {"node": {"path": request["node"]}},
    }) as ydl:
        info = ydl.extract_info(
            "https://www.youtube.com/playlist?list=UU" + channel[2:], download=False)
        if info.get("channel_id") != channel:
            raise ValueError("channel mismatch")
        entries = []
        for entry in info["entries"]:
            if entry.get("is_live") or entry.get("live_status") == "is_upcoming":
                continue
            entries.append({
                "id": entry.get("id"), "channel": entry.get("channel_id"),
                "title": entry.get("title"), "author": entry.get("channel", ""),
                "description": (entry.get("description") or "")[:20000],
                "timestamp": entry.get("timestamp"),
            })
            if len(entries) == 15:
                break
        return {"channel": channel, "entries": entries}


if __name__ == "__main__":
    try:
        print(json.dumps(extract(json.loads(sys.stdin.read(4096))), ensure_ascii=True))
    except ImportError:
        print(json.dumps({"error": "YOUTUBE_DEPENDENCY_MISSING"}))
    except Exception:
        # Provider diagnostics may contain signed URLs; keep only a stable error code.
        print(json.dumps({"error": "YOUTUBE_UPLOADS_UNAVAILABLE"}))
