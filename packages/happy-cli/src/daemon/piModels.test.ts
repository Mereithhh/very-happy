import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  PI_LIST_MODELS_TIMEOUT_MS,
  createPiModelRefresher,
  detectPiModels,
  parsePiListModels,
  parsePiModelsJson,
  piListModelsCommand,
  relaunchModel,
} from './piModels';
import { sanitizeResumeModel } from './resumePrecheck';

const SAMPLE = [
  'provider  model       context  max-out  thinking  images',
  'fakehub   fake-large  200K     16.4K    yes       no    ',
  'fakehub   fake-small  128K     16.4K    no        no    ',
  'fakehub   fake-small  128K     16.4K    no        no    ',
  'bad;host  x;y         1K       1K       no        no    ',
  '',
].join('\n');

const MODELS_JSON = {
  providers: {
    fakehub: {
      models: [
        { id: 'fake-large', name: 'Fake Large', reasoning: true },
        { id: 'fake-small' },
        { id: '' },
      ],
    },
    'bad;host': { models: [{ id: 'x;y' }] },
  },
};

describe('parsePiListModels (B-978)', () => {
  it('reads provider/id codes, thinking support, and drops duplicates and unsafe ids', () => {
    expect(parsePiListModels(SAMPLE)).toEqual([
      { code: 'fakehub/fake-large', value: 'fakehub/fake-large', thinking: true },
      { code: 'fakehub/fake-small', value: 'fakehub/fake-small', thinking: false },
    ]);
  });

  it('returns nothing for the no-models warning or empty output', () => {
    expect(parsePiListModels('Warning: No models available. Use /login to log into a provider.\n')).toEqual([]);
    expect(parsePiListModels('')).toEqual([]);
  });
});

describe('parsePiModelsJson (B-978 fallback)', () => {
  it('reads the providers the user configured, with reasoning as thinking', () => {
    expect(parsePiModelsJson(MODELS_JSON)).toEqual([
      { code: 'fakehub/fake-large', value: 'fakehub/Fake Large', thinking: true },
      { code: 'fakehub/fake-small', value: 'fakehub/fake-small', thinking: false },
    ]);
  });

  it('is empty for a missing or malformed file', () => {
    expect(parsePiModelsJson(null)).toEqual([]);
    expect(parsePiModelsJson({})).toEqual([]);
    expect(parsePiModelsJson({ providers: [] })).toEqual([]);
  });
});

describe('piListModelsCommand (B-978: the path a spawn would use)', () => {
    it('uses the copy agentBinResolver found when `pi` is not on the daemon PATH', () => {
        const exists = (path: string) => path === '/opt/nvm/v24/bin/pi';
        expect(piListModelsCommand(['/opt/nvm/v24/bin'], exists, 'linux')).toBe('/opt/nvm/v24/bin/pi');
    });

    it('falls back to the daemon PATH name when no resolved dir holds pi', () => {
        expect(piListModelsCommand([], () => false, 'linux')).toBe('pi');
        expect(piListModelsCommand(['/opt/empty'], () => false, 'linux')).toBe('pi');
    });

    it('looks for the Windows launchers first', () => {
        const win = join('C:\\node', 'pi.cmd');
        const exists = (path: string) => path === win;
        expect(piListModelsCommand(['C:\\node'], exists, 'win32')).toBe(win);
    });
});

