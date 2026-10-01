"""Count the tokens Cohere Embed v3 sees in one input (I2-4).

Bedrock's cohere.embed-english-v3 reads at most 512 tokens a text, and the
corpus builds send ``truncate: "END"``, so anything past token 512 is
silently in no embedding. The chunkers size text in characters, which does
not bound tokens: URLs, emoji and pasted blobs run near two or three
characters a token.

The model's tokenizer is BERT-uncased WordPiece (Cohere publishes it as
tokenizer.json; ``embed_vocab.txt`` is its 30,522-entry vocabulary in id
order). This module reimplements the four steps the tokenizer runs - BERT
normalizer, BERT pre-tokenizer, greedy WordPiece, and the [CLS]/[SEP]
template - so a build or gate can count truncated inputs without a
dependency or a Bedrock call. tests/test_embed_tokens.py pins the counts
Bedrock itself confirmed at the cap.
"""

from __future__ import annotations

import unicodedata
from functools import lru_cache
from pathlib import Path

# Cohere Embed v3's input limit, in tokens, [CLS] and [SEP] included.
COHERE_EMBED_MAX_TOKENS = 512
# WordPiece maps a word longer than this to a single [UNK].
_MAX_WORD_CHARS = 100
_VOCAB_PATH = Path(__file__).with_name("embed_vocab.txt")


@lru_cache(maxsize=1)
def _vocab() -> frozenset[str]:
    return frozenset(_VOCAB_PATH.read_text(encoding="utf-8").splitlines())


def _is_control(char: str) -> bool:
    if char in "\t\n\r":
        return False
    return unicodedata.category(char).startswith("C")


def _is_chinese(code: int) -> bool:
    return (
        0x4E00 <= code <= 0x9FFF
        or 0x3400 <= code <= 0x4DBF
        or 0x20000 <= code <= 0x2A6DF
        or 0x2A700 <= code <= 0x2B73F
        or 0x2B740 <= code <= 0x2B81F
        or 0x2B920 <= code <= 0x2CEAF
        or 0xF900 <= code <= 0xFAFF
        or 0x2F800 <= code <= 0x2FA1F
    )


def _is_punctuation(char: str) -> bool:
    code = ord(char)
    if 33 <= code <= 47 or 58 <= code <= 64 or 91 <= code <= 96 or 123 <= code <= 126:
        return True
    return unicodedata.category(char).startswith("P")


def _normalize(text: str) -> str:
    # BertNormalizer: clean_text, handle_chinese_chars, strip_accents (on,
    # because lowercase is), lowercase - in that order.
    out = []
    for char in text:
        code = ord(char)
        if code == 0 or code == 0xFFFD or _is_control(char):
            continue
        if char.isspace():
            out.append(" ")
        elif _is_chinese(code):
            out.append(f" {char} ")
        else:
            out.append(char)
    decomposed = unicodedata.normalize("NFD", "".join(out))
    stripped = "".join(c for c in decomposed if unicodedata.category(c) != "Mn")
    return stripped.lower()


def _words(text: str) -> list[str]:
    # BertPreTokenizer: split on whitespace, and every punctuation
    # character is a word of its own.
    words: list[str] = []
    for piece in text.split():
        current = []
        for char in piece:
            if _is_punctuation(char):
                if current:
                    words.append("".join(current))
                    current = []
                words.append(char)
            else:
                current.append(char)
        if current:
            words.append("".join(current))
    return words


def _wordpiece_count(word: str, vocab: frozenset[str]) -> int:
    if len(word) > _MAX_WORD_CHARS:
        return 1
    count = 0
    start = 0
    while start < len(word):
        end = len(word)
        while end > start:
            piece = word[start:end] if start == 0 else "##" + word[start:end]
            if piece in vocab:
                break
            end -= 1
        if end == start:
            return 1  # no piece matches: the whole word is one [UNK]
        count += 1
        start = end
    return count


def embed_token_count(text: str) -> int:
    """Tokens Cohere Embed v3 reads for ``text``, [CLS] and [SEP] included."""
    vocab = _vocab()
    return 2 + sum(_wordpiece_count(word, vocab) for word in _words(_normalize(text)))
