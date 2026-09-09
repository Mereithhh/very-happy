import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUILTIN_TODO_SKILL } from './builtinTodoSkill';
describe('official Todo skill publication', () => {
  it('publishes the same document that the CLI and Web copy', () => {
    expect(readFileSync(new URL('../../happy-web-v2/public/skills/very-happy-todos/SKILL.md', import.meta.url), 'utf8')).toBe(BUILTIN_TODO_SKILL);
  });
});
