import { beforeAll, describe, expect, it } from 'vitest';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';
import type { LeafRow } from './chatTurns';

let stackToolRows: typeof import('./ActivityMessages').stackToolRows;
beforeAll(async () => { installBrowserTestGlobals(); ({ stackToolRows } = await import('./ActivityMessages')); });

const tool = (key: string) => ({ type: 'toolgroup', key, tools: [] }) as unknown as LeafRow;
const text = (key: string) => ({ type: 'message', key, message: { kind: 'agent-text' } }) as unknown as LeafRow;

/** B-614: a turn's consecutive tool rows render inside ONE card; order is never changed. */
describe('activity tool stacks (B-614)', () => {
    it('groups only consecutive tool rows and keeps every row in order', () => {
        const blocks = stackToolRows([text('a'), tool('t1'), tool('t2'), text('b'), tool('t3')]);
        expect(blocks.map(b => b.kind === 'stack' ? b.groups.map(g => g.key).join('+') : b.row.key)).toEqual(['a', 't1+t2', 'b', 't3']);
        expect(blocks.filter(b => b.kind === 'stack').map(b => b.key)).toEqual(['stack-t1', 'stack-t3']);
    });
    it('returns no stack when there are no tools', () => {
        expect(stackToolRows([text('a')])).toEqual([{ kind: 'row', row: text('a') }]);
    });
});
