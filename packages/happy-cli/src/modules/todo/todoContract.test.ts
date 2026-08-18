import { describe, expect, it } from 'vitest';
import {
    TODO_LIST_MAX_ITEMS,
    TODO_TITLE_MAX_CHARS,
    buildProviderArgv,
    parseTodoList,
} from './todoContract';

const ok = (s: string) => {
    const r = parseTodoList(s);
    if ('error' in r) throw new Error(`unexpected error: ${r.error}`);
    return r;
};

describe('parseTodoList — 正常路径', () => {
    it('只要 id+title 就够，其余可选', () => {
        const r = ok('{"items":[{"id":"a","title":"写周报"}]}');
        expect(r.items).toEqual([{ id: 'a', title: '写周报', status: 'open' }]);
        expect(r.dropped).toBe(0);
    });

    it('可选字段透传并规范化', () => {
        const r = ok(JSON.stringify({ items: [{
            id: 'a', title: 't', status: 'done', due: '2026-08-20',
            priority: 'high', group: '工作', note: 'n',
        }] }));
        expect(r.items[0]).toMatchObject({ status: 'done', due: '2026-08-20', priority: 'high', group: '工作', note: 'n' });
    });

    it('未知字段一律忽略（前向兼容：第三方 provider 加字段不该让旧客户端崩）', () => {
        const r = ok('{"items":[{"id":"a","title":"t","somethingNew":{"deep":1}}]}');
        expect(Object.keys(r.items[0]).sort()).toEqual(['id', 'status', 'title']);
    });

    it('未知 status/priority 退回安全默认', () => {
        const r = ok('{"items":[{"id":"a","title":"t","status":"weird","priority":"URGENT"}]}');
        expect(r.items[0].status).toBe('open');
        expect(r.items[0].priority).toBeUndefined();
    });
});

describe('parseTodoList — 畸形输入只丢弃不抛错', () => {
    it('非 JSON → 带原文片段的错误，不抛', () => {
        const r = parseTodoList('command not found');
        expect('error' in r && r.error).toContain('command not found');
    });

    it('空输出也给得出错误', () => {
        expect('error' in parseTodoList('')).toBe(true);
    });

    it('缺 items 数组 → 错误', () => {
        expect('error' in parseTodoList('{"todos":[]}')).toBe(true);
        expect('error' in parseTodoList('{"items":{}}')).toBe(true);
    });

    it('坏条目被丢弃、好条目保留，并报出丢了几条', () => {
        const r = ok(JSON.stringify({ items: [
            { id: 'a', title: 'good' },
            { id: 'b' },                 // 缺 title
            { title: 'no id' },          // 缺 id
            null, 'string', 42,          // 根本不是对象
            { id: '  ', title: 'blank id' },
            { id: 'c', title: 'also good' },
        ] }));
        expect(r.items.map((i) => i.id)).toEqual(['a', 'c']);
        expect(r.dropped).toBe(6);  // 缺title + 缺id + null + string + 42 + 空白id
    });

    it('丢弃后总数没超上限时**不该**报截断（review finding 7 的回归）', () => {
        // provider 返回 520 条、其中 100 条缺 id/title → 处理完只留 420 条，
        // 一条都没截。旧判据 `rawItems.length > MAX` 会骗人说「列表已截断」。
        const good = Array.from({ length: 420 }, (_, i) => ({ id: `g${i}`, title: 't' }));
        const bad = Array.from({ length: 100 }, () => ({ title: 'no id' }));
        const r = ok(JSON.stringify({ items: [...good, ...bad] }));
        expect(r.items).toHaveLength(420);
        expect(r.dropped).toBe(100);
        expect(r.truncated, '没有因为达上限而停下，就不该报截断').toBe(false);
    });

    it('超上限截断并标记', () => {
        const items = Array.from({ length: TODO_LIST_MAX_ITEMS + 10 }, (_, i) => ({ id: `i${i}`, title: 't' }));
        const r = ok(JSON.stringify({ items }));
        expect(r.items).toHaveLength(TODO_LIST_MAX_ITEMS);
        expect(r.truncated).toBe(true);
    });

    it('超长标题被截断（标题来自外部系统，是不可信输入）', () => {
        const r = ok(JSON.stringify({ items: [{ id: 'a', title: 'x'.repeat(TODO_TITLE_MAX_CHARS + 100) }] }));
        expect(r.items[0].title).toHaveLength(TODO_TITLE_MAX_CHARS);
    });
});

describe('buildProviderArgv — 安全回归（spec 风险 1）', () => {
    const config = { command: '/opt/p.mjs', args: ['--source', 'x'] };

    it('可执行文件与固定参数只来自本机配置', () => {
        expect(buildProviderArgv(config, 'list')).toEqual(['/opt/p.mjs', '--source', 'x', 'list']);
    });

    it('web 传来的内容只能落在末尾的操作数位，动不了 command/args', () => {
        const argv = buildProviderArgv(config, 'complete', '--source=/evil; rm -rf /');
        expect(argv[0]).toBe('/opt/p.mjs');
        expect(argv.slice(0, 4)).toEqual(['/opt/p.mjs', '--source', 'x', 'complete']);
        // 危险字符原样作为**单个 argv 元素**存在——没有 shell 会去解释它
        expect(argv[4]).toBe('--source=/evil; rm -rf /');
        expect(argv).toHaveLength(5);
    });

    it("标题里的引号与分号不会被拆成额外的 argv（不经 shell 的核心保证）", () => {
        const argv = buildProviderArgv(config, 'create', `it's a "test"; echo pwned`);
        expect(argv).toHaveLength(5);
        expect(argv[4]).toBe(`it's a "test"; echo pwned`);
    });
});
