/** B-974d: Web routes for plugin surfaces. */
export function pluginPanelPath(installId: string, panelId: string, path?: string | null): string {
  const base = `/plugins/${encodeURIComponent(installId)}/${encodeURIComponent(panelId)}`;
  return path ? `${base}?path=${encodeURIComponent(path)}` : base;
}
