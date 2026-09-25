import { useEffect, useState } from 'react';
import type { Clip, ContinuityMode } from '../../../../shared/types.ts';
import { api } from '../../lib/api.ts';
import { useAction } from '../../lib/hooks.ts';
import { AssetThumb } from '../AssetsPanel.tsx';
import { ErrorBanner, Spinner, StepHeader, Toggle } from '../ui.tsx';
import type { StepProps } from '../Workspace.tsx';

export function PromptsStep(props: StepProps) {
  const { project, setProject, go } = props;
  const { pending, error, setError, run } = useAction();
  const hasVideos = project.clips.some((c) => c.localPath);

  return (
    <>
      <StepHeader
        title="Omni prompts & references"
        subtitle="Clip 1 describes the whole cast and gets your asset images. Every later clip gets the previous clip as its reference video, so only the changes need describing. You can edit any prompt before generating."
      >
        <button className="btn-ghost" disabled={!!pending || project.generating} onClick={() => confirm('Rebuild all prompts from the script? Your manual prompt edits will be replaced.') && run('rebuild', async () => setProject(await api.buildClips(project.id)))}>
          {pending === 'rebuild' ? <Spinner /> : '↻'} Rebuild all from script
        </button>
        <button
          className="btn-primary"
          disabled={!!pending || project.generating}
          onClick={() =>
            run('gen', async () => {
              if (!hasVideos || project.clips.some((c) => c.status !== 'ready' || c.stale)) setProject(await api.generate(project.id, 'all'));
              go('generate');
            })
          }
        >
          {pending === 'gen' ? <Spinner /> : '▶'} {hasVideos ? 'Generate remaining clips' : 'Generate all clips'}
        </button>
      </StepHeader>
      <ErrorBanner error={error} onClose={() => setError(undefined)} />

      <div className="card mb-6 grid gap-3 p-4 md:grid-cols-2">
        {(
          [
            ['reference', 'Previous clip as reference video', 'Sends clip N-1 as video_urls. Needs a public URL for the clip: APIMart\'s own link while it lasts, then PUBLIC_BASE_URL.'],
            ['extend', 'Extend the previous generation', 'Sends clip N-1\'s APIMart task id (extend_from_task_id). Nothing to host. If Omni returns the old clip plus the new part, Ideabro trims off the old part.'],
          ] as [ContinuityMode, string, string][]
        ).map(([mode, title, hint]) => (
          <button
            key={mode}
            disabled={project.generating}
            onClick={() => run('mode', async () => setProject(await api.patchProject(project.id, { brief: { continuity: mode } })))}
            className={`rounded-xl border p-3 text-left transition ${project.brief.continuity === mode ? 'border-brand bg-brand/15' : 'border-line bg-panel2 hover:border-brand/50'}`}
          >
            <div className="text-sm font-semibold">
              {project.brief.continuity === mode ? '● ' : '○ '}
              {title}
            </div>
            <div className="mt-1 text-xs text-muted">{hint}</div>
          </button>
        ))}
      </div>

      <div className="space-y-5">
        {project.clips.map((c) => (
          <ClipPromptCard key={c.id} clip={c} {...props} />
        ))}
      </div>
    </>
  );
}

