import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

describe.skipIf(process.platform === 'win32')('user launchd installation', () => {
    it('refuses a live daemon and installs stable runtime paths without a forced restart', () => {
        const base = join(homedir(), 'code/github/skills/tmp/agent-teams-rollout/tests');
        mkdirSync(base, { recursive: true });
        const home = mkdtempSync(join(base, 'launchd-'));
        try {
            mkdirSync(join(home, '.happy'));
            mkdirSync(join(home, 'bin'));
            writeFileSync(join(home, 'bin/launchctl'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOME/launchctl.log"\n', { mode: 0o755 });
            const env = { ...process.env, HOME: home, PATH: `${join(home, 'bin')}:${process.env.PATH}` };
            const script = resolve('../../ops/mac-office/install-launch-agent.sh');
            writeFileSync(join(home, '.happy/daemon.state.json'), JSON.stringify({ pid: process.pid }));
            const refused = spawnSync('bash', [script], { env, encoding: 'utf8' });
            expect(refused.status).not.toBe(0);
            expect(existsSync(join(home, 'launchctl.log'))).toBe(false);
            rmSync(join(home, '.happy/daemon.state.json'));
            const installed = spawnSync('bash', [script], { env, encoding: 'utf8' });
            expect(installed.status, installed.stderr).toBe(0);
            expect(readFileSync(join(home, 'Library/LaunchAgents/com.mereith.happy-daemon.plist'), 'utf8')).toContain(join(home, '.local/share/very-happy/ops/happy-daemon-launch.sh'));
            expect(readFileSync(join(home, '.local/share/very-happy/ops/node-bin-dir'), 'utf8')).not.toContain('fnm_multishells');
            expect(readFileSync(join(home, 'launchctl.log'), 'utf8')).not.toContain('kickstart -k');
        } finally { rmSync(home, { recursive: true, force: true }); }
    });
});
