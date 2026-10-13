// B-582 — chat type scale contract (spec specs/2026-10-chat-type-scale.md).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CHAT_TEXT_SCALE, CHAT_TEXT_SIZES, applyChatTextSize, normalizeChatTextSize,
} from '@/ui/chatTextSize';

const tokens = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const LINT = fileURLToPath(new URL('../../../../scripts/dev/check-design-lint.mjs', import.meta.url));

describe('chat type scale tokens', () => {
  it('defines every tier as a ratio of the 对话字号 scale, equal to the pre-B-582 px at scale 1', () => {
    expect(tokens).toMatch(/--chat-scale: 1;/);
    const tiers: Record<string, number> = { body: 14, control: 13, secondary: 12, caption: 11, badge: 10, code: 12 };
    for (const [tier, px] of Object.entries(tiers)) {
      expect(tokens).toContain(`--chat-fs-${tier}: calc(var(--fs-${px}) * var(--chat-scale));`);
    }
    expect(tokens).toContain('--chat-space: calc(var(--sp-1) * var(--chat-scale));');
    expect(tokens).toContain('--conversation-icon-size: calc(18px * var(--chat-scale));');
  });

  it('maps each non-default size to the same scale the setting module advertises', () => {
    for (const size of CHAT_TEXT_SIZES) {
      if (size === 'md') {
        expect(tokens).not.toContain(`data-chat-size='md'`);
        continue;
      }
      expect(tokens).toContain(`:root[data-chat-size='${size}'] { --chat-scale: ${CHAT_TEXT_SCALE[size]}; }`);
    }
  });

  it('keeps every conversation css font size on a chat tier (whole files, not just new lines)', async () => {
    const lint = await import(/* @vite-ignore */ LINT) as {
      CONVERSATION_CSS: Set<string>;
      lintFile: (rel: string, source: string, added: Set<number>) => { rule: string; line: number; source: string }[];
    };
    const src = fileURLToPath(new URL('..', import.meta.url));
    const issues: string[] = [];
    for (const rel of lint.CONVERSATION_CSS) {
      const source = readFileSync(`${src}/${rel}`, 'utf8');
      const all = new Set(source.split('\n').map((_, i) => i + 1));
      for (const f of lint.lintFile(rel, source, all)) {
        if (f.rule === 'conversation-font-size') issues.push(`${rel}:${f.line} ${f.source}`);
      }
    }
    expect(issues).toEqual([]);
  });
});

describe('docks above the composer share its horizontal lane (B-455)', () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  // padding: <top> <horizontal> [<bottom>] → the horizontal part, which must never use --chat-space
  const horizontal = (css: string, selector: string, from = 0) => {
    const at = css.indexOf(selector + ' {', from);
    const body = css.slice(at, css.indexOf('}', at));
    const pad = /padding:\s*([^;]+);/.exec(body)?.[1].trim() ?? '';
    const parts: string[] = [];
    let depth = 0, cur = '';
    for (const ch of pad) {
      if (ch === ' ' && depth === 0) { if (cur) parts.push(cur); cur = ''; continue; }
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      cur += ch;
    }
    if (cur) parts.push(cur);
    return parts[1];
  };
  it('perm-dock keeps --sp-4 desktop / --sp-3 touch like the composer and sa-dock', () => {
    const perm = read('../screens/session/permission.css');
    const input = read('../screens/session/input.css');
    const sa = read('../screens/session/subagent.css');
    expect(horizontal(perm, '.perm-dock')).toBe('var(--sp-4)');
    expect(horizontal(sa, '.sa-dock')).toBe('var(--sp-4)');
    expect(horizontal(input, '.ci')).toBe('var(--sp-4)');
    const touchPerm = horizontal(perm, '.perm-dock', perm.indexOf('.perm-dock {') + 1);
    const touchCi = horizontal(input, '.ci', input.indexOf('@media (max-width: 600px), (pointer: coarse)'));
    expect(touchPerm).toBe('var(--sp-3)');
    expect(touchCi).toBe(touchPerm);
  });
});

describe('fixed-scale islands', () => {
  it('re-declare the tiers under --chat-scale: 1 for floats, modals and the terminal tool history', () => {
    for (const sel of ['.term-screen > .tool-history', '.cl-selquote', '.cl-rail', '.msg-hover-time', '.skill-preview', '.image-preview', '.runtime-controls']) {
      expect(tokens).toMatch(new RegExp(`:is\\([^)]*${sel.replace(/[.>]/g, (c) => '\\' + c)}[^)]*\\) \\{ --chat-scale: 1; \\}`));
    }
    expect(tokens).toMatch(/:root,\s*:is\([^)]*\) \{\s*--chat-fs-body: calc/);
  });
});

describe('chatTextSize setting', () => {
  it('normalizes unknown or missing stored values to the default', () => {
    expect(normalizeChatTextSize('lg')).toBe('lg');
    expect(normalizeChatTextSize('xxl')).toBe('md');
    expect(normalizeChatTextSize(null)).toBe('md');
    expect(normalizeChatTextSize(1.25)).toBe('md');
  });

  it('leaves <html> without the attribute at the default so tokens apply untouched', () => {
    const el = { dataset: {} as DOMStringMap };
    applyChatTextSize('xl', el);
    expect(el.dataset.chatSize).toBe('xl');
    applyChatTextSize('md', el);
    expect('chatSize' in el.dataset).toBe(false);
  });
});
