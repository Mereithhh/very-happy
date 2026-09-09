// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuiltinTodoRecord } from '@/sync/builtinTodos';
import type { AuthCredentials } from '@/auth/tokenStorage';

const mocks = vi.hoisted(() => ({
    credentials: { token: 'test-account' },
    machines: [{ id: 'A', active: true }, { id: 'B', active: true }],
    client: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), move: vi.fn() },
    externalList: vi.fn(), externalCreate: vi.fn(), externalComplete: vi.fn(),
}));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ credentials: mocks.credentials }) }));
vi.mock('@/app/BackButton', () => ({ BackButton: () => null }));
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ lang: 'en', t: (key: string) => key }) }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://test.invalid' }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { onReconnected: () => () => {}, onRecovered: () => () => {} }, getHappyClientId: () => 'test-client' }));
vi.mock('@/sync/sync', () => ({ sync: { onResume: () => () => {} } }));
vi.mock('@/sync/kvUpdates', () => ({ onKvChanges: () => () => {} }));
vi.mock('@/sync/builtinTodos', async importOriginal => ({
    ...await importOriginal<typeof import('@/sync/builtinTodos')>(),
    createBuiltinTodoClient: () => mocks.client,
}));
vi.mock('@/sync/storage', async () => {
    const { useState } = await import('react');
    return {
        useAllMachines: () => mocks.machines,
        useLocalSettingMutable: (key: string) => useState(key === 'todoMachineId' ? 'A' : 'group'),
    };
});
vi.mock('@/sync/todoOps', () => ({
    machineTodoList: mocks.externalList, machineTodoCreate: mocks.externalCreate, machineTodoComplete: mocks.externalComplete,
}));
vi.mock('@/utils/machineUtils', () => ({ isMachineOnline: () => true, machineLabel: (machine: { id: string }) => machine.id }));
vi.mock('@/ui', () => ({
    EmptyState: () => null, OrbitLoader: () => null, Spinner: () => null, StatusDot: () => null,
    toast: { error: vi.fn() },
}));

import { TodosScreen } from './TodosScreen';
import { BuiltinTodosPanel } from './BuiltinTodosPanel';
import { ExternalTodosScreen } from './ExternalTodosScreen';

const todo: BuiltinTodoRecord = {
    schemaVersion: 1, id: '00000000-0000-4000-8000-000000000001', title: 'Server confirmed task',
    note: '', status: 'open', order: 1, createdAt: 1, updatedAt: 1, version: 0,
};
const list = (records: BuiltinTodoRecord[] = []) => ({ records, truncated: false, invalidCount: 0 });
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    for (const mock of Object.values(mocks.client)) mock.mockReset();
    mocks.client.list.mockResolvedValue(list());
    mocks.externalList.mockReset().mockResolvedValue({ ok: true, items: [], dropped: 0, truncated: false });
    mocks.externalCreate.mockReset().mockResolvedValue({ ok: true });
    mocks.externalComplete.mockReset().mockResolvedValue({ ok: true });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
});

