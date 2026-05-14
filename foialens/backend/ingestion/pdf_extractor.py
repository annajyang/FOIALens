import io
import re
from dataclasses import dataclass

import pdfplumber


@dataclass
class PagedText:
    page: int
    text: str


def extract_pages(buffer: bytes) -> list[PagedText]:
    pages: list[PagedText] = []
    with pdfplumber.open(io.BytesIO(buffer)) as pdf:
        for i, page in enumerate(pdf.pages, 1):
            raw = page.extract_text() or ""
            text = _clean(raw)
            if text.strip():
                pages.append(PagedText(page=i, text=text))
    return pages


def _clean(text: str) -> str:
    text = text.replace("\f", " ")
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)   # rejoin hyphenated line breaks
    text = re.sub(r" {3,}", "  ", text)
    return text.strip()
