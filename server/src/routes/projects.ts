import fs from 'node:fs';
import path from 'node:path';
import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { fileUrl, HttpError, newId, nowIso, projectDir, store } from '../store.ts';
import { generateConcepts, generateScript, describeAsset } from '../services/planner.ts';
import { buildClipPrompt, buildClips, finalPrompt, selectImageRefs } from '../services/prompts.ts';
import { cancelGeneration, restoreVersion, startGeneration, type GenerateMode } from '../services/generator.ts';
import { startRender } from '../services/render.ts';
import { applyEditDefaults, runAutopilot } from '../services/pipeline.ts';
import { STAGES, type Asset, type AssetKind, type Brief, type Clip, type EditSettings, type Scene, type Script, type Stage } from '../../../shared/types.ts';

export const router = Router();

type Handler = (req: Request, res: Response) => unknown;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res)).catch(next);
const param = (req: Request, k: string) => String(req.params[k]);
const background = (label: string, p: Promise<unknown>) => p.catch((err) => console.error(`[${label}]`, err));

const ASSET_KINDS: AssetKind[] = ['creator', 'product', 'environment', 'logo', 'props', 'narrator', 'music', 'sfx', 'other'];

// ----- projects -------------------------------------------------------------------------

router.get('/projects', (_req, res) => {
  res.json(
    store.list().map((p) => ({
      id: p.id,
      name: p.name,
      stage: p.stage,
      updatedAt: p.updatedAt,
      platform: p.brief.platform,
      durationSec: p.brief.durationSec,
      thumb: p.clips.find((c) => c.url)?.url,
      finalUrl: p.render.url,
    })),
  );
});

router.post('/projects', (req, res) => {
  res.status(201).json(store.create(String(req.body?.name ?? '').slice(0, 120)));
});

router.get('/projects/:id', (req, res) => {
  res.json(store.get(param(req, 'id')));
});

router.patch(
  '/projects/:id',
  h((req, res) => {
    const body = req.body as { name?: string; brief?: Partial<Brief>; stage?: Stage };
    const p = store.update(param(req, 'id'), (d) => {
      if (typeof body.name === 'string') d.name = body.name.slice(0, 120);
      if (body.brief) {
        const b = { ...d.brief, ...body.brief };
        b.durationSec = clamp(Number(b.durationSec) || 30, 3, 180);
        b.maxClipSec = clamp(Number(b.maxClipSec) || 10, 3, 10);
        d.brief = b;
      }
      if (body.stage && STAGES.includes(body.stage)) d.stage = body.stage;
    });
    res.json(p);
  }),
);

router.delete('/projects/:id', (req, res) => {
  store.remove(param(req, 'id'));
  res.status(204).end();
});

// ----- assets ---------------------------------------------------------------------------

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = path.join(projectDir(String(req.params.id)), 'assets');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => cb(null, `${newId('a_')}${path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '')}`),
  }),
  limits: { fileSize: 300 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /^(image|audio|video)\//.test(file.mimetype)),
});

function uniqueTag(assets: Asset[], wanted: string, ignoreId?: string) {
  const base = wanted.replace(/^@/, '').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'asset';
  let tag = base;
  for (let i = 2; assets.some((a) => a.tag === tag && a.id !== ignoreId); i++) tag = `${base}${i}`;
  return tag;
}

