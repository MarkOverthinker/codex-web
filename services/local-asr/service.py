import errno
import base64
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler
import json
import logging
import os
from pathlib import Path
import signal
import socket
import socketserver
import stat
import subprocess
import sys
import threading
import time
import tomllib

import imageio_ffmpeg
import numpy as np
import sherpa_onnx

from pipeline import join_transcripts, normalize_hotwords, restore_punctuation, speech_windows
from recognizers import MODEL_IDS, create_punctuator, create_recognizer

FORMATS = {"webm": "matroska", "ogg": "ogg", "mp4": "mov", "mp3": "mp3", "wav": "wav", "aac": "aac", "flac": "flac"}
MAX_UPLOAD_BYTES = 15 * 1024 * 1024


class InputError(Exception):
    def __init__(self, message, status=422):
        super().__init__(message)
        self.status = status


def decode_audio(payload, extension, maximum_seconds):
    if extension not in FORMATS:
        raise InputError("不支持的录音格式。", 400)
    try:
        converted = subprocess.run([
            imageio_ffmpeg.get_ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-nostdin",
            "-protocol_whitelist", "pipe", "-f", FORMATS[extension], "-i", "pipe:0",
            "-t", str(maximum_seconds + 1), "-vn", "-ac", "1", "-ar", "16000",
            "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1",
        ], input=payload, capture_output=True, timeout=20, check=True)
    except (subprocess.SubprocessError, OSError):
        raise InputError("无法解码录音，请重新录制。") from None
    if not converted.stdout or len(converted.stdout) % 2:
        raise InputError("录音为空或已损坏。")
    audio = np.frombuffer(converted.stdout, dtype="<i2").astype(np.float32) / 32768
    if len(audio) > maximum_seconds * 16000:
        raise InputError("录音超过5分钟，请分段录制。", 413)
    return audio


class Engine:
    def __init__(self, root, threads, maximum_seconds, timeout, models=None, chunk_seconds=16):
        self.root = root
        self.maximum_seconds = maximum_seconds
        self.timeout = timeout
        self.lock = threading.Lock()
        self.threads = threads
        self.models = tuple(models if models is not None else MODEL_IDS[:2])
        if not self.models or any(model not in MODEL_IDS for model in self.models):
            raise ValueError("Invalid enabled ASR models")
        if not 1 <= threads <= 16 or not 4 <= chunk_seconds <= 18:
            raise ValueError("Use 1–16 threads and 4–18 second recognition chunks")
        self.chunk_seconds = chunk_seconds
        self.recognizers = OrderedDict()
        self.punctuator = create_punctuator(root, threads)
        for model in self.models[:2]:
            self.recognizer(model, ())
        config = sherpa_onnx.VadModelConfig()
        config.silero_vad.model = str(root / "models" / "silero_vad.onnx")
        config.silero_vad.threshold = 0.5
        config.silero_vad.min_silence_duration = 0.5
        config.silero_vad.min_speech_duration = 0.2
        config.silero_vad.max_speech_duration = chunk_seconds - 0.5
        config.sample_rate = 16000
        config.num_threads = 1
        self.vad = sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=maximum_seconds + 2)

    def recognizer(self, model, hotwords):
        key = (model, tuple(hotwords) if model == "fun-asr-nano-fp32" else ())
        if key not in self.recognizers:
            if len(self.recognizers) >= 2:
                self.recognizers.popitem(last=False)
            self.recognizers[key] = create_recognizer(self.root, model, self.threads, hotwords)
        self.recognizers.move_to_end(key)
        return self.recognizers[key]

    def transcribe(self, audio, model, started, hotwords=(), punctuation="smart"):
        if float(np.max(np.abs(audio))) < 0.0001:
            return {"text": "", "model": model, "segments": 0}
        self.vad.reset()
        texts = []
        try:
            for offset in range(0, len(audio), 512):
                chunk = audio[offset:offset + 512]
                if len(chunk) < 512:
                    chunk = np.pad(chunk, (0, 512 - len(chunk)))
                self.vad.accept_waveform(chunk)
            self.vad.flush()
            spans = []
            while not self.vad.empty():
                segment = self.vad.front
                spans.append((segment.start, segment.start + len(segment.samples)))
                self.vad.pop()
            windows = speech_windows(spans, len(audio), int(self.chunk_seconds * 16000))
            recognizer = self.recognizer(model, hotwords) if windows else None
            for start, end in windows:
                if time.monotonic() - started > self.timeout:
                    raise InputError("本地识别超时，请缩短录音后重试。", 504)
                samples = audio[start:end]
                stream = recognizer.create_stream()
                if model == "qwen3-asr-0.6b" and hotwords:
                    stream.set_option("hotwords", ",".join(hotwords))
                stream.accept_waveform(16000, samples)
                recognizer.decode_stream(stream)
                text = stream.result.text.strip()
                if not text or text in {"<sil>", "/sil"}:
                    raise InputError("有声片段未能完整识别，请换一个模型或重新录制。")
                texts.append(text)
            text = join_transcripts(texts)
            punctuation_applied = False
            if punctuation == "smart":
                try:
                    text, punctuation_applied = restore_punctuation(text, self.punctuator)
                except Exception:
                    logging.warning("Punctuation restoration failed; preserving ASR text")
            return {"text": text, "model": model, "segments": len(texts), "punctuation_applied": punctuation_applied,
                "hotwords_applied": bool(hotwords) and model != "sensevoice-small-int8"}
        finally:
            self.vad.reset()


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    request_queue_size = 8


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def log_message(self, *args):
        pass

    def reply(self, status, body):
        encoded = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self):
        self.reply(200, {"ready": True, "models": list(self.server.engine.models), "offline": True, "punctuation": self.server.engine.punctuator is not None}) if self.path == "/health" else self.reply(404, {"error": "Not found"})

    def do_POST(self):
        engine = self.server.engine
        model = self.path.removeprefix("/transcribe/")
        if self.path != "/transcribe/" + model or model not in engine.models:
            self.reply(400, {"error": "请选择有效的本地语音模型。"})
            return
        if not engine.lock.acquire(blocking=False):
            self.reply(429, {"error": "本地语音服务正在处理其他录音，请稍后重试。"})
            return
        started = time.monotonic()
        try:
            options = parse_options(self.headers.get("X-ASR-Options", ""))
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                raise InputError("无效的录音长度。", 400) from None
            if self.headers.get("Transfer-Encoding") or not 0 < length <= MAX_UPLOAD_BYTES:
                raise InputError("录音为空或超过15 MiB限制。", 413)
            payload = self.rfile.read(length)
            if len(payload) != length:
                raise InputError("录音上传不完整。", 400)
            audio = decode_audio(payload, self.headers.get("X-Audio-Extension", ""), engine.maximum_seconds)
            result = engine.transcribe(audio, model, started, **options)
            self.reply(200, {**result, "audio_seconds": len(audio) / 16000})
        except InputError as error:
            self.reply(error.status, {"error": str(error)})
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass
        except Exception:
            logging.exception("Local ASR request failed")
            self.reply(503, {"error": "本地语音识别失败，请稍后重试。"})
        finally:
            engine.lock.release()


