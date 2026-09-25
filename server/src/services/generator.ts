import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.ts';
import { fileUrl, HttpError, nowIso, projectDir, store } from '../store.ts';
import { platformById, type Clip, type Project } from '../../../shared/types.ts';
import { finalPrompt } from './prompts.ts';
import { getTask, submitGeneration, type TaskStatus } from './apimart.ts';
import { renderMockClip } from './mock.ts';
import { probe } from './ffmpeg.ts';

const cancelled = new Set<string>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type GenerateMode = 'all' | 'one' | 'from';

/**
 * Start generating clips in the background.
 *  - all : every clip that is not ready (or is stale), in order
 *  - one : only the given clip (downstream clips get flagged stale)
 *  - from: the given clip and every clip after it (keeps continuity intact)
 */
export function startGeneration(projectId: string, mode: GenerateMode, clipId?: string): Promise<void> {
  const p = store.get(projectId);
  if (p.generating) throw new HttpError(409, 'Generation already running for this project');
  if (!p.clips.length) throw new HttpError(400, 'No clips yet — build the clip prompts first');

  let targets: Clip[];
  if (mode === 'all') targets = p.clips.filter((c) => c.status !== 'ready' || c.stale);
  else {
    const clip = p.clips.find((c) => c.id === clipId);
    if (!clip) throw new HttpError(404, 'Clip not found');
    targets = mode === 'one' ? [clip] : p.clips.filter((c) => c.index >= clip.index);
  }
  if (!targets.length) throw new HttpError(400, 'All clips are already generated');
  const ids = targets.sort((a, b) => a.index - b.index).map((c) => c.id);

  cancelled.delete(projectId);
  store.update(projectId, (d) => {
    d.generating = true;
    d.stage = 'generate';
    for (const c of d.clips) if (ids.includes(c.id)) Object.assign(c, { status: 'queued', progress: 0, error: undefined, taskId: undefined });
  });
  return runChain(projectId, ids);
}

export function cancelGeneration(projectId: string) {
  cancelled.add(projectId);
  store.update(projectId, (d) => {
    for (const c of d.clips) if (c.status === 'queued') c.status = c.localPath ? 'ready' : 'idle';
  });
}

async function runChain(projectId: string, ids: string[]) {
  try {
    for (const id of ids) {
      if (cancelled.has(projectId)) break;
      const ok = await generateOne(projectId, id);
      if (!ok) {
        // Later clips depend on this one for continuity; stop the chain.
        store.update(projectId, (d) => {
          for (const c of d.clips) if (ids.includes(c.id) && c.status === 'queued') c.status = c.localPath ? 'ready' : 'idle';
        });
        break;
      }
    }
  } finally {
    cancelled.delete(projectId);
    store.update(projectId, (d) => {
      d.generating = false;
    });
  }
}

function setClip(projectId: string, clipId: string, patch: Partial<Clip>) {
  store.update(projectId, (d) => {
    const c = d.clips.find((x) => x.id === clipId);
    if (c) Object.assign(c, patch);
  });
}

