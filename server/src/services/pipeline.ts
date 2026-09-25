import { store } from '../store.ts';
import type { Project } from '../../../shared/types.ts';
import { generateConcepts, generateScript } from './planner.ts';
import { buildClips } from './prompts.ts';
import { startGeneration } from './generator.ts';
import { startRender } from './render.ts';

/**
 * First draft = the clips joined back to back with Omni's own audio. Extra edit layers
 * (captions, music, logo, end card) stay off until the user turns them on; we only pre-fill
 * their text/asset choices so they're ready when enabled.
 */
export function applyEditDefaults(d: Project) {
  const logo = d.assets.find((a) => a.kind === 'logo' && a.file);
  if (logo && !d.edit.logo.assetId) d.edit.logo.assetId = logo.id;
  if (d.script) {
    if (!d.edit.endCard.headline) d.edit.endCard.headline = d.script.endCard.headline || d.brief.brandName;
    if (!d.edit.endCard.cta) d.edit.endCard.cta = d.script.endCard.cta || d.brief.cta;
  }
}

/** One click: idea → concepts → script → prompts → clip chain → final MP4. */
export async function runAutopilot(projectId: string) {
  const set = (step: string) =>
    store.update(projectId, (d) => {
      d.autopilot = { running: true, step };
    });
  try {
    set('Brainstorming concepts');
    let p = store.get(projectId);
    if (!p.concepts.length) {
      const concepts = await generateConcepts(p);
      p = store.update(projectId, (d) => {
        d.concepts = concepts;
      });
    }
    if (!p.selectedConceptId) p = store.update(projectId, (d) => void (d.selectedConceptId = d.concepts[0]?.id));

    if (!p.script) {
      set('Writing the script');
      const script = await generateScript(p);
      p = store.update(projectId, (d) => {
        d.script = script;
      });
    }
    if (!p.clips.length) {
      set('Building clip prompts');
      p = store.update(projectId, (d) => {
        d.clips = buildClips(d);
      });
    }
    store.update(projectId, applyEditDefaults);

    if (p.clips.some((c) => c.status !== 'ready' || c.stale)) {
      set('Generating clips');
      await startGeneration(projectId, 'all');
    }
    p = store.get(projectId);
    const failed = p.clips.find((c) => !c.localPath);
    if (failed) throw new Error(`Clip ${failed.index + 1} failed: ${failed.error ?? 'unknown error'}`);

    set('Editing & exporting');
    await startRender(projectId);
    p = store.get(projectId);
    if (p.render.status === 'failed') throw new Error(p.render.error);
    store.update(projectId, (d) => {
      d.autopilot = { running: false, step: 'Done' };
      d.stage = 'export';
    });
  } catch (err) {
    store.update(projectId, (d) => {
      d.autopilot = { running: false, error: err instanceof Error ? err.message : String(err) };
    });
  }
}
