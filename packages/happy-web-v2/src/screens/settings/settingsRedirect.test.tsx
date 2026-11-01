// @vitest-environment happy-dom
/**
 * B-850c: /settings/agents and /settings/models open the merged 模型与账号 page
 * under every settings mount, keeping the query (?machine=, ?setting=) and hash.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { LEGACY_SETTINGS_REDIRECTS, MODELS_ACCOUNTS_PATH, SettingsRedirect } from './settingsRedirect';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let seen = '';
function Probe() {
    const location = useLocation();
    seen = `${location.pathname}${location.search}${location.hash}`;
    return null;
}
/** Same shape as AppRoot → SettingsRoutes: a `<mount>/*` parent with relative child routes. */
function mount(mountPath: string, entry: string) {
    const el = document.createElement('div');
    document.body.appendChild(el);
    root = createRoot(el);
    act(() => root!.render(
        <MemoryRouter initialEntries={[entry]}>
            <Probe />
            <Routes>
                <Route path={`${mountPath}/*`} element={<Routes>
                    <Route path={MODELS_ACCOUNTS_PATH} element={<div data-page />} />
                    {Object.entries(LEGACY_SETTINGS_REDIRECTS).map(([from, to]) => <Route key={from} path={from} element={<SettingsRedirect to={to} />} />)}
                </Routes>} />
            </Routes>
        </MemoryRouter>,
    ));
}
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ''; });

describe('B-850c legacy settings redirects', () => {
    for (const mountPath of ['/settings', '/dev/settings', '/dev/device/settings']) {
        for (const from of ['agents', 'models']) {
            it(`${mountPath}/${from} → ${mountPath}/${MODELS_ACCOUNTS_PATH} (query + hash kept)`, () => {
                mount(mountPath, `${mountPath}/${from}?machine=m1&setting=models.machine#x`);
                expect(seen).toBe(`${mountPath}/${MODELS_ACCOUNTS_PATH}?machine=m1&setting=models.machine#x`);
                expect(document.querySelector('[data-page]')).not.toBeNull();
            });
        }
    }

    it('SettingsRoutes mounts the merged page and the redirect table', () => {
        const src = readFileSync(join(process.cwd(), 'src/screens/settings/SettingsRoutes.tsx'), 'utf8');
        expect(src).toContain('<Route path={MODELS_ACCOUNTS_PATH} element={<ModelsAndAccounts />} />');
        expect(src).toContain('Object.entries(LEGACY_SETTINGS_REDIRECTS).map(([from, to]) => <Route key={from} path={from} element={<SettingsRedirect to={to} />} />)');
        expect(src).not.toContain('<Route path="agents" element={<Agents />} />');
    });
});
