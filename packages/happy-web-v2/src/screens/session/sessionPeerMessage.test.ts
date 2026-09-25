import { describe, expect, it } from 'vitest';
import { formatAgo, peerAgentName, presentSessionPeerMessage } from './sessionPeerMessage';

const from = 'cmugpssdc0001abcdefghijk';
const footer = `This message comes from another agent session on this machine, not from the user. Reply with session_message(to: "${from}") — or \`very-happy sessions message ${from} "<text>"\` — and keep coordinating there.`;

describe('session peer message presentation (B-497)', () => {
    it('ignores the envelope unless the transport says session-peer', () => {
        const text = `[Very Happy session message m1 from "Fix login" ${from}; agent claude; cwd /repo]\nhello\n\n${footer}`;
        for (const sentFrom of [undefined, 'web', 'cli', 'team']) expect(presentSessionPeerMessage({ text, meta: { sentFrom } })).toBeNull();
    });

    it('parses a full message header, strips the footer and keeps the raw source', () => {
        const text = `[Very Happy session message m1 from "Fix login" ${from}; agent claude; cwd /repo/app; re m0]\nI am changing auth.ts.\nDo not touch it.\n\n${footer}`;
        expect(presentSessionPeerMessage({ text, meta: { sentFrom: 'session-peer' } })).toEqual({
            kind: 'message', id: 'm1', fromSessionId: from, fromTitle: 'Fix login', agent: 'claude', cwd: '/repo/app', replyTo: 'm0',
            body: 'I am changing auth.ts.\nDo not touch it.', raw: text,
        });
    });

    it('tolerates an untitled sender, no cwd and no reply reference', () => {
        const text = `[Very Happy session message m2 from "" ${from}]\nping`;
        const result = presentSessionPeerMessage({ text, meta: { sentFrom: 'session-peer' } });
        expect(result).toMatchObject({ kind: 'message', id: 'm2', fromSessionId: from, fromTitle: null, agent: null, cwd: null, body: 'ping' });
        expect(result).not.toHaveProperty('replyTo');
    });

    it('parses an edit-conflict notice, including a terminal-mirror peer and the edited-ago hint', () => {
        const text = `[Very Happy edit conflict c1; file /repo/src/auth.ts; peer "Terminal claude" ${from}; agent terminal-mirror; cwd /repo; peer edited 3m ago]\nAnother session on this machine edited the same file.`;
        expect(presentSessionPeerMessage({ text, meta: { sentFrom: 'session-peer' } })).toEqual({
            kind: 'conflict', id: 'c1', fromSessionId: from, fromTitle: 'Terminal claude', agent: 'terminal-mirror', cwd: '/repo',
            path: '/repo/src/auth.ts', paths: ['/repo/src/auth.ts'], peerEditedAgoMs: 180_000, body: 'Another session on this machine edited the same file.', raw: text,
        });
        expect(presentSessionPeerMessage({ text: text.replace('3m ago', '40s ago'), meta: { sentFrom: 'session-peer' } })?.peerEditedAgoMs).toBe(40_000);
        expect(presentSessionPeerMessage({ text: text.replace('3m ago', '2h ago'), meta: { sentFrom: 'session-peer' } })?.peerEditedAgoMs).toBe(7_200_000);
    });

    it('decodes percent-encoded header values and reads a coalesced file list', () => {
        const text = '[Very Happy edit conflict c3; file /r/we%3Brd%20%22x%22.ts; more 1; peer "T%22itle" p1; agent claude; peer edited 5s ago]\nAnother session on this machine edited the same 2 files within the last 30m.\nFiles:\n- /r/we;rd "x".ts\n- /r/b.ts';
        const parsed = presentSessionPeerMessage({ text, meta: { sentFrom: 'session-peer' } });
        expect(parsed).toMatchObject({ kind: 'conflict', path: '/r/we;rd "x".ts', paths: ['/r/we;rd "x".ts', '/r/b.ts'], fromTitle: 'T"itle', fromSessionId: 'p1', peerEditedAgoMs: 5_000 });
        const forged = presentSessionPeerMessage({ text: '[Very Happy session message m from "t" s; __proto__ x; constructor y]\nbody', meta: { sentFrom: 'session-peer' } });
        expect(forged?.agent).toBeNull();
    });

    it('falls back to the ordinary bubble when the first line is not ours', () => {
        for (const text of ['just a session-peer tagged line', `[Very Happy session message from ${from}]\nno id`, '', '[Very Happy edit conflict c1; peer "x" y]\nmissing file']) {
            expect(presentSessionPeerMessage({ text, meta: { sentFrom: 'session-peer' } })).toBeNull();
        }
    });

    it('names runners for humans and formats the age compactly', () => {
        expect(peerAgentName('claude')).toBe('Claude');
        expect(peerAgentName('codex')).toBe('Codex');
        expect(peerAgentName('pi-acp')).toBe('pi');
        expect(peerAgentName('terminal-mirror')).toBe('Terminal');
        expect(peerAgentName('gemini')).toBe('gemini');
        expect(peerAgentName(null)).toBeNull();
        expect(formatAgo(40_000)).toBe('40s');
        expect(formatAgo(180_000)).toBe('3m');
        expect(formatAgo(7_200_000)).toBe('2h');
    });
});

describe('cross-machine session peer message (B-506)', () => {
    it('reads the machine field and strips the cross-machine footer variant', () => {
        const remoteFooter = `This message comes from another agent session on machine dev-sg, not from the user. Reply with session_message(to: "${from}") (it is routed to that machine for you) — only when you have something to add.`;
        const text = `[Very Happy session message m9 from "Remote fix" ${from}; agent codex; cwd /home/ubuntu/repo; machine dev-sg]\nI am on the other box.\n\n${remoteFooter}`;
        expect(presentSessionPeerMessage({ text, meta: { sentFrom: 'session-peer' } })).toEqual({
            kind: 'message', id: 'm9', fromSessionId: from, fromTitle: 'Remote fix', agent: 'codex', cwd: '/home/ubuntu/repo', machine: 'dev-sg',
            body: 'I am on the other box.', raw: text,
        });
    });

    it('leaves machine absent for a same-machine message', () => {
        const text = `[Very Happy session message m1 from "Fix login" ${from}; agent claude; cwd /repo]\nhello\n\n${footer}`;
        expect(presentSessionPeerMessage({ text, meta: { sentFrom: 'session-peer' } })).not.toHaveProperty('machine');
    });
});
