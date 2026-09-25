import { config } from '../config.ts';
import { newId } from '../store.ts';
import { chat, chatJson, imageToDataUri } from './llm.ts';
import {
  platformById,
  splitDuration,
  type Asset,
  type AssetKind,
  type Beat,
  type CastNote,
  type Concept,
  type Project,
  type Scene,
  type Script,
} from '../../../shared/types.ts';

const FORMAT_LABEL: Record<string, string> = {
  ugc: 'UGC (user-generated-content style: a real person talking to their phone camera, authentic, unpolished, native to social feeds)',
  ad: 'performance ad (scroll-stopping hook, clear benefits, strong CTA)',
  campaign: 'brand campaign film (cinematic, emotional, brand storytelling)',
  film: 'short AI film (narrative, cinematic, story-first)',
};

const BEATS: Beat[] = ['hook', 'problem', 'solution', 'demo', 'benefit', 'social-proof', 'offer', 'cta', 'story', 'other'];

function assetLines(assets: Asset[]) {
  const visual = assets.filter((a) => a.kind !== 'music' && a.kind !== 'sfx');
  if (!visual.length) return 'No assets were provided. Invent a fitting cast, product look and environment.';
  return visual
    .map((a) => `- @${a.tag} [${a.kind}] ${a.name ? `"${a.name}"` : ''} ${a.file || a.remoteUrl ? '(reference image provided)' : '(no image)'}: ${a.description || 'no description'}`)
    .join('\n');
}

