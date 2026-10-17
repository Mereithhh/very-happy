/**
 * SharedComposer (B-619) — the ONLY write surface of a session shared with
 * me as a driver. Plain text goes to POST /v1/sessions/:id/shared-messages;
 * the server encrypts it with the session key, prefixes the sender header
 * and stores it as the owner's session traffic. There is deliberately no
 * mode / model / steer / attachment control here: a driver cannot change
 * how the owner's agent runs (spec §写路径).
 *
 * The echo comes back through the normal `new-message` update, so the
 * bubble appears when the server has it — no optimistic outbox needed.
 */
import { useRef, useState } from 'react';
import { SendHorizontal } from 'lucide-react';
import { randomUUID } from 'expo-crypto';
import { useSession, useSetting } from '@/sync/storage';
import { sendSharedMessage, SessionShareApiError } from '@/sync/apiSessionShares';
import { useImeGuard } from '@/utils/ime';
import { insertComposerNewline, isSoftKeyboardDevice, resolveComposerEnter } from '@/utils/composerEnter';
import { Spinner, useToast } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import './shared.css';

export function SharedComposer({ sessionId }: { sessionId: string }) {
    const { t } = useTranslation();
    const toast = useToast();
    const session = useSession(sessionId);
    const ime = useImeGuard();
    const enterToSend = useSetting('agentInputEnterToSend');
    const taRef = useRef<HTMLTextAreaElement>(null);
    const [text, setText] = useState('');
    const [sending, setSending] = useState(false);
    const archived = !!session?.archivedAt;

    const send = async () => {
        const value = text.trim();
        if (!value || sending || archived) return;
        setSending(true);
        try {
            await sendSharedMessage(sessionId, value, `shared-${randomUUID()}`);
            setText('');
            taRef.current?.focus();
        } catch (error) {
            const code = error instanceof SessionShareApiError ? error.code : 'unknown';
            toast.error(
                code === 'driver_only' || code === 'session_not_found' ? t('share.composer.noAccess')
                    : code === 'session_archived' ? t('share.composer.archived')
                        : t('share.composer.sendFailed', { error: code }),
            );
        } finally {
            setSending(false);
        }
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        const action = resolveComposerEnter(e, { guarded: ime.isGuarded(e), enterToSend, softKeyboard: isSoftKeyboardDevice() });
        if (action === 'send') { e.preventDefault(); void send(); }
        else if (action === 'newline') { e.preventDefault(); insertComposerNewline(e.currentTarget); }
    };

    return (
        <div className="shc">
            <textarea
                ref={taRef}
                className="shc-input"
                rows={1}
                value={text}
                placeholder={archived ? t('share.composer.archived') : t('share.composer.placeholder')}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKeyDown}
                onCompositionStart={ime.onCompositionStart}
                onCompositionEnd={ime.onCompositionEnd}
                disabled={sending || archived}
                aria-label={t('share.composer.placeholder')}
            />
            <button
                type="button"
                className="shc-send"
                onClick={() => void send()}
                disabled={sending || archived || text.trim().length === 0}
                aria-busy={sending}
                aria-label={t('share.composer.send')}
                title={t('share.composer.sendHint')}
            >
                {sending ? <Spinner size={14} /> : <SendHorizontal size={16} />}
            </button>
        </div>
    );
}