router.post(
  '/projects/:id/assets',
  upload.single('file'),
  h((req, res) => {
    const id = param(req, 'id');
    const body = req.body as Record<string, string>;
    const kind = (ASSET_KINDS.includes(body.kind as AssetKind) ? body.kind : 'other') as AssetKind;
    let asset!: Asset;
    store.update(id, (d) => {
      asset = {
        id: newId('as_'),
        kind,
        tag: uniqueTag(d.assets, body.tag || kind),
        name: (body.name || req.file?.originalname.replace(/\.[^.]+$/, '') || '').slice(0, 80),
        description: (body.description || '').slice(0, 2000),
        remoteUrl: /^https?:\/\//.test(body.remoteUrl || '') ? body.remoteUrl : undefined,
        createdAt: nowIso(),
        file: req.file
          ? { path: req.file.path, url: fileUrl(req.file.path), mime: req.file.mimetype, originalName: req.file.originalname, size: req.file.size }
          : undefined,
      };
      d.assets.push(asset);
      if (kind === 'music' && !d.edit.music.assetId) d.edit.music.assetId = asset.id;
      if (kind === 'logo' && asset.file && !d.edit.logo.assetId) Object.assign(d.edit.logo, { assetId: asset.id, enabled: true });
    });
    res.status(201).json(asset);
  }),
);

router.patch(
  '/projects/:id/assets/:assetId',
  h((req, res) => {
    const body = req.body as Partial<Asset>;
    let out: Asset | undefined;
    store.update(param(req, 'id'), (d) => {
      const a = d.assets.find((x) => x.id === param(req, 'assetId'));
      if (!a) throw new HttpError(404, 'Asset not found');
      const oldTag = a.tag;
      if (body.tag !== undefined) a.tag = uniqueTag(d.assets, body.tag, a.id);
      if (body.kind && ASSET_KINDS.includes(body.kind)) a.kind = body.kind;
      if (body.name !== undefined) a.name = String(body.name).slice(0, 80);
      if (body.description !== undefined) a.description = String(body.description).slice(0, 2000);
      if (body.remoteUrl !== undefined) a.remoteUrl = /^https?:\/\//.test(body.remoteUrl || '') ? body.remoteUrl : undefined;
      if (oldTag !== a.tag) renameTag(d.brief, d.script, oldTag, a.tag);
      out = a;
    });
    res.json(out);
  }),
);

function renameTag(brief: Brief, script: Script | undefined, from: string, to: string) {
  const re = new RegExp(`@${from}\\b`, 'g');
  brief.idea = brief.idea.replace(re, `@${to}`);
  if (!script) return;
  for (const c of script.cast) if (c.tag === from) c.tag = to;
  for (const s of script.scenes) {
    s.assetTags = s.assetTags.map((t) => (t === from ? to : t));
    for (const k of ['setting', 'camera', 'action', 'speaker', 'changes'] as const) s[k] = s[k].replace(re, `@${to}`);
  }
}

router.delete(
  '/projects/:id/assets/:assetId',
  h((req, res) => {
    store.update(param(req, 'id'), (d) => {
      const a = d.assets.find((x) => x.id === param(req, 'assetId'));
      if (!a) throw new HttpError(404, 'Asset not found');
      if (a.file) fs.rmSync(a.file.path, { force: true });
      d.assets = d.assets.filter((x) => x.id !== a.id);
      for (const c of d.clips) c.imageAssetIds = c.imageAssetIds.filter((x) => x !== a.id);
      if (d.edit.music.assetId === a.id) d.edit.music.assetId = undefined;
      if (d.edit.logo.assetId === a.id) Object.assign(d.edit.logo, { assetId: undefined, enabled: false });
      if (d.edit.endCard.logoAssetId === a.id) d.edit.endCard.logoAssetId = undefined;
      d.edit.sfx = d.edit.sfx.filter((s) => s.assetId !== a.id);
    });
    res.status(204).end();
  }),
);

router.post(
  '/projects/:id/assets/:assetId/describe',
  h(async (req, res) => {
    const p = store.get(param(req, 'id'));
    const a = p.assets.find((x) => x.id === param(req, 'assetId'));
    if (!a) throw new HttpError(404, 'Asset not found');
    const description = await describeAsset(a);
    const out = store.update(p.id, (d) => {
      const x = d.assets.find((y) => y.id === a.id);
      if (x) x.description = description;
    });
    res.json(out.assets.find((x) => x.id === a.id));
  }),
);

