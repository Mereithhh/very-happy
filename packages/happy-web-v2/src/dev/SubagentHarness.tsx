/** DEV-only visual harness for the sub-agent pointer row + drawer (B-317).
 *  Route is `/dev/subagent/:id` so the row sees a session id and takes the
 *  real drawer path instead of the no-session inline fallback. */
import { useEffect, useState } from 'react';
import { storage } from '@/sync/storage';
import type { ToolCallMessage } from '@/sync/typesMessage';
import { ToolGroupView } from '@/screens/session/ToolGroupView';
import { SubagentPanel } from '@/screens/session/SubagentPanel';
import { onSubagentOpen } from '@/screens/session/subagentPanelState';
import '@/screens/session/session.css';

const SESSION_ID = 'dev-subagent';
const NOW = Date.now();

function child(id: string, name: string, input: Record<string, unknown>, state: ToolCallMessage['tool']['state'] = 'completed'): ToolCallMessage {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: NOW,
        children: [],
        tool: { name, state, input, createdAt: NOW, startedAt: NOW, completedAt: NOW, description: null },
    };
}

function card(id: string, status: 'running' | 'completed' | 'failed' | 'stopped', extra: Record<string, unknown> = {}): ToolCallMessage {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: NOW,
        children: Array.from({ length: 10 }, (_, i) =>
            child(`${id}-c${i}`, 'Bash', { command: `cd /Users/jojo/.claude/skills/apodex-product/scripts/platform && set -a && source ~/.secrets/env/infra-aws.env && ./ops-cli quota show --account ${i}` })),
        subagent: { status, subagentType: 'general-purpose', updatedAt: NOW, ...extra } as ToolCallMessage['subagent'],
        tool: {
            name: 'Task',
            state: status === 'running' ? 'running' : 'completed',
            input: {
                sessionSubagent: `sub-${id}`,
                subagent_type: 'general-purpose',
                description: '查 API Platform TPM 配置',
                prompt: Array.from({ length: 24 }, (_, i) => `${i + 1}. 一段很长的任务说明，用来验证它不会再被直接倾倒进对话流里。`).join('\n'),
            },
            createdAt: NOW,
            startedAt: NOW,
            completedAt: status === 'running' ? null : NOW + 42_000,
            description: null,
        },
    };
}

const CARDS = [
    card('task-running', 'running'),
    card('task-done', 'completed', { result: { text: '## 结论\n\nTPM 可以安全提到 200000。' }, usage: { toolUses: 10, totalTokens: 41200, durationMs: 42_000 } }),
    card('task-stopped', 'stopped'),
];

export function SubagentHarness() {
    const [open, setOpen] = useState<string | null>(null);
    useEffect(() => {
        storage.setState((state) => ({
            sessionMessages: {
                ...state.sessionMessages,
                [SESSION_ID]: {
                    messages: [...CARDS].reverse(),
                    messagesMap: Object.fromEntries(CARDS.map((c) => [c.id, c])),
                    isLoaded: true,
                    hasMoreOlder: false,
                    isLoadingOlder: false,
                } as never,
            },
        }));
        return onSubagentOpen((detail) => setOpen(detail.messageId));
    }, []);
    return (
        <div className={`sd${open ? ' sd--files-open' : ''}`}>
            <div className="sd-main">
                <div className="sd-body" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {CARDS.map((c) => <ToolGroupView key={c.id} tools={[c]} />)}
                </div>
            </div>
            {open && (
                <>
                    <div className="sd-files-scrim" onClick={() => setOpen(null)} aria-hidden />
                    <aside className="sd-files">
                        <SubagentPanel sessionId={SESSION_ID} messageId={open} onClose={() => setOpen(null)} />
                    </aside>
                </>
            )}
        </div>
    );
}
