import { useEffect, useState } from 'react';
import type { Beat, CastNote, Scene, Script } from '../../../../shared/types.ts';
import { api } from '../../lib/api.ts';
import { useAction, useDebounced } from '../../lib/hooks.ts';
import { ErrorBanner, Field, Spinner, StepHeader } from '../ui.tsx';
import type { StepProps } from '../Workspace.tsx';

const BEATS: Beat[] = ['hook', 'problem', 'solution', 'demo', 'benefit', 'social-proof', 'offer', 'cta', 'story', 'other'];

export function ScriptStep({ project, setProject, config, go }: StepProps) {
  const [script, setScript] = useState<Script | undefined>(project.script);
  const [dirty, setDirty] = useState(false);
  const { pending, error, setError, run } = useAction();

  useEffect(() => {
    if (!dirty) setScript(project.script);
  }, [project.script, dirty]);

  useDebounced(script, 900, (s) => (s && dirty ? api.saveScript(project.id, s).then((p) => (setProject(p), setDirty(false))) : undefined));

  if (!script) return <p className="text-muted">No script yet — pick a concept first.</p>;

  const update = (fn: (s: Script) => void) => {
    const next = structuredClone(script);
    fn(next);
    setScript(next);
    setDirty(true);
  };
  const setScene = (i: number, patch: Partial<Scene>) => update((s) => Object.assign(s.scenes[i], patch));
  const setCast = (i: number, patch: Partial<CastNote>) => update((s) => Object.assign(s.cast[i], patch));
  const total = script.scenes.reduce((a, s) => a + s.durationSec, 0);
  const max = project.brief.maxClipSec;

  async function buildPrompts() {
    await run('build', async () => {
      if (dirty) await api.saveScript(project.id, script!);
      setDirty(false);
      setProject(await api.buildClips(project.id));
      go('prompts');
    });
  }

  return (
    <>
      <StepHeader
        title={script.title || 'Script'}
        subtitle={
          <>
            {script.logline} <br />
            {script.scenes.length} scenes · {total}s total (target {project.brief.durationSec}s) · each scene becomes one Omni clip. Edits save automatically.
          </>
        }
      >
        <button className="btn-ghost" disabled={!!pending} onClick={() => run('regen', async () => (setProject(await api.generateScript(project.id)), setDirty(false)))}>
          {pending === 'regen' ? <Spinner /> : '↻'} Rewrite
        </button>
        <button className="btn-primary" disabled={!!pending} onClick={buildPrompts}>
          {pending === 'build' ? <Spinner /> : '🎬'} {project.clips.length ? 'Rebuild clip prompts' : 'Build clip prompts'}
        </button>
      </StepHeader>
      <ErrorBanner error={error} onClose={() => setError(undefined)} />

      <div className="mb-6 grid gap-4 md:grid-cols-3">
        <Field label="Voice / delivery">
          <input className="input" value={script.voiceStyle} onChange={(e) => update((s) => void (s.voiceStyle = e.target.value))} />
        </Field>
        <Field label="Visual style">
          <input className="input" value={script.visualStyle} onChange={(e) => update((s) => void (s.visualStyle = e.target.value))} />
        </Field>
        <Field label="Music mood">
          <input className="input" value={script.musicMood} onChange={(e) => update((s) => void (s.musicMood = e.target.value))} />
        </Field>
      </div>

      <h2 className="label">Cast & world — described in full on clip 1</h2>
      <div className="mb-8 grid gap-3 md:grid-cols-2">
        {script.cast.map((c, i) => (
          <div key={i} className="card p-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="tag">@{c.tag}</span>
              <span className="text-xs text-muted">{c.kind}</span>
              {c.generated && <span className="ml-auto rounded-full bg-lime/15 px-2 py-0.5 text-[10px] font-bold uppercase text-lime">AI-generated</span>}
            </div>
            <textarea className="input min-h-20 !text-xs" value={c.description} onChange={(e) => setCast(i, { description: e.target.value })} />
          </div>
        ))}
      </div>

      <h2 className="label">Scenes → clips</h2>
      <div className="space-y-4">
        {script.scenes.map((sc, i) => (
          <div key={sc.id || `new-${i}`} className="card overflow-hidden">
            <div className="flex flex-wrap items-center gap-3 border-b border-line bg-panel2 px-4 py-2.5">
              <span className="grid h-7 w-7 place-items-center rounded-full bg-brand text-xs font-bold">{i + 1}</span>
              <select className="input !w-auto !py-1" value={sc.beat} onChange={(e) => setScene(i, { beat: e.target.value as Beat })}>
                {BEATS.map((b) => (
                  <option key={b}>{b}</option>
                ))}
              </select>
              <label className="flex items-center gap-2 text-xs text-muted">
                Duration
                <input type="number" min={config.minClipSec} max={max} className="input !w-20 !py-1" value={sc.durationSec} onChange={(e) => setScene(i, { durationSec: Math.min(max, Math.max(config.minClipSec, Number(e.target.value))) })} />s
              </label>
              <span className="text-xs text-muted">{i === 0 ? 'Establishes cast, product & world' : `Continues from clip ${i}`}</span>
              <div className="ml-auto flex gap-1">
                <button className="btn-ghost !px-2 !py-1 text-xs" disabled={i === 0} onClick={() => update((s) => void s.scenes.splice(i - 1, 2, s.scenes[i], s.scenes[i - 1]))}>
                  ↑
                </button>
                <button className="btn-ghost !px-2 !py-1 text-xs" disabled={i === script.scenes.length - 1} onClick={() => update((s) => void s.scenes.splice(i, 2, s.scenes[i + 1], s.scenes[i]))}>
                  ↓
                </button>
                <button className="btn-danger !px-2 !py-1 text-xs" disabled={script.scenes.length <= 1} onClick={() => update((s) => void s.scenes.splice(i, 1))}>
                  ✕
                </button>
              </div>
            </div>
            <div className="grid gap-3 p-4 md:grid-cols-2">
              <Field label="Dialogue (spoken, lip-synced)" className="md:col-span-2">
                <textarea className="input min-h-16 !text-base" value={sc.dialogue} onChange={(e) => setScene(i, { dialogue: e.target.value })} />
                <WordBudget text={sc.dialogue} seconds={sc.durationSec} />
              </Field>
              <Field label="Speaker">
                <input className="input" value={sc.speaker} onChange={(e) => setScene(i, { speaker: e.target.value })} placeholder="@creator or narrator (voice-over)" />
              </Field>
              <Field label="Assets in scene">
                <input
                  className="input font-mono"
                  value={sc.assetTags.map((t) => `@${t}`).join(' ')}
                  onChange={(e) => setScene(i, { assetTags: e.target.value.split(/[\s,]+/).map((t) => t.replace(/^@/, '')).filter(Boolean) })}
                />
              </Field>
              {i > 0 && (
                <Field label="What changes vs. previous clip" className="md:col-span-2" hint="Camera angle, new location, a new person walking in… The previous clip is the video reference, so only describe the difference.">
                  <input className="input" value={sc.changes} onChange={(e) => setScene(i, { changes: e.target.value })} />
                </Field>
              )}
              <Field label="Setting">
                <input className="input" value={sc.setting} onChange={(e) => setScene(i, { setting: e.target.value })} />
              </Field>
              <Field label="Camera">
                <input className="input" value={sc.camera} onChange={(e) => setScene(i, { camera: e.target.value })} />
              </Field>
              <Field label="Action" className="md:col-span-2">
                <textarea className="input min-h-14" value={sc.action} onChange={(e) => setScene(i, { action: e.target.value })} />
              </Field>
              <Field label="Sound design">
                <input className="input" value={sc.sfx} onChange={(e) => setScene(i, { sfx: e.target.value })} />
              </Field>
            </div>
          </div>
        ))}
        <button
          className="btn-ghost"
          onClick={() =>
            update((s) =>
              void s.scenes.push({
                id: '',
                index: s.scenes.length,
                durationSec: Math.min(max, 8),
                beat: 'other',
                setting: 'same place',
                camera: '',
                action: '',
                dialogue: '',
                speaker: s.scenes[s.scenes.length - 1]?.speaker ?? '@creator',
                assetTags: [...(s.scenes[s.scenes.length - 1]?.assetTags ?? [])],
                changes: '',
                sfx: '',
              }),
            )
          }
        >
          + Add scene
        </button>
      </div>

      <div className="mt-8 grid gap-4 md:grid-cols-2">
        <Field label="End card headline">
          <input className="input" value={script.endCard.headline} onChange={(e) => update((s) => void (s.endCard.headline = e.target.value))} />
        </Field>
        <Field label="End card CTA">
          <input className="input" value={script.endCard.cta} onChange={(e) => update((s) => void (s.endCard.cta = e.target.value))} />
        </Field>
      </div>
    </>
  );
}

function WordBudget({ text, seconds }: { text: string; seconds: number }) {
  const words = text.split(/\s+/).filter(Boolean).length;
  const budget = Math.round(seconds * 2.6);
  const over = words > budget;
  return (
    <span className={`mt-1 block text-xs ${over ? 'text-amber-300' : 'text-muted'}`}>
      {words} words · ~{budget} fit in {seconds}s{over ? ' — may be rushed or cut off' : ''}
    </span>
  );
}
