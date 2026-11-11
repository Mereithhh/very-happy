/**
 * B-924 Settings → Main agent: the three default automations (早报 / 盯卡住的会话 /
 * 提醒收尾) as switches, and the main agent's quiet hours.
 *
 * Switch state comes from the automation list (matched by name). On = resume,
 * or create it on the main agent's machine (KV pointer `vh.main-agent.v1`)
 * when it does not exist yet; off = pause (never delete). Quiet hours live in
 * KV `vh.main-agent-config.v1`.quietHours; a write keeps the blob's other
 * fields and uses the KV version as a CAS (one re-merge on a conflict).
 */
import { useEffect, useMemo, useState } from 'react';
import * as Switch from '@radix-ui/react-switch';
import type { MainAgentAutomationKind, MainAgentQuietWindow } from '@slopus/happy-wire';
import { useAuth } from '@/auth/AuthContext';
import type { AuthCredentials } from '@/auth/tokenStorage';
import { useTranslation } from '@/i18n/useTranslation';
import type { TranslationKey } from '@/text';
import { Item, ItemGroup, toast } from '@/ui';
import { kvMutate } from '@/sync/apiKv';
import { AUTOMATIONS_OVERVIEW_POLL_MS, useAutomations, useAutomationsPoll } from '@/sync/automationsStore';
import { MAIN_AGENT_CONFIG_KEY, decodeKvJson, encodeKvJson, parseMainAgentConfig } from '@/assistant/mainAgent';
import { loadMainAgentConfig, refreshMainAgentPointer, useMainAgentStore } from '@/assistant/mainAgentStore';
import { isValidTimeZone, knownTimeZones, localTimeZone } from '@/screens/automations/automationForm';
import { SuggestInput } from '@/ui/SuggestInput';
import { Button } from '@/ui/Button';
import { isHhmm, mainAgentAutomationRows, mainAgentZone, planMainAgentToggle, planRestoreDefaults, planZoneChange, readMainAgentQuietHours, withQuietHours, type MainAgentAutomationRow } from './mainAgentAutomationsModel';

const KIND_TEXT: Record<MainAgentAutomationKind, { title: TranslationKey; hint: TranslationKey }> = {
    brief: { title: 'settingsMainAgent.automationBrief', hint: 'settingsMainAgent.automationBriefHint' },
    stuck: { title: 'settingsMainAgent.automationStuck', hint: 'settingsMainAgent.automationStuckHint' },
    wrapup: { title: 'settingsMainAgent.automationWrapup', hint: 'settingsMainAgent.automationWrapupHint' },
};

function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
    return (
        <Switch.Root className="set-switch vh-hit" checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={label}>
            <Switch.Thumb className="set-switch__thumb" />
        </Switch.Root>
    );
}

/** Write `quietHours` into the config KV (other fields kept); on a version conflict re-merge onto the newer value once. */
export async function saveMainAgentQuietHours(creds: AuthCredentials, quiet: MainAgentQuietWindow): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
        const { configRaw, configVersion } = useMainAgentStore.getState();
        const merged = withQuietHours(configRaw, quiet, Date.now());
        const res = await kvMutate(creds, [{ key: MAIN_AGENT_CONFIG_KEY, value: encodeKvJson(merged), version: configVersion }]);
        if (res.success) {
            setConfigRaw(merged, res.results[0].version);
            return true;
        }
        const err = res.errors[0];
        setConfigRaw(err.value ? decodeKvJson(err.value) : null, err.version);
    }
    return false;
}

/** Keep `config` (skillRoots / deniedTools) the same object unless it really changed, so the page's unsaved edits survive. */
function setConfigRaw(raw: unknown, version: number): void {
    const st = useMainAgentStore.getState();
    const parsed = parseMainAgentConfig(raw);
    const same = JSON.stringify(parsed) === JSON.stringify(st.config);
    useMainAgentStore.setState({ configRaw: raw, configVersion: version, configStatus: 'ready', ...(same ? {} : { config: parsed }) });
}

