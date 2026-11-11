/**
 * Settings → Main agent (B-916a): which machine runs the account's one main
 * agent, its mounted skills folders, and additions to the outbound deny list.
 *
 * Machine = the KV pointer `vh.main-agent.v1` (moving spawns a fresh session
 * on the new machine and archives the old one). skillRoots / deniedTools =
 * KV `vh.main-agent-config.v1`; unknown fields in that blob are preserved on
 * write (later phases add quietHours etc.). Old CLIs are listed but disabled
 * with the upgrade reason — never a blind spawn.
 */

import { useEffect, useMemo, useState } from 'react';
import { Check, Server } from 'lucide-react';
import { SettingsPage as Page, SettingsHeader as Header } from './SettingsLayout';
import { Button, ItemGroup, ItemList, Item, Spinner, toast } from '@/ui';
import { Modal } from '@/modal';
import { useAuth } from '@/auth/AuthContext';
import { useTranslation } from '@/i18n/useTranslation';
import { useAllMachines } from '@/sync/storage';
import { machineLabel } from '@/utils/machineUtils';
import { mainAgentCopy } from '@/assistant/mainAgentCopy';
import { checkConfigLines, hasMainAgentGates, mainAgentSupported, rankMainAgentCandidates, DENIED_TOOLS_MAX, SKILL_ROOTS_MAX, type ConfigLinesCheck } from '@/assistant/mainAgent';
import { loadMainAgentConfig, saveMainAgentConfig, useMainAgentStore } from '@/assistant/mainAgentStore';
import { useMainAgentActions, useMainAgentPointerSync, useMainAgentState } from '@/assistant/useMainAgent';
import { MainAgentAutomationsSection } from './MainAgentAutomationsSection';
import '@/screens/mainAgent/mainAgent.css';
import { MainAgentSafetySection } from './MainAgentSafetySection';

