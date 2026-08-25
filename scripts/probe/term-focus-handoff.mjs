#!/usr/bin/env node
/**
 * 点击终端后的**焦点交接**验证 —— `?input=own` 下的最高真机风险。
 *
 * 风险是什么
 * ----------
 * 我们的输入元素是 `pointer-events:none`（不能挡住光标附近的拖选，spec §R6），
 * 所以点击终端画面仍然走 xterm 自己的 `mousedown → term.focus()` → **helper
 * textarea 拿到焦点**。此时 `attachCustomKeyEventHandler` 的安全带会把真实按键
 * 全部否决 ⇒ **光标看着还在、打字全哑**。实现里靠 root 上的 `focusin` 把焦点
 * 弹回 `.vh-term-input` 自愈（termInputHost.ts 的 onFocusIn）。
 *
 * 这个脚本就验这条自愈路径 —— 点不同位置各来一次，每次：
 *   ① 点完立刻发一个可打印键 + 一个方向键，断言 `__vhTermInput.routed` 有增长
 *      且 `emitted` 里有对应字节（= 键真的进了 PTY，不是打进空气）；
 *   ② 断言 `document.activeElement` 是 `.vh-term-input`；
 *   ③ 顺带取 `__vhTermDiag.snapshot()`，看 `focusOwner` 是不是 'terminal'
 *      （overlay 被报成 'other' 就是 classifyFocusHolder 漏了 class 兜底那一层）。
 *
 * 纪律与三道闸完全复用 term-input-goldendiff.mjs（新建专用终端 / 硬断言 fresh=1 /
 * 断言 id 不在开跑前的 tmux 快照里 / finally 清理），**绝不碰 Owner 已有的会话**。
 *
 *   node scripts/probe/term-focus-handoff.mjs
 *   node scripts/probe/term-focus-handoff.mjs --clicks 5 --base https://veryhappy.dev
 *
 * 退出码：0=全部通过  1=有断言失败  2=跑不出结论（没建成终端/契约不在/页面没起来）
 */

import { hostname } from 'node:os';
import {
    ensureChrome, attachExisting, openTab, closeTab, ensureLoggedIn, ensureDebugMode,
    createTestTerminal, cleanupTerminal, prepSink, waitFor, FIND_TERM,
} from './term-input-goldendiff.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
    const o = {
        base: 'https://veryhappy.dev',
        port: 9227,
        profile: '/tmp/vh-goldendiff-profile',
        chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        machine: hostname(),
        settle: 250,
        keepTerminal: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i];
        switch (a) {
            case '--base': case '--url': o.base = next(); break;
            case '--port': o.port = Number(next()); break;
            case '--profile': o.profile = next(); break;
            case '--machine': o.machine = next(); break;
            case '--settle': o.settle = Number(next()); break;
            case '--keep-terminal': o.keepTerminal = true; break;
            default: throw new Error(`未知参数: ${a}`);
        }
    }
    return o;
}

/** 点击位置：中心 / 靠左 / 靠下 / 右上 / 再回中心（同一处重复也要稳）。 */
const SPOTS = [
    { name: '中心', fx: 0.50, fy: 0.50 },
    { name: '靠左', fx: 0.12, fy: 0.50 },
    { name: '靠下', fx: 0.50, fy: 0.88 },
    { name: '右上', fx: 0.85, fy: 0.15 },
    { name: '中心(重复)', fx: 0.50, fy: 0.50 },
];

const esc = (s) => (s === '' ? '(空)' : String(s).replace(/[\x00-\x1f\x7f]/g, (c) => {
    const n = c.charCodeAt(0);
    if (n === 0x1b) return 'ESC';
    if (n === 0x0d) return '\\r';
    return '\\x' + n.toString(16).padStart(2, '0');
}));

