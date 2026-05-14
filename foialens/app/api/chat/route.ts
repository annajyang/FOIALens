import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';

export async function POST(req: NextRequest) {
  const { system, messages } = await req.json() as {
    system: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  };

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({
      content:
        '[ Agent unavailable — no ANTHROPIC_API_KEY configured. Add it to .env.local to enable the chat agent. ]',
    });
  }

  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system,
      messages,
    });
    const text =
      response.content[0]?.type === 'text' ? response.content[0].text : '';
    return NextResponse.json({ content: text });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ content: `[ Agent error — ${msg} ]` });
  }
}
