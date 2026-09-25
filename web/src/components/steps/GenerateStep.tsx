import { useEffect, useRef, useState } from 'react';
import { platformById, type Clip } from '../../../../shared/types.ts';
import { api } from '../../lib/api.ts';
import { useAction } from '../../lib/hooks.ts';
import { ErrorBanner, Progress, Spinner, StatusPill, StepHeader, fmtSec } from '../ui.tsx';
import { ClipPromptCard } from './PromptsStep.tsx';
import type { StepProps } from '../Workspace.tsx';

export function GenerateStep(props: StepProps) {
  const { project, setProject, go } = props;
  const { pending, error, setError, run } = useAction();
  const clips = project.clips;
  const ready = clips.filter((c) => c.localPath).length;
  const needsWork = clips.some((c) => c.status !== 'ready' || c.stale);
  const current = clips.find((c) => ['submitting', 'generating', 'downloading'].includes(c.status));

  return (
    <>
      <StepHeader
        title="Generate & timeline"
        subtitle={`Clips are generated in order: each one is sent to ${props.config.videoModel} with the previous clip as its reference video. Regenerate any clip on its own; clips that continued from it get flagged “out of sync” so you can regenerate from there.`}
      >
        {project.generating ? (
          <button className="btn-danger" onClick={() => run('cancel', async () => setProject(await api.cancel(project.id)))}>
            ■ Stop after current clip
          </button>
        ) : (
          needsWork && (
            <button className="btn-primary" disabled={!!pending} onClick={() => run('gen', async () => setProject(await api.generate(project.id, 'all')))}>
              {pending === 'gen' ? <Spinner /> : '▶'} Generate {ready ? 'remaining' : 'all'}
            </button>
          )
        )}
        <button className="btn-lime" disabled={ready < clips.length || project.generating} onClick={() => go('edit')}>
          Edit →
        </button>
      </StepHeader>
      <ErrorBanner error={error} onClose={() => setError(undefined)} />

      {project.generating && (
        <div className="card mb-6 flex items-center gap-4 p-4">
          <Spinner className="text-brand2" />
          <div className="flex-1">
            <div className="text-sm font-semibold">
              {current ? `Generating clip ${current.index + 1} of ${clips.length}` : 'Working…'} · {ready}/{clips.length} ready
            </div>
            <Progress value={((ready + (current?.progress ?? 0) / 100) / clips.length) * 100} className="mt-2" />
          </div>
        </div>
      )}

      <SequencePlayer project={project} />

      <div className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {clips.map((c) => (
          <ClipCard key={c.id} clip={c} {...props} />
        ))}
      </div>
    </>
  );
}

