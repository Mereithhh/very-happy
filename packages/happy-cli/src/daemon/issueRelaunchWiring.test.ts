import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// B-874c wiring (source assertions; issueRelaunchEnv / the digest / the worker have behavioural tests).
const strip = (source: string) => source.replace(/^\s*\/\/.*$/gm, '');
const run = strip(readFileSync(join(__dirname, 'run.ts'), 'utf8'));
const block = (start: string, end: string) => run.slice(run.indexOf(start), run.indexOf(end, run.indexOf(start)));

describe('issue binding rides every wrapper relaunch (QA43 P1-1)', () => {
    // resumeSessionImpl: Restore / hibernation wake / crash-loop wake; restartSessionImpl: auto-restart, Restart, account switch.
    for (const [name, start] of [['resumeSessionImpl', 'const resumeSessionImpl = async'], ['restartSessionImpl', 'const restartSessionImpl = async']] as const) {
        it(`${name} spawns with issueRelaunchEnv(metadata) after the inherited env`, () => {
            const body = block(start, 'const result = await spawnTrackedHappyProcess(');
            const spawn = run.slice(run.indexOf('const result = await spawnTrackedHappyProcess(', run.indexOf(start)));
            const env = spawn.slice(0, spawn.indexOf('});'));
            expect(body).toContain('const teamEnv = await teamRelaunchEnvFor(happySessionId, metadata);');
            expect(env).toContain('HAPPY_RECONNECT_SESSION_ID: happySessionId,');
            expect(env.indexOf('...issueRelaunchEnv(metadata),')).toBeGreaterThan(env.indexOf('...process.env,'));
        });
    }
    it('only those two paths reconnect a wrapper to an existing session (plus the assistant, which is never an issue run)', () => {
        expect(run.match(/HAPPY_RECONNECT_SESSION_ID:/g)?.length).toBe(3);
        expect(run.match(/\.\.\.issueRelaunchEnv\(metadata\),/g)?.length).toBe(2);
    });
    it('the digest falls back to metadata.issue when the env is missing', () => {
        const injector = strip(readFileSync(join(__dirname, '../projects/injector.ts'), 'utf8'));
        expect(injector).toContain('createIssueDigest({ sessionId: deps.sessionId, metadata: () => deps.metadata?.() ?? null, timeoutMs })');
    });
});

describe('a directory that cannot be created is a definite spawn failure (QA43 P2-1)', () => {
    it('the mkdir failure returns notStarted', () => {
        const mkdir = block('Directory creation failed: ${errorMessage}', 'directoryCreated = true');
        expect(mkdir.slice(0, 200)).toContain('notStarted: true');
    });
});
