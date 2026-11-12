/**
 * B-931 — where the daemon remembers automatic restarts that have not yet
 * been seen to land (`AutoRestartLanding`), so a daemon restart or handover
 * cannot forget a restart that changed nothing and start the loop again.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAutoRestartLandings, type AutoRestartLanding } from '@/update/autoRestartPolicy';

export const AUTO_RESTART_LANDINGS_FILE = 'auto-restart-landings.json';

export function autoRestartLandingStore(homeDir: string, now: () => number = Date.now) {
    const file = join(homeDir, AUTO_RESTART_LANDINGS_FILE);
    return {
        read(): Record<string, AutoRestartLanding> {
            try { return parseAutoRestartLandings(JSON.parse(readFileSync(file, 'utf8')), now()); } catch { return {}; }
        },
        write(landings: Record<string, AutoRestartLanding>): void {
            const tmp = `${file}.${process.pid}.tmp`;
            writeFileSync(tmp, JSON.stringify(landings), { mode: 0o600 });
            renameSync(tmp, file);
        },
    };
}
