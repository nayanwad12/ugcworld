import { platformById } from '../../../../shared/types.ts';
import { api } from '../../lib/api.ts';
import { useAction } from '../../lib/hooks.ts';
import { ErrorBanner, Progress, Spinner, StepHeader, fmtSec } from '../ui.tsx';
import type { StepProps } from '../Workspace.tsx';

export function ExportStep({ project, setProject, go }: StepProps) {
  const { pending, error, setError, run } = useAction();
  const r = project.render;
  const platform = platformById(project.brief.platform);
  const rendering = r.status === 'rendering';

  return (
    <>
      <StepHeader title="Export" subtitle={`${platform.label} · ${platform.width}×${platform.height} · H.264/AAC MP4`}>
        <button className="btn-ghost" onClick={() => go('edit')}>
          ← Back to edit
        </button>
        <button className="btn-primary" disabled={rendering || !!pending} onClick={() => run('render', async () => setProject(await api.render(project.id)))}>
          {rendering || pending ? <Spinner /> : '🎞️'} {r.url ? 'Re-render' : 'Render'}
        </button>
      </StepHeader>
      <ErrorBanner error={error} onClose={() => setError(undefined)} />
      {r.status === 'failed' && <ErrorBanner error={`Render failed: ${r.error}`} />}

      {rendering && (
        <div className="card mb-6 p-5">
          <div className="mb-2 flex justify-between text-sm">
            <span className="inline-flex items-center gap-2">
              <Spinner className="text-brand2" /> {r.step}
            </span>
            <span className="tabular-nums text-muted">{r.progress}%</span>
          </div>
          <Progress value={r.progress} />
        </div>
      )}

      {r.url && (
        <div className="grid gap-6 md:grid-cols-[minmax(0,420px)_1fr]">
          <div className="overflow-hidden rounded-2xl border border-line bg-black" style={{ aspectRatio: platform.aspect.replace(':', '/'), maxHeight: '75vh' }}>
            <video key={r.url} src={r.url} controls playsInline className="h-full w-full object-contain" />
          </div>
          <div className="space-y-4">
            <div className="card p-5">
              <div className="text-sm text-muted">Final video</div>
              <div className="mt-1 font-display text-2xl font-bold">{project.script?.title ?? project.name}</div>
              <div className="mt-1 text-sm text-muted">
                {fmtSec(r.durationSec ?? 0)} · rendered {r.updatedAt ? new Date(r.updatedAt).toLocaleString() : ''}
              </div>
              <a className="btn-lime mt-4" href={r.url} download>
                ⬇ Download MP4
              </a>
            </div>
            {r.history.length > 1 && (
              <div className="card p-5">
                <div className="label">Previous renders</div>
                <ul className="space-y-1 text-sm">
                  {r.history.slice(1).map((h) => (
                    <li key={h.url}>
                      <a className="text-brand2 hover:text-white" href={h.url} download>
                        {new Date(h.createdAt).toLocaleString()} · {fmtSec(h.durationSec ?? 0)}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}
      {!r.url && !rendering && r.status !== 'failed' && <p className="text-muted">Nothing rendered yet.</p>}
    </>
  );
}
