from pathlib import Path

import sherpa_onnx


MODEL_IDS = ("sensevoice-small-int8", "qwen3-asr-0.6b", "fun-asr-nano-fp32")


def create_recognizer(root, model, threads, hotwords=()):
    root = Path(root) / "models"
    common = {"num_threads": threads, "provider": "cpu"}
    if model == "sensevoice-small-int8":
        directory = root / "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
        return sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=str(directory / "model.int8.onnx"), tokens=str(directory / "tokens.txt"), use_itn=True, **common,
        )
    if model == "qwen3-asr-0.6b":
        directory = root / "sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25"
        return sherpa_onnx.OfflineRecognizer.from_qwen3_asr(
            conv_frontend=str(directory / "conv_frontend.onnx"), encoder=str(directory / "encoder.int8.onnx"),
            decoder=str(directory / "decoder.int8.onnx"), tokenizer=str(directory / "tokenizer"),
            max_total_len=512, max_new_tokens=256, **common,
        )
    if model == "fun-asr-nano-fp32":
        directory = root / "sherpa-onnx-funasr-nano-2025-12-30"
        return sherpa_onnx.OfflineRecognizer.from_funasr_nano(
            encoder_adaptor=str(directory / "encoder_adaptor.onnx"), llm=str(directory / "llm.fp32.onnx"),
            embedding=str(directory / "embedding.onnx"), tokenizer=str(directory / "Qwen3-0.6B"),
            max_new_tokens=256, temperature=1e-6, top_p=0.8, seed=42, language="", itn=True,
            hotwords=",".join(hotwords), **common,
        )
    raise ValueError("Unknown local ASR model")


def create_punctuator(root, threads):
    model = Path(root) / "models" / "sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8" / "model.int8.onnx"
    if not model.is_file():
        return None
    configuration = sherpa_onnx.OfflinePunctuationConfig()
    configuration.model.ct_transformer = str(model)
    configuration.model.num_threads = min(threads, 4)
    return sherpa_onnx.OfflinePunctuation(configuration)