function query<T extends Element>(selector: string): T {
    const element = host.querySelector<T>(selector);
    if (!element) throw new Error(`Missing test element: ${selector}`);
    return element;
}
async function type(input: HTMLInputElement, text: string) {
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}
async function clickText(text: string) {
    const button = [...host.querySelectorAll('button')].find(element => element.textContent === text);
    if (!button) throw new Error(`Missing button: ${text}`);
    await act(async () => button.click());
}
async function click(selector: string) { await act(async () => query<HTMLButtonElement>(selector).click()); }
async function submit(selector: string) {
    await act(async () => query<HTMLFormElement>(selector).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}
async function selectMachine(value: string) {
    await act(async () => {
        const select = query<HTMLSelectElement>('select[aria-label="todos.machine"]');
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
    });
}

// These are behavioral regressions over mounted React components, not source assertions.
describe('Todo source and write lifecycles', () => {
    it('loads external providers only after visiting and keeps each source draft across switches', async () => {
        await act(async () => root.render(<TodosScreen />));
        expect(mocks.externalList).not.toHaveBeenCalled();
        const builtinInput = query<HTMLInputElement>('input[aria-label="New todo"]');
        await type(builtinInput, 'Unsubmitted built-in draft');
        await clickText('External source');
        expect(mocks.externalList).toHaveBeenCalledTimes(1);
        expect(builtinInput.closest('[hidden]')).not.toBeNull();
        const externalInput = query<HTMLInputElement>('input[placeholder="todos.addPlaceholder"]');
        await type(externalInput, 'Unsubmitted external draft');
        await clickText('My todos');
        expect(query('input[aria-label="New todo"]')).toBe(builtinInput);
        expect(builtinInput.value).toBe('Unsubmitted built-in draft');
        await clickText('External source');
        expect(query('input[placeholder="todos.addPlaceholder"]')).toBe(externalInput);
        expect(externalInput.value).toBe('Unsubmitted external draft');
        expect(mocks.externalList).toHaveBeenCalledTimes(1);
        expect(mocks.client.create).not.toHaveBeenCalled();
        expect(mocks.externalCreate).not.toHaveBeenCalled();
    });

    it('keeps an unsaved edit when switching away from the built-in list', async () => {
        mocks.client.list.mockResolvedValue(list([todo]));
        await act(async () => root.render(<TodosScreen />));
        await click(`button[aria-label="Edit: ${todo.title}"]`);
        const editor = query<HTMLInputElement>('.td-editor input');
        await type(editor, 'My unsaved correction');
        await clickText('External source');
        await clickText('My todos');
        expect(query<HTMLInputElement>('.td-editor input').value).toBe('My unsaved correction');
        expect(mocks.client.update).not.toHaveBeenCalled();
    });

    it('renders a confirmed new task even when the following list request fails', async () => {
        mocks.client.list.mockResolvedValueOnce(list()).mockRejectedValue(new Error('read unavailable'));
        mocks.client.create.mockResolvedValue(todo);
        await act(async () => root.render(<BuiltinTodosPanel credentials={mocks.credentials as AuthCredentials} />));
        const input = query<HTMLInputElement>('input[aria-label="New todo"]');
        await type(input, todo.title);
        await submit('.td-compose');
        expect(mocks.client.create).toHaveBeenCalledWith(todo.title);
        expect(query('.td-item-title').textContent).toBe(todo.title);
        expect(input.value).toBe('');
        expect(query('[role="alert"]').textContent?.trim()).toBeTruthy();
    });

    it('keeps confirmed completion and deletion when subsequent refreshes fail', async () => {
        mocks.client.list.mockResolvedValueOnce(list([todo])).mockRejectedValue(new Error('read unavailable'));
        mocks.client.update.mockResolvedValue({ ...todo, status: 'done', version: 1 });
        mocks.client.remove.mockResolvedValue(undefined);
        await act(async () => root.render(<BuiltinTodosPanel credentials={mocks.credentials as AuthCredentials} />));
        await click(`button[aria-label="Complete: ${todo.title}"]`);
        expect(host.querySelector('.td-item-title')).toBeNull();
        await clickText('Completed · 1');
        expect(query('.td-item-title').textContent).toBe(todo.title);
        await click(`button[aria-label="Delete: ${todo.title}"]`);
        await clickText('Confirm delete');
        expect(host.querySelector('.td-item-title')).toBeNull();
        expect(mocks.client.remove).toHaveBeenCalledWith(expect.objectContaining({ status: 'done', version: 1 }));
    });

    it('does not let an old external A create clear a new A draft after A → B → A', async () => {
        let resolveCreate!: (value: { ok: true }) => void;
        mocks.externalCreate.mockReturnValue(new Promise(resolve => { resolveCreate = resolve; }));
        await act(async () => root.render(<ExternalTodosScreen />));
        await type(query<HTMLInputElement>('input[placeholder="todos.addPlaceholder"]'), 'First task on A');
        await submit('.td-compose');
        expect(mocks.externalCreate).toHaveBeenCalledWith('A', 'First task on A');
        await selectMachine('B');
        await selectMachine('A');
        const currentDraft = query<HTMLInputElement>('input[placeholder="todos.addPlaceholder"]');
        await type(currentDraft, 'New draft after returning to A');
        const readsBeforeOldResponse = mocks.externalList.mock.calls.length;
        await act(async () => resolveCreate({ ok: true }));
        expect(currentDraft.value).toBe('New draft after returning to A');
        expect(currentDraft.disabled).toBe(false);
        expect(mocks.externalList).toHaveBeenCalledTimes(readsBeforeOldResponse);
    });
});