function ClipCard(props: StepProps & { clip: Clip }) {
  const { clip, project, setProject } = props;
  const [editing, setEditing] = useState(false);
  const { pending, error, run } = useAction();
  const scene = project.script?.scenes.find((s) => s.id === clip.sceneId);
  const busy = ['queued', 'submitting', 'generating', 'downloading'].includes(clip.status);
  const prev = project.clips.find((c) => c.index === clip.index - 1);
  const blocked = clip.index > 0 && clip.useVideoRef && !prev?.localPath;
  const aspect = platformById(project.brief.platform).aspect.replace(':', '/');

  return (
    <div className={`card overflow-hidden ${clip.stale ? '!border-amber-500/40' : ''}`}>
      <div className="relative bg-black" style={{ aspectRatio: aspect, maxHeight: 420 }}>
        {clip.url ? <video key={clip.url} src={clip.url} controls playsInline className="h-full w-full object-contain" /> : <div className="grid h-full place-items-center text-sm text-muted">{busy ? <Spinner /> : 'Not generated yet'}</div>}
        <span className="absolute left-2 top-2 grid h-7 w-7 place-items-center rounded-full bg-brand text-xs font-bold">{clip.index + 1}</span>
      </div>
      <div className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <StatusPill status={clip.status} stale={clip.stale} />
          <span className="text-xs text-muted">
            {fmtSec(clip.durationSec)} · v{clip.version || 0}
          </span>
        </div>
        {busy && <Progress value={clip.progress} />}
        {scene && <p className="line-clamp-2 text-sm italic text-muted">“{scene.dialogue}”</p>}
        {clip.index > 0 && <p className="text-[11px] text-muted">{clip.useVideoRef ? `↳ continues from clip ${clip.index}${clip.basedOnPrevVersion ? ` (v${clip.basedOnPrevVersion})` : ''}` : 'fresh shot (no video reference)'}</p>}
        {clip.error && <p className="rounded-lg bg-red-500/10 p-2 text-xs text-red-300">{clip.error}</p>}
        {(error || blocked) && <p className="text-xs text-amber-300">{error ?? `Generate clip ${clip.index} first.`}</p>}

        <div className="flex flex-wrap gap-2">
          <button className="btn-ghost !px-3 !py-1.5 text-xs" disabled={project.generating || !!pending || blocked} onClick={() => run('one', async () => setProject(await api.generate(project.id, 'one', clip.id)))}>
            ↻ {clip.localPath ? 'Regenerate' : 'Generate'}
          </button>
          {clip.index < project.clips.length - 1 && (
            <button className="btn-ghost !px-3 !py-1.5 text-xs" disabled={project.generating || !!pending || blocked} onClick={() => run('from', async () => setProject(await api.generate(project.id, 'from', clip.id)))} title="Regenerate this clip and every clip after it, keeping continuity">
              ↻ From here →
            </button>
          )}
          <button className="btn-ghost !px-3 !py-1.5 text-xs" onClick={() => setEditing(!editing)}>
            ✎ Prompt
          </button>
          {clip.history.length > 1 && (
            <select
              className="input !w-auto !py-1 !text-xs"
              value={clip.version}
              disabled={project.generating}
              onChange={(e) => run('restore', async () => setProject(await api.restoreClip(project.id, clip.id, Number(e.target.value))))}
              title="Switch between takes"
            >
              {clip.history.map((h) => (
                <option key={h.version} value={h.version}>
                  Take v{h.version}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
      {editing && (
        <div className="border-t border-line">
          <ClipPromptCard {...props} compact />
        </div>
      )}
    </div>
  );
}

/** Plays the ready clips back to back, as a rough cut of the timeline. */
export function SequencePlayer({ project }: { project: StepProps['project'] }) {
  const clips = project.clips.filter((c) => c.url);
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  const total = project.clips.reduce((a, c) => a + c.durationSec, 0);
  const aspect = platformById(project.brief.platform).aspect.replace(':', '/');
  const cur = clips[i];

  useEffect(() => {
    if (i >= clips.length) setI(0);
  }, [clips.length, i]);

  useEffect(() => {
    if (playing) void video.current?.play().catch(() => setPlaying(false));
  }, [i, playing, cur?.url]);

  if (!clips.length) return null;
  const offset = project.clips.filter((c) => c.index < (cur?.index ?? 0)).reduce((a, c) => a + c.durationSec, 0);

  return (
    <div className="card grid gap-5 p-4 md:grid-cols-[minmax(0,340px)_1fr]">
      <div className="mx-auto w-full overflow-hidden rounded-xl bg-black" style={{ aspectRatio: aspect, maxHeight: 520 }}>
        {cur && (
          <video
            ref={video}
            src={cur.url}
            className="h-full w-full object-contain"
            playsInline
            onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
            onEnded={() => {
              if (i < clips.length - 1) setI(i + 1);
              else setPlaying(false);
            }}
            onPause={(e) => !e.currentTarget.ended && setPlaying(false)}
            onPlay={() => setPlaying(true)}
          />
        )}
      </div>
      <div className="flex flex-col justify-center gap-4">
        <div>
          <h3 className="font-display text-lg font-bold">Timeline preview</h3>
          <p className="text-sm text-muted">
            Rough cut of {clips.length}/{project.clips.length} clips · {fmtSec(total)}. Captions, music and the end card are added in Edit.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button className="btn-primary !px-5" onClick={() => (playing ? video.current?.pause() : (setPlaying(true), void video.current?.play()))}>
            {playing ? '❚❚ Pause' : '▶ Play all'}
          </button>
          <span className="text-sm tabular-nums text-muted">
            {fmtSec(offset + t)} / {fmtSec(total)}
          </span>
        </div>
        <div className="flex h-14 w-full gap-1">
          {project.clips.map((c) => {
            const idx = clips.indexOf(c);
            const active = cur?.id === c.id;
            return (
              <button
                key={c.id}
                disabled={idx < 0}
                onClick={() => {
                  setI(idx);
                  setT(0);
                }}
                style={{ flexGrow: c.durationSec }}
                className={`relative basis-0 overflow-hidden rounded-lg border text-left text-[11px] transition ${active ? 'border-lime bg-lime/10' : c.stale ? 'border-amber-500/50 bg-amber-500/10' : c.url ? 'border-line bg-panel2 hover:border-brand' : 'border-dashed border-line opacity-50'}`}
              >
                {active && <span className="absolute inset-y-0 left-0 bg-lime/20" style={{ width: `${Math.min(100, (t / c.durationSec) * 100)}%` }} />}
                <span className="relative block px-2 pt-1.5 font-bold">{c.index + 1}</span>
                <span className="relative block px-2 text-muted">{fmtSec(c.durationSec)}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
