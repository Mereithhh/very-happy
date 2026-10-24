/**
 * B-801: pure helpers behind the draft page's target fields.
 */
import type { RecentMachinePath } from '@/utils/quickChat';

/** The daemon's spawn does not expand `~`: resolve it with the machine's home dir. */
export function resolveHomePath(path: string, homeDir: string | undefined): string {
    if (!homeDir) return path;
    if (path === '~') return homeDir;
    if (path.startsWith('~/')) return `${homeDir.replace(/\/$/, '')}/${path.slice(2)}`;
    return path;
}

/** Directory completions: this machine's recent paths first, then saved presets, no repeats. */
export function draftDirectorySuggestions(
    machineId: string,
    recents: readonly RecentMachinePath[],
    presets: readonly { path: string }[],
): string[] {
    const out: string[] = [];
    for (const r of recents) if (r.machineId === machineId && r.path && !out.includes(r.path)) out.push(r.path);
    for (const p of presets) if (p.path && !out.includes(p.path)) out.push(p.path);
    return out;
}

/** The draft page's project line: where the session will land (no picker here — B-757 banner after). */
export function draftProjectHint(
    joining: { name: string } | undefined,
    suggested: { name: string } | null,
    zh: boolean,
): string {
    if (joining) return zh ? `将加入项目「${joining.name}」。` : `The session joins “${joining.name}”.`;
    if (suggested) return zh
        ? `目录属于「${suggested.name}」，不会自动加入；会话建好后可一键加入。`
        : `This folder belongs to “${suggested.name}”; the session does not join it automatically (one click once it starts).`;
    return zh ? '不属于任何项目。' : 'Not in any project.';
}
