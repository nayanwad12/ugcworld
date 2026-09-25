import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { config, SERVER_ROOT } from '../config.ts';

const require = createRequire(import.meta.url);

function resolveBinary(explicit: string, name: 'ffmpeg' | 'ffprobe', installerPkg: string): string {
  if (explicit) return explicit;
  // Prefer a system install (usually newer: has xfade etc.), fall back to the bundled static build.
  const probe = spawnSync(name, ['-version'], { stdio: 'ignore' });
  if (probe.status === 0) return name;
  try {
    return (require(installerPkg) as { path: string }).path;
  } catch {
    return name;
  }
}

export const FFMPEG = resolveBinary(config.ffmpegPath, 'ffmpeg', '@ffmpeg-installer/ffmpeg');
export const FFPROBE = resolveBinary(config.ffprobePath, 'ffprobe', '@ffprobe-installer/ffprobe');

/** Directory with TTF fonts used for captions and end cards. */
export const FONTS_DIR = (() => {
  if (config.fontsDir) return config.fontsDir;
  try {
    return path.dirname(require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf'));
  } catch {
    return path.join(SERVER_ROOT, 'fonts');
  }
})();

export const BOLD_FONT_FILE = path.join(FONTS_DIR, 'DejaVuSans-Bold.ttf');

// A minimal fontconfig file pointing at our fonts (plus system fonts, for non-Latin glyph fallback such as
// Devanagari or Arabic) keeps libass deterministic; static FFmpeg builds otherwise warn about the system config.
const fontconfigFile = path.join(config.dataDir, 'fonts.conf');
let fontconfigReady = false;
function ensureFontconfig() {
  if (fontconfigReady) return;
  const dirs = [FONTS_DIR, '/usr/share/fonts', '/usr/local/share/fonts'].filter((d) => fs.existsSync(d));
  fs.mkdirSync(path.dirname(fontconfigFile), { recursive: true });
  fs.writeFileSync(
    fontconfigFile,
    `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n${dirs.map((d) => `  <dir>${d}</dir>`).join('\n')}\n  <cachedir>${path.join(config.dataDir, 'fontcache')}</cachedir>\n</fontconfig>\n`,
  );
  fontconfigReady = true;
}

let filterCache: Set<string> | undefined;
export function hasFilter(name: string): boolean {
  if (!filterCache) {
    const out = spawnSync(FFMPEG, ['-hide_banner', '-filters'], { encoding: 'utf8' });
    filterCache = new Set(
      (out.stdout || '')
        .split('\n')
        .map((l) => l.trim().split(/\s+/)[1])
        .filter(Boolean),
    );
  }
  return filterCache.has(name);
}

export interface RunOptions {
  /** Total output duration in seconds, used to report progress 0..1. */
  durationSec?: number;
  onProgress?: (fraction: number) => void;
  cwd?: string;
}

export function runFfmpeg(args: string[], opts: RunOptions = {}): Promise<void> {
  ensureFontconfig();
  return new Promise((resolve, reject) => {
    const fullArgs = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-progress', 'pipe:1', ...args];
    const child = spawn(FFMPEG, fullArgs, {
      cwd: opts.cwd,
      env: { ...process.env, FONTCONFIG_FILE: fontconfigFile },
    });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    child.stdout.on('data', (d: Buffer) => {
      if (!opts.onProgress || !opts.durationSec) return;
      const m = /out_time_(?:ms|us)=(\d+)/.exec(d.toString());
      if (m) opts.onProgress(Math.min(1, Number(m[1]) / 1e6 / opts.durationSec));
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${code}: ${stderr.trim().split('\n').slice(-6).join('\n')}\nargs: ${fullArgs.join(' ')}`));
    });
  });
}

export interface ProbeInfo {
  durationSec: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

export function probe(file: string): Promise<ProbeInfo> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', file]);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe failed: ${err}`));
      try {
        const j = JSON.parse(out) as { format?: { duration?: string }; streams?: { codec_type: string; width?: number; height?: number }[] };
        const v = j.streams?.find((s) => s.codec_type === 'video');
        resolve({
          durationSec: Number(j.format?.duration ?? 0),
          width: v?.width ?? 0,
          height: v?.height ?? 0,
          hasAudio: !!j.streams?.some((s) => s.codec_type === 'audio'),
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}
