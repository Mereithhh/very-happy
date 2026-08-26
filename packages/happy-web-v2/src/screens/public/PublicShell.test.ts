import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('public mobile header', () => {
  const styles = readFileSync(new URL('./public.css', import.meta.url), 'utf8');
  const shell = readFileSync(new URL('./PublicShell.tsx', import.meta.url), 'utf8');

  it('moves the redundant CTA out of the narrow header', () => {
    const mobile = styles.slice(styles.indexOf('@media (max-width: 480px)'));
    expect(mobile).toContain('.pub-header .pub-nav-cta { display: none; }');
  });

  it('keeps sign-in reachable without depending on navigation order', () => {
    const mobile = styles.slice(styles.indexOf('@media (max-width: 680px)'));
    expect(shell).toContain('className="pub-nav-login" href={`${import.meta.env.BASE_URL}login`}');
    expect(shell).not.toContain('<Link className="pub-nav-login"');
    expect(shell).toContain('className="pub-nav-secondary"');
    expect(mobile).toContain('.pub-header .pub-nav-secondary { display: none; }');
    expect(mobile).toContain('.pub-header .pub-nav-login { display: inline-flex; }');
    expect(mobile).not.toMatch(/nav a:nth-child/);
    expect(styles).toContain('env(safe-area-inset-right)');
    expect(styles).toContain('env(safe-area-inset-left)');
  });
});
