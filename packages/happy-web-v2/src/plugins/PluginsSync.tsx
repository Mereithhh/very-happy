/**
 * B-974d: keeps the plugin installs loaded — on mount and on every web resume
 * (AGENTS #13: via sync.onResume). Mounted once in AppLayout; renders nothing.
 */
import { useEffect } from 'react';
import { sync } from '@/sync/sync';
import { loadPluginInstalls } from '@/sync/pluginStore';

export function PluginsSync() {
  useEffect(() => {
    void loadPluginInstalls();
    return sync.onResume(() => {
      void loadPluginInstalls();
    });
  }, []);
  return null;
}
