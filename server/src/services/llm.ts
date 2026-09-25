import fs from 'node:fs';
import { config } from '../config.ts';

type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

/** Calls an OpenAI-compatible chat completions endpoint (APIMart by default). */
export async function chat(messages: ChatMessage[], opts: { json?: boolean; model?: string; temperature?: number } = {}): Promise<string> {
  const body: Record<string, unknown> = {
    model: opts.model ?? config.llm.model,
    messages,
    temperature: opts.temperature ?? 0.8,
  };
  if (opts.json) body.response_format = { type: 'json_object' };

  let res = await post(body);
  // Some gateway models reject response_format; retry once without it.
  if (!res.ok && opts.json && res.status === 400) {
    delete body.response_format;
    res = await post(body);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`LLM request failed (${res.status}): ${text.slice(0, 500)}`);
  const data = JSON.parse(text) as { choices?: { message?: { content?: string | ContentPart[] } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => ('text' in p ? p.text : '')).join('');
  throw new Error('LLM returned no content');
}

function post(body: Record<string, unknown>) {
  return fetch(`${config.llm.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.llm.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
}

/** Ask for JSON and parse it, tolerating code fences and surrounding prose. */
export async function chatJson<T>(system: string, user: string | ContentPart[], opts: { model?: string; temperature?: number } = {}): Promise<T> {
  const raw = await chat(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { ...opts, json: true },
  );
  return parseJsonLoose<T>(raw);
}

export function parseJsonLoose<T>(raw: string): T {
  const cleaned = raw.replace(/```(?:json)?/gi, '').trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.search(/[[{]/);
    const end = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1)) as T;
    throw new Error(`Could not parse JSON from model output: ${raw.slice(0, 300)}`);
  }
}

export function imageToDataUri(path: string, mime: string) {
  return `data:${mime};base64,${fs.readFileSync(path).toString('base64')}`;
}