// ----- concepts & script -------------------------------------------------------------------

router.post(
  '/projects/:id/concepts',
  h(async (req, res) => {
    const p = store.get(param(req, 'id'));
    if (!p.brief.idea.trim() && !p.assets.length) throw new HttpError(400, 'Describe your idea or add some assets first');
    const concepts = await generateConcepts(p);
    res.json(
      store.update(p.id, (d) => {
        d.concepts = concepts;
        d.selectedConceptId = concepts[0]?.id;
        d.stage = 'concept';
      }),
    );
  }),
);

router.post(
  '/projects/:id/concepts/select',
  h((req, res) => {
    const body = req.body as { conceptId?: string; custom?: { title: string; hook: string; angle: string; summary: string } };
    res.json(
      store.update(param(req, 'id'), (d) => {
        if (body.custom) {
          const c = { id: newId('c_'), ...body.custom };
          d.concepts.push(c);
          d.selectedConceptId = c.id;
        } else {
          if (!d.concepts.some((c) => c.id === body.conceptId)) throw new HttpError(404, 'Concept not found');
          d.selectedConceptId = body.conceptId;
        }
      }),
    );
  }),
);

router.post(
  '/projects/:id/script',
  h(async (req, res) => {
    const p = store.get(param(req, 'id'));
    const script = await generateScript(p);
    res.json(
      store.update(p.id, (d) => {
        d.script = script;
        d.stage = 'script';
        applyEditDefaults(d);
      }),
    );
  }),
);

router.put(
  '/projects/:id/script',
  h((req, res) => {
    const script = req.body as Script;
    if (!script || !Array.isArray(script.scenes) || !script.scenes.length) throw new HttpError(400, 'Script needs at least one scene');
    res.json(
      store.update(param(req, 'id'), (d) => {
        script.scenes = script.scenes.map(
          (s, i): Scene => ({
            ...s,
            id: s.id || newId('s_'),
            index: i,
            durationSec: clamp(Math.round(Number(s.durationSec) || 5), 3, d.brief.maxClipSec),
            assetTags: (s.assetTags ?? []).map((t) => t.replace(/^@/, '').toLowerCase()),
            changes: i === 0 ? '' : (s.changes ?? ''),
          }),
        );
        d.script = script;
      }),
    );
  }),
);

// ----- clips ------------------------------------------------------------------------------

router.post(
  '/projects/:id/clips/build',
  h((req, res) => {
    const keepPrompts = !!(req.body as { keepPrompts?: boolean })?.keepPrompts;
    res.json(
      store.update(param(req, 'id'), (d) => {
        if (!d.script) throw new HttpError(400, 'Write the script first');
        if (d.generating) throw new HttpError(409, 'Wait for generation to finish');
        d.clips = buildClips(d, keepPrompts);
        d.stage = 'prompts';
      }),
    );
  }),
);

router.patch(
  '/projects/:id/clips/:clipId',
  h((req, res) => {
    const body = req.body as Partial<Clip>;
    res.json(
      store.update(param(req, 'id'), (d) => {
        const c = d.clips.find((x) => x.id === param(req, 'clipId'));
        if (!c) throw new HttpError(404, 'Clip not found');
        if (typeof body.prompt === 'string') c.prompt = body.prompt;
        if (typeof body.useVideoRef === 'boolean') c.useVideoRef = c.index > 0 && body.useVideoRef;
        if (Array.isArray(body.imageAssetIds)) c.imageAssetIds = body.imageAssetIds.filter((id) => d.assets.some((a) => a.id === id));
        if (body.trimStart !== undefined) c.trimStart = clamp(Number(body.trimStart) || 0, 0, c.durationSec - 1);
        if (body.trimEnd !== undefined) c.trimEnd = clamp(Number(body.trimEnd) || 0, 0, c.durationSec - 1 - c.trimStart);
        if (body.captionText !== undefined) c.captionText = body.captionText === null ? undefined : String(body.captionText);
        if (body.durationSec !== undefined && c.status !== 'ready') c.durationSec = clamp(Math.round(Number(body.durationSec)), 3, d.brief.maxClipSec);
      }),
    );
  }),
);

