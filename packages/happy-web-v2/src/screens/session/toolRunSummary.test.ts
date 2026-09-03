import { describe, expect, it } from 'vitest';
import type { ToolCall } from '@/sync/typesMessage';
import { toolRunSummary } from './toolRunSummary';

const tool = (name: string): ToolCall => ({
  name,
  state: 'completed',
  input: {},
  createdAt: 1,
} as ToolCall);

describe('toolRunSummary', () => {
  it('groups equivalent file edits and repeated activity kinds', () => {
    expect(toolRunSummary([
      tool('Read'), tool('Read'), tool('Write'), tool('Edit'), tool('Bash'),
    ])).toBe('Read ×2 · Edit ×2 · Terminal');
  });

  it('keeps MCP names readable and bounds a long overview', () => {
    expect(toolRunSummary([
      tool('Read'), tool('Bash'), tool('WebSearch'), tool('mcp__happy__change_title'), tool('Task'),
    ], 3)).toBe('Read · Terminal · Search · +2');
  });

  it('labels pi tool calls by their piTool identity, not the ACP kind (B-353)', () => {
    const pi = (name: string, input: Record<string, unknown>): ToolCall => ({ ...tool(name), input } as ToolCall);
    expect(toolRunSummary([
      pi('execute', { piTool: 'bash', command: 'ls' }),
      pi('execute', { piTool: 'bash', command: 'pwd' }),
      pi('read', { piTool: 'read', rawInput: { path: 'a' } }),
    ])).toBe('Terminal ×2 · Read');
  });
});
