/**
 * B-516: header + body of an optimistic pending session page. The layout
 * slots are SessionDetailScreen's own (single tree), so the composer below
 * stays mounted when the page turns into the real session.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ListEnd, Trash2 } from 'lucide-react';
import { BackButton } from '@/app/BackButton';
import { storage, useAllMachines, useSetting } from '@/sync/storage';
import { Button, Combobox, Spinner, SuggestInput } from '@/ui';
import type { SelectOption } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import type { PendingAgent, PendingSessionRecord } from '@/sync/pendingSessions';
import { pendingSessions, useAdoptableSession } from '@/sync/pendingSessionsRuntime';
import { isMachineOnline } from '@/utils/machineUtils';
import { isAgentOffered, resolveAgentAvailability, SESSION_AGENTS } from '@/utils/agentAvailability';
import { resolveNewSessionPermissionMode } from '@/sync/agentDefaults';
import { launcherReportsRunFacts } from '@/sync/followLatestDisplay';
import { machineCliVersion } from '@/app/staleWrapperPolicy';
import { useProjects } from '@/sync/projects';
import { suggestProjectFor } from '@/screens/projects/projectSuggestion';
import { draftDirectorySuggestions, draftProjectHint, resolveHomePath } from './draftTarget';
import './header.css';
import './input.css';
import './pendingSession.css';

function basename(path: string): string {
    const trimmed = path.replace(/\/+$/, '');
    return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed;
}

export function PendingSessionHeader({ record }: { record: PendingSessionRecord }) {
    const { t } = useTranslation();
    const machineName = storage((s) => {
        const meta = s.machines[record.machineId]?.metadata;
        return meta?.displayName || meta?.host || record.machineId.slice(0, 8);
    });
    const status = record.state === 'draft'
        ? t('pendingSession.draft')
        : record.state === 'failed'
        ? t('pendingSession.sidebarFailed')
        : record.state === 'needs-approval'
            ? t('pendingSession.sidebarNeedsApproval')
            : record.state === 'landed'
                ? t('pendingSession.connecting')
                : record.waitingForModels
                    ? t('pendingSession.waitingForModels', { machine: machineName })
                    : t('pendingSession.starting');
    const busy = record.state === 'spawning' || record.state === 'landing' || record.state === 'landed';
    return (
        <header className="ch ps-head" data-pending-state={record.state}>
            <BackButton />
            <div className="ch-main">
                <span className="ch-title">{basename(record.path) || t('newSessionModal.chatTitle')}</span>
                <span className="ps-head-sub mono" title={`${machineName} · ${record.path}`}>{record.agent} · {machineName} · {record.path}</span>
            </div>
            <div className="ch-status ps-head-status" role="status">
                {busy && <Spinner size={14} />}
                <span>{status}</span>
            </div>
        </header>
    );
}

export function PendingSessionBody({ record }: { record: PendingSessionRecord }) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const adoptable = useAdoptableSession(record);
    const id = record.pendingId;
    const machineOffline = storage((s) => {
        const machine = s.machines[record.machineId];
        return !!machine && !isMachineOnline(machine);
    });

    // Another tab owns this record (and runs its spawn): show, don't act.
    if (!pendingSessions.isOwnedHere(id) && record.state !== 'landed') {
        return (
            <div className="ps-body">
                <section className="ps-card" role="status">
                    <p className="ps-card-text">{t('pendingSession.otherTab')}</p>
                </section>
                <PendingOutbox record={record} />
            </div>
        );
    }

    if (record.state === 'needs-approval') {
        return (
            <div className="ps-body">
                <section className="ps-card" role="alertdialog" aria-labelledby={`${id}-title`}>
                    <div className="ps-card-title" id={`${id}-title`}>{t('pendingSession.needsApprovalTitle')}</div>
                    <p className="ps-card-text">{t('pendingSession.needsApprovalMessage', { directory: record.approvalDirectory ?? record.path })}</p>
                    <div className="ps-card-actions">
                        <Button variant="ghost" onClick={() => pendingSessions.declineDirectory(id)}>{t('common.cancel')}</Button>
                        <Button variant="primary" onClick={() => pendingSessions.approveDirectory(id)}>{t('pendingSession.createAndStart')}</Button>
                    </div>
                </section>
                <PendingOutbox record={record} />
            </div>
        );
    }

    if (record.state === 'failed') {
        const title = record.failure === 'interrupted'
            ? t('pendingSession.interruptedTitle')
            : record.failure === 'directory-declined'
                ? t('pendingSession.declinedTitle')
                : t('pendingSession.failedTitle');
        const detail = record.failure === 'interrupted' ? t('pendingSession.interruptedMessage') : record.error;
        return (
            <div className="ps-body">
                <section className="ps-card ps-card--failed" role="alert">
                    <div className="ps-card-title">{title}</div>
                    {detail && <p className="ps-card-text ps-card-error">{detail}</p>}
                    {machineOffline && record.failure !== 'directory-declined' && <p className="ps-card-text">{t('pendingSession.machineOffline')}</p>}
                    {record.textReturned && <p className="ps-card-text">{t('pendingSession.textKept')}</p>}
                    {record.deferred && record.outbox.length > 0 && <p className="ps-card-text">{t('pendingSession.failedDraftKept')}</p>}
                    {adoptable && (
                        <div className="ps-adopt">
                            <span>{t('pendingSession.adoptFound')}</span>
                            <Button variant="secondary" onClick={() => pendingSessions.adopt(id, adoptable)}>{t('pendingSession.adopt')}</Button>
                        </div>
                    )}
                    <div className="ps-card-actions">
                        {record.deferred
                            ? <Button variant="ghost" onClick={() => pendingSessions.backToDraft(id)}>{t('pendingSession.backToDraft')}</Button>
                            : <Button variant="ghost" onClick={() => navigate('/')}>{t('common.back')}</Button>}
                        <Button variant="primary" onClick={() => pendingSessions.retry(id)}>{t('common.retry')}</Button>
                    </div>
                </section>
                <PendingOutbox record={record} />
            </div>
        );
    }

    if (record.state === 'draft') {
        return (
            <div className="ps-body">
                <DraftTarget record={record} />
            </div>
        );
    }

    return (
        <div className="ps-body">
            <PendingOutbox record={record} />
        </div>
    );
}

function machineLabel(meta: { displayName?: string; host?: string } | null | undefined, id: string): string {
    return meta?.displayName || meta?.host || id.slice(0, 8);
}

/**
 * B-801: the draft page's 「发到哪里」 — agent, machine and directory stay
 * editable until the first send (model / permission / effort sit in the
 * composer as on any session), plus where the session lands project-wise.
 */
