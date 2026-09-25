import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { automationsGettingStartedCopy } from './automationsGettingStartedCopy';

describe('Automations onboarding copy', () => {
  it('describes only shipped paths, in both languages, with the same shape', () => {
    const en = automationsGettingStartedCopy('en');
    const zh = automationsGettingStartedCopy('zh-Hans');
    expect(Object.keys(zh)).toEqual(Object.keys(en));
    expect(en.steps).toHaveLength(3);
    expect(zh.steps).toHaveLength(3);
    // the three real creation paths, never "install a skill first"
    expect(en.createCli).toContain('very-happy auto create');
    expect(zh.createCli).toContain('very-happy auto create');
    expect(en.createSession).toContain('automation_create');
    expect(zh.createSession).toContain('automation_create');
    // the only event entry point is fire (no inbound webhook)
    expect(en.triggerNote).toContain('very-happy auto fire');
    expect(en.triggerNote).toContain('automation_fire');
    expect(zh.triggerNote).toContain('very-happy auto fire');
    expect(zh.triggerNote).toContain('automation_fire');
    expect(en.triggerNote).not.toMatch(/webhook/i);
    // gate and single-machine boundary stay explicit
    expect(en.gate).toContain('VH_AUTOMATIONS_ENABLED');
    expect(zh.gate).toContain('VH_AUTOMATIONS_ENABLED');
    expect(en.limit).toContain('no automatic cross-machine');
    expect(zh.limit).toContain('不会自动跨机器');
  });

  it('is mounted on both first-run and help, after Teams', () => {
    for (const file of ['FirstRunScreen.tsx', '../help/HelpScreen.tsx']) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      expect(source).toMatch(/<TeamGettingStarted \/>\s*<AutomationsGettingStarted \/>/);
    }
  });
});
