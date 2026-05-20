import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';

export async function POST(req: NextRequest) {
  const { system, messages } = await req.json() as {
    system: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  };

  if (!process.env.DO_MODEL_ACCESS_KEY) {
    return NextResponse.json({
      content:
        '[ Agent unavailable — no DO_MODEL_ACCESS_KEY configured. Add it to .env.local to enable the chat agent. ]',
    });
  }

  try {
    const client = new OpenAI({
      baseURL: 'https://inference.do-ai.run/v1',
      apiKey: process.env.DO_MODEL_ACCESS_KEY,
    });
    const response = await client.chat.completions.create({
      model: process.env.DO_MODEL ?? 'anthropic-claude-haiku-4.5',
      max_tokens: 1024,
      messages: [{ role: 'system', content: system }, ...messages],
    });
    const text = response.choices[0]?.message.content ?? '';
    return NextResponse.json({ content: text });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ content: `[ Agent error — ${msg} ]` });
  }
}
