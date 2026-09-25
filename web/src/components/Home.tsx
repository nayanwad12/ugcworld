import { useEffect, useState } from 'react';
import type { AppConfig } from '../../../shared/types.ts';
import { api, type ProjectSummary } from '../lib/api.ts';
import { ErrorBanner, Logo, Spinner } from './ui.tsx';

const FLOW = ['Idea', 'Script', 'Scenes', 'Omni prompts', 'Clip chain', 'Timeline', 'Join', 'MP4'];

export function Home({ config }: { config: AppConfig }) {
  const [projects, setProjects] = useState<ProjectSummary[]>();
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api.projects().then(setProjects).catch((e) => setError(e.message));
  }, []);

  async function create() {
    setCreating(true);
    try {
      const p = await api.createProject(name.trim() || 'Untitled video');
      window.location.hash = `#/p/${p.id}`;
    } catch (e) {
      setError((e as Error).message);
      setCreating(false);
    }
  }

  async function remove(id: string) {
    if (!confirm('Delete this project and all its clips?')) return;
    await api.deleteProject(id);
    setProjects((ps) => ps?.filter((p) => p.id !== id));
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <div className="flex items-center justify-between">
        <Logo size="lg" />
        <ModeBadge config={config} />
      </div>

      <section className="relative mt-10 overflow-hidden rounded-3xl border border-line bg-gradient-to-br from-brand/25 via-panel to-panel p-8 md:p-12">
        <div className="absolute -right-24 -top-24 h-72 w-72 rounded-full bg-lime/10 blur-3xl" />
        <h1 className="max-w-3xl font-display text-4xl font-bold leading-tight md:text-5xl">
          Turn one idea into a finished <span className="text-lime">UGC ad</span>.
        </h1>
        <p className="mt-4 max-w-2xl text-muted">
          Drop in your idea and tag your @creator, @product, @environment and @logo. Ideabro writes the script, splits it into scenes, generates each clip with Gemini Omni
          1.1 Flash (every clip continues from the one before it) and joins them into one MP4.
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-2 text-xs text-muted">
          {FLOW.map((s, i) => (
            <span key={s} className="inline-flex items-center gap-2">
              <span className="chip">{s}</span>
              {i < FLOW.length - 1 && <span>→</span>}
            </span>
          ))}
        </div>
        <form
          className="mt-8 flex max-w-xl gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <input className="input !py-3" placeholder="Project name, e.g. Voltz energy drink — TikTok" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn-lime shrink-0 whitespace-nowrap !px-6" disabled={creating}>
            {creating ? <Spinner /> : 'New video'}
          </button>
        </form>
      </section>

      <ErrorBanner error={error} />

      <h2 className="mb-4 mt-12 font-display text-xl font-bold">Your projects</h2>
      {!projects ? (
        <Spinner />
      ) : projects.length === 0 ? (
        <p className="text-sm text-muted">No projects yet. Start your first video above.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <div key={p.id} className="card group overflow-hidden">
              <a href={`#/p/${p.id}`} className="block">
                <div className="aspect-video bg-panel2">
                  {p.finalUrl || p.thumb ? <video src={p.finalUrl ?? p.thumb} className="h-full w-full object-cover" muted preload="metadata" /> : <div className="grid h-full place-items-center text-4xl text-line">▶</div>}
                </div>
                <div className="p-4">
                  <div className="font-semibold group-hover:text-lime">{p.name}</div>
                  <div className="mt-1 text-xs text-muted">
                    {p.platform} · {p.durationSec}s · stage: {p.stage} · {new Date(p.updatedAt).toLocaleString()}
                  </div>
                </div>
              </a>
              <div className="flex justify-end border-t border-line px-4 py-2">
                <button className="text-xs text-muted hover:text-red-300" onClick={() => remove(p.id)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ModeBadge({ config }: { config: AppConfig }) {
  if (config.mockVideo || config.mockLlm)
    return (
      <span className="chip border-amber-500/30 bg-amber-500/10 text-amber-200" title="Set APIMART_API_KEY in .env to use real generation">
        ● Demo mode{config.mockVideo && config.mockLlm ? '' : config.mockVideo ? ' (video)' : ' (script)'} — placeholder output
      </span>
    );
  return (
    <span className="chip border-lime/30 bg-lime/10 text-lime" title={`LLM: ${config.llmModel}`}>
      ● Live · {config.videoModel}
    </span>
  );
}
