import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const css = (path: string) => '\n' + readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (source: string, selector: string) => source.split('\n' + selector + ' {').slice(1).map(block => block.split('}')[0]).join('\n');
describe('workspace typography contract', () => {
  it('shares the desktop primary baseline with a separate mobile conversation size', () => {
    const tokens = css('./tokens.css');
    expect(tokens).toContain('--workspace-primary-size: var(--fs-14);');
    expect(tokens).toContain('--conversation-size: var(--fs-14);');
    expect(tokens).toContain('--conversation-leading: 1.6;');
    expect(tokens).toMatch(/@media \(pointer: coarse\), \(max-width: 860px\)\s*\{\s*:root \{ --conversation-size: var\(--fs-15\); \}/);
  });
  it('uses the same body scale for both message roles', () => {
    const messages = css('../screens/session/message.css');
    for (const selector of ['.msg-bubble', '.msg-agent-text']) {
      expect(rule(messages, selector)).toContain('font-size: var(--conversation-size);');
      expect(rule(messages, selector)).toContain('line-height: var(--conversation-leading);');
    }
    expect(rule(messages, '.msg-agent-text')).toContain('--markdown-gap: var(--sp-3);');
    expect(rule(messages, '.msg-agent-text')).toContain('--markdown-list-gap: var(--sp-1);');
  });
  it('keeps compact markdown scoped to the conversation and primary sidebar labels aligned', () => {
    expect(rule(css('../screens/session/markdown.css'), '.md')).toContain('line-height: var(--markdown-leading, 1.7);');
    expect(rule(css('../screens/sessions/sidebar.css'), '.sb-row-title')).toContain('font-size: var(--workspace-primary-size);');
    expect(rule(css('../screens/session/input.css'), '.ci-textarea')).toContain('font-size: var(--workspace-primary-size);');
  });
});
