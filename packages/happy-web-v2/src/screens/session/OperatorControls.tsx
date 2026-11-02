/**
 * B-867 operator controls — what an operator grantee gets on top of the
 * driver composer: interrupt, permission mode (never above the owner's mode
 * in effect, spec §4) and model. Every call is a session RPC the web routes
 * through the server broker; the broker re-applies the same cap, so the
 * disabled options here are a courtesy, not the enforcement.
 */
import { Square } from 'lucide-react';
import { useState } from 'react';
import { RUN_INTENT_RPC } from '@slopus/happy-wire';
import { useSession } from '@/sync/storage';
import { sessionAbort, sessionSetPermissionMode } from '@/sync/ops';
import { apiSocket } from '@/sync/apiSocket';
import { operatorModeAllowed, operatorModeChoices } from '@/sync/operatorProtocol';
import { SelectMenu } from '@/ui/SelectMenu';
import { Button } from '@/ui';
import { toast } from '@/ui/Toast';
import { useTranslation } from '@/i18n/useTranslation';
import { operatorErrorCode, operatorErrorCopy } from './operatorCopy';
import './shared.css';

export function OperatorControls({ sessionId }: { sessionId: string }) {
    const { t } = useTranslation();
    const session = useSession(sessionId);
    const [busy, setBusy] = useState<'stop' | 'mode' | 'model' | null>(null);
    if (!session) return null;
    const meta = session.metadata;
    const ownerMode = meta?.permissionMode ?? null;
    const choices = operatorModeChoices(meta?.flavor, ownerMode);
    const models = (meta?.models ?? []).map((m) => m.code).filter((c): c is string => typeof c === 'string' && c.length > 0);
    const currentModel = meta?.modelIntent ?? meta?.currentModelCode ?? null;
    const fail = (e: unknown) => toast.error(operatorErrorCopy(t, operatorErrorCode(e)));

    const stop = async () => {
        setBusy('stop');
        try { await sessionAbort(sessionId); } catch (e) { fail(e); } finally { setBusy(null); }
    };
    const setMode = async (mode: string) => {
        if (!operatorModeAllowed(mode, ownerMode)) { toast.error(t('share.operator.errors.modeEscalation')); return; }
        setBusy('mode');
        try { await sessionSetPermissionMode(sessionId, mode); } catch (e) { fail(e); } finally { setBusy(null); }
    };
    const setModel = async (model: string) => {
        setBusy('model');
        try {
            const raw = await apiSocket.sessionRPC<{ ok?: boolean; error?: unknown }, { modelIntent: string }>(sessionId, RUN_INTENT_RPC, { modelIntent: model });
            if (!raw || raw.ok !== true) throw new Error('run intent refused');
        } catch (e) { fail(e); } finally { setBusy(null); }
    };

    return (
        <div className="opc" role="group" aria-label={t('share.roleOperator')}>
            <Button type="button" variant="ghost" size="sm" leftIcon={<Square size={12} fill="currentColor" />} loading={busy === 'stop'} onClick={() => void stop()}>
                {t('session.chat.stop')}
            </Button>
            <span className="opc-field">
                <span className="opc-label" id={`opc-mode-${sessionId}`}>{t('share.operator.modeLabel')}</span>
                <SelectMenu<string>
                    className="opc-select"
                    label={t('session.chat.permissionLabel')}
                    labelledBy={`opc-mode-${sessionId}`}
                    value={ownerMode ?? 'default'}
                    options={choices.map((c) => ({ value: c.value, label: c.value, disabled: !c.allowed }))}
                    onChange={(v) => void setMode(v)}
                />
            </span>
            {models.length > 0 && (<span className="opc-field">
                <span className="opc-label" id={`opc-model-${sessionId}`}>{t('session.chat.modelLabel')}</span>
                <SelectMenu<string>
                    className="opc-select"
                    label={t('session.chat.modelLabel')}
                    labelledBy={`opc-model-${sessionId}`}
                    value={currentModel && models.includes(currentModel) ? currentModel : models[0]}
                    options={models.map((m) => ({ value: m, label: m }))}
                    onChange={(v) => void setModel(v)}
                />
            </span>)}
        </div>
    );
}
