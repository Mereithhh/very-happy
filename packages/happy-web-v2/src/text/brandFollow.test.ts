/**
 * B-637: on a white-labelled relay (B-624 `BRAND_NAME`) every string `t()`
 * returns names the operator's product, so copy such as the first-machine
 * intro or test notifications never say "Very Happy".
 */
import { describe, it, expect } from 'vitest';

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};
(globalThis as any).__HAPPY_CONFIG__ = { brand: { name: 'Apodex Vibe' } };

const { t, setLanguage } = await import('./index');

describe('B-637 t() follows the brand', () => {
  it('renames the product in plain strings and in parametrised strings', async () => {
    await setLanguage('en');
    expect(t('onboarding.intro')).toBe('Apodex Vibe runs the coding agent on your computer and lets this Web UI control it through your account.');
    expect(t('notifications.testPushTitle')).toBe('Apodex Vibe · Test notification');
    expect(t('onboarding.intro')).not.toContain('very happy');
  });

  it('applies to translations too', async () => {
    await setLanguage('zh-Hans');
    expect(t('onboarding.intro')).toBe('Apodex Vibe 在你的电脑上运行 coding agent，再通过当前账号让这个 Web 界面控制它。');
    await setLanguage('en');
  });
});
