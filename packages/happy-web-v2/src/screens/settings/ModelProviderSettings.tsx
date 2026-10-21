/**
 * Settings → 模型与 Provider (B-688, specs/2026-10-custom-models.md).
 *
 * Per machine × harness: what the harness's own config file says right now
 * (masked, read from the machine), and the shared editor to change it.
 * Separate file on purpose: SettingsRoutes.tsx is a conflict hot zone and only
 * gains an import, one <Route> and one overview <Item> (VoiceSettings precedent).
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Pencil, RefreshCw } from 'lucide-react';
import { SettingsPage as Page, SettingsHeader as Header } from './SettingsLayout';
import { Button, Item, ItemGroup, ItemList, Spinner } from '@/ui';
import { Combobox } from '@/ui/Combobox';
import { useAllMachines } from '@/sync/storage';
import { isMachineOnline, machineLabel } from '@/utils/machineUtils';
import { useTranslation } from '@/i18n/useTranslation';
import { modelConfigStore, useMachineModelConfig } from '@/sync/modelConfigStore';
import { HARNESS_LABELS, machineSupportsModelConfig } from '@/sync/modelConfigModel';
import { HARNESS_IDS, type HarnessConfigView, type HarnessId } from '@/sync/modelConfigTypes';
import { ModelConfigEditor } from '@/components/modelConfig/ModelConfigEditor';
import '@/components/modelConfig/modelConfigEditor.css';

function keySummary(view: HarnessConfigView, t: ReturnType<typeof useTranslation>['t']): string {
    const key = view.current.apiKey;
    if (!key || key.mode === 'none') return t('modelConfig.keyNone');
    if (key.mode === 'literal') return t('modelConfig.keyLiteral', { masked: key.masked ?? '••••' });
    if (key.mode === 'env') return t(key.envPresent ? 'modelConfig.keyEnvSet' : 'modelConfig.keyEnvMissing', { name: key.envName ?? '' });
    return t('modelConfig.keyCommand');
}

export function ModelProviderSettings() {
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
        <Page>
            <Header title={t('modelConfig.title')} />
            <ItemList>
                <ItemGroup settingId="models.machine" title={t('modelConfig.machine')} footer={t('modelConfig.settingsFooter')}>
                    <div className="mcs-machine">
                        {/* inside the settings card the picker is fill-only (1-Border Rule) */}
                        <Combobox label={t('modelConfig.machine')} variant="soft" size="md" className="mcs-machine-picker"
                            value={effectiveId || null} onChange={setMachineId}
                            options={machines.map((m) => ({ value: m.id, label: machineLabel(m), meta: isMachineOnline(m) ? undefined : t('settingsMachines.offline') }))} />
                        {machine && supported && online && <Button size="sm" variant="ghost" leftIcon={<RefreshCw size={14} />} loading={state?.status === 'loading'}
                            onClick={() => void modelConfigStore.getState().load(effectiveId, { force: true })}>{t('modelConfig.reload')}</Button>}
                    </div>
                </ItemGroup>

                {!machine && <ItemGroup><Item title={t('modelConfig.noMachine')} /></ItemGroup>}
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
            </ItemList>
            <ModelConfigEditor open={editor !== null} onOpenChange={(open) => { if (!open) setEditor(null); }} machineId={effectiveId} harness={editor} />
        </Page>
    );
}
