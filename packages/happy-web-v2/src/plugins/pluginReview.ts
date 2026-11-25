/**
 * B-974d: review-page helpers (DESIGN B-973 §3.2, §3.3).
 */
import type { PluginManifest, PluginPermission } from './pluginTypes';

/** i18n key segment for a permission (dots would split the t() path). */
export function permissionTextKey(p: PluginPermission): 'sidebar' | 'panel' | 'decisions' | 'sessionWidget' | 'sessionsList' | 'sessionsRead' {
  switch (p) {
    case 'session.widget':
      return 'sessionWidget';
    case 'sessions.list':
      return 'sessionsList';
    case 'sessions.read':
      return 'sessionsRead';
    default:
      return p;
  }
}

/** One diff value as plain text; never rendered as HTML. */
export function diffValueText(v: unknown): string {
  if (v === undefined || v === null || v === '') return '—';
  if (typeof v === 'string') return v.length > 200 ? `${v.slice(0, 200)}…` : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    const s = JSON.stringify(v);
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  } catch {
    return '?';
  }
}

/** Panel → upstream lines for the 「本机地址」 group. */
export function reviewPanelRows(m: PluginManifest): { id: string; title: string; upstream: string }[] {
  return (m.panels ?? []).map((p) => ({ id: p.id, title: p.title || p.id, upstream: p.upstream || '—' }));
}
