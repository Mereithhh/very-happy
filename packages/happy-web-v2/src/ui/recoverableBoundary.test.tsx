// @vitest-environment happy-dom
/**
 * B-565 RecoverableBoundary: a crash inside one row greys out only that row,
 * a resetKey change recovers it, chunk-load failures go to the route.
 */
import { act, Component, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecoverableBoundary } from './RecoverableBoundary';
import { BOUNDARY_COPY_MAX, boundaryErrorText, nextBoundaryState, shouldRethrowToRoute } from './recoverableBoundaryModel';

describe('recoverableBoundaryModel', () => {
    it('rethrows only lazy-chunk failures to the route boundary', () => {
        expect(shouldRethrowToRoute(new TypeError('Failed to fetch dynamically imported module: /assets/x.js'))).toBe(true);
        expect(shouldRethrowToRoute(new Error('Unable to preload CSS for /assets/y.css'))).toBe(true);
        expect(shouldRethrowToRoute(new TypeError("Cannot read properties of undefined (reading 'map')"))).toBe(false);
    });

    it('clears the error only when the reset key changes (Object.is)', () => {
        const key = { id: 'm1' };
        expect(nextBoundaryState({ error: new Error('x'), resetKey: key }, key)).toBeNull();
        expect(nextBoundaryState({ error: new Error('x'), resetKey: key }, { id: 'm1' })).toEqual({ error: null, resetKey: { id: 'm1' } });
        expect(nextBoundaryState({ error: null, resetKey: NaN }, NaN)).toBeNull();
    });

    it('builds a bounded copy payload carrying the region name', () => {
        const err = new TypeError('boom');
        const text = boundaryErrorText('message', err, '\n    at Row');
        expect(text.startsWith('[boundary:message] TypeError: boom')).toBe(true);
        expect(text).toContain('Component stack:\n    at Row');
        expect(boundaryErrorText('x', 'plain')).toBe('[boundary:x] Error: plain');
        const huge = new Error('y'.repeat(BOUNDARY_COPY_MAX * 2));
        expect(boundaryErrorText('x', huge).length).toBeLessThan(BOUNDARY_COPY_MAX + 32);
    });
});

function Row({ text }: { text: string | null }) {
    if (text === null) throw new TypeError('malformed row');
    return <p className="row">{text}</p>;
}

class Outer extends Component<{ children: ReactNode }, { error: unknown }> {
    state = { error: null as unknown };
    static getDerivedStateFromError(error: unknown) { return { error }; }
    render() { return this.state.error ? <div className="outer-caught">{String((this.state.error as Error).message)}</div> : this.props.children; }
}

describe('<RecoverableBoundary>', () => {
    let host: HTMLDivElement;
    let root: Root;
    let errorSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
        Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
        host = document.createElement('div');
        document.body.append(host);
        root = createRoot(host);
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(async () => {
        await act(async () => root.unmount());
        host.remove();
        errorSpy.mockRestore();
    });

    const list = (rows: Array<{ id: string; text: string | null }>) => (
        <div>
            {rows.map((r) => (
                <RecoverableBoundary key={r.id} region="message" resetKey={r} compact>
                    <Row text={r.text} />
                </RecoverableBoundary>
            ))}
        </div>
    );

    it('greys out only the crashing row; siblings keep rendering', async () => {
        await act(async () => root.render(list([{ id: 'a', text: 'first' }, { id: 'b', text: null }, { id: 'c', text: 'third' }])));
        expect([...host.querySelectorAll('.row')].map((n) => n.textContent)).toEqual(['first', 'third']);
        const fallback = host.querySelectorAll('[role="alert"]');
        expect(fallback).toHaveLength(1);
        expect(fallback[0].getAttribute('data-boundary')).toBe('message');
        expect(fallback[0].classList.contains('vh-boundary--compact')).toBe(true);
        expect(fallback[0].textContent).toContain('This content failed to render');
        // console carries the region name
        expect(errorSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes('[boundary:message]'))).toBe(true);
    });

    it('recovers automatically when the reset key changes (content fixed)', async () => {
        const broken = { id: 'b', text: null as string | null };
        await act(async () => root.render(list([{ id: 'a', text: 'first' }, broken])));
        expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
        // same key → stays in fallback
        await act(async () => root.render(list([{ id: 'a', text: 'first' }, broken])));
        expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
        // new object for the same id (reducer rebuilt it) → retried
        await act(async () => root.render(list([{ id: 'a', text: 'first' }, { id: 'b', text: 'fixed' }])));
        expect(host.querySelectorAll('[role="alert"]')).toHaveLength(0);
        expect([...host.querySelectorAll('.row')].map((n) => n.textContent)).toEqual(['first', 'fixed']);
    });

    it('retry button re-renders the subtree', async () => {
        let fail = true;
        function Flaky() { if (fail) throw new Error('once'); return <p className="row">ok</p>; }
        await act(async () => root.render(<RecoverableBoundary region="panel"><Flaky /></RecoverableBoundary>));
        const panel = host.querySelector('[role="alert"]')!;
        expect(panel.classList.contains('vh-boundary--panel')).toBe(true);
        fail = false;
        const retry = [...panel.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!;
        await act(async () => retry.click());
        expect(host.querySelector('.row')?.textContent).toBe('ok');
    });

    it('hands lazy-chunk failures to the route boundary (ChunkFailure path)', async () => {
        function Lazy(): ReactNode { throw new TypeError('Failed to fetch dynamically imported module: /assets/Mermaid-abc.js'); }
        await act(async () => root.render(<Outer><RecoverableBoundary region="mermaid" compact><Lazy /></RecoverableBoundary></Outer>));
        expect(host.querySelector('[role="alert"]')).toBeNull();
        expect(host.querySelector('.outer-caught')?.textContent).toContain('Failed to fetch dynamically imported module');
    });
});
