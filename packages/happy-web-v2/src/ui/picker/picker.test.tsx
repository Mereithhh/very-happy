// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Picker, type PickerOption, type PickerText } from './Picker';
import {
    filterOptions,
    groupOptions,
    highlightRuns,
    initialActive,
    moveActive,
    orderedOptions,
    shouldShowSearch,
    typeaheadMatch,
} from './pickerModel';

/**
 * B-714 — SelectMenu / Combobox replace every native <select>. Pins the
 * keyboard model, groups, disabled rows, form value, ARIA wiring and the phone
 * bottom sheet on the real component (happy-dom + Radix).
 */

const TEXT: PickerText = { search: 'Search', empty: 'No matches', loading: 'Loading', retry: 'Retry', required: 'Pick one' };

const MACHINES: PickerOption[] = [
    { value: 'm1', label: 'build-box', meta: 'online' },
    { value: 'm2', label: 'mac-office', disabled: true, description: 'offline · 2h ago' },
    { value: 'm3', label: 'dev-sg' },
    { value: 'm4', label: 'dog-hk' },
];

describe('pickerModel', () => {
    it('moveActive skips disabled rows and stops at the ends (no wrap)', () => {
        expect(moveActive(MACHINES, 0, 1)).toBe(2);
        expect(moveActive(MACHINES, 2, -1)).toBe(0);
        expect(moveActive(MACHINES, 3, 1)).toBe(3);
        expect(moveActive(MACHINES, 0, -1)).toBe(0);
        expect(moveActive(MACHINES, -1, 1)).toBe(0);
    });

    it('initialActive: the selected option, or the first enabled one when it is disabled/missing', () => {
        expect(initialActive(MACHINES, 'm3')).toBe(2);
        expect(initialActive(MACHINES, 'm2')).toBe(0);
        expect(initialActive(MACHINES, null)).toBe(0);
    });

    it('typeahead: prefix match from after the current row, wrapping; repeated letter cycles; disabled skipped', () => {
        expect(typeaheadMatch(MACHINES, 'd', 0)).toBe(2);
        expect(typeaheadMatch(MACHINES, 'dd', 2)).toBe(3);
        expect(typeaheadMatch(MACHINES, 'ddd', 3)).toBe(2);
        expect(typeaheadMatch(MACHINES, 'do', 2)).toBe(3);
        expect(typeaheadMatch(MACHINES, 'm', 0)).toBe(-1); // mac-office is disabled
        expect(typeaheadMatch(MACHINES, '', 0)).toBe(-1);
    });

    it('filter matches label / description / meta / keywords case-insensitively; highlight marks the hit', () => {
        expect(filterOptions(MACHINES, 'BOX').map((o) => o.value)).toEqual(['m1']);
        expect(filterOptions(MACHINES, 'offline').map((o) => o.value)).toEqual(['m2']);
        expect(filterOptions([{ value: 'x', label: 'Opus', keywords: 'claude-opus' }], 'claude').length).toBe(1);
        expect(highlightRuns('dev-sg', 'V-S')).toEqual([{ text: 'de', match: false }, { text: 'v-s', match: true }, { text: 'g', match: false }]);
    });

    it('groups keep first-seen order, ungrouped first; navigation order follows the render order', () => {
        const opts: PickerOption[] = [
            { value: 'c1', label: 'custom', group: 'Custom' },
            { value: 'd', label: 'default' },
            { value: 'k1', label: 'opus', group: 'Catalog' },
            { value: 'c2', label: 'custom2', group: 'Custom' },
        ];
        expect(groupOptions(opts).map((g) => g.label)).toEqual(['', 'Custom', 'Catalog']);
        expect(orderedOptions(opts).map((o) => o.value)).toEqual(['d', 'c1', 'c2', 'k1']);
    });

    it('search shows automatically above 8 options', () => {
        expect(shouldShowSearch('auto', 8)).toBe(false);
        expect(shouldShowSearch('auto', 9)).toBe(true);
        expect(shouldShowSearch(false, 50)).toBe(false);
    });
});

