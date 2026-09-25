import { useRef, useState } from 'react';
import { RESOLUTIONS, platformById, splitDuration, type Brief, type Resolution, type VideoFormat } from '../../../../shared/types.ts';
import { api } from '../../lib/api.ts';
import { useAction, useDebounced } from '../../lib/hooks.ts';
import { AddAssetForm, AssetCard, AssetThumb } from '../AssetsPanel.tsx';
import { ErrorBanner, Field, Spinner, StepHeader } from '../ui.tsx';
import type { StepProps } from '../Workspace.tsx';

const FORMATS: { id: VideoFormat; label: string; hint: string }[] = [
  { id: 'ugc', label: 'UGC', hint: 'Creator talking to camera' },
  { id: 'ad', label: 'Performance ad', hint: 'Hook → benefits → CTA' },
  { id: 'campaign', label: 'Brand campaign', hint: 'Cinematic storytelling' },
  { id: 'film', label: 'AI film', hint: 'Narrative short' },
];

const DURATIONS = [10, 15, 20, 30, 45, 60];

export function BriefStep({ project, setProject, refresh, config, go }: StepProps) {
  const [brief, setBrief] = useState<Brief>(project.brief);
  const { pending, error, setError, run } = useAction();
  const set = <K extends keyof Brief>(k: K, v: Brief[K]) => setBrief((b) => ({ ...b, [k]: v }));

  useDebounced(brief, 600, (b) => api.patchProject(project.id, { brief: b }).then(setProject));

  const clips = splitDuration(brief.durationSec, brief.maxClipSec, config.minClipSec);
  const visualAssets = project.assets.filter((a) => a.kind !== 'music' && a.kind !== 'sfx');
  const audioAssets = project.assets.filter((a) => a.kind === 'music' || a.kind === 'sfx');

  async function next() {
    await run('concepts', async () => {
      await api.patchProject(project.id, { brief });
      setProject(await api.concepts(project.id));
      go('concept');
    });
  }

  return (
    <>
      <StepHeader title="What are we making?" subtitle="Describe the idea in plain words and tag your assets with @ — e.g. “@creator shows why @product beats coffee in @environment”. Anything you don't provide, Ideabro invents.">
        <button className="btn-primary" disabled={!!pending} onClick={next}>
          {pending === 'concepts' ? <Spinner /> : '💡'} Generate concepts
        </button>
      </StepHeader>
      <ErrorBanner error={error} onClose={() => setError(undefined)} />

      <div className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
        <div className="space-y-5">
          <Field label="Your idea">
            <MentionTextarea value={brief.idea} onChange={(v) => set('idea', v)} tags={visualAssets.map((a) => ({ tag: a.tag, kind: a.kind, asset: a }))} />
          </Field>

          <Field label="Format">
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              {FORMATS.map((f) => (
                <button key={f.id} onClick={() => set('format', f.id)} className={`rounded-xl border p-3 text-left transition ${brief.format === f.id ? 'border-brand bg-brand/15' : 'border-line bg-panel2 hover:border-brand/50'}`}>
                  <div className="text-sm font-semibold">{f.label}</div>
                  <div className="text-xs text-muted">{f.hint}</div>
                </button>
              ))}
            </div>
          </Field>

          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Platform" hint={['1:1', '4:5'].includes(platformById(brief.platform).aspect) ? 'Generated in 9:16 (Omni supports 16:9 / 9:16), then center-cropped.' : undefined}>
              <select className="input" value={brief.platform} onChange={(e) => set('platform', e.target.value as Brief['platform'])}>
                {config.platforms.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label} · {p.aspect}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Video quality" hint="Higher resolution costs more per clip on APIMart.">
              <select className="input" value={brief.resolution} onChange={(e) => set('resolution', e.target.value as Resolution)}>
                {RESOLUTIONS.map((r) => (
                  <option key={r} value={r}>
                    {r === '360p' ? '360p · draft' : r === '4k' ? '4K' : r}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Language">
              <input className="input" list="langs" value={brief.language} onChange={(e) => set('language', e.target.value)} />
              <datalist id="langs">
                {config.languages.map((l) => (
                  <option key={l} value={l} />
                ))}
              </datalist>
            </Field>
          </div>

          <Field
            label={`Duration · ${brief.durationSec}s`}
            hint={
              <>
                {clips.length} clip{clips.length > 1 ? 's' : ''} of ~{clips.join(' + ')}s. Each clip continues from the previous one. Omni picks each clip's exact length (3–10s), so the final
                length can vary a little.
              </>
            }
          >
            <div className="flex flex-wrap items-center gap-2">
              {DURATIONS.map((d) => (
                <button key={d} onClick={() => set('durationSec', d)} className={`chip ${brief.durationSec === d ? '!border-brand !bg-brand/20 !text-white' : ''}`}>
                  {d}s
                </button>
              ))}
              <input type="number" min={3} max={180} className="input !w-24" value={brief.durationSec} onChange={(e) => set('durationSec', Number(e.target.value))} />
            </div>
          </Field>

          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Brand name">
              <input className="input" value={brief.brandName} onChange={(e) => set('brandName', e.target.value)} placeholder="Voltz" />
            </Field>
            <Field label="Call to action">
              <input className="input" value={brief.cta} onChange={(e) => set('cta', e.target.value)} placeholder="Grab a can today" />
            </Field>
            <Field label="Tone">
              <input className="input" value={brief.tone} onChange={(e) => set('tone', e.target.value)} />
            </Field>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <span className="label">Assets · {project.assets.length}</span>
            <p className="mb-3 text-xs text-muted">
              Clip 1 gets up to {config.maxImageRefs} of these as reference images. Later clips carry identity through the previous clip's video, and only get images for new elements.
            </p>
            {!config.mockVideo && !config.publicBaseUrl && project.assets.some((x) => x.file && !x.remoteUrl && x.file.mime.startsWith('image/')) && (
              <p className="mb-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
                APIMart only accepts public image URLs. Set <code>PUBLIC_BASE_URL</code> on the server (your domain or an ngrok URL), or paste a public URL on each image asset.
              </p>
            )}
            <AddAssetForm project={project} onAdded={refresh} compact kinds={['creator', 'product', 'environment', 'logo', 'props', 'narrator', 'other']} />
          </div>
          <div className="space-y-2">
            {visualAssets.map((a) => (
              <AssetCard key={a.id} project={project} asset={a} onChange={refresh} />
            ))}
            {audioAssets.map((a) => (
              <AssetCard key={a.id} project={project} asset={a} onChange={refresh} />
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function MentionTextarea({ value, onChange, tags }: { value: string; onChange: (v: string) => void; tags: { tag: string; kind: string; asset: import('../../../../shared/types.ts').Asset }[] }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const matches = query === null ? [] : tags.filter((t) => t.tag.startsWith(query.toLowerCase()));

  const detect = (el: HTMLTextAreaElement) => {
    const m = /@([\w-]*)$/.exec(el.value.slice(0, el.selectionStart));
    setQuery(m ? m[1] : null);
    setActive(0);
  };

  const insert = (tag: string) => {
    const el = ref.current;
    if (!el) return;
    const before = el.value.slice(0, el.selectionStart).replace(/@[\w-]*$/, `@${tag} `);
    const after = el.value.slice(el.selectionStart);
    onChange(before + after);
    setQuery(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(before.length, before.length);
    });
  };

  return (
    <div className="relative">
      <textarea
        ref={ref}
        className="input min-h-40 !text-base leading-relaxed"
        placeholder="e.g. A 30s TikTok where @creator, a busy nurse, explains why @product keeps her going through night shifts better than coffee. End with the can on the counter and the @logo."
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          detect(e.target);
        }}
        onClick={(e) => detect(e.currentTarget)}
        onBlur={() => setTimeout(() => setQuery(null), 150)}
        onKeyDown={(e) => {
          if (!matches.length) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => (a + 1) % matches.length);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => (a - 1 + matches.length) % matches.length);
          } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            insert(matches[active].tag);
          } else if (e.key === 'Escape') setQuery(null);
        }}
      />
      {matches.length > 0 && (
        <div className="absolute left-3 top-full z-10 mt-1 w-64 overflow-hidden rounded-xl border border-line bg-panel2 shadow-2xl">
          {matches.map((t, i) => (
            <button key={t.tag} onMouseDown={(e) => e.preventDefault()} onClick={() => insert(t.tag)} className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${i === active ? 'bg-brand/20' : ''}`}>
              <AssetThumb asset={t.asset} className="h-7 w-7 rounded" />
              <span className="font-mono text-brand2">@{t.tag}</span>
              <span className="ml-auto text-xs text-muted">{t.kind}</span>
            </button>
          ))}
        </div>
      )}
      {tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {tags.map((t) => (
            <button key={t.tag} type="button" className="tag hover:bg-brand/30" onClick={() => onChange(`${value}${value && !value.endsWith(' ') ? ' ' : ''}@${t.tag} `)}>
              @{t.tag}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