function DraftTarget({ record }: { record: PendingSessionRecord }) {
    const { t, lang } = useTranslation();
    const zh = lang.startsWith('zh');
    const id = record.pendingId;
    const machines = useAllMachines({ includeOffline: true });
    const recents = useSetting('recentMachinePaths');
    const presets = useSetting('sessionPathPresets') as Array<{ path: string }> | undefined;
    const projectsSnap = useProjects();
    const machine = machines.find((m) => m.id === record.machineId);
    const homeDir = (machine?.metadata as { homeDir?: string } | undefined)?.homeDir;
    // Typed text stays as typed (`~/x`); the record gets the resolved path.
    const [directory, setDirectory] = useState(record.path);
    useEffect(() => { setDirectory((typed) => (resolveHomePath(typed.trim(), homeDir) === record.path ? typed : record.path)); }, [record.path, homeDir]);

    // B-849a: a machine whose CLI cannot report what this agent runs is marked
    // in the list, and the card names where the session lands.
    const oldCli = (m: (typeof machines)[number]) => !launcherReportsRunFacts(record.agent, { cliVersion: machineCliVersion(m) });
    const machineOptions: SelectOption[] = useMemo(() => [
        ...machines.filter(isMachineOnline).map((m) => ({ value: m.id, label: machineLabel(m.metadata, m.id), ...(oldCli(m) ? { meta: t('pendingSession.draftOldCliTag') } : {}) })),
        ...machines.filter((m) => !isMachineOnline(m)).map((m) => ({ value: m.id, label: machineLabel(m.metadata, m.id), meta: t('pendingSession.draftOffline'), disabled: true })),
        ...(machine ? [] : [{ value: record.machineId, label: record.machineId.slice(0, 8), meta: t('pendingSession.draftOffline'), disabled: true }]),
    ], [machines, machine, record.machineId, record.agent, t]);
    const machineName = machine ? machineLabel(machine.metadata, machine.id) : record.machineId.slice(0, 8);
    const machineVersion = machine ? machineCliVersion(machine) : null;
    const agentOptions: SelectOption[] = SESSION_AGENTS
        .filter((a) => a === record.agent || isAgentOffered(machine?.metadata, a))
        .map((a) => {
            const available = resolveAgentAvailability(machine?.metadata, a).available;
            return { value: a, label: a, ...(available ? {} : { disabled: true, meta: t('newSessionModal.notInstalled') }) };
        });
    const suggestions = useMemo(
        () => draftDirectorySuggestions(record.machineId, recents ?? [], presets ?? []),
        [record.machineId, recents, presets],
    );
    const liveProjects = projectsSnap.projects.filter((p) => !p.archivedAt);
    const joining = record.onSpawnedProject ? liveProjects.find((p) => p.id === record.onSpawnedProject!.projectId) : undefined;
    const suggested = suggestProjectFor({ machineId: record.machineId, path: record.path }, liveProjects);
    const projectHint = projectsSnap.status === 'ready' ? draftProjectHint(joining, suggested, zh) : null;

    const setAgent = (agent: string) => {
        const state = storage.getState();
        const next = agent as PendingAgent;
        pendingSessions.setTarget(id, {
            agent: next,
            permissionMode: resolveNewSessionPermissionMode(state.settings.agentDefaultOverrides, next, state.localSettings.newSessionReviewFirst),
        });
    };
    const commitDirectory = (value: string) => {
        setDirectory(value);
        const resolved = resolveHomePath(value.trim(), homeDir);
        if (resolved) pendingSessions.setTarget(id, { path: resolved });
    };

    return (
        <section className="ps-card ps-draft" data-testid="draft-target" aria-labelledby={`${id}-draft-title`}>
            <div className="ps-card-title" id={`${id}-draft-title`}>{t('pendingSession.draftTitle')}</div>
            <p className="ps-card-text">{t('pendingSession.draftHint')}</p>
            <div className="ps-draft-grid">
                <label className="ps-draft-label" id={`${id}-agent`}>{t('pendingSession.draftAgent')}</label>
                <Combobox label={t('pendingSession.draftAgent')} labelledBy={`${id}-agent`} value={record.agent} onChange={setAgent} options={agentOptions} searchable={false} />
                <label className="ps-draft-label" id={`${id}-machine`}>{t('pendingSession.draftMachine')}</label>
                <Combobox label={t('pendingSession.draftMachine')} labelledBy={`${id}-machine`} value={record.machineId} onChange={(machineId) => pendingSessions.setTarget(id, { machineId })} options={machineOptions} />
                <label className="ps-draft-label" htmlFor={`${id}-dir`}>{t('pendingSession.draftDirectory')}</label>
                <SuggestInput
                    id={`${id}-dir`}
                    className="ps-draft-dir mono"
                    value={directory}
                    onValueChange={commitDirectory}
                    suggestions={suggestions}
                    placeholder="~/code/project"
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                />
            </div>
            <p className="ps-card-text ps-draft-landing" data-testid="draft-landing">{t('pendingSession.draftLanding', { machine: machineName })}</p>
            {machine && machineVersion && oldCli(machine) && <p className="ps-card-text ps-draft-warn" role="status" data-testid="draft-old-cli">{t('pendingSession.draftOldCli', { machine: machineName, version: machineVersion })}</p>}
            {projectHint && <p className="ps-card-text ps-draft-project" data-testid="draft-project-hint">{projectHint}</p>}
        </section>
    );
}

