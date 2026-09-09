import { describe, expect, it } from 'vitest';
import { sessionAgentLabel } from './sessionAgentLabel';
describe('reported agent identity', () => {
    it.each([[undefined,'未知'],[null,'未知'],['  ','未知'],['claude','Claude Code'],['codex','Codex'],['pi-acp','Pi'],['terminal-mirror','Terminal'],['custom-runner','custom-runner']])('reports %s as %s', (flavor, label) => {
        expect(sessionAgentLabel(flavor, '未知')).toBe(label);
    });
});
