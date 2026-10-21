import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findNativeControls, findRawColors, isFieldFocusSelector, lintFile, parseAddedLines } from './check-design-lint.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-design-lint.mjs');

/** 把整份 source 当作新增行跑一个文件，返回 [rule, line] 列表。 */
function lintAll(rel, source) {
    const added = new Set(source.split('\n').map((_, i) => i + 1));
    return lintFile(rel, source, added).map(f => [f.rule, f.line]);
}

test('parseAddedLines keeps only added .css/.tsx lines under the web src', () => {
    const diff = [
        'diff --git a/packages/happy-web-v2/src/a.css b/packages/happy-web-v2/src/a.css',
        '--- a/packages/happy-web-v2/src/a.css',
        '+++ b/packages/happy-web-v2/src/a.css',
        '@@ -3,0 +4,2 @@',
        '+.a { color: red; }',
        '+.b { color: blue; }',
        '@@ -10 +12 @@',
        '-.old {}',
        '+.new {}',
        'diff --git a/packages/happy-web-v2/src/x.ts b/packages/happy-web-v2/src/x.ts',
        '+++ b/packages/happy-web-v2/src/x.ts',
        '@@ -1 +1 @@',
        '+const c = "#fff";',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-gone',
        '+++ b/packages/happy-cli/src/y.tsx',
        '@@ -0,0 +1 @@',
        '+x',
    ].join('\n');
    const files = parseAddedLines(diff);
    assert.deepEqual([...files.keys()], ['packages/happy-web-v2/src/a.css']);
    assert.deepEqual([...files.get('packages/happy-web-v2/src/a.css')], [4, 5, 12]);
});

test('css raw colors: hex, rgb(), hsl() literals are flagged; token-derived values are not', () => {
    assert.deepEqual(findRawColors('  color: #fff;', 'css'), ['#fff']);
    assert.deepEqual(findRawColors('  border: 1px solid #06080c80;', 'css'), ['#06080c80']);
    assert.deepEqual(findRawColors('  box-shadow: 0 6px 24px rgb(0 0 0 / 28%);', 'css'), ['rgb(0 0 0 / 28%)']);
    assert.deepEqual(findRawColors('  --x: hsl(215 45% 72%);', 'css'), ['hsl(215 45% 72%)']);
    assert.deepEqual(findRawColors('  background: color-mix(in srgb, var(--accent) 12%, transparent);', 'css'), []);
    assert.deepEqual(findRawColors('  background: rgb(from var(--text) r g b / 0.5);', 'css'), []);
    assert.deepEqual(findRawColors('  background: rgba(var(--rgb-ink), 0.4);', 'css'), []);
    assert.deepEqual(findRawColors('  fill: url(#abc);', 'css'), []);
    assert.deepEqual(findRawColors('.a, #add > b { color: var(--text); }', 'css'), []);
    assert.deepEqual(findRawColors('  grid-area: hdr;', 'css'), []);
});

test('tsx raw colors: only obvious color strings, never issue refs or prose', () => {
    assert.deepEqual(findRawColors("  background: '#06080C', foreground: '#E8EDF4',", 'tsx'), ['#06080C', '#E8EDF4']);
    assert.deepEqual(findRawColors('<div style={{ color: "#abc" }} />', 'tsx'), ['#abc']);
    assert.deepEqual(findRawColors("  border: '1px solid #fafafa',", 'tsx'), ['#fafafa']);
    assert.deepEqual(findRawColors("  selection: 'rgba(52,226,196,0.24)',", 'tsx'), ['rgba(52,226,196,0.24)']);
    assert.deepEqual(findRawColors("  call('x', { progress: 'PR #431 open for review' })", 'tsx'), []);
    assert.deepEqual(findRawColors('  const rgb = rgb(value);', 'tsx'), []);
    assert.deepEqual(findRawColors("  color: 'var(--text)',", 'tsx'), []);
});

test('raw colors in comments are ignored; token file, tests and the xterm theme are exempt', () => {
    assert.deepEqual(lintAll('ui/a.css', '/* was #fff */\n.a {\n  /* see\n   #000 */\n  color: var(--text);\n}'), []);
    assert.deepEqual(lintAll('ui/A.tsx', '// matches #fff in the legacy theme\nconst a = 1;'), []);
    assert.deepEqual(lintAll('styles/tokens.css', ':root { --bg-0: #111210; }'), []);
    assert.deepEqual(lintAll('ui/A.test.tsx', "const c = '#fff';"), []);
    assert.deepEqual(lintAll('screens/terminal/WebTerminalScreen.tsx', "  background: '#06080C',"), []);
    assert.deepEqual(lintAll('screens/terminal/terminal.css', '.t { color: #34e2c4; }'), [['raw-color', 1]]);
});

