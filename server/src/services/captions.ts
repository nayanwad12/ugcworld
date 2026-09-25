import type { Clip, EditSettings, Project } from '../../../shared/types.ts';
import { config } from '../config.ts';

export interface TimelineItem {
  clip: Clip;
  start: number;
  duration: number;
}

export function clipDuration(c: Clip) {
  return Math.max(0.5, c.durationSec - (c.trimStart || 0) - (c.trimEnd || 0));
}

/** Where each clip lands in the final edit (crossfades overlap neighbouring clips). */
export function buildTimeline(clips: Clip[], edit: EditSettings, crossfade: boolean): { items: TimelineItem[]; total: number } {
  const overlap = crossfade ? edit.transition.durationSec : 0;
  let t = 0;
  const items = clips.map((clip, i) => {
    const duration = clipDuration(clip);
    const start = i === 0 ? 0 : t - overlap;
    t = start + duration;
    return { clip, start, duration };
  });
  return { items, total: t };
}

const pad = (n: number, w = 2) => String(Math.floor(n)).padStart(w, '0');
function assTime(sec: number) {
  const s = Math.max(0, sec);
  const cs = Math.round((s % 1) * 100) % 100;
  return `${Math.floor(s / 3600)}:${pad((s / 60) % 60)}:${pad(s % 60)}.${pad(cs)}`;
}

/** #RRGGBB (+ alpha 0..1 opacity) -> ASS &HAABBGGRR */
export function assColor(hex: string, opacity = 1) {
  const h = hex.replace('#', '').padEnd(6, '0');
  const a = Math.round((1 - opacity) * 255);
  return `&H${pad16(a)}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}
const pad16 = (n: number) => n.toString(16).padStart(2, '0');

const escapeAss = (s: string) => s.replace(/\\/g, '\\\\').replace(/[{}]/g, '').replace(/\n/g, ' ');

interface Cue {
  start: number;
  end: number;
  words: { text: string; start: number; end: number }[];
}

/** Spread a line of dialogue over a time window, weighting words by length. */
export function timeWords(text: string, start: number, end: number, wordsPerLine: number): Cue[] {
  const words = text.split(/\s+/).map((w) => w.trim()).filter(Boolean);
  if (!words.length || end <= start) return [];
  const weights = words.map((w) => w.length + 2);
  const totalW = weights.reduce((a, b) => a + b, 0);
  let t = start;
  const timed = words.map((w, i) => {
    const d = ((end - start) * weights[i]) / totalW;
    const item = { text: w, start: t, end: t + d };
    t += d;
    return item;
  });
  const cues: Cue[] = [];
  const perLine = Math.max(1, wordsPerLine);
  for (let i = 0; i < timed.length; i += perLine) {
    let chunk = timed.slice(i, i + perLine);
    // Break early after sentence punctuation for more natural captions.
    const stop = chunk.findIndex((w, k) => k < chunk.length - 1 && /[.!?]$/.test(w.text));
    if (stop >= 0) {
      chunk = chunk.slice(0, stop + 1);
      i -= perLine - chunk.length;
    }
    cues.push({ start: chunk[0].start, end: chunk[chunk.length - 1].end, words: chunk });
  }
  return cues;
}

function header(w: number, h: number, styles: string[]) {
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${w}
PlayResY: ${h}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styles.join('\n')}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
}

export function captionsAss(p: Project, items: TimelineItem[], w: number, h: number): string | undefined {
  const cap = p.edit.captions;
  if (!cap.enabled) return undefined;
  const scale = Math.min(w, h * (9 / 16)) / 1080;
  const size = Math.round(cap.fontSize * scale * (w > h ? 1.25 : 1));
  const align = cap.position === 'top' ? 8 : cap.position === 'middle' ? 5 : 2;
  const marginV = cap.position === 'middle' ? 0 : Math.round(h * (cap.position === 'top' ? 0.12 : 0.2));
  const clean = cap.style === 'clean';
  const style =
    `Style: Cap,${config.captionFont},${size},${assColor('#FFFFFF')},${assColor('#FFFFFF')},` +
    (clean
      ? `${assColor('#000000', 0.55)},${assColor('#000000', 0.55)},-1,0,0,0,100,100,0,0,3,${Math.round(size * 0.22)},0,`
      : `${assColor('#000000')},${assColor('#000000', 0.6)},-1,0,0,0,100,100,1,0,1,${Math.max(3, Math.round(size * 0.08))},${Math.round(size * 0.04)},`) +
    `${align},${Math.round(w * 0.08)},${Math.round(w * 0.08)},${marginV},1`;

  const lines: string[] = [];
  const hl = assColor(cap.highlightColor || '#FFE600');
  for (const it of items) {
    const scene = p.script?.scenes.find((s) => s.id === it.clip.sceneId);
    const text = (it.clip.captionText ?? scene?.dialogue ?? '').trim();
    if (!text) continue;
    const cues = timeWords(cap.uppercase ? text.toUpperCase() : text, it.start + 0.15, it.start + it.duration - 0.2, cap.wordsPerLine);
    for (const cue of cues) {
      if (cap.style === 'karaoke') {
        cue.words.forEach((word, k) => {
          const end = k === cue.words.length - 1 ? cue.end : cue.words[k + 1].start;
          const txt = cue.words
            .map((x, j) => (j === k ? `{\\c${hl}\\fscx112\\fscy112}${escapeAss(x.text)}{\\r}` : escapeAss(x.text)))
            .join(' ');
          lines.push(`Dialogue: 0,${assTime(word.start)},${assTime(end)},Cap,,0,0,0,,${txt}`);
        });
      } else {
        lines.push(`Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Cap,,0,0,0,,${cue.words.map((x) => escapeAss(x.text)).join(' ')}`);
      }
    }
  }
  return header(w, h, [style]) + lines.join('\n') + '\n';
}

export function endCardAss(p: Project, w: number, h: number, hasLogo: boolean): string {
  const ec = p.edit.endCard;
  const scale = Math.min(w, h) / 1080;
  const headline = Math.round(92 * scale);
  const cta = Math.round(60 * scale);
  const headY = hasLogo ? Math.round(h * 0.6) : Math.round(h * 0.47);
  const text = assColor(ec.textColor || '#FFFFFF');
  const bg = assColor(ec.bgColor || '#000000');
  const styles = [
    `Style: Head,${config.captionFont},${headline},${text},${text},${bg},${bg},-1,0,0,0,100,100,0,0,1,0,0,5,60,60,0,1`,
    `Style: Cta,${config.captionFont},${cta},${bg},${bg},${text},${text},-1,0,0,0,100,100,1,0,3,${Math.round(cta * 0.45)},0,5,60,60,0,1`,
  ];
  const d = assTime(ec.durationSec + 1);
  const events = [
    ec.headline && `Dialogue: 0,0:00:00.00,${d},Head,,0,0,0,,{\\an5\\pos(${w / 2},${headY})\\fad(300,0)}${escapeAss(ec.headline)}`,
    ec.cta && `Dialogue: 0,0:00:00.25,${d},Cta,,0,0,0,,{\\an5\\pos(${w / 2},${headY + Math.round(headline * 1.6)})\\fad(300,0)}${escapeAss(ec.cta)}`,
  ].filter(Boolean);
  return header(w, h, styles) + events.join('\n') + '\n';
}
