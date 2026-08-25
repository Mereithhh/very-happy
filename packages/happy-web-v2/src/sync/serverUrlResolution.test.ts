import { describe, expect, it } from 'vitest';
import { resolveServerUrl } from './serverUrlResolution';

describe('resolveServerUrl', () => {
  it('resolves the standalone same-origin marker without falling back to the hosted relay', () => {
    expect(resolveServerUrl({
      isDev: false,
      runtime: 'same-origin',
      origin: 'https://self-host.example',
      fallback: 'https://veryhappy.dev',
    })).toBe('https://self-host.example');
  });

  it('keeps an explicit user-selected server ahead of injected defaults', () => {
    expect(resolveServerUrl({
      isDev: false,
      stored: 'https://chosen.example',
      runtime: 'same-origin',
      origin: 'https://web.example',
      fallback: 'https://veryhappy.dev',
    })).toBe('https://chosen.example');
  });
});