async function generateOne(projectId: string, clipId: string): Promise<boolean> {
  const p = store.get(projectId);
  const clip = p.clips.find((c) => c.id === clipId);
  const scene = p.script?.scenes.find((s) => s.id === clip?.sceneId);
  if (!clip || !scene) return false;
  const prev = p.clips.find((c) => c.index === clip.index - 1);
  const withVideo = clip.index > 0 && clip.useVideoRef;

  try {
    if (withVideo && (!prev || prev.status !== 'ready' || !prev.localPath)) {
      throw new Error(`Clip ${clip.index} must be generated first — this clip continues from it.`);
    }
    setClip(projectId, clipId, { status: 'submitting', progress: 1, error: undefined });
    const version = nextVersion(clip);
    const outFile = path.join(projectDir(projectId), 'clips', `clip_${clip.index + 1}_v${version}.mp4`);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });

    if (config.mockVideo) {
      setClip(projectId, clipId, { status: 'generating', progress: 30 });
      await sleep(600);
      await renderMockClip(p, { ...scene, durationSec: clip.durationSec }, outFile, version);
      await finishTake(projectId, clipId, { version, outFile, withVideo });
      return true;
    }

    // Resolve every URL before submitting so a missing public URL fails fast and costs nothing.
    const imageUrls = clip.imageAssetIds.map((id) => assetReferenceUrl(p, id)).filter((u): u is string => !!u);
    const extend = withVideo && p.brief.continuity === 'extend';
    const taskId = await submitGeneration({
      prompt: finalPrompt(p, clip, withVideo),
      aspect: platformById(p.brief.platform).aspect,
      resolution: p.brief.resolution,
      imageUrls,
      videoUrl: withVideo && !extend && prev ? clipReferenceUrl(prev) : undefined,
      extendFromTaskId: extend && prev ? takeOf(prev)?.taskId || missingTask(prev) : undefined,
    });
    setClip(projectId, clipId, { status: 'generating', taskId, progress: 5 });
    const done = await pollTask(projectId, clipId, taskId);
    setClip(projectId, clipId, { status: 'downloading', progress: 95 });
    await download(done.videoUrl!, outFile);
    await finishTake(projectId, clipId, { version, outFile, withVideo, remoteUrl: done.videoUrl, remoteExpiresAt: done.expiresAt, taskId });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[generate] clip ${clip.index + 1} failed:`, message);
    // A previous take (localPath) is kept so the edit can still use it.
    setClip(projectId, clipId, { status: 'failed', error: message, progress: 0 });
    return false;
  }
}

interface Take {
  version: number;
  outFile: string;
  withVideo: boolean;
  remoteUrl?: string;
  remoteExpiresAt?: number;
  taskId?: string;
}

/** Record a finished take on the clip and flag clips that continued from an older take. */
async function finishTake(projectId: string, clipId: string, t: Take) {
  const info = await probe(t.outFile).catch(() => undefined);
  const p = store.get(projectId);
  const clip = p.clips.find((x) => x.id === clipId);
  const prev = p.clips.find((x) => x.index === (clip?.index ?? 0) - 1);
  // An "extend" result may contain the previous clip followed by the new part; keep only the new part.
  let trimStart = 0;
  if (t.withVideo && p.brief.continuity === 'extend' && prev?.localPath && info?.durationSec) {
    const prevDur = (await probe(prev.localPath).catch(() => undefined))?.durationSec ?? 0;
    if (prevDur && info.durationSec >= prevDur + 1.5) trimStart = Math.round(prevDur * 100) / 100;
  }
  store.update(projectId, (d) => {
    const c = d.clips.find((x) => x.id === clipId);
    if (!c) return;
    const url = fileUrl(t.outFile);
    const prevNow = d.clips.find((x) => x.index === c.index - 1);
    Object.assign(c, {
      status: 'ready',
      progress: 100,
      version: t.version,
      localPath: t.outFile,
      url,
      remoteUrl: t.remoteUrl,
      taskId: t.taskId,
      stale: false,
      basedOnPrevVersion: t.withVideo ? prevNow?.version : undefined,
      trimStart,
      trimEnd: 0,
    } satisfies Partial<Clip>);
    // Omni picks the length itself (3–10s): the real duration drives the timeline.
    if (info?.durationSec) c.durationSec = Math.round(info.durationSec * 100) / 100;
    c.history.push({
      version: t.version,
      prompt: c.prompt,
      url,
      localPath: t.outFile,
      remoteUrl: t.remoteUrl,
      remoteExpiresAt: t.remoteExpiresAt,
      taskId: t.taskId,
      trimStart,
      createdAt: nowIso(),
    });
    markDownstreamStale(d, c.index);
  });
}

/** The take a clip currently uses. */
const takeOf = (c: Clip) => c.history.find((h) => h.version === c.version);

function missingTask(prev: Clip): never {
  throw new Error(`Clip ${prev.index + 1} has no APIMart task id (it was made in demo mode or before task tracking). Regenerate it, or switch continuity to "reference video".`);
}

const nextVersion = (c: Clip) => Math.max(c.version, ...c.history.map((h) => h.version)) + 1;

/**
 * A clip that continues from another is stale when the clip before it is no longer the take it was
 * generated from (or is itself stale). Restoring the original take clears the flag again.
 */
function markDownstreamStale(d: Project, fromIndex: number) {
  const sorted = [...d.clips].sort((a, b) => a.index - b.index);
  for (const c of sorted) {
    if (c.index <= fromIndex || !c.localPath) continue;
    const prev = sorted.find((x) => x.index === c.index - 1);
    c.stale = c.useVideoRef && !!prev && (c.basedOnPrevVersion !== prev.version || prev.stale);
  }
}

async function pollTask(projectId: string, clipId: string, taskId: string): Promise<TaskStatus> {
  const started = Date.now();
  let failures = 0;
  while (Date.now() - started < config.apimart.timeoutMs) {
    if (cancelled.has(projectId)) throw new Error('Cancelled');
    await sleep(config.apimart.pollIntervalMs);
    try {
      const t = await getTask(taskId);
      failures = 0;
      if (t.status === 'completed' && t.videoUrl) return t;
      if (t.status === 'failed') throw new Error(t.error || 'Generation failed');
      setClip(projectId, clipId, { progress: Math.max(5, Math.min(94, t.progress || 0)) });
    } catch (err) {
      if (err instanceof Error && /fail|cancel/i.test(err.message) && !/lookup/i.test(err.message)) throw err;
      if (++failures > 10) throw err;
    }
  }
  throw new Error('Timed out waiting for the video');
}

async function download(url: string, outFile: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), fs.createWriteStream(outFile));
}

const isPublic = (u?: string) => !!u && /^https?:\/\//.test(u) && !/^https?:\/\/(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.)/.test(u);

/** APIMart only accepts public HTTP(S) image URLs: the asset's own URL, else this server's public URL. */
function assetReferenceUrl(p: Project, assetId: string): string | undefined {
  const a = p.assets.find((x) => x.id === assetId);
  if (!a) return undefined;
  if (a.remoteUrl) return a.remoteUrl;
  if (!a.file) return undefined;
  const url = config.publicBaseUrl ? `${config.publicBaseUrl}${a.file.url}` : undefined;
  if (!isPublic(url)) {
    throw new Error(`APIMart needs a public URL for @${a.tag}. Set PUBLIC_BASE_URL (your deployed domain or an ngrok URL), or paste a public image URL on the asset.`);
  }
  return url;
}

/** The previous clip as reference video: APIMart's own URL until it expires, then this server's public URL. */
function clipReferenceUrl(prev: Clip): string {
  const take = takeOf(prev);
  const remote = take?.remoteUrl ?? prev.remoteUrl;
  const expires = take?.remoteExpiresAt;
  if (remote && (!expires || expires * 1000 > Date.now() + 5 * 60_000)) return remote;
  const own = config.publicBaseUrl && prev.url ? `${config.publicBaseUrl}${prev.url}` : undefined;
  if (isPublic(own)) return own!;
  throw new Error(
    `Clip ${prev.index + 1}'s APIMart link has expired and PUBLIC_BASE_URL is not set, so it can't be sent as the reference video. Set PUBLIC_BASE_URL, or switch continuity to "extend".`,
  );
}

/** After a restart: resume polling clips that were mid-generation, reset the rest. */
export function resumeInterrupted() {
  for (const p of store.list()) {
    const inFlight = p.clips.filter((c) => c.status === 'generating' && c.taskId);
    store.update(p.id, (d) => {
      for (const c of d.clips) {
        if (['queued', 'submitting', 'downloading'].includes(c.status) || (c.status === 'generating' && !c.taskId)) {
          c.status = c.localPath ? 'ready' : 'failed';
          if (!c.localPath) c.error = 'Interrupted by a server restart — generate again.';
        }
      }
      d.generating = inFlight.length > 0;
      if (d.render.status === 'rendering') Object.assign(d.render, { status: 'failed', error: 'Interrupted by a server restart' });
      if (d.autopilot.running) Object.assign(d.autopilot, { running: false, error: 'Interrupted by a server restart' });
    });
    if (!inFlight.length || config.mockVideo) continue;
    void (async () => {
      for (const c of inFlight) {
        try {
          const done = await pollTask(p.id, c.id, c.taskId!);
          const version = nextVersion(c);
          const outFile = path.join(projectDir(p.id), 'clips', `clip_${c.index + 1}_v${version}.mp4`);
          await download(done.videoUrl!, outFile);
          await finishTake(p.id, c.id, { version, outFile, withVideo: c.index > 0 && c.useVideoRef, remoteUrl: done.videoUrl, remoteExpiresAt: done.expiresAt, taskId: c.taskId });
        } catch (err) {
          setClip(p.id, c.id, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
        }
      }
      store.update(p.id, (d) => {
        d.generating = false;
      });
    })();
  }
}

/** Switch a clip back to one of its previous takes. */
export function restoreVersion(projectId: string, clipId: string, version: number) {
  return store.update(projectId, (d) => {
    const c = d.clips.find((x) => x.id === clipId);
    const v = c?.history.find((h) => h.version === version);
    if (!c || !v) throw new HttpError(404, 'Version not found');
    Object.assign(c, { version: v.version, url: v.url, localPath: v.localPath, remoteUrl: v.remoteUrl, taskId: v.taskId, status: 'ready', error: undefined, trimStart: v.trimStart ?? 0, trimEnd: 0 });
    markDownstreamStale(d, c.index);
  });
}
