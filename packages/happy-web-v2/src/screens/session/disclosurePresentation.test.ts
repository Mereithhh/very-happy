import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');

describe('conversation disclosure presentation (B-209)', () => {
  it('uses a quiet focus rail instead of the global glow rectangle', () => {
    const base = read('../../styles/base.css');
    const input = read('./input.css');
    const disclosureRule = base.slice(base.indexOf('.vh-disclosure-trigger:focus-visible'));
    const composerRule = input.slice(input.indexOf('.ci-composer:focus-within'));

    expect(disclosureRule).toContain('box-shadow: inset 0 -2px 0 var(--accent)');
    expect(disclosureRule.slice(0, disclosureRule.indexOf('}'))).not.toContain('accent-glow');
    expect(composerRule).toContain('box-shadow: inset 0 -2px 0 var(--accent)');
    expect(composerRule.slice(0, composerRule.indexOf('}'))).not.toContain('accent-glow');
  });

  it('keeps dense desktop rows but provides a thumb-sized touch target', () => {
    const base = read('../../styles/base.css');
    const coarsePointerRule = base.slice(base.indexOf('@media (pointer: coarse)'));

    expect(coarsePointerRule).toContain('.vh-disclosure-trigger');
    expect(coarsePointerRule).toContain('min-height: 44px');
  });

  it('wires expanded state to controlled content across messages, tools, and code', () => {
    for (const file of ['./MessageView.tsx', './ToolGroupView.tsx', './ToolView.tsx', './CodeView.tsx']) {
      const source = read(file);
      expect(source).toContain('vh-disclosure-trigger');
      expect(source).toContain('aria-controls=');
    }
  });

  it('uses the icon system rather than an emoji for thinking', () => {
    const message = read('./MessageView.tsx');
    expect(message).toContain('<Brain');
    expect(message).not.toContain('💭');
  });
});
