import re
import unicodedata


def speech_windows(spans, sample_count, maximum_samples, padding=3200, maximum_gap=32000):
    groups = []
    for start, end in spans:
        start, end = max(0, start), min(sample_count, end)
        if end <= start:
            continue
        if groups and start - groups[-1][1] <= maximum_gap and end - groups[-1][0] <= maximum_samples - 2 * padding:
            groups[-1] = (groups[-1][0], end)
        else:
            groups.append((start, end))
    windows = []
    for index, (start, end) in enumerate(groups):
        left = 0 if index == 0 else (groups[index - 1][1] + start) // 2
        right = sample_count if index + 1 == len(groups) else (end + groups[index + 1][0]) // 2
        start, end = max(left, start - padding), min(right, end + padding)
        while end - start > maximum_samples:
            windows.append((start, start + maximum_samples))
            start += maximum_samples
        windows.append((start, end))
    return windows


def normalize_hotwords(value):
    if not isinstance(value, list) or len(value) > 20:
        raise ValueError("术语必须是最多20项的列表。")
    words = []
    for item in value:
        if not isinstance(item, str):
            raise ValueError("术语必须是文字。")
        word = item.strip()
        if not word or len(word) > 40 or re.search(r"[\x00-\x1f\x7f,，<>]", word):
            raise ValueError("每项术语应为1–40字，不能包含逗号、控制字符或尖括号。")
        if word not in words:
            words.append(word)
    if sum(len(word) for word in words) > 160:
        raise ValueError("术语总长度不能超过160字。")
    return words


def content_characters(text):
    return "".join(character for character in text if character.isalnum())


def content_tokens(text):
    return re.findall(r"[A-Za-z0-9]+|[^\W\dA-Za-z_]", text, flags=re.UNICODE)


def join_transcripts(texts):
    combined = ""
    for text in texts:
        text = text.strip()
        if not text:
            continue
        if combined and combined[-1].isascii() and combined[-1].isalnum() and text[0].isascii() and text[0].isalnum():
            combined += " "
        elif combined and combined[-1] in ".!?" and text[0].isascii() and text[0].isalnum():
            combined += " "
        combined += text
    return combined


def restore_punctuation(text, punctuator):
    if not text or punctuator is None:
        return text, False
    if re.search(r"\d[.,:/-]\d|\w[._/@\\'’\-]\w|://|[-−]\s*\d|[`<>=+*#\[\]{}\"“”]", text):
        return text, False
    plain = "".join(" " if unicodedata.category(character).startswith("P") else character for character in text)
    plain = re.sub(r"\s+", " ", plain).strip()
    if not plain:
        return text, False
    restored = punctuator.add_punctuation(plain).strip()
    if content_characters(restored) != content_characters(text) or content_tokens(restored) != content_tokens(text):
        return text, False
    if not re.search(r"[\u3400-\u9fff]", restored):
        restored = restored.translate(str.maketrans("，。？！；：", ",.?!;:"))
    return restored, True
