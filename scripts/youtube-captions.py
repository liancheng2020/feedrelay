"""Anonymous captions only. Invoked with Python isolated mode by the local worker."""
import json
import re
import sys
from importlib.metadata import PackageNotFoundError
from urllib.parse import urlparse


class CaptionError(Exception):
    pass


def select_track(info):
    for kind, field in (("manual", "subtitles"), ("automatic", "automatic_captions")):
        tracks = {
            lang: next((t for t in rows if t.get("ext") == "json3"), None)
            for lang, rows in (info.get(field) or {}).items()
            if re.fullmatch(r"[a-zA-Z0-9-]{1,24}", lang) and lang != "live_chat"
        }
        tracks = {lang: row for lang, row in tracks.items() if row}
        original = next((lang for lang in tracks if lang.endswith("-orig")), None)
        order = ([original] if kind == "automatic" and original else []) + [
            "zh-Hans", "zh-Hant", "zh", "en-orig", "en"
        ]
        language = next((lang for lang in order if lang in tracks), next(iter(tracks), None))
        if language:
            return kind, language, tracks[language]["url"]
    raise CaptionError("YOUTUBE_NO_CAPTIONS")


def extract(video_id, proxy, node):
    from importlib.metadata import version
    from yt_dlp import YoutubeDL
    from yt_dlp.globals import plugin_dirs

    if version("yt-dlp") != "2026.8.19" or version("yt-dlp-ejs") != "0.8.0":
        raise CaptionError("YOUTUBE_DEPENDENCY_VERSION")
    plugin_dirs.value = []

    class Quiet:
        def debug(self, *_): pass
        def warning(self, *_): pass
        def error(self, *_): pass

    with YoutubeDL({
        "logger": Quiet(), "quiet": True, "no_warnings": True,
        "skip_download": True, "noplaylist": True, "cachedir": False,
        "cookiefile": None, "cookiesfrombrowser": None, "usenetrc": False,
        "proxy": proxy, "socket_timeout": 8, "retries": 0, "extractor_retries": 0,
        "remote_components": [], "js_runtimes": {"node": {"path": node}},
        "ignore_no_formats_error": True,
    }) as ydl:
        info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
        if info.get("id") != video_id or info.get("is_live"):
            raise CaptionError("YOUTUBE_VIDEO_UNAVAILABLE")
        kind, language, url = select_track(info)
        parsed = urlparse(url)
        if parsed.scheme != "https" or parsed.hostname not in ("www.youtube.com", "youtube.com"):
            raise CaptionError("YOUTUBE_CAPTION_URL_BLOCKED")
        with ydl.urlopen(url) as response:
            raw = response.read(2_000_001)
        if len(raw) > 2_000_000:
            raise CaptionError("YOUTUBE_CAPTION_TOO_LARGE")
        data = json.loads(raw)
        cues = [
            {"start": event.get("tStartMs"), "duration": event.get("dDurationMs"),
             "text": "".join(s.get("utf8", "") for s in event["segs"])}
            for event in data.get("events", []) if isinstance(event.get("segs"), list)
        ]
        return {"videoId": video_id, "language": language, "kind": kind,
                "duration": info.get("duration"), "cues": cues}


def main():
    try:
        request = json.loads(sys.stdin.read(4096))
        if not re.fullmatch(r"[a-zA-Z0-9_-]{11}", request["id"]):
            raise CaptionError("YOUTUBE_INVALID_VIDEO_ID")
        print(json.dumps(extract(request["id"], request["proxy"], request["node"]), ensure_ascii=True))
    except CaptionError as error:
        print(json.dumps({"error": str(error)}))
    except (ImportError, PackageNotFoundError):
        print(json.dumps({"error": "YOUTUBE_DEPENDENCY_MISSING"}))
    except Exception as error:
        # Never print signed URLs, proxy details or raw provider messages.
        message = str(error).lower()
        code = "YOUTUBE_EXTRACTION_FAILED"
        if "429" in message or "too many requests" in message:
            code = "YOUTUBE_RATE_LIMITED"
        elif any(s in message for s in ("sign in", "not a bot", "login required", "403", "po token")):
            code = "YOUTUBE_ACCESS_BLOCKED"
        elif any(s in message for s in ("timed out", "connection", "network", "getaddrinfo", "name resolution")):
            code = "YOUTUBE_NETWORK_ERROR"
        print(json.dumps({"error": code}))


if __name__ == "__main__":
    main()
