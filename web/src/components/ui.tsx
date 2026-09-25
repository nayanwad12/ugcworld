import type { ReactNode } from 'react';
import type { ClipStatus } from '../../../shared/types.ts';

export function Logo({ size = 'md' }: { size?: 'md' | 'lg' }) {
  const big = size === 'lg';
  return (
    <span className="inline-flex items-center gap-2 select-none">
      <span className={`grid place-items-center rounded-xl bg-brand font-display font-bold text-lime ${big ? 'h-11 w-11 text-2xl' : 'h-8 w-8 text-lg'}`}>i</span>
      <span className={`font-display font-bold tracking-tight ${big ? 'text-3xl' : 'text-xl'}`}>
        Idea<span className="text-lime">bro</span>
      </span>
    </span>
  );
}

export function Spinner({ className = '' }: { className?: string }) {
  return <span className={`inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent ${className}`} />;
}

export function ErrorBanner({ error, onClose }: { error?: string; onClose?: () => void }) {
  if (!error) return null;
  return (
    <div className="mb-4 flex items-start justify-between gap-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
      <span className="whitespace-pre-wrap break-words">{error}</span>
      {onClose && (
        <button className="text-red-300 hover:text-white" onClick={onClose}>
          ✕
        </button>
      )}
    </div>
  );
}

export function StepHeader({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="font-display text-2xl font-bold">{title}</h1>
        {subtitle && <p className="mt-1 max-w-3xl text-sm text-muted">{subtitle}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

export function Field({ label, hint, children, className = '' }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function Progress({ value, className = '' }: { value: number; className?: string }) {
  return (
    <div className={`h-1.5 w-full overflow-hidden rounded-full bg-line ${className}`}>
      <div className="h-full rounded-full bg-gradient-to-r from-brand to-lime transition-all duration-500" style={{ width: `${Math.max(2, Math.min(100, value))}%` }} />
    </div>
  );
}

const STATUS_STYLE: Record<ClipStatus, string> = {
  idle: 'bg-zinc-500/15 text-zinc-300',
  queued: 'bg-sky-500/15 text-sky-300',
  submitting: 'bg-brand/20 text-brand2',
  generating: 'bg-brand/20 text-brand2',
  downloading: 'bg-brand/20 text-brand2',
  ready: 'bg-lime/15 text-lime',
  failed: 'bg-red-500/15 text-red-300',
};

export function StatusPill({ status, stale }: { status: ClipStatus; stale?: boolean }) {
  return (
    <span className="inline-flex gap-1">
      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${STATUS_STYLE[status]}`}>{status}</span>
      {stale && <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-300">out of sync</span>}
    </span>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className="inline-flex items-center gap-2 text-sm text-zinc-200">
      <span className={`relative h-5 w-9 rounded-full transition ${checked ? 'bg-brand' : 'bg-line'}`}>
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`} />
      </span>
      {label}
    </button>
  );
}

export function Slider({ value, min, max, step, onChange, format }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; format?: (v: number) => string }) {
  return (
    <div className="flex items-center gap-3">
      <input type="range" className="w-full accent-[var(--color-brand)]" value={value} min={min} max={max} step={step} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="w-14 text-right text-xs tabular-nums text-muted">{format ? format(value) : value}</span>
    </div>
  );
}

export const fmtSec = (s: number) => `${Math.round(s * 10) / 10}s`;
