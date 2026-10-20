import { describe, expect, it, vi } from 'vitest';
import { executeSessionPeerTool } from '@/sessions/peerTools';
import { ProjectsUnsupportedError } from './client';

const self = () => ({ sessionId: 's-me', cwd: '/repo' });

describe('session_peers scope=project (B-645)', () => {
    it('reads project presence for the calling session and never fans out to machines', async () => {
        const listPeers = vi.fn();
        const projectPeers = vi.fn(async (sid: string) => ({ scope: 'project' as const, project: { id: 'p', name: 'vh' }, peers: [{ sessionId: 'x', title: 't', agent: 'codex', machine: 'mac', branch: null, state: 'idle', doing: null, updatedAt: 1, url: 'u' }] }));
        const out = await executeSessionPeerTool('session_peers', { scope: 'project' }, { self, listPeers, projectPeers });
        expect(projectPeers).toHaveBeenCalledWith('s-me');
        expect(listPeers).not.toHaveBeenCalled();
        expect(out).toMatchObject({ scope: 'project', project: { name: 'vh' } });
    });
    it('an old server gives an actionable error instead of a crash', async () => {
        await expect(executeSessionPeerTool('session_peers', { scope: 'project' }, { self, projectPeers: async () => { throw new ProjectsUnsupportedError(); } }))
            .rejects.toThrow(/does not support projects yet; use scope "repo"/);
    });
    it('other scopes are unchanged', async () => {
        const out = await executeSessionPeerTool('session_peers', { scope: 'machine' }, { self, listPeers: async () => [], repoOf: () => ({ root: null, commonDir: null }) as any });
        expect(out).toMatchObject({ scope: 'machine', peers: [] });
    });
});
