/**
 * APIMart client for Gemini Omni 1.1 Flash video generation.
 * Docs: https://docs.apimart.ai/en/api-reference/videos/gemini-omni-1.1-flash/generation
 *
 *   POST {base}/v1/videos/generations  -> { code: 200, data: [{ status: "submitted", task_id }] }
 *   GET  {base}/v1/tasks/{taskId}      -> { code: 200, data: { status, progress, result: { videos: [{ url: [..], expires_at }] } } }
 *
 * Notes from the docs that shape this client:
 *  - there is no `duration` parameter: the model picks 3–10s from the content, so pacing goes in the prompt
 *  - aspect_ratio is 16:9 or 9:16 only (and is ignored when video_urls is given: output follows the input video)
 *  - image_urls must be public HTTP(S) URLs, max 10; a single image is treated as the FIRST FRAME unless the
 *    task says otherwise, so we send metadata.task = "reference_to_video" when images are references
 *  - video_urls (max 1, <=10s) and extend_from_task_id are mutually exclusive
 */
import { config } from '../config.ts';

export type OmniTask = 'text_to_video' | 'image_to_video' | 'reference_to_video' | 'edit' | 'extend';

export interface GenerationRequest {
  prompt: string;
  aspect: string;
  resolution: string;
  imageUrls: string[];
  /** Previous clip as a reference video (continuity mode "reference"). */
  videoUrl?: string;
  /** Previous clip's APIMart task (continuity mode "extend"). */
  extendFromTaskId?: string;
}

export interface TaskStatus {
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress: number;
  videoUrl?: string;
  expiresAt?: number;
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

/** Which Omni task a request represents. */
export function inferTask(req: GenerationRequest): OmniTask {
  if (req.extendFromTaskId) return 'extend';
  if (req.videoUrl || req.imageUrls.length) return 'reference_to_video';
  return 'text_to_video';
}

/** Build the POST body exactly as the APIMart docs describe it. */
export function buildGenerationBody(req: GenerationRequest): Record<string, unknown> {
  if (req.videoUrl && req.extendFromTaskId) throw new Error('video_urls and extend_from_task_id are mutually exclusive');
  const task = inferTask(req);
  const resolution = ['360p', '720p', '1080p', '4k'].includes(req.resolution.toLowerCase()) ? req.resolution.toLowerCase() : '720p';
  return {
    model: config.apimart.videoModel,
    prompt: req.prompt,
    aspect_ratio: nearestAspect(req.aspect),
    resolution,
    ...(req.imageUrls.length ? { image_urls: req.imageUrls.slice(0, 10) } : {}),
    ...(req.videoUrl ? { video_urls: [req.videoUrl] } : {}),
    ...(req.extendFromTaskId ? { extend_from_task_id: req.extendFromTaskId } : {}),
    ...(config.apimart.sendTaskMetadata && task !== 'text_to_video' ? { metadata: { task } } : {}),
    ...config.apimart.extraBody,
  };
}

export async function submitGeneration(req: GenerationRequest): Promise<string> {
  const body = buildGenerationBody(req);
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
    const result = (data.result ?? data.output ?? data) as { videos?: { expires_at?: number }[] };
    const videoUrl = findVideoUrl(result);
    if (!videoUrl) return { status: 'failed', progress: 100, error: `Task completed but no video URL found: ${text.slice(0, 300)}` };
    const expiresAt = Number(result.videos?.[0]?.expires_at) || undefined;
    return { status: 'completed', progress: 100, videoUrl, expiresAt };
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
