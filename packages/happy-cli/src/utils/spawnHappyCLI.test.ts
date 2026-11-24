import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { orphanLauncherArgs } from './spawnHappyCLI';

describe('spawnHappyCLIOrphaned launcher (B-965)', () => {
    it.skipIf(process.platform === 'win32')('the started process is not a child of the caller or of the launcher', async () => {
        const out = join(mkdtempSync(join(tmpdir(), 'b965-')), 'ppid');
        const target = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(out)}, String(process.ppid)), 300)`;
        const launcher = spawn(process.execPath, orphanLauncherArgs(process.execPath, ['-e', target]), { stdio: 'ignore' });
        const launcherPid = launcher.pid;
        await new Promise<void>((resolve) => launcher.on('exit', () => resolve()));
        for (let i = 0; i < 50 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 100));
        const ppid = Number(readFileSync(out, 'utf8'));
        expect(ppid).toBeGreaterThan(0);
        expect(ppid).not.toBe(launcherPid);
        expect(ppid).not.toBe(process.pid);
    });
});