export function MainAgentSettings() {
    const { lang } = useTranslation();
    const copy = mainAgentCopy(lang);
    const { credentials } = useAuth();
    useMainAgentPointerSync();
    const state = useMainAgentState();
    const actions = useMainAgentActions();
    const machines = useAllMachines({ includeOffline: true });
    const recommended = useMemo(() => rankMainAgentCandidates(machines)[0] ?? null, [machines]);
    const currentMachineId = state.kind === 'ready' ? state.machine?.id ?? state.session.metadata?.machineId ?? null
        : state.kind === 'upgrade' || state.kind === 'starting' ? state.machine.id : null;
    const currentSessionId = state.kind === 'ready' ? state.session.id : null;

    const configStatus = useMainAgentStore((s) => s.configStatus);
    const config = useMainAgentStore((s) => s.config);
    const [roots, setRoots] = useState('');
    const [denied, setDenied] = useState('');
    const [saving, setSaving] = useState(false);
    useEffect(() => { if (credentials) void loadMainAgentConfig(credentials); }, [credentials]);
    useEffect(() => {
        if (configStatus !== 'ready') return;
        setRoots(config.skillRoots.join('\n'));
        setDenied(config.deniedTools.join('\n'));
    }, [configStatus, config]);
    // spec §6: validate before writing — invalid lines block the save and are named inline
    const rootsCheck = useMemo(() => checkConfigLines(roots, 'skillRoots'), [roots]);
    const deniedCheck = useMemo(() => checkConfigLines(denied, 'deniedTools'), [denied]);
    const valid = rootsCheck.invalid.length === 0 && !rootsCheck.tooMany && deniedCheck.invalid.length === 0 && !deniedCheck.tooMany;
    const dirty = configStatus === 'ready'
        && (rootsCheck.values.join('\n') !== config.skillRoots.join('\n') || deniedCheck.values.join('\n') !== config.deniedTools.join('\n'));
    const gates = state.kind === 'ready' ? hasMainAgentGates(state.session) : null;
    const problem = (c: ConfigLinesCheck, max: number) => c.invalid.length
        ? copy.invalidLines(c.invalid.slice(0, 3).join(', ') + (c.invalid.length > 3 ? ' …' : ''))
        : c.tooMany ? copy.tooMany(max) : null;
    const rootsProblem = problem(rootsCheck, SKILL_ROOTS_MAX);
    const deniedProblem = problem(deniedCheck, DENIED_TOOLS_MAX);

    const onSave = async () => {
        if (!credentials) return;
        setSaving(true);
        try {
            const ok = await saveMainAgentConfig(credentials, { skillRoots: rootsCheck.values, deniedTools: deniedCheck.values });
            if (ok) toast.success(copy.settingsSaved);
            else toast.error(copy.settingsSaveFailed);
        } catch {
            toast.error(copy.settingsSaveFailed);
        } finally {
            setSaving(false);
        }
    };

    const onPickMachine = async (machineId: string) => {
        if (machineId === currentMachineId || actions.spawning) return;
        const m = machines.find((x) => x.id === machineId);
        if (!m) return;
        if (currentSessionId && !(await Modal.confirm(copy.settingsMoveConfirm(machineLabel(m))))) return;
        if (currentSessionId) await actions.replace(machineId, currentSessionId);
        else await actions.enable(machineId);
    };

    return (
        <Page>
            <Header title={copy.settingsTitle} />
            <ItemList>
                <ItemGroup settingId="mainAgent.machine" title={copy.settingsMachine} footer={copy.settingsMachineHint}>
                    {machines.length === 0 && <Item title={copy.noMachine} />}
                    {machines.map((m) => {
                        const supported = mainAgentSupported(m);
                        const current = m.id === currentMachineId;
                        const reason = !supported
                            ? copy.upgradeBody(machineLabel(m), m.metadata?.happyCliVersion ?? copy.unknownVersion)
                            : !m.active ? copy.statusOffline : undefined;
                        const disabled = !current && (!supported || !m.active || actions.spawning);
                        return (
                            <Item
                                key={m.id}
                                title={<>{machineLabel(m)}{recommended?.id === m.id && <span className="ma-machine-badge ma-machine-badge--inline">{copy.recommended}</span>}</>}
                                subtitle={reason ?? m.metadata?.platform}
                                left={<Server size={16} />}
                                right={current ? <Check size={16} aria-label={copy.settingsMachine} /> : actions.spawning ? <Spinner size={14} /> : undefined}
                                onClick={disabled || current ? undefined : () => void onPickMachine(m.id)}
                                disabled={disabled}
                            />
                        );
                    })}
                    {actions.spawnError && <Item title={<span className="tg-error">{actions.spawnError}</span>} />}
                </ItemGroup>

                <ItemGroup settingId="mainAgent.skillRoots" title={copy.settingsSkillRoots} footer={copy.settingsSkillRootsHint}>
                    <div className="ma-settings-field">
                        <textarea className="ma-settings-textarea mono" rows={3} value={roots} spellCheck={false}
                            aria-label={copy.settingsSkillRoots} placeholder="~/skills"
                            disabled={configStatus !== 'ready'} aria-invalid={!!rootsProblem} onChange={(e) => setRoots(e.target.value)} />
                        {rootsProblem && <p className="tg-error ma-settings-error">{rootsProblem}</p>}
                    </div>
                </ItemGroup>

                <ItemGroup settingId="mainAgent.deniedTools" title={copy.settingsDenied} footer={<>{copy.settingsDeniedHint}{gates !== null && <span className="ma-settings-gates" data-gates={gates ? 'active' : 'missing'}> {gates ? copy.gatesActive : copy.gatesMissing}</span>}</>}>
                    <div className="ma-settings-field">
                        <textarea className="ma-settings-textarea mono" rows={3} value={denied} spellCheck={false}
                            aria-label={copy.settingsDenied} placeholder="mcp__*__*send*"
                            disabled={configStatus !== 'ready'} aria-invalid={!!deniedProblem} onChange={(e) => setDenied(e.target.value)} />
                        {deniedProblem && <p className="tg-error ma-settings-error">{deniedProblem}</p>}
                    </div>
                </ItemGroup>

                <MainAgentSafetySection machine={machines.find((m) => m.id === currentMachineId) ?? null} />

                <div className="ma-settings-actions">
                    {configStatus === 'error' && <span className="tg-error">{copy.settingsLoadFailed}</span>}
                    {configStatus === 'loading' && <Spinner size={14} />}
                    <span className="ma-settings-note">{copy.settingsStoredIn}</span>
                    <Button variant="primary" loading={saving} disabled={!dirty || !valid} onClick={() => void onSave()}>{copy.settingsSave}</Button>
                </div>
                <MainAgentAutomationsSection />
            </ItemList>
        </Page>
    );
}
