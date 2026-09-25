import { useEffect, useState } from 'react';
import type { AppConfig } from '../../shared/types.ts';
import { api } from './lib/api.ts';
import { Home } from './components/Home.tsx';
import { Workspace } from './components/Workspace.tsx';
import { Spinner } from './components/ui.tsx';

function useHashRoute() {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

export default function App() {
  const hash = useHashRoute();
  const [config, setConfig] = useState<AppConfig>();
  useEffect(() => {
    api.config().then(setConfig).catch(() => undefined);
  }, []);

  if (!config)
    return (
      <div className="grid h-full place-items-center text-muted">
        <Spinner />
      </div>
    );
  const m = /^#\/p\/([\w-]+)/.exec(hash);
  return m ? <Workspace key={m[1]} id={m[1]} config={config} /> : <Home config={config} />;
}
