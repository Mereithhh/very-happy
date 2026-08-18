/**
 * B-007 端到端（daemon 侧）：真的起子进程跑 provider，验契约与失败路径。
 * 用仓库自带的示例 provider 当固定后端——不接任何外部服务。
 */
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const settings: { todoProvider?: unknown } = {};
vi.mock('@/persistence', () => ({ readSettings: async () => settings }));

import { registerTodoHandlers } from './todoRpc';

const EXAMPLE = resolve(__dirname, '../../../examples/todo-provider-jsonfile.mjs');

/** 收集 registerHandler 注册进来的 handler。 */
function collect() {
    const handlers = new Map<string, (p: any) => Promise<any>>();
    registerTodoHandlers({ registerHandler: (m: string, h: any) => handlers.set(m, h) } as any);
    return handlers;
}

let store: string;
beforeEach(() => {
    store = join(mkdtempSync(join(tmpdir(), 'vh-todo-')), 'todos.json');
    settings.todoProvider = { command: EXAMPLE, args: ['--file', store] };
});

describe('todo RPC 走真实 provider', () => {
    it('create → list → complete → list 全链路', async () => {
        const h = collect();
        await h.get('todo-create')!({ title: '写周报' });
        let listed = await h.get('todo-list')!({});
        expect(listed.items).toHaveLength(1);
        expect(listed.items[0].title).toBe('写周报');

        await h.get('todo-complete')!({ id: listed.items[0].id });
        listed = await h.get('todo-list')!({});
        // 示例 provider 的 list 过滤掉 done —— 以外部系统的实际状态为准
        expect(listed.items).toHaveLength(0);
    });

    it('标题里的引号/分号原样存活，不被 shell 解释（安全回归）', async () => {
        const h = collect();
        const nasty = `it's a "test"; touch /tmp/vh-pwned-$$`;
        await h.get('todo-create')!({ title: nasty });
        const listed = await h.get('todo-list')!({});
        expect(listed.items[0].title).toBe(nasty);
        // provider 文件里存的也是原文，说明整条链路没有任何一处过 shell
        expect(readFileSync(store, 'utf8')).toContain('touch /tmp/vh-pwned-$$');
    });

    it('未配置 provider → not-configured', async () => {
        settings.todoProvider = undefined;
        await expect(collect().get('todo-list')!({})).rejects.toThrow(/not-configured/);
    });

    it('provider 非零退出 → 把它的 stderr 原样带出来', async () => {
        const h = collect();
        await expect(h.get('todo-complete')!({ id: 'nope' })).rejects.toThrow(/provider-error.*no todo with id nope/s);
    });

    it('provider 吐非 JSON → bad-output', async () => {
        const bad = join(mkdtempSync(join(tmpdir(), 'vh-bad-')), 'p.mjs');
        writeFileSync(bad, '#!/usr/bin/env node\nprocess.stdout.write("not json")\n');
        chmodSync(bad, 0o755);
        settings.todoProvider = { command: bad };
        await expect(collect().get('todo-list')!({})).rejects.toThrow(/bad-output/);
    });

    it('provider 卡住 → timeout（不是一直挂着）', async () => {
        const slow = join(mkdtempSync(join(tmpdir(), 'vh-slow-')), 'p.mjs');
        writeFileSync(slow, '#!/usr/bin/env node\nsetTimeout(()=>{},60000)\n');
        chmodSync(slow, 0o755);
        settings.todoProvider = { command: slow, timeoutMs: 300 };
        await expect(collect().get('todo-list')!({})).rejects.toThrow(/timeout/);
    });

    it('可执行文件不存在 → spawn-failed，不崩', async () => {
        settings.todoProvider = { command: '/nonexistent/vh-provider' };
        await expect(collect().get('todo-list')!({})).rejects.toThrow(/spawn-failed/);
    });

    it('缺 id / 缺 title 被挡在跑子进程之前', async () => {
        const h = collect();
        await expect(h.get('todo-complete')!({})).rejects.toThrow(/invalid-params/);
        await expect(h.get('todo-create')!({ title: '   ' })).rejects.toThrow(/invalid-params/);
    });
});