let host: HTMLDivElement;
let root: Root;
let sheetMatches = false;
beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    sheetMatches = false;
    vi.stubGlobal('matchMedia', (q: string) => ({
        matches: q.includes('max-width: 600px') ? sheetMatches : false,
        media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
    }));
    window.matchMedia = globalThis.matchMedia;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
});

function render(node: React.ReactNode) {
    act(() => root.render(node));
}
function key(el: Element, k: string, init: KeyboardEventInit = {}) {
    act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })); });
}
const trigger = () => document.querySelector<HTMLButtonElement>('.vh-select-trigger')!;
const listbox = () => document.querySelector<HTMLElement>('[role="listbox"]');
const activeOption = (owner: Element) => {
    const id = owner.getAttribute('aria-activedescendant');
    return id ? document.getElementById(id) : null;
};

function Controlled(props: { options: PickerOption[]; initial?: string | null; onChange?: (v: string) => void; searchable?: boolean | 'auto'; name?: string; required?: boolean }) {
    const { options, initial = null, onChange, ...rest } = props;
    const [value, setValue] = useState<string | null>(initial);
    return <Picker {...rest} label="Machine" text={TEXT} options={options} value={value} onChange={(v) => { setValue(v); onChange?.(v); }} />;
}

describe('SelectMenu (no search) — popover', () => {
    it('trigger is a select-only combobox; ↓ opens with the selected row highlighted; focus stays on the trigger', () => {
        render(<Controlled options={MACHINES} initial="m3" />);
        const t = trigger();
        expect(t.getAttribute('role')).toBe('combobox');
        expect(t.getAttribute('aria-haspopup')).toBe('listbox');
        expect(t.getAttribute('aria-expanded')).toBe('false');
        expect(t.getAttribute('aria-label')).toBe('Machine');
        expect(t.textContent).toContain('dev-sg');
        act(() => t.focus());
        key(t, 'ArrowDown');
        expect(t.getAttribute('aria-expanded')).toBe('true');
        expect(listbox()).not.toBeNull();
        expect(t.getAttribute('aria-controls')).toBe(listbox()!.id);
        expect(activeOption(t)?.textContent).toContain('dev-sg');
        expect(activeOption(t)?.getAttribute('aria-selected')).toBe('true');
        expect(document.activeElement).toBe(t);
    });

    it('↑↓ skip the disabled row, Home/End jump, Enter chooses and closes', () => {
        const onChange = vi.fn();
        render(<Controlled options={MACHINES} initial="m1" onChange={onChange} />);
        const t = trigger();
        key(t, 'ArrowDown');
        key(t, 'ArrowDown');
        expect(activeOption(t)?.textContent).toContain('dev-sg'); // skipped mac-office
        key(t, 'End');
        expect(activeOption(t)?.textContent).toContain('dog-hk');
        key(t, 'Home');
        expect(activeOption(t)?.textContent).toContain('build-box');
        key(t, 'ArrowDown');
        key(t, 'Enter');
        expect(onChange).toHaveBeenCalledWith('m3');
        expect(t.getAttribute('aria-expanded')).toBe('false');
        expect(t.textContent).toContain('dev-sg');
    });

    it('disabled rows are aria-disabled, show their reason, and ignore clicks', () => {
        const onChange = vi.fn();
        render(<Controlled options={MACHINES} onChange={onChange} />);
        key(trigger(), 'ArrowDown');
        const disabled = [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent?.includes('mac-office'))!;
        expect(disabled.getAttribute('aria-disabled')).toBe('true');
        expect(disabled.textContent).toContain('offline · 2h ago');
        act(() => { (disabled as HTMLElement).click(); });
        expect(onChange).not.toHaveBeenCalled();
    });

    it('typeahead on the trigger opens and jumps to the match', () => {
        render(<Controlled options={MACHINES} initial="m1" />);
        const t = trigger();
        key(t, 'd');
        expect(t.getAttribute('aria-expanded')).toBe('true');
        expect(activeOption(t)?.textContent).toContain('dev-sg');
        key(t, 'o');
        expect(activeOption(t)?.textContent).toContain('dog-hk');
    });

    it('Esc closes without choosing; Space chooses', () => {
        const onChange = vi.fn();
        render(<Controlled options={MACHINES} initial="m1" onChange={onChange} />);
        const t = trigger();
        key(t, 'ArrowDown');
        key(t, 'Escape');
        expect(t.getAttribute('aria-expanded')).toBe('false');
        expect(onChange).not.toHaveBeenCalled();
        key(t, ' ');
        key(t, 'End');
        key(t, ' ');
        expect(onChange).toHaveBeenCalledWith('m4');
    });

    it('Tab closes the list without choosing', () => {
        const onChange = vi.fn();
        render(<Controlled options={MACHINES} initial="m1" onChange={onChange} />);
        const t = trigger();
        key(t, 'ArrowDown');
        key(t, 'ArrowDown');
        key(t, 'Tab');
        expect(t.getAttribute('aria-expanded')).toBe('false');
        expect(onChange).not.toHaveBeenCalled();
    });

    it('groups render as role=group named by their heading', () => {
        render(<Controlled options={[
            { value: 'default', label: 'Default' },
            { value: 'opus', label: 'Opus', group: 'Catalog' },
            { value: 'mine', label: 'my-model', group: 'Custom' },
        ]} />);
        key(trigger(), 'ArrowDown');
        const groups = [...document.querySelectorAll('[role="group"]')];
        expect(groups.map((g) => document.getElementById(g.getAttribute('aria-labelledby')!)?.textContent)).toEqual(['Catalog', 'Custom']);
        expect(groups[1].querySelector('[role="option"]')?.textContent).toContain('my-model');
    });

    it('name puts the value in FormData; required blocks submit with an inline error instead of the browser bubble', () => {
        const submitted: (string | null)[] = [];
        render(<form onSubmit={(e) => { e.preventDefault(); submitted.push(new FormData(e.currentTarget).get('assistant') as string | null); }}>
            <Controlled options={MACHINES} name="assistant" required />
            <button type="submit">go</button>
        </form>);
        const form = document.querySelector('form')!;
        const proxy = document.querySelector<HTMLInputElement>('[data-vh-picker-proxy]')!;
        expect(proxy.required).toBe(true);
        let valid = true;
        act(() => { valid = form.checkValidity(); });
        expect(valid).toBe(false);
        expect(document.querySelector('.vh-picker-required')?.textContent).toBe('Pick one');
        expect(trigger().getAttribute('aria-invalid')).toBe('true');
        key(trigger(), 'ArrowDown');
        key(trigger(), 'Enter');
        expect(document.querySelector('.vh-picker-required')).toBeNull();
        act(() => { valid = form.checkValidity(); });
        expect(valid).toBe(true);
        act(() => { form.requestSubmit(); });
        expect(submitted).toEqual(['m1']);
    });
});

