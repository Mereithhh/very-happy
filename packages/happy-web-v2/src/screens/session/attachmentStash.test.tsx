// @vitest-environment happy-dom
/** B-918: a pushed preview takes you from A to B; A's unsent attachments must be there when you come back. */
import { StrictMode, act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentPreview } from '@/sync/attachmentTypes';
import { takeStashedAttachments, useAttachments } from './useAttachments';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const revoked: string[] = [];
let host: HTMLDivElement;
let root: Root;
let api: ReturnType<typeof useAttachments> | null = null;

function Composer({ id }: { id: string }) {
    const a = useAttachments(id);
    useEffect(() => { api = a; });
    return <ul>{a.attachments.map((x) => <li key={x.id}>{x.uri}</li>)}</ul>;
}

const item = (n: number) => ({ id: `att-${n}`, uri: `blob:x/${n}`, name: `f${n}.png`, mimeType: 'image/png', size: 1 }) as unknown as AttachmentPreview;

beforeEach(() => {
    revoked.length = 0;
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u: string) => { revoked.push(u); });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); takeStashedAttachments('a'); takeStashedAttachments('b'); vi.restoreAllMocks(); });

const mount = (id: string, strict = false) => act(() => root.render(strict ? <StrictMode><Composer key={id} id={id}/></StrictMode> : <Composer key={id} id={id}/>));
const shown = () => Array.from(host.querySelectorAll('li')).map((li) => li.textContent);

describe('B-918 composer attachments survive leaving the session', () => {
    it('A → B → A keeps A’s attachments alive (not revoked) and never shows them in B', () => {
        mount('a');
        act(() => api!.restore([item(1), item(2)]));
        expect(shown()).toEqual(['blob:x/1', 'blob:x/2']);
        mount('b');                       // route switch: composer remounts keyed by session id
        expect(shown()).toEqual([]);
        expect(revoked).toEqual([]);
        mount('a');
        expect(shown()).toEqual(['blob:x/1', 'blob:x/2']);
    });

    it('under StrictMode the double mount neither loses nor duplicates them', () => {
        mount('a', true);
        act(() => api!.restore([item(3)]));
        mount('b', true);
        mount('a', true);
        expect(shown()).toEqual(['blob:x/3']);
        expect(revoked).toEqual([]);
    });

    it('removed or sent (taken) items are not parked', () => {
        mount('a');
        act(() => api!.restore([item(4), item(5)]));
        act(() => api!.remove('att-4'));
        act(() => { api!.take(); });
        mount('b');
        mount('a');
        expect(shown()).toEqual([]);
    });
});
