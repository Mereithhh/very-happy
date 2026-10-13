import { describe, expect, it } from 'vitest';
import type { Message, ToolCall } from '@/sync/typesMessage';
import { buildChatRows } from './chatTurns';
import {
    countLines,
    countReplacement,
    countUnifiedDiff,
    displayPath,
    toolFileEdits,
    turnDiffSummary,
    unifiedDiffRender,
    writtenPathsOf,
    EDIT_DIFF_MAX_CELLS,
} from './turnDiffs';

let n = 0;
const call = (name: string, input: unknown, extra: Partial<ToolCall> = {}): ToolCall => ({
    name, input, state: 'completed', createdAt: 10, startedAt: 10, completedAt: 20, description: null, ...extra,
});
const msg = (tool: ToolCall, children: Message[] = []): Message => ({
    kind: 'tool-call', id: `t${++n}`, localId: null, createdAt: tool.createdAt, tool, children,
});
const user = (id: string, createdAt: number): Message => ({ kind: 'user-text', id, localId: null, createdAt, text: id });
const answer = (id: string, createdAt: number): Message => ({ kind: 'agent-text', id, localId: null, createdAt, text: 'done' });

describe('line counting helpers', () => {
    it('counts file lines without a phantom trailing line', () => {
        expect(countLines('')).toBe(0);
        expect(countLines('a')).toBe(1);
        expect(countLines('a\nb\n')).toBe(2);
    });
    it('counts a replacement after trimming shared lines', () => {
        expect(countReplacement('a\nb\nc', 'a\nB\nc')).toEqual({ added: 1, removed: 1 });
        expect(countReplacement('a', 'a\nb\nc')).toEqual({ added: 2, removed: 0 });
        expect(countReplacement('x\ny', '')).toEqual({ added: 0, removed: 2 });
    });
    it('reports unknown instead of running a huge LCS', () => {
        const side = Math.ceil(Math.sqrt(EDIT_DIFF_MAX_CELLS)) + 2;
        const a = Array.from({ length: side }, (_, i) => `a${i}`).join('\n');
        const b = Array.from({ length: side }, (_, i) => `b${i}`).join('\n');
        expect(countReplacement(a, b)).toBeNull();
    });
    it('counts unified diff hunk lines, not file headers', () => {
        const diff = '--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new\n ctx\n@@ -9 +9,2 @@\n+more\n ctx';
        expect(countUnifiedDiff(diff)).toEqual({ added: 2, removed: 1 });
        expect(unifiedDiffRender(diff)).toEqual({ oldText: 'old\nctx\n⋯\nctx', newText: 'new\nctx\n⋯\nmore\nctx' });
    });
});

