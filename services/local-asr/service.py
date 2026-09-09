import errno
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


MODEL_IDS = ("sensevoice-small-int8", "qwen3-asr-0.6b")
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
    def __init__(self, root, threads, maximum_seconds, timeout):
        self.root = root
        self.maximum_seconds = maximum_seconds
        self.timeout = timeout
        self.lock = threading.Lock()
        sense = root / "models" / "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
        qwen = root / "models" / "sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25"
        self.recognizers = {
            MODEL_IDS[0]: sherpa_onnx.OfflineRecognizer.from_sense_voice(
                model=str(sense / "model.int8.onnx"), tokens=str(sense / "tokens.txt"),
                num_threads=threads, provider="cpu", use_itn=True,
            ),
            MODEL_IDS[1]: sherpa_onnx.OfflineRecognizer.from_qwen3_asr(
                conv_frontend=str(qwen / "conv_frontend.onnx"), encoder=str(qwen / "encoder.int8.onnx"),
                decoder=str(qwen / "decoder.int8.onnx"), tokenizer=str(qwen / "tokenizer"),
                num_threads=threads, provider="cpu", max_total_len=512, max_new_tokens=256,
            ),
        }
        config = sherpa_onnx.VadModelConfig()
        config.silero_vad.model = str(root / "models" / "silero_vad.onnx")
        config.silero_vad.threshold = 0.5
        config.silero_vad.min_silence_duration = 0.5
        config.silero_vad.min_speech_duration = 0.2
        config.silero_vad.max_speech_duration = 18
        config.sample_rate = 16000
        config.num_threads = 1
        self.vad = sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=maximum_seconds + 2)

    def transcribe(self, audio, model, started):
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
            for index, (start, end) in enumerate(spans):
                if time.monotonic() - started > self.timeout:
                    raise InputError("本地识别超时，请缩短录音后重试。", 504)
                left = 0 if index == 0 else (spans[index - 1][1] + start) // 2
                right = len(audio) if index + 1 == len(spans) else (end + spans[index + 1][0]) // 2
                samples = audio[max(left, start - 3200):min(right, end + 3200)]
                if len(samples) > 20 * 16000:
                    raise InputError("语音分段异常，请缩短录音后重试。")
                stream = self.recognizers[model].create_stream()
                stream.accept_waveform(16000, samples)
                self.recognizers[model].decode_stream(stream)
                text = stream.result.text.strip()
                if not text or text in {"<sil>", "/sil"}:
                    raise InputError("有声片段未能完整识别，请换一个模型或重新录制。")
                texts.append(text)
            return {"text": "\n".join(texts), "model": model, "segments": len(texts)}
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
        self.reply(200, {"ready": True, "models": list(MODEL_IDS), "offline": True}) if self.path == "/health" else self.reply(404, {"error": "Not found"})

    def do_POST(self):
        engine = self.server.engine
        model = self.path.removeprefix("/transcribe/")
        if self.path != "/transcribe/" + model or model not in MODEL_IDS:
            self.reply(400, {"error": "请选择有效的本地语音模型。"})
            return
        if not engine.lock.acquire(blocking=False):
            self.reply(429, {"error": "本地语音服务正在处理其他录音，请稍后重试。"})
            return
        started = time.monotonic()
        try:
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
            result = engine.transcribe(audio, model, started)
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
    engine = Engine(root, configuration["threads"], configuration["maximum_audio_seconds"], configuration["request_timeout_seconds"])
    os.umask(0o077)
    with Server(str(socket_path), Handler) as server:
        server.engine = engine
        os.chmod(socket_path, 0o600)
        signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
        print("Local ASR ready: SenseVoiceSmall INT8, Qwen3-ASR-0.6B; network isolated", flush=True)
        try:
            server.serve_forever(poll_interval=0.2)
        finally:
            socket_path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
