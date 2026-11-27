import { describe, expect, it } from 'vitest';
import { parseNoticesResponse } from './index';

describe('parseNoticesResponse', () => {
    it('keeps valid notices, skips malformed ones, and reads unknown fields leniently', () => {
        const notices = parseNoticesResponse({
            notices: [
                { id: 'maint-1', title: 'Maintenance', body: 'Tonight', level: 'warning', dismissible: false, endsAt: '2026-12-01T00:00:00Z' },
                { id: 'bad id', title: 'x', body: 'y', level: 'info', dismissible: true },
                { id: 'future', title: 'New level', body: 'z', level: 'critical', dismissible: 'yes', extra: 1 },
            ],
        });
        expect(notices).toEqual([
            { id: 'maint-1', title: 'Maintenance', body: 'Tonight', level: 'warning', dismissible: false, endsAt: '2026-12-01T00:00:00Z' },
            { id: 'future', title: 'New level', body: 'z', level: 'info', dismissible: true },
        ]);
    });

    it('anything that is not a notices list is no notices', () => {
        expect(parseNoticesResponse(null)).toEqual([]);
        expect(parseNoticesResponse({ error: 'not_found' })).toEqual([]);
        expect(parseNoticesResponse({ notices: 'x' })).toEqual([]);
    });
});
