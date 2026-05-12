import type { PagedText } from './pdf-extractor';

export interface RawChunk {
  content: string;
  startPage: number;
  endPage: number;
  chunkIndex: number;
  tokenCount: number;  // approximate (chars / 4)
}

const TARGET_CHARS  = 2000;  // ~500 tokens
const OVERLAP_CHARS = 200;   // ~50 tokens — carried into next chunk for context

// Words that end with a period but do not end sentences.
const ABBREVS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'vs', 'etc', 'inc',
  'ltd', 'corp', 'co', 'dept', 'est', 'approx', 'govt', 'no', 'vol',
  'fig', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep',
  'oct', 'nov', 'dec', 'u.s', 'e.g', 'i.e', 'op', 'cit', 'cf', 'al',
  'pp', 'pg', 'ch', 'sec', 'art', 'para', 'st', 'ave', 'blvd', 'rd',
]);

interface TaggedSentence {
  text: string;
  page: number;
}

export function chunkPages(pages: PagedText[]): RawChunk[] {
  const sentences = tagSentences(pages);
  return groupIntoChunks(sentences);
}

// ── Sentence tagging ─────────────────────────────────────────────────────────

function tagSentences(pages: PagedText[]): TaggedSentence[] {
  const result: TaggedSentence[] = [];
  for (const { page, text } of pages) {
    for (const sentence of splitSentences(text)) {
      const trimmed = sentence.trim();
      if (trimmed.length > 0) {
        result.push({ text: trimmed, page });
      }
    }
  }
  return result;
}

function splitSentences(text: string): string[] {
  // Split on [.!?] followed by whitespace + an uppercase letter, quote, or digit.
  // Lookbehind is safe — Node 18+ supports it.
  const parts = text.split(/(?<=[.!?])\s+(?=[A-Z0-9"'“])/);
  const merged: string[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    // Check if the last word of this part is a known abbreviation.
    const lastWord = part
      .trimEnd()
      .split(/\s+/)
      .pop()
      ?.replace(/[^a-zA-Z.]/g, '')
      .toLowerCase()
      .replace(/\.$/, '');

    if (lastWord && ABBREVS.has(lastWord) && i + 1 < parts.length) {
      // Merge with the next part — this period belonged to an abbreviation.
      parts[i + 1] = part + ' ' + parts[i + 1];
    } else {
      merged.push(part);
    }
  }

  return merged;
}

// ── Chunk grouping ───────────────────────────────────────────────────────────

function groupIntoChunks(sentences: TaggedSentence[]): RawChunk[] {
  const chunks: RawChunk[] = [];
  let buffer: TaggedSentence[] = [];
  let bufferLen = 0;
  let chunkIndex = 0;

  const flush = () => {
    if (buffer.length === 0) return;

    const content = buffer.map(s => s.text).join(' ');
    chunks.push({
      content,
      startPage: buffer[0].page,
      endPage:   buffer[buffer.length - 1].page,
      chunkIndex: chunkIndex++,
      tokenCount: Math.round(content.length / 4),
    });

    // Carry the tail of the buffer forward for overlap.
    let overlapLen = 0;
    let cutoff = buffer.length - 1;
    while (cutoff > 0 && overlapLen < OVERLAP_CHARS) {
      overlapLen += buffer[cutoff].text.length;
      cutoff--;
    }
    buffer = buffer.slice(cutoff + 1);
    bufferLen = buffer.reduce((n, s) => n + s.text.length, 0);
  };

  for (const sentence of sentences) {
    // Flush before adding if this sentence would push us over the target.
    // The guard `buffer.length > 0` ensures we never emit an empty chunk,
    // and that a single very-long sentence still gets included (as its own chunk).
    if (bufferLen + sentence.text.length > TARGET_CHARS && buffer.length > 0) {
      flush();
    }
    buffer.push(sentence);
    bufferLen += sentence.text.length;
  }

  flush();
  return chunks;
}
