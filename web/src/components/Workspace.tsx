import { useEffect, useState } from 'react';
import { STAGES, type AppConfig, type Project, type Stage } from '../../../shared/types.ts';
import { api } from '../lib/api.ts';
import { flushAutosaves, useProject } from '../lib/hooks.ts';
import { ErrorBanner, Logo, Spinner } from './ui.tsx';
import { ModeBadge } from './Home.tsx';
import { BriefStep } from './steps/BriefStep.tsx';
import { ConceptStep } from './steps/ConceptStep.tsx';
import { ScriptStep } from './steps/ScriptStep.tsx';
import { PromptsStep } from './steps/PromptsStep.tsx';
import { GenerateStep } from './steps/GenerateStep.tsx';
import { EditStep } from './steps/EditStep.tsx';
import { ExportStep } from './steps/ExportStep.tsx';

export interface StepProps {
  project: Project;
  setProject: (p: Project) => void;
  refresh: () => Promise<void>;
  config: AppConfig;
  go: (s: Stage) => void;
}

const LABELS: Record<Stage, { title: string; hint: string }> = {
  brief: { title: 'Brief & assets', hint: 'Idea, platform, @tags' },
  concept: { title: 'Concept', hint: 'Pick an angle' },
  script: { title: 'Script & scenes', hint: 'Dialogue per clip' },
  prompts: { title: 'Omni prompts', hint: 'References & continuity' },
  generate: { title: 'Generate & timeline', hint: 'Clip chain, regenerate' },
  edit: { title: 'Edit', hint: 'Captions, music, SFX, logo' },
  export: { title: 'Export', hint: 'Final MP4' },
};

function reachable(p: Project): Record<Stage, boolean> {
  return {
    brief: true,
    concept: p.concepts.length > 0,
    script: !!p.script,
    prompts: p.clips.length > 0,
    generate: p.clips.length > 0,
    edit: p.clips.some((c) => c.localPath),
    export: p.clips.length > 0 && p.clips.every((c) => c.localPath),
  };
}

export function Workspace({ id, config }: { id: string; config: AppConfig }) {
  const { project, setProject, refresh, error } = useProject(id);
  const [stage, setStage] = useState<Stage>();
  const [name, setName] = useState('');

  useEffect(() => {
    if (project && !stage) {
      setStage(project.stage);
      setName(project.name);
    }
  }, [project, stage]);

  // Follow the autopilot as it moves through stages.
  useEffect(() => {
    if (project?.autopilot.running) setStage(project.stage);
  }, [project?.autopilot.running, project?.stage]);

  if (error && !project) return <div className="p-10"><ErrorBanner error={error} /><a className="btn-ghost" href="#/">← Back</a></div>;
  if (!project || !stage)
    return (
      <div className="grid h-full place-items-center text-muted">
        <Spinner />
      </div>
    );

  const ok = reachable(project);
  const go = (s: Stage) => {
    setStage(s);
    window.scrollTo({ top: 0 });
    void api.patchProject(project.id, { stage: s }).catch(() => undefined);
  };
  const props: StepProps = { project, setProject, refresh, config, go };

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-20 flex items-center gap-4 border-b border-line bg-ink/85 px-5 py-3 backdrop-blur">
        <a href="#/" title="All projects">
          <Logo />
        </a>
        <span className="text-line">/</span>
        <input
          className="min-w-0 max-w-sm flex-1 rounded-lg bg-transparent px-2 py-1 font-semibold outline-none hover:bg-panel2 focus:bg-panel2"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name !== project.name && api.patchProject(project.id, { name }).then(setProject)}
        />
        <div className="ml-auto flex items-center gap-3">
          <ModeBadge config={config} />
          <AutopilotButton {...props} />
        </div>
      </header>

      {(project.autopilot.running || project.autopilot.error) && (
        <div className={`border-b px-5 py-2 text-sm ${project.autopilot.error ? 'border-red-500/30 bg-red-500/10 text-red-200' : 'border-brand/30 bg-brand/10 text-brand2'}`}>
          {project.autopilot.running ? (
            <span className="inline-flex items-center gap-2">
              <Spinner /> Autopilot: {project.autopilot.step}…
            </span>
          ) : (
            <>Autopilot stopped: {project.autopilot.error}</>
          )}
        </div>
      )}

      <div className="flex flex-1">
        <nav className="sticky top-[57px] hidden h-[calc(100vh-57px)] w-60 shrink-0 border-r border-line p-4 md:block">
          <ol className="space-y-1">
            {STAGES.map((s, i) => {
              const active = s === stage;
              return (
                <li key={s}>
                  <button
                    disabled={!ok[s]}
                    onClick={() => go(s)}
                    className={`flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition disabled:opacity-35 ${active ? 'bg-brand/15 text-white' : 'hover:bg-panel2'}`}
                  >
                    <span className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold ${active ? 'bg-brand text-white' : ok[s] ? 'bg-lime/15 text-lime' : 'bg-line text-muted'}`}>{i + 1}</span>
                    <span>
                      <span className="block text-sm font-semibold">{LABELS[s].title}</span>
                      <span className="block text-xs text-muted">{LABELS[s].hint}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        <main className="min-w-0 flex-1 px-5 py-8 md:px-10">
          <div className="mx-auto max-w-6xl">
            <div className="mb-4 flex gap-1 overflow-x-auto md:hidden">
              {STAGES.map((s) => (
                <button key={s} disabled={!ok[s]} onClick={() => go(s)} className={`chip shrink-0 ${s === stage ? '!border-brand !text-white' : ''} disabled:opacity-40`}>
                  {LABELS[s].title}
                </button>
              ))}
            </div>
            {stage === 'brief' && <BriefStep {...props} />}
            {stage === 'concept' && <ConceptStep {...props} />}
            {stage === 'script' && <ScriptStep {...props} />}
            {stage === 'prompts' && <PromptsStep {...props} />}
            {stage === 'generate' && <GenerateStep {...props} />}
            {stage === 'edit' && <EditStep {...props} />}
            {stage === 'export' && <ExportStep {...props} />}
          </div>
        </main>
      </div>
    </div>
  );
}

function AutopilotButton({ project, setProject }: StepProps) {
  const [err, setErr] = useState<string>();
  const running = project.autopilot.running;
  return (
    <button
      className="btn-lime"
      disabled={running || project.generating || project.render.status === 'rendering'}
      title={err ?? 'Runs every remaining step automatically: concepts → script → prompts → clips → edit → MP4'}
      onClick={async () => {
        try {
          setErr(undefined);
          await flushAutosaves();
          setProject(await api.autopilot(project.id));
        } catch (e) {
          setErr((e as Error).message);
          alert((e as Error).message);
        }
      }}
    >
      {running ? <Spinner /> : '⚡'} Autopilot
    </button>
  );
}
