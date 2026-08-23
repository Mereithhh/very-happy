import { afterEach, describe, expect, it } from 'vitest';
import { configuredResourceLimit } from './resourceLimits';

describe('configurable resource limits', () => {
    afterEach(() => delete process.env.TEST_RESOURCE_LIMIT);

    it('uses safe defaults, accepts an explicit cap, and reserves zero for unlimited', () => {
        expect(configuredResourceLimit('TEST_RESOURCE_LIMIT', 20)).toBe(20);
        process.env.TEST_RESOURCE_LIMIT = '4';
        expect(configuredResourceLimit('TEST_RESOURCE_LIMIT', 20)).toBe(4);
        process.env.TEST_RESOURCE_LIMIT = '0';
        expect(configuredResourceLimit('TEST_RESOURCE_LIMIT', 20)).toBe(0);
        process.env.TEST_RESOURCE_LIMIT = '-1';
        expect(configuredResourceLimit('TEST_RESOURCE_LIMIT', 20)).toBe(20);
    });
});
