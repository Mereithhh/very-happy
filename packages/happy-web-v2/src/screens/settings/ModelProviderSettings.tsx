/**
 * Settings → 模型与账号, the per-machine half (B-850c merged the former
 * 「模型与 Provider」 page, B-688 specs/2026-10-custom-models.md, into it).
 *
 * One machine at a time: its accounts (MachineAccounts), then per harness what
 * the harness's own config file says right now (masked, read from the
 * machine) and the shared editor to change it — 「本机配置」.
 * Separate file on purpose: SettingsRoutes.tsx is a conflict hot zone.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Pencil, RefreshCw } from 'lucide-react';
import { Button, Item, ItemGroup, Spinner } from '@/ui';
import { Combobox } from '@/ui/Combobox';
import { useAllMachines } from '@/sync/storage';
import { isMachineOnline, machineLabel } from '@/utils/machineUtils';
import { useTranslation } from '@/i18n/useTranslation';
import { modelConfigStore, useMachineModelConfig } from '@/sync/modelConfigStore';
import { HARNESS_LABELS, machineSupportsModelConfig } from '@/sync/modelConfigModel';
import { HARNESS_IDS, type HarnessConfigView, type HarnessId } from '@/sync/modelConfigTypes';
import { ModelConfigEditor } from '@/components/modelConfig/ModelConfigEditor';
import { MachineAccounts } from '@/components/accounts/MachineAccounts';
import '@/components/modelConfig/modelConfigEditor.css';

function keySummary(view: HarnessConfigView, t: ReturnType<typeof useTranslation>['t']): string {
    const key = view.current.apiKey;
    if (!key || key.mode === 'none') return t('modelConfig.keyNone');
    if (key.mode === 'literal') return t('modelConfig.keyLiteral', { masked: key.masked ?? '••••' });
    if (key.mode === 'env') return t(key.envPresent ? 'modelConfig.keyEnvSet' : 'modelConfig.keyEnvMissing', { name: key.envName ?? '' });
    return t('modelConfig.keyCommand');
}

/** Machine picker + that machine's accounts + its agents' own config. Rendered inside the page's ItemList. */
export function MachineModelsAndAccounts() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [params] = useSearchParams();
    const machines = useAllMachines({ includeOffline: true });
    const preferred = useMemo(() => machines.find((m) => isMachineOnline(m) && machineSupportsModelConfig(m)) ?? machines.find(isMachineOnline) ?? machines[0], [machines]);
    const [machineId, setMachineId] = useState<string>(params.get('machine') ?? '');
    const effectiveId = machines.some((m) => m.id === machineId) ? machineId : preferred?.id ?? '';
    const machine = machines.find((m) => m.id === effectiveId) ?? null;
    const supported = machineSupportsModelConfig(machine);
    const online = machine ? isMachineOnline(machine) : false;
    const state = useMachineModelConfig(effectiveId);
    const [editor, setEditor] = useState<HarnessId | null>(null);

    useEffect(() => {
        if (effectiveId && supported && online) void modelConfigStore.getState().load(effectiveId);
    }, [effectiveId, supported, online]);

    const harnesses = state?.data?.harnesses ?? [];

    return (
        <>
                <ItemGroup settingId="models.machine" title={t('accounts.machineGroup')} footer={t('accounts.machineFooter')}>
                    <div className="mcs-machine">
                        {/* inside the settings card the picker is fill-only (1-Border Rule) */}
                        <Combobox label={t('modelConfig.machine')} variant="soft" size="md" className="mcs-machine-picker"
                            value={effectiveId || null} onChange={setMachineId}
                            options={machines.map((m) => ({ value: m.id, label: machineLabel(m), meta: isMachineOnline(m) ? undefined : t('settingsMachines.offline') }))} />
                        {machine && supported && online && <Button size="sm" variant="ghost" leftIcon={<RefreshCw size={14} />} loading={state?.status === 'loading'}
                            onClick={() => void modelConfigStore.getState().load(effectiveId, { force: true })}>{t('modelConfig.reload')}</Button>}
                    </div>
                </ItemGroup>

                {!machine && <ItemGroup><Item title={t('accounts.noMachine')} /></ItemGroup>}
                {machine && <MachineAccounts key={machine.id} machine={machine} />}
                {machine && <div className="mcs-local-head" data-setting-id="models.local">
                    <span className="vh-itemgroup__title eyebrow">{t('accounts.localConfigGroup')}</span>
                    <span className="mcs-local-note">{t('modelConfig.settingsFooter')}</span>
                </div>}
                {machine && !supported && <ItemGroup settingId="models.upgrade">
                    <Item title={t('modelConfig.needsUpgrade')} subtitle={machine.metadata?.happyCliVersion ? `CLI ${machine.metadata.happyCliVersion}` : undefined}
                        right={<Button size="sm" onClick={() => navigate(`/machine/${machine.id}`)}>{t('modelConfig.openMachine')}</Button>} />
                </ItemGroup>}
                {machine && supported && !online && <ItemGroup><Item title={t('modelConfig.offline')} /></ItemGroup>}
                {machine && supported && online && !state?.data && state?.status !== 'error' && <ItemGroup><Item title={t('modelConfig.loading')} right={<Spinner size={14} />} /></ItemGroup>}
                {state?.status === 'error' && <ItemGroup><Item title={state.unsupported ? t('modelConfig.needsUpgrade') : state.error} /></ItemGroup>}

                {machine && supported && HARNESS_IDS.map((id) => {
                    const view = harnesses.find((h) => h.harness === id);
                    if (!view) return null;
                    const c = view.current;
                    const fileError = view.files.find((f) => f.error)?.error;
                    return (
                        <ItemGroup key={id} settingId={`models.${id}`} title={HARNESS_LABELS[id]}>
                            <Item
                                title={c.baseUrl ?? t('modelConfig.defaultEndpoint')}
                                subtitle={[
                                    c.providerId ? `${t('modelConfig.provider')}: ${c.providerId}${c.active ? ` · ${t('modelConfig.activeSuffix')}` : ''}` : null,
                                    `${t('modelConfig.apiKey')}: ${keySummary(view, t)}`,
                                    (id === 'pi' ? c.defaultModel : c.model) ? `${t('modelConfig.defaultModel')}: ${id === 'pi' ? c.defaultModel : c.model}` : null,
                                    view.pickerModels.length ? `${t('modelConfig.pickerModelsShort')}: ${view.pickerModels.join(', ')}` : null,
                                ].filter(Boolean).join(' · ')}
                                detail={fileError ? fileError.message : view.files.map((f) => f.path).join('  ')}
                                multiline
                                right={<Button size="sm" leftIcon={<Pencil size={14} />} disabled={!online} onClick={() => setEditor(id)}>{t('modelConfig.edit')}</Button>}
                            />
                            {view.warnings.map((w) => <Item key={w.code} title={w.message} multiline />)}
                            {!view.installed && <Item title={t('modelConfig.notInstalled', { name: HARNESS_LABELS[id] })} />}
                        </ItemGroup>
                    );
                })}
            <ModelConfigEditor open={editor !== null} onOpenChange={(open) => { if (!open) setEditor(null); }} machineId={effectiveId} harness={editor} />
        </>
    );
}