export function MainAgentAutomationsSection() {
    const { t } = useTranslation();
    const { credentials } = useAuth();
    const browserTz = localTimeZone();

    const refreshOverview = useAutomations((s) => s.refreshOverview);
    const enabled = useAutomations((s) => s.enabled);
    const loadedAt = useAutomations((s) => s.loadedAt);
    const loadError = useAutomations((s) => s.error);
    const automations = useAutomations((s) => s.automations);
    useAutomationsPoll(refreshOverview, AUTOMATIONS_OVERVIEW_POLL_MS);
    const rows = mainAgentAutomationRows(automations);

    const pointerStatus = useMainAgentStore((s) => s.pointerStatus);
    const machineId = useMainAgentStore((s) => s.pointer?.machineId ?? null);
    const configStatus = useMainAgentStore((s) => s.configStatus);
    const configRaw = useMainAgentStore((s) => s.configRaw);
    useEffect(() => {
        if (!credentials) return;
        if (pointerStatus === 'idle') void refreshMainAgentPointer(credentials);
        if (configStatus === 'idle') void loadMainAgentConfig(credentials);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- once per sign-in; the store holds the result
    }, [credentials]);

    // The zone the brief / wrap-up / quiet hours run in: shown and editable (B-924 review).
    const tz = mainAgentZone(readMainAgentQuietHours(configRaw).tz, rows, browserTz);
    const timeZones = useMemo(knownTimeZones, []);
    const [zoneDraft, setZoneDraft] = useState<string | null>(null);

    const [busy, setBusy] = useState<MainAgentAutomationKind | 'zone' | 'restore' | null>(null);
    const onToggle = async (row: MainAgentAutomationRow, on: boolean) => {
        const plan = planMainAgentToggle(row, on, { machineId, tz });
        if (plan.op === 'noop') return;
        if (plan.op === 'needMainAgent') {
            toast.error(t('settingsMainAgent.automationsNeedMainAgent'));
            return;
        }
        setBusy(row.kind);
        try {
            const st = useAutomations.getState();
            if (plan.op === 'pause') await st.pause(plan.id);
            else if (plan.op === 'resume') await st.resume(plan.id);
            else await st.create(plan.body);
        } catch {
            toast.error(t('settingsMainAgent.automationToggleFailed'));
        } finally {
            setBusy(null);
        }
    };

    // Quiet hours: the stored value, with a local copy while a write is in flight.
    const stored = readMainAgentQuietHours(configRaw, browserTz);
    const [pendingQuiet, setPendingQuiet] = useState<MainAgentQuietWindow | null>(null);
    const quiet = pendingQuiet ?? stored;
    const quietReady = configStatus === 'ready' && !!credentials;
    const saveQuiet = async (patch: Partial<MainAgentQuietWindow>) => {
        if (!credentials) return;
        const next: MainAgentQuietWindow = { ...quiet, ...patch, tz: patch.tz ?? tz };
        if (!isHhmm(next.start) || !isHhmm(next.end)) return;
        setPendingQuiet(next);
        try {
            if (!(await saveMainAgentQuietHours(credentials, next))) toast.error(t('settingsMainAgent.quietSaveFailed'));
        } catch {
            toast.error(t('settingsMainAgent.quietSaveFailed'));
        } finally {
            setPendingQuiet(null);
        }
    };

    const commitZone = async () => {
        const next = zoneDraft?.trim();
        setZoneDraft(null);
        if (!next || next === tz || !credentials) return;
        if (!isValidTimeZone(next)) { toast.error(t('settingsMainAgent.zoneInvalid')); return; }
        setBusy('zone');
        try {
            const st = useAutomations.getState();
            for (const change of planZoneChange(rows, next)) await st.update(change.id, change.body);
            if (!(await saveMainAgentQuietHours(credentials, { ...quiet, tz: next }))) toast.error(t('settingsMainAgent.quietSaveFailed'));
        } catch {
            toast.error(t('settingsMainAgent.automationToggleFailed'));
        } finally {
            setBusy(null);
        }
    };

    const onRestore = async () => {
        const plan = planRestoreDefaults(rows, { machineId, tz });
        if (plan.op === 'noop') return;
        if (plan.op === 'needMainAgent') { toast.error(t('settingsMainAgent.automationsNeedMainAgent')); return; }
        setBusy('restore');
        try {
            const st = useAutomations.getState();
            for (const body of plan.bodies) await st.create(body);
        } catch {
            toast.error(t('settingsMainAgent.automationToggleFailed'));
        } finally {
            setBusy(null);
        }
    };

    const listReady = enabled === true && loadedAt !== null;
    const status = enabled === false ? t('settingsMainAgent.automationsUnavailable')
        : loadError && !listReady ? t('settingsMainAgent.automationsLoadFailed')
        : pointerStatus !== 'loading' && pointerStatus !== 'idle' && !machineId && rows.some((r) => !r.automation) ? t('settingsMainAgent.automationsNeedMainAgent')
        : null;

    return (
        <>
            <ItemGroup settingId="mainAgent.automations" title={t('settingsMainAgent.automationsTitle')} footer={t('settingsMainAgent.automationsFooter')}>
                {rows.map((row) => (
                    <Item
                        key={row.kind}
                        multiline
                        title={t(KIND_TEXT[row.kind].title)}
                        subtitle={t(KIND_TEXT[row.kind].hint)}
                        right={
                            <Toggle
                                checked={row.on}
                                disabled={!listReady || busy !== null}
                                onChange={(v) => void onToggle(row, v)}
                                label={t(KIND_TEXT[row.kind].title)}
                            />
                        }
                    />
                ))}
                <Item
                    multiline
                    title={t('settingsMainAgent.zone')}
                    subtitle={t('settingsMainAgent.zoneHint')}
                    right={
                        <SuggestInput className="set-value mono" aria-label={t('settingsMainAgent.zone') as string} value={zoneDraft ?? tz}
                            onValueChange={setZoneDraft} suggestions={timeZones} spellCheck={false} disabled={busy !== null || !credentials}
                            onBlur={() => void commitZone()} onKeyDown={(e) => { if (e.key === 'Enter') void commitZone(); }} />
                    }
                />
                {listReady && rows.some((r) => !r.automation) && (
                    <Item
                        title={t('settingsMainAgent.restoreDefaults')}
                        subtitle={t('settingsMainAgent.restoreDefaultsHint')}
                        right={<Button size="sm" variant="secondary" loading={busy === 'restore'} disabled={busy !== null} onClick={() => void onRestore()}>{t('settingsMainAgent.restoreDefaultsAction')}</Button>}
                    />
                )}
                {status && <Item title={<span className="ma-settings-note" role="status">{status}</span>} />}
            </ItemGroup>

            {/* not in the settings search index: 免打扰 / quiet hours finds the notifications one */}
            <ItemGroup title={t('settingsMainAgent.quietTitle')} footer={t('settingsMainAgent.quietFooter')}>
                <Item
                    title={t('settingsMainAgent.quietEnable')}
                    right={<Toggle checked={quiet.enabled} disabled={!quietReady || pendingQuiet !== null} onChange={(v) => void saveQuiet({ enabled: v })} label={t('settingsMainAgent.quietEnable')} />}
                />
                {quiet.enabled && (
                    <>
                        <Item
                            title={t('settingsMainAgent.quietStart')}
                            right={
                                <input type="time" className="set-value" aria-label={t('settingsMainAgent.quietStart')} value={quiet.start} disabled={!quietReady}
                                    onChange={(e) => { if (e.target.value !== quiet.start) void saveQuiet({ start: e.target.value }); }} />
                            }
                        />
                        <Item
                            title={t('settingsMainAgent.quietEnd')}
                            right={
                                <input type="time" className="set-value" aria-label={t('settingsMainAgent.quietEnd')} value={quiet.end} disabled={!quietReady}
                                    onChange={(e) => { if (e.target.value !== quiet.end) void saveQuiet({ end: e.target.value }); }} />
                            }
                        />
                    </>
                )}
            </ItemGroup>
        </>
    );
}
