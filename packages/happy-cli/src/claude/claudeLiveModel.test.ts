import { describe, expect, it } from 'vitest';
import { modelSwitchFailureNotice, modelTarget, needsModelSwitch } from './claudeLiveModel';

describe('claudeLiveModel', () => {
    it('treats null, undefined and empty string as "the machine default"', () => {
        expect(modelTarget(null)).toBeUndefined();
        expect(modelTarget(undefined)).toBeUndefined();
        expect(modelTarget('')).toBeUndefined();
        expect(modelTarget('opus')).toBe('opus');
        // The web sends `null` for the "default model" pick (B-103); it must not
        // read as a switch away from an already-default session.
        expect(needsModelSwitch(undefined, null)).toBe(false);
        expect(needsModelSwitch(null, undefined)).toBe(false);
    });

    it('detects a real switch in both directions, including to and from default', () => {
        expect(needsModelSwitch('opus', 'sonnet')).toBe(true);
        expect(needsModelSwitch('opus', 'opus')).toBe(false);
        expect(needsModelSwitch(null, 'opus')).toBe(true);
        expect(needsModelSwitch('opus', null)).toBe(true);
        // `[1m]` variants are distinct models, not decoration (B-290).
        expect(needsModelSwitch('opus', 'opus[1m]')).toBe(true);
    });

    it('names the model and carries the SDK reason in the failure notice', () => {
        const notice = modelSwitchFailureNotice('fable5', new Error('Model "fable5" is not a recognized model id.'));
        expect(notice).toContain('fable5');
        expect(notice).toContain('not a recognized model id');
        expect(modelSwitchFailureNotice(null, 'boom')).toContain('default');
    });
});
