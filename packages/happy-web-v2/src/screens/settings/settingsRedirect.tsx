/**
 * B-850c: settings paths that moved. 「智能体默认设置」 (/settings/agents) and
 * 「模型与 Provider」 (/settings/models) are one page now. Old bookmarks and
 * links keep their ?machine= / ?setting= and hash; the target is relative, so
 * every mount (/settings, /dev/settings, /dev/device/settings) stays in place.
 */
import { Navigate, useLocation } from 'react-router-dom';

export const MODELS_ACCOUNTS_PATH = 'models-accounts';

export const LEGACY_SETTINGS_REDIRECTS: Readonly<Record<string, string>> = {
  agents: MODELS_ACCOUNTS_PATH,
  models: MODELS_ACCOUNTS_PATH,
};

export function SettingsRedirect({ to }: { to: string }) {
  const location = useLocation();
  return <Navigate replace to={{ pathname: `../${to}`, search: location.search, hash: location.hash }} />;
}
