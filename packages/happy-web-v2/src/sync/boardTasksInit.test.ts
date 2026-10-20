/**
 * B-068: the board's task list loads on a cold mount straight into /board.
 * The store used to read credentials only from the getCurrentAuth() global,
 * which AuthProvider publishes from an effect; the board now hands it the
 * credentials from context, so the load no longer depends on effect order.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const kv = vi.hoisted(() => ({ kvGet: vi.fn(), kvSet: vi.fn() }));
const auth = vi.hoisted(() => ({ current: null as null | { credentials: { token: string; secret: string } } }));
vi.mock('@/sync/apiKv', () => kv);
vi.mock('@/auth/AuthContext', () => ({ getCurrentAuth: () => auth.current }));
vi.mock('@/storage/mmkv-web', () => ({ MMKV: class { getString() { return undefined; } set() {} delete() {} } }));

import { useBoardTasks } from './boardTasks';

const creds = { token: 'tok-a', secret: 'sec' };
const b64 = (v: unknown) => btoa(JSON.stringify(v));

describe('boardTasks.initialize (B-068)', () => {
    beforeEach(() => {
        auth.current = null;
        kv.kvGet.mockReset();
        useBoardTasks.setState({ tasks: [], initialized: false });
    });

    it('loads with context credentials while the getCurrentAuth global is still empty', async () => {
        const task = { id: 't1', title: 'Ship', status: 'open', createdAt: 1, updatedAt: 1 };
        kv.kvGet.mockResolvedValue({ version: 3, value: b64({ tasks: [task] }) });
        await useBoardTasks.getState().initialize(creds);
        expect(kv.kvGet).toHaveBeenCalledWith(creds, expect.any(String));
        expect(useBoardTasks.getState().initialized).toBe(true);
        expect(useBoardTasks.getState().tasks.map((t) => t.id)).toEqual(['t1']);
    });

    it('without either source it stays a no-op (logged out)', async () => {
        await useBoardTasks.getState().initialize();
        expect(kv.kvGet).not.toHaveBeenCalled();
        expect(useBoardTasks.getState().initialized).toBe(false);
    });

    it('the board passes useAuth().credentials and re-runs when they arrive', () => {
        const src = readFileSync(new URL('../screens/board/TaskBoardScreen.tsx', import.meta.url), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        expect(src).toContain('const { credentials } = useAuth();');
        expect(src).toMatch(/if \(credentials\) void initializeTasks\(credentials\);\s*\}, \[initializeTasks, credentials\]\);/);
    });
});
