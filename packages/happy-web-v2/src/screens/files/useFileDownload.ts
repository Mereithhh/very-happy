/**
 * One file's download lifecycle (B-562): machine check → chunked fs-read with
 * progress → blob URL → programmatic click, while KEEPING the blob URL so the
 * UI can offer a real `<a download>` as the gesture fallback (iOS ignores a
 * programmatic click that happens after an async read). The URL is revoked on
 * the next attempt and on unmount.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMachine } from '@/sync/storage';
import { isMachineOnline, machineLabel } from '@/utils/machineUtils';
import { createDownloadUrl, downloadFailureText, downloadFileName, readDownload, triggerDownload } from './fileDownload';

export type FileDownloadState =
    | { phase: 'idle' }
    | { phase: 'reading'; progress: number | null }
    | { phase: 'ready'; url: string; name: string; size: number }
    | { phase: 'failed'; message: string };

export function useFileDownload(machineId: string | null | undefined, path: string, zh: boolean) {
    const machine = useMachine(machineId ?? '');
    const [state, setState] = useState<FileDownloadState>({ phase: 'idle' });
    const alive = useRef(true);
    const run = useRef(0);
    const url = useRef<string | null>(null);
    const release = () => {
        if (url.current) URL.revokeObjectURL(url.current);
        url.current = null;
    };
    useEffect(() => {
        alive.current = true;
        return () => { alive.current = false; run.current++; release(); };
    }, []);

    const start = useCallback(async (preloaded?: Uint8Array) => {
        const id = ++run.current;
        const current = () => alive.current && run.current === id;
        release();
        const deliver = (bytes: Uint8Array) => {
            const next = createDownloadUrl(bytes, path);
            url.current = next;
            setState({ phase: 'ready', url: next, name: downloadFileName(path), size: bytes.byteLength });
            triggerDownload(next, path);
        };
        if (preloaded) { deliver(preloaded); return; }
        if (!machineId || !machine) { setState({ phase: 'failed', message: downloadFailureText({ kind: 'machine-unknown' }, zh) }); return; }
        if (!isMachineOnline(machine)) {
            setState({ phase: 'failed', message: downloadFailureText({ kind: 'machine-offline', machine: machineLabel(machine) }, zh) });
            return;
        }
        setState({ phase: 'reading', progress: null });
        try {
            const result = await readDownload(machineId, path, () => !current(), (loaded, total) => {
                if (current() && total > 0) setState({ phase: 'reading', progress: Math.min(loaded / total, 1) });
            });
            if (!current()) return;
            if (result.ok) deliver(result.bytes);
            else setState({ phase: 'failed', message: downloadFailureText({ kind: 'read', result }, zh) });
        } catch {
            if (current()) setState({ phase: 'failed', message: downloadFailureText({ kind: 'read', result: { ok: false, code: 'inconsistent' } }, zh) });
        }
    }, [machineId, machine, path, zh]);

    return { state, start, busy: state.phase === 'reading' };
}
