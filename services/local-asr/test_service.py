import io
import base64
import json
from collections import OrderedDict
from types import SimpleNamespace
import time
import unittest
import wave

import numpy as np

from service import decode_audio, Engine, InputError, parse_options
from pipeline import join_transcripts, normalize_hotwords, restore_punctuation, speech_windows


def wav_bytes(seconds):
    output = io.BytesIO()
    with wave.open(output, "wb") as destination:
        destination.setnchannels(1)
        destination.setsampwidth(2)
        destination.setframerate(16000)
        destination.writeframes(bytes(int(seconds * 32000)))
    return output.getvalue()


class ServiceTests(unittest.TestCase):
    def test_decode_silence(self):
        audio = decode_audio(wav_bytes(1), "wav", 300)
        self.assertEqual(audio.shape, (16000,))
        self.assertEqual(float(np.max(np.abs(audio))), 0)

    def test_reject_long_audio_without_silent_truncation(self):
        with self.assertRaises(InputError) as caught:
            decode_audio(wav_bytes(3), "wav", 1)
        self.assertEqual(caught.exception.status, 413)

    def test_reject_invalid_audio_and_demuxers(self):
        with self.assertRaises(InputError):
            decode_audio(b"broken", "webm", 300)
        with self.assertRaises(InputError) as caught:
            decode_audio(b"broken", "concat", 300)
        self.assertEqual(caught.exception.status, 400)

    def test_zero_audio_never_reaches_recognition(self):
        engine = Engine.__new__(Engine)
        result = engine.transcribe(np.zeros(16000, dtype=np.float32), "sensevoice-small-int8", time.monotonic())
        self.assertEqual(result["text"], "")
        self.assertEqual(result["segments"], 0)

    def test_missing_speech_segment_is_not_silently_dropped(self):
        engine = Engine.__new__(Engine)
        engine.timeout = 110
        engine.chunk_seconds = 16
        engine.punctuator = None
        calls = []
        pending = [True]
        engine.vad = SimpleNamespace(reset=lambda: calls.append("reset"), accept_waveform=lambda _: None,
            flush=lambda: None, empty=lambda: not pending, front=SimpleNamespace(start=0, samples=[0.1] * 1600), pop=lambda: pending.pop())
        stream = SimpleNamespace(accept_waveform=lambda *_: None, result=SimpleNamespace(text=""))
        engine.recognizer = lambda *_: SimpleNamespace(create_stream=lambda: stream, decode_stream=lambda _: None)
        with self.assertRaises(InputError):
            engine.transcribe(np.ones(1600, dtype=np.float32), "model", time.monotonic())
        self.assertEqual(calls, ["reset", "reset"])

    def test_short_pauses_stay_in_one_recognition_window(self):
        engine = Engine.__new__(Engine)
        engine.timeout = 110
        engine.chunk_seconds = 16
        engine.punctuator = None
        pending = [SimpleNamespace(start=4000, samples=[0.1] * 2000), SimpleNamespace(start=7000, samples=[0.1] * 2000)]
        class FakeVad:
            def reset(self): pass
            def accept_waveform(self, chunk): pass
            def flush(self): pass
            def empty(self): return not pending
            @property
            def front(self): return pending[0]
            def pop(self): pending.pop(0)
        engine.vad = FakeVad()
        segments = []
        stream = SimpleNamespace(accept_waveform=lambda rate, samples: segments.append(samples), result=SimpleNamespace(text="识别"))
        engine.recognizer = lambda *_: SimpleNamespace(create_stream=lambda: stream, decode_stream=lambda _: None)
        engine.transcribe(np.arange(16000, dtype=np.float32), "model", time.monotonic())
        self.assertEqual(len(segments), 1)
        np.testing.assert_array_equal(segments[0], np.arange(800, 12200, dtype=np.float32))

    def test_long_windows_are_bounded_without_losing_speech(self):
        windows = speech_windows([(100, 1000000)], 1000000, 256000)
        self.assertEqual(windows[0][0], 0)
        self.assertEqual(windows[-1][1], 1000000)
        self.assertTrue(all(end - start <= 256000 for start, end in windows))
        self.assertTrue(all(first[1] == second[0] for first, second in zip(windows, windows[1:])))

    def test_separate_windows_never_overlap(self):
        windows = speech_windows([(5000, 14000), (70000, 120000)], 140000, 64000)
        self.assertEqual(len(windows), 2)
        self.assertLessEqual(windows[0][1], windows[1][0])

    def test_audio_boundaries_do_not_introduce_newlines(self):
        self.assertEqual(join_transcripts(["我觉得", "可以继续说"]), "我觉得可以继续说")
        self.assertEqual(join_transcripts(["use FastAPI", "and Python"]), "use FastAPI and Python")

    def test_punctuation_cannot_change_words_case_or_numbers(self):
        for result in ["可以删除文件。", "不要删除三个文件。", "不要删除API文件。"]:
            original = "不要删除两个api文件"
            text, applied = restore_punctuation(original, SimpleNamespace(add_punctuation=lambda _: result))
            self.assertEqual(text, original)
            self.assertFalse(applied)
        self.assertEqual(restore_punctuation("不要删除文件", SimpleNamespace(add_punctuation=lambda _: "不要删除文件。")), ("不要删除文件。", True))
        self.assertEqual(restore_punctuation("do not delete", SimpleNamespace(add_punctuation=lambda _: "donot delete。")), ("do not delete", False))

    def test_code_versions_paths_and_negative_numbers_are_preserved(self):
        def forbidden(_):
            self.fail("Technical text must bypass punctuation reconstruction")
        for text in ["Python 3.12", "保留src/api.ts", "设置为-5", "don't delete", "访问http://localhost", '保留"foo"字符串']:
            self.assertEqual(restore_punctuation(text, SimpleNamespace(add_punctuation=forbidden)), (text, False))

    def test_options_are_bounded_and_reject_unknown_fields(self):
        self.assertEqual(normalize_hotwords([" Python ", "Python", "FastAPI"]), ["Python", "FastAPI"])
        for value in [{"hotwords": ["a"] * 21}, {"hotwords": ["a" * 41]}, {"hotwords": ["<system>"]}, {"hotwords": ["a" * 39 + str(index) for index in range(5)]}, {"url": "remote"}, {"punctuation": "rewrite"}]:
            with self.assertRaises(InputError):
                parse_options(base64.b64encode(json.dumps(value).encode()).decode())
        parsed = parse_options(base64.b64encode(json.dumps({"hotwords": ["Codex"], "punctuation": "original"}).encode()).decode())
        self.assertEqual(parsed, {"hotwords": ["Codex"], "punctuation": "original"})

    def test_model_cache_is_bounded_and_hotwords_do_not_leak_between_requests(self):
        from unittest.mock import patch
        engine = Engine.__new__(Engine)
        engine.recognizers = OrderedDict()
        engine.root, engine.threads = "unused", 4
        with patch("service.create_recognizer", side_effect=lambda *args: object()) as factory:
            first = engine.recognizer("fun-asr-nano-fp32", ["Alpha"])
            second = engine.recognizer("fun-asr-nano-fp32", ["Beta"])
            self.assertIsNot(first, second)
            self.assertIs(first, engine.recognizer("fun-asr-nano-fp32", ["Alpha"]))
            engine.recognizer("qwen3-asr-0.6b", [])
            self.assertEqual(len(engine.recognizers), 2)
            self.assertNotIn(("fun-asr-nano-fp32", ("Beta",)), engine.recognizers)
            self.assertEqual(factory.call_count, 3)


if __name__ == "__main__":
    unittest.main()
