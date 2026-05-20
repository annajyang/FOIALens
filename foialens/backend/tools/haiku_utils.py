import json
import os
import re

from openai import AsyncOpenAI

DO_MODEL = os.getenv("DO_MODEL", "anthropic-claude-haiku-4-5-20251001")
HAIKU = DO_MODEL

_client: AsyncOpenAI | None = None


def _openai() -> AsyncOpenAI:
    global _client
    if _client is None:
        _client = AsyncOpenAI(
            base_url="https://inference.do-ai.run/v1",
            api_key=os.environ.get("DO_MODEL_ACCESS_KEY"),
        )
    return _client


def extract_text(response) -> str:
    return response.choices[0].message.content or ""


def parse_json(text: str):
    cleaned = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*```$", "", cleaned).strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        m = re.search(r"\[[\s\S]*\]", cleaned)
        if m:
            try:
                return json.loads(m.group())
            except json.JSONDecodeError:
                pass
    return None
