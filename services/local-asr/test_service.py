import io
from types import SimpleNamespace
import time
import unittest
import wave

import numpy as np

from service import decode_audio, Engine, InputError


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
        calls = []
        pending = [True]
        engine.vad = SimpleNamespace(reset=lambda: calls.append("reset"), accept_waveform=lambda _: None,
            flush=lambda: None, empty=lambda: not pending, front=SimpleNamespace(start=0, samples=[0.1] * 1600), pop=lambda: pending.pop())
        stream = SimpleNamespace(accept_waveform=lambda *_: None, result=SimpleNamespace(text=""))
        engine.recognizers = {"model": SimpleNamespace(create_stream=lambda: stream, decode_stream=lambda _: None)}
        with self.assertRaises(InputError):
            engine.transcribe(np.ones(1600, dtype=np.float32), "model", time.monotonic())
        self.assertEqual(calls, ["reset", "reset"])

    def test_vad_padding_preserves_word_onsets_without_overlapping_segments(self):
        engine = Engine.__new__(Engine)
        engine.timeout = 110
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
        engine.recognizers = {"model": SimpleNamespace(create_stream=lambda: stream, decode_stream=lambda _: None)}
        engine.transcribe(np.arange(16000, dtype=np.float32), "model", time.monotonic())
        np.testing.assert_array_equal(segments[0], np.arange(800, 6500, dtype=np.float32))
        np.testing.assert_array_equal(segments[1], np.arange(6500, 12200, dtype=np.float32))


if __name__ == "__main__":
    unittest.main()
