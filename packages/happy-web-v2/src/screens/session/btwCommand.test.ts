import { describe, expect, it } from 'vitest';
import { canOfferBtw, parseBtwCommand, supportsBtw } from './btwCommand';

describe('/btw command parsing (B-283)', () => {
    it('opens the panel on a bare /btw and asks on /btw <question>', () => {
        expect(parseBtwCommand('/btw')).toEqual({ question: '' });
        expect(parseBtwCommand('  /BTW  ')).toEqual({ question: '' });
        expect(parseBtwCommand('/btw what does E2BIG mean?')).toEqual({ question: 'what does E2BIG mean?' });
        expect(parseBtwCommand('/btw\nmulti\nline')).toEqual({ question: 'multi\nline' });
    });

    it('leaves every other message alone', () => {
        expect(parseBtwCommand('/btwx')).toBeNull();
        expect(parseBtwCommand('btw hi')).toBeNull();
        expect(parseBtwCommand('/compact')).toBeNull();
        expect(parseBtwCommand('please /btw')).toBeNull();
    });
});

describe('btw capability gate', () => {
    const claude = (capabilities?: string[]) => ({ metadata: { flavor: 'claude', capabilities } } as any);
    it('offers the panel on any Claude session but only new CLIs answer', () => {
        expect(canOfferBtw(claude())).toBe(true);
        expect(canOfferBtw({ metadata: {} } as any)).toBe(true);
        expect(canOfferBtw({ metadata: { flavor: 'codex' } } as any)).toBe(false);
        expect(supportsBtw(claude())).toBe(false);
        expect(supportsBtw(claude(['claude-steer-v1']))).toBe(false);
        expect(supportsBtw(claude(['claude-steer-v1', 'claude-btw-v1']))).toBe(true);
        expect(supportsBtw({ metadata: { flavor: 'codex', capabilities: ['claude-btw-v1'] } } as any)).toBe(false);
        expect(supportsBtw(null)).toBe(false);
    });
});
