import io
import re
from dataclasses import dataclass, field

import pdfplumber

from .ocr import ocr_page, is_enabled as ocr_enabled

# Pages with fewer non-whitespace characters than this are treated as image-only.
_TEXT_THRESHOLD = 50


@dataclass
class PagedText:
    page: int
    text: str
    ocr_processed: bool = field(default=False)


async def extract_pages(buffer: bytes) -> list[PagedText]:
    """
    Extract text from all pages of a PDF.

    For pages with native text (pdfplumber finds >= _TEXT_THRESHOLD
    non-whitespace characters), text is used directly.

    For image-only pages (scanned PDFs), if ENABLE_OCR=true is set the page
    is rendered to PNG and passed to a vision model for transcription.
    Pages that yield no text and have OCR disabled are silently skipped —
    same behaviour as before OCR was added.
    """
    pages: list[PagedText] = []
    with pdfplumber.open(io.BytesIO(buffer)) as pdf:
        for i, page in enumerate(pdf.pages, 1):
            raw = page.extract_text() or ""
            text = _clean(raw)
            non_ws = len(text.replace(" ", "").replace("\n", ""))

            if non_ws >= _TEXT_THRESHOLD:
                pages.append(PagedText(page=i, text=text, ocr_processed=False))
            elif ocr_enabled():
                ocr_text = await ocr_page(buffer, i)
                if ocr_text:
                    pages.append(PagedText(page=i, text=ocr_text, ocr_processed=True))
            # else: page skipped (no text, OCR disabled) — existing behaviour

    return pages


def _clean(text: str) -> str:
    text = text.replace("\f", " ")
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)   # rejoin hyphenated line breaks
    text = re.sub(r" {3,}", "  ", text)
    return text.strip()