function briefBlock(p: Project) {
  const b = p.brief;
  const platform = platformById(b.platform);
  return [
    `IDEA: ${b.idea || '(none given — propose something compelling for the assets)'}`,
    `FORMAT: ${FORMAT_LABEL[b.format] ?? b.format}`,
    `TOTAL DURATION: ${b.durationSec} seconds`,
    `PLATFORM: ${platform.label} (${platform.aspect})`,
    `LANGUAGE for all spoken dialogue and on-screen copy: ${b.language}`,
    b.tone && `TONE: ${b.tone}`,
    b.brandName && `BRAND: ${b.brandName}`,
    b.cta && `CALL TO ACTION: ${b.cta}`,
    `ASSETS (referenced by @tag):\n${assetLines(p.assets)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Concepts
// ---------------------------------------------------------------------------

export async function generateConcepts(p: Project): Promise<Concept[]> {
  if (config.mockLlm) return mockConcepts(p);
  const system = `You are Ideabro, a senior creative strategist for short-form video ads and UGC.
Return JSON: {"concepts":[{"title":string,"hook":string,"angle":string,"summary":string}]} with exactly 3 distinct concepts.
- "hook" is the literal first line spoken in the first 2 seconds, written in the requested language.
- "angle" names the creative angle (e.g. problem/solution, testimonial, before/after, day-in-the-life, unboxing, myth-busting, POV, skit).
- "summary" is 2-3 sentences describing the video beat by beat.
Concepts must be producible as a sequence of continuous AI-generated clips of at most ${p.brief.maxClipSec}s each and must use the provided @assets.`;
  const out = await chatJson<{ concepts: Omit<Concept, 'id'>[] }>(system, briefBlock(p));
  return (out.concepts ?? []).slice(0, 3).map((c) => ({ id: newId('c_'), title: c.title, hook: c.hook, angle: c.angle, summary: c.summary }));
}

// ---------------------------------------------------------------------------
// Script + scene split
// ---------------------------------------------------------------------------

interface RawScript {
  title?: string;
  logline?: string;
  voiceStyle?: string;
  musicMood?: string;
  visualStyle?: string;
  cast?: { tag?: string; kind?: string; description?: string }[];
  scenes?: Partial<Scene>[];
  endCard?: { headline?: string; cta?: string };
}

export async function generateScript(p: Project): Promise<Script> {
  const concept = p.concepts.find((c) => c.id === p.selectedConceptId);
  const durations = splitDuration(p.brief.durationSec, p.brief.maxClipSec, config.clip.minSec);
  if (config.mockLlm) return normalizeScript(mockScript(p, concept, durations), p, durations);

  const system = `You are Ideabro, an expert short-form video director and scriptwriter.
You write scripts that are produced with Gemini Omni Flash: each scene becomes ONE continuous AI-generated clip with native audio (the character speaks the dialogue on camera, lip-synced).
The model decides each clip's exact length (3–10s) from the content, so keep each scene's dialogue speakable within its target duration.
Clip N+1 is generated using clip N as a video reference, so the model continues the same people, product and look. Scenes can still change camera angle, framing, location or introduce new people — describe those changes explicitly in "changes".

Return JSON with this exact shape:
{
  "title": string,
  "logline": string,
  "voiceStyle": string,        // how the speaker sounds (age, accent, energy, pace)
  "musicMood": string,         // background music direction for the edit
  "visualStyle": string,       // camera/look, e.g. "handheld iPhone selfie, natural window light"
  "cast": [ { "tag": string, "kind": "creator"|"product"|"environment"|"narrator"|"props"|"logo"|"other", "description": string } ],
  "scenes": [ {
     "beat": ${BEATS.map((b) => `"${b}"`).join('|')},
     "setting": string, "camera": string, "action": string,
     "dialogue": string,       // spoken words, in the requested language, natural and speakable within the scene duration (~2.5 words per second max)
     "speaker": string,        // "@tag" of who talks on camera, or "narrator (voice-over)"
     "assetTags": string[],    // tags without "@" visible or heard in the scene
     "changes": string,        // what differs from the previous clip (empty for scene 1)
     "sfx": string             // short sound design idea, or ""
  } ],
  "endCard": { "headline": string, "cta": string }
}
Rules:
- Produce EXACTLY ${durations.length} scenes with these durations in seconds: ${durations.join(', ')}.
- Every user-provided @asset must appear in the cast with its tag unchanged; enrich the description only with visual details consistent with it.
- If there is no creator/presenter, no environment, or (for voice-over) no narrator, INVENT one and add it to the cast with a vivid, specific visual description (age, look, wardrobe, setting details, lighting). Use tags "creator", "environment", "narrator".
- Scene 1 must open with the hook. The last scene should land the call to action.
- Do not ask for on-screen text inside the generated video; captions are added in post.`;

  const user = `${briefBlock(p)}\n\nCHOSEN CONCEPT:\n${concept ? `${concept.title} — ${concept.angle}\nHook: ${concept.hook}\n${concept.summary}` : '(none — create the best concept yourself)'}`;
  const raw = await chatJson<RawScript>(system, user, { temperature: 0.7 });
  return normalizeScript(raw, p, durations);
}

/** Force the model output into a valid Script with the exact clip plan. */
export function normalizeScript(raw: RawScript, p: Project, durations: number[]): Script {
  const kinds: AssetKind[] = ['creator', 'product', 'environment', 'logo', 'props', 'narrator', 'other'];
  const cast: CastNote[] = [];
  const userTags = new Set(p.assets.map((a) => a.tag));
  // User assets first, always.
  for (const a of p.assets) {
    if (a.kind === 'music' || a.kind === 'sfx') continue;
    const fromModel = raw.cast?.find((c) => cleanTag(c.tag) === a.tag);
    cast.push({ tag: a.tag, kind: a.kind, description: a.description || fromModel?.description || a.name, generated: false });
  }
  for (const c of raw.cast ?? []) {
    const tag = cleanTag(c.tag);
    if (!tag || userTags.has(tag) || cast.some((x) => x.tag === tag)) continue;
    const kind = (kinds.includes(c.kind as AssetKind) ? c.kind : 'other') as AssetKind;
    cast.push({ tag, kind, description: c.description ?? '', generated: true });
  }

  const rawScenes = raw.scenes ?? [];
  const scenes: Scene[] = durations.map((durationSec, i) => {
    const s = rawScenes[i] ?? rawScenes[rawScenes.length - 1] ?? {};
    return {
      id: newId('s_'),
      index: i,
      durationSec,
      beat: BEATS.includes(s.beat as Beat) ? (s.beat as Beat) : i === 0 ? 'hook' : i === durations.length - 1 ? 'cta' : 'benefit',
      setting: s.setting ?? '',
      camera: s.camera ?? '',
      action: s.action ?? '',
      dialogue: s.dialogue ?? '',
      speaker: s.speaker ?? '@creator',
      assetTags: (s.assetTags ?? []).map(cleanTag).filter(Boolean),
      changes: i === 0 ? '' : (s.changes ?? ''),
      sfx: s.sfx ?? '',
    };
  });

  return {
    title: raw.title || p.name,
    logline: raw.logline ?? '',
    voiceStyle: raw.voiceStyle ?? '',
    musicMood: raw.musicMood ?? '',
    visualStyle: raw.visualStyle ?? '',
    cast,
    scenes,
    endCard: { headline: raw.endCard?.headline ?? p.brief.brandName ?? '', cta: raw.endCard?.cta ?? p.brief.cta ?? '' },
  };
}

const cleanTag = (t?: string) => (t ?? '').replace(/^@/, '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');

// ---------------------------------------------------------------------------
// Asset auto-description (vision)
// ---------------------------------------------------------------------------

export async function describeAsset(asset: Asset): Promise<string> {
  if (!asset.file || !asset.file.mime.startsWith('image/')) throw new Error('Only image assets can be auto-described');
  if (config.mockLlm) return `${asset.name || asset.tag} (${asset.kind}) — add a detailed description or configure an LLM key for auto-describe.`;
  const focus: Record<string, string> = {
    creator: 'the person: apparent age, gender presentation, ethnicity, hair, face, build, wardrobe, vibe',
    product: 'the product: type, shape, material, colors, label text and logo placement, packaging details',
    environment: 'the location: type of place, layout, furniture, colors, lighting, time of day, mood',
    logo: 'the logo: shapes, colors, typography, text',
    props: 'the object(s): what they are, look, colors, materials',
  };
  return chat(
    [
      {
        role: 'system',
        content: 'You write precise visual descriptions used to keep AI video generation consistent. One dense paragraph, max 70 words, no preamble.',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Describe ${focus[asset.kind] ?? 'the subject'}.` },
          { type: 'image_url', image_url: { url: imageToDataUri(asset.file.path, asset.file.mime) } },
        ],
      },
    ],
    { model: config.llm.visionModel, temperature: 0.2 },
  ).then((s) => s.trim());
}

