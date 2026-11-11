/**
 * B-922: Settings → Main agent → Safety renders the presets only for a machine
 * whose daemon advertises `mainAgentSafety`; otherwise the upgrade note (that
 * CLI runs strict); a note before a main agent machine exists.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';

let MainAgentSafetySection: typeof import('./MainAgentSafetySection').MainAgentSafetySection;
let ToastProvider: typeof import('@/ui/Toast').ToastProvider;
let AuthProvider: typeof import('@/auth/AuthContext').AuthProvider;

beforeAll(async () => {
    installBrowserTestGlobals();
    ({ ToastProvider } = await import('@/ui/Toast'));
    ({ AuthProvider } = await import('@/auth/AuthContext'));
    ({ MainAgentSafetySection } = await import('./MainAgentSafetySection'));
});

const machine = (flags: Record<string, unknown>) => ({
    id: 'm1', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1, metadata: null, metadataVersion: 1,
    daemonState: { startedAt: 10, ...flags }, daemonStateVersion: 1,
}) as any;
const render = (m: any) => renderToStaticMarkup(<AuthProvider initialCredentials={null}><ToastProvider><MainAgentSafetySection machine={m} /></ToastProvider></AuthProvider>);

describe('B-922 main agent safety section', () => {
    it('capability present: preset picker, advanced toggle, save', () => {
        const html = render(machine({ mainAgentSafety: { rpcAvailable: true, detectedAt: 20 } }));
        expect(html).toContain('data-setting-id="mainAgent.safety"');
        expect(html).toMatch(/Strict|严格/);
        expect(html).toMatch(/Standard|标准/);
        expect(html).toMatch(/Loose|宽松/);
        expect(html).toMatch(/Advanced|高级设置/);
        expect(html).toMatch(/Save safety settings|保存安全设置/);
    });

    it('older CLI (gates only, or a stale flag): upgrade note, no picker', () => {
        for (const flags of [{ mainAgentGates: { rpcAvailable: true, detectedAt: 20 } }, { mainAgentSafety: { rpcAvailable: true, detectedAt: 5 } }]) {
            const html = render(machine(flags));
            expect(html).toMatch(/too old|太旧/);
            expect(html).not.toMatch(/Save safety settings|保存安全设置/);
        }
    });

    it('no main agent machine yet: only a note (the anchor stays for settings search)', () => {
        const html = render(null);
        expect(html).toContain('data-setting-id="mainAgent.safety"');
        expect(html).toMatch(/Enable the main agent|先在上面选一台机器/);
        expect(html).not.toMatch(/Save safety settings|保存安全设置/);
    });
});
