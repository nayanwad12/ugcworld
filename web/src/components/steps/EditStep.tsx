import { useEffect, useState, type ReactNode } from 'react';
import type { Corner, EditSettings } from '../../../../shared/types.ts';
import { api } from '../../lib/api.ts';
import { useAction, useDebounced } from '../../lib/hooks.ts';
import { AddAssetForm, AssetThumb } from '../AssetsPanel.tsx';
import { ErrorBanner, Field, Slider, Spinner, StepHeader, Toggle, fmtSec } from '../ui.tsx';
import type { StepProps } from '../Workspace.tsx';

export function EditStep(props: StepProps) {
  const { project, setProject, refresh, config, go } = props;
  const [edit, setEdit] = useState<EditSettings>(project.edit);
  const { pending, error, setError, run } = useAction();
  const [upload, setUpload] = useState<'music' | 'sfx' | null>(null);

  useDebounced(edit, 500, (e) => api.saveEdit(project.id, e).then(setProject));
  // Pick up server-side defaults (e.g. a newly uploaded track becoming the music bed).
  useEffect(() => {
    setEdit((e) => ({
      ...e,
      music: { ...e.music, assetId: e.music.assetId ?? project.edit.music.assetId },
      logo: { ...e.logo, assetId: e.logo.assetId ?? project.edit.logo.assetId },
    }));
  }, [project.edit.music.assetId, project.edit.logo.assetId]);

  const set = <K extends keyof EditSettings>(k: K, v: Partial<EditSettings[K]>) => setEdit((e) => ({ ...e, [k]: Array.isArray(v) ? v : { ...(e[k] as object), ...v } }));
  const music = project.assets.filter((a) => a.kind === 'music' || (a.kind === 'other' && a.file?.mime.startsWith('audio/')));
  const sfx = project.assets.filter((a) => a.kind === 'sfx' || (a.kind === 'other' && a.file?.mime.startsWith('audio/')));
  const images = project.assets.filter((a) => a.file?.mime.startsWith('image/'));
  const total = project.clips.reduce((a, c) => a + c.durationSec - c.trimStart - c.trimEnd, 0);
  const sceneStarts = project.clips.map((_, i) => project.clips.slice(0, i).reduce((a, c) => a + c.durationSec - c.trimStart - c.trimEnd, 0));

  async function renderNow() {
    await run('render', async () => {
      const p = await api.saveEdit(project.id, edit);
      setProject(p);
      setProject(await api.render(project.id));
      go('export');
    });
  }

  return (
    <>
      <StepHeader title="Edit" subtitle={`Final cut settings — FFmpeg assembles ${project.clips.length} clips (${fmtSec(total)}) with your captions, music, sound FX, logo and end card. Changes save automatically.`}>
        <button className="btn-lime" disabled={!!pending || project.render.status === 'rendering'} onClick={renderNow}>
          {pending === 'render' ? <Spinner /> : '🎞️'} Render final MP4
        </button>
      </StepHeader>
      <ErrorBanner error={error} onClose={() => setError(undefined)} />

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="Captions" right={<Toggle checked={edit.captions.enabled} onChange={(v) => set('captions', { enabled: v })} />}>
          <div className={edit.captions.enabled ? '' : 'pointer-events-none opacity-40'}>
            <CaptionPreview edit={edit} />
            <div className="mt-4 grid grid-cols-2 gap-3">
              <Field label="Style">
                <select className="input" value={edit.captions.style} onChange={(e) => set('captions', { style: e.target.value as EditSettings['captions']['style'] })}>
                  <option value="karaoke">Karaoke — word highlight</option>
                  <option value="bold">Bold outline</option>
                  <option value="clean">Clean box</option>
                </select>
              </Field>
              <Field label="Position">
                <select className="input" value={edit.captions.position} onChange={(e) => set('captions', { position: e.target.value as EditSettings['captions']['position'] })}>
                  <option value="bottom">Lower third</option>
                  <option value="middle">Center</option>
                  <option value="top">Top</option>
                </select>
              </Field>
              <Field label="Words per caption">
                <Slider value={edit.captions.wordsPerLine} min={1} max={7} step={1} onChange={(v) => set('captions', { wordsPerLine: v })} />
              </Field>
              <Field label="Size">
                <Slider value={edit.captions.fontSize} min={48} max={130} step={2} onChange={(v) => set('captions', { fontSize: v })} />
              </Field>
              <Field label="Highlight color">
                <input type="color" className="h-9 w-full cursor-pointer rounded-lg border border-line bg-panel2" value={edit.captions.highlightColor} onChange={(e) => set('captions', { highlightColor: e.target.value })} />
              </Field>
              <div className="flex items-end pb-2">
                <Toggle checked={edit.captions.uppercase} onChange={(v) => set('captions', { uppercase: v })} label="UPPERCASE" />
              </div>
            </div>
            <p className="mt-3 text-xs text-muted">Caption text comes from each scene's dialogue; edit it per clip below. Timing is spread across the clip by word length.</p>
          </div>
        </Panel>

        <Panel title="Music" right={<button className="text-xs text-brand2 hover:text-white" onClick={() => setUpload(upload === 'music' ? null : 'music')}>+ Upload track</button>}>
          {upload === 'music' && (
            <div className="mb-4">
              <AddAssetForm project={project} kinds={['music']} defaultKind="music" compact onAdded={() => (setUpload(null), void refresh())} />
            </div>
          )}
          {project.script?.musicMood && <p className="mb-3 text-xs text-muted">Suggested mood: {project.script.musicMood}</p>}
          <Field label="Track">
            <select className="input" value={edit.music.assetId ?? ''} onChange={(e) => set('music', { assetId: e.target.value || undefined })}>
              <option value="">No music</option>
              {music.map((a) => (
                <option key={a.id} value={a.id}>
                  @{a.tag} — {a.name}
                </option>
              ))}
            </select>
          </Field>
          <div className={`mt-3 grid gap-3 ${edit.music.assetId ? '' : 'pointer-events-none opacity-40'}`}>
            <Field label="Music volume">
              <Slider value={edit.music.volume} min={0} max={1} step={0.05} onChange={(v) => set('music', { volume: v })} format={(v) => `${Math.round(v * 100)}%`} />
            </Field>
            <Field label="Fade out">
              <Slider value={edit.music.fadeOutSec} min={0} max={5} step={0.5} onChange={(v) => set('music', { fadeOutSec: v })} format={fmtSec} />
            </Field>
            <Toggle checked={edit.music.duck} onChange={(v) => set('music', { duck: v })} label="Auto-duck music under speech" />
          </div>
          <div className="mt-4">
            <Field label="Voice / clip audio volume">
              <Slider value={edit.voiceVolume} min={0} max={2} step={0.05} onChange={(v) => setEdit((e) => ({ ...e, voiceVolume: v }))} format={(v) => `${Math.round(v * 100)}%`} />
            </Field>
          </div>
        </Panel>

        <Panel title="Sound FX" right={<button className="text-xs text-brand2 hover:text-white" onClick={() => setUpload(upload === 'sfx' ? null : 'sfx')}>+ Upload SFX</button>}>
          {upload === 'sfx' && (
            <div className="mb-4">
              <AddAssetForm project={project} kinds={['sfx']} defaultKind="sfx" compact onAdded={() => (setUpload(null), void refresh())} />
            </div>
          )}
          <div className="mb-3 space-y-1">
            {project.script?.scenes
              .filter((s) => s.sfx)
              .map((s) => (
                <p key={s.id} className="text-xs text-muted">
                  Scene {s.index + 1} @ {fmtSec(sceneStarts[s.index] ?? 0)}: <span className="text-zinc-300">{s.sfx}</span>
                </p>
              ))}
          </div>
          <div className="space-y-2">
            {edit.sfx.map((cue, k) => (
              <div key={cue.id || k} className="grid grid-cols-[1fr_90px_1fr_auto] items-center gap-2">
                <select className="input !py-1.5" value={cue.assetId} onChange={(e) => set('sfx', edit.sfx.map((c, j) => (j === k ? { ...c, assetId: e.target.value } : c)))}>
                  {sfx.map((a) => (
                    <option key={a.id} value={a.id}>
                      @{a.tag}
                    </option>
                  ))}
                </select>
                <input type="number" step={0.1} min={0} className="input !py-1.5" value={cue.atSec} onChange={(e) => set('sfx', edit.sfx.map((c, j) => (j === k ? { ...c, atSec: Number(e.target.value) } : c)))} title="Seconds from start" />
                <Slider value={cue.volume} min={0} max={2} step={0.1} onChange={(v) => set('sfx', edit.sfx.map((c, j) => (j === k ? { ...c, volume: v } : c)))} format={(v) => `${Math.round(v * 100)}%`} />
                <button className="text-muted hover:text-red-300" onClick={() => set('sfx', edit.sfx.filter((_, j) => j !== k))}>
                  ✕
                </button>
              </div>
            ))}
          </div>
          <button className="btn-ghost mt-3 !py-1.5 text-xs" disabled={!sfx.length} onClick={() => set('sfx', [...edit.sfx, { id: '', assetId: sfx[0].id, atSec: 0, volume: 1 }])}>
            + Add cue {sfx.length ? '' : '(upload an SFX first)'}
          </button>
        </Panel>

        <Panel title="Logo watermark" right={<Toggle checked={edit.logo.enabled} onChange={(v) => set('logo', { enabled: v })} />}>
          <div className={edit.logo.enabled ? '' : 'pointer-events-none opacity-40'}>
            <ImagePicker images={images} value={edit.logo.assetId} onChange={(id) => set('logo', { assetId: id })} />
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Field label="Corner">
                <select className="input" value={edit.logo.position} onChange={(e) => set('logo', { position: e.target.value as Corner })}>
                  <option value="top-right">Top right</option>
                  <option value="top-left">Top left</option>
                  <option value="bottom-right">Bottom right</option>
                  <option value="bottom-left">Bottom left</option>
                </select>
              </Field>
              <Field label="Size">
                <Slider value={edit.logo.scale} min={0.06} max={0.4} step={0.01} onChange={(v) => set('logo', { scale: v })} format={(v) => `${Math.round(v * 100)}%`} />
              </Field>
              <Field label="Opacity">
                <Slider value={edit.logo.opacity} min={0.2} max={1} step={0.05} onChange={(v) => set('logo', { opacity: v })} format={(v) => `${Math.round(v * 100)}%`} />
              </Field>
            </div>
          </div>
        </Panel>

        <Panel title="End card" right={<Toggle checked={edit.endCard.enabled} onChange={(v) => set('endCard', { enabled: v })} />}>
          <div className={`grid gap-3 md:grid-cols-[140px_1fr] ${edit.endCard.enabled ? '' : 'pointer-events-none opacity-40'}`}>
            <div className="flex aspect-[9/16] flex-col items-center justify-center gap-2 rounded-xl border border-line p-3 text-center" style={{ background: edit.endCard.bgColor, color: edit.endCard.textColor }}>
              {(() => {
                const logo = images.find((a) => a.id === (edit.endCard.logoAssetId ?? edit.logo.assetId));
                return logo ? <AssetThumb asset={logo} className="h-10 w-10 rounded !object-contain" /> : null;
              })()}
              <span className="text-sm font-bold">{edit.endCard.headline || 'Headline'}</span>
              {edit.endCard.cta && (
                <span className="px-1.5 py-0.5 text-[10px] font-bold" style={{ background: edit.endCard.textColor, color: edit.endCard.bgColor }}>
                  {edit.endCard.cta}
                </span>
              )}
            </div>
            <div className="grid gap-3">
              <input className="input" placeholder="Headline" value={edit.endCard.headline} onChange={(e) => set('endCard', { headline: e.target.value })} />
              <input className="input" placeholder="CTA, e.g. Shop now — link in bio" value={edit.endCard.cta} onChange={(e) => set('endCard', { cta: e.target.value })} />
              <div className="grid grid-cols-3 gap-2">
                <Field label="Background">
                  <input type="color" className="h-9 w-full rounded-lg border border-line bg-panel2" value={edit.endCard.bgColor} onChange={(e) => set('endCard', { bgColor: e.target.value })} />
                </Field>
                <Field label="Text">
                  <input type="color" className="h-9 w-full rounded-lg border border-line bg-panel2" value={edit.endCard.textColor} onChange={(e) => set('endCard', { textColor: e.target.value })} />
                </Field>
                <Field label="Length">
                  <input type="number" min={1} max={8} step={0.5} className="input" value={edit.endCard.durationSec} onChange={(e) => set('endCard', { durationSec: Number(e.target.value) })} />
                </Field>
              </div>
              <Field label="End card logo">
                <ImagePicker images={images} value={edit.endCard.logoAssetId ?? edit.logo.assetId} onChange={(id) => set('endCard', { logoAssetId: id })} />
              </Field>
            </div>
          </div>
        </Panel>

        <Panel title="Transitions">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Between clips" hint={!config.xfade && edit.transition.type === 'crossfade' ? 'This FFmpeg build has no xfade; crossfade falls back to a quick dip.' : undefined}>
              <select className="input" value={edit.transition.type} onChange={(e) => set('transition', { type: e.target.value as EditSettings['transition']['type'] })}>
                <option value="cut">Hard cut (best for continuous UGC)</option>
                <option value="crossfade">Crossfade</option>
                <option value="fade">Dip to black</option>
              </select>
            </Field>
            <Field label="Duration">
              <Slider value={edit.transition.durationSec} min={0.1} max={1.5} step={0.05} onChange={(v) => set('transition', { durationSec: v })} format={fmtSec} />
            </Field>
          </div>
        </Panel>
      </div>

      <h2 className="label mt-8">Clips — trim & captions</h2>
      <div className="space-y-2">
        {project.clips.map((c) => (
          <ClipEditRow key={c.id} {...props} clipId={c.id} />
        ))}
      </div>
    </>
  );
}