def parse_options(encoded):
    if not encoded:
        return {"hotwords": [], "punctuation": "smart"}
    try:
        if len(encoded) > 4096:
            raise ValueError()
        options = json.loads(base64.b64decode(encoded, validate=True))
        if not isinstance(options, dict) or set(options) - {"hotwords", "punctuation"}:
            raise ValueError()
        punctuation = options.get("punctuation", "smart")
        if punctuation not in {"smart", "original"}:
            raise ValueError()
        return {"hotwords": normalize_hotwords(options.get("hotwords", [])), "punctuation": punctuation}
    except (ValueError, TypeError, UnicodeError):
        raise InputError("无效的语音选项或术语列表。", 400) from None


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: service.py CONFIG.toml")
    with socket.socket() as probe:
        probe.settimeout(1)
        if probe.connect_ex(("192.0.2.1", 443)) != errno.ENETUNREACH:
            raise SystemExit("Start this service in an isolated network namespace (unshare --user --map-root-user --net).")
    config_path = Path(sys.argv[1]).resolve()
    configuration = tomllib.loads(config_path.read_text())
    root = (config_path.parent / configuration["root"]).resolve()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    socket_path = root / "asr.sock"
    if len(os.fsencode(socket_path)) > 107:
        raise SystemExit("Choose a shorter ASR root: Unix socket paths must fit within 107 bytes.")
    if socket_path.exists():
        if not stat.S_ISSOCK(socket_path.lstat().st_mode):
            raise SystemExit("Refusing to replace a non-socket path")
        with socket.socket(socket.AF_UNIX) as probe:
            if probe.connect_ex(str(socket_path)) == 0:
                raise SystemExit("ASR service is already running")
        socket_path.unlink()
    engine = Engine(root, configuration["threads"], configuration["maximum_audio_seconds"], configuration["request_timeout_seconds"],
        configuration.get("models"), configuration.get("chunk_seconds", 16))
    os.umask(0o077)
    with Server(str(socket_path), Handler) as server:
        server.engine = engine
        os.chmod(socket_path, 0o600)
        signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
        print("Local ASR ready; network isolated; models=" + ",".join(engine.models), flush=True)
        try:
            server.serve_forever(poll_interval=0.2)
        finally:
            socket_path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
