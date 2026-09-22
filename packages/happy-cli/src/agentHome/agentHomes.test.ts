import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

import {
    agentHomeCandidates,
    agentHomeEnv,
    claudeConversationPath,
    codexRolloutFileMatches,
    describeAgentHome,
    expandHomePath,
    findClaudeConversation,
    findCodexThread,
    resolveAgentHomes,
    type ResolveAgentHomesInput,
} from './agentHomes';

const HOME = '/home/wei';

function input(over: Partial<ResolveAgentHomesInput> = {}): ResolveAgentHomesInput {
    return { settings: {}, daemonEnv: {}, loginShellEnv: null, homeDir: HOME, ...over };
}

describe('resolveAgentHomes precedence', () => {
    it('falls back to the provider defaults', () => {
        const homes = resolveAgentHomes(input());
        expect(homes.claudeConfigDir).toEqual({ path: join(HOME, '.claude'), source: 'default' });
        expect(homes.codexHome).toEqual({ path: join(HOME, '.codex'), source: 'default' });
    });

    it('B-478: the login shell beats the daemon env snapshot (the dev-box case)', () => {
        // daemon was started before the user exported the persistent dir
        const homes = resolveAgentHomes(input({
            daemonEnv: { CLAUDE_CONFIG_DIR: '/home/wei/.claude' },
            loginShellEnv: { CLAUDE_CONFIG_DIR: '/mnt/data/.claude' },
        }));
        expect(homes.claudeConfigDir).toEqual({ path: '/mnt/data/.claude', source: 'login-shell' });
    });

    it('keeps a daemon env value when the login shell does not export one (service-manager env)', () => {
        const homes = resolveAgentHomes(input({
            daemonEnv: { CODEX_HOME: '/srv/codex' },
            loginShellEnv: { CODEX_HOME: undefined },
        }));
        expect(homes.codexHome).toEqual({ path: '/srv/codex', source: 'daemon-env' });
    });

    it('settings override everything', () => {
        const homes = resolveAgentHomes(input({
            settings: { claudeConfigDir: '~/persist/claude' },
            daemonEnv: { CLAUDE_CONFIG_DIR: '/a' },
            loginShellEnv: { CLAUDE_CONFIG_DIR: '/b' },
        }));
        expect(homes.claudeConfigDir).toEqual({ path: join(HOME, 'persist/claude'), source: 'settings' });
    });

    it('treats blank values as unset', () => {
        const homes = resolveAgentHomes(input({
            settings: { claudeConfigDir: '   ' },
            daemonEnv: { CLAUDE_CONFIG_DIR: '' },
            loginShellEnv: { CLAUDE_CONFIG_DIR: '' },
        }));
        expect(homes.claudeConfigDir.source).toBe('default');
    });
});

describe('expandHomePath', () => {
    it('expands ~ and resolves relative paths against the home', () => {
        expect(expandHomePath('~', HOME)).toBe(HOME);
        expect(expandHomePath('~/x/y', HOME)).toBe(join(HOME, 'x/y'));
        expect(expandHomePath('rel/dir', HOME)).toBe(join(HOME, 'rel/dir'));
        expect(expandHomePath('/abs', HOME)).toBe('/abs');
    });
});

describe('agentHomeEnv', () => {
    it('sets only non-default choices', () => {
        const homes = resolveAgentHomes(input({ loginShellEnv: { CLAUDE_CONFIG_DIR: '/mnt/data/.claude' } }));
        expect(agentHomeEnv(homes)).toEqual({ CLAUDE_CONFIG_DIR: '/mnt/data/.claude' });
    });
});

describe('agentHomeCandidates', () => {
    it('lists the resolved dir first, then the other sources, then the default, deduplicated', () => {
        const in_ = input({
            settings: { claudeConfigDir: '/s' },
            daemonEnv: { CLAUDE_CONFIG_DIR: '/d' },
            loginShellEnv: { CLAUDE_CONFIG_DIR: '/s' },
        });
        expect(agentHomeCandidates('claude', in_)).toEqual(['/s', '/d', join(HOME, '.claude')]);
    });

    it('is just the default when nothing is configured', () => {
        expect(agentHomeCandidates('codex', input())).toEqual([join(HOME, '.codex')]);
    });
});