test('conversation css font sizes must use the chat tiers (B-582); other css may use px / --fs-*', () => {
    const css = '.m { font-size: 13px; }\n.n { font-size: var(--fs-12); }\n.o { font-size: var(--conversation-size); }';
    assert.deepEqual(lintAll('screens/session/message.css', css), [['conversation-font-size', 1], ['conversation-font-size', 2]]);
    const ok = [
        '.a { font-size: var(--chat-fs-secondary); }',
        '.b { font: var(--chat-fs-caption)/1.4 var(--font-mono); }',
        '.c { font-size: max(16px, var(--chat-fs-body)); }',
        '.d { font-size: 1.25em; }',
        '.e { font: inherit; }',
        '.f { font-size: calc(var(--workspace-primary-size) * var(--chat-scale)); }',
    ].join('\n');
    assert.deepEqual(lintAll('screens/session/markdown.css', ok), []);
    const bad = '.a { font: var(--fs-12)/1 var(--font-sans); }\n.b { font-size: var(--workspace-primary-size); }\n.c { font: 12px/1.4 var(--font-sans); }';
    assert.deepEqual(lintAll('screens/session/chatReadingAids.css', bad), [['conversation-font-size', 1], ['conversation-font-size', 2], ['conversation-font-size', 3]]);
    assert.deepEqual(lintAll('screens/session/toolgroup.css', '.g {\n  font-size:11px;\n}'), [['conversation-font-size', 2]]);
    assert.deepEqual(lintAll('screens/session/header.css', css), []);
    assert.deepEqual(lintAll('screens/settings/settings.css', css), []);
    assert.deepEqual(lintAll('screens/session/message.css', '.m { line-height: 13px; }'), []);
});

test('outline:none needs a focus replacement in the same file', () => {
    // 无任何替代 → 报
    assert.deepEqual(lintAll('ui/a.css', '.range {\n  appearance: none;\n  outline: none;\n}'), [['outline-none', 3]]);
    assert.deepEqual(lintAll('ui/a.css', '.btn { outline: 0; }'), [['outline-none', 1]]);
    // 同规则在 :focus-visible 上换成 box-shadow → 过
    assert.deepEqual(lintAll('ui/a.css', '.btn:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--accent); }'), []);
    // 同类名另有 :focus-visible 样式 → 过
    assert.deepEqual(lintAll('ui/a.css', '.btn { outline: none; }\n.btn:focus-visible { box-shadow: 0 0 0 2px var(--accent); }'), []);
    // 外框 :focus-within 表达焦点（input 在 wrapper 里）→ 过
    assert.deepEqual(lintAll('ui/a.css', '.wrap:focus-within { border-color: var(--line-3); }\n.inp { outline: none; }'), []);
    // 程序化聚焦的容器 `X:focus { outline:none }` → 过（宁可漏报）
    assert.deepEqual(lintAll('ui/a.css', '.dialog:focus { outline:none; }'), []);
    // 只有 outline:none 的 :focus-visible 规则不算替代
    assert.deepEqual(lintAll('ui/a.css', '.btn { outline: none; }\n.btn:focus-visible { outline: none; }'), [['outline-none', 1], ['outline-none', 2]]);
    // 嵌套在 @media 里也能找到所属规则
    assert.deepEqual(lintAll('ui/a.css', '@media (pointer: coarse) {\n  .x {\n    outline: none;\n  }\n}'), [['outline-none', 3]]);
    // outline-offset 等不是 outline:none
    assert.deepEqual(lintAll('ui/a.css', '.x { outline-offset: 0; }'), []);
});

test('text fields never get a focus ring or glow (B-699); buttons still may', () => {
    assert.deepEqual(lintAll('ui/a.css', '.x-input:focus { box-shadow: var(--focus-ring); }'), [['field-focus-ring', 1]]);
    assert.deepEqual(lintAll('ui/a.css', '.m textarea:focus-visible {\n  box-shadow: 0 0 0 3px var(--accent-glow);\n}'), [['field-focus-ring', 2]]);
    assert.deepEqual(lintAll('ui/a.css', 'input:focus { outline: 2px solid var(--accent); }'), [['field-focus-ring', 1]]);
    assert.deepEqual(lintAll('ui/a.css', '.x-input:focus { outline: none; border-color: var(--line-heavy); }'), []);
    assert.deepEqual(lintAll('ui/a.css', '.btn:focus-visible { box-shadow: var(--focus-ring); }'), []);
    assert.deepEqual(lintAll('ui/a.css', '.s :focus-visible:not(textarea, input) { box-shadow: var(--focus-ring); }'), []);
    assert.deepEqual(lintAll('ui/a.css', 'input[type="checkbox"]:focus-visible { box-shadow: var(--focus-ring); }'), []);
    assert.equal(isFieldFocusSelector('.a-input-wrap:focus-within'), false);
    assert.equal(isFieldFocusSelector('.pp-search input:focus'), true);
});

