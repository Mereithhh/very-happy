import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const chatList = readFileSync(new URL('./ChatList.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('./chatlist.css', import.meta.url), 'utf8');

describe('chat loading layout', () => {
  it('centers the orbit loader inside the scroll area from its first frame', () => {
    expect(chatList).toMatch(/className="cl cl--loading"[\s\S]*className="cl-scroll"[\s\S]*<OrbitLoader/);
    expect(styles).toMatch(/\.cl--loading \.cl-scroll\s*\{[^}]*display:\s*grid;[^}]*place-items:\s*center;/s);
  });
});
