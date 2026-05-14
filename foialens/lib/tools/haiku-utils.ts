import Anthropic from '@anthropic-ai/sdk';

export function extractText(response: Anthropic.Message): string {
  const block = response.content[0];
  return block.type === 'text' ? block.text : '';
}

export function parseJSON<T>(text: string): T | null {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) {
      try { return JSON.parse(match[0]) as T; } catch { return null; }
    }
    return null;
  }
}
