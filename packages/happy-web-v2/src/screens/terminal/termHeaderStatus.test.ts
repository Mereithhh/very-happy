import { describe, expect, it } from 'vitest';
import { termHeaderStatusChips } from './termHeaderStatus';

describe('termHeaderStatusChips', () => {
    it('shows at most one chip on a phone — the regression that hid the action cluster', () => {
        expect(termHeaderStatusChips({ compact: true, connecting: true, fontLoading: true })).toEqual(['connecting']);
        expect(termHeaderStatusChips({ compact: true, connecting: false, fontLoading: true })).toEqual(['font']);
        expect(termHeaderStatusChips({ compact: true, connecting: false, fontLoading: false })).toEqual(['relay']);
    });

    it('never leaves the compact header with an empty status slot', () => {
        for (const connecting of [true, false]) {
            for (const fontLoading of [true, false]) {
                expect(termHeaderStatusChips({ compact: true, connecting, fontLoading })).toHaveLength(1);
            }
        }
    });

    it('keeps the full set where there is room, relay first', () => {
        expect(termHeaderStatusChips({ compact: false, connecting: true, fontLoading: true }))
            .toEqual(['relay', 'connecting', 'font']);
        expect(termHeaderStatusChips({ compact: false, connecting: false, fontLoading: false })).toEqual(['relay']);
    });
});
