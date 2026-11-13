import { describe, expect, it } from 'vitest';
import { registerOwnerBoardTools } from './tools';
import type { LeadBoard } from './leadBoard';

/** B-920: an agent's own owner_board_* tools never post, edit or close an approval card. */
describe('owner_board_* and reserved approval cards', () => {
    function setup() {
        const calls: string[] = [];
        const items = [{ id: 'c1', key: 'settings-change:a' }, { id: 'c2', key: 'main-agent-dispatch:b' }, { id: 'c3', key: 'topic' }, { id: 'c4', key: 'main-agent-tool:0b8c2b5e-1111-4222-8333-944445555666:mcp__chat__send_message' }];
        const board = {
            post: async () => { calls.push('post'); return { id: 'n', created: true }; },
            update: async (input: { id: string }) => { calls.push(`update:${input.id}`); return {}; },
            resolve: async (input: { id: string }) => { calls.push(`resolve:${input.id}`); return {}; },
            list: async () => ({ items }),
        } as unknown as LeadBoard;
        const tools = new Map<string, (args: unknown) => Promise<{ isError: boolean; content: Array<{ text: string }> }>>();
        registerOwnerBoardTools({ registerTool: (name: string, _config: unknown, handler: any) => { tools.set(name, handler); } } as any, board);
        return { calls, tools };
    }

    it('refuses reserved keys and ids, passes the rest', async () => {
        const { calls, tools } = setup();
        const post = await tools.get('owner_board_post')!({ kind: 'decision', title: 't', key: ' Settings-Change:x', request_id: 'req-post-1', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] });
        expect(post.isError).toBe(true);
        expect(post.content[0]!.text).toContain('reserved_card');
        for (const id of ['c1', 'c2', 'c4']) {
            expect((await tools.get('owner_board_update')!({ id, title: 'softer', request_id: 'req-upd-1' })).isError).toBe(true);
            expect((await tools.get('owner_board_resolve')!({ id, outcome: 'done', request_id: 'req-res-1' })).isError).toBe(true);
        }
        expect((await tools.get('owner_board_update')!({ id: 'c3', title: 'ok', request_id: 'req-upd-3' })).isError).toBe(false);
        expect(calls).toEqual(['update:c3']);
    });

    it('B-922: gate-1 tool approval cards (main-agent-tool:) are reserved for posts too', async () => {
        const { calls, tools } = setup();
        for (const key of ['main-agent-tool:x:mcp__chat__send_message', '  MAIN-AGENT-TOOL:x:y']) {
            const post = await tools.get('owner_board_post')!({ kind: 'decision', title: 't', key, request_id: 'req-post-tool', options: [{ id: 'once', label: 'A' }, { id: 'always', label: 'B' }] });
            expect(post.isError, key).toBe(true);
            expect(post.content[0]!.text).toContain('reserved_card');
        }
        expect(calls).toEqual([]);
    });
});
