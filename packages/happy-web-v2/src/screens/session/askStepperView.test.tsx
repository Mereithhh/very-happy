// @vitest-environment happy-dom
/**
 * B-564: the stepper submits exactly what the old batched form submitted.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/ui', () => ({
    Button: ({ children, disabled, onClick }: { children: React.ReactNode; disabled?: boolean; onClick?: () => void }) => (
        <button type="button" data-btn disabled={disabled} onClick={onClick}>{children}</button>
    ),
}));
import { AskUserQuestionOptions } from './AskUserQuestionView';
import { buildQuestionAnswers, type AskQuestion } from './askUserQuestion';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const questions: AskQuestion[] = [
    { question: 'Which DB?', header: 'DB', options: [{ label: 'Postgres' }, { label: 'SQLite' }] },
    { question: 'Which tools?', header: 'Tools', multiSelect: true, options: [{ label: 'lint' }, { label: 'test' }] },
    { question: 'Deploy?', options: [{ label: 'Yes' }, { label: 'No' }] },
];

let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ''; vi.useRealTimers(); });

function mount(qs: AskQuestion[], props: Partial<Parameters<typeof AskUserQuestionOptions>[0]> = {}) {
    const onSubmit = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<AskUserQuestionOptions questions={qs} disabled={false} onSubmit={onSubmit} {...props} />));
    return { host, onSubmit };
}
const visiblePane = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('.tv-ask-pane')].find((p) => !p.hidden)!;
const option = (host: HTMLElement, label: string) =>
    [...visiblePane(host).querySelectorAll<HTMLButtonElement>('.tv-ask-opt')].find((b) => b.textContent?.includes(label))!;
const navButton = (host: HTMLElement, key: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('.tv-ask-nav button')].find((b) => b.textContent === key)!;

describe('B-564 multi-question stepper', () => {
    it('shows one question at a time with step tabs', () => {
        const { host } = mount(questions);
        expect(host.querySelectorAll('.tv-ask-step')).toHaveLength(3);
        expect(host.querySelector('[aria-current="step"]')?.textContent).toContain('DB');
        expect(visiblePane(host).textContent).toContain('Which DB?');
        expect(navButton(host, 'tools.askUserQuestion.next').disabled).toBe(true);
    });

    it('single-select auto-advances, multi-select does not, last step submits the old payload', () => {
        vi.useFakeTimers();
        const { host, onSubmit } = mount(questions);
        act(() => option(host, 'SQLite').click());
        act(() => { vi.advanceTimersByTime(200); });
        expect(visiblePane(host).textContent).toContain('Which tools?');
        act(() => option(host, 'lint').click());
        act(() => option(host, 'test').click());
        act(() => { vi.advanceTimersByTime(500); });
        expect(visiblePane(host).textContent).toContain('Which tools?');
        act(() => navButton(host, 'tools.askUserQuestion.next').click());
        act(() => option(host, 'No').click());
        act(() => { vi.advanceTimersByTime(500); });
        expect(onSubmit).not.toHaveBeenCalled(); // the last question never auto-submits
        act(() => navButton(host, 'tools.askUserQuestion.submit').click());
        expect(onSubmit).toHaveBeenCalledWith(buildQuestionAnswers(questions, { 0: ['SQLite'], 1: ['lint', 'test'], 2: ['No'] }));
        expect(onSubmit.mock.calls[0][0]).toEqual({ 'Which DB?': 'SQLite', 'Which tools?': 'lint, test', 'Deploy?': 'No' });
    });

    it('previous goes back and keeps answers; a tab click cancels a pending auto-advance', () => {
        vi.useFakeTimers();
        const { host } = mount(questions);
        act(() => option(host, 'Postgres').click());
        act(() => (host.querySelectorAll<HTMLButtonElement>('.tv-ask-step')[2]).click());
        act(() => { vi.advanceTimersByTime(500); });
        expect(visiblePane(host).textContent).toContain('Deploy?');
        act(() => navButton(host, 'tools.askUserQuestion.previous').click());
        act(() => navButton(host, 'tools.askUserQuestion.previous').click());
        expect(option(host, 'Postgres').className).toContain('tv-ask-opt--selected');
    });

    it('a single question keeps the immediate click-to-submit behaviour', () => {
        const { host, onSubmit } = mount([questions[0]]);
        expect(host.querySelector('.tv-ask-steps')).toBeNull();
        act(() => [...host.querySelectorAll<HTMLButtonElement>('.tv-ask-opt')].find((b) => b.textContent?.includes('Postgres'))!.click());
        expect(onSubmit).toHaveBeenCalledWith({ 'Which DB?': 'Postgres' });
    });

    it('a stacked read-only receipt keeps every question visible', () => {
        const { host } = mount(questions, { disabled: true, stacked: true, selected: ['SQLite'] });
        expect(host.querySelector('.tv-ask-steps')).toBeNull();
        expect(host.querySelectorAll('.tv-ask-q')).toHaveLength(3);
    });
});
