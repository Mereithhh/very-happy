/**
 * MirrorInputBar — B-107, the mirror's v2 interaction path.
 *
 * A single input row at the bottom of a terminal-mirror session. The text is
 * NOT a session message: it goes over the machine RPC `mirror-terminal-send`
 * straight into the terminal's pty (tmux bracketed paste + Enter), exactly as
 * if typed in the terminal — and flows back into the mirror through the
 * transcript. The mirror session itself stays strictly read-only.
 *
 * Visibility gate (client-side courtesy; the daemon re-checks HARD): the
 * bound terminal must still exist and its pane must look like claude
 * (agentState !== 'shell'). After claude exits, pasted bytes would execute in
 * a bare shell — the daemon refuses with `mirror-not-active` and we surface
 * that instead of trusting a stale page.
 */
import { useState, useRef } from 'react';
import { SendHorizontal } from 'lucide-react';
import { useSession } from '@/sync/storage';
import { useTerminalSessions } from '@/sync/terminalSessions';
import { useTerminalAgentState } from '@/sync/terminalAgentState';
import { machineMirrorTerminalSend } from '@/sync/ops';
import { useImeGuard } from '@/utils/ime';
import { useToast } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import './mirror.css';

export function MirrorInputBar({ sessionId }: { sessionId: string }) {
    const { t } = useTranslation();
    const toast = useToast();
    const session = useSession(sessionId);
    const terminalId = session?.metadata?.terminalId;
    const machineId = session?.metadata?.machineId;
    const agentState = useTerminalAgentState(terminalId);
    const terminalLive = useTerminalSessions(
        (s) => !!terminalId && s.terminals.some((x) => x.id === terminalId),
    );
    const ime = useImeGuard();
    const taRef = useRef<HTMLTextAreaElement>(null);
    const [text, setText] = useState('');
    const [sending, setSending] = useState(false);

    // No terminal, or claude verifiably gone from the pane → no input bar.
    // (agentState may be undefined while the pane is unclassifiable — allow
    // those; the daemon-side active-binding guard is the real gate.)
    if (!terminalId || !machineId || !terminalLive || agentState === 'shell') {
        return null;
    }

    const send = async () => {
        const value = text.trim();
        if (value.length === 0 || sending) return;
        setSending(true);
        try {
            const result = await machineMirrorTerminalSend(machineId, terminalId, value);
            if (result.success) {
                setText('');
                taRef.current?.focus();
            } else if (result.reason === 'not-active') {
                toast.error(t('session.mirror.sendNotActive'));
            } else if (result.reason === 'unsupported') {
                toast.error(t('session.mirror.sendUnsupported'));
            } else {
                toast.error(t('session.mirror.sendFailed', { error: result.error }));
            }
        } finally {
            setSending(false);
        }
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey && !ime.isGuarded(e)) {
            e.preventDefault();
            void send();
        }
    };

    return (
        <div className="mri">
            <textarea
                ref={taRef}
                className="mri-input"
                rows={1}
                value={text}
                placeholder={t('session.mirror.inputPlaceholder')}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKeyDown}
                onCompositionStart={ime.onCompositionStart}
                onCompositionEnd={ime.onCompositionEnd}
                disabled={sending}
            />
            <button
                type="button"
                className="mri-send"
                onClick={() => void send()}
                disabled={sending || text.trim().length === 0}
                aria-label={t('session.mirror.send')}
                title={t('session.mirror.sendHint')}
            >
                <SendHorizontal size={16} />
            </button>
        </div>
    );
}
