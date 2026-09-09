/**
 * B-370: Settings → Agents really renders a pi row whose model list is what pi
 * sessions published — behavioural render (installBrowserTestGlobals +
 * renderToStaticMarkup, the liveStreamRender/markdownRender precedent).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeAll, describe, expect, it } from 'vitest';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';

let SettingsRoutes: typeof import('./SettingsRoutes').SettingsRoutes;
let storage: typeof import('@/sync/storage').storage;
let ToastProvider: typeof import('@/ui/Toast').ToastProvider;

beforeAll(async () => {
    installBrowserTestGlobals();
    ({ storage } = await import('@/sync/storage'));
    ({ ToastProvider } = await import('@/ui/Toast'));
    ({ SettingsRoutes } = await import('./SettingsRoutes'));
});

const piSession = (id: string, updatedAt: number, models: string[]) => ({
    id,
    seq: 0,
    createdAt: updatedAt,
    updatedAt,
    active: true,
    activeAt: updatedAt,
    metadata: {
        path: '/tmp',
        host: 'mac',
        flavor: 'acp',
        models: models.map((code) => ({ code, value: code })),
        currentModelCode: models[0],
        operatingModes: ['off', 'medium'].map((code) => ({ code, value: `Thinking: ${code}` })),
    },
    metadataVersion: 1,
    agentState: null,
    agentStateVersion: 0,
    thinking: false,
    thinkingAt: 0,
    presence: 'online' as const,
    permissionMode: null,
    modelMode: null,
    effortLevel: null,
});

function renderAgents() {
    return renderToStaticMarkup(
        <ToastProvider>
            <MemoryRouter initialEntries={['/settings/agents']}>
                <Routes>
                    <Route path="/settings/*" element={<SettingsRoutes />} />
                </Routes>
            </MemoryRouter>
        </ToastProvider>,
    );
}

describe('Settings → Agents (B-370)', () => {
    it('renders a pi group with its own code defaults next to the other agents', () => {
        // renderToStaticMarkup reads zustand's SERVER snapshot (= the store's initial
        // state), so store mutations are invisible here; what this pins is that the
        // page iterates agentKeys and pi's row resolves the pi slot (yolo + default
        // model, no effort row) — override isolation is covered by agentDefaults.test.ts.
        const html = renderAgents();
        const groups = [...html.matchAll(/<div class="vh-itemgroup__title eyebrow">([^<]+)<\/div>/g)].map((m) => m[1]);
        expect(groups).toEqual(['New chat creation', 'claude', 'codex', 'gemini', 'openclaw', 'pi']);
        const piGroup = html.slice(html.indexOf('eyebrow">pi<'));
        expect(piGroup).toContain('<span class="vh-item__title">Permission</span></span><span class="vh-item__right"><span class="set-value">Auto-run (default)</span>');
        expect(piGroup).toContain('<span class="vh-item__title">Model</span></span><span class="vh-item__right"><span class="set-value">default model (default)</span>');
        expect(piGroup).not.toContain('<span class="vh-item__title">Effort</span>');
    });

    it('pi model options are the published registry (+ default), never Claude aliases', async () => {
        // The option list only mounts when a row is open, so assert it through the
        // same pure function the row calls, fed with real pi sessions in the store.
        const state = storage.getState();
        state.applyLoaded();
        state.applySessions([
            piSession('s-old', 1, ['zai/glm-5.3']) as any,
            piSession('s-new', 2, ['llm-hub/claude-fable-5-1', 'zai/glm-5.3']) as any,
        ]);
        state.applyReady();
        const { collectPiModelOptions } = await import('@/sync/piModelOptions');
        const sessions = Object.values(storage.getState().sessions);
        expect(sessions).toHaveLength(2);
        const keys = collectPiModelOptions(sessions, ['llm-hub/claude-fable-5-1']).map((o) => o.key);
        expect(keys).toEqual(['default', 'llm-hub/claude-fable-5-1', 'zai/glm-5.3']);
        expect(keys.some((k) => ['opus', 'sonnet', 'fable'].includes(k))).toBe(false);
    });
});
