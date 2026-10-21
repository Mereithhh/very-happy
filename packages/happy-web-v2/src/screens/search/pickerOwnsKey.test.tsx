// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Combobox, SelectMenu } from '@/ui';
import { pickerOwnsKey } from './pickerOwnsKey';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; });

const key = (el: Element, k: string) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });
const OPTIONS = Array.from({ length: 10 }, (_, i) => ({ value: `p${i}`, label: `project ${i}` }));

/** The session-search panel's shape: Esc on the panel closes it unless a picker owns the key. */
function Panel({ onPanelEsc, searchable }: { onPanelEsc: () => void; searchable: boolean }) {
    const [v, setV] = useState('p0');
    const Picker = searchable ? Combobox : SelectMenu;
    return (
        <div onKeyDown={(e) => { if (pickerOwnsKey(e)) return; if (e.key === 'Escape') onPanelEsc(); }}>
            <Picker variant="chip" label="Project" value={v} onChange={setV} options={searchable ? OPTIONS : OPTIONS.slice(0, 4)} />
        </div>
    );
}

describe('B-714 session search: filter pickers keep their keys', () => {
    for (const searchable of [false, true]) {
        it(`Esc closes only the ${searchable ? 'searchable' : 'select-only'} picker; on a closed trigger it reaches the panel`, () => {
            const onPanelEsc = vi.fn();
            act(() => root.render(<Panel onPanelEsc={onPanelEsc} searchable={searchable} />));
            const trigger = host.querySelector<HTMLButtonElement>('[role="combobox"]')!;
            act(() => trigger.focus());
            key(trigger, 'ArrowDown');
            expect(trigger.getAttribute('aria-expanded')).toBe('true');
            const owner = searchable ? document.querySelector<HTMLInputElement>('.vh-picker-search')! : trigger;
            key(owner, 'ArrowDown');
            key(owner, 'Escape');
            expect(trigger.getAttribute('aria-expanded')).toBe('false');
            expect(onPanelEsc).not.toHaveBeenCalled();
            key(trigger, 'Escape');
            expect(onPanelEsc).toHaveBeenCalledTimes(1);
        });
    }
});
