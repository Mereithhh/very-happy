import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

/**
 * B-713 E: touch browsers keep :hover "stuck" on the last tapped element, so the
 * Very Happy brand (and any sidebar control) looked hovered on the phone by
 * default. Every :hover rule in the sidebar stylesheet must sit inside a
 * hover-capable media query.
 */
function unguardedHoverSelectors(css: string): string[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const stack: string[] = [];
  const bad: string[] = [];
  let prelude = '';
  for (const ch of src) {
    if (ch === '{') {
      const head = prelude.trim();
      if (!head.startsWith('@') && head.includes(':hover') && !stack.some((s) => /@media[^{]*hover:\s*hover/.test(s))) {
        bad.push(...head.split(',').map((s) => s.trim()).filter((s) => s.includes(':hover')));
      }
      stack.push(head);
      prelude = '';
    } else if (ch === '}') {
      stack.pop();
      prelude = '';
    } else if (ch === ';') {
      prelude = '';
    } else {
      prelude += ch;
    }
  }
  return bad;
}

it('every sidebar :hover rule is gated by (hover: hover)', () => {
  const css = readFileSync(new URL('./sidebar.css', import.meta.url), 'utf8');
  expect(unguardedHoverSelectors(css)).toEqual([]);
});

it('the checker catches an unguarded hover (and accepts a guarded one)', () => {
  expect(unguardedHoverSelectors('.a:hover { color: red; } .b { x: y; }')).toEqual(['.a:hover']);
  expect(unguardedHoverSelectors('@media (hover: hover) and (pointer: fine) { .a:hover, .b:hover { color: red; } }')).toEqual([]);
  expect(unguardedHoverSelectors('@media (pointer: coarse) { .a:hover { color: red; } }')).toEqual(['.a:hover']);
});
