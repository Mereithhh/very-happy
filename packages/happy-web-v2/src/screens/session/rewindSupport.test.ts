import { describe, expect, it } from 'vitest';
import { canRetryMessage, canRewindMessage } from './rewindSupport';

const prompt = { seq: 3 };
const session = (metadata: Record<string, unknown>, share?: unknown) => ({ metadata, ...(share ? { share } : {}) }) as any;

describe('B-961 canRewindMessage', () => {
    it('Claude: every owner session; Codex: only wrappers advertising codex-rewind-v1', () => {
        expect(canRewindMessage(session({ flavor: 'claude' }), prompt, null)).toBe(true);
        expect(canRewindMessage(session({}), prompt, null)).toBe(true);
        expect(canRewindMessage(session({ flavor: 'codex' }), prompt, null)).toBe(false);
        expect(canRewindMessage(session({ flavor: 'codex', capabilities: ['codex-steer-v1'] }), prompt, null)).toBe(false);
        expect(canRewindMessage(session({ flavor: 'codex', capabilities: ['codex-rewind-v1'] }), prompt, null)).toBe(true);
        expect(canRewindMessage(session({ flavor: 'pi', capabilities: ['codex-rewind-v1'] }), prompt, null)).toBe(false);
        expect(canRewindMessage(session({ flavor: 'terminal-mirror' }), prompt, null)).toBe(false);
    });
    it('never for a grantee, an unconfirmed or still-sending prompt', () => {
        const codex = { flavor: 'codex', capabilities: ['codex-rewind-v1'] };
        expect(canRewindMessage(session(codex, { accessLevel: 'view' }), prompt, null)).toBe(false);
        expect(canRewindMessage(session(codex), { seq: null } as any, null)).toBe(false);
        expect(canRewindMessage(session(codex), undefined, null)).toBe(false);
        expect(canRewindMessage(session(codex), prompt, { state: 'sending' } as any)).toBe(false);
    });
    it('retry needs text and no attachments', () => {
        expect(canRetryMessage(true, false, 'hi')).toBe(true);
        expect(canRetryMessage(true, true, 'hi')).toBe(false);
        expect(canRetryMessage(true, false, '  ')).toBe(false);
        expect(canRetryMessage(false, false, 'hi')).toBe(false);
    });
});
