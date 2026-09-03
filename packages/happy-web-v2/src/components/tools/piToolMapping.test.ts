import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ToolCall } from '@/sync/typesMessage';
import { mapPiToolToKnown, normalizePiToolCall } from './piToolMapping';

const base = (input: any): ToolCall => ({
    name: 'execute', state: 'completed', input, createdAt: 1, startedAt: 1, completedAt: 2, description: null,
});

describe('mapPiToolToKnown', () => {
    it('bash: command from args.command (title) or rawInput.command', () => {
        expect(mapPiToolToKnown({ piTool: 'bash', command: 'echo probe' })).toEqual({ name: 'Bash', input: { command: 'echo probe' } });
        expect(mapPiToolToKnown({ piTool: 'bash', rawInput: { command: 'ls', timeout: 5 } })).toEqual({ name: 'Bash', input: { command: 'ls', timeout: 5 } });
        expect(mapPiToolToKnown({ piTool: 'bash' })).toBeNull();
    });

    it('read/edit/write map pi arg names onto the Claude shape', () => {
        expect(mapPiToolToKnown({ piTool: 'read', rawInput: { path: '/a.ts', limit: 10, offset: 2 } }))
            .toEqual({ name: 'Read', input: { file_path: '/a.ts', limit: 10, offset: 2 } });
        expect(mapPiToolToKnown({ piTool: 'edit', rawInput: { path: '/a.ts', oldText: 'x', newText: 'y' } }))
            .toEqual({ name: 'Edit', input: { file_path: '/a.ts', old_string: 'x', new_string: 'y' } });
        expect(mapPiToolToKnown({ piTool: 'write', rawInput: { path: '/a.ts', content: '' } }))
            .toEqual({ name: 'Write', input: { file_path: '/a.ts', content: '' } });
    });

    it('grep/find/ls map when the shape fits, otherwise null', () => {
        expect(mapPiToolToKnown({ piTool: 'grep', rawInput: { pattern: 'foo', path: 'src' } })).toEqual({ name: 'Grep', input: { pattern: 'foo', path: 'src' } });
        expect(mapPiToolToKnown({ piTool: 'find', rawInput: { pattern: '**/*.ts' } })).toEqual({ name: 'Glob', input: { pattern: '**/*.ts' } });
        expect(mapPiToolToKnown({ piTool: 'ls', rawInput: { path: '.' } })).toEqual({ name: 'LS', input: { path: '.' } });
        expect(mapPiToolToKnown({ piTool: 'grep', rawInput: {} })).toBeNull();
    });

    it('shape mismatch / unknown / missing piTool → null', () => {
        expect(mapPiToolToKnown({ piTool: 'edit', rawInput: { path: '/a' } })).toBeNull();
        expect(mapPiToolToKnown({ piTool: 'session_spawn', rawInput: { prompt: 'x' } })).toBeNull();
        expect(mapPiToolToKnown({ rawInput: { path: '/a' } })).toBeNull();
        expect(mapPiToolToKnown(null)).toBeNull();
        expect(mapPiToolToKnown({ piTool: 'read', rawInput: 'not an object' })).toBeNull();
    });
});

describe('normalizePiToolCall', () => {
    it('returns the same object when there is no piTool (old CLI / Claude sessions)', () => {
        const tool = base({ command: 'ls' });
        expect(normalizePiToolCall(tool)).toBe(tool);
        const claude = { ...base({ command: 'ls' }), name: 'Bash' };
        expect(normalizePiToolCall(claude)).toBe(claude);
    });

    it('rewrites name + input for mapped tools, keeping state/result', () => {
        const tool = { ...base({ piTool: 'bash', acpKind: 'execute', acpTitle: 'echo hi', command: 'echo hi' }), result: { stdout: 'hi' } };
        const out = normalizePiToolCall(tool);
        expect(out.name).toBe('Bash');
        expect(out.input).toEqual({ command: 'echo hi' });
        expect(out.result).toEqual({ stdout: 'hi' });
        expect(tool.name).toBe('execute');
    });

    it('bridge tools are renamed to their piTool with rawInput as input', () => {
        const out = normalizePiToolCall({ ...base({ piTool: 'session_spawn', acpKind: 'other', rawInput: { prompt: 'go' } }), name: 'other' });
        expect(out.name).toBe('session_spawn');
        expect(out.input).toEqual({ prompt: 'go' });
    });

    it('unknown piTool stays untouched', () => {
        const tool = { ...base({ piTool: 'weird_tool', rawInput: { a: 1 } }), name: 'other' };
        expect(normalizePiToolCall(tool)).toBe(tool);
    });
});

// Source assertions: every consumer that keys on tool identity must go through normalizePiToolCall,
// otherwise a pi session reads "Execute ×2 · Other" in one place and "Terminal" in another.
describe('normalizePiToolCall wiring', () => {
    const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

    it('is applied at the row, the group summary, the file-path whitelist and the hidden check', () => {
        expect(src('../../screens/session/ToolGroupView.tsx')).toContain('const tool = normalizePiToolCall(rawMessage.tool);');
        expect(src('../../screens/session/toolRunSummary.ts')).toContain('const tool = normalizePiToolCall(rawTool);');
        expect(src('../../screens/session/toolFilePath.ts')).toContain('const tool = normalizePiToolCall(rawTool);');
        expect(src('../../screens/session/toolVisibility.ts')).toContain('isHiddenToolName(normalizePiToolCall(tool).name)');
        expect(src('../../screens/session/ChatList.tsx')).toContain('!isHiddenToolCall(message.tool)');
    });
});
