/**
 * B-718 — `$HAPPY_HOME_DIR/cli-update-last.json`: the last CLI install this
 * machine completed. Written by the daemon that installs, read by the daemon
 * that replaces it, so the machine page can say "auto-updated 0.2.179 → 0.2.180
 * at 21:49" instead of an indistinguishable "current". Display only — nothing
 * decides anything from it.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseExactVersion } from './cliUpdate';
import type { LastCliInstall } from './updateController';

export function parseLastInstall(raw: unknown): LastCliInstall | null {
    if (!raw || typeof raw !== 'object') return null;
    const { from, to, at, source } = raw as Record<string, unknown>;
    if (typeof from !== 'string' || typeof to !== 'string' || !parseExactVersion(from) || !parseExactVersion(to)) return null;
    if (typeof at !== 'number' || !Number.isFinite(at) || (source !== 'auto' && source !== 'manual')) return null;
    return { from, to, at, source };
}

export function lastInstallStore(homeDir: string) {
    const file = join(homeDir, 'cli-update-last.json');
    return {
        read(): LastCliInstall | null {
            try { return parseLastInstall(JSON.parse(readFileSync(file, 'utf8'))); } catch { return null; }
        },
        write(record: LastCliInstall): void {
            const tmp = `${file}.${process.pid}.tmp`;
            writeFileSync(tmp, JSON.stringify(record));
            renameSync(tmp, file);
        },
    };
}
