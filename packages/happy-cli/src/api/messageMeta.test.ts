import { describe, expect, it } from 'vitest';
import { MessageMetaSchema } from './types';

describe('CLI MessageMetaSchema delivery', () => {
    it('does not strip the Web Steer marker', () => {
        expect(MessageMetaSchema.parse({ sentFrom: 'web', delivery: 'steer' })).toEqual({
            sentFrom: 'web',
            delivery: 'steer',
        });
    });
});