function ClipEditRow({ project, setProject, clipId }: StepProps & { clipId: string }) {
  const c = project.clips.find((x) => x.id === clipId)!;
  const scene = project.script?.scenes.find((s) => s.id === c.sceneId);
  const [caption, setCaption] = useState(c.captionText ?? scene?.dialogue ?? '');
  const patch = async (body: Parameters<typeof api.patchClip>[2]) => setProject(await api.patchClip(project.id, c.id, body));
  return (
    <div className="card grid items-center gap-3 p-3 md:grid-cols-[110px_1fr_220px]">
      <div className="flex items-center gap-2">
        {c.url && <video src={c.url} className="h-14 w-10 rounded object-cover" muted />}
        <div className="text-xs">
          <div className="font-bold">Clip {c.index + 1}</div>
          <div className="text-muted">{fmtSec(c.durationSec - c.trimStart - c.trimEnd)}</div>
        </div>
      </div>
      <input className="input" value={caption} onChange={(e) => setCaption(e.target.value)} onBlur={() => caption !== (c.captionText ?? scene?.dialogue ?? '') && void patch({ captionText: caption === scene?.dialogue ? null : caption })} placeholder="No captions for this clip" />
      <div className="grid grid-cols-2 gap-2 text-xs text-muted">
        <label>
          Trim start
          <input type="number" step={0.1} min={0} className="input !py-1" defaultValue={c.trimStart} onBlur={(e) => Number(e.target.value) !== c.trimStart && void patch({ trimStart: Number(e.target.value) })} />
        </label>
        <label>
          Trim end
          <input type="number" step={0.1} min={0} className="input !py-1" defaultValue={c.trimEnd} onBlur={(e) => Number(e.target.value) !== c.trimEnd && void patch({ trimEnd: Number(e.target.value) })} />
        </label>
      </div>
    </div>
  );
}

