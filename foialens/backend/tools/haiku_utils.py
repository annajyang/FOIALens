import asyncio
import json
import os
import re

from openai import AsyncOpenAI

DO_MODEL = os.getenv("DO_MODEL", "anthropic-claude-haiku-4.5")
HAIKU = os.getenv("DO_EXTRACT_MODEL", DO_MODEL)

_client: AsyncOpenAI | None = None


def _openai() -> AsyncOpenAI:
    global _client
    if _client is None:
        _client = AsyncOpenAI(
            base_url="https://inference.do-ai.run/v1",
            api_key=os.environ.get("DO_MODEL_ACCESS_KEY"),
        )
    return _client


async def call_with_backoff(**kwargs) -> object:
    delays = [30, 60, 120, 180]
    model_label = kwargs.get("model", "?")
    for attempt, delay in enumerate(delays + [None]):
        try:
            return await _openai().chat.completions.create(**kwargs)
        except Exception as e:
            msg = str(e).lower()
            is_rate_limit = '429' in msg or 'rate_limit' in msg or 'rate limit' in msg
            if not is_rate_limit or delay is None:
                print(f"[backoff] FATAL model={model_label} attempt={attempt} err={e}", flush=True)
                raise
            print(f"[backoff] rate-limited model={model_label} attempt={attempt}/{len(delays)}, sleeping {delay}s", flush=True)
            await asyncio.sleep(delay)


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
