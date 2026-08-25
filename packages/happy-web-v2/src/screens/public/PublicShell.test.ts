import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('public mobile header', () => {
  const styles = readFileSync(new URL('./public.css', import.meta.url), 'utf8');

  it('moves the redundant CTA out of the narrow header', () => {
    const mobile = styles.slice(styles.indexOf('@media (max-width: 480px)'));
    expect(mobile).toContain('.pub-header .pub-nav-cta { display: none; }');
  });
});
