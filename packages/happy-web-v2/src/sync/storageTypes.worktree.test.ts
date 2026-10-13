import { it, expect } from 'vitest';
import { MachineMetadataSchema, MetadataSchema } from './storageTypes';

it('schemas keep the new optional fields and tolerate garbage (iron rule 14)', () => {
    const machine = MachineMetadataSchema.parse({ host: 'h', platform: 'linux', happyCliVersion: '1', happyHomeDir: '/h', homeDir: '/h', worktreeVersion: 1 });
    expect(machine.worktreeVersion).toBe(1);
    const base = { path: '/w', host: 'h' };
    expect(MetadataSchema.parse({ ...base, worktree: { branch: 'vh/a', root: '/w' } }).worktree).toEqual({ branch: 'vh/a', root: '/w' });
    // a malformed value from some future/old wrapper must not drop the session
    expect(MetadataSchema.safeParse({ ...base, worktree: 'weird' }).success).toBe(true);
    expect(MetadataSchema.parse({ ...base }).worktree).toBeUndefined();
});
