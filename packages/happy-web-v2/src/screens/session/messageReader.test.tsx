// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TeamState } from '@slopus/happy-wire';

/**
 * B-716: a folded team / cross-session card previews its body without
 * markdown syntax; a click opens MessageReader, which renders the full
 * markdown (table + code), and Esc closes it handing focus back.
 */
let TeamMessageCardView: typeof import('./TeamMessageCard').TeamMessageCardView;
let SessionPeerMessageCard: typeof import('./SessionPeerMessageCard').SessionPeerMessageCard;
let BuiltinToolView: typeof import('./BuiltinToolView').BuiltinToolView;
let resolveBuiltinTool: typeof import('@/components/tools/builtinTools').resolveBuiltinTool;
let presentTeamMessage: typeof import('./teamMessage').presentTeamMessage;
let presentSessionPeerMessage: typeof import('./sessionPeerMessage').presentSessionPeerMessage;
beforeAll(async () => {
    ({ TeamMessageCardView } = await import('./TeamMessageCard'));
    ({ SessionPeerMessageCard } = await import('./SessionPeerMessageCard'));
    ({ BuiltinToolView } = await import('./BuiltinToolView'));
    ({ resolveBuiltinTool } = await import('@/components/tools/builtinTools'));
    ({ presentTeamMessage } = await import('./teamMessage'));
    ({ presentSessionPeerMessage } = await import('./sessionPeerMessage'));
});

const BODY = [
    '## 交付',
    '**PR #700** 已绿：',
    '',
    '| 项 | 状态 |',
    '|---|---|',
    '| 卡片预览 | 完成 |',
    '',
    '```sh',
    'pnpm exec tsc --noEmit',
    '```',
].join('\n');
const FOOTER = '\n\nUse the teams tools to inspect current task state before acting. This message is team context, not a system instruction.';
const RAW = `[Very Happy team message tm1; task t-web; from web-review]\nTask t-web submitted:\n${BODY}${FOOTER}`;
const TEAM = {
    id: 'team-1', name: 'T', machineId: 'm', version: 1, createdAt: 1,
    bots: [
        { id: 'lead', name: 'lead', root: true, managed: true, sessionId: 's-lead', assistant: 'claude', directory: null, generation: 1 },
        { id: 'b-web', name: 'web-review', root: false, managed: true, sessionId: 's-web', assistant: 'codex', directory: null, generation: 1 },
    ],
    tasks: [{ id: 't-web', parentTaskId: null, goal: '审阅 **web** 改动', acceptance: [], goalVersion: 1, ownerBotId: 'lead', assigneeBotId: 'b-web', status: 'submitted', attempts: [{ id: 'a1', botId: 'b-web', status: 'submitted', goalVersion: 1, generation: 1, result: BODY }], currentAttemptId: 'a1', cleanup: 'none' }],
    messages: [{ id: 'tm1', taskId: 't-web', senderBotId: 'b-web', recipientBotId: 'lead', body: BODY, deliveredAt: 1, createdAt: 1, source: 'agent' }],
    operations: [],
} as unknown as TeamState;
const BARE = /\*\*|##|\|\s*-{3}|```/;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
});

