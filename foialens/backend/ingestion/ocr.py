"""
OCR for image-only PDF pages.

Enabled when ENABLE_OCR=true is set in the environment.
Uses pypdfium2 (bundled PDFium, no system deps) to render pages to PNG,
then calls a vision model via OpenRouter to transcribe the visible text.

Cost: ~$0.01–0.02 per page depending on the vision model.
"""

import asyncio
import base64
import io
import os

_VISION_MODEL = os.getenv("OPENROUTER_VISION_MODEL", "google/gemini-flash-1.5")

_TRANSCRIPTION_PROMPT = (
    "Transcribe all text visible in this document page image. "
    "Preserve reading order. Include headers, tables, footnotes, and body text. "
    "Return only the transcribed text — no commentary, no markdown fences, no explanations."
)


def is_enabled() -> bool:
    return os.getenv("ENABLE_OCR", "").lower() in ("1", "true", "yes")


def _render_page_png(buffer: bytes, page_num: int) -> bytes:
    """Render a single PDF page to PNG bytes at 144 DPI (scale=2).
    Lazy-imports pypdfium2 so the package is optional when OCR is disabled.
    """
    import pypdfium2 as pdfium  # noqa: PLC0415

    doc = pdfium.PdfDocument(buffer)
    try:
        page = doc[page_num - 1]  # pypdfium2 uses 0-based indexing
        bitmap = page.render(scale=2.0)  # 144 DPI — good balance of quality vs size
        pil_image = bitmap.to_pil()
        buf = io.BytesIO()
        pil_image.save(buf, format="PNG")
        return buf.getvalue()
    finally:
        doc.close()


async def ocr_page(buffer: bytes, page_num: int) -> str | None:
    """
    OCR a single PDF page. Returns transcribed text or None if OCR is
    disabled, rendering fails, or the vision call returns empty content.
    """
    if not is_enabled():
        return None

    loop = asyncio.get_event_loop()
    try:
        png_bytes = await loop.run_in_executor(None, _render_page_png, buffer, page_num)
    except Exception as exc:
        print(f"[ocr] render failed p.{page_num}: {exc}", flush=True)
        return None

    b64 = base64.b64encode(png_bytes).decode()

    try:
        from openai import AsyncOpenAI
        client = AsyncOpenAI(
            base_url="https://openrouter.ai/api/v1",
            api_key=os.environ.get("OPENROUTER_API_KEY"),
        )
        response = await client.chat.completions.create(
            model=_VISION_MODEL,
            max_tokens=2048,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:image/png;base64,{b64}"},
                        },
                        {"type": "text", "text": _TRANSCRIPTION_PROMPT},
                    ],
                }
            ],
        )
        text = (response.choices[0].message.content or "").strip()
        if text:
            print(f"[ocr] p.{page_num}: {len(text)} chars transcribed", flush=True)
            return text
        return None
    except Exception as exc:
        print(f"[ocr] vision call failed p.{page_num}: {exc}", flush=True)
        return None
