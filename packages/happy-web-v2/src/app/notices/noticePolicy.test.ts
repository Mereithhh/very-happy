import { describe, expect, it } from 'vitest';
import type { NoticeView } from '@slopus/happy-wire';
import { noticeOpenAt, pickNotice, splitNoticeBody, withDismissed } from './noticePolicy';

const n = (id: string, over: Partial<NoticeView> = {}): NoticeView => ({ id, title: id, body: '', level: 'info', dismissible: true, ...over });
const NOW = Date.parse('2026-11-27T12:00:00Z');
const none = new Set<string>();

describe('pickNotice', () => {
    it('shows the first (newest) notice that is not dismissed', () => {
        const list = [n('newest'), n('older'), n('oldest')];
        expect(pickNotice(list, [], none, NOW)?.id).toBe('newest');
        expect(pickNotice(list, ['newest'], none, NOW)?.id).toBe('older');
        expect(pickNotice(list, ['newest', 'older', 'oldest'], none, NOW)).toBeNull();
        expect(pickNotice([], null, none, NOW)).toBeNull();
    });

    it('a notice that cannot be dismissed ignores the dismissed list but not a close for this load', () => {
        const list = [n('sticky', { dismissible: false }), n('next')];
        expect(pickNotice(list, ['sticky'], none, NOW)?.id).toBe('sticky');
        expect(pickNotice(list, ['sticky'], new Set(['sticky']), NOW)?.id).toBe('next');
    });

    it('skips a notice whose window closed (or has not opened) since the last fetch', () => {
        const list = [n('ended', { endsAt: '2026-11-27T12:00:00Z' }), n('later', { startsAt: '2026-11-27T13:00:00Z' }), n('open', { endsAt: '2026-11-28T00:00:00Z' })];
        expect(pickNotice(list, [], none, NOW)?.id).toBe('open');
        expect(noticeOpenAt({ startsAt: 'garbage' }, NOW)).toBe(true);
    });
});

describe('withDismissed', () => {
    it('appends, moves a repeat to the end, and keeps the newest 100', () => {
        expect(withDismissed(undefined, 'a')).toEqual(['a']);
        expect(withDismissed(['a', 'b'], 'a')).toEqual(['b', 'a']);
        const many = Array.from({ length: 100 }, (_, i) => `n${i}`);
        const next = withDismissed(many, 'new');
        expect(next).toHaveLength(100);
        expect(next[0]).toBe('n1');
        expect(next[99]).toBe('new');
    });
});

describe('splitNoticeBody', () => {
    it('turns http(s) URLs into links and leaves trailing punctuation as text', () => {
        expect(splitNoticeBody('See https://status.example.com/x. Thanks')).toEqual([
            { kind: 'text', text: 'See ' },
            { kind: 'link', href: 'https://status.example.com/x' },
            { kind: 'text', text: '. Thanks' },
        ]);
        expect(splitNoticeBody('详情见 https://docs.example.com/a?b=1）')).toEqual([
            { kind: 'text', text: '详情见 ' },
            { kind: 'link', href: 'https://docs.example.com/a?b=1' },
            { kind: 'text', text: '）' },
        ]);
        expect(splitNoticeBody('javascript:alert(1) and ftp://x')).toEqual([{ kind: 'text', text: 'javascript:alert(1) and ftp://x' }]);
    });
});
