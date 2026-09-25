import fs from 'node:fs';
import path from 'node:path';
import { platformById, type Project, type Scene } from '../../../shared/types.ts';
import { BOLD_FONT_FILE, runFfmpeg } from './ffmpeg.ts';

const COLORS = ['0x3b2a8f', '0x8f2a5a', '0x1f6f5c', '0x7a5a12', '0x274b8f', '0x6b2a8f'];

/**
 * Offline stand-in for Omni: renders a labelled placeholder clip with a tone "voice" so the
 * whole pipeline (timeline, regenerate, captions, music ducking, export) works without an API key.
 */
export async function renderMockClip(p: Project, scene: Scene, outFile: string, version: number) {
  const platform = platformById(p.brief.platform);
  // Mock output at a lower resolution to keep it fast; the renderer scales everything anyway.
  const w = Math.round(platform.width / 2 / 2) * 2;
  const h = Math.round(platform.height / 2 / 2) * 2;
  const dir = path.dirname(outFile);
  fs.mkdirSync(dir, { recursive: true });
  const textFile = path.join(dir, `mock_${scene.index}_v${version}.txt`);
  const wrap = (s: string, n: number) => s.replace(new RegExp(`(.{1,${n}})(\\s+|$)`, 'g'), '$1\n').trim();
  fs.writeFileSync(
    textFile,
    [`CLIP ${scene.index + 1}  v${version}  (${scene.durationSec}s)`, scene.beat.toUpperCase(), '', wrap(scene.camera, 30), '', wrap(`"${scene.dialogue}"`, 30)].join('\n'),
  );
  const color = COLORS[(scene.index + version) % COLORS.length];
  const fontSize = Math.round(w / 22);
  await runFfmpeg([
    '-f', 'lavfi', '-i', `color=c=${color}:s=${w}x${h}:r=30:d=${scene.durationSec}`,
    '-f', 'lavfi', '-i', `sine=frequency=${180 + scene.index * 40}:sample_rate=48000:duration=${scene.durationSec}`,
    '-filter_complex',
    `[0:v]drawtext=fontfile='${BOLD_FONT_FILE}':textfile='${textFile}':fontcolor=white:fontsize=${fontSize}:line_spacing=10:x=(w-text_w)/2:y=h*0.18[v];` +
      `[1:a]volume=0.9,aformat=channel_layouts=stereo[a]`,
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    outFile,
  ]);
}
