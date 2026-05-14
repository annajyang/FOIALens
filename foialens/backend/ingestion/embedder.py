import os
import openai

EMBEDDING_MODEL = "text-embedding-3-small"
BATCH_SIZE = 100

_client: openai.AsyncOpenAI | None = None


def _openai() -> openai.AsyncOpenAI:
    global _client
    if _client is None:
        _client = openai.AsyncOpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
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
