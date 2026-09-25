import { useState } from 'react';
import { api } from '../../lib/api.ts';
import { useAction } from '../../lib/hooks.ts';
import { ErrorBanner, Spinner, StepHeader } from '../ui.tsx';
import type { StepProps } from '../Workspace.tsx';

export function ConceptStep({ project, setProject, go }: StepProps) {
  const { pending, error, setError, run } = useAction();
  const [custom, setCustom] = useState({ title: '', hook: '', angle: '', summary: '' });
  const [showCustom, setShowCustom] = useState(false);

  return (
    <>
      <StepHeader title="Pick a concept" subtitle="Three creative angles based on your brief. Pick one, or write your own. The hook is the first line spoken in the video.">
        <button className="btn-ghost" disabled={!!pending} onClick={() => run('regen', async () => setProject(await api.concepts(project.id)))}>
          {pending === 'regen' ? <Spinner /> : '↻'} New ideas
        </button>
        <button
          className="btn-primary"
          disabled={!!pending || !project.selectedConceptId}
          onClick={() =>
            run('script', async () => {
              setProject(await api.generateScript(project.id));
              go('script');
            })
          }
        >
          {pending === 'script' ? <Spinner /> : '✍️'} {project.script ? 'Rewrite script' : 'Write script'}
        </button>
      </StepHeader>
      <ErrorBanner error={error} onClose={() => setError(undefined)} />
      {project.script && <p className="mb-4 text-xs text-amber-200/80">A script already exists. “Rewrite script” replaces it; use the sidebar to keep your current one.</p>}

      <div className="grid gap-4 md:grid-cols-3">
        {project.concepts.map((c) => {
          const selected = c.id === project.selectedConceptId;
          return (
            <button
              key={c.id}
              onClick={() => run('select', async () => setProject(await api.selectConcept(project.id, { conceptId: c.id })))}
              className={`card p-5 text-left transition ${selected ? '!border-brand ring-2 ring-brand/40' : 'hover:border-brand/50'}`}
            >
              <div className="flex items-center justify-between">
                <span className="chip">{c.angle}</span>
                {selected && <span className="text-xs font-bold text-lime">✓ Selected</span>}
              </div>
              <h3 className="mt-3 font-display text-lg font-bold">{c.title}</h3>
              <p className="mt-3 rounded-xl bg-panel2 p-3 text-sm italic text-zinc-200">“{c.hook}”</p>
              <p className="mt-3 text-sm text-muted">{c.summary}</p>
            </button>
          );
        })}
      </div>

      <div className="mt-6">
        {!showCustom ? (
          <button className="btn-ghost" onClick={() => setShowCustom(true)}>
            + Write my own concept
          </button>
        ) : (
          <div className="card grid gap-3 p-5 md:grid-cols-2">
            <input className="input" placeholder="Title" value={custom.title} onChange={(e) => setCustom({ ...custom, title: e.target.value })} />
            <input className="input" placeholder="Angle (testimonial, POV, skit…)" value={custom.angle} onChange={(e) => setCustom({ ...custom, angle: e.target.value })} />
            <input className="input md:col-span-2" placeholder="Hook — the first line spoken" value={custom.hook} onChange={(e) => setCustom({ ...custom, hook: e.target.value })} />
            <textarea className="input min-h-20 md:col-span-2" placeholder="Beat-by-beat summary" value={custom.summary} onChange={(e) => setCustom({ ...custom, summary: e.target.value })} />
            <div className="flex justify-end gap-2 md:col-span-2">
              <button className="btn-ghost" onClick={() => setShowCustom(false)}>
                Cancel
              </button>
              <button
                className="btn-primary"
                disabled={!custom.title || !custom.summary}
                onClick={() =>
                  run('custom', async () => {
                    setProject(await api.selectConcept(project.id, { custom }));
                    setShowCustom(false);
                  })
                }
              >
                Use this concept
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
