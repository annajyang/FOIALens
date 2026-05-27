import asyncio
import json
import os
import re

from openai import AsyncOpenAI

MODEL = os.getenv("OPENROUTER_MODEL", "google/gemini-3.5-flash")
HAIKU = os.getenv("OPENROUTER_EXTRACT_MODEL", MODEL)

_client: AsyncOpenAI | None = None


def _openai() -> AsyncOpenAI:
    global _client
    if _client is None:
        _client = AsyncOpenAI(
            base_url="https://openrouter.ai/api/v1",
            api_key=os.environ.get("OPENROUTER_API_KEY"),
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

    # Clean parse
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass

    # Complete [...] block anywhere in the text
    m = re.search(r"\[[\s\S]*\]", cleaned)
    if m:
        try:
            return json.loads(m.group())
        except json.JSONDecodeError:
            pass

    # Truncated-array recovery: slice up to the last complete '}' and close the array.
    # Handles the case where the model hit max_tokens mid-JSON.
    start = cleaned.find("[")
    last_obj_end = cleaned.rfind("}")
    if start != -1 and last_obj_end > start:
        try:
            result = json.loads(cleaned[start : last_obj_end + 1] + "]")
            if isinstance(result, list) and result:
                print(f"[parse_json] recovered {len(result)} item(s) from truncated output", flush=True)
                return result
        except json.JSONDecodeError:
            pass

    return None
