/**
 * Omni prompt construction — the continuity workflow:
 *
 *  Clip 1  : describe everything (who the creator/narrator is, the product, environment, logo, props)
 *            and attach the tagged assets as reference images.
 *  Clip N>1: attach clip N-1 as the reference VIDEO so the model continues the same people, product and look.
 *            Only describe what CHANGES (angle, location, new person...) and attach images only for new elements.
 *
 * The creative part of each prompt (clip.prompt) is editable by the user. The reference legend
 * ("Image 1 is @creator...") is generated at submit time from the clip's actual references so it can never drift.
 */
import { config } from '../config.ts';
import { newId } from '../store.ts';
import { platformById, type Asset, type AssetKind, type CastNote, type Clip, type Project, type Scene } from '../../../shared/types.ts';

const KIND_PRIORITY: AssetKind[] = ['creator', 'product', 'environment', 'props', 'other', 'logo', 'narrator'];

const KIND_ROLE: Record<string, string> = {
  creator: 'the on-camera creator/presenter — match face, hair, skin tone, body and wardrobe exactly',
  product: 'the product — reproduce shape, colors, packaging, label and logo exactly; never change the text on it',
  environment: 'the environment/location — match layout, decor, colors and lighting',
  logo: 'the brand logo — reproduce it faithfully wherever the brand appears',
  props: 'a prop that appears in the scene — match its look',
  narrator: 'the narrator — use as the look/identity of the voice-over character',
  other: 'a reference element — match its look',
};

export const hasImage = (a: Asset) => !!(a.remoteUrl || (a.file && a.file.mime.startsWith('image/')));

function castFor(p: Project): CastNote[] {
  if (p.script?.cast?.length) return p.script.cast;
  return p.assets.filter((a) => a.kind !== 'music' && a.kind !== 'sfx').map((a) => ({ tag: a.tag, kind: a.kind, description: a.description || a.name, generated: false }));
}

function aspectFor(p: Project) {
  return platformById(p.brief.platform).aspect;
}

/** Tags that appear in a scene, including the speaker. */
function sceneTags(scene: Scene): string[] {
  const tags = new Set(scene.assetTags);
  const m = /@([a-z0-9_-]+)/i.exec(scene.speaker);
  if (m) tags.add(m[1].toLowerCase());
  for (const t of `${scene.action} ${scene.setting} ${scene.changes}`.matchAll(/@([a-z0-9_-]+)/gi)) tags.add(t[1].toLowerCase());
  return [...tags];
}

/** Pick which uploaded images to attach for a clip. */
export function selectImageRefs(p: Project, scene: Scene, withVideoRef: boolean): string[] {
  const scenes = p.script?.scenes ?? [];
  const tags = sceneTags(scene);
  const byPriority = (a: Asset, b: Asset) => KIND_PRIORITY.indexOf(a.kind) - KIND_PRIORITY.indexOf(b.kind);
  const candidates = p.assets.filter(hasImage).filter((a) => a.kind !== 'music' && a.kind !== 'sfx');

  let chosen: Asset[];
  if (!withVideoRef) {
    // First clip (or continuity off): everything in the scene, plus the primary creator/product/environment
    // when the scene doesn't already have one of that kind (they define the world).
    const inScene = candidates.filter((a) => tags.includes(a.tag)).sort(byPriority);
    const core = (['creator', 'product', 'environment'] as AssetKind[])
      .filter((k) => !inScene.some((a) => a.kind === k))
      .map((k) => candidates.find((a) => a.kind === k))
      .filter((a): a is Asset => !!a);
    const logo = scene.index === 0 ? candidates.filter((a) => a.kind === 'logo') : [];
    chosen = [...inScene, ...core, ...logo];
  } else {
    // Continuation: the video carries identity. Add images only for elements new to this scene,
    // plus the product (labels drift easily) when it is on screen.
    const first = scenes.find((s) => s.index === 0);
    const seen = new Set(scenes.filter((s) => s.index < scene.index).flatMap(sceneTags));
    if (first && first.index !== scene.index) {
      for (const id of selectImageRefs(p, first, false)) seen.add(candidates.find((a) => a.id === id)?.tag ?? '');
    }
    const fresh = candidates.filter((a) => tags.includes(a.tag) && !seen.has(a.tag)).sort(byPriority);
    const product = candidates.filter((a) => a.kind === 'product' && tags.includes(a.tag) && !fresh.includes(a));
    chosen = [...fresh, ...product];
  }
  const unique = [...new Map(chosen.map((a) => [a.id, a])).values()];
  return unique.slice(0, config.apimart.maxImageRefs).map((a) => a.id);
}

function describeCast(notes: CastNote[]) {
  return notes.map((c) => `- @${c.tag} (${c.kind}): ${c.description}`).join('\n');
}

function dialogueLine(p: Project, scene: Scene) {
  if (!scene.dialogue.trim()) return 'Dialogue: none — no one speaks in this shot.';
  const lang = p.brief.language;
  const voice = p.script?.voiceStyle ? `, ${p.script.voiceStyle}` : '';
  if (/narrator|voice-?over|\bvo\b/i.test(scene.speaker)) {
    return `Voice-over (${scene.speaker}, not on screen) in ${lang}${voice}: "${scene.dialogue.trim()}"`;
  }
  return `Dialogue — ${scene.speaker || '@creator'} speaks ${lang} directly to camera, natural and lip-synced${voice}: "${scene.dialogue.trim()}"`;
}

