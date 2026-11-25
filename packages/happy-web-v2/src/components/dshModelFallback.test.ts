import { describe, expect, it } from 'vitest';
import { getAvailableModels, getLauncherModelModes } from './modelModeOptions';

describe('B-978: dsh without a catalog offers only the machine default', () => {
    const t = (key: string) => key as never;
    it('never falls through to the Claude list', () => {
        expect(getLauncherModelModes('dsh', [], t, null).map((m) => m.key)).toEqual(['default']);
        expect(getAvailableModels('dsh', { models: [] } as never, t).map((m) => m.key)).toEqual(['default']);
    });
    it('uses dsh’s own catalog once a session published one', () => {
        const metadata = { flavor: 'dsh', models: [{ code: 'deepseek-v4.1', value: 'DeepSeek V4.1' }] };
        expect(getAvailableModels('dsh', metadata as never, t).map((m) => m.key)).toEqual(['deepseek-v4.1']);
    });
});
