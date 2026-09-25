import { useRef, useState } from 'react';
import type { Asset, AssetKind, Project } from '../../../shared/types.ts';
import { api } from '../lib/api.ts';
import { Spinner } from './ui.tsx';

export const KIND_META: Record<AssetKind, { label: string; icon: string; hint: string; accept: string }> = {
  creator: { label: 'Creator', icon: '🧑', hint: 'The person on camera', accept: 'image/*' },
  product: { label: 'Product', icon: '🥤', hint: 'Packshot of what you sell', accept: 'image/*' },
  environment: { label: 'Environment', icon: '🏙️', hint: 'Location / set', accept: 'image/*' },
  logo: { label: 'Logo', icon: '🔷', hint: 'PNG with transparency is best', accept: 'image/*' },
  props: { label: 'Props', icon: '🎒', hint: 'Objects in the scene', accept: 'image/*' },
  narrator: { label: 'Narrator', icon: '🎙️', hint: 'Voice-over persona', accept: 'image/*' },
  music: { label: 'Music', icon: '🎵', hint: 'Background track', accept: 'audio/*' },
  sfx: { label: 'Sound FX', icon: '💥', hint: 'Whoosh, pop, ding…', accept: 'audio/*' },
  other: { label: 'Other', icon: '✨', hint: 'Anything else', accept: 'image/*,video/*,audio/*' },
};

export function AssetThumb({ asset, className = '' }: { asset: Asset; className?: string }) {
  const src = asset.file?.url ?? asset.remoteUrl;
  if (asset.file?.mime.startsWith('audio/')) return <div className={`grid place-items-center bg-panel2 text-3xl ${className}`}>{KIND_META[asset.kind].icon}</div>;
  if (asset.file?.mime.startsWith('video/')) return <video src={src} className={`object-cover ${className}`} muted />;
  if (src) return <img src={src} alt={asset.tag} className={`object-cover ${className}`} />;
  return <div className={`grid place-items-center bg-panel2 text-3xl ${className}`}>{KIND_META[asset.kind].icon}</div>;
}