/** Messages sent before the session exists. Same row style as the composer queue. */
function PendingOutbox({ record }: { record: PendingSessionRecord }) {
    const { t } = useTranslation();
    if (record.outbox.length === 0) return null;
    // A draft's first message is what is being started (B-801): 返回修改 takes it back instead.
    const removable = !record.deferred && (record.state === 'spawning' || record.state === 'needs-approval') && pendingSessions.isOwnedHere(record.pendingId);
    return (
        <section className="ci-queue ps-outbox" aria-label={t('pendingSession.outboxTitle')}>
            <div className="ci-queue-list">
                {record.outbox.map((item) => (
                    <div className="ci-queue-item" key={item.id} data-pending-outbox-item>
                        <ListEnd className="ci-queue-index" size={17} aria-hidden />
                        <span className="ps-outbox-text">
                            <span className="ci-queue-text">{item.text}</span>
                            <span className="ps-outbox-hint">{record.deferred
                                ? (record.state === 'failed' ? t('pendingSession.notSent') : t('pendingSession.sending'))
                                : t('pendingSession.sendAfterStart')}</span>
                        </span>
                        <div className="ci-queue-actions">
                            {removable && (
                                <button
                                    type="button"
                                    className="ci-queue-action"
                                    onClick={() => pendingSessions.removeOutboxItem(record.pendingId, item.id)}
                                    aria-label={t('pendingSession.removeQueued')}
                                    title={t('pendingSession.removeQueued')}
                                ><Trash2 size={15} /></button>
                            )}
                        </div>
                    </div>
                ))}
            </div>
        </section>
    );
}
