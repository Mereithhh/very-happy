/**
 * B-974g: loads `/v1/features` once per sign-in. Asked again on web resume
 * (AGENTS #13) only while the server has not answered — like the plugin UI
 * (pluginStore), a switch flipped later shows on the next load. Renders nothing.
 */
import { useEffect } from 'react';
import { useAuth } from '@/auth/AuthContext';
import { sync } from '@/sync/sync';
import { getServerUrl } from '@/sync/serverConfig';
import { fetchServerFeatures, setServerFeatures } from '@/sync/serverFeatures';

export function ServerFeaturesSync() {
  const token = useAuth().credentials?.token ?? null;
  useEffect(() => {
    if (!token) return;
    let gone = false;
    let wanted = true;
    const load = () => {
      if (!wanted) return;
      wanted = false;
      void fetchServerFeatures(getServerUrl(), token).then((result) => {
        if (gone) return;
        wanted = result.retry;
        setServerFeatures(result.features);
      });
    };
    load();
    const off = sync.onResume(load);
    return () => { gone = true; off(); setServerFeatures([]); };
  }, [token]);
  return null;
}
