import { describe, expect, it } from 'vitest';
import { MessageMetaSchema } from './typesMessageMeta';

describe('Web MessageMetaSchema delivery', () => {
    it('preserves Steer while old messages remain queue-by-default', () => {
        expect(MessageMetaSchema.parse({ delivery: 'steer' }).delivery).toBe('steer');
        expect(MessageMetaSchema.parse({}).delivery).toBeUndefined();
    });
});
