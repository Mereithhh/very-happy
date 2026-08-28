import { describe, expect, it } from 'vitest';
import { MessageMetaSchema } from './messageMeta';

describe('MessageMetaSchema delivery', () => {
  it('preserves explicit Steer and leaves old messages as queue-by-default', () => {
    expect(MessageMetaSchema.parse({ delivery: 'steer' }).delivery).toBe('steer');
    expect(MessageMetaSchema.parse({}).delivery).toBeUndefined();
    expect(MessageMetaSchema.safeParse({ delivery: 'interrupt' }).success).toBe(false);
  });
});
