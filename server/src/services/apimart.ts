/**
 * APIMart client for Gemini Omni 1.1 Flash video generation.
 * Docs: https://docs.apimart.ai/en/api-reference/videos/gemini-omni-1.1-flash/generation
 *
 *   POST {base}/v1/videos/generations   -> task id
 *   GET  {base}/v1/tasks/{taskId}       -> status / progress / video url
 *
 * Response parsing is intentionally tolerant (APIMart wraps payloads as {code, data}), and
 * APIMART_EXTRA_BODY lets you add/override request fields without code changes.
 */
import { config } from '../config.ts';

export interface GenerationRequest {
  prompt: string;
  durationSec: number;
  aspect: string;
  imageUrls: string[];
  videoUrls: string[];
}

export interface TaskStatus {
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress: number;
  videoUrl?: string;
  error?: string;
}

function headers() {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apimart.apiKey}` };
}

export function nearestAspect(aspect: string): string {
  const supported = config.apimart.supportedAspects;
  if (supported.includes(aspect)) return aspect;
  const ratio = (a: string) => {
    const [w, h] = a.split(':').map(Number);
    return w / h;
  };
  const target = ratio(aspect);
  return [...supported].sort((a, b) => Math.abs(Math.log(ratio(a) / target)) - Math.abs(Math.log(ratio(b) / target)))[0] ?? '9:16';
}

export async function submitGeneration(req: GenerationRequest): Promise<string> {
  const body: Record<string, unknown> = {
    model: config.apimart.videoModel,
    prompt: req.prompt,
    duration: Math.round(Math.min(config.clip.maxSec, Math.max(config.clip.minSec, req.durationSec))),
    aspect_ratio: nearestAspect(req.aspect),
    resolution: config.apimart.resolution,
    ...(req.imageUrls.length ? { image_urls: req.imageUrls } : {}),
    ...(req.videoUrls.length ? { video_urls: req.videoUrls } : {}),
    ...config.apimart.extraBody,
  };
  const res = await fetch(`${config.apimart.baseUrl}/v1/videos/generations`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`APIMart returned non-JSON (${res.status}): ${text.slice(0, 300)}`);
  }
  if (!res.ok || apiError(json)) throw new Error(`APIMart generation failed (${res.status}): ${apiError(json) ?? text.slice(0, 400)}`);
  const taskId = findTaskId(json);
  if (!taskId) throw new Error(`APIMart response had no task id: ${text.slice(0, 400)}`);
  return taskId;
}

export async function getTask(taskId: string): Promise<TaskStatus> {
  const res = await fetch(`${config.apimart.baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`, {
    headers: headers(),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) {
    // Transient gateway errors should not fail the clip; the poller retries.
    if (res.status >= 500 || res.status === 429) return { status: 'running', progress: 0 };
    throw new Error(`APIMart task lookup failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const json = JSON.parse(text) as Record<string, unknown>;
  const data = (json.data ?? json) as Record<string, unknown>;
  const rawStatus = String(data.status ?? data.state ?? '').toLowerCase();
  const progress = Number(data.progress ?? 0);
  if (/(fail|error|cancel|reject)/.test(rawStatus)) {
    return { status: 'failed', progress, error: String(data.fail_reason ?? data.error_message ?? errorText(data.error) ?? 'Generation failed') };
  }
  if (/(complete|success|succeed|done|finished)/.test(rawStatus)) {
    const videoUrl = findVideoUrl(data.result ?? data.output ?? data);
    if (!videoUrl) return { status: 'failed', progress: 100, error: `Task completed but no video URL found: ${text.slice(0, 300)}` };
    return { status: 'completed', progress: 100, videoUrl };
  }
  return { status: rawStatus.includes('pend') || rawStatus.includes('queue') || rawStatus.includes('submit') ? 'pending' : 'running', progress: Number.isFinite(progress) ? progress : 0 };
}

function apiError(json: unknown): string | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const j = json as Record<string, unknown>;
  if (j.error) return errorText(j.error);
  if (typeof j.code === 'number' && j.code !== 200 && j.code !== 0) return String(j.msg ?? j.message ?? `code ${j.code}`);
  return undefined;
}

function errorText(e: unknown): string | undefined {
  if (!e) return undefined;
  if (typeof e === 'string') return e;
  if (typeof e === 'object') return String((e as Record<string, unknown>).message ?? JSON.stringify(e));
  return String(e);
}

function findTaskId(json: unknown): string | undefined {
  const j = json as Record<string, unknown>;
  const data = j?.data as unknown;
  const candidates = [Array.isArray(data) ? data[0] : data, j];
  for (const c of candidates) {
    if (c && typeof c === 'object') {
      const o = c as Record<string, unknown>;
      const id = o.task_id ?? o.taskId ?? o.id;
      if (typeof id === 'string' && id) return id;
    }
  }
  return undefined;
}

/** Find the first video-looking URL anywhere in the result payload. */
export function findVideoUrl(node: unknown): string | undefined {
  const urls: string[] = [];
  const walk = (n: unknown) => {
    if (typeof n === 'string') {
      if (/^https?:\/\//.test(n)) urls.push(n);
    } else if (Array.isArray(n)) n.forEach(walk);
    else if (n && typeof n === 'object') {
      const o = n as Record<string, unknown>;
      // Prefer obvious keys first.
      for (const k of ['videos', 'video', 'video_url', 'videoUrl', 'url', 'urls']) if (k in o) walk(o[k]);
      for (const [k, v] of Object.entries(o)) if (!['videos', 'video', 'video_url', 'videoUrl', 'url', 'urls'].includes(k)) walk(v);
    }
  };
  walk(node);
  return urls.find((u) => /\.(mp4|mov|webm)(\?|$)/i.test(u)) ?? urls.find((u) => !/\.(png|jpe?g|webp|gif)(\?|$)/i.test(u));
}

export async function isReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(15_000) });
    return res.ok;
  } catch {
    return false;
  }
}