// ---------------------------------------------------------------------------
// Offline mocks (no API key): deterministic but coherent, so the full pipeline can be exercised.
// ---------------------------------------------------------------------------

function subject(p: Project) {
  const product = p.assets.find((a) => a.kind === 'product');
  return product?.name || p.brief.brandName || p.brief.idea.split(/[.,\n]/)[0].slice(0, 60) || 'the product';
}

function mockConcepts(p: Project): Concept[] {
  const s = subject(p);
  return [
    { title: 'Honest first impression', angle: 'testimonial', hook: `Okay, I finally tried ${s} and I need to talk about it.`, summary: `Creator talks to camera about trying ${s}, shows it up close, lists the benefits and ends with a recommendation.` },
    { title: 'Problem → fix', angle: 'problem/solution', hook: `If your afternoons look like this, watch this.`, summary: `Opens on the pain point, reveals ${s} as the fix, demos it and closes with a clear CTA.` },
    { title: 'Day in the life', angle: 'day-in-the-life', hook: `Come with me — here's how ${s} fits into my day.`, summary: `Quick moments across a day showing ${s} in real use, ending with the payoff.` },
  ].map((c) => ({ id: newId('c_'), ...c }));
}

function mockScript(p: Project, concept: Concept | undefined, durations: number[]): RawScript {
  const s = subject(p);
  const has = (k: AssetKind) => p.assets.find((a) => a.kind === k);
  const creator = has('creator')?.tag ?? 'creator';
  const product = has('product')?.tag ?? 'product';
  const lines = [
    concept?.hook ?? `Okay, I finally tried ${s} and I need to talk about it.`,
    `Here's the thing — it actually works, and it tastes great too.`,
    `I use it every day now, and honestly it's the best part of my routine.`,
    `Seriously, go try ${s}. Link is right below.`,
  ];
  const beats: Beat[] = ['hook', 'benefit', 'demo', 'cta'];
  const angles = ['medium selfie shot, handheld', 'close-up on the product in hand', 'wide shot, creator walking and talking', 'medium close-up, direct to camera'];
  return {
    title: concept?.title ?? `${s} UGC`,
    logline: concept?.summary ?? '',
    voiceStyle: 'friendly, upbeat, conversational',
    musicMood: 'upbeat lo-fi pop, light and energetic',
    visualStyle: 'handheld smartphone footage, natural light, authentic UGC look',
    cast: [
      ...(has('creator') ? [] : [{ tag: 'creator', kind: 'creator', description: 'A friendly 25-year-old with shoulder-length dark hair, casual oversized hoodie, natural makeup, expressive and warm.' }]),
      ...(has('environment') ? [] : [{ tag: 'environment', kind: 'environment', description: 'A bright, cozy apartment living room with plants, soft daylight from a large window, neutral tones.' }]),
    ],
    scenes: durations.map((_, i) => {
      const k = i === 0 ? 0 : i === durations.length - 1 ? 3 : 1 + ((i - 1) % 2);
      return {
        beat: beats[k],
        setting: i === 0 ? 'the environment' : 'same place',
        camera: angles[k],
        action: i === 0 ? `@${creator} holds up @${product} and talks to the camera.` : `@${creator} keeps talking while using @${product}.`,
        dialogue: lines[k],
        speaker: `@${creator}`,
        assetTags: [creator, product],
        changes: i === 0 ? '' : `Switch to a ${angles[k]}.`,
        sfx: i === 0 ? 'can opening pop' : '',
      };
    }),
    endCard: { headline: p.brief.brandName || s, cta: p.brief.cta || 'Try it today' },
  };
}