test('design-lint-allow with a reason suppresses; without a reason it still reports', () => {
    assert.deepEqual(lintAll('ui/a.css', '.a { color: #fff; } /* design-lint-allow: 品牌资产固有白底 */'), []);
    assert.deepEqual(lintAll('ui/a.css', '/* design-lint-allow: 品牌资产固有白底 */\n.a { color: #fff; }'), []);
    assert.deepEqual(lintAll('ui/A.tsx', "// design-lint-allow: xterm 主题只收字面量\nconst c = { color: '#fff' };"), []);
    const bare = lintFile('ui/a.css', '.a { color: #fff; } /* design-lint-allow: */', new Set([1]));
    assert.equal(bare.length, 1);
    assert.match(bare[0].message, /缺理由/);
});

test('only added lines are checked', () => {
    const source = '.a { color: #fff; }\n.b { color: #000; }';
    const findings = lintFile('ui/a.css', source, new Set([2]));
    assert.deepEqual(findings.map(f => [f.file, f.line]), [['packages/happy-web-v2/src/ui/a.css', 2]]);
});

test('CLI diffs base...head in a real repo and exits 1 on findings, 0 when clean', () => {
    const dir = mkdtempSync(join(tmpdir(), 'design-lint-'));
    try {
        const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
        const write = (rel, body) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), body); };
        git('init', '-q', '-b', 'main');
        write('packages/happy-web-v2/src/ui/a.css', '.old { color: #fff; }\n');
        git('add', '.'); git('commit', '-qm', 'base');
        git('checkout', '-qb', 'feature');
        write('packages/happy-web-v2/src/ui/a.css', '.old { color: #fff; }\n.new { color: var(--text); }\n');
        git('commit', '-qam', 'clean change');
        const clean = spawnSync(process.execPath, [SCRIPT, '--base', 'main'], { cwd: dir, encoding: 'utf8' });
        assert.equal(clean.status, 0, clean.stdout + clean.stderr);

        write('packages/happy-web-v2/src/screens/session/message.css', '.m {\n  font-size: 13px;\n  color: rgb(0 0 0 / 50%);\n}\n');
        git('add', '.'); git('commit', '-qm', 'dirty change');
        const dirty = spawnSync(process.execPath, [SCRIPT, '--base', 'main', '--head', 'HEAD'], { cwd: dir, encoding: 'utf8' });
        assert.equal(dirty.status, 1, dirty.stdout + dirty.stderr);
        assert.match(dirty.stdout, /screens\/session\/message\.css:2: \[conversation-font-size\]/);
        assert.match(dirty.stdout, /screens\/session\/message\.css:3: \[raw-color\]/);
        assert.doesNotMatch(dirty.stdout, /ui\/a\.css:1/);

        const bad = spawnSync(process.execPath, [SCRIPT, '--base', 'no-such-ref'], { cwd: dir, encoding: 'utf8' });
        assert.equal(bad.status, 2);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('B-714 native-control: new <select>/<option>/checkbox/<summary> in tsx are flagged; owners, strings and components pass', () => {
    const src = [
        '<select value={v} onChange={f}>',
        '  <option value="a">A</option>',
        '</select>',
        '<input type="checkbox" checked={x} />',
        '<details><summary>More</summary></details>',
        '<SelectMenu label="x" options={o} value={v} onChange={f} />',
        '<Summary>More</Summary>',
        'const raw = "<summary>Background agent</summary>";',
        '{/* design-lint-allow: 外部 HTML 预览需要原生控件 */}',
        '<select />',
    ].join('\n');
    assert.deepEqual(lintAll('screens/x/Form.tsx', src), [
        ['native-control', 1], ['native-control', 2], ['native-control', 4], ['native-control', 5],
    ]);
    assert.deepEqual(lintAll('ui/Checkbox.tsx', '<input type="checkbox" className="vh-checkbox-input" />'), []);
    assert.deepEqual(lintAll('ui/Summary.tsx', '<summary className="vh-summary">'), []);
    assert.deepEqual(findNativeControls('<input type={"checkbox"} />', 'screens/a.tsx').map(h => h.kind), ['checkbox']);
    assert.deepEqual(findNativeControls('<datalist id="x"><option value="a" /></datalist>', 'screens/a.tsx').map(h => h.kind), ['option', 'datalist']);
    // the owner whitelist is per control: Checkbox.tsx may not grow a <select>
    assert.deepEqual(findNativeControls('<select>', 'ui/Checkbox.tsx').map(h => h.kind), ['select']);
    // css and tests are out of scope for this rule
    assert.deepEqual(lintAll('screens/x/form.css', 'select { color: var(--text); }'), []);
    assert.deepEqual(lintAll('screens/x/Form.test.tsx', '<select />'), []);
});
