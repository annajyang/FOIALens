import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';

export async function POST(req: NextRequest) {
  const { system, messages } = await req.json() as {
    system: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  };

  if (!process.env.OPENROUTER_API_KEY) {
    return NextResponse.json({
      content:
        '[ Agent unavailable — no OPENROUTER_API_KEY configured. Add it to .env.local to enable the chat agent. ]',
    });
  }

  try {
    const client = new OpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: process.env.OPENROUTER_API_KEY,
    });
    const response = await client.chat.completions.create({
      model: process.env.OPENROUTER_MODEL ?? 'google/gemini-3.5-flash',
      max_tokens: 4096,
      messages: [{ role: 'system', content: system }, ...messages],
    });
    const text = (response.choices[0]?.message.content ?? '').trim();
    return NextResponse.json({ content: text });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ content: `[ Agent error — ${msg} ]` });
  }
}