async function main() {
    let opts;
    try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); return 2; }

    let terminalId = null, ownsTerminal = false, preExisting = null;
    let setupTab = null, tab = null;
    let exitCode = 2;

    const doCleanup = () => {
        if (!ownsTerminal || !terminalId) return;
        if (opts.keepTerminal) {
            console.error(`⚠️ --keep-terminal：vh-${terminalId} 留着没清`);
            return;
        }
        cleanupTerminal(terminalId, { preExisting });
        ownsTerminal = false;
    };
    const onSignal = () => { doCleanup(); process.exit(130); };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    try {
        const chrome = await ensureChrome(opts);
        console.error(`Chrome ${chrome.version}（${chrome.launched ? '本次拉起' : '复用已在跑的'}，port ${opts.port}）`);
        setupTab = await attachExisting(opts.port, 'about:blank');
        console.error(`登录状态：${await ensureLoggedIn(setupTab, opts)}`);
        console.error(`debugMode：${await ensureDebugMode(setupTab)}`);

        const created = await createTestTerminal(setupTab, opts);
        terminalId = created.tid;
        preExisting = created.before;
        ownsTerminal = true;
        console.error(`专用测试终端 vh-${terminalId}（machine ${created.machineId}，来源 ${created.discoveredBy}）—— 跑完 kill + 墓碑`);
        await waitFor(async () => (await setupTab.evalJs(`!!document.querySelector('.xterm')`)) === true, 40000, '新终端没连上');
        await sleep(2500);
        const found = await setupTab.evalJs(FIND_TERM);
        if (found !== 'ok') throw new Error(`建终端后找不到 xterm 实例：${found}`);
        await prepSink(setupTab);   // raw 模式字节水槽：扫描键不会作用到 shell
        console.error('已把终端压成 raw 模式字节水槽');
        await closeTab(opts.port, setupTab.target.id, setupTab);
        setupTab = null;

        const url = `${opts.base}/terminal/${created.machineId}?tid=${terminalId}&input=own`;
        tab = await openTab(opts.port, url);
        await waitFor(async () => (await tab.evalJs(`!!document.querySelector('.xterm')`)) === true, 40000, `终端页没加载（${url}）`);
        await sleep(2500);
        if ((await tab.evalJs(FIND_TERM)) !== 'ok') throw new Error('新 tab 里找不到 xterm 实例');

        const contract = await tab.evalJson(`JSON.stringify({
            hasBuf: !!window.__vhTermInput,
            hasDiag: !!window.__vhTermDiag,
            ownEls: document.querySelectorAll('.vh-term-input').length,
            path: window.__vhTermInput ? (window.__vhTermInput.path ?? null) : null,
        })`);
        console.error(`契约：${JSON.stringify(contract)}`);
        if (!contract.hasBuf) throw new Error('window.__vhTermInput 不在（debugMode 没开？契约没上线？）⇒ 判 inconclusive');
        if (contract.ownEls !== 1) throw new Error(`?input=own 下 .vh-term-input 个数 = ${contract.ownEls}（期望 1）⇒ 自有输入路径没生效`);

        const box = await tab.evalJson(`(()=>{const e=document.querySelector('.xterm-screen')||document.querySelector('.xterm');
            const r=e.getBoundingClientRect(); return JSON.stringify({l:r.left,t:r.top,w:r.width,h:r.height});})()`);

        const sendKey = async (k) => {
            const common = {
                modifiers: 0, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode,
                key: k.key, code: k.code, location: 0,
            };
            const withText = k.text ? { text: k.text, unmodifiedText: k.text } : {};
            await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', ...common, ...withText });
            await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
            await sleep(opts.settle);
        };
        const read = async () => tab.evalJson(`JSON.stringify((()=>{
            const b = window.__vhTermInput || {};
            const ae = document.activeElement;
            const norm = (e) => typeof e === 'string' ? e : (e && (e.data ?? e.text)) ?? '';
            return {
              routed: (b.routed || []).length,
              emitted: ((b.emitted) || []).map(norm),
              activeTag: ae ? (ae.tagName + (ae.className ? '.' + String(ae.className).slice(0,40) : '')) : null,
              activeIsOwn: !!(ae && ae.classList && ae.classList.contains('vh-term-input')),
              activeIsHelperTa: !!(ae && ae.classList && ae.classList.contains('xterm-helper-textarea')),
            };
        })())`);

        const rows = [];
        for (const spot of SPOTS) {
            // 先把焦点丢掉，保证这一轮的焦点确实是"点击 → xterm 抢 → 自愈"挣回来的
            await tab.evalJs(`(()=>{ const ae=document.activeElement; if (ae && ae.blur) ae.blur(); return 'ok'; })()`);
            await sleep(150);
            const beforeBlur = await read();

            const x = box.l + box.w * spot.fx, y = box.t + box.h * spot.fy;
            await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
            await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
            await sleep(250);
            const afterClick = await read();

            await tab.evalJs(`(()=>{ try { window.__vhTermInput.routed.length = 0; window.__vhTermInput.emitted.length = 0; } catch (e) {} return 'ok'; })()`);
            await sendKey({ key: 'x', code: 'KeyX', keyCode: 88, text: 'x' });
            const afterPrintable = await read();
            await tab.evalJs(`(()=>{ try { window.__vhTermInput.routed.length = 0; window.__vhTermInput.emitted.length = 0; } catch (e) {} return 'ok'; })()`);
            await sendKey({ key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 });
            const afterArrow = await read();

            rows.push({
                spot: spot.name,
                blurredTo: beforeBlur.activeTag,
                afterClickActive: afterClick.activeTag,
                activeIsOwn: afterClick.activeIsOwn,
                printable: { routed: afterPrintable.routed, emitted: afterPrintable.emitted.join('') },
                arrow: { routed: afterArrow.routed, emitted: afterArrow.emitted.join('') },
                activeAfterKeys: afterArrow.activeTag,
            });
        }

        const diag = await tab.evalJson(`JSON.stringify(window.__vhTermDiag ? window.__vhTermDiag.snapshot() : null)`);

        // ── 判定 ────────────────────────────────────────────────────────────
        const fails = [];
        for (const r of rows) {
            if (!r.activeIsOwn) fails.push(`[${r.spot}] 点击后 activeElement = ${r.afterClickActive}（期望 .vh-term-input）—— focusin 自愈没接住`);
            if (r.printable.routed <= 0) fails.push(`[${r.spot}] 可打印键 routed 没增长`);
            if (r.printable.emitted !== 'x') fails.push(`[${r.spot}] 可打印键 emitted = ${esc(r.printable.emitted)}（期望 'x'）`);
            if (r.arrow.routed <= 0) fails.push(`[${r.spot}] 方向键 routed 没增长`);
            if (r.arrow.emitted !== '\x1b[C' && r.arrow.emitted !== '\x1bOC') fails.push(`[${r.spot}] 方向键 emitted = ${esc(r.arrow.emitted)}（期望 ESC[C 或 ESCOC）`);
        }

        console.log('');
        console.log(`点击后焦点交接验证   ?input=own   终端 vh-${terminalId} @ ${opts.machine}`);
        console.log('');
        for (const r of rows) {
            console.log(`  ${r.activeIsOwn ? '✔' : '✘'} ${r.spot.padEnd(12)} 点后焦点=${r.afterClickActive}`);
            console.log(`      可打印 x   routed+${r.printable.routed}  emitted=${esc(r.printable.emitted)}`);
            console.log(`      方向 →     routed+${r.arrow.routed}  emitted=${esc(r.arrow.emitted)}`);
        }
        console.log('');
        console.log(`__vhTermDiag.snapshot(): ${JSON.stringify(diag, null, 2)}`);
        console.log('');
        if (fails.length) {
            console.log('失败：');
            for (const f of fails) console.log(`  ✘ ${f}`);
            exitCode = 1;
        } else {
            console.log(`结论：${rows.length}/${rows.length} 次点击都完成了焦点交接，键照常进 PTY ✅`);
            exitCode = 0;
        }
        if (diag && diag.focusOwner !== 'terminal') {
            console.log(`⚠️ __vhTermDiag.focusOwner = ${JSON.stringify(diag.focusOwner)}（期望 'terminal'）—— ` +
                `classifyFocusHolder 把我们的 overlay 认成了别人，诊断量会误导排查。`);
        }
    } catch (e) {
        console.error('');
        console.error(`✘ 跑不出结论：${e.message}`);
        exitCode = 2;
    } finally {
        try { if (tab) await closeTab(opts.port, tab.target.id, tab); } catch { /* 已关 */ }
        try { if (setupTab) await closeTab(opts.port, setupTab.target.id, setupTab); } catch { /* 已关 */ }
        doCleanup();
    }
    return exitCode;
}

process.exitCode = await main();