describe('findClaudeConversation', () => {
    const id = '0d6f2b6e-1111-4222-8333-444455556666';
    const cwd = '/home/wei/proj';

    it('uses Claude Code path encoding', () => {
        expect(claudeConversationPath('/c', '/home/wei/my.app', id))
            .toBe(join('/c', 'projects', '-home-wei-my-app', `${id}.jsonl`));
    });

    it('reports a hit in the resolved dir as resolved', () => {
        const hit = findClaudeConversation(id, cwd, ['/r', '/other'], p => p.startsWith('/r/') ? 1000 : null);
        expect(hit).toEqual({ home: '/r', file: claudeConversationPath('/r', cwd, id), resolved: true });
    });

    it('finds the conversation in another candidate and flags it for an override', () => {
        const hit = findClaudeConversation(id, cwd, ['/r', '/mnt/data/.claude'], p => p.startsWith('/mnt/') ? 1000 : null);
        expect(hit).toEqual({ home: '/mnt/data/.claude', file: claudeConversationPath('/mnt/data/.claude', cwd, id), resolved: false });
    });

    it('prefers the substantive transcript over a stop-time stub in the resolved dir (2026-09-22)', () => {
        const size = (p: string) => p.startsWith('/r/') ? 285 : (p.startsWith('/mnt/') ? 182_815 : null);
        const hit = findClaudeConversation(id, cwd, ['/r', '/mnt/data/.claude'], size);
        expect(hit).toEqual({ home: '/mnt/data/.claude', file: claudeConversationPath('/mnt/data/.claude', cwd, id), resolved: false });
    });

    it('keeps the earlier candidate on a size tie', () => {
        const hit = findClaudeConversation(id, cwd, ['/r', '/mnt/data/.claude'], () => 500);
        expect(hit?.home).toBe('/r');
    });

    it('returns null when absent everywhere', () => {
        expect(findClaudeConversation(id, cwd, ['/r', '/x'], () => null)).toBeNull();
    });
});

describe('findCodexThread', () => {
    const thread = '019a9707-033d-78c2-b446-cb1fe099309f';
    const file = `rollout-2025-11-18T20-53-30-${thread}.jsonl`;

    it('matches rollout file names by thread id suffix', () => {
        expect(codexRolloutFileMatches(file, thread)).toBe(true);
        expect(codexRolloutFileMatches(`rollout-x-${thread}.jsonl.bak`, thread)).toBe(false);
        expect(codexRolloutFileMatches(file, 'other')).toBe(false);
    });

    it('walks only YYYY/MM/DD and returns the home that holds the thread', () => {
        const tree: Record<string, string[]> = {
            '/r/sessions': ['2025', 'junk'],
            '/r/sessions/2025': ['11'],
            '/r/sessions/2025/11': ['18'],
            '/r/sessions/2025/11/18': ['rollout-2025-11-18T00-00-00-other.jsonl'],
            '/mnt/codex/sessions': ['2025'],
            '/mnt/codex/sessions/2025': ['11'],
            '/mnt/codex/sessions/2025/11': ['18'],
            '/mnt/codex/sessions/2025/11/18': [file],
        };
        const visited: string[] = [];
        const listDir = (p: string) => { visited.push(p); return tree[p] ?? []; };
        const hit = findCodexThread(thread, ['/r', '/mnt/codex'], listDir);
        expect(hit).toEqual({ home: '/mnt/codex', file: join('/mnt/codex/sessions/2025/11/18', file), resolved: false });
        expect(visited).not.toContain('/r/sessions/junk');
    });

    it('returns null when no candidate has it', () => {
        expect(findCodexThread(thread, ['/r'], () => [])).toBeNull();
    });
});

describe('describeAgentHome', () => {
    it('names the source', () => {
        expect(describeAgentHome({ path: '/x', source: 'login-shell' })).toBe('/x (login shell)');
    });
});
