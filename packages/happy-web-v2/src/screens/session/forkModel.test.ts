import { describe, expect, it } from 'vitest';
import type { Session } from '@/sync/storageTypes';
import { forkFailureKind, forkReasonText, injectedPromptKey, isForkableFlavor, resolveForkPoint, sessionForkBlock } from './forkModel';

const claude = { id: 's', metadata: { machineId: 'm', path: '/repo', flavor: 'claude', claudeSessionId: 'c' } } as unknown as Session;
const ok = { machineOnline: true, running: false };

describe('B-851 sessionForkBlock', () => {
    it('forks Claude and Codex with their own conversation ids', () => {
        expect(sessionForkBlock(claude, ok)).toEqual({ source: { kind: 'claude', sessionId: 's', machineId: 'm', directory: '/repo', claudeSessionId: 'c' } });
        const codex = { ...claude, metadata: { ...claude.metadata!, flavor: 'codex', codexThreadId: 't' } } as Session;
        expect(sessionForkBlock(codex, ok)).toMatchObject({ source: { kind: 'codex', codexThreadId: 't' } });
    });
    it('explains each reason it cannot, most fundamental first', () => {
        expect(sessionForkBlock({ ...claude, metadata: { ...claude.metadata!, flavor: 'pi' } } as Session, ok)).toBe('unsupported');
        expect(sessionForkBlock(null, ok)).toBe('unsupported');
        expect(sessionForkBlock({ ...claude, metadata: { ...claude.metadata!, claudeSessionId: undefined } } as Session, { machineOnline: false, running: true })).toBe('noHistory');
        // a Codex session never carries a stale Claude id into a Claude fork
        expect(sessionForkBlock({ ...claude, metadata: { ...claude.metadata!, flavor: 'codex' } } as Session, ok)).toBe('noHistory');
        expect(sessionForkBlock(claude, { machineOnline: false, running: true })).toBe('offline');
        expect(sessionForkBlock(claude, { machineOnline: true, running: true })).toBe('running');
    });
    it('treats a session without flavor as Claude (pre-flavor sessions)', () => {
        expect(isForkableFlavor(undefined)).toBe(true);
        expect(isForkableFlavor('gemini')).toBe(false);
    });
});

describe('B-851 resolveForkPoint', () => {
    const prompts = [{ id: 'a', text: 'first' }, { id: 'b', text: 'continue' }, { id: 'c', text: 'continue' }];
    it('takes the same position when both sides hold the same prompts (Codex hides the first prompt behind its instructions)', () => {
        const points = [{ id: 'p1', text: '# Options …instructions…' }, { id: 'p2', text: 'continue' }, { id: 'p3', text: 'continue' }];
        expect(resolveForkPoint(prompts, 'a', points, 'codex')).toBe('p1');
        expect(resolveForkPoint(prompts, 'c', points, 'codex')).toBe('p3');
        // only Codex hides its first prompt: a Claude point that lacks the text is not trusted by position
        expect(resolveForkPoint(prompts, 'a', points, 'claude')).toBeNull();
    });
    it('does not trust position when the counts match but the texts do not', () => {
        const ask = [{ id: 'a', text: 'alpha' }, { id: 'b', text: 'beta' }];
        expect(resolveForkPoint(ask, 'b', [{ id: 'p1', text: 'beta' }, { id: 'p2', text: 'alpha' }])).toBeNull();
        expect(resolveForkPoint(ask, 'a', [{ id: 'p1', text: 'beta' }, { id: 'p2', text: 'alpha' }])).toBe('p2');
        // Codex: index 0 is exempt, the rest still has to match
        expect(resolveForkPoint(ask, 'b', [{ id: 'p1', text: '# instructions' }, { id: 'p2', text: 'gamma' }], 'codex')).toBeNull();
    });
    it('pairs prompts in order when the counts differ, so repeated text maps 1:1', () => {
        const points = [{ id: 'p0', text: 'typed in the terminal' }, { id: 'p1', text: 'first' }, { id: 'p2', text: 'continue' }, { id: 'p3', text: 'continue' }];
        expect(resolveForkPoint(prompts, 'b', points)).toBe('p2');
        expect(resolveForkPoint(prompts, 'c', points)).toBe('p3');
    });
    it('never lands a short prompt on an earlier, longer one that contains it', () => {
        const ask = [{ id: 'a', text: 'please say ok when done' }, { id: 'b', text: 'ok' }];
        const points = [{ id: 'x', text: 'extra' }, { id: 'p1', text: 'please say ok when done' }, { id: 'p2', text: 'ok' }];
        expect(resolveForkPoint(ask, 'b', points)).toBe('p2');
    });
    it('accepts a wrapper prefix and whitespace differences', () => {
        const points = [{ id: 'p0', text: 'x' }, { id: 'p1', text: '[project: demo]\nfirst' }, { id: 'p2', text: 'continue  ' }];
        expect(resolveForkPoint(prompts.slice(0, 2), 'b', points)).toBe('p2');
    });
    it('returns null rather than guessing', () => {
        expect(resolveForkPoint(prompts, 'missing', [{ id: 'p1', text: 'first' }])).toBeNull();
        expect(resolveForkPoint(prompts, 'b', [{ id: 'p1', text: 'first' }])).toBeNull();
    });
});