export function ClipPromptCard({ clip, project, setProject, config, compact }: StepProps & { clip: Clip; compact?: boolean }) {
  const [prompt, setPrompt] = useState(clip.prompt);
  const [final, setFinal] = useState<string>();
  const scene = project.script?.scenes.find((s) => s.id === clip.sceneId);
  const imageAssets = project.assets.filter((a) => (a.file?.mime.startsWith('image/') || a.remoteUrl) && a.kind !== 'music' && a.kind !== 'sfx');

  useEffect(() => setPrompt(clip.prompt), [clip.prompt]);

  const patch = async (body: Parameters<typeof api.patchClip>[2]) => setProject(await api.patchClip(project.id, clip.id, body));
  const toggleImage = (id: string) => {
    const has = clip.imageAssetIds.includes(id);
    if (!has && clip.imageAssetIds.length >= config.maxImageRefs) return alert(`Max ${config.maxImageRefs} reference images per clip.`);
    void patch({ imageAssetIds: has ? clip.imageAssetIds.filter((x) => x !== id) : [...clip.imageAssetIds, id] });
  };

  return (
    <div className="card overflow-hidden">
      {!compact && (
        <div className="flex flex-wrap items-center gap-3 border-b border-line bg-panel2 px-4 py-2.5">
          <span className="grid h-7 w-7 place-items-center rounded-full bg-brand text-xs font-bold">{clip.index + 1}</span>
          <span className="text-sm font-semibold capitalize">{scene?.beat}</span>
          <span className="text-xs text-muted">{clip.durationSec}s</span>
          {scene?.dialogue && <span className="min-w-0 flex-1 truncate text-sm italic text-muted">“{scene.dialogue}”</span>}
        </div>
      )}
      <div className="grid gap-4 p-4 lg:grid-cols-[280px_1fr]">
        <div className="space-y-4">
          <div>
            <span className="label">Continuity</span>
            {clip.index === 0 ? (
              <p className="text-xs text-muted">First clip — no video reference. Establishes the cast and world.</p>
            ) : (
              <Toggle
                checked={clip.useVideoRef}
                onChange={(v) => void api.patchClip(project.id, clip.id, { useVideoRef: v }).then(() => api.rebuildClip(project.id, clip.id)).then(setProject)}
                label={<span className="text-xs">{clip.useVideoRef ? `${project.brief.continuity === 'extend' ? 'Extend' : 'Continue from'} clip ${clip.index}` : 'Off — fresh shot (full descriptions)'}</span>}
              />
            )}
          </div>
          <div>
            <span className="label">
              Reference images · {clip.imageAssetIds.length}/{config.maxImageRefs}
            </span>
            {imageAssets.length === 0 ? (
              <p className="text-xs text-muted">No image assets uploaded.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {imageAssets.map((a) => {
                  const idx = clip.imageAssetIds.indexOf(a.id);
                  return (
                    <button key={a.id} onClick={() => toggleImage(a.id)} title={`@${a.tag}`} className={`relative overflow-hidden rounded-lg border-2 transition ${idx >= 0 ? 'border-lime' : 'border-transparent opacity-45 hover:opacity-100'}`}>
                      <AssetThumb asset={a} className="h-14 w-12" />
                      {idx >= 0 && <span className="absolute left-0.5 top-0.5 rounded bg-lime px-1 text-[10px] font-bold text-ink">{idx + 1}</span>}
                      <span className="absolute inset-x-0 bottom-0 truncate bg-black/70 px-0.5 text-[9px]">@{a.tag}</span>
                    </button>
                  );
                })}
              </div>
            )}
            <p className="mt-1 text-[11px] text-muted">Numbered in the order they are sent (max {config.maxImageRefs}). The prompt legend (“Image 1 is @creator…”) is generated automatically, and images are sent as references, not as the first frame.</p>
          </div>
        </div>
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="label !mb-0">Prompt</span>
            <div className="flex gap-3 text-xs">
              <button className="text-brand2 hover:text-white" onClick={() => void api.rebuildClip(project.id, clip.id).then(setProject)}>
                ↻ Rebuild from script
              </button>
              <button className="text-brand2 hover:text-white" onClick={async () => setFinal(final ? undefined : (await api.finalPrompt(project.id, clip.id)).prompt)}>
                {final ? 'Hide' : 'Preview'} exact prompt sent
              </button>
            </div>
          </div>
          <textarea
            className="input min-h-64 font-mono !text-xs leading-relaxed"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onBlur={() => prompt !== clip.prompt && void patch({ prompt })}
          />
          {final && <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-xl border border-line bg-ink p-3 text-[11px] text-zinc-300">{final}</pre>}
        </div>
      </div>
    </div>
  );
}
