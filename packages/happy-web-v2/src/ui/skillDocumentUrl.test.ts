import { describe, expect, it } from 'vitest';
import { skillDocumentBody, skillDocumentUrl } from './skillDocumentUrl';

const page = 'https://veryhappy.dev/session/abc';
describe('skill document URLs', () => {
    it('opens bundled same-origin Markdown, including shared absolute links', () => {
        expect(skillDocumentUrl('/skills/provider/SKILL.md?from=help', page)).toBe('https://veryhappy.dev/skills/provider/SKILL.md?from=help');
        expect(skillDocumentUrl('https://veryhappy.dev/skills/todos/SKILL.md', page)).toBe('https://veryhappy.dev/skills/todos/SKILL.md');
    });
    it('resolves relative skill references against the displayed document', () => {
        expect(skillDocumentUrl('references/config.md', page, 'https://veryhappy.dev/skills/provider/SKILL.md')).toBe('https://veryhappy.dev/skills/provider/references/config.md');
        expect(skillDocumentUrl('../todos/SKILL.md', page, 'https://veryhappy.dev/skills/provider/SKILL.md')).toBe('https://veryhappy.dev/skills/todos/SKILL.md');
    });
    it('respects a non-root app base without rewriting the raw asset contract', () => {
        expect(skillDocumentUrl('/skills/provider/SKILL.md', page, page, '/happy.v2/')).toBe('https://veryhappy.dev/happy.v2/skills/provider/SKILL.md');
        expect(skillDocumentUrl('/happy.v2/skills/provider/SKILL.md', page, page, '/happy.v2/')).toBe('https://veryhappy.dev/happy.v2/skills/provider/SKILL.md');
    });
    it.each([undefined, '', '#setup', 'javascript:alert(1)', 'https://elsewhere.dev/skills/provider/SKILL.md', '//elsewhere.dev/skills/provider/SKILL.md', '/skills/provider/../../secret.md', '/skillset/SKILL.md', '/skills/provider/setup.html', '/skills/provider/SKILL.md/not-a-file', 'https://user:password@veryhappy.dev/skills/provider/SKILL.md'])('does not intercept other destinations: %s', href => {
        expect(skillDocumentUrl(href, page)).toBeNull();
    });
});

describe('skill front matter', () => {
    it('omits metadata from the rendered prose while leaving the source untouched', () => {
        const source = '---\nname: provider\ndescription: Configure todos\n---\n\n# Provider\nInstructions';
        expect(skillDocumentBody(source)).toBe('\n# Provider\nInstructions');
        expect(source).toContain('name: provider');
    });
    it('preserves ordinary Markdown and an incomplete metadata block', () => {
        expect(skillDocumentBody('# Skill\n\n---\nNote')).toBe('# Skill\n\n---\nNote');
        expect(skillDocumentBody('---\nname: incomplete')).toBe('---\nname: incomplete');
    });
});
