import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const EMBEDDING_MODEL = 'text-embedding-3-small';
const BATCH_SIZE = 100;

/**
 * Embed an array of texts using text-embedding-3-small (1536 dimensions).
 * Batches into groups of 100 to stay within API limits.
 * Returned embeddings are in the same order as the input array.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const all: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: batch,
    });
    // Sort by index in case the API returns results out of order.
    const sorted = response.data.sort((a, b) => a.index - b.index);
    all.push(...sorted.map(d => d.embedding));
  }

  return all;
}

/** Format a vector array as the string pgvector accepts: '[1.0,2.0,...]' */
export function toVectorString(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}
