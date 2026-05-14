import re
from dataclasses import dataclass

from .pdf_extractor import PagedText

TARGET_CHARS  = 2000
OVERLAP_CHARS = 200

ABBREVS = {
    "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "vs", "etc", "inc",
    "ltd", "corp", "co", "dept", "est", "approx", "govt", "no", "vol",
    "fig", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep",
    "oct", "nov", "dec", "u.s", "e.g", "i.e", "op", "cit", "cf", "al",
    "pp", "pg", "ch", "sec", "art", "para", "st", "ave", "blvd", "rd",
}


@dataclass
class RawChunk:
    content: str
    start_page: int
    end_page: int
    chunk_index: int
    token_count: int  # approximate: chars / 4


@dataclass
class _Tagged:
    text: str
    page: int


def chunk_pages(pages: list[PagedText]) -> list[RawChunk]:
    sentences = _tag_sentences(pages)
    return _group(sentences)


def _tag_sentences(pages: list[PagedText]) -> list[_Tagged]:
    result: list[_Tagged] = []
    for p in pages:
        for s in _split_sentences(p.text):
            s = s.strip()
            if s:
                result.append(_Tagged(text=s, page=p.page))
    return result


def _split_sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?])\s+(?=[A-Z0-9\"'“])", text)
    merged: list[str] = []
    i = 0
    while i < len(parts):
        part = parts[i]
        last_word = re.sub(r"[^a-zA-Z.]", "", part.rstrip().split()[-1] if part.strip() else "")
        last_word = last_word.lower().rstrip(".")
        if last_word in ABBREVS and i + 1 < len(parts):
            parts[i + 1] = part + " " + parts[i + 1]
        else:
            merged.append(part)
        i += 1
    return merged


def _group(sentences: list[_Tagged]) -> list[RawChunk]:
    chunks: list[RawChunk] = []
    buf: list[_Tagged] = []
    buf_len = 0
    idx = 0

    def flush() -> None:
        nonlocal buf, buf_len, idx
        if not buf:
            return
        content = " ".join(s.text for s in buf)
        chunks.append(RawChunk(
            content=content,
            start_page=buf[0].page,
            end_page=buf[-1].page,
            chunk_index=idx,
            token_count=round(len(content) / 4),
        ))
        idx += 1
        overlap_len = 0
        cutoff = len(buf) - 1
        while cutoff > 0 and overlap_len < OVERLAP_CHARS:
            overlap_len += len(buf[cutoff].text)
            cutoff -= 1
        buf = buf[cutoff + 1:]
        buf_len = sum(len(s.text) for s in buf)

    for sentence in sentences:
        if buf_len + len(sentence.text) > TARGET_CHARS and buf:
            flush()
        buf.append(sentence)
        buf_len += len(sentence.text)

    flush()
    return chunks
