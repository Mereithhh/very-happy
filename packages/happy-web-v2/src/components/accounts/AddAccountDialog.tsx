/**
 * B-850c 「添加账号」 (design F4). One dialog, three kinds:
 * - Claude subscription: login-start → open the URL → paste the code →
 *   poll login-status until a terminal state. Re-login of an existing
 *   account passes its `accountId`.
 * - API URL + key: key from a file on the machine (default), an env var name,
 *   or pasted (Q2: relayed through the server, not stored there — the form
 *   says so). The pasted value lives only in this component's state and is
 *   cleared on submit / close.
 * - B-850c2 (wire v3) Codex ChatGPT: device code — open the link, enter the
 *   userCode shown here; there is nothing to paste, the machine's app-server
 *   finishes the sign-in and status polling ends it. The name may stay empty
 *   (the account is then named after the signed-in email).
 * - B-850c2 Codex provider: a `[model_providers.X]` of the machine's
 *   ~/.codex/config.toml (the URL field only overrides) or an own URL with its
 *   wire API; models and the key as for an API account.
 * Kinds are per agent: the dialog only offers the ones this daemon can add.
 */
import * as Dialog from '@radix-ui/react-dialog';
import { DialogContent } from '@/ui/DialogContent';
import { ExternalLink, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button, Segmented, Spinner, toast } from '@/ui';
import { CopyButton } from '@/ui/CopyButton';
import { useTranslation } from '@/i18n/useTranslation';
import { Combobox } from '@/ui/Combobox';
import {
    AGENT_ACCOUNT_KINDS,
    LOGIN_POLL_MS,
    codexProviderAddFields,
    isLoginTerminal,
    isValidBaseUrl,
    isValidEnvName,
    baseUrlHost,
    parseModelList,
    type CodexProviderOption,
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

type Kind = 'claude-subscription' | 'claude-api' | 'codex-chatgpt' | 'codex-provider';
type KeySource = AgentProfileKeyInput['source'];
const CUSTOM_PROVIDER = '__custom__';

/** Pure: the kinds this dialog offers for `agent` on a daemon that can add `kinds`. */
export function offeredAccountKinds(agent: string, kinds: readonly string[]): Kind[] {
    return (AGENT_ACCOUNT_KINDS[agent] ?? []).filter((k) => kinds.includes(k)) as Kind[];
}

export function AddAccountDialog({ open, onOpenChange, machineId, machineName, agent = 'claude', kinds, codexProviders = [], relogin }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    machineId: string;
    machineName: string;
    /** whose account this is ('claude' | 'codex') */
    agent?: string;
    /** kinds the daemon can add (AgentProfilesState.kinds) */
    kinds: readonly string[];
    /** wire v3: the machine's config.toml providers (codex-provider form) */
    codexProviders?: readonly CodexProviderOption[];
    /** re-login an existing subscription account (Claude subscription or Codex ChatGPT) */
    relogin?: { accountId: string; label: string; kind: string } | null;
}) {
    const { t } = useTranslation();
    const titleRef = useRef<HTMLHeadingElement>(null);
    const offered = offeredAccountKinds(agent, kinds);
    const reloginKind: Kind = relogin?.kind === 'codex-chatgpt' ? 'codex-chatgpt' : 'claude-subscription';
    const initialKind: Kind = relogin ? reloginKind : offered[0] ?? 'claude-subscription';
    const [kind, setKind] = useState<Kind>(initialKind);
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
    // codex provider
    const [provider, setProvider] = useState<string>(codexProviders[0]?.id ?? CUSTOM_PROVIDER);
    const [wireApi, setWireApi] = useState<'responses' | 'chat'>('responses');
    const chosenProvider = codexProviders.find((p) => p.id === provider) ?? null;

    useEffect(() => {
        if (!open) return;
        setKind(initialKind);
        setLabel(relogin?.label ?? '');
        setError(null); setBusy(false); setLogin(null); setCode('');
        setBaseUrl(''); setModels(''); setKeySource('file'); setKeyPath(''); setKeyValue('');
        setProvider(codexProviders[0]?.id ?? CUSTOM_PROVIDER); setWireApi('responses');
        setKeyEnv(codexProviders[0]?.envKey ?? '');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, relogin?.accountId, agent]);

    // A config.toml provider names the variable its key lives in: offer it for the env source.
    const chooseProvider = (next: string) => {
        setProvider(next);
        const envKey = codexProviders.find((p) => p.id === next)?.envKey;
        if (envKey && (!keyEnv.trim() || codexProviders.some((p) => p.envKey === keyEnv.trim()))) setKeyEnv(envKey);
    };

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
        const which = kind === 'codex-chatgpt' ? { agent: 'codex' as const, kind: 'codex-chatgpt' as const } : { agent: 'claude' as const, kind: 'claude-subscription' as const };
        const result = await agentProfileLoginStart(machineId, relogin ? { ...which, accountId: relogin.accountId } : { ...which, ...(label.trim() ? { label: label.trim() } : {}) });
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
    const providerFields = kind === 'codex-provider'
        ? codexProviderAddFields({ label, provider: provider === CUSTOM_PROVIDER ? null : provider, baseUrl, wireApi, models })
        : null;
    const apiReady = kind === 'codex-provider'
        ? !!providerFields && !!keyInput()
        : !!label.trim() && isValidBaseUrl(baseUrl) && !!keyInput();

    async function addApi() {
        const key = keyInput();
        if (!key || !apiReady) return;
        setBusy(true); setError(null);
        const result = await agentProfileAdd(machineId, kind === 'codex-provider' && providerFields
            ? { agent: 'codex', kind: 'codex-provider', ...providerFields, key }
            : { agent: 'claude', kind: 'claude-api', label: label.trim(), baseUrl: baseUrl.trim(), models: parseModelList(models), key });
        setBusy(false);
        if (!result.ok) { setError(accountErrorText(result, t)); return; }
        setKeyValue('');
        const account = result.data;
        if (account.status === 'ok') toast.success(t('accounts.addedOk', { label: account.label }));
        else toast.show(t('accounts.addedUnverified', { label: account.label, detail: account.statusDetail ?? account.status }), 'error');
        onOpenChange(false);
    }

    const kindText: Record<Kind, [string, string]> = {
        'claude-subscription': [t('accounts.typeSubscription'), t('accounts.typeSubscriptionHint')],
        'claude-api': [t('accounts.typeApi'), t('accounts.typeApiHint')],
        'codex-chatgpt': [t('accounts.typeCodexChatgpt'), t('accounts.typeCodexChatgptHint')],
        'codex-provider': [t('accounts.typeCodexProvider'), t('accounts.typeCodexProviderHint')],
    };
    const kindOptions = offered.map((k) => ({ value: k, label: kindText[k][0] }));
    const kindHint = kindText[kind][1];
    const loginEnded = login && isLoginTerminal(login.state);
    const signIn = kind === 'claude-subscription' || kind === 'codex-chatgpt';
    const api = kind === 'claude-api' || kind === 'codex-provider';
    // Codex names a new ChatGPT account after its email: the name is optional there.
    const labelRequired = kind !== 'codex-chatgpt';
    const deviceCode = login?.flow === 'device-code';

    return <Dialog.Root open={open} onOpenChange={close}>
        <Dialog.Portal>
            <Dialog.Overlay className="vh-dialog-overlay so-overlay" />
            <DialogContent className="vh-dialog so-dialog acc-dialog" aria-describedby="acc-add-desc" data-testid="add-account-dialog"
                onOpenAutoFocus={(e) => { e.preventDefault(); titleRef.current?.focus(); }}>
                <div className="vh-dialog-head so-head">
                    <div>
                        <Dialog.Title ref={titleRef} tabIndex={-1} className="vh-dialog-title so-title">{relogin ? t('accounts.relogin') : t('accounts.addTitle')}</Dialog.Title>
                        <p id="acc-add-desc" className="so-description">{agent === 'codex' ? t('accounts.addDescriptionCodex', { machine: machineName }) : t('accounts.addDescription', { machine: machineName })}</p>
                    </div>
                    <Dialog.Close className="vh-dialog-close so-close" aria-label={t('common.close')}><X size={18} /></Dialog.Close>
                </div>

                <div className="so-fields">
                    {!relogin && kindOptions.length > 1 && <div className="so-field" data-testid="account-kinds">
                        <span className="so-field-label" id="acc-kind">{t('accounts.typeLabel')}</span>
                        <Segmented labelledBy="acc-kind" className="acc-kinds" options={kindOptions} value={kind}
                            disabled={!!login && !loginEnded}
                            onChange={(next) => { setKind(next); setError(null); }} />
                        <span className="mce-hint">{kindHint}</span>
                    </div>}

                    {!relogin && <label className="so-field">
                        <span className="so-field-label">{t('accounts.nameLabel')}</span>
                        <input className="mce-input" value={label} maxLength={60} placeholder={labelRequired ? t('accounts.namePlaceholder') : t('accounts.nameOptionalPlaceholder')} spellCheck={false}
                            disabled={!!login && !loginEnded} onChange={(e) => setLabel(e.target.value)} data-testid="account-label" />
                    </label>}

                    {signIn && <>
                        {!login && <div className="mce-actions">
                            <Button variant="primary" loading={busy} disabled={!relogin && labelRequired && !label.trim()} onClick={() => void startLogin()} data-testid="account-login-start">
                                {busy ? t('accounts.starting') : t('accounts.startLogin', { machine: machineName })}
                            </Button>
                        </div>}
                        {/* Device code (Codex): link + userCode, no paste box — the machine completes the sign-in. */}
                        {login && deviceCode && (login.state === 'waiting-code' || login.state === 'starting') && (login.url || login.userCode) && <div className="acc-login" data-testid="account-device-code">
                            <p className="acc-step"><span className="acc-step-n">1</span>{t('accounts.deviceStep1')}</p>
                            {login.url && <div className="acc-link-row">
                                <a className="acc-link" href={login.url} target="_blank" rel="noopener noreferrer" data-testid="account-login-url">
                                    <ExternalLink size={14} aria-hidden="true" /><span>{login.url.replace(/^https:\/\//, '')}</span>
                                </a>
                                <CopyButton text={login.url} />
                            </div>}
                            {login.userCode && <>
                                <p className="acc-step"><span className="acc-step-n">2</span>{t('accounts.deviceStep2')}</p>
                                <div className="acc-user-code-row">
                                    <span className="acc-user-code mono" aria-label={t('accounts.userCodeLabel')} data-testid="account-user-code">{login.userCode}</span>
                                    <CopyButton text={login.userCode} label={t('accounts.userCodeLabel')} />
                                </div>
                            </>}
                            <p className="mce-note" role="status"><Spinner size={13} /> {t('accounts.deviceWaiting')}</p>
                        </div>}
                        {login && !deviceCode && login.state === 'waiting-code' && <div className="acc-login" data-testid="account-login-waiting">
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
                        {login && login.state === 'starting' && !(deviceCode && (login.url || login.userCode)) && <p className="mce-note" role="status"><Spinner size={13} /> {t('accounts.starting')}</p>}
                        {login && login.state === 'exchanging' && <p className="mce-note" role="status"><Spinner size={13} /> {t('accounts.exchanging')}</p>}
                        {login && login.state === 'succeeded' && <p className="mce-note" role="status" data-testid="account-login-done">{t('accounts.loginSucceeded', { label: login.account?.label ?? label })}</p>}
                        {login && (login.state === 'failed' || login.state === 'expired' || login.state === 'canceled') && <div className="acc-login">
                            <p className="mce-note mce-note--danger" role="alert">
                                {login.state === 'expired' ? (deviceCode ? t('accounts.loginExpiredDevice') : t('accounts.loginExpired')) : login.state === 'canceled' ? t('accounts.loginCanceled') : t('accounts.loginFailed', { error: login.error ?? '' })}
                            </p>
                            <div className="mce-actions"><Button onClick={() => { setLogin(null); setError(null); }}>{t('accounts.startAgain')}</Button></div>
                        </div>}
                        {login?.state === 'succeeded' && <div className="mce-actions"><Button variant="primary" onClick={() => onOpenChange(false)}>{t('common.ok')}</Button></div>}
                    </>}

                    {api && <>
                        {kind === 'codex-provider' && codexProviders.length > 0 && <div className="so-field">
                            <span className="so-field-label" id="acc-provider">{t('accounts.providerLabel')}</span>
                            <Combobox label={t('accounts.providerLabel')} labelledBy="acc-provider" size="md" searchable={codexProviders.length > 8 ? 'auto' : false}
                                id="account-provider" value={provider} onChange={chooseProvider}
                                options={[
                                    ...codexProviders.map((p) => ({ value: p.id, label: p.name && p.name !== p.id ? `${p.name} (${p.id})` : p.id, ...(p.baseUrl ? { meta: baseUrlHost(p.baseUrl) ?? p.baseUrl } : {}) })),
                                    { value: CUSTOM_PROVIDER, label: t('accounts.providerCustom') },
                                ]} />
                            {chosenProvider && <span className="mce-hint">{t('accounts.providerHint', { machine: machineName })}</span>}
                        </div>}
                        <label className="so-field">
                            <span className="so-field-label">{t('accounts.baseUrlLabel')}</span>
                            <input className="mce-input mono" value={baseUrl} spellCheck={false} autoCapitalize="off" autoCorrect="off" inputMode="url"
                                placeholder={kind === 'codex-provider' ? chosenProvider?.baseUrl ?? 'https://api.openai.com/v1' : 'https://api.anthropic.com'}
                                onChange={(e) => setBaseUrl(e.target.value)} data-testid="account-base-url" />
                            {baseUrl.trim() && !isValidBaseUrl(baseUrl)
                                ? <span className="mce-hint mce-hint--warn">{t('accounts.baseUrlInvalid')}</span>
                                : chosenProvider && kind === 'codex-provider' && <span className="mce-hint">{t('accounts.baseUrlOverrideHint')}</span>}
                        </label>
                        {kind === 'codex-provider' && !chosenProvider && <div className="so-field">
                            <span className="so-field-label" id="acc-wire-api">{t('accounts.wireApiLabel')}</span>
                            <Segmented labelledBy="acc-wire-api" className="acc-kinds" value={wireApi} onChange={setWireApi}
                                options={[{ value: 'responses', label: 'responses' }, { value: 'chat', label: 'chat' }]} />
                            <span className="mce-hint">{t('accounts.wireApiHint')}</span>
                        </div>}
                        <label className="so-field">
                            <span className="so-field-label">{t('accounts.modelsLabel')}</span>
                            <textarea className="mce-input mce-textarea mono" rows={3} value={models} spellCheck={false} placeholder={kind === 'codex-provider' ? 'gpt-5.6-sol\ngpt-5.4-mini' : 'claude-sonnet-5-5\nkimi-k3'}
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
                                <input className="mce-input mono" value={keyEnv} placeholder={kind === 'codex-provider' ? t('accounts.codexKeyEnvPlaceholder') : t('accounts.keyEnvPlaceholder')} spellCheck={false} autoCapitalize="off" autoCorrect="off"
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
            </DialogContent>
        </Dialog.Portal>
    </Dialog.Root>;
}
