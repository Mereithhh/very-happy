/**
 * B-688 model / provider editor (specs/2026-10-custom-models.md). One dialog
 * shared by Settings → 模型与 Provider and the composer picker's 「自定义…」.
 *
 * Flow is fixed: edit → 预览改动 (daemon dry run, masked diff) → 确认写入
 * (daemon re-checks the files' hash, backs up, writes atomically). The key
 * the user types lives only in this component's state, goes out once inside
 * the machine-key-encrypted RPC params, and is cleared after the write.
 */
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Spinner, toast } from '@/ui';
import { Checkbox } from '@/ui/Checkbox';
import { Combobox } from '@/ui/Combobox';
import { SelectMenu, type SelectOption } from '@/ui/SelectMenu';
import { Summary } from '@/ui/Summary';
import { useTranslation } from '@/i18n/useTranslation';
import { useAllMachines } from '@/sync/storage';
import { machineLabel, isMachineOnline } from '@/utils/machineUtils';
import { modelConfigApply, modelConfigRead, modelConfigRestore } from '@/sync/modelConfigOps';
import { modelConfigStore, useMachineModelConfig } from '@/sync/modelConfigStore';
import {
    HARNESS_LABELS, describeModelConfigError, formFromView, machineSupportsModelConfig, newProviderForm, parsePiModelLines, patchFromForm, piModelLinesError,
    type KeyMode, type ModelConfigForm,
} from '@/sync/modelConfigModel';
import { HARNESS_IDS, PI_APIS, type HarnessConfigView, type HarnessId, type ModelConfigApplyResult } from '@/sync/modelConfigTypes';
import '@/screens/session/sessionOptionsDialog.css';
import './modelConfigEditor.css';

const NEW_PROVIDER = '__new__';

type Pending =
    | { kind: 'apply'; result: ModelConfigApplyResult }
    | { kind: 'restore'; backupId: string; result: ModelConfigApplyResult };

export function DiffBlock({ text }: { text: string }) {
    return <pre className="mce-diff">{text.split('\n').filter((line, i, all) => i < all.length - 1 || line !== '').map((line, i) => {
        const kind = line.startsWith('+++') || line.startsWith('---') ? 'file' : line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx';
        return <span key={i} className={`mce-diff-line mce-diff-line--${kind}`}>{line || ' '}</span>;
    })}</pre>;
}