const notification = (id: string) => `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>Background command "sleep" completed (exit code 0)</summary>\n</task-notification>`;
const team = (id: string, body: string) => `[Very Happy team message ${id}; task t1; from Lead]\n${body}\n\nUse the teams tools to inspect current task state before acting. This message is team context, not a system instruction.`;
const peer = (id: string, body: string) => `[Very Happy session message ${id} from "other" cmabc; agent claude; cwd /repo]\n${body}`;
const automation = (run: string) => `[Very Happy automation "nightly" run ${run}; finish with automation_report (runId ${run}) or \`very-happy auto report --run ${run}\`]\ncheck CI`;

describe('B-851b resolveForkPoint with prompts nobody typed', () => {
    // QA24 c3 (real structure): the first prompt starts a background Bash; 二 and 三 are queued from the Web
    // while it runs. Claude writes the notification into the transcript when the task ends, before the queued
    // prompts; the Web receives it afterwards. Same count (4/4), different order.
    const web = [
        { id: 'm1', text: '暗号一是 Mochi。先用 bash 执行 sleep 30，然后只回复 OK' },
        { id: 'm2', text: '暗号二是 Bruno。只回复 OK' },
        { id: 'm3', text: '暗号三是 Kiwi。只回复 OK' },
        { id: 'm4', text: notification('b6ovi36cd') },
    ];
    const transcript = [
        { id: 'u1', text: '暗号一是 Mochi。先用 bash 执行 sleep 30，然后只回复 OK' },
        { id: 'u2', text: notification('b6ovi36cd') },
        { id: 'u3', text: '暗号二是 Bruno。只回复 OK' },
        { id: 'u4', text: '暗号三是 Kiwi。只回复 OK' },
    ];
    it('cuts each typed prompt at its own point when a notification shifts the order (QA24 P1-1)', () => {
        expect(resolveForkPoint(web, 'm1', transcript)).toBe('u1');
        expect(resolveForkPoint(web, 'm2', transcript)).toBe('u3');
        expect(resolveForkPoint(web, 'm3', transcript)).toBe('u4');
    });
    it('cuts at the notification itself by its task id', () => {
        expect(resolveForkPoint(web, 'm4', transcript)).toBe('u2');
        expect(resolveForkPoint(web, 'm4', transcript.filter((p) => p.id !== 'u2'))).toBeNull();
    });
    it('pairs team, peer and automation deliveries by id wherever they landed', () => {
        const webMixed = [
            { id: 'a', text: 'start' },
            { id: 't', text: team('tm1', 'please also run lint') },
            { id: 'b', text: 'ok' },
            { id: 'p', text: peer('pm1', 'ok') },
            { id: 'r', text: automation('run1') },
            { id: 'c', text: 'ok' },
        ];
        // delivered out of Web order, a project header in front of one, a notification and an interrupt in between
        const points = [
            { id: 'x1', text: '[Very Happy project "demo" · ctx]\nstart' },
            { id: 'x2', text: peer('pm1', 'ok') },
            { id: 'x3', text: 'ok' },
            { id: 'x4', text: notification('bg1') },
            { id: 'x5', text: '[Very Happy project "demo" · ctx]\n' + team('tm1', 'please also run lint') },
            { id: 'x6', text: '[Request interrupted by user]' },
            { id: 'x7', text: 'ok' },
            { id: 'x8', text: automation('run1') },
        ];
        expect(resolveForkPoint(webMixed, 'a', points)).toBe('x1');
        expect(resolveForkPoint(webMixed, 'b', points)).toBe('x3');
        expect(resolveForkPoint(webMixed, 'c', points)).toBe('x7');
        expect(resolveForkPoint(webMixed, 't', points)).toBe('x5');
        expect(resolveForkPoint(webMixed, 'p', points)).toBe('x2');
        expect(resolveForkPoint(webMixed, 'r', points)).toBe('x8');
    });
    it('QA24 c4: forking from /compact keeps the compacted history, not its summary; mirrored command rows never guess', () => {
        const web = [
            { id: 'w1', text: '暗号一是 Mochi。只回复 OK' },
            { id: 'w2', text: '暗号二是 Bruno。只回复 OK' },
            { id: 'w3', text: '/compact' },
            { id: 'w4', text: '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>' },
            { id: 'w5', text: '<local-command-stdout>Compacted </local-command-stdout>' },
            { id: 'w6', text: '暗号三是 Kiwi。只回复 OK' },
        ];
        const points = [
            { id: 'p0', text: '暗号一是 Mochi。只回复 OK' },
            { id: 'p1', text: '暗号二是 Bruno。只回复 OK' },
            { id: 'p2', text: 'This session is being continued from a previous conversation that ran out of context. The summary below covers …' },
            { id: 'p3', text: '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>' },
            { id: 'p4', text: '<local-command-stdout>Compacted </local-command-stdout>' },
            { id: 'p5', text: '暗号三是 Kiwi。只回复 OK' },
        ];
        expect(resolveForkPoint(web, 'w2', points)).toBe('p1');
        expect(resolveForkPoint(web, 'w3', points)).toBe('p2');
        expect(resolveForkPoint(web, 'w4', points)).toBeNull();
        expect(resolveForkPoint(web, 'w5', points)).toBeNull();
        expect(resolveForkPoint(web, 'w6', points)).toBe('p5');
    });
    it('keeps a typed "ok" off an injected point whose body contains it', () => {
        const ask = [{ id: 'a', text: 'ok' }];
        expect(resolveForkPoint(ask, 'a', [{ id: 'x', text: peer('pm1', 'ok') }])).toBeNull();
        expect(resolveForkPoint(ask, 'a', [{ id: 'x', text: notification('n1') }, { id: 'y', text: 'ok' }])).toBe('y');
    });
    it('refuses an injected prompt without an id or with an ambiguous one', () => {
        const ask = [{ id: 'a', text: '<system-reminder>x</system-reminder>' }, { id: 'b', text: notification('dup') }];
        expect(resolveForkPoint(ask, 'a', [{ id: 'x', text: '<system-reminder>x</system-reminder>' }])).toBeNull();
        expect(resolveForkPoint(ask, 'b', [{ id: 'x', text: notification('dup') }, { id: 'y', text: notification('dup') }])).toBeNull();
    });
    it('classifies what nobody typed and leaves typed prompts alone', () => {
        expect(injectedPromptKey(notification('b6'))).toBe('task:b6');
        expect(injectedPromptKey('[Request interrupted by user for tool use]')).toBeNull();
        expect(injectedPromptKey('<local-command-stdout>Compacted</local-command-stdout>')).toBeNull();
        expect(injectedPromptKey(team('tm9', 'x'))).toBe('team:tm9');
        expect(injectedPromptKey(peer('pm9', 'x'))).toBe('peer:pm9');
        expect(injectedPromptKey(automation('r9'))).toBe('automation:r9');
        // typed: a slash command wrapper, a notification quoted inside real text, a project header alone
        expect(injectedPromptKey('<command-name>/compact</command-name>\n<command-args></command-args>')).toBeUndefined();
        expect(injectedPromptKey(`look at this:\n${notification('q')}`)).toBeUndefined();
        expect(injectedPromptKey('[Very Happy project "demo" · ctx]\nfix the bug')).toBeUndefined();
        expect(injectedPromptKey('[Briefing board] 1 open: todo\nhi')).toBeUndefined();
    });
});

describe('B-851 failure copy', () => {
    it('tells an outdated CLI from an offline or unreachable machine', () => {
        expect(forkFailureKind('Method not found', true)).toBe('outdated');
        // CLI before B-851 on Codex ≥ 0.154
        expect(forkFailureKind('thread/rollback: paginated threads do not support thread/rollback (code=-32600)', true)).toBe('outdated');
        expect(forkFailureKind('RPC method not available', false)).toBe('offline');
        // the machine flag lags a stopped daemon: name both causes
        expect(forkFailureKind('RPC method not available', true)).toBe('unreachable');
        expect(forkFailureKind('Claude session file not found on this machine', true)).toBe('failed');
    });
    it('keeps the machine’s words only for a generic failure', () => {
        const t = (key: string) => key;
        expect(forkReasonText(t as never, 'failed', 'disk full')).toBe('session.forkErrorGeneric disk full');
        expect(forkReasonText(t as never, 'outdated', 'Method not found')).toBe('session.forkErrorOutdated');
        expect(forkReasonText(t as never, 'offline')).toBe('session.forkErrorOffline');
    });
});
