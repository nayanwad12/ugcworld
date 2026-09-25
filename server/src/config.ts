import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// Works both from src/ (tsx) and dist/ (esbuild bundle): both sit one level below server/.
export const SERVER_ROOT = path.resolve(here, '..');
export const REPO_ROOT = path.resolve(SERVER_ROOT, '..');

const env = process.env;
const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);
const bool = (v: string | undefined, d: boolean) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

const apimartKey = env.APIMART_API_KEY?.trim() || '';
const llmKey = env.LLM_API_KEY?.trim() || apimartKey;

export const config = {
  port: num(env.PORT, 8787),
  dataDir: path.resolve(REPO_ROOT, env.DATA_DIR || 'data'),
  webDist: path.resolve(REPO_ROOT, 'web', 'dist'),
  /** Public URL where this server is reachable (used to hand uploaded assets to APIMart as image URLs). */
  publicBaseUrl: (env.PUBLIC_BASE_URL || codespacesUrl() || '').replace(/\/$/, '') || undefined,

  apimart: {
    apiKey: apimartKey,
    baseUrl: (env.APIMART_BASE_URL || 'https://api.apimart.ai').replace(/\/$/, ''),
    videoModel: env.APIMART_VIDEO_MODEL || 'gemini-omni-1.1-flash',
    /** Default resolution for new projects: 360p | 720p | 1080p | 4k. */
    resolution: env.APIMART_RESOLUTION || '720p',
    /** Omni accepts 16:9 and 9:16 only; other platform ratios are generated at the nearest one and cropped in FFmpeg. */
    supportedAspects: (env.APIMART_SUPPORTED_ASPECTS || '9:16,16:9').split(',').map((s) => s.trim()).filter(Boolean),
    /** image_urls + first/last frames: at most 10 in total. */
    maxImageRefs: Math.min(10, num(env.APIMART_MAX_IMAGE_REFS, 10)),
    /** Send metadata.task (reference_to_video / extend) instead of letting APIMart infer it. */
    sendTaskMetadata: bool(env.APIMART_SEND_TASK_METADATA, true),
    /** Default continuity mode for new projects: reference (video_urls) | extend (extend_from_task_id). */
    continuity: env.APIMART_CONTINUITY === 'extend' ? ('extend' as const) : ('reference' as const),
    /** Extra JSON merged into every generation request body (escape hatch for new API fields). */
    extraBody: safeJson(env.APIMART_EXTRA_BODY),
    pollIntervalMs: num(env.APIMART_POLL_INTERVAL_MS, 5000),
    timeoutMs: num(env.APIMART_TIMEOUT_MS, 15 * 60 * 1000),
  },

  llm: {
    apiKey: llmKey,
    baseUrl: (env.LLM_BASE_URL || 'https://api.apimart.ai/v1').replace(/\/$/, ''),
    model: env.LLM_MODEL || 'gemini-3.8-flash',
    visionModel: env.LLM_VISION_MODEL || env.LLM_MODEL || 'gemini-3.8-flash',
  },

  clip: {
    maxSec: num(env.MAX_CLIP_SEC, 10),
    minSec: num(env.MIN_CLIP_SEC, 3),
  },

  /** Force mock mode even when keys are present (useful for UI work). */
  mockVideo: bool(env.MOCK_VIDEO, !apimartKey),
  mockLlm: bool(env.MOCK_LLM, !llmKey),

  ffmpegPath: env.FFMPEG_PATH || '',
  ffprobePath: env.FFPROBE_PATH || '',
  fontsDir: env.CAPTION_FONTS_DIR || '',
  captionFont: env.CAPTION_FONT || 'DejaVu Sans',
};

/** Inside a GitHub Codespace the forwarded port has a stable public address (once its visibility is Public). */
function codespacesUrl(): string | undefined {
  const name = env.CODESPACE_NAME;
  const domain = env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN;
  if (!name || !domain) return undefined;
  return `https://${name}-${num(env.PORT, 8787)}.${domain}`;
}

function safeJson(v: string | undefined): Record<string, unknown> {
  if (!v) return {};
  try {
    const parsed = JSON.parse(v);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    console.warn('[config] APIMART_EXTRA_BODY is not valid JSON; ignoring');
    return {};
  }
}
