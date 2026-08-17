#!/usr/bin/env node
/**
 * B-121 终端通道 v2 —— 真站 E2E 冒烟（lines 模式的三个可判定事实）。
 *
 * 这套东西的存在理由是「手机滑动回看要跟手」，而它成立的**技术前提**恰好是可
 * 自动判定的三条：
 *   ① open 响应带 `streamMode:'lines'`（daemon 真的走了内容流通道）；
 *   ② xterm 处在 **normal buffer** 且**本地 scrollback 真的有内容**
 *      （v1 恒在 alternate buffer、scrollback 恒为 0——这正是滚动不跟手的根）；
 *   ③ normal 轨**不再劫持滚轮**、`.term-host` 的 touch-action 交还浏览器
 *      （合成 wheel 那条 200ms 往返路径退场）。
 * 手感本身仍是真机项（V-061），这里只钉「前提成立」。
 *
 * 复用 term-input-goldendiff.mjs 的登录 / 建终端 / **三道闸** / 清理——那套闸
 * （取第一个候选 + 硬断言 fresh=1 + 断言新 id 不在开跑前的 tmux 快照里；清理时
 * 拒杀开跑前就存在的会话）只能有一份实现，2026-08-14 误杀过真终端。
 *
 *   node scripts/probe/term-lines-e2e.mjs
 *   node scripts/probe/term-lines-e2e.mjs --url https://happy.mereith.com
 *
 * 退出码：0 全通过 · 1 有断言失败 · 2 跑不出结论（2 绝不当 0 用）。
 */
import { hostname } from 'node:os';
import {
    ensureChrome, openTab, closeTab, ensureLoggedIn, ensureDebugMode,
    createTestTerminal, cleanupTerminal, waitFor, FIND_TERM,
} from './term-input-goldendiff.mjs';

const opts = {
    url: 'https://happy.mereith.com',
    port: 9227,
    profile: '/tmp/vh-goldendiff-profile',
    chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    // ensureLoggedIn / createTestTerminal 复用 goldendiff 的字段名
    base: 'https://happy.mereith.com',
    machine: hostname(),
    keep: false,
    /** 'lines' = 期望 v2 通道；'attach' = 期望回退轨（新 web + 老 daemon 象限）。 */
    expect: 'lines',
};
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--url') { opts.url = process.argv[++i]; opts.base = opts.url; }
    else if (a === '--port') opts.port = Number(process.argv[++i]);
    else if (a === '--profile') opts.profile = process.argv[++i];
    else if (a === '--keep') opts.keep = true;
    else if (a === '--expect') opts.expect = process.argv[++i];
    else if (a === '--chrome') opts.chrome = process.argv[++i];
    else if (a === '-h' || a === '--help') {
        console.log('用法：node scripts/probe/term-lines-e2e.mjs [--url U] [--port P] [--profile DIR] [--keep]');
        process.exit(0);
    } else { console.error(`未知参数：${a}`); process.exit(2); }
}

/**
 * 所有 touch-action 规则都在 `@media (pointer: coarse)` 里（桌面 Chrome 天然
 * 看不到，v1 同理），所以要验移动端那条关键路径，必须先把浏览器切成粗指针 +
 * 移动视口——否则读到的永远是 `auto`，一个与手机无关的假红/假绿。
 */
async function emulateCoarsePointer(tab, on = true) {
    if (on) {
        await tab.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        await tab.send('Emulation.setDeviceMetricsOverride', {
            width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
        });
    } else {
        await tab.send('Emulation.clearDeviceMetricsOverride');
        await tab.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    }
    await new Promise((r) => setTimeout(r, 600));
    const r = await tab.send('Runtime.evaluate', {
        expression: `matchMedia('(pointer: coarse)').matches`, returnByValue: true,
    });
    return r.result?.result?.value === true;
}