export function AddAssetForm({ project, onAdded, kinds, defaultKind = 'creator', compact }: { project: Project; onAdded: () => void; kinds?: AssetKind[]; defaultKind?: AssetKind; compact?: boolean }) {
  const [kind, setKind] = useState<AssetKind>(defaultKind);
  const [file, setFile] = useState<File>();
  const [tag, setTag] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const list = kinds ?? (Object.keys(KIND_META) as AssetKind[]);
  const audio = kind === 'music' || kind === 'sfx';

  async function submit() {
    if (!file && !description.trim() && !remoteUrl.trim()) return setErr('Add a file, a URL, or at least a description.');
    setBusy(true);
    setErr(undefined);
    const form = new FormData();
    form.set('kind', kind);
    if (tag) form.set('tag', tag);
    if (name) form.set('name', name);
    if (description) form.set('description', description);
    if (remoteUrl) form.set('remoteUrl', remoteUrl);
    if (file) form.set('file', file);
    try {
      await api.addAsset(project.id, form);
      setFile(undefined);
      setTag('');
      setName('');
      setDescription('');
      setRemoteUrl('');
      onAdded();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-4">
      <div className="mb-3 flex flex-wrap gap-1.5">
        {list.map((k) => (
          <button key={k} type="button" onClick={() => setKind(k)} className={`chip ${kind === k ? '!border-brand !bg-brand/20 !text-white' : 'hover:border-brand/50'}`}>
            {KIND_META[k].icon} {KIND_META[k].label}
          </button>
        ))}
      </div>
      <div className={`grid gap-3 ${compact ? '' : 'md:grid-cols-[180px_1fr]'}`}>
        <div
          onClick={() => input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
          }}
          className={`flex min-h-28 cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-3 text-center text-xs transition ${drag ? 'border-lime bg-lime/5' : 'border-line hover:border-brand/60'}`}
        >
          <input ref={input} type="file" hidden accept={KIND_META[kind].accept} onChange={(e) => setFile(e.target.files?.[0])} />
          {file ? (
            file.type.startsWith('image/') ? (
              <img src={URL.createObjectURL(file)} className="max-h-24 rounded-lg" />
            ) : (
              <span className="break-all text-zinc-200">{file.name}</span>
            )
          ) : (
            <>
              <span className="text-2xl">{KIND_META[kind].icon}</span>
              <span className="mt-1 text-muted">Drop or click to upload</span>
              <span className="text-[11px] text-muted/70">{KIND_META[kind].hint}</span>
            </>
          )}
        </div>
        <div className="grid gap-2">
          <div className="grid grid-cols-2 gap-2">
            <input className="input" placeholder={`Tag, e.g. @${kind === 'creator' ? 'maya' : kind}`} value={tag} onChange={(e) => setTag(e.target.value.replace(/\s/g, ''))} />
            <input className="input" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          {!audio && (
            <textarea
              className="input min-h-16"
              placeholder={kind === 'narrator' ? 'Voice: e.g. warm female voice, late 20s, soft American accent' : 'Describe it (or leave blank and use ✨ Auto-describe after upload)'}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          )}
          {!audio && <input className="input" placeholder="Public image URL (optional — used instead of the upload for APIMart)" value={remoteUrl} onChange={(e) => setRemoteUrl(e.target.value)} />}
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-red-300">{err}</span>
            <button className="btn-primary" disabled={busy} onClick={submit} type="button">
              {busy ? <Spinner /> : '+'} Add {KIND_META[kind].label.toLowerCase()}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function AssetCard({ project, asset, onChange }: { project: Project; asset: Asset; onChange: () => void }) {
  const [tag, setTag] = useState(asset.tag);
  const [description, setDescription] = useState(asset.description);
  const [busy, setBusy] = useState<string>();
  const audio = asset.kind === 'music' || asset.kind === 'sfx';
  const isImage = asset.file?.mime.startsWith('image/');

  const save = async (patch: Partial<Asset>) => {
    const a = await api.patchAsset(project.id, asset.id, patch);
    setTag(a.tag);
    onChange();
  };

  return (
    <div className="card flex gap-3 p-3">
      <AssetThumb asset={asset} className="h-24 w-20 shrink-0 rounded-lg" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="text-brand2">@</span>
          <input
            className="w-full min-w-0 rounded bg-transparent font-mono text-sm font-semibold text-brand2 outline-none focus:bg-panel2"
            value={tag}
            onChange={(e) => setTag(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ''))}
            onBlur={() => tag !== asset.tag && save({ tag })}
          />
          <span className="chip shrink-0 !py-0.5">
            {KIND_META[asset.kind].icon} {KIND_META[asset.kind].label}
          </span>
        </div>
        {audio ? (
          <audio controls src={asset.file?.url} className="h-8 w-full" />
        ) : (
          <textarea
            className="input !py-1.5 !text-xs min-h-14"
            placeholder="Description used in prompts"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={() => description !== asset.description && save({ description })}
          />
        )}
        <div className="flex items-center justify-between">
          <span className="truncate text-[11px] text-muted">{asset.name}</span>
          <div className="flex gap-2">
            {isImage && (
              <button
                className="text-xs text-brand2 hover:text-white disabled:opacity-50"
                disabled={!!busy}
                onClick={async () => {
                  setBusy('describe');
                  try {
                    const a = await api.describeAsset(project.id, asset.id);
                    setDescription(a.description);
                    onChange();
                  } catch (e) {
                    alert((e as Error).message);
                  } finally {
                    setBusy(undefined);
                  }
                }}
              >
                {busy === 'describe' ? 'Describing…' : '✨ Auto-describe'}
              </button>
            )}
            <button
              className="text-xs text-muted hover:text-red-300"
              onClick={async () => {
                if (!confirm(`Remove @${asset.tag}?`)) return;
                await api.deleteAsset(project.id, asset.id);
                onChange();
              }}
            >
              Remove
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