function Panel({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="card p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="font-display text-lg font-bold">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

function ImagePicker({ images, value, onChange }: { images: StepProps['project']['assets']; value?: string; onChange: (id?: string) => void }) {
  if (!images.length) return <p className="text-xs text-muted">Upload a logo image in Brief & assets.</p>;
  return (
    <div className="flex flex-wrap gap-2">
      {images.map((a) => (
        <button key={a.id} onClick={() => onChange(a.id)} title={`@${a.tag}`} className={`overflow-hidden rounded-lg border-2 ${value === a.id ? 'border-lime' : 'border-transparent opacity-50 hover:opacity-100'}`}>
          <AssetThumb asset={a} className="h-12 w-12 !object-contain bg-panel2" />
        </button>
      ))}
    </div>
  );
}

function CaptionPreview({ edit }: { edit: EditSettings }) {
  const c = edit.captions;
  const words = ['This', 'changed', 'my', 'mornings', 'forever'].slice(0, Math.max(1, Math.min(5, c.wordsPerLine)));
  const text = (w: string) => (c.uppercase ? w.toUpperCase() : w);
  const pos = c.position === 'top' ? 'items-start pt-4' : c.position === 'middle' ? 'items-center' : 'items-end pb-6';
  return (
    <div className={`flex h-36 justify-center rounded-xl bg-gradient-to-br from-zinc-700 to-zinc-900 px-3 ${pos}`}>
      <span
        className={`text-center font-extrabold ${c.style === 'clean' ? 'rounded bg-black/55 px-2 py-1' : ''}`}
        style={{ fontSize: Math.round(c.fontSize / 4.2), textShadow: c.style === 'clean' ? undefined : '0 0 3px #000, 0 0 3px #000, 2px 2px 0 #000' }}
      >
        {words.map((w, i) => (
          <span key={i} style={{ color: c.style === 'karaoke' && i === 1 ? c.highlightColor : '#fff' }}>
            {text(w)}{' '}
          </span>
        ))}
      </span>
    </div>
  );
}