export function ModelConfigEditor({ open, onOpenChange, machineId: initialMachineId, harness: initialHarness, onSaved }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    machineId?: string | null;
    harness?: HarnessId | null;
    /** after a successful write (e.g. offer to restart the session) */
    onSaved?: (machineId: string, harness: HarnessId) => void;
}) {
    const { t } = useTranslation();
    const machines = useAllMachines({ includeOffline: true });
    const [machineId, setMachineId] = useState<string>(initialMachineId ?? '');
    const [harness, setHarness] = useState<HarnessId>(initialHarness ?? 'claude');
    const [provider, setProvider] = useState<string>('');
    const [providerView, setProviderView] = useState<HarnessConfigView | null>(null);
    const [form, setForm] = useState<ModelConfigForm>(() => formFromView(initialHarness ?? 'claude', null));
    const [pending, setPending] = useState<Pending | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<{ kind: string; message: string } | null>(null);
    const [saved, setSaved] = useState(false);
    const titleRef = useRef<HTMLHeadingElement>(null);
    const previewRef = useRef<HTMLDivElement>(null);

    // (Re)seed from the caller every time the dialog opens.
    useEffect(() => {
        if (!open) return;
        const fallback = machines.find((m) => isMachineOnline(m) && machineSupportsModelConfig(m)) ?? machines[0];
        setMachineId(initialMachineId || fallback?.id || '');
        setHarness(initialHarness ?? 'claude');
        setProvider('');
        setPending(null);
        setError(null);
        setSaved(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, initialMachineId, initialHarness]);

    // Machines can arrive after the dialog opened: pick the default once they do.
    useEffect(() => {
        if (open && !machineId && machines.length) {
            setMachineId((machines.find((m) => isMachineOnline(m) && machineSupportsModelConfig(m)) ?? machines[0]).id);
        }
    }, [open, machineId, machines]);

    const machine = machines.find((m) => m.id === machineId) ?? null;
    const supported = machineSupportsModelConfig(machine);
    const online = machine ? isMachineOnline(machine) : false;
    const state = useMachineModelConfig(machineId);

    useEffect(() => {
        if (open && machineId && supported && online) void modelConfigStore.getState().load(machineId);
    }, [open, machineId, supported, online]);

    const storeView = state?.data?.harnesses.find((h) => h.harness === harness) ?? null;
    const view = providerView && providerView.harness === harness ? providerView : storeView;
    const hasProviders = harness === 'codex' || harness === 'pi';
    const providerIds = storeView?.providers ?? [];
    const selectedProvider = hasProviders ? (provider || storeView?.current.providerId || NEW_PROVIDER) : '';

    // Codex/pi: switching to another existing provider reads that provider's view.
    useEffect(() => {
        setProviderView(null);
        if (!open || !hasProviders || !machineId || !provider || provider === NEW_PROVIDER || provider === storeView?.current.providerId) return;
        let cancelled = false;
        void modelConfigRead(machineId, { harness, providerId: provider }).then((result) => {
            if (!cancelled && result.ok) setProviderView(result.data.harnesses[0] ?? null);
        });
        return () => { cancelled = true; };
    }, [open, machineId, harness, provider, hasProviders, storeView?.current.providerId]);

    // Reset the form whenever what it edits changes.
    const formKey = `${machineId}|${harness}|${selectedProvider}|${view?.baseHash ?? ''}`;
    useEffect(() => {
        setForm(newProviderForm(harness, selectedProvider === NEW_PROVIDER, view));
        setPending(null);
        setError(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [formKey]);

    // The preview lands below a long form: bring it (and the confirm button) into view.
    useEffect(() => {
        if (pending) previewRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
    }, [pending]);

    const set = <K extends keyof ModelConfigForm>(key: K, value: ModelConfigForm[K]) => {
        setForm((f) => ({ ...f, [key]: value }));
        setPending(null);
        setSaved(false);
        setError(null);
    };

    const fileError = view?.files.find((f) => f.error)?.error ?? null;
    const canEdit = !!machine && supported && online && !!view && !fileError;

    async function preview() {
        if (!machineId) return;
        setBusy(true); setError(null); setSaved(false);
        const linesError = piModelLinesError(form, view);
        if (linesError) {
            setBusy(false);
            setError({ kind: 'invalid', message: linesError.code === 'needs-upgrade' ? t('modelConfig.piContextWindowNeedsUpgrade') : t('modelConfig.piModelLineInvalid', { line: linesError.line ?? '' }) });
            return;
        }
        const result = await modelConfigApply(machineId, patchFromForm(form, view), { dryRun: true });
        setBusy(false);
        if (!result.ok) { setError(describeModelConfigError(result)); return; }
        setPending({ kind: 'apply', result: result.data });
    }

    async function confirm() {
        if (!machineId || !pending) return;
        setBusy(true); setError(null);
        const result = pending.kind === 'apply'
            ? await modelConfigApply(machineId, patchFromForm(form, view), { dryRun: false, baseHash: pending.result.baseHash })
            : await modelConfigRestore(machineId, harness, pending.backupId, { dryRun: false, baseHash: pending.result.baseHash });
        setBusy(false);
        if (!result.ok) {
            const described = describeModelConfigError(result);
            setError(described);
            if (described.kind === 'conflict') { setPending(null); void modelConfigStore.getState().load(machineId, { force: true }); }
            return;
        }
        const config = result.data.config;
        // Selected provider stays selected; the store gets the harness's default view.
        void modelConfigStore.getState().load(machineId, { force: true });
        if (config && (!hasProviders || config.current.providerId === storeView?.current.providerId)) modelConfigStore.getState().setHarnessView(machineId, config);
        if (hasProviders && config?.current.providerId) { setProvider(config.current.providerId); setProviderView(config); }
        setForm((f) => ({ ...f, keyMode: 'keep', keyValue: '' }));
        setPending(null);
        setSaved(true);
        toast.success(t(pending.kind === 'apply' ? 'modelConfig.savedToast' : 'modelConfig.restoredToast'));
        onSaved?.(machineId, harness);
    }

    async function previewRestore(backupId: string) {
        if (!machineId) return;
        setBusy(true); setError(null); setSaved(false);
        const result = await modelConfigRestore(machineId, harness, backupId, { dryRun: true });
        setBusy(false);
        if (!result.ok) { setError(describeModelConfigError(result)); return; }
        setPending({ kind: 'restore', backupId, result: result.data });
    }

    const keyView = view?.current.apiKey;
    const keyCurrent = useMemo(() => {
        if (!keyView || keyView.mode === 'none') return t('modelConfig.keyNone');
        if (keyView.mode === 'literal') return t('modelConfig.keyLiteral', { masked: keyView.masked ?? '••••' });
        if (keyView.mode === 'env') return t(keyView.envPresent ? 'modelConfig.keyEnvSet' : 'modelConfig.keyEnvMissing', { name: keyView.envName ?? '' });
        return t('modelConfig.keyCommand');
    }, [keyView, t]);
    const keyModes: KeyMode[] = harness === 'gemini' ? ['keep', 'literal', 'clear'] : ['keep', 'literal', 'env', 'clear'];

    const field = (label: string, key: keyof ModelConfigForm, opts: { placeholder?: string; hint?: string; mono?: boolean } = {}) => (
        <label className="so-field">
            <span className="so-field-label">{label}</span>
            <input className="mce-input" value={String(form[key] ?? '')} placeholder={opts.placeholder} spellCheck={false} autoCapitalize="off" autoCorrect="off"
                disabled={!canEdit || busy} onChange={(e) => set(key, e.target.value as never)} />
            {opts.hint && <span className="mce-hint">{opts.hint}</span>}
        </label>
    );

    // B-714: machine / provider are dynamic lists → Combobox; pi API and auth header are fixed → SelectMenu.
    const select = (label: string, value: string, options: SelectOption[], onChange: (v: string) => void, disabled = false, kind: 'combobox' | 'menu' = 'menu') => {
        const picker = { label, size: 'md', className: 'mce-picker', value: value || null, options, disabled: disabled || busy, onChange } as const;
        return (
            <div className="so-field">
                <span className="so-field-label">{label}</span>
                {kind === 'combobox' ? <Combobox {...picker} /> : <SelectMenu {...picker} />}
            </div>
        );
    };

    const changedNothing = pending && !pending.result.changed;

    return <Dialog.Root open={open} onOpenChange={(next) => { if (!next) setForm((f) => ({ ...f, keyValue: '' })); onOpenChange(next); }}>
        <Dialog.Portal>
            <Dialog.Overlay className="so-overlay" />
            <Dialog.Content className="so-dialog mce-dialog" aria-describedby="mce-desc" onOpenAutoFocus={(e) => { e.preventDefault(); titleRef.current?.focus(); }}>
                <div className="so-head">
                    <div>
                        <Dialog.Title ref={titleRef} tabIndex={-1} className="so-title">{t('modelConfig.editorTitle')}</Dialog.Title>
                        <p id="mce-desc" className="so-description">{t('modelConfig.editorDescription')}</p>
                    </div>
                    <Dialog.Close className="so-close" aria-label={t('common.close')}><X size={18} /></Dialog.Close>
                </div>

                <div className="so-fields">
                    {select(t('modelConfig.machine'), machineId, machines.map((m) => ({ value: m.id, label: machineLabel(m), meta: isMachineOnline(m) ? undefined : t('settingsMachines.offline') })), (v) => { setMachineId(v); setProvider(''); }, false, 'combobox')}
                    <div className="vh-segmented mce-harness" role="tablist" aria-label={t('modelConfig.harness')}>
                        {HARNESS_IDS.map((id) => (
                            <button key={id} type="button" role="tab" aria-selected={harness === id} className={harness === id ? 'is-active' : ''} onClick={() => { setHarness(id); setProvider(''); }}>
                                {HARNESS_LABELS[id]}
                            </button>
                        ))}
                    </div>

                    {!machine && <p className="mce-note">{t('modelConfig.noMachine')}</p>}
                    {machine && !supported && <p className="mce-note mce-note--warn">
                        {t('modelConfig.needsUpgrade')} <Link to={`/machine/${machine.id}`} onClick={() => onOpenChange(false)}>{t('modelConfig.openMachine')}</Link>
                    </p>}
                    {machine && supported && !online && <p className="mce-note">{t('modelConfig.offline')}</p>}
                    {machine && supported && online && !view && state?.status !== 'error' && <p className="mce-note"><Spinner size={13} /> {t('modelConfig.loading')}</p>}
                    {state?.status === 'error' && <p className="mce-note mce-note--warn" role="alert">{state.unsupported ? t('modelConfig.needsUpgrade') : state.error}</p>}

                    {view && <div className="mce-files">
                        {view.files.map((f) => <div key={f.path} className="mce-file">
                            <code>{f.path}</code>
                            <span className="mce-file-state">{f.error ? f.error.message : f.exists ? '' : t('modelConfig.fileMissing')}</span>
                        </div>)}
                        {!view.installed && <span className="mce-hint">{t('modelConfig.notInstalled', { name: HARNESS_LABELS[harness] })}</span>}
                    </div>}

                    {view && hasProviders && select(t('modelConfig.provider'), selectedProvider,
                        [...providerIds.map((id) => ({ value: id, label: id, meta: id === view.current.activeProvider ? t('modelConfig.activeSuffix') : undefined })), { value: NEW_PROVIDER, label: t('modelConfig.newProvider') }],
                        setProvider, !canEdit, 'combobox')}

                    {view && hasProviders && form.isNewProvider && field(t('modelConfig.providerId'), 'providerId', { placeholder: harness === 'codex' ? 'my-gateway' : 'my-gateway', hint: t('modelConfig.providerIdHint') })}
                    {view && harness === 'codex' && field(t('modelConfig.providerName'), 'providerName', { placeholder: form.providerId || 'My gateway' })}
                    {view && field(t('modelConfig.baseUrl'), 'baseUrl', { placeholder: harness === 'claude' ? 'https://gateway.example.com' : harness === 'gemini' ? 'https://gemini-gateway.example.com' : 'https://gateway.example.com/v1', hint: t(`modelConfig.baseUrlHint.${harness}` as 'modelConfig.baseUrlHint.claude') })}
                    {view && harness === 'pi' && select(t('modelConfig.api'), form.api, PI_APIS.map((a) => ({ value: a, label: a })), (v) => set('api', v), !canEdit)}
                    {view && harness === 'claude' && select(t('modelConfig.authHeader'), form.authHeader, [
                        { value: 'bearer', label: 'Authorization: Bearer (ANTHROPIC_AUTH_TOKEN)' },
                        { value: 'x-api-key', label: 'x-api-key (ANTHROPIC_API_KEY)' },
                    ], (v) => set('authHeader', v as 'bearer' | 'x-api-key'), !canEdit)}

                    {view && <fieldset className="so-field mce-key" disabled={!canEdit || busy}>
                        <legend className="so-field-label">{t('modelConfig.apiKey')}</legend>
                        <span className="mce-hint">{t('modelConfig.keyCurrent', { value: keyCurrent })}</span>
                        <div className="vh-segmented mce-keymodes" role="radiogroup" aria-label={t('modelConfig.apiKey')}>
                            {keyModes.map((mode) => (
                                <button key={mode} type="button" role="radio" aria-checked={form.keyMode === mode} className={form.keyMode === mode ? 'is-active' : ''} onClick={() => set('keyMode', mode)}>
                                    {t(`modelConfig.keyMode.${mode}` as 'modelConfig.keyMode.keep')}
                                </button>
                            ))}
                        </div>
                        {form.keyMode === 'literal' && <>
                            <input className="mce-input" type="password" autoComplete="off" spellCheck={false} value={form.keyValue} placeholder="sk-…" aria-label={t('modelConfig.apiKey')} onChange={(e) => set('keyValue', e.target.value)} />
                            <span className="mce-hint">{t(`modelConfig.literalHint.${harness}` as 'modelConfig.literalHint.claude')}</span>
                        </>}
                        {form.keyMode === 'env' && <>
                            <input className="mce-input" value={form.keyEnv} spellCheck={false} autoCapitalize="off" placeholder="MY_GATEWAY_KEY" aria-label={t('modelConfig.envName')} onChange={(e) => set('keyEnv', e.target.value)} />
                            <span className="mce-hint">{t('modelConfig.envHint')}</span>
                        </>}
                        {harness === 'gemini' && form.keyMode !== 'literal' && <span className="mce-hint">{t('modelConfig.geminiEnvHint')}</span>}
                    </fieldset>}

                    {view && harness !== 'pi' && field(t('modelConfig.defaultModel'), 'model', { placeholder: harness === 'claude' ? 'glm-5.3' : harness === 'codex' ? 'gpt-5.5' : 'gemini-3-flash-preview', hint: t('modelConfig.defaultModelHint') })}
                    {view && harness === 'claude' && <details className="mce-more">
                        <Summary>{t('modelConfig.aliasMapping')}</Summary>
                        <div className="so-fields">
                            {field('opus →', 'opusModel', { placeholder: 'ANTHROPIC_DEFAULT_OPUS_MODEL' })}
                            {field('sonnet →', 'sonnetModel', { placeholder: 'ANTHROPIC_DEFAULT_SONNET_MODEL' })}
                            {field('haiku →', 'haikuModel', { placeholder: 'ANTHROPIC_DEFAULT_HAIKU_MODEL' })}
                        </div>
                    </details>}
                    {view && (harness === 'claude' || harness === 'pi') && <label className="so-field">
                        <span className="so-field-label">{t(harness === 'pi' ? 'modelConfig.piModels' : 'modelConfig.pickerModels')}</span>
                        <textarea className="mce-input mce-textarea" rows={3} value={form.extraModels} spellCheck={false} disabled={!canEdit || busy} placeholder={harness === 'pi' ? 'glm-5.3 200k\nkimi-k3 256k' : 'glm-5.3\nkimi-k3'} onChange={(e) => set('extraModels', e.target.value)} />
                        <span className="mce-hint">{t(harness === 'pi' ? 'modelConfig.piModelListHint' : 'modelConfig.modelListHint')}</span>
                    </label>}
                    {view && hasProviders && <Checkbox className="mce-check" checked={form.activate} disabled={!canEdit || busy} onCheckedChange={(checked) => set('activate', checked)}>
                        {t(harness === 'codex' ? 'modelConfig.activateCodex' : 'modelConfig.activatePi')}
                    </Checkbox>}
                    {view && harness === 'pi' && form.activate && field(t('modelConfig.defaultModel'), 'model', { placeholder: parsePiModelLines(form.extraModels).ids[0] || 'model-id' })}

                    {view && view.warnings.length > 0 && !pending && <ul className="mce-warnings">
                        {view.warnings.map((w) => <li key={w.code}>{w.message}</li>)}
                    </ul>}

                    {error && <p className="mce-note mce-note--danger" role="alert">{error.kind === 'unsupported' ? t('modelConfig.needsUpgrade') : error.kind === 'conflict' ? t('modelConfig.conflict') : error.message}</p>}

                    {pending && <div className="mce-preview" aria-live="polite">
                        <div className="so-field-label">{t(pending.kind === 'apply' ? 'modelConfig.previewTitle' : 'modelConfig.restorePreviewTitle')}</div>
                        {changedNothing ? <p className="mce-note">{t('modelConfig.noChanges')}</p>
                            : pending.result.files.map((f) => <DiffBlock key={f.path} text={f.diff} />)}
                        {pending.result.warnings.length > 0 && <ul className="mce-warnings">{pending.result.warnings.map((w) => <li key={w.code}>{w.message}</li>)}</ul>}
                    </div>}

                    {saved && <p className="mce-note" role="status">{t('modelConfig.savedNote')}</p>}

                    <div className="mce-actions" ref={previewRef}>
                        {pending && !changedNothing
                            ? <>
                                <Button variant="ghost" onClick={() => setPending(null)} disabled={busy}>{t('modelConfig.back')}</Button>
                                <Button variant="primary" loading={busy} onClick={() => void confirm()}>{t(pending.kind === 'apply' ? 'modelConfig.confirmWrite' : 'modelConfig.confirmRestore')}</Button>
                            </>
                            : <Button variant="primary" loading={busy} disabled={!canEdit} onClick={() => void preview()}>{t('modelConfig.preview')}</Button>}
                    </div>

                    {view && view.backups.length > 0 && <details className="mce-more">
                        <Summary>{t('modelConfig.backups', { count: view.backups.length })}</Summary>
                        <ul className="mce-backups">
                            {view.backups.slice(0, 10).map((b) => <li key={b.id}>
                                <span>{new Date(b.createdAt).toLocaleString()}</span>
                                <span className="mce-hint">{t(b.reason === 'before-restore' ? 'modelConfig.backupBeforeRestore' : 'modelConfig.backupBeforeApply')}</span>
                                <Button size="xs" variant="ghost" disabled={!machine || !supported || !online || busy} onClick={() => void previewRestore(b.id)}>{t('modelConfig.previewRestore')}</Button>
                            </li>)}
                        </ul>
                    </details>}
                </div>
            </Dialog.Content>
        </Dialog.Portal>
    </Dialog.Root>;
}