function sceneBlock(p: Project, scene: Scene) {
  return [
    `SCENE ${scene.index + 1} — ${scene.beat.toUpperCase()}`,
    scene.setting && `Setting: ${scene.setting}`,
    scene.camera && `Camera: ${scene.camera}`,
    scene.action && `Action: ${scene.action}`,
    dialogueLine(p, scene),
    `Sound: natural ambient sound${scene.sfx ? `, ${scene.sfx}` : ''}. No background music.`,
    'Do not render any on-screen text, captions, subtitles, UI or watermarks.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Build the editable creative prompt for one scene. */
export function buildClipPrompt(p: Project, scene: Scene, withVideoRef: boolean): string {
  const s = p.script;
  const aspect = aspectFor(p);
  const cast = castFor(p);
  const style = s?.visualStyle || (p.brief.format === 'ugc' ? 'authentic UGC, handheld smartphone footage, natural light' : 'cinematic commercial look');

  if (!withVideoRef) {
    const inScene = new Set(sceneTags(scene));
    // Describe the whole cast on the first clip; on a hard reset describe what this scene needs.
    const primary = (k: AssetKind) => !cast.some((c) => c.kind === k && inScene.has(c.tag)) && cast.find((c) => c.kind === k)?.tag;
    const notes = scene.index === 0 ? cast : cast.filter((c) => inScene.has(c.tag) || c.tag === primary('creator') || c.tag === primary('environment'));
    return [
      `${style}. ${aspect} aspect ratio. One continuous shot, about ${scene.durationSec} seconds long.`,
      notes.length ? `CAST & ASSETS:\n${describeCast(notes)}` : '',
      sceneBlock(p, scene),
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  const scenes = s?.scenes ?? [];
  const seen = new Set(scenes.filter((x) => x.index < scene.index).flatMap(sceneTags));
  const fresh = cast.filter((c) => sceneTags(scene).includes(c.tag) && !seen.has(c.tag));
  return [
    `Continue from the previous shot with a new shot of about ${scene.durationSec} seconds: same ${style}, one continuous shot. Keep every person, the wardrobe, the product, lighting and voice identical.`,
    scene.changes ? `CHANGES FROM THE PREVIOUS SHOT: ${scene.changes}` : 'CHANGES FROM THE PREVIOUS SHOT: none — continue seamlessly.',
    fresh.length ? `NEW IN THIS SHOT:\n${describeCast(fresh)}` : '',
    sceneBlock(p, scene),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Legend explaining the attached references; prepended to the prompt when submitting. */
export function referenceLegend(p: Project, clip: Clip, withVideo: boolean): string {
  const lines: string[] = [];
  if (withVideo && p.brief.continuity === 'extend') {
    lines.push('- This extends the previous shot of this same video. Pick up from its final moment and keep continuity (people, wardrobe, product, location unless told otherwise, lighting, color grade, voice).');
  } else if (withVideo) {
    lines.push('- The reference video is the previous shot of this same video. Pick up from its final moment and keep continuity (people, wardrobe, product, location unless told otherwise, lighting, color grade, voice).');
  }
  clip.imageAssetIds.forEach((id, i) => {
    const a = p.assets.find((x) => x.id === id);
    if (!a) return;
    lines.push(`- Image ${i + 1} is @${a.tag}${a.name ? ` ("${a.name}")` : ''}: ${KIND_ROLE[a.kind] ?? KIND_ROLE.other}.`);
  });
  return lines.length ? `REFERENCES:\n${lines.join('\n')}` : '';
}

export function finalPrompt(p: Project, clip: Clip, withVideo: boolean) {
  return [referenceLegend(p, clip, withVideo), clip.prompt].filter(Boolean).join('\n\n');
}

/**
 * (Re)build clips from the script. Existing generated videos are kept when the scene is unchanged;
 * prompts are regenerated unless `keepPrompts` is set.
 */
export function buildClips(p: Project, keepPrompts = false): Clip[] {
  const scenes = p.script?.scenes ?? [];
  return scenes.map((scene) => {
    const existing = p.clips.find((c) => c.sceneId === scene.id) ?? p.clips[scene.index];
    const useVideoRef = scene.index > 0 && (existing?.useVideoRef ?? true);
    const prompt = keepPrompts && existing?.prompt ? existing.prompt : buildClipPrompt(p, scene, useVideoRef);
    const base: Clip = existing
      ? { ...existing }
      : {
          id: newId('clip_'),
          sceneId: scene.id,
          index: scene.index,
          durationSec: scene.durationSec,
          prompt,
          useVideoRef,
          imageAssetIds: [],
          status: 'idle',
          progress: 0,
          version: 0,
          history: [],
          stale: false,
          trimStart: 0,
          trimEnd: 0,
        };
    const promptChanged = !!existing && existing.prompt !== prompt;
    return {
      ...base,
      sceneId: scene.id,
      index: scene.index,
      durationSec: scene.durationSec,
      prompt,
      useVideoRef,
      imageAssetIds: keepPrompts && existing ? existing.imageAssetIds : selectImageRefs(p, scene, useVideoRef),
      stale: base.stale || (promptChanged && base.status === 'ready'),
    };
  });
}