describe('toolFileEdits — Claude', () => {
    it('Edit: line diff of old/new strings', () => {
        const [e] = toolFileEdits(call('Edit', { file_path: '/r/a.ts', old_string: 'a\nb', new_string: 'a\nc\nd' }));
        expect(e).toMatchObject({ path: '/r/a.ts', added: 2, removed: 1 });
        expect(e.renders).toEqual([{ oldText: 'a\nb', newText: 'a\nc\nd' }]);
    });
    it('Edit: structuredPatch from toolUseResult wins (exact, incl. replace_all)', () => {
        const result = { structuredPatch: [{ lines: [' a', '-b', '+c', '+c2'] }, { lines: ['-z'] }] };
        const [e] = toolFileEdits(call('Edit', { file_path: '/r/a.ts', old_string: 'b', new_string: 'c', replace_all: true }, { result }));
        expect(e).toMatchObject({ added: 2, removed: 2 });
    });
    it('Edit: replace_all without a patch is unknown, never a guessed number', () => {
        const [e] = toolFileEdits(call('Edit', { file_path: '/r/a.ts', old_string: 'b', new_string: 'c', replace_all: true }));
        expect(e).toMatchObject({ added: null, removed: null });
    });
    it('MultiEdit sums its edits; one unknown makes the file unknown', () => {
        const ok = toolFileEdits(call('MultiEdit', { file_path: '/r/m.ts', edits: [
            { old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'c\nd' },
        ] }))[0];
        expect(ok).toMatchObject({ added: 2, removed: 1 });
        expect(ok.renders).toHaveLength(2);
        const unknown = toolFileEdits(call('MultiEdit', { file_path: '/r/m.ts', edits: [
            { old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd', replace_all: true },
        ] }))[0];
        expect(unknown).toMatchObject({ added: null, removed: null });
    });
    it('Write: only the runner result says "created" — then all lines are added', () => {
        expect(toolFileEdits(call('Write', { file_path: '/r/new.md', content: 'a\nb\nc\n' }, { result: { type: 'create' } }))[0])
            .toMatchObject({ added: 3, removed: 0, renders: [{ oldText: '', newText: 'a\nb\nc\n' }] });
    });
    it('Write without a result type (pi, session-protocol channel) is 「已改」, not a guessed new file (review 低1)', () => {
        expect(toolFileEdits(call('Write', { file_path: '/r/x.md', content: 'a\nb' }))[0]).toMatchObject({ added: null, removed: null, renders: [] });
    });
    it('Write update: numbers and the expanded diff both come from structuredPatch (review 低2)', () => {
        const result = { type: 'update', structuredPatch: [{ lines: [' keep', '-a', '+x'] }, { lines: ['+tail'] }] };
        expect(toolFileEdits(call('Write', { file_path: '/r/n.md', content: 'whole new file' }, { result }))[0])
            .toEqual({ path: '/r/n.md', added: 2, removed: 1, renders: [{ oldText: 'keep\na\n⋯', newText: 'keep\nx\n⋯\ntail' }] });
        // update without a patch → unknown, no misleading all-added render
        expect(toolFileEdits(call('Write', { file_path: '/r/n.md', content: 'x' }, { result: { type: 'update' } }))[0])
            .toMatchObject({ added: null, renders: [] });
    });
    it('Edit with structuredPatch renders the patch, matching its counts', () => {
        const result = { structuredPatch: [{ lines: ['-b', '+c'] }, { lines: ['-b', '+c'] }] };
        const [e] = toolFileEdits(call('Edit', { file_path: '/r/a.ts', old_string: 'b', new_string: 'c', replace_all: true }, { result }));
        expect(e).toMatchObject({ added: 2, removed: 2, renders: [{ oldText: 'b\n⋯\nb', newText: 'c\n⋯\nc' }] });
    });
    it('NotebookEdit is unknown; failed / running / denied edits count nothing', () => {
        expect(toolFileEdits(call('NotebookEdit', { notebook_path: '/r/n.ipynb' }))[0]).toMatchObject({ path: '/r/n.ipynb', added: null });
        expect(toolFileEdits(call('Edit', { file_path: '/r/a', old_string: 'a', new_string: 'b' }, { state: 'error' }))).toEqual([]);
        expect(toolFileEdits(call('Write', { file_path: '/r/a', content: 'b' }, { state: 'running' }))).toEqual([]);
        expect(toolFileEdits(call('Read', { file_path: '/r/a' }))).toEqual([]);
    });
});

describe('toolFileEdits — Codex', () => {
    it('app-server shape: kind.type + diff, add, delete, move_path', () => {
        const edits = toolFileEdits(call('CodexPatch', { changes: {
            '/r/u.ts': { kind: { type: 'update', move_path: null }, diff: '@@ -1 +1,2 @@\n-a\n+b\n+c' },
            '/r/add.ts': { kind: { type: 'add' }, add: { content: 'x\ny\n' } },
            '/r/gone.ts': { kind: { type: 'delete' }, delete: { content: 'p\nq\nr' } },
            '/r/old.ts': { kind: { type: 'update', move_path: '/r/moved.ts' }, diff: '@@ -1 +1 @@\n-a\n+b' },
        } }));
        expect(edits.map((e) => [e.path, e.added, e.removed])).toEqual([
            ['/r/u.ts', 2, 1], ['/r/add.ts', 2, 0], ['/r/gone.ts', 0, 3], ['/r/moved.ts', 1, 1],
        ]);
    });
    it('legacy MCP shape: update.unified_diff / modify / unknown', () => {
        const edits = toolFileEdits(call('CodexPatch', { changes: {
            'a.ts': { update: { unified_diff: '@@ -1 +1 @@\n-x\n+y', move_path: null } },
            'b.ts': { modify: { old_content: 'a\nb', new_content: 'a\nc' } },
            'c.ts': {},
        } }));
        expect(edits.map((e) => [e.path, e.added, e.removed])).toEqual([['a.ts', 1, 1], ['b.ts', 1, 1], ['c.ts', null, null]]);
    });
});

describe('toolFileEdits — pi (ACP, mapped to Claude shapes)', () => {
    it('edit with one or several edits, and write', () => {
        const one = call('edit', { piTool: 'edit', rawInput: { path: 'src/a.ts', edits: [{ oldText: 'a', newText: 'b\nc' }] } });
        expect(toolFileEdits(one)[0]).toMatchObject({ path: 'src/a.ts', added: 2, removed: 1 });
        const many = call('edit', { piTool: 'edit', rawInput: { path: 'src/a.ts', edits: [{ oldText: 'a', newText: 'b' }, { oldText: 'c', newText: 'd' }] } });
        expect(toolFileEdits(many)[0]).toMatchObject({ added: 2, removed: 2 });
        const write = call('edit', { piTool: 'write', rawInput: { path: 'notes.md', content: 'x\ny' } });
        expect(toolFileEdits(write)[0]).toMatchObject({ path: 'notes.md', added: null, removed: null });
        expect(writtenPathsOf(write)).toEqual(['notes.md']);
    });
});

describe('turnDiffSummary', () => {
    it('aggregates by path in first-change order, sums, and flags partial totals', () => {
        const diff = turnDiffSummary([
            msg(call('Edit', { file_path: '/r/a.ts', old_string: 'a', new_string: 'b' })),
            msg(call('Read', { file_path: '/r/z.ts' })),
            msg(call('Edit', { file_path: '/r/./a.ts', old_string: 'c', new_string: 'c\nd' })),
            msg(call('NotebookEdit', { notebook_path: '/r/n.ipynb' })),
        ])!;
        expect(diff.files.map((f) => [f.path, f.added, f.removed, f.edits])).toEqual([['/r/a.ts', 2, 1, 2], ['/r/n.ipynb', null, null, 1]]);
        expect(diff).toMatchObject({ added: 2, removed: 1, partial: true });
    });
    it('attributes sub-agent edits (Task/Agent children) to the turn holding the card', () => {
        const sub = msg(call('Agent', { prompt: 'p' }), [msg(call('Write', { file_path: '/r/sub.ts', content: 'a' }))]);
        expect(turnDiffSummary([sub])!.files.map((f) => f.path)).toEqual(['/r/sub.ts']);
    });
    it('null when nothing was written', () => {
        expect(turnDiffSummary([msg(call('Read', { file_path: '/r/x' }))])).toBeNull();
    });
});

describe('buildChatRows turn-diff rows (B-571)', () => {
    const turn = () => [
        user('u1', 1),
        msg(call('Edit', { file_path: '/r/a.ts', old_string: 'a', new_string: 'b' }, { createdAt: 2 })),
        answer('a1', 3),
        user('u2', 4),
        msg(call('Write', { file_path: '/r/a.ts', content: 'x' }, { createdAt: 5 })),
        answer('a2', 6),
    ];
    it('is off by default (existing callers unchanged)', () => {
        expect(buildChatRows(turn(), false).some((r) => r.type === 'turn-diff')).toBe(false);
    });
    it('ends each finished turn with its rollup', () => {
        const rows = buildChatRows(turn(), false, { turnDiffs: true });
        const diffs = rows.filter((r) => r.type === 'turn-diff');
        expect(diffs.map((r) => r.key)).toEqual(['turndiff-u1', 'turndiff-u2']);
        expect(rows[rows.indexOf(diffs[0]) - 1]).toMatchObject({ type: 'message', message: { id: 'a1' } });
        expect(diffs[1].type === 'turn-diff' && diffs[1].diff.files[0].added).toBeNull();
    });
    it('the live turn has no rollup yet', () => {
        const rows = buildChatRows(turn(), true, { turnDiffs: true });
        expect(rows.filter((r) => r.type === 'turn-diff').map((r) => r.key)).toEqual(['turndiff-u1']);
    });
});

describe('displayPath', () => {
    it('shows paths under the cwd relative to it', () => {
        expect(displayPath('/r/src/a.ts', '/r')).toBe('src/a.ts');
        expect(displayPath('/other/a.ts', '/r')).toBe('/other/a.ts');
        expect(displayPath('./src/a.ts', null)).toBe('src/a.ts');
    });
});