describe('inside a native modal <dialog>', () => {
    it('portals the popup into the dialog (outside the top layer is inert)', () => {
        render(<dialog open><Controlled options={MACHINES} /></dialog>);
        key(trigger(), 'ArrowDown');
        expect(listbox()?.closest('dialog')).toBe(document.querySelector('dialog'));
    });
});

describe('Combobox (search) — popover', () => {
    const MANY: PickerOption[] = Array.from({ length: 12 }, (_, i) => ({ value: `b${i}`, label: i === 7 ? 'feature/select-menu' : `branch-${i}` }));

    it('auto search above 8 options: focus moves to the search combobox, typing filters and highlights, Enter picks', () => {
        const onChange = vi.fn();
        render(<Controlled options={MANY} searchable="auto" onChange={onChange} />);
        key(trigger(), 'ArrowDown');
        const search = document.querySelector<HTMLInputElement>('.vh-picker-search')!;
        expect(search).not.toBeNull();
        expect(search.getAttribute('role')).toBe('combobox');
        expect(search.getAttribute('aria-controls')).toBe(listbox()!.id);
        expect(document.activeElement).toBe(search);
        act(() => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
            setter.call(search, 'SELECT');
            search.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const rows = document.querySelectorAll('[role="option"]');
        expect(rows.length).toBe(1);
        expect(rows[0].querySelector('mark')?.textContent).toBe('select');
        expect(activeOption(search)).toBe(rows[0]);
        key(search, 'Enter');
        expect(onChange).toHaveBeenCalledWith('b7');
    });

    it('no match shows the empty line; a space types into the query instead of choosing', () => {
        const onChange = vi.fn();
        render(<Controlled options={MANY} searchable onChange={onChange} />);
        key(trigger(), 'ArrowDown');
        const search = document.querySelector<HTMLInputElement>('.vh-picker-search')!;
        key(search, ' ');
        expect(onChange).not.toHaveBeenCalled();
        act(() => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
            setter.call(search, 'zzz');
            search.dispatchEvent(new Event('input', { bubbles: true }));
        });
        expect(document.querySelector('.vh-picker-state')?.textContent).toBe('No matches');
    });

    it('loading, error + retry and trailing action rows', () => {
        const retry = vi.fn();
        const create = vi.fn();
        render(<Picker label="Provider" text={TEXT} options={[]} value={null} onChange={() => undefined} loading />);
        key(trigger(), 'ArrowDown');
        expect(document.querySelector('.vh-picker-state')?.textContent).toContain('Loading');
        render(<Picker label="Provider" text={TEXT} options={[]} value={null} onChange={() => undefined} error="boom" onRetry={retry} />);
        const retryButton = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!;
        act(() => retryButton.click());
        expect(retry).toHaveBeenCalled();
        render(<Picker label="Provider" text={TEXT} options={[{ value: 'a', label: 'anthropic' }]} value={null} onChange={() => undefined}
            actions={[{ key: 'new', label: 'New provider…', onSelect: create }]} />);
        const t = trigger();
        key(t, 'End');
        expect(activeOption(t)?.textContent).toContain('New provider…');
        key(t, 'Enter');
        expect(create).toHaveBeenCalled();
    });

    it('busy swaps the chevron for a spinner (same slot)', () => {
        render(<Picker label="Model" text={TEXT} options={MACHINES} value="m1" onChange={() => undefined} busy />);
        expect(trigger().getAttribute('aria-busy')).toBe('true');
        expect(document.querySelector('.vh-select-chevron .vh-spinner')).not.toBeNull();
    });
});

