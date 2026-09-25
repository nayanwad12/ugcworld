import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { config } from './config.ts';
import { HttpError, store } from './store.ts';
import { router } from './routes/projects.ts';
import { resumeInterrupted } from './services/generator.ts';
import { canCrossfade } from './services/render.ts';
import { FFMPEG } from './services/ffmpeg.ts';
import { LANGUAGES, PLATFORMS, type AppConfig } from '../../shared/types.ts';

store.init();
resumeInterrupted();

const app = express();
app.use(express.json({ limit: '5mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/config', (_req, res) => {
  const out: AppConfig = {
    mockVideo: config.mockVideo,
    mockLlm: config.mockLlm,
    videoModel: config.apimart.videoModel,
    llmModel: config.llm.model,
    maxImageRefs: config.apimart.maxImageRefs,
    maxClipSec: config.clip.maxSec,
    minClipSec: config.clip.minSec,
    publicBaseUrl: config.publicBaseUrl,
    xfade: canCrossfade(),
    platforms: PLATFORMS,
    languages: LANGUAGES,
  };
  res.json(out);
});

app.use('/api', router);

// Uploaded assets, generated clips and renders. Also what APIMart fetches when PUBLIC_BASE_URL is set.
app.use('/files', express.static(config.dataDir, { fallthrough: false, index: false, dotfiles: 'deny' }));

if (fs.existsSync(config.webDist)) {
  app.use(express.static(config.webDist));
  app.get(/^\/(?!api|files).*/, (_req, res) => res.sendFile(path.join(config.webDist, 'index.html')));
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof HttpError ? err.status : (err as { status?: number })?.status ?? 500;
  const message = err instanceof Error ? err.message : String(err);
  if (status >= 500) console.error('[api]', err);
  res.status(status).json({ error: message });
});

app.listen(config.port, () => {
  console.log(`\n  Ideabro server  →  http://localhost:${config.port}`);
  console.log(`  video: ${config.mockVideo ? 'MOCK (set APIMART_API_KEY for real generation)' : `APIMart ${config.apimart.videoModel}`}`);
  console.log(`  llm:   ${config.mockLlm ? 'MOCK (set APIMART_API_KEY or LLM_API_KEY)' : config.llm.model}`);
  console.log(`  ffmpeg: ${FFMPEG}${canCrossfade() ? '' : ' (no xfade: crossfades fall back to dip-to-black)'}\n`);
});
