// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// B-562: the viewer's "cannot preview" state, the pushed download bar and the
// byte path from fs-read chunks to the saved blob.
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key, lang: 'en' }) }));
vi.mock('@/ui', () => ({ Spinner: () => null }));
vi.mock('@/ui/CopyButton', () => ({ CopyButton: () => null }));
vi.mock('../session/CodeView', () => ({ CodeView: () => null }));
vi.mock('../session/Markdown', () => ({ Markdown: () => null }));
vi.mock('./SpreadsheetPreview', () => ({ SpreadsheetPreview: () => null }));
const state = vi.hoisted(() => ({ machine: { id: 'm', active: true, metadata: { host: 'box' } } as any, size: 6 }));
vi.mock('@/sync/storage', () => ({ useMachine: () => state.machine, useSessionMessages: () => ({ messages: [] }), useSession: () => null }));
vi.mock('@/utils/machineUtils', () => ({ isMachineOnline: (m: any) => m.active, machineLabel: (m: any) => m.metadata.host }));
const BYTES = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00]);
const machineFsRead = vi.hoisted(() => vi.fn());
vi.mock('@/sync/fsOps', () => ({ machineFsRead }));

import { FsFileViewer } from './FsFileViewer';
import { setDownloadIntent, peekDownloadIntent } from './downloadIntent';

let host: HTMLDivElement; let root: Root;
let blobs: Blob[]; let clicks: Array<{ href: string; download: string }>;
beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    state.machine = { id: 'm', active: true, metadata: { host: 'box' } };
    state.size = BYTES.length;
    machineFsRead.mockReset();
    machineFsRead.mockImplementation(async (_m: string, _p: string, opts: { allowBinary?: boolean; offset?: number }) => {
        if (!opts.allowBinary) return { ok: true, binary: true, content: null, size: state.size, truncated: true };
        const at = opts.offset ?? 0;
        const part = BYTES.slice(at, at + 4); // two windows → exercises chunk assembly
        return { ok: true, binary: true, content: Buffer.from(part).toString('base64'), size: BYTES.length, offset: at, truncated: at + part.length < BYTES.length };
    });
    blobs = []; clicks = [];
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: (b: Blob) => { blobs.push(b); return `blob:test/${blobs.length}`; }, revokeObjectURL: () => {} }));
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicks.push({ href: this.getAttribute('href')!, download: this.download }); });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

const props = { machineId: 'm', path: '/repo/out.zip', onClose: () => {}, fullscreen: false, onToggleFullscreen: () => {} };
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };
const button = (text: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.includes(text));

describe('B-562 viewer download', () => {
    it('shows "cannot preview" with a large download button and saves the exact bytes', async () => {
        await act(async () => root.render(<FsFileViewer {...props} />));
        await flush();
        expect(host.textContent).toContain('This file type cannot be previewed');
        const big = button('Download out.zip')!;
        expect(big.textContent).toContain('6 B');
        await act(async () => big.click());
        await flush();
        expect(clicks).toEqual([{ href: 'blob:test/1', download: 'out.zip' }]);
        expect(new Uint8Array(await blobs[0].arrayBuffer())).toEqual(BYTES);
        expect(blobs[0].type).toBe('application/zip');
        // The real-link gesture fallback stays available (iOS).
        const save = host.querySelector<HTMLAnchorElement>('a.fdl-save')!;
        expect(save.getAttribute('href')).toBe('blob:test/1');
        expect(save.download).toBe('out.zip');
    });

    it('explains the 50 MiB limit instead of offering a button that cannot work', async () => {
        state.size = 60 * 1024 * 1024;
        await act(async () => root.render(<FsFileViewer {...props} />));
        await flush();
        expect(host.textContent).toContain('50 MiB');
        expect(host.textContent).toContain('split');
        expect(button('Download out.zip')).toBeUndefined();
    });

    it('a pushed download intent shows the bar, auto-downloads once (desktop) and is consumed', async () => {
        setDownloadIntent({ machineId: 'm', path: '/repo/out.zip', auto: true });
        await act(async () => root.render(<FsFileViewer {...props} />));
        await flush();
        expect(peekDownloadIntent()).toBeNull();
        expect(host.querySelector('.fdl--bar')).not.toBeNull();
        expect(host.querySelector('.fdl--block')).toBeNull(); // no duplicate big button in the body
        expect(clicks).toHaveLength(1);
        await act(async () => root.render(<FsFileViewer {...props} />));
        await flush();
        expect(clicks).toHaveLength(1);
    });

    it('without auto (phones) the bar waits for a tap; an intent for another file is ignored', async () => {
        setDownloadIntent({ machineId: 'm', path: '/repo/other.zip', auto: true });
        await act(async () => root.render(<FsFileViewer {...props} />));
        await flush();
        expect(host.querySelector('.fdl--bar')).toBeNull();
        setDownloadIntent({ machineId: 'm', path: '/repo/out.zip', auto: false });
        await flush();
        expect(host.querySelector('.fdl--bar')).not.toBeNull();
        expect(clicks).toHaveLength(0);
    });

    it('an offline machine gets a clear error and no read', async () => {
        await act(async () => root.render(<FsFileViewer {...props} />));
        await flush();
        state.machine = { ...state.machine, active: false };
        await act(async () => root.render(<FsFileViewer {...props} path="/repo/out.zip" />));
        machineFsRead.mockClear();
        await act(async () => button('Download out.zip')!.click());
        await flush();
        expect(host.textContent).toContain('box is offline');
        expect(machineFsRead).not.toHaveBeenCalled();
    });
});