describe('phone bottom sheet (coarse, ≤600px)', () => {
    it('opens a dialog titled with the field name; the listbox owns the highlight; picking closes and refocuses the trigger', async () => {
        sheetMatches = true;
        const onChange = vi.fn();
        render(<Controlled options={MACHINES} initial="m1" onChange={onChange} />);
        act(() => trigger().click());
        const dialog = document.querySelector('[role="dialog"]')!;
        expect(dialog).not.toBeNull();
        expect(dialog.classList.contains('vh-picker-sheet')).toBe(true);
        expect(dialog.querySelector('.vh-picker-sheet-title')?.textContent).toBe('Machine');
        expect(document.querySelector('.vh-picker-scrim')).not.toBeNull();
        const list = listbox()!;
        expect(document.activeElement).toBe(list);
        expect(activeOption(list)?.textContent).toContain('build-box');
        key(list, 'ArrowDown');
        expect(activeOption(list)?.textContent).toContain('dev-sg');
        const dog = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.includes('dog-hk'))!;
        act(() => dog.click());
        expect(onChange).toHaveBeenCalledWith('m4');
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        // Radix FocusScope restores focus on a 0ms timer after unmount
        await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
        expect(document.activeElement).toBe(trigger());
    });

    it('a sheet with search focuses the search box', () => {
        sheetMatches = true;
        render(<Controlled options={MACHINES} searchable />);
        act(() => trigger().click());
        expect(document.activeElement?.classList.contains('vh-picker-search')).toBe(true);
    });

    it('swiping the header down past the threshold closes it', () => {
        sheetMatches = true;
        render(<Controlled options={MACHINES} />);
        act(() => trigger().click());
        const head = document.querySelector('.vh-picker-sheet-head')!;
        act(() => { head.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientY: 100 })); });
        act(() => { head.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientY: 200 })); });
        act(() => { head.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientY: 200 })); });
        expect(document.querySelector('[role="dialog"]')).toBeNull();
    });
});
