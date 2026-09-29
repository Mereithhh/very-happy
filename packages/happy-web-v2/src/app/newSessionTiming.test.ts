import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';

let timing: typeof import('./newSessionTiming');
const lines: string[] = [];

beforeAll(async () => {
    installBrowserTestGlobals();
    timing = await import('./newSessionTiming');
    timing.configureNewSessionTiming({ report: (line) => lines.push(line), enabled: () => true });
});

describe('new-session timing (B-512)', () => {
    beforeEach(() => {
        lines.length = 0;
        timing.newSessionTimingCancel();
    });

    it('reports one line when the composer mounts, with the store arrival that beat the RPC', () => {
        timing.newSessionTimingStart('quick');
        timing.newSessionTimingRpcSent();
        timing.newSessionTimingInStore('s1'); // update arrived before the RPC reply
        timing.newSessionTimingInStore('other');
        timing.newSessionTimingRpcReturned('s1');
        timing.newSessionTimingComposerMounted('s1');
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/^\[new-session timing\] quick s1 total=\d+ms rpcSent=\d+ms rpc=\d+ms inStore=\d+ms composer=\d+ms$/);
        // the trace is closed: a second mount does not report again
        timing.newSessionTimingComposerMounted('s1');
        expect(lines).toHaveLength(1);
    });

    it('ignores other sessions, cancelled traces and pages opened without a click', () => {
        timing.newSessionTimingComposerMounted('s1');
        timing.newSessionTimingStart('dialog');
        timing.newSessionTimingRpcSent();
        timing.newSessionTimingRpcReturned('s2');
        timing.newSessionTimingComposerMounted('s1');
        expect(lines).toHaveLength(0);
        timing.newSessionTimingCancel();
        timing.newSessionTimingComposerMounted('s2');
        expect(lines).toHaveLength(0);
    });

    it('stays silent when reporting is disabled', () => {
        const report = vi.fn();
        timing.configureNewSessionTiming({ report, enabled: () => false });
        timing.newSessionTimingStart('quick');
        timing.newSessionTimingRpcReturned('s3');
        timing.newSessionTimingComposerMounted('s3');
        expect(report).not.toHaveBeenCalled();
        timing.configureNewSessionTiming({ report: (line) => lines.push(line), enabled: () => true });
    });

    it('formats unknown stages as ?', () => {
        expect(timing.formatNewSessionTiming('quick', 's', { click: 0, composer: 1200 }))
            .toBe('[new-session timing] quick s total=1200ms rpcSent=? rpc=? inStore=? composer=1200ms');
    });
});
