import { describe, it, expect, vi } from 'vitest';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { installTeamSkill } from './install';
vi.mock('node:fs/promises', async original => {
    const actual = await original<typeof import('node:fs/promises')>();
    return { ...actual, rename: vi.fn(actual.rename) };
});
describe('interrupted skill publication', () => {
    it('recovers both publication boundaries but preserves edits during recovery', async () => {
        const base = join(homedir(), 'code/github/skills/tmp/agent-teams-implementation/tests');
        await mkdir(base, { recursive: true });
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        for (const failAt of [2, 3]) for (const edit of [false, true]) {
            const home = await mkdtemp(join(base, 'recovery-'));
            let calls = 0;
            vi.mocked(rename).mockImplementation(async (...args) => {
                if (++calls === failAt) throw new Error('simulated disk failure');
                return actual.rename(...args);
            });
            try {
                await expect(installTeamSkill({ host: 'pi', home, apply: true })).rejects.toThrow('disk failure');
                vi.mocked(rename).mockImplementation(actual.rename);
                const preview = await installTeamSkill({ host: 'pi', home });
                expect(preview.action).toBe('write');
                if (edit) {
                    await writeFile(preview.path, 'user edits during interruption');
                    await expect(installTeamSkill({ host: 'pi', home, apply: true })).rejects.toThrow('edited');
                    await expect(installTeamSkill({ host: 'pi', home, apply: true, uninstall: true })).rejects.toThrow('edited');
                } else {
                    await installTeamSkill({ host: 'pi', home, apply: true });
                    expect((await installTeamSkill({ host: 'pi', home })).action).toBe('unchanged');
                }
            } finally { vi.mocked(rename).mockImplementation(actual.rename); await rm(home, { recursive: true, force: true }); }
        }
    });
});
