/** B-637: the PWA install card and public chrome copy follow the operator brand (B-624). */
import { describe, it, expect } from 'vitest';

(globalThis as any).__HAPPY_CONFIG__ = { brand: { name: 'Apodex Vibe' } };
const { getPublicCopy } = await import('./publicI18n');

describe('B-637 public copy follows the brand', () => {
  it('renames the PWA card and header in every language', () => {
    expect(getPublicCopy('en').pwa.title).toBe('Install Apodex Vibe');
    expect(getPublicCopy('zh-Hans').pwa.title).toBe('安装 Apodex Vibe');
    expect(getPublicCopy('en').shell.homeLabel).toBe('Apodex Vibe home');
    expect(getPublicCopy('ja').pwa.title).toBe('Install Apodex Vibe');
  });
});