describe('detectPiModels (B-978)', () => {
  it('wraps the parsed table with the check time, daemon pid and source', async () => {
    const table = await detectPiModels(async () => SAMPLE, 123, 7, 'pi', () => null);
    expect(table).toMatchObject({ checkedAt: 123, daemonPid: 7, source: 'cli' });
    expect(table?.models.map((m) => m.code)).toEqual(['fakehub/fake-large', 'fakehub/fake-small']);
  });

  it('runs the command it was given (the resolver path, not a bare name)', async () => {
    const run = vi.fn(async () => SAMPLE);
    await detectPiModels(run, 1, 2, '/opt/nvm/v24/bin/pi', () => null);
    expect(run).toHaveBeenCalledWith('/opt/nvm/v24/bin/pi');
  });

  it('falls back to models.json when the command fails, and says so in the source', async () => {
    const table = await detectPiModels(async () => { throw new Error('ENOENT'); }, 5, 6, 'pi', () => MODELS_JSON);
    expect(table).toMatchObject({ checkedAt: 5, source: 'models-json' });
    expect(table?.models.map((m) => m.code)).toEqual(['fakehub/fake-large', 'fakehub/fake-small']);
  });

  it('falls back when the command prints nothing usable (old pi without --list-models)', async () => {
    const table = await detectPiModels(async () => 'error: unknown option --list-models', 1, 2, 'pi', () => MODELS_JSON);
    expect(table?.source).toBe('models-json');
  });

  it('is null when neither the command nor models.json gives a model, so nothing is published', async () => {
    expect(await detectPiModels(async () => { throw new Error('ENOENT'); }, 1, 2, 'pi', () => null)).toBeNull();
    expect(await detectPiModels(async () => '', 1, 2, 'pi', () => ({}))).toBeNull();
  });

  it('caps the list command at 10 seconds', () => {
    expect(PI_LIST_MODELS_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });
});

describe('createPiModelRefresher (B-978: cache, refresh on change, keep the last table)', () => {
    const table = (at: number) => ({ checkedAt: at, daemonPid: 1, source: 'cli' as const, models: [{ code: 'p/m', value: 'p/m', thinking: false }] });

    it('probes once, then only when the version, config or command changed or the table aged out', async () => {
        let clock = 0;
        let version = '1.6.0';
        const detect = vi.fn(async () => table(clock));
        const publish = vi.fn(async () => {});
        const refresh = createPiModelRefresher({
            detect, publish, log: () => {}, now: () => clock, maxAgeMs: 1000,
            key: () => ({ version, config: 'a', command: 'pi' }),
        });
        await refresh.refresh();
        expect(detect).toHaveBeenCalledTimes(1);
        await refresh.refresh();
        expect(detect).toHaveBeenCalledTimes(1);
        version = '1.7.0';
        await refresh.refresh();
        expect(detect).toHaveBeenCalledTimes(2);
        clock = 5000;
        await refresh.refresh();
        expect(detect).toHaveBeenCalledTimes(3);
    });

    it('keeps the last table when a probe fails, and retries next tick', async () => {
        const detect = vi.fn(async () => null as any);
        const publish = vi.fn(async () => {});
        const log = vi.fn();
        const refresh = createPiModelRefresher({ detect, publish, log, now: () => 1, key: () => ({ version: '1', config: 'a', command: 'pi' }) });
        await refresh.refresh();
        expect(publish).not.toHaveBeenCalled();
        expect(log).toHaveBeenCalledWith(expect.stringContaining('keeping the last one'));
        await refresh.refresh();
        expect(detect).toHaveBeenCalledTimes(2);
    });

    it('coalesces overlapping refreshes into one probe', async () => {
        const detect = vi.fn(async () => table(1));
        const refresh = createPiModelRefresher({ detect, publish: async () => {}, log: () => {}, now: () => 1, key: () => ({ version: '1', config: 'a', command: 'pi' }) });
        await Promise.all([refresh.refresh(), refresh.refresh(), refresh.refresh()]);
        expect(detect).toHaveBeenCalledTimes(1);
    });
});

describe('relaunchModel (B-978: a restored pi session keeps its model)', () => {

    it('Claude/Codex keep the resume sanitizer and its result', () => {
        expect(relaunchModel('opus[1m]', { flavor: 'claude' }, sanitizeResumeModel)).toBe('opus[1m]');
        expect(relaunchModel(undefined, { flavor: 'claude', currentModelCode: 'opus' }, sanitizeResumeModel)).toBeNull();
    });

    it('pi keeps an explicit provider/id', () => {
        expect(relaunchModel('fakehub/fake-small', { flavor: 'acp' }, sanitizeResumeModel)).toBe('fakehub/fake-small');
    });

    it('pi with no model sent (Web restore, auto-resume) reopens on the model it was running', () => {
        expect(relaunchModel(undefined, { flavor: 'acp', currentModelCode: 'fakehub/fake-large' }, sanitizeResumeModel)).toBe('fakehub/fake-large');
        expect(relaunchModel(undefined, { flavor: 'acp' }, sanitizeResumeModel)).toBeNull();
    });

    it('an invalid model is dropped, never replaced by the running one', () => {
        expect(relaunchModel('--evil', { flavor: 'acp', currentModelCode: 'fakehub/fake-large' }, sanitizeResumeModel)).toBeNull();
    });
});
