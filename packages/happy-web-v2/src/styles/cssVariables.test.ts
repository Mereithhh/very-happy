/**
 * 每个 `var(--x)` 都必须有定义（T-005）。
 *
 * 为什么要钉这个：`color: var(--text-1)` 里的 `--text-1` 从来不存在（text 阶梯只有
 * --text / --text-dim / --text-faint），但浏览器**不会报错**——声明在 computed-value time
 * 失效、按 `unset` 处理。对 `color` 这种继承属性，结果是「碰巧继承父级」，于是 Chromium 里
 * 看起来没坏；对 `background` / `outline` / `text-decoration-color` 这类不继承的属性，结果
 * 是回到初始值——按钮没了底色、焦点环不见了、hover 状态什么都不做。filepathlink.css 的
 * hover / focus / 图标三个状态就这样静默死了几周（`.vh-update-prompt-btn` 的 ink/canvas
 * 底色同理）。DevTools 会把这类声明标成无效，但没有人会逐条去看。
 *
 * 规则：src 下所有 CSS / TSX / index.html 里用到的 `var(--x` 都要在同一集合里有 `--x:`、
 * `setProperty('--x'` 或 `'--x':` 的定义，除了下面两类：
 *  1. 第三方在运行时注入的（shiki 的 token 变量、Radix 的 popper 变量）；
 *  2. 已登记的存量债（尺寸 / 动效 token 缺失，不影响可读性）。**这份清单是精确相等断言**：
 *     修掉一条就要从这里删掉，新增一条未定义变量会直接红。别把它变成「宽泛放行」。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const PKG = join(ROOT, '..');

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (/\.(css|tsx|ts|html)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
    }
    return out;
}

/** Runtime-injected by third parties; never declared in our sources. */
const EXTERNAL = new Set([
    '--shiki-light',
    '--shiki-dark',
    '--radix-dropdown-menu-content-transform-origin',
    '--radix-dropdown-menu-trigger-width',
    '--radix-popover-content-available-height',
]);

/**
 * Known debt — size/motion tokens that were never added to tokens.css. These are
 * invalid-at-computed-value too (a heading falls back to the inherited font size),
 * but none of them carries a colour, so they are not a legibility bug. Listed by
 * variable → files, so fixing one means deleting its line here.
 */
const KNOWN_DEBT: Record<string, string[]> = {};

/** Properties whose invalid fallback makes text unreadable or controls vanish. */
const COLOUR_PROPS = /(^|[^-])(color|background|background-color|border|border-color|outline|outline-color|fill|stroke|text-decoration-color|box-shadow)\s*:/;

function collect() {
    const files = [...walk(join(ROOT)), join(PKG, 'index.html')];
    const used = new Map<string, Set<string>>();          // var → files
    const colourUses = new Map<string, Set<string>>();    // var → files where it sits in a colour property
    const defined = new Set<string>();
    for (const file of files) {
        // Strip CSS / TS block comments: a comment that *talks about* `var(--text-1)` is
        // documentation, not a declaration (filepathlink.css does exactly that).
        const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        const rel = relative(PKG, file);
        for (const m of source.matchAll(/var\(\s*(--[\w-]+)/g)) {
            if (!used.has(m[1])) used.set(m[1], new Set());
            used.get(m[1])!.add(rel);
        }
        // declaration-level scan: which property is this var() inside of?
        for (const decl of source.matchAll(/([\w-]+)\s*:\s*([^;{}]*var\(--[\w-]+[^;{}]*)/g)) {
            if (!COLOUR_PROPS.test(`${decl[1]}:`)) continue;
            for (const v of decl[2].matchAll(/var\(\s*(--[\w-]+)/g)) {
                if (!colourUses.has(v[1])) colourUses.set(v[1], new Set());
                colourUses.get(v[1])!.add(rel);
            }
        }
        for (const m of source.matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1]);
        for (const m of source.matchAll(/setProperty\(\s*['"](--[\w-]+)/g)) defined.add(m[1]);
        for (const m of source.matchAll(/['"](--[\w-]+)['"]\s*:/g)) defined.add(m[1]);
    }
    const undefinedVars = [...used.keys()].filter((v) => !defined.has(v) && !EXTERNAL.has(v)).sort();
    return { used, colourUses, defined, undefinedVars };
}

describe('CSS custom properties resolve', () => {
    const { used, colourUses, undefinedVars } = collect();

    it('no colour-carrying declaration references an undefined variable', () => {
        const offenders = undefinedVars
            .filter((v) => colourUses.has(v))
            .map((v) => `${v} ← ${[...colourUses.get(v)!].sort().join(', ')}`);
        // The T-005 finding: --text-0/1/2 (filepathlink.css), --ink/--canvas (updatePrompt.css),
        // --text-2 (languageSwitcher.css, todos.css), --surface-3 (sidebar.css).
        expect(offenders).toEqual([]);
    });

    it('the set of undefined variables is exactly the registered debt (delete a line when you fix one)', () => {
        const actual = Object.fromEntries(undefinedVars.map((v) => [v, [...used.get(v)!].sort()]));
        expect(actual).toEqual(KNOWN_DEBT);
    });

    it('the text ladder is --text / --text-dim / --text-faint — no numbered variants anywhere', () => {
        const numbered = [...used.keys()].filter((v) => /^--text-\d$/.test(v));
        expect(numbered).toEqual([]);
    });
});
