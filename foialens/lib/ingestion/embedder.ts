import OpenAI from 'openai';

const EMBEDDING_MODEL = 'text-embedding-3-small';
const BATCH_SIZE = 100;

let _openai: OpenAI | null = null;
function openai() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const all: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const response = await openai().embeddings.create({
      model: EMBEDDING_MODEL,
      input: batch,
    });
    const sorted = response.data.sort((a, b) => a.index - b.index);
    all.push(...sorted.map(d => d.embedding));
  }

  return all;
}

export function toVectorString(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}