router.post(
  '/projects/:id/clips/:clipId/rebuild',
  h((req, res) => {
    res.json(
      store.update(param(req, 'id'), (d) => {
        const c = d.clips.find((x) => x.id === param(req, 'clipId'));
        const scene = d.script?.scenes.find((s) => s.id === c?.sceneId);
        if (!c || !scene) throw new HttpError(404, 'Clip not found');
        const withVideo = c.index > 0 && c.useVideoRef;
        c.prompt = buildClipPrompt(d, { ...scene, durationSec: c.durationSec }, withVideo);
        c.imageAssetIds = selectImageRefs(d, scene, withVideo);
      }),
    );
  }),
);

router.get(
  '/projects/:id/clips/:clipId/final-prompt',
  h((req, res) => {
    const p = store.get(param(req, 'id'));
    const c = p.clips.find((x) => x.id === param(req, 'clipId'));
    if (!c) throw new HttpError(404, 'Clip not found');
    res.json({ prompt: finalPrompt(p, c, c.index > 0 && c.useVideoRef) });
  }),
);

router.post(
  '/projects/:id/clips/:clipId/restore',
  h((req, res) => {
    res.json(restoreVersion(param(req, 'id'), param(req, 'clipId'), Number((req.body as { version: number }).version)));
  }),
);

router.post(
  '/projects/:id/generate',
  h((req, res) => {
    const body = req.body as { mode?: GenerateMode; clipId?: string };
    const mode: GenerateMode = body.mode === 'one' || body.mode === 'from' ? body.mode : 'all';
    background('generate', startGeneration(param(req, 'id'), mode, body.clipId));
    res.status(202).json(store.get(param(req, 'id')));
  }),
);

router.post(
  '/projects/:id/cancel',
  h((req, res) => {
    cancelGeneration(param(req, 'id'));
    res.json(store.get(param(req, 'id')));
  }),
);

// ----- edit & export ------------------------------------------------------------------------

router.put(
  '/projects/:id/edit',
  h((req, res) => {
    const e = req.body as EditSettings;
    res.json(
      store.update(param(req, 'id'), (d) => {
        d.edit = {
          ...d.edit,
          ...e,
          transition: { ...d.edit.transition, ...e.transition, durationSec: clamp(Number(e.transition?.durationSec ?? 0.3), 0, 1.5) },
          captions: { ...d.edit.captions, ...e.captions },
          music: { ...d.edit.music, ...e.music },
          logo: { ...d.edit.logo, ...e.logo },
          endCard: { ...d.edit.endCard, ...e.endCard },
          sfx: (e.sfx ?? d.edit.sfx).map((s) => ({ ...s, id: s.id || newId('fx_'), atSec: Math.max(0, Number(s.atSec) || 0), volume: clamp(Number(s.volume) || 1, 0, 3) })),
        };
      }),
    );
  }),
);

router.post(
  '/projects/:id/render',
  h((req, res) => {
    background('render', startRender(param(req, 'id')));
    res.status(202).json(store.get(param(req, 'id')));
  }),
);

router.post(
  '/projects/:id/autopilot',
  h((req, res) => {
    const p = store.get(param(req, 'id'));
    if (p.autopilot.running) throw new HttpError(409, 'Autopilot already running');
    if (!p.brief.idea.trim() && !p.assets.length) throw new HttpError(400, 'Describe your idea or add some assets first');
    store.update(p.id, (d) => {
      d.autopilot = { running: true, step: 'Starting' };
    });
    background('autopilot', runAutopilot(p.id));
    res.status(202).json(store.get(p.id));
  }),
);

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}
