import os
from openai import AsyncOpenAI

EMBEDDING_MODEL = os.getenv("DO_EMBEDDING_MODEL", "thenlper/gte-large")
BATCH_SIZE = 100

_client: AsyncOpenAI | None = None


def _openai() -> AsyncOpenAI:
    global _client
    if _client is None:
        _client = AsyncOpenAI(
            base_url="https://inference.do-ai.run/v1",
            api_key=os.environ.get("DO_MODEL_ACCESS_KEY"),
        )
    return _client


async def embed_texts(texts: list[str]) -> list[list[float]]:
    if not texts:
        return []
    all_embeddings: list[list[float]] = []
    for i in range(0, len(texts), BATCH_SIZE):
        batch = texts[i : i + BATCH_SIZE]
        response = await _openai().embeddings.create(model=EMBEDDING_MODEL, input=batch)
        sorted_data = sorted(response.data, key=lambda x: x.index)
        all_embeddings.extend(d.embedding for d in sorted_data)
    return all_embeddings


def to_vector_string(embedding: list[float]) -> str:
    return f"[{','.join(str(x) for x in embedding)}]"
