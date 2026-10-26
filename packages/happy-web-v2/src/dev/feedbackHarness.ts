/** DEV-only (B-836): in-page `/v1/feedback*` for device captures — this account
 *  is a feedback admin with a few sample rows; posts succeed locally and are
 *  recorded on `window.__feedbackCalls`. Nothing leaves the page. */
export function installFeedbackApi(): () => void {
    const zh = typeof navigator === 'undefined' || navigator.language.toLowerCase().startsWith('zh');
    const now = Date.now();
    const items = [
        { id: 'fb-3', rating: 'bad', text: zh ? '手机上切回会话时，最新一条消息要等几秒才出现，期间也没有「同步中」提示。' : 'Switching back to a session on my phone, the newest message takes a few seconds to appear and nothing says it is syncing.', source: 'manual', createdAt: now - 12 * 60_000, readAt: null,
          diagnostics: { webVersion: '2.1.0', cliVersions: ['0.2.190'], userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_1 like Mac OS X)', language: 'zh-CN', viewport: '390x844', pointer: 'coarse', route: '/session/:id', timeZone: 'Asia/Singapore', ts: new Date(now - 12 * 60_000).toISOString() },
          account: { id: 'acc-ada', displayName: 'Ada Lin', username: 'ada', email: 'ada@example.com' } },
        { id: 'fb-2', rating: 'good', text: null, source: 'prompt', createdAt: now - 3 * 3600_000, readAt: null, diagnostics: null,
          account: { id: 'acc-bo', displayName: 'Bo', username: 'bo', email: null } },
        { id: 'fb-1', rating: 'ok', text: zh ? '团队页很好用，希望任务卡能按负责人筛选。' : 'Teams are great — I would like to filter task cards by assignee.', source: 'manual', createdAt: now - 26 * 3600_000, readAt: now - 20 * 3600_000, diagnostics: null,
          account: { id: 'acc-cy', displayName: 'Chen Yu', username: null, email: 'cy@example.org' } },
    ];
    const real = window.fetch;
    window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const parsed = new URL(url, location.href);
        const path = parsed.pathname;
        if (!path.startsWith('/v1/feedback')) return real(input, init);
        const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
        if (path === '/v1/feedback/admin/access') return json(200, { admin: true });
        if (path === '/v1/feedback/admin') {
            const unread = parsed.searchParams.get('unread') === 'true';
            return json(200, { items: items.filter((i) => !unread || i.readAt === null), nextCursor: null, unreadCount: items.filter((i) => i.readAt === null).length });
        }
        const read = path.match(/^\/v1\/feedback\/admin\/([^/]+)\/read$/);
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        ((window as unknown as { __feedbackCalls?: unknown[] }).__feedbackCalls ??= []).push({ path, method: init?.method ?? 'GET', body });
        if (read) {
            const item = items.find((i) => i.id === decodeURIComponent(read[1]));
            if (!item) return json(404, { error: 'feedback_not_found' });
            item.readAt = body.read ? Date.now() : null;
            return json(200, { feedback: item });
        }
        const view = { id: 'fb-new', rating: body.rating ?? 'good', text: body.text ?? null, diagnostics: body.diagnostics ?? null, source: body.source ?? 'manual', createdAt: Date.now(), readAt: null };
        return json(200, path === '/v1/feedback' ? { feedback: view, deduped: false } : { feedback: view });
    };
    return () => { window.fetch = real; };
}
