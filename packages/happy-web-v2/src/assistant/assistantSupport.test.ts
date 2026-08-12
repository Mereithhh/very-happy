import { describe, it, expect } from 'vitest';
import { compareVersions, isAssistantSupported } from './assistantSupport';
import { ASSISTANT_MIN_CLI_VERSION } from './assistantConstants';

describe('compareVersions', () => {
    it('orders plain semver', () => {
        expect(compareVersions('0.2.33', '0.2.34')).toBeLessThan(0);
        expect(compareVersions('0.2.34', '0.2.34')).toBe(0);
        expect(compareVersions('0.2.35', '0.2.34')).toBeGreaterThan(0);
    });

    it('compares numerically, not lexically', () => {
        expect(compareVersions('0.2.100', '0.2.34')).toBeGreaterThan(0);
        expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    });

    it('major/minor precedence beats patch', () => {
        expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
        expect(compareVersions('0.3.0', '0.2.34')).toBeGreaterThan(0);
    });

    it('missing segments count as zero', () => {
        expect(compareVersions('0.2', '0.2.0')).toBe(0);
        expect(compareVersions('1', '1.0.0')).toBe(0);
    });

    it('tolerates v-prefix and pre-release suffixes', () => {
        expect(compareVersions('v0.2.34', '0.2.34')).toBe(0);
        expect(compareVersions('0.2.34-beta', '0.2.34')).toBe(0);
    });
});

describe('isAssistantSupported', () => {
    it('accepts the minimum version and above', () => {
        expect(isAssistantSupported(ASSISTANT_MIN_CLI_VERSION)).toBe(true);
        expect(isAssistantSupported('0.2.35')).toBe(true);
        expect(isAssistantSupported('0.3.0')).toBe(true);
        expect(isAssistantSupported('1.0.0')).toBe(true);
    });

    it('rejects older versions', () => {
        expect(isAssistantSupported('0.2.33')).toBe(false);
        expect(isAssistantSupported('0.1.99')).toBe(false);
    });

    it('gates closed on unknown/garbage versions', () => {
        expect(isAssistantSupported(null)).toBe(false);
        expect(isAssistantSupported(undefined)).toBe(false);
        expect(isAssistantSupported('')).toBe(false);
        expect(isAssistantSupported('dev')).toBe(false);
    });
});
