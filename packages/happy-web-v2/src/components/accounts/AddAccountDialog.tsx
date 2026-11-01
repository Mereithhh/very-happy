/**
 * B-850c 「添加账号」 (design F4). One dialog, three kinds:
 * - Claude subscription: login-start → open the URL → paste the code →
 *   poll login-status until a terminal state. Re-login of an existing
 *   account passes its `accountId`.
 * - API URL + key: key from a file on the machine (default), an env var name,
 *   or pasted (Q2: relayed through the server, not stored there — the form
 *   says so). The pasted value lives only in this component's state and is
 *   cleared on submit / close.
 * - Codex device code: placeholder, shown only when the daemon lists the kind.
 */
import * as Dialog from '@radix-ui/react-dialog';
import { ExternalLink, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button, Segmented, Spinner, toast } from '@/ui';
import { CopyButton } from '@/ui/CopyButton';
import { useTranslation } from '@/i18n/useTranslation';
import {
    LOGIN_POLL_MS,
    isLoginTerminal,
    isValidBaseUrl,
    isValidEnvName,
    parseModelList,
    type LoginStatus,
} from '@/sync/agentProfiles';
import {
    agentProfileAdd,
    agentProfileLoginCancel,
    agentProfileLoginStart,
    agentProfileLoginStatus,
    agentProfileLoginSubmit,
    type AgentProfileKeyInput,
} from '@/sync/agentProfileOps';
import { accountErrorText } from './accountText';
import '@/screens/session/sessionOptionsDialog.css';
import '@/components/modelConfig/modelConfigEditor.css';
import './accounts.css';

type Kind = 'claude-subscription' | 'claude-api' | 'codex-chatgpt';
type KeySource = AgentProfileKeyInput['source'];

