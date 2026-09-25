import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { piSessionNameFromTitle, TERMINAL_TITLE_SUGGEST_METHOD, TerminalTitleSuggestRequestSchema } from './terminalTitleSuggest';

describe('piSessionNameFromTitle (B-500)', () => {
    it('reads the name out of pi\'s `<app> - <name> - <cwd basename>` title only', () => {
        expect(piSessionNameFromTitle('π - Fix auth - repo', '/x/repo')).toBe('Fix auth');
        expect(piSessionNameFromTitle('pi - Fix auth - repo', '/x/repo/')).toBe('Fix auth');
        expect(piSessionNameFromTitle('π - one - two - repo', '/x/repo')).toBe('one - two');
        expect(piSessionNameFromTitle('π - repo', '/x/repo')).toBeUndefined();     // unnamed
        expect(piSessionNameFromTitle('π - Fix auth - other', '/x/repo')).toBeUndefined(); // not this pane's cwd
        expect(piSessionNameFromTitle('π - Fix auth - repo', undefined)).toBeUndefined();
        expect(piSessionNameFromTitle('π -  - repo', '/x/repo')).toBeUndefined();  // empty name
        expect(piSessionNameFromTitle('Fix auth - repo', '/x/repo')).toBeUndefined(); // no pi prefix
        expect(piSessionNameFromTitle('π - Fix auth - repo', 'C:\\x\\repo')).toBe('Fix auth');
    });

    it('is a custom JSON-RPC method, never an MCP tool, on both terminal bridges', () => {
        // The model must not see it (B-493: a forced change_title turn is paid
        // for on every session); the pi extension calls it directly.
        expect(TERMINAL_TITLE_SUGGEST_METHOD.startsWith('very-happy/')).toBe(true);
        expect(TerminalTitleSuggestRequestSchema.parse({ method: TERMINAL_TITLE_SUGGEST_METHOD, params: { prompt: 'x' } }).params.prompt).toBe('x');
        const mcp = readFileSync(join(__dirname, '../commands/mcp.ts'), 'utf8');
        expect(mcp).toContain('server.server.setRequestHandler(TerminalTitleSuggestRequestSchema');
        expect(mcp).toContain('if (terminalId) registerTerminalTitleSuggest(server);');
        expect(readFileSync(join(__dirname, '../commands/piTerminal.ts'), 'utf8')).toContain('registerTerminalTitleSuggest(mcp);');
        // Both pi extensions arm on session_start and fire on the first prompt only.
        const native = readFileSync(join(__dirname, '../piExtension.ts'), 'utf8');
        expect(native).toContain("titleArmed = !!pi.setSessionName && !pi.getSessionName?.();");
        expect(native).toContain('if (result.title && expected === generation && !stopped && !pi.getSessionName?.()) pi.setSessionName!(result.title);');
        // The daemon's pane-title follow and the assistant's terminal list both
        // hand deriveAutoTitle the pane cwd: without it the named form cannot be told apart.
        const wt = readFileSync(join(__dirname, 'webTerminal.ts'), 'utf8');
        expect(wt).toContain('const auto = deriveAutoTitle(s.paneTitle, hostname, s.cwd);');
        expect(wt).toContain('created.direct.title = deriveAutoTitle(title, os.hostname(), created.direct.cwd);');
        expect(readFileSync(join(__dirname, '../assistant/terminals.ts'), 'utf8')).toContain('deriveAutoTitle(s.paneTitle, hostname, s.cwd)');
        const launcher = readFileSync(join(__dirname, '../teams/resources.ts'), 'utf8');
        expect(launcher).toContain("rpc('very-happy/terminal-title-suggest', {prompt})");
        expect(launcher).toContain('if (!managed && pi.setSessionName) {');
    });
});
