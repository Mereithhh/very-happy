import { useId, useRef, useState } from 'react';
import { Copy } from 'lucide-react';
import { BUILTIN_TODO_SKILL } from '@slopus/happy-wire';
import { useTranslation } from '@/i18n/useTranslation';
import { getServerUrl } from '@/sync/serverConfig';

function serverHint(): string {
    try {
        const url = new URL(getServerUrl());
        // Copy the service address only, never URL credentials or query tokens.
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return '(confirm in Very Happy settings)';
        return `${url.origin}${url.pathname.replace(/\/$/, '')}`;
    } catch {
        return '(confirm in Very Happy settings)';
    }
}

export function TodoAgentSetup() {
    const { lang } = useTranslation();
    const zh = lang.startsWith('zh');
    const words = (cn: string, en: string) => zh ? cn : en;
    const [state, setState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
    const [expanded, setExpanded] = useState(false);
    const inFlight = useRef(false);
    const previewId = useId();
    const payload = `${words(
        '请按照下面的官方 skill 接入 Very Happy 内置待办。安装前确认 CLI 连接到下列服务端，并请我确认登录账号与网页当前账号一致。验证只读取列表，不创建、完成或删除真实待办。不要读取或复制登录凭据到对话中。',
        'Set up access to Very Happy built-in todos using the official skill below. Before installation, verify the CLI targets the server below and ask me to confirm its signed-in account matches my current Web account. Validate by reading the list only; do not create, complete, or delete real tasks. Do not read or copy login credentials into this conversation.',
    )}\n\n${words('期望服务端', 'Expected server')}: ${serverHint()}\n\n${BUILTIN_TODO_SKILL}`;

    const copy = async () => {
        if (inFlight.current) return;
        inFlight.current = true;
        setState('copying');
        try {
            await navigator.clipboard.writeText(payload);
            setState('copied');
        } catch {
            setState('failed');
            setExpanded(true);
        } finally {
            inFlight.current = false;
        }
    };

    return <div className="td-agent-setup">
        <div className="td-agent-actions">
            <button type="button" className="td-action" disabled={state === 'copying'} onClick={() => void copy()}>
                <Copy size={16} aria-hidden="true" />
                {state === 'copying' ? words('复制中…', 'Copying…') : words('让 AI 使用我的待办', 'Let AI use my todos')}
            </button>
            <button type="button" className="td-action td-agent-preview-toggle" aria-expanded={expanded} aria-controls={previewId} onClick={() => setExpanded(value => !value)}>
                {expanded ? words('收起接入说明', 'Hide setup instructions') : words('查看接入说明', 'View setup instructions')}
            </button>
        </div>
        <p className="td-agent-hint">{words('复制官方 skill，粘贴给你的 coding agent，让它完成接入。', 'Copy the official skill and paste it into your coding agent to set up access.')}</p>
        <div role="status" aria-live="polite" aria-atomic="true" className="td-agent-feedback">{state === 'copied' ? words('已复制官方 skill，请粘贴给你的 coding agent。', 'Official skill copied. Paste it into your coding agent.') : ''}</div>
        {state === 'failed' && <p role="alert" className="td-agent-error">{words('复制失败。请重试，或选中下方全文手动复制。', 'Copy failed. Retry, or select all the text below and copy it manually.')}</p>}
        {expanded && <textarea id={previewId} className="td-input td-agent-preview" aria-label={words('官方 skill 接入说明', 'Official skill setup instructions')} readOnly rows={8} value={payload} onFocus={event => event.currentTarget.select()} />}
    </div>;
}