export function AddAccountDialog({ open, onOpenChange, machineId, machineName, kinds, relogin }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    machineId: string;
    machineName: string;
    /** kinds the daemon can add (AgentProfilesState.kinds) */
    kinds: readonly string[];
    /** re-login an existing subscription account */
    relogin?: { accountId: string; label: string } | null;
}) {
    const { t } = useTranslation();
    const titleRef = useRef<HTMLHeadingElement>(null);
    const offered: Kind[] = (['claude-subscription', 'claude-api', 'codex-chatgpt'] as const).filter((k) => kinds.includes(k));
    const [kind, setKind] = useState<Kind>(relogin ? 'claude-subscription' : offered[0] ?? 'claude-subscription');
    const [label, setLabel] = useState(relogin?.label ?? '');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    // subscription
    const [login, setLogin] = useState<LoginStatus | null>(null);
    const [code, setCode] = useState('');
    const loginRef = useRef<LoginStatus | null>(null);
    loginRef.current = login;
    // api
    const [baseUrl, setBaseUrl] = useState('');
    const [models, setModels] = useState('');
    const [keySource, setKeySource] = useState<KeySource>('file');
    const [keyPath, setKeyPath] = useState('');
    const [keyEnv, setKeyEnv] = useState('');
    const [keyValue, setKeyValue] = useState('');

    useEffect(() => {
        if (!open) return;
        setKind(relogin ? 'claude-subscription' : offered[0] ?? 'claude-subscription');
        setLabel(relogin?.label ?? '');
        setError(null); setBusy(false); setLogin(null); setCode('');
        setBaseUrl(''); setModels(''); setKeySource('file'); setKeyPath(''); setKeyEnv(''); setKeyValue('');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, relogin?.accountId]);

    // Poll the machine until the sign-in ends (contract: every 1–2 s).
    const loginId = login && !isLoginTerminal(login.state) ? login.loginId : null;
    useEffect(() => {
        if (!loginId) return;
        let stopped = false;
        const timer = setInterval(() => {
            void agentProfileLoginStatus(machineId, loginId).then((result) => {
                if (stopped) return;
                if (result.ok) setLogin((current) => (current?.loginId === loginId ? { ...current, ...result.data, url: result.data.url ?? current.url } : current));
                else if (result.code === 'login-not-found') setLogin((current) => (current?.loginId === loginId ? { ...current, state: 'failed', error: accountErrorText(result, t) } : current));
            });
        }, LOGIN_POLL_MS);
        return () => { stopped = true; clearInterval(timer); };
    }, [loginId, machineId, t]);

    useEffect(() => {
        if (login?.state === 'succeeded') toast.success(t('accounts.loginSucceeded', { label: login.account?.label ?? label }));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [login?.state]);

    const close = (next: boolean) => {
        if (!next) {
            const running = loginRef.current;
            if (running && !isLoginTerminal(running.state)) void agentProfileLoginCancel(machineId, running.loginId);
            setKeyValue('');
            setCode('');
        }
        onOpenChange(next);
    };

    async function startLogin() {
        setBusy(true); setError(null);
        const result = await agentProfileLoginStart(machineId, relogin ? { accountId: relogin.accountId } : { label: label.trim() });
        setBusy(false);
        if (!result.ok) { setError(accountErrorText(result, t)); return; }
        setLogin(result.data);
    }

    async function submitCode() {
        if (!login || !code.trim()) return;
        setBusy(true); setError(null);
        const result = await agentProfileLoginSubmit(machineId, login.loginId, code.trim());
        setBusy(false);
        if (!result.ok) { setError(accountErrorText(result, t)); return; }
        setCode('');
        setLogin((current) => ({ ...result.data, url: result.data.url ?? current?.url }));
    }

    const keyInput = (): AgentProfileKeyInput | null => {
        if (keySource === 'file') return keyPath.trim() ? { source: 'file', path: keyPath.trim() } : null;
        if (keySource === 'env') return isValidEnvName(keyEnv) ? { source: 'env', name: keyEnv.trim() } : null;
        return keyValue.trim() ? { source: 'paste', value: keyValue.trim() } : null;
    };
    const apiReady = !!label.trim() && isValidBaseUrl(baseUrl) && !!keyInput();

    async function addApi() {
        const key = keyInput();
        if (!key || !apiReady) return;
        setBusy(true); setError(null);
        const result = await agentProfileAdd(machineId, { label: label.trim(), baseUrl: baseUrl.trim(), models: parseModelList(models), key });
        setBusy(false);
        if (!result.ok) { setError(accountErrorText(result, t)); return; }
        setKeyValue('');
        const account = result.data;
        if (account.status === 'ok') toast.success(t('accounts.addedOk', { label: account.label }));
        else toast.show(t('accounts.addedUnverified', { label: account.label, detail: account.statusDetail ?? account.status }), 'error');
        onOpenChange(false);
    }

    const kindOptions = offered.map((k) => ({
        value: k,
        label: k === 'claude-subscription' ? t('accounts.typeSubscription') : k === 'claude-api' ? t('accounts.typeApi') : t('accounts.typeCodex'),
    }));
    const kindHint = kind === 'claude-subscription' ? t('accounts.typeSubscriptionHint') : kind === 'claude-api' ? t('accounts.typeApiHint') : t('accounts.typeCodexHint');
    const loginEnded = login && isLoginTerminal(login.state);

    return <Dialog.Root open={open} onOpenChange={close}>
        <Dialog.Portal>
            <Dialog.Overlay className="vh-dialog-overlay so-overlay" />
            <Dialog.Content className="vh-dialog so-dialog acc-dialog" aria-describedby="acc-add-desc" data-testid="add-account-dialog"
                onOpenAutoFocus={(e) => { e.preventDefault(); titleRef.current?.focus(); }}>
                <div className="vh-dialog-head so-head">
                    <div>
                        <Dialog.Title ref={titleRef} tabIndex={-1} className="vh-dialog-title so-title">{relogin ? t('accounts.relogin') : t('accounts.addTitle')}</Dialog.Title>
                        <p id="acc-add-desc" className="so-description">{t('accounts.addDescription', { machine: machineName })}</p>
                    </div>
                    <Dialog.Close className="vh-dialog-close so-close" aria-label={t('common.close')}><X size={18} /></Dialog.Close>
                </div>

                <div className="so-fields">
                    {!relogin && kindOptions.length > 1 && <div className="so-field">
                        <span className="so-field-label" id="acc-kind">{t('accounts.typeLabel')}</span>
                        <Segmented labelledBy="acc-kind" className="acc-kinds" options={kindOptions} value={kind}
                            disabled={!!login && !loginEnded}
                            onChange={(next) => { setKind(next); setError(null); }} />
                        <span className="mce-hint">{kindHint}</span>
                    </div>}

                    {!relogin && <label className="so-field">
                        <span className="so-field-label">{t('accounts.nameLabel')}</span>
                        <input className="mce-input" value={label} maxLength={60} placeholder={t('accounts.namePlaceholder')} spellCheck={false}
                            disabled={!!login && !loginEnded} onChange={(e) => setLabel(e.target.value)} data-testid="account-label" />
                    </label>}

                    {kind === 'claude-subscription' && <>
                        {!login && <div className="mce-actions">
                            <Button variant="primary" loading={busy} disabled={!relogin && !label.trim()} onClick={() => void startLogin()} data-testid="account-login-start">
                                {busy ? t('accounts.starting') : t('accounts.startLogin', { machine: machineName })}
                            </Button>
                        </div>}
                        {login && login.state === 'waiting-code' && <div className="acc-login" data-testid="account-login-waiting">
                            <p className="acc-step"><span className="acc-step-n">1</span>{t('accounts.loginStep1')}</p>
                            {login.url && <div className="acc-link-row">
                                <a className="acc-link" href={login.url} target="_blank" rel="noopener noreferrer" data-testid="account-login-url">
                                    <ExternalLink size={14} aria-hidden="true" /><span>{t('accounts.openLink')}</span>
                                </a>
                                <CopyButton text={login.url} />
                            </div>}
                            <p className="acc-step"><span className="acc-step-n">2</span>{t('accounts.loginStep2')}</p>
                            <input className="mce-input mono" value={code} aria-label={t('accounts.codeLabel')} placeholder={t('accounts.codePlaceholder')}
                                autoComplete="off" spellCheck={false} autoCapitalize="off" autoCorrect="off" data-testid="account-login-code"
                                onChange={(e) => setCode(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void submitCode(); } }} />
                            <div className="mce-actions">
                                <Button variant="primary" loading={busy} disabled={!code.trim()} onClick={() => void submitCode()} data-testid="account-login-submit">{t('accounts.submitCode')}</Button>
                            </div>
                        </div>}
                        {login && login.state === 'starting' && <p className="mce-note" role="status"><Spinner size={13} /> {t('accounts.starting')}</p>}
                        {login && login.state === 'exchanging' && <p className="mce-note" role="status"><Spinner size={13} /> {t('accounts.exchanging')}</p>}
                        {login && login.state === 'succeeded' && <p className="mce-note" role="status" data-testid="account-login-done">{t('accounts.loginSucceeded', { label: login.account?.label ?? label })}</p>}
                        {login && (login.state === 'failed' || login.state === 'expired' || login.state === 'canceled') && <div className="acc-login">
                            <p className="mce-note mce-note--danger" role="alert">
                                {login.state === 'expired' ? t('accounts.loginExpired') : login.state === 'canceled' ? t('accounts.loginCanceled') : t('accounts.loginFailed', { error: login.error ?? '' })}
                            </p>
                            <div className="mce-actions"><Button onClick={() => { setLogin(null); setError(null); }}>{t('accounts.startAgain')}</Button></div>
                        </div>}
                        {login?.state === 'succeeded' && <div className="mce-actions"><Button variant="primary" onClick={() => onOpenChange(false)}>{t('common.ok')}</Button></div>}
                    </>}

                    {/* PR-D (B-850b): Codex device code — verificationUrl + userCode, offered only when the daemon lists the kind. */}
                    {kind === 'codex-chatgpt' && <p className="mce-note">{t('accounts.typeCodexHint')}</p>}

                    {kind === 'claude-api' && <>
                        <label className="so-field">
                            <span className="so-field-label">{t('accounts.baseUrlLabel')}</span>
                            <input className="mce-input mono" value={baseUrl} placeholder="https://api.anthropic.com" spellCheck={false} autoCapitalize="off" autoCorrect="off" inputMode="url"
                                onChange={(e) => setBaseUrl(e.target.value)} data-testid="account-base-url" />
                            {baseUrl.trim() && !isValidBaseUrl(baseUrl) && <span className="mce-hint mce-hint--warn">{t('accounts.baseUrlInvalid')}</span>}
                        </label>
                        <label className="so-field">
                            <span className="so-field-label">{t('accounts.modelsLabel')}</span>
                            <textarea className="mce-input mce-textarea mono" rows={3} value={models} spellCheck={false} placeholder={'claude-sonnet-5-5\nkimi-k3'}
                                onChange={(e) => setModels(e.target.value)} data-testid="account-models" />
                            <span className="mce-hint">{t('accounts.modelsHint')}</span>
                        </label>
                        <fieldset className="so-field mce-key">
                            <legend className="so-field-label">{t('accounts.keyLabel')}</legend>
                            <Segmented label={t('accounts.keyLabel')} className="mce-keymodes" value={keySource} onChange={setKeySource}
                                options={[{ value: 'file', label: t('accounts.keyFile') }, { value: 'env', label: t('accounts.keyEnv') }, { value: 'paste', label: t('accounts.keyPaste') }]} />
                            {keySource === 'file' && <>
                                <input className="mce-input mono" value={keyPath} placeholder={t('accounts.keyFilePlaceholder')} spellCheck={false} autoCapitalize="off" autoCorrect="off"
                                    aria-label={t('accounts.keyFile')} onChange={(e) => setKeyPath(e.target.value)} data-testid="account-key-path" />
                                <span className="mce-hint">{t('accounts.keyFileHint', { machine: machineName })}</span>
                            </>}
                            {keySource === 'env' && <>
                                <input className="mce-input mono" value={keyEnv} placeholder={t('accounts.keyEnvPlaceholder')} spellCheck={false} autoCapitalize="off" autoCorrect="off"
                                    aria-label={t('accounts.keyEnv')} onChange={(e) => setKeyEnv(e.target.value)} data-testid="account-key-env" />
                                <span className="mce-hint">{keyEnv.trim() && !isValidEnvName(keyEnv) ? t('accounts.keyEnvInvalid') : t('accounts.keyEnvHint', { machine: machineName })}</span>
                            </>}
                            {keySource === 'paste' && <>
                                <input className="mce-input" type="password" autoComplete="off" spellCheck={false} value={keyValue} placeholder="sk-…"
                                    aria-label={t('accounts.keyPaste')} onChange={(e) => setKeyValue(e.target.value)} data-testid="account-key-paste" />
                                <p className="mce-note mce-note--warn" data-testid="account-paste-warning">{t('accounts.keyPasteWarn', { machine: machineName })}</p>
                            </>}
                        </fieldset>
                        <div className="mce-actions">
                            <Button variant="primary" loading={busy} disabled={!apiReady} onClick={() => void addApi()} data-testid="account-add-submit">{t('accounts.save')}</Button>
                        </div>
                    </>}

                    {error && <p className="mce-note mce-note--danger" role="alert" data-testid="account-error">{error}</p>}
                </div>
            </Dialog.Content>
        </Dialog.Portal>
    </Dialog.Root>;
}
