/**
 * 深色主题下会话正文的每一档文字都要能读（T-005）。
 *
 * 报告「深色主题下部分文字显示为黑色看不见」。真 Chromium + 生产 CSS 采样没有复现，
 * 但那次排查暴露了一类会**静默**制造黑字的机制：`color: var(--不存在的变量)` 在
 * computed-value time 失效 → `unset` → 继承。碰巧父级是浅色就没事，父级是别的就出事。
 * `cssVariables.test.ts` 钉「变量必须有定义」；这个文件钉另一半：**定义了的**文字 / 底色
 * 组合本身对比度够——tokens.css 的注释说「All text/bg pairs pass WCAG AA」，但从来没有
 * 东西检查过深色主题（那句话写在 light 块上）。
 *
 * 用的是真值：从 tokens.css 解析两个主题的实际 hex，按 WCAG 2.x 相对亮度算对比度。
 * 阈值：正文 --text ≥ 7:1（AAA，等宽小字号也稳），--text-dim ≥ 4.5:1（AA），
 * --text-faint ≥ 3:1（它是刻意的「dim 槽」，tokens.css 头部已登记豁免 AA）。
 * 底色取会话正文实际坐的四级台阶 bg-0..bg-3（transcript / 面板 / 气泡 / hover）。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const tokens = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

/** Pull `--name: #hex;` pairs out of one `:root…{}` block. */
function block(selectorStart: string): Record<string, string> {
    const start = tokens.indexOf(selectorStart);
    expect(start, `tokens.css block ${selectorStart}`).toBeGreaterThan(-1);
    const body = tokens.slice(tokens.indexOf('{', start) + 1, tokens.indexOf('}', start));
    const out: Record<string, string> = {};
    for (const m of body.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\b/g)) out[m[1]] = m[2].toLowerCase();
    return out;
}

function luminance(hex: string): number {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

export function contrast(fg: string, bg: string): number {
    const [a, b] = [luminance(fg), luminance(bg)];
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const SURFACES = ['--bg-0', '--bg-1', '--bg-2', '--bg-3'] as const;
const LADDER: Array<[string, number]> = [
    ['--text', 7],
    ['--text-dim', 4.5],
    ['--text-faint', 3],
];

describe.each([
    ['dark', ":root,\n:root[data-theme='dark']"],
    ['light', ":root[data-theme='light']"],
])('%s theme text ladder is legible on every surface step', (_theme, selector) => {
    const t = block(selector);

    it('defines the whole ladder and all four surfaces', () => {
        for (const name of [...SURFACES, ...LADDER.map(([n]) => n)]) {
        expect(t[name], `${name} missing or not a 6-digit hex`).toMatch(/^#[0-9a-f]{6}$/);
        }
    });

    it.each(LADDER.flatMap(([text, min]) => SURFACES.map((bg) => [text, bg, min] as const)))(
        '%s on %s ≥ %s:1',
        (text, bg, min) => {
  const ratio = contrast(t[text], t[bg]);
            expect(ratio, `${text} ${t[text]} on ${bg} ${t[bg]} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(min);
        },
    );

    it('the ladder is ordered: --text is the brightest step, --text-faint the dimmest', () => {
        const on0 = LADDER.map(([n]) => contrast(t[n], t['--bg-0']));
        expect(on0[0]).toBeGreaterThan(on0[1]);
    expect(on0[1]).toBeGreaterThanOrEqual(on0[2]);
    });
});

describe('dark theme never puts near-black ink on a dark surface', () => {
    // The literal failure mode reported: text that renders black on the dark
    // transcript. Every ink token in the dark block must be far from the surfaces.
    const t = block(":root,\n:root[data-theme='dark']");
    it.each(['--text', '--text-dim', '--text-faint', '--accent-2', '--warn', '--danger'])(
        '%s is light-on-dark (luminance well above bg-0)',
      (name) => {
            expect(luminance(t[name])).toBeGreaterThan(luminance(t['--bg-0']) + 0.2);
        },
    );
});
