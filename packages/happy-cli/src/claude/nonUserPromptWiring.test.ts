/**
 * B-940 wiring guard: a routed session-peer message is marked non-user on its
 * way to each agent — queued as a prompt of its own (Claude, Codex, pi), never
 * steered into a running Codex / pi turn (no non-user channel there), and
 * steered into a Claude turn only as synthetic. The behaviour is pinned in
 * claudeRemote.nonUser.test.ts, MessageQueue2.test.ts and nonUserPrompt.test.ts;
 * these are source assertions because the bug class is which flag reaches
 * which call. Pinned with scripts/dev/mutation-check.mjs.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');

describe('session-peer message wiring (B-940)', () => {
    it('Claude: queued as non-user; a steer carries synthetic', () => {
        const src = read('./runClaude.ts');
        expect(src).toContain('const fromPeer = isSessionPeerPrompt(message.meta);');
        expect(src).toContain('...(fromPeer ? { synthetic: true } : {}),');
        expect(src).toContain('if (fromPeer) messageQueue.pushNonUser(modelText, enhancedMode, attachmentsForThisMessage, message.localKey);');
    });

    it('Claude launcher: the queue\'s non-user mark reaches the Query, through a park and a steer', () => {
        const src = read('./claudeRemoteLauncher.ts');
        const section = (from: string, to: string) => {
            const start = src.indexOf(from);
            expect(start, from).toBeGreaterThan(-1);
            return src.slice(start, src.indexOf(to, start));
        };
        const mark = '...(msg.nonUser ? { synthetic: true } : {}),';
        expect(section("logger.debug('[remote]: mode has changed, pending message');", 'return null;')).toContain(mark);
        expect(section('const withAttachments = await finalize(', 'const finalized = await finalize(')).toContain(mark);
        expect(section('const finalized = await finalize(msg.message);', '// Exit')).toContain(mark);
        expect(src).toContain('q.steer(message, input.mode, input.localKey, input.synthetic);');
    });

    it('Codex and pi: never steered into a running turn; queued as non-user', () => {
        const codex = read('../codex/runCodex.ts');
        expect(codex).toContain("if (message.meta?.delivery === 'steer' && !fromPeer && !isCodexControlText(message.content.text)) {");
        expect(codex).toContain('...(fromPeer ? { nonUser: true } : {}),');
        const acp = read('../agent/acp/runAcp.ts');
        expect(acp).toContain("if (message.meta?.delivery === 'steer' && !fromPeer && piSteer?.ready && thinking && !attachments?.length) {");
        expect(acp).toContain('if (fromPeer) messageQueue.pushNonUser(message.content.text, queued, attachments, message.localKey);');
    });
});

/**
 * B-939c wiring: a stored project message is routed locally into its
 * recipient, counted as delivered once the Claude launcher pushed it, and kept
 * out of the B-940b exit hand-over (no server record: it stays unread and the
 * next wrapper routes it again). Codex and pi route it too; Gemini keeps the
 * text line.
 */
describe('stored project message wiring (B-939c)', () => {
    it('Claude: routed locally, delivered on push, not handed on or tombstoned at exit', () => {
        expect(read('./session.ts')).toContain("dispatchToSelf: (text, localKey) => this.client.routeLocalSessionPeer(text, localKey),\n            handedOn: 'pushed',");
        expect(read('./claudeRemoteLauncher.ts')).toContain('onPromptPushed: (sourceIds) => { if (!session.exiting) session.projectInjector.handed(sourceIds); },');
        expect(read('./runClaude.ts')).toContain('.filter((id) => !isStoredMessageLocalId(id)), session);');
    });
    it('Codex and pi route it; Gemini does not', () => {
        for (const rel of ['../codex/runCodex.ts', '../agent/acp/runAcp.ts']) expect(read(rel)).toContain('dispatchToSelf: (text, localKey) => { if (!session) throw new Error(\'no session\'); session.routeLocalSessionPeer(text, localKey); }');
        expect(read('../gemini/runGemini.ts')).not.toContain('dispatchToSelf');
    });
});
