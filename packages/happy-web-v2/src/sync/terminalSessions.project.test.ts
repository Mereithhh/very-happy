/**
 * B-868 through the store: 移到项目 / 移出 render at once, call the daemon RPC
 * with the right arguments, and revert immediately when the daemon refuses.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';

const setProject = vi.fn<(machineId: string, terminalId: string, projectId: string | null) => Promise<boolean>>();
vi.mock('@/sync/ops', () => ({
  machineSetTerminalProject: (...args: [string, string, string | null]) => setProject(...args),
  machineSetTerminalTags: vi.fn(async () => true),
  machineSetTerminalTitle: vi.fn(async () => true),
}));

let useTerminalSessions: typeof import('./terminalSessions').useTerminalSessions;
beforeAll(async () => {
  installBrowserTestGlobals();
  ({ useTerminalSessions } = await import('./terminalSessions'));
});

const PID = 'p-1';
const row = () => useTerminalSessions.getState().terminals.find((t) => t.id === 'aaa');

describe('B-868 terminalSessions.setProject', () => {
  beforeEach(() => {
    setProject.mockReset();
    useTerminalSessions.setState({ terminals: [], pushes: {}, overlay: { created: [], renames: {}, removed: {} } });
    useTerminalSessions.getState().applyPush('m1', 'box', [{ id: 'aaa', title: 'work', projectId: null }], Date.now());
  });

  it('moves optimistically and asks the owning daemon', async () => {
    let resolve!: (ok: boolean) => void;
    setProject.mockReturnValue(new Promise((r) => { resolve = r; }));
    const done = useTerminalSessions.getState().setProject('aaa', PID);
    expect(row()!.projectId).toBe(PID);
    expect(setProject).toHaveBeenCalledWith('m1', 'aaa', PID);
    resolve(true);
    await expect(done).resolves.toBe(true);
    expect(row()!.projectId).toBe(PID); // until the push confirms (or the TTL)
    useTerminalSessions.getState().applyPush('m1', 'box', [{ id: 'aaa', title: 'work', projectId: PID }], Date.now());
    expect(useTerminalSessions.getState().overlay.renames.aaa).toBeUndefined();
  });

  it('a refused write reverts at once instead of pretending', async () => {
    setProject.mockResolvedValue(false);
    await expect(useTerminalSessions.getState().setProject('aaa', PID)).resolves.toBe(false);
    expect(row()!.projectId).toBeNull();
    expect(useTerminalSessions.getState().overlay.renames.aaa).toBeUndefined();
  });

  it('a create inside a project shows under it before the daemon pushes', () => {
    const t = useTerminalSessions.getState().create('m1', 'box', undefined, PID);
    expect(useTerminalSessions.getState().terminals.find((x) => x.id === t.id)!.projectId).toBe(PID);
  });
});