const checks = [];
const check = (name, ok, detail = '') => {
    checks.push({ name, ok, detail });
    console.error(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

let tab = null; let targetId = null; let tid = null; let preExisting = null;
try {
    await ensureChrome(opts);
    tab = await openTab(opts.port, opts.url);
    targetId = tab.target.id;
    await ensureLoggedIn(tab, opts);
    await ensureDebugMode(tab);

    const created = await createTestTerminal(tab, opts);
    tid = created.tid; preExisting = created.before ?? null;
    console.error(`测试终端：${tid}`);

    // ① lines 模式协商成功。web 只在 lines 响应里给 .term-host 挂 --lines class
    //    （attach fallback 不挂），所以 class 就是协商结果的可观测投影。
    const wantLines = opts.expect !== 'attach';
    const mode = await waitFor(async () => {
        const r = await tab.send('Runtime.evaluate', {
            expression: `(() => {
                const host = document.querySelector('.term-host');
                if (!host) return null;
                return { lines: host.classList.contains('term-host--lines'), alt: host.classList.contains('term-host--alt'),
                         touch: getComputedStyle(host).touchAction };
            })()`,
            returnByValue: true,
        });
        const v = r.result?.result?.value;
        if (!v) return null;
        // attach 象限：等「终端已挂载且明确不是 lines」稳定 3 秒再判（协商是异步的）
        return wantLines ? (v.lines ? v : null) : v;
    }, 30_000, wantLines ? 'lines 模式协商' : '终端挂载');

    if (!wantLines) {
        // 新 web + 老 daemon：必须回退 attach 轨，且保留 v1 的合成 wheel 前提
        await new Promise((r) => setTimeout(r, 3000));
        const coarse = await emulateCoarsePointer(tab, true);
        check('（前置）粗指针模拟生效', coarse);
        const after = await tab.send('Runtime.evaluate', {
            expression: `(() => { const h = document.querySelector('.term-host');
                return h ? { lines: h.classList.contains('term-host--lines'), touch: getComputedStyle(h).touchAction } : null; })()`,
            returnByValue: true,
        });
        const v = after.result?.result?.value;
        check('【象限：新 web + 老 daemon】回退 attach 轨（无 lines class）', v && v.lines === false, `lines=${v?.lines}`);
        check('【象限：新 web + 老 daemon】touch-action 仍为 none（合成 wheel 的前提保留）', v?.touch === 'none', `touch-action=${v?.touch}`);
        if (tid && !opts.keep) cleanupTerminal(tid, { preExisting });
        if (tab && targetId) await closeTab(opts.port, targetId, tab).catch(() => { });
        const bad = checks.filter((c) => !c.ok);
        console.error(`\n${checks.length - bad.length}/${checks.length} 通过`);
        process.exit(bad.length === 0 ? 0 : 1);
    }
    check('① open 协商到 streamMode:lines', true);

    // ③ normal 轨把触摸滚动交还浏览器（v1 是 touch-action:none 才能合成 wheel）。
    //    必须在粗指针下读——规则全在 @media (pointer: coarse) 里。
    const coarse = await emulateCoarsePointer(tab, true);
    check('（前置）粗指针模拟生效', coarse);
    const touch = await tab.send('Runtime.evaluate', {
        expression: `getComputedStyle(document.querySelector('.term-host')).touchAction`,
        returnByValue: true,
    });
    const ta = touch.result?.result?.value;
    check('③ 移动端 normal 轨把纵向滚动交还浏览器（v1 恒为 none）', ta === 'pan-y', `touch-action=${ta}`);
    await emulateCoarsePointer(tab, false);

    // ② 造历史 → normal buffer + 本地 scrollback 真的有内容。
    //    走 xterm 自己的 paste 通道（= onData → sendInput，与 prepSink 同款），
    //    比 dispatchKeyEvent 稳：不依赖窗口焦点，也不受 app 层快捷键干扰。
    const cmd = 'for i in $(seq 1 200); do echo "e2e-line-$i"; done\r';
    await tab.send('Runtime.evaluate', { expression: FIND_TERM, returnByValue: true });
    const fed = await tab.send('Runtime.evaluate', {
        expression: `(()=>{ const T = window.__VHGD_T; if (!T) return 'no term'; T.paste(${JSON.stringify('for i in $(seq 1 200); do echo "e2e-line-$i"; done\r')}); return 'ok'; })()`,
        returnByValue: true,
    });
    if (fed.result?.result?.value !== 'ok') throw new Error(`拿不到 term 实例：${fed.result?.result?.value}`);
    void cmd;
    // 判据刻意**不依赖具体文本**：Owner 的新终端会自动起 claude（startupCommand），
    // 粘进去的东西是 prompt 不是 shell 命令——2026-08-17 首跑就撞上这个，白等了 60s。
    // 本批要证的是「本地 scrollback 真的长出来了」，那就直接判 baseY/length。
    let buf = null;
    await waitFor(async () => {
        await tab.send('Runtime.evaluate', { expression: FIND_TERM, returnByValue: true });
        const r = await tab.send('Runtime.evaluate', {
            expression: `
                (() => {
                    const t = window.__VHGD_T;
                    if (!t) return null;
                    const b = t.buffer.active;
                    let text = '';
                    for (let y = Math.max(0, b.length - 5); y < b.length; y++) text += (b.getLine(y)?.translateToString(true) ?? '') + '\\n';
                    return { type: b.type, length: b.length, rows: t.rows, viewportY: b.viewportY, baseY: b.baseY, tail: text };
                })()`,
            returnByValue: true,
        });
        const v = r.result?.result?.value;
        if (v && v.baseY > 0 && v.length > v.rows) { buf = v; return true; }
        return false;
    }, 90_000, '本地 scrollback 长出内容');

    check('② xterm 处在 normal buffer（不是 v1 的 alternate 全屏镜像）', buf.type === 'normal', `type=${buf.type}`);
    const cls = await tab.send('Runtime.evaluate', {
        expression: `document.querySelector('.term-host').className`, returnByValue: true,
    });
    const className = cls.result?.result?.value ?? '';
    check('③ 稳定后不在 alternate 轨（class 与 buffer 一致）', !/term-host--alt/.test(className), `class="${className}"`);
    check('② 本地 scrollback 真的有内容（v1 恒为 0）', buf.baseY > 0 && buf.length > buf.rows,
        `baseY=${buf.baseY} length=${buf.length} rows=${buf.rows}`);

    // ② 续：本地滚动可用——直接调 xterm 的 scrollLines（不经任何 RPC），
    //    v1 下 alternate buffer 没有 scrollback，这一步位移恒为 0。
    await tab.send('Runtime.evaluate', { expression: FIND_TERM, returnByValue: true });
    const scrolled = await tab.send('Runtime.evaluate', {
        expression: `
            (() => {
                const t = window.__VHGD_T;
                const before = t.buffer.active.viewportY;
                t.scrollLines(-50);
                const after = t.buffer.active.viewportY;
                t.scrollToBottom();
                return { before, after };
            })()`,
        returnByValue: true,
    });
    const sc = scrolled.result?.result?.value;
    check('② 纯本地滚动生效（零 RPC 往返）', sc && sc.after < sc.before, `viewportY ${sc?.before} → ${sc?.after}`);
} catch (e) {
    console.error(`\n跑不出结论：${e?.message ?? e}`);
    // --keep 在失败路径上同样生效：诊断时最需要的就是现场。
    if (tid && !opts.keep) cleanupTerminal(tid, { preExisting });
    else if (tid) console.error(`（--keep：保留 vh-${tid} 供诊断，记得手动清理）`);
    if (tab && targetId) await closeTab(opts.port, targetId, tab).catch(() => { });
    process.exit(2);
}

if (tid && !opts.keep) cleanupTerminal(tid, { preExisting });
if (tab && targetId) await closeTab(opts.port, targetId, tab).catch(() => { });

const failed = checks.filter((c) => !c.ok);
console.error(`\n${checks.length - failed.length}/${checks.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
