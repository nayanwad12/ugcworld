import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.ts';
import type { Brief, EditSettings, Project } from '../../shared/types.ts';

export const newId = (prefix = '') => prefix + crypto.randomBytes(6).toString('hex');
export const nowIso = () => new Date().toISOString();

export function projectDir(id: string) {
  if (!/^[a-z0-9_-]+$/i.test(id)) throw new HttpError(400, 'Invalid project id');
  return path.join(config.dataDir, 'projects', id);
}

/** Public URL path (served from /files) for a file inside the data dir. */
export function fileUrl(absPath: string) {
  const rel = path.relative(config.dataDir, absPath).split(path.sep).join('/');
  return `/files/${rel}`;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function defaultBrief(): Brief {
  return {
    idea: '',
    durationSec: 30,
    platform: 'tiktok',
    language: 'English',
    format: 'ugc',
    tone: 'authentic, energetic',
    brandName: '',
    cta: '',
    maxClipSec: config.clip.maxSec,
  };
}

export function defaultEdit(): EditSettings {
  return {
    transition: { type: 'cut', durationSec: 0.3 },
    captions: {
      enabled: true,
      style: 'karaoke',
      position: 'bottom',
      uppercase: true,
      wordsPerLine: 3,
      fontSize: 84,
      highlightColor: '#FFE600',
    },
    voiceVolume: 1,
    music: { volume: 0.25, duck: true, fadeOutSec: 1.5 },
    sfx: [],
    logo: { enabled: false, position: 'top-right', scale: 0.16, opacity: 0.9 },
    endCard: {
      enabled: false,
      durationSec: 2.5,
      headline: '',
      cta: '',
      bgColor: '#0B0B12',
      textColor: '#FFFFFF',
    },
  };
}

class ProjectStore {
  private cache = new Map<string, Project>();
  private writes = new Map<string, Promise<void>>();
  private listeners = new Set<(p: Project) => void>();

  init() {
    fs.mkdirSync(path.join(config.dataDir, 'projects'), { recursive: true });
    for (const id of fs.readdirSync(path.join(config.dataDir, 'projects'))) {
      const file = path.join(config.dataDir, 'projects', id, 'project.json');
      if (!fs.existsSync(file)) continue;
      try {
        const p = JSON.parse(fs.readFileSync(file, 'utf8')) as Project;
        this.cache.set(p.id, migrate(p));
      } catch (err) {
        console.error(`[store] failed to load ${file}:`, err);
      }
    }
  }

  onChange(fn: (p: Project) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  list(): Project[] {
    return [...this.cache.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string): Project {
    const p = this.cache.get(id);
    if (!p) throw new HttpError(404, 'Project not found');
    return p;
  }

  create(name: string): Project {
    const id = newId('p_');
    const p: Project = {
      id,
      name: name || 'Untitled video',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      stage: 'brief',
      brief: defaultBrief(),
      assets: [],
      concepts: [],
      clips: [],
      generating: false,
      edit: defaultEdit(),
      render: { status: 'idle', progress: 0, history: [] },
      autopilot: { running: false },
    };
    fs.mkdirSync(projectDir(id), { recursive: true });
    this.cache.set(id, p);
    this.persist(p);
    return p;
  }

  /** Apply a synchronous mutation and persist. Returns the updated project. */
  update(id: string, fn: (p: Project) => void): Project {
    const p = this.get(id);
    fn(p);
    p.updatedAt = nowIso();
    this.persist(p);
    return p;
  }

  remove(id: string) {
    this.get(id);
    this.cache.delete(id);
    fs.rmSync(projectDir(id), { recursive: true, force: true });
  }

  private persist(p: Project) {
    for (const l of this.listeners) l(p);
    const file = path.join(projectDir(p.id), 'project.json');
    const snapshot = JSON.stringify(p, null, 2);
    const prev = this.writes.get(p.id) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.writeFile(file + '.tmp', snapshot);
        await fs.promises.rename(file + '.tmp', file);
      })
      .catch((err) => console.error('[store] write failed', err));
    this.writes.set(p.id, next);
  }
}

/** Fill in fields added after a project was first saved. */
function migrate(p: Project): Project {
  p.brief = { ...defaultBrief(), ...p.brief };
  const e = defaultEdit();
  p.edit = {
    ...e,
    ...p.edit,
    transition: { ...e.transition, ...p.edit?.transition },
    captions: { ...e.captions, ...p.edit?.captions },
    music: { ...e.music, ...p.edit?.music },
    logo: { ...e.logo, ...p.edit?.logo },
    endCard: { ...e.endCard, ...p.edit?.endCard },
    sfx: p.edit?.sfx ?? [],
  };
  p.render ??= { status: 'idle', progress: 0, history: [] };
  p.render.history ??= [];
  p.autopilot ??= { running: false };
  p.clips ??= [];
  p.concepts ??= [];
  p.assets ??= [];
  return p;
}

export const store = new ProjectStore();
