import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Message } from '@/sync/typesMessage';
import { activityDurationSeconds } from './chatTurns';

const styles = readFileSync(new URL('./turnactivity.css', import.meta.url), 'utf8');

describe('turn activity timeline', () => {
    it('uses a horizontal elapsed divider without any vertical activity rail', () => {
        const activityRule = styles.match(/\.ta\s*{([^}]*)}/s)?.[1] ?? '';
        const headRule = styles.match(/\.ta-head\s*{([^}]*)}/s)?.[1] ?? '';
        expect(activityRule).not.toContain('border-left');
        expect(activityRule).not.toContain('padding-left');
        expect(headRule).toContain('border-bottom: 1px solid var(--line)');
        expect(styles).toMatch(/\.ta-detail \.msg-thinking\s*{[^}]*border-left:\s*0/s);
        expect(styles).toMatch(/\.ta-detail \.tg-spine\s*{[^}]*display:\s*none/s);
    });

    it('centers the activity disclosure icon independently of the text baseline', () => {
        expect(styles).toMatch(/\.ta-head > \.tg-chevron\s*{[^}]*display:\s*block/s);
        expect(styles).toMatch(/\.ta-head > \.tg-chevron\s*{[^}]*align-self:\s*center/s);
        expect(styles).toMatch(/\.ta-head > \.tg-chevron\s*{[^}]*transform-origin:\s*50% 50%/s);
    });

    it('uses a lone tool completion time for the elapsed header', () => {
        const message: Message = {
            kind: 'tool-call',
            id: 'tool',
            localId: null,
            createdAt: 1_000,
            children: [],
            tool: {
                name: 'Read',
                state: 'completed',
                input: {},
                createdAt: 1_000,
                startedAt: 1_000,
                completedAt: 4_000,
                description: null,
            },
        };
        expect(activityDurationSeconds([message])).toBe(3);
    });
});
