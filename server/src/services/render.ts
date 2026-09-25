/**
 * Final edit with FFmpeg, in three passes:
 *  1. normalize  — each clip trimmed, scaled/cropped to the platform size, 24fps (Omni's native rate), stereo 48k (+ fades)
 *  2. assemble   — clips (+ generated end card) joined by cut, dip-to-black fade or crossfade
 *  3. finish     — logo watermark, burned-in captions, voice + music (ducked) + SFX mix, MP4 export
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileUrl, HttpError, nowIso, projectDir, store } from '../store.ts';
import { platformById, type Project } from '../../../shared/types.ts';
import { buildTimeline, captionsAss, clipDuration, endCardAss } from './captions.ts';
import { FONTS_DIR, hasFilter, probe, runFfmpeg } from './ffmpeg.ts';

const FPS = 24;
const ENCODE = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'];
const AUDIO_NORM = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';

export const canCrossfade = () => hasFilter('xfade');

export function startRender(projectId: string): Promise<void> {
  const p = store.get(projectId);
  if (p.render.status === 'rendering') throw new HttpError(409, 'Already rendering');
  const missing = p.clips.filter((c) => !c.localPath);
  if (!p.clips.length || missing.length) throw new HttpError(400, `Generate all clips first (missing: ${missing.map((c) => c.index + 1).join(', ') || 'all'})`);
  store.update(projectId, (d) => {
    d.render = { ...d.render, status: 'rendering', progress: 0, step: 'Preparing', error: undefined };
    d.stage = 'export';
  });
  return render(projectId).catch((err) => {
    console.error('[render] failed', err);
    store.update(projectId, (d) => {
      d.render = { ...d.render, status: 'failed', error: err instanceof Error ? err.message : String(err), updatedAt: nowIso() };
    });
  });
}

function progress(projectId: string, step: string, value: number) {
  store.update(projectId, (d) => {
    d.render.step = step;
    d.render.progress = Math.round(Math.min(99, value));
  });
}

async function render(projectId: string) {
  const p: Project = structuredClone(store.get(projectId));
  const { width: W, height: H } = platformById(p.brief.platform);
  const stamp = Date.now();
  const outDir = path.join(projectDir(projectId), 'renders');
  const work = path.join(outDir, `work_${stamp}`);
  fs.mkdirSync(work, { recursive: true });

  const clips = [...p.clips].sort((a, b) => a.index - b.index);
  const t = p.edit.transition;
  const wantCrossfade = t.type === 'crossfade' && canCrossfade() && t.durationSec > 0;
  const useFades = (t.type === 'fade' || (t.type === 'crossfade' && !wantCrossfade)) && t.durationSec > 0;
  const T = Math.min(1.5, Math.max(0.1, t.durationSec));

  const ec = p.edit.endCard;
  const endCardOn = ec.enabled && ec.durationSec > 0;
  const segments: { file: string; duration: number }[] = [];

  // --- 1. normalize clips ---------------------------------------------------------------
  for (const [i, clip] of clips.entries()) {
    progress(projectId, `Preparing clip ${i + 1}/${clips.length}`, (i / clips.length) * 40);
    const src = clip.localPath!;
    const info = await probe(src);
    const dur = Math.min(clipDuration(clip), Math.max(0.5, info.durationSec - (clip.trimStart || 0)));
    const isFirst = i === 0;
    const isLast = i === clips.length - 1 && !endCardOn;
    const vf = [`scale=${W}:${H}:force_original_aspect_ratio=increase`, `crop=${W}:${H}`, 'setsar=1', `fps=${FPS}`, 'format=yuv420p'];
    const af = [AUDIO_NORM];
    if (useFades && !isFirst) {
      vf.push(`fade=t=in:st=0:d=${T / 2}`);
      af.push(`afade=t=in:st=0:d=${T / 2}`);
    }
    if (useFades && !isLast) {
      vf.push(`fade=t=out:st=${Math.max(0, dur - T / 2)}:d=${T / 2}`);
      af.push(`afade=t=out:st=${Math.max(0, dur - T / 2)}:d=${T / 2}`);
    }
    const out = path.join(work, `seg_${i}.mp4`);
    const args = ['-ss', String(clip.trimStart || 0), '-t', String(dur), '-i', src];
    if (!info.hasAudio) args.push('-f', 'lavfi', '-t', String(dur), '-i', 'anullsrc=r=48000:cl=stereo');
    args.push('-vf', vf.join(','), '-af', af.join(','), '-map', '0:v:0', '-map', info.hasAudio ? '0:a:0' : '1:a:0', '-t', String(dur), ...ENCODE, out);
    await runFfmpeg(args);
    segments.push({ file: out, duration: dur });
    clip.durationSec = dur + (clip.trimStart || 0) + (clip.trimEnd || 0);
  }

  // --- 2a. end card -------------------------------------------------------------------------
  const logoAsset = (id?: string) => {
    const a = p.assets.find((x) => x.id === id);
    return a?.file && a.file.mime.startsWith('image/') ? a.file.path : undefined;
  };
  if (endCardOn) {
    progress(projectId, 'Building end card', 42);
    const logo = logoAsset(ec.logoAssetId ?? p.edit.logo.assetId ?? p.assets.find((a) => a.kind === 'logo')?.id);
    fs.writeFileSync(path.join(work, 'endcard.ass'), endCardAss(p, W, H, !!logo));
    const d = ec.durationSec;
    const args = ['-f', 'lavfi', '-i', `color=c=${hex(ec.bgColor)}:s=${W}x${H}:r=${FPS}:d=${d}`, '-f', 'lavfi', '-t', String(d), '-i', 'anullsrc=r=48000:cl=stereo'];
    let fc: string;
    if (logo) {
      args.push('-loop', '1', '-t', String(d), '-i', logo);
      const lw = Math.round(Math.min(W, H) * 0.42);
      fc = `[2:v]scale=${lw}:-1,format=rgba[lg];[0:v][lg]overlay=x=(W-w)/2:y=${Math.round(H * 0.4)}-h/2:shortest=1,ass=endcard.ass:fontsdir=${FONTS_DIR},fade=t=in:st=0:d=0.3,format=yuv420p[v]`;
    } else {
      fc = `[0:v]ass=endcard.ass:fontsdir=${FONTS_DIR},fade=t=in:st=0:d=0.3,format=yuv420p[v]`;
    }
    const out = path.join(work, 'endcard.mp4');
    await runFfmpeg([...args, '-filter_complex', fc, '-map', '[v]', '-map', '1:a', '-t', String(d), ...ENCODE, out], { cwd: work });
    segments.push({ file: out, duration: d });
  }

  // --- 2b. assemble ----------------------------------------------------------------------
  progress(projectId, 'Joining clips', 48);
  const base = path.join(work, 'base.mp4');
  let total: number;
  if (wantCrossfade && segments.length > 1) {
    const inputs = segments.flatMap((s) => ['-i', s.file]);
    const parts: string[] = [];
    let offset = 0;
    let vPrev = '[0:v]';
    let aPrev = '[0:a]';
    segments.forEach((s, i) => {
      if (i === 0) {
        offset = s.duration;
        return;
      }
      offset -= T;
      const v = `[v${i}]`;
      const a = `[a${i}]`;
      parts.push(`${vPrev}[${i}:v]xfade=transition=fade:duration=${T}:offset=${offset.toFixed(3)}${v}`);
      parts.push(`${aPrev}[${i}:a]acrossfade=d=${T}${a}`);
      offset += s.duration;
      vPrev = v;
      aPrev = a;
    });
    total = offset;
    await runFfmpeg([...inputs, '-filter_complex', parts.join(';'), '-map', vPrev, '-map', aPrev, ...ENCODE, base], {
      durationSec: total,
      onProgress: (f) => progress(projectId, 'Joining clips', 48 + f * 12),
    });
  } else {
    const list = path.join(work, 'concat.txt');
    fs.writeFileSync(list, segments.map((s) => `file '${s.file.replace(/'/g, "'\\''")}'`).join('\n'));
    await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', base]);
    total = segments.reduce((a, s) => a + s.duration, 0);
  }
  total = (await probe(base)).durationSec || total;

  const finalName = `ideabro_${slug(p.script?.title || p.name)}_${stamp}.mp4`;
  const finalFile = path.join(outDir, finalName);
  const music = p.assets.find((a) => a.id === p.edit.music.assetId && a.file);
  const lg = p.edit.logo;
  const logoFile = lg.enabled ? logoAsset(lg.assetId ?? p.assets.find((a) => a.kind === 'logo')?.id) : undefined;
  const hasSfx = p.edit.sfx.some((c) => p.assets.some((a) => a.id === c.assetId && a.file));
  const plainJoin = !p.edit.captions.enabled && !logoFile && !music && !hasSfx && (p.edit.voiceVolume ?? 1) === 1;

  if (plainJoin) {
    // First draft: just the clips joined, Omni's own audio untouched.
    progress(projectId, 'Finalizing MP4', 90);
    await runFfmpeg(['-i', base, '-c', 'copy', '-movflags', '+faststart', finalFile]);
  } else {
    // --- 3. finish: logo, captions, audio mix -------------------------------------------------
    progress(projectId, 'Captions, logo & audio mix', 60);
    const contentEnd = endCardOn ? total - ec.durationSec : total;
    const { items } = buildTimeline(clips, p.edit, wantCrossfade);
    const ass = captionsAss(p, items, W, H);
    if (ass) fs.writeFileSync(path.join(work, 'captions.ass'), ass);

    const args: string[] = ['-i', base];
    const filters: string[] = [];
    let v = '[0:v]';
    let next = 1;

    if (logoFile) {
      args.push('-loop', '1', '-i', logoFile);
      const idx = next++;
      const lw = Math.round(W * Math.min(0.6, Math.max(0.05, lg.scale)));
      const m = Math.round(W * 0.045);
      const x = lg.position.endsWith('left') ? `${m}` : `main_w-overlay_w-${m}`;
      const y = lg.position.startsWith('top') ? `${Math.round(H * 0.05)}` : `main_h-overlay_h-${Math.round(H * 0.05)}`;
      filters.push(`[${idx}:v]scale=${lw}:-1,format=rgba,colorchannelmixer=aa=${lg.opacity.toFixed(2)}[lg]`);
      filters.push(`${v}[lg]overlay=x=${x}:y=${y}:shortest=1:enable='lt(t,${contentEnd.toFixed(2)})'[vl]`);
      v = '[vl]';
    }
    if (ass) {
      filters.push(`${v}ass=captions.ass:fontsdir=${FONTS_DIR}[vc]`);
      v = '[vc]';
    }
    filters.push(`${v}format=yuv420p[vout]`);

    // Audio
    const audioIns: string[] = [];
    const voiceVol = p.edit.voiceVolume ?? 1;
    const duck = !!music && p.edit.music.duck;
    filters.push(`[0:a]${AUDIO_NORM},volume=${voiceVol}${duck ? ',asplit=2[voice][sc]' : '[voice]'}`);
    audioIns.push('[voice]');
    if (music?.file) {
      args.push('-stream_loop', '-1', '-i', music.file.path);
      const idx = next++;
      const fo = Math.min(p.edit.music.fadeOutSec, total / 2);
      filters.push(
        `[${idx}:a]${AUDIO_NORM},atrim=0:${total.toFixed(3)},asetpts=PTS-STARTPTS,volume=${p.edit.music.volume},afade=t=out:st=${Math.max(0, total - fo).toFixed(3)}:d=${fo}${duck ? '[mraw]' : '[music]'}`,
      );
      if (duck) filters.push('[mraw][sc]sidechaincompress=threshold=0.04:ratio=8:attack=20:release=400:makeup=1[music]');
      audioIns.push('[music]');
    }
    for (const [k, cue] of p.edit.sfx.entries()) {
      const a = p.assets.find((x) => x.id === cue.assetId);
      if (!a?.file || cue.atSec >= total) continue;
      args.push('-i', a.file.path);
      const idx = next++;
      const ms = Math.round(Math.max(0, cue.atSec) * 1000);
      filters.push(`[${idx}:a]${AUDIO_NORM},volume=${cue.volume},adelay=${ms}|${ms}[sfx${k}]`);
      audioIns.push(`[sfx${k}]`);
    }
    if (audioIns.length > 1) {
      // amix scales inputs by 1/N; compensate, then limit.
      filters.push(`${audioIns.join('')}amix=inputs=${audioIns.length}:duration=first:dropout_transition=0,volume=${audioIns.length},alimiter=limit=0.95[aout]`);
    } else {
      filters.push('[voice]alimiter=limit=0.95[aout]');
    }

    await runFfmpeg(
      [
        ...args,
        '-filter_complex', filters.join(';'),
        '-map', '[vout]', '-map', '[aout]',
        '-t', total.toFixed(3),
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS),
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
        '-movflags', '+faststart',
        finalFile,
      ],
      { cwd: work, durationSec: total, onProgress: (f) => progress(projectId, 'Captions, logo & audio mix', 60 + f * 39) },
    );
  }

  fs.rmSync(work, { recursive: true, force: true });
  const url = fileUrl(finalFile);
  store.update(projectId, (d) => {
    d.render = {
      status: 'done',
      progress: 100,
      step: 'Done',
      url,
      durationSec: Math.round(total * 10) / 10,
      updatedAt: nowIso(),
      history: [{ url, createdAt: nowIso(), durationSec: Math.round(total * 10) / 10 }, ...d.render.history].slice(0, 10),
    };
  });
}

const hex = (c: string) => (/^#?[0-9a-f]{6}$/i.test(c) ? `0x${c.replace('#', '')}` : '0x000000');
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'video';
