/**
 * B-856: `very-happy daemon list` — per session, the wrapper's CLI version and
 * its auto-restart classification (B-852). The daemon publishes that status
 * to the server encrypted, so before this a release check could only infer it
 * from banners and wrapper pids.
 */
import { compareExactVersions } from '@/update/cliUpdate';
import type { AutoRestartSessionStatus } from '@/update/autoRestartPolicy';
import type { DaemonListInfo } from './controlServer';

export interface DaemonListSession {
    happySessionId: string;
    pid: number;
    startedBy?: string;
    turnActive?: boolean;
    cliVersion?: string;
    /** null = nothing pending; absent = an older daemon that does not report it. */
    autoRestart?: AutoRestartSessionStatus | null;
    /** B-911: a queued 「空闲后重启」. */
    idleRestart?: { source: string; requestedAt: number; wait?: string; restarting?: boolean };
}

export function autoRestartLabel(session: DaemonListSession, daemon: DaemonListInfo | undefined, formatTime: (ms: number) => string = defaultTime): string {
    const status = session.autoRestart;
    if (status === undefined) return 'auto-restart: unknown (daemon does not report it)';
    if (status) {
        const details = [status.reason, status.offline ? 'offline' : null, status.retryAt ? `retry ${formatTime(status.retryAt)}` : null]
            .filter((part): part is string => !!part);
        return `auto-restart: ${status.state}${details.length ? ` (${details.join(', ')})` : ''} → ${status.target}`;
    }
    const behind = !!daemon && !!session.cliVersion && (compareExactVersions(session.cliVersion, daemon.version) ?? 0) < 0;
    if (!behind) return 'current';
    return daemon!.autoRestartEnabled ? 'behind (not evaluated yet)' : 'behind (auto-restart off)';
}

export function formatDaemonList(sessions: DaemonListSession[], daemon: DaemonListInfo | undefined, formatTime?: (ms: number) => string): string[] {
    const lines: string[] = [];
    if (daemon) {
        lines.push(`Daemon ${daemon.version} · auto-restart ${daemon.autoRestartEnabled ? 'on' : 'off'}${daemon.upgradePending
            ? ` · upgrade pending (${daemon.upgradePending}): automatic restarts wait for the new daemon`
            : ''}`);
    }
    for (const session of sessions) {
        const idle = session.idleRestart;
        const queued = idle ? `  restart when idle: ${idle.restarting ? 'restarting' : `queued by ${idle.source} ${(formatTime ?? defaultTime)(idle.requestedAt)}${idle.wait ? ` (waiting: ${idle.wait})` : ''}`}` : '';
        lines.push(`  ${session.happySessionId}  pid ${session.pid}  cli ${session.cliVersion ?? '?'}  ${autoRestartLabel(session, daemon, formatTime)}${queued}`);
    }
    return lines;
}

function defaultTime(ms: number): string {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
