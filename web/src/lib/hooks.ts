import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project } from '../../../shared/types.ts';
import { api } from './api.ts';

const busy = (p?: Project) => !!p && (p.generating || p.render.status === 'rendering' || p.autopilot.running);

/** Loads a project and keeps polling while background work (generation, render, autopilot) runs. */
export function useProject(id: string) {
  const [project, setProject] = useState<Project>();
  const [error, setError] = useState<string>();
  const timer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      setProject(await api.project(id));
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    window.clearTimeout(timer.current);
    if (busy(project)) timer.current = window.setTimeout(refresh, 1500);
    return () => window.clearTimeout(timer.current);
  }, [project, refresh]);

  return { project, setProject, refresh, error };
}

/** Run an async action with a loading flag and error capture. */
export function useAction() {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>): Promise<T | undefined> => {
    setPending(key);
    setError(undefined);
    try {
      return await fn();
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    } finally {
      setPending(null);
    }
  }, []);
  return { pending, error, setError, run };
}

const flushers = new Set<() => Promise<unknown>>();

/** Save every form with unsaved changes (call before actions that read server state). */
export async function flushAutosaves() {
  await Promise.all([...flushers].map((f) => f()));
}

/**
 * Debounced autosave. Pending changes are also saved when the component unmounts
 * (e.g. switching steps) and when flushAutosaves() is called.
 */
export function useDebounced<T>(value: T, ms: number, fn: (v: T) => unknown, enabled = true) {
  const first = useRef(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const pending = useRef<{ value: T } | null>(null);

  const flush = useCallback(async () => {
    const p = pending.current;
    pending.current = null;
    if (p) await fnRef.current(p.value);
  }, []);

  useEffect(() => {
    flushers.add(flush);
    return () => {
      flushers.delete(flush);
      void flush();
    };
  }, [flush]);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!enabled) return;
    pending.current = { value };
    const t = window.setTimeout(() => void flush(), ms);
    return () => window.clearTimeout(t);
  }, [value, ms, enabled, flush]);
}
