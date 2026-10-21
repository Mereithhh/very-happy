import { describe, expect, it } from 'vitest';
import type { MachineMetadata } from '@/api/types';
import { withRunningCliFacts } from './machineMetadata';

const registered = { host: 'dev-sg', platform: 'linux', happyCliVersion: '0.2.134', homeDir: '/home/u', happyHomeDir: '/home/u/.happy', happyLibDir: '/old/lib', displayName: 'dev-sg (renamed)' } as MachineMetadata;
const running = { ...registered, happyCliVersion: '0.2.180', happyLibDir: '/usr/lib/node_modules/very-happy-cli', displayName: undefined } as MachineMetadata;

describe('machine metadata on daemon start (B-718, QA2 O6)', () => {
    it('republishes the running CLI version over the registered one', () => {
        const next = withRunningCliFacts(registered, running);
        expect(next.happyCliVersion).toBe('0.2.180');
        expect(next.happyLibDir).toBe('/usr/lib/node_modules/very-happy-cli');
    });
    it('keeps everything else the row already had (user rename included)', () => {
        expect((withRunningCliFacts(registered, running) as Record<string, unknown>).displayName).toBe('dev-sg (renamed)');
    });
    it('falls back to the running metadata when the row has none', () => {
        expect(withRunningCliFacts(null, running)).toEqual(running);
    });
});