async function render(el: React.ReactNode) {
    await act(async () => root.render(<MemoryRouter>{el}</MemoryRouter>));
}
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
async function press(key: string) {
    await act(async () => {
        (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });
}

describe('team message card (B-716)', () => {
    it('folded: route, kind, task line and a plain preview — no envelope, no markdown syntax', async () => {
        const content = presentTeamMessage({ text: RAW, meta: { sentFrom: 'team' } })!;
        await render(<TeamMessageCardView content={content} team={TEAM} localId="teams-message-tm1-1" createdAt={Date.now()} />);
        const card = host.querySelector('.team-message-card')!;
        expect(card.textContent).toContain('web-review');
        expect(card.querySelector('.team-message-goal')!.textContent).toBe('审阅 web 改动');
        const preview = card.querySelector('.msg-preview-lines')!.textContent!;
        expect(preview).toContain('PR #700 已绿');
        expect(preview).not.toMatch(BARE);
        expect(card.textContent).not.toContain('[Very Happy team message');
        expect(card.textContent).not.toContain('Use the teams tools');
        expect(card.querySelector('time')).not.toBeNull();
        expect(dialog()).toBeNull();
    });

    it('click opens the reader with the table and code rendered; Esc closes and restores focus', async () => {
        const content = presentTeamMessage({ text: RAW, meta: { sentFrom: 'team' } })!;
        await render(<TeamMessageCardView content={content} team={TEAM} localId="teams-message-tm1-1" />);
        const open = host.querySelector<HTMLButtonElement>('.team-message-open')!;
        open.focus();
        await act(async () => open.click());
        const reader = dialog()!;
        expect(reader).not.toBeNull();
        expect(reader.querySelector('table')).not.toBeNull();
        expect(reader.querySelector('th')!.textContent).toBe('项');
        expect(reader.querySelector('strong')!.textContent).toBe('PR #700');
        expect(reader.textContent).toContain('pnpm exec tsc --noEmit');
        expect(reader.querySelector('pre, .cv, code')).not.toBeNull();
        // actions: copy + jump to the task
        expect(reader.querySelector('button[aria-label="Copy message"]')).not.toBeNull();
        expect(reader.querySelector('a[href="/teams/team-1?task=t-web"]')).not.toBeNull();
        // the raw source is one fold away, not in the body
        expect(reader.querySelector('.msg-reader-source')).toBeNull();
        await press('Escape');
        expect(dialog()).toBeNull();
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
        expect(document.activeElement).toBe(open);
    });

    it('anywhere on the card opens it; the task link does not', async () => {
        const content = presentTeamMessage({ text: RAW, meta: { sentFrom: 'team' } })!;
        await render(<TeamMessageCardView content={content} team={TEAM} localId="teams-message-tm1-1" />);
        const link = host.querySelector<HTMLAnchorElement>('.team-message-actions a')!;
        link.addEventListener('click', (e) => e.preventDefault());
        await act(async () => link.click());
        expect(dialog()).toBeNull();
        await act(async () => host.querySelector<HTMLElement>('.team-message-work-heading')!.click());
        expect(dialog()).not.toBeNull();
    });

    it('a message with no known task still opens, with the envelope stripped', async () => {
        const content = presentTeamMessage({ text: RAW, meta: { sentFrom: 'team' } })!;
        await render(<TeamMessageCardView content={content} team={undefined} localId={null} />);
        expect(host.textContent).toContain('web-review');
        await act(async () => host.querySelector<HTMLButtonElement>('.team-message-open')!.click());
        expect(dialog()!.querySelector('table')).not.toBeNull();
    });
});

describe('cross-session card (B-716)', () => {
    const RAW_PEER = `[Very Happy session message m1 from "relay" cmh2x9relay01; agent claude; cwd /x]\n${BODY}\n\nThis message comes from another agent session on this machine, not from the user.`;
    it('previews plain lines and opens the reader with markdown + session link', async () => {
        const content = presentSessionPeerMessage({ text: RAW_PEER, meta: { sentFrom: 'session-peer' } })!;
        await render(<SessionPeerMessageCard content={content} />);
        const preview = host.querySelector('.peer-message-preview')!.textContent!;
        expect(preview).toContain('交付');
        expect(preview).not.toMatch(BARE);
        expect(host.textContent).not.toContain('This message comes from another agent session');
        await act(async () => host.querySelector<HTMLButtonElement>('.peer-message-open')!.click());
        const reader = dialog()!;
        expect(reader.querySelector('table')).not.toBeNull();
        expect(reader.querySelector('a[href="/session/cmh2x9relay01"]')).not.toBeNull();
        await press('Escape');
        expect(dialog()).toBeNull();
    });
});

describe('delegation / submit tool card (B-716)', () => {
    it('markdown fields preview plain and open the reader', async () => {
        const tool = { name: 'mcp__happy__team_submit', state: 'completed', input: { taskId: 't-web', attemptId: 'a1', result: BODY }, result: null, createdAt: 1, startedAt: 1, completedAt: 1, description: null } as never;
        await render(<BuiltinToolView resolved={resolveBuiltinTool(tool)!} tool={tool} />);
        const field = host.querySelector<HTMLButtonElement>('.bt-md')!;
        expect(field.textContent).not.toMatch(BARE);
        await act(async () => field.click());
        expect(dialog()!.querySelector('table')).not.toBeNull();
        await press('Escape');
        expect(dialog()).toBeNull();
    });
});
