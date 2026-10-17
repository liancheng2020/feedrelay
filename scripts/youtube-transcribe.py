"""Public audio -> local ASR. No credentials, video frames or cloud transcription."""
import json
import logging
import math
import sys
import tempfile
from hashlib import sha256
from importlib.metadata import version
from pathlib import Path

MAX_BYTES = 100_000_000
MAX_SECONDS = 3600
last_progress = None


class TranscribeError(Exception):
    pass


def progress(stage, percent=0):
    global last_progress
    value = (stage, int(percent))
    if value != last_progress:
        print(json.dumps({"stage": stage, "percent": int(percent)}), file=sys.stderr, flush=True)
        last_progress = value


def check_duration(info):
    duration = info.get("duration")
    if info.get("is_live") or not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration <= 0:
        raise TranscribeError("YOUTUBE_VIDEO_UNAVAILABLE")
    if duration > MAX_SECONDS:
        raise TranscribeError("YOUTUBE_ASR_VIDEO_TOO_LONG")
    return duration


def transcribe(request):
    from yt_dlp import YoutubeDL
    from yt_dlp.globals import plugin_dirs
    from faster_whisper import WhisperModel
    if version("faster-whisper") != "1.2.1" or version("av") != "16.1.0":
        raise TranscribeError("YOUTUBE_DEPENDENCY_VERSION")
    plugin_dirs.value = []
    logging.disable(logging.CRITICAL)

    class Quiet:
        def debug(self, *_): pass
        def warning(self, *_): pass
        def error(self, *_): pass

    def hook(value):
        downloaded = value.get("downloaded_bytes") or 0
        total = value.get("total_bytes") or value.get("total_bytes_estimate") or 0
        if max(downloaded, total) > MAX_BYTES:
            raise TranscribeError("YOUTUBE_AUDIO_TOO_LARGE")
        progress("downloading", min(99, downloaded * 100 / total) if total else 0)

    with tempfile.TemporaryDirectory(prefix="feedrelay-audio-") as folder:
        with YoutubeDL({
            "logger": Quiet(), "quiet": True, "no_warnings": True,
            "noplaylist": True, "cachedir": False, "cookiefile": None,
            "cookiesfrombrowser": None, "usenetrc": False,
            "proxy": request["proxy"], "socket_timeout": 30, "retries": 2,
            "extractor_retries": 0, "fragment_retries": 2,
            "http_chunk_size": 1024 * 1024,
            "remote_components": [], "js_runtimes": {"node": {"path": request["node"]}},
            "format": "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio",
            "outtmpl": str(Path(folder) / "audio.%(ext)s"), "max_filesize": MAX_BYTES,
            "progress_hooks": [hook], "overwrites": False,
        }) as ydl:
            progress("downloading")
            info = ydl.extract_info(f'https://www.youtube.com/watch?v={request["id"]}', download=False)
            if info.get("id") != request["id"]:
                raise TranscribeError("YOUTUBE_VIDEO_UNAVAILABLE")
            duration = check_duration(info)
            if (info.get("filesize") or info.get("filesize_approx") or 0) > MAX_BYTES:
                raise TranscribeError("YOUTUBE_AUDIO_TOO_LARGE")
            ydl.process_info(info)
            audio = Path(ydl.prepare_filename(info))
            if not audio.is_file():
                raise TranscribeError("YOUTUBE_AUDIO_UNAVAILABLE")
            if audio.stat().st_size > MAX_BYTES:
                raise TranscribeError("YOUTUBE_AUDIO_TOO_LARGE")
        progress("transcribing")
        model = WhisperModel(request["model"], device="cpu", compute_type="int8",
                             cpu_threads=4, local_files_only=True)
        segments, detected = model.transcribe(str(audio), beam_size=3, vad_filter=True,
                                              condition_on_previous_text=False)
        cues = []
        size = 0
        for segment in segments:
            text = segment.text.strip()
            if not text:
                continue
            size += len(text.encode("utf-16-le")) // 2
            if size > 48000:
                raise TranscribeError("YOUTUBE_CAPTION_TOO_LONG")
            cues.append({"start": round(segment.start * 1000),
                         "duration": max(0, round((segment.end - segment.start) * 1000)), "text": text})
            progress("transcribing", min(99, segment.end * 100 / duration))
        if not cues:
            raise TranscribeError("YOUTUBE_ASR_EMPTY")
        return {"videoId": request["id"], "language": detected.language, "kind": "transcribed",
                "model": "faster-whisper-1.2.1-" + sha256((Path(request["model"]) / "config.json").read_bytes()).hexdigest()[:12],
                "duration": duration, "cues": cues}


if __name__ == "__main__":
    import re
    try:
        request = json.loads(sys.stdin.read(4096))
        if not re.fullmatch(r"[a-zA-Z0-9_-]{11}", request["id"]):
            raise TranscribeError("YOUTUBE_INVALID_VIDEO_ID")
        print(json.dumps(transcribe(request), ensure_ascii=True))
    except TranscribeError as error:
        print(json.dumps({"error": str(error)}))
    except ImportError:
        print(json.dumps({"error": "YOUTUBE_ASR_DEPENDENCY_MISSING"}))
    except Exception as error:
        message = str(error).lower()
        code = "YOUTUBE_ASR_FAILED"
        if any(word in message for word in ("403", "sign in", "not a bot", "po token")):
            code = "YOUTUBE_ACCESS_BLOCKED"
        elif "429" in message:
            code = "YOUTUBE_RATE_LIMITED"
        elif any(word in message for word in ("network", "connection", "timed out", "getaddrinfo")):
            code = "YOUTUBE_NETWORK_ERROR"
        print(json.dumps({"error": code}))
