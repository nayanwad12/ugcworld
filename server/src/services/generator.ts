import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.ts';
import { fileUrl, HttpError, nowIso, projectDir, store } from '../store.ts';
import { platformById, type Clip, type Project } from '../../../shared/types.ts';
import { finalPrompt } from './prompts.ts';
import { getTask, isReachable, submitGeneration } from './apimart.ts';
import { imageToDataUri } from './llm.ts';
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
    let remoteUrl: string | undefined;

    if (config.mockVideo) {
      setClip(projectId, clipId, { status: 'generating', progress: 30 });
      await sleep(600);
      await renderMockClip(p, { ...scene, durationSec: clip.durationSec }, outFile, version);
    } else {
      const imageUrls = await Promise.all(clip.imageAssetIds.map((id) => assetReferenceUrl(p, id)));
      const videoUrls = withVideo && prev ? [await clipReferenceUrl(prev)] : [];
      const taskId = await submitGeneration({
        prompt: finalPrompt(p, clip, withVideo),
        durationSec: clip.durationSec,
        aspect: platformById(p.brief.platform).aspect,
        imageUrls: imageUrls.filter((u): u is string => !!u),
        videoUrls,
      });
      setClip(projectId, clipId, { status: 'generating', taskId, progress: 5 });
      remoteUrl = await pollTask(projectId, clipId, taskId);
      setClip(projectId, clipId, { status: 'downloading', progress: 95 });
      await download(remoteUrl, outFile);
    }

    const info = await probe(outFile).catch(() => undefined);
    store.update(projectId, (d) => {
      const c = d.clips.find((x) => x.id === clipId);
      if (!c) return;
      const url = fileUrl(outFile);
      const prevNow = d.clips.find((x) => x.index === c.index - 1);
      Object.assign(c, {
        status: 'ready',
        progress: 100,
        version,
        localPath: outFile,
        url,
        remoteUrl,
        stale: false,
        basedOnPrevVersion: withVideo ? prevNow?.version : undefined,
        trimStart: 0,
        trimEnd: 0,
      } satisfies Partial<Clip>);
      if (info?.durationSec) c.durationSec = Math.round(info.durationSec * 100) / 100;
      c.history.push({ version, prompt: c.prompt, url, localPath: outFile, remoteUrl, createdAt: nowIso() });
      markDownstreamStale(d, c.index);
    });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[generate] clip ${clip.index + 1} failed:`, message);
    // A previous take (localPath) is kept so the edit can still use it.
    setClip(projectId, clipId, { status: 'failed', error: message, progress: 0 });
    return false;
  }
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

async function pollTask(projectId: string, clipId: string, taskId: string): Promise<string> {
  const started = Date.now();
  let failures = 0;
  while (Date.now() - started < config.apimart.timeoutMs) {
    if (cancelled.has(projectId)) throw new Error('Cancelled');
    await sleep(config.apimart.pollIntervalMs);
    try {
      const t = await getTask(taskId);
      failures = 0;
      if (t.status === 'completed' && t.videoUrl) return t.videoUrl;
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

/** Resolve an asset into something APIMart can fetch: explicit URL > public server URL > data URI. */
async function assetReferenceUrl(p: Project, assetId: string): Promise<string | undefined> {
  const a = p.assets.find((x) => x.id === assetId);
  if (!a) return undefined;
  if (a.remoteUrl) return a.remoteUrl;
  if (!a.file) return undefined;
  if (config.publicBaseUrl) return `${config.publicBaseUrl}${a.file.url}`;
  if (config.apimart.allowDataUri && a.file.mime.startsWith('image/')) return imageToDataUri(a.file.path, a.file.mime);
  throw new Error(`Asset @${a.tag} has no public URL. Set PUBLIC_BASE_URL or give the asset a remote URL.`);
}

/** The previous clip as a reference video: APIMart's own URL while it is still live, else our public URL. */
async function clipReferenceUrl(prev: Clip): Promise<string> {
  if (prev.remoteUrl && (await isReachable(prev.remoteUrl))) return prev.remoteUrl;
  if (config.publicBaseUrl && prev.url) return `${config.publicBaseUrl}${prev.url}`;
  if (prev.remoteUrl) return prev.remoteUrl;
  throw new Error('The previous clip has no public URL to use as the reference video. Set PUBLIC_BASE_URL.');
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
          const remoteUrl = await pollTask(p.id, c.id, c.taskId!);
          const version = nextVersion(c);
          const outFile = path.join(projectDir(p.id), 'clips', `clip_${c.index + 1}_v${version}.mp4`);
          await download(remoteUrl, outFile);
          store.update(p.id, (d) => {
            const x = d.clips.find((y) => y.id === c.id)!;
            const url = fileUrl(outFile);
            Object.assign(x, { status: 'ready', progress: 100, version, localPath: outFile, url, remoteUrl, stale: false });
            x.history.push({ version, prompt: x.prompt, url, localPath: outFile, remoteUrl, createdAt: nowIso() });
            markDownstreamStale(d, x.index);
          });
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
    Object.assign(c, { version: v.version, url: v.url, localPath: v.localPath, remoteUrl: v.remoteUrl, status: 'ready', error: undefined, trimStart: 0, trimEnd: 0 });
    markDownstreamStale(d, c.index);
  });
}
