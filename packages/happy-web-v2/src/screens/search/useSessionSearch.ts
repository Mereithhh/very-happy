/**
 * B-650 → B-865: the cross-session search behind the ⌘K palette — titles and
 * metadata (Web-local), what was said (every online machine's daemon
 * `history-search`, in parallel) and the messages this tab already holds,
 * narrowed by the palette's filter bar. Moved out of the old SessionSearchPanel
 * unchanged; the palette decides how the rows are grouped (paletteModel.splitSearchRows).
 */
import { useEffect, useMemo, useState } from 'react';
import { storage, useAllMachines } from '@/sync/storage';
import type { Session } from '@/sync/storageTypes';
import type { Message } from '@/sync/typesMessage';
import { useProjects } from '@/sync/projects';
import { useIncomingProjectShares } from '@/sync/projectSharesStore';
import { useTranslation } from '@/i18n/useTranslation';
import { sessionPlacementResolver } from '@/app/sessionPlacement';
import { useTeamNavigation } from '@/screens/sessions/useTeamNavigation';
import { teamSessionMembership } from '@/screens/sessions/teamNavigation';
import { useTeamNavigationCopy } from '@/screens/sessions/teamNavigationCopy';
import { worktreeBranchLabel } from '@/utils/worktree';
import { formatPathRelativeToHome } from '@/utils/sessionUtils';
import { prepareSearch } from './searchMatch';
import { sessionSearchFields, type SearchLabels } from './searchDocs';
import { isListedLive } from '@/app/sessionHibernation';
import { useWakeExpiryTick } from '@/app/useWakeExpiryTick';
import { isAssistantSession } from '@/assistant/assistantSession';
import { sessionHasPendingRequests } from '@/screens/board/boardItems';
import { getSessionName, getSessionSidebarSubtitle } from '@/utils/sessionUtils';
import { machineLabel } from '@/utils/machineUtils';
import { findTrackedSessionId } from '@/screens/sessions/historySearch';
import { shortenCwd } from '@/screens/sessions/claudeHistoryImport';
import { useContentSearch } from './useContentSearch';
import {
    daemonAgentFor,
    importableAllowed,
    machinesInScope,
    mergeContentHits,
    parseSessionSearchQuery,
    passesFilters,
    rankRows,
    searchLocalSessions,
    summarizeCoverage,
    type CoverageSummary,
    type MachineContentHit,
    type SessionSearchDoc,
    type SessionSearchFilters,
    type SessionSearchQuery,
    type SessionSearchRow,
} from './sessionSearch';

/** Typing → local pass. The daemon fan-out waits CONTENT_DEBOUNCE_MS more (≈250 ms in all). */
export const LOCAL_DEBOUNCE_MS = 120;
export const CONTENT_DEBOUNCE_MS = 130;
const MAX_ROWS = 60;

export function useDebounced<T>(value: T, ms: number): T {
    const [v, setV] = useState(value);
    useEffect(() => {
        const t = setTimeout(() => setV(value), ms);
        return () => clearTimeout(t);
    }, [value, ms]);
    return v;
}

export interface SessionFacts {
    session: Session;
    doc: SessionSearchDoc;
    agent: string | null;
    machineId: string | null;
    projectId: string | null;
    waiting: boolean;
}

export interface SessionSearchResult {
    /** Parsed debounced query. */
    q: SessionSearchQuery;
    /** Sessions passing the filters (assistant excluded; archived per the status filter). */
    passing: SessionFacts[];
    /** All searchable sessions — the agent filter's options come from these. */
    facts: SessionFacts[];
    /** One row per matching session / importable conversation, ranked; [] when not searching. */
    rows: SessionSearchRow[];
    coverage: CoverageSummary;
    /** The agent filter names an agent the daemons do not index. */
    contentSkipped: boolean;
    machines: ReturnType<typeof useAllMachines>;
    projects: ReturnType<typeof useProjects>;
    /** B-895: teams (sidebar navigation snapshot) and the field labels, for the project / team rows. */
    teams: ReturnType<typeof useTeamNavigation>;
    incomingProjects: ReturnType<typeof useIncomingProjectShares>;
    labels: SearchLabels;
    now: number;
}

/**
 * `text` = the free text to search for (already gated by the caller: '' = no
 * search). `rawInput` carries the `#tag` grammar for the tag filter.
 */
export function useSessionSearch(rawInput: string, enabled: boolean, filters: SessionSearchFilters): SessionSearchResult {
    const debounced = useDebounced(enabled ? rawInput : '', LOCAL_DEBOUNCE_MS);
    const q = useMemo(() => parseSessionSearchQuery(debounced), [debounced]);
    const searching = q.terms.length > 0;

    const sessionsById = storage((s) => s.sessions);
    // B-906b: a waking row's 'archived' flag flips when its grace runs out.
    const wakeTick = useWakeExpiryTick(useMemo(() => Object.values(sessionsById), [sessionsById]));
    const machines = useAllMachines({ includeOffline: true });
    const projects = useProjects();

    const teams = useTeamNavigation();
    const incomingProjects = useIncomingProjectShares();
    const { t } = useTranslation();
    const teamCopy = useTeamNavigationCopy();
    const labels = useMemo<SearchLabels>(() => ({
        project: t('sessionSearch.projectLabel'),
        team: t('sessionSearch.teamLabel'),
        lead: teamCopy.lead,
        member: teamCopy.member,
        sharer: t('sessionSearch.sharerLabel'),
        machine: t('sessionSearch.machineLabel'),
    }), [t, teamCopy]);

    // B-895: a team's sessions belong to the team's project (same rule as the sidebar).
    const liveTeams = useMemo(() => teams.filter((team) => !team.archivedAt), [teams]);
    const placement = useMemo(() => sessionPlacementResolver(projects.projects, projects.members, liveTeams), [projects.projects, projects.members, liveTeams]);
    const membership = useMemo(() => teamSessionMembership(liveTeams), [liveTeams]);
    const projectName = useMemo(() => new Map([
        ...incomingProjects.map((p) => [p.projectId, p.name] as const),
        ...projects.projects.map((p) => [p.id, p.name] as const),
    ]), [projects.projects, incomingProjects]);
    const machineName = useMemo(() => new Map(machines.map((m) => [m.id, machineLabel(m)])), [machines]);

    // Every searchable session (archived and terminal mirrors included; the assistant is not a conversation).
    const facts = useMemo<SessionFacts[]>(() => {
        const out: SessionFacts[] = [];
        const now = Date.now();
        for (const s of Object.values(sessionsById)) {
            if (isAssistantSession(s)) continue;
            const archived = !isListedLive(s, now);
            const projectId = placement(s.id).projectId ?? null;
            const machineId = s.metadata?.machineId ?? null;
            const flavor = s.metadata?.flavor?.trim() || null;
            const agent = !flavor || flavor === 'terminal-mirror' ? 'claude' : flavor;
            const member = membership.get(s.id);
            const title = getSessionName(s);
            const tags = s.metadata?.tags ?? [];
            const path = s.metadata?.path ?? null;
            const fields = sessionSearchFields({
                projectName: projectId ? projectName.get(projectId) : s.share?.projectId ? projectName.get(s.share.projectId) : null,
                team: member ? { name: member.team.name, bot: member.bot } : null,
                sharer: s.share?.owner.displayName ?? null,
                machineName: (machineId ? machineName.get(machineId) : null) ?? s.metadata?.host ?? null,
                path,
                pathDisplay: path ? formatPathRelativeToHome(path, s.metadata?.homeDir) : undefined,
                meta: [agent, worktreeBranchLabel(s.metadata)],
            }, labels);
            out.push({
                session: s,
                agent,
                machineId,
                projectId,
                waiting: sessionHasPendingRequests(s) || s.metadata?.board?.attention === 'review' || s.metadata?.board?.attention === 'blocked',
                doc: {
                    sessionId: s.id,
                    title,
                    subtitle: getSessionSidebarSubtitle(s),
                    // B-895: ties go to the most recently active — the sidebar's activity time (Sidebar.tsx `ts`).
                    search: prepareSearch({ title, fields, tags, updatedAt: s.updatedAt || s.activeAt || s.createdAt, archived }),
                    tags,
                    updatedAt: s.updatedAt,
                    archived,
                },
            });
        }
        return out;
    }, [sessionsById, wakeTick, placement, membership, projectName, machineName, labels]);

    const now = Date.now();
    const passing = useMemo(
        () => facts.filter((f) => passesFilters({ ...f, archived: f.doc.archived, updatedAt: f.doc.updatedAt }, filters, now)),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [facts, filters],
    );
    const docMap = useMemo(() => new Map(passing.map((f) => [f.doc.sessionId, f.doc])), [passing]);

    // Content scope: machines owning sessions + every online machine, narrowed by the machine filter.
    const scopeMachines = useMemo(() => {
        const owning = new Set(facts.map((f) => f.machineId).filter((x): x is string => !!x));
        const list = machinesInScope(machines, owning);
        return filters.machineId ? list.filter((m) => m.id === filters.machineId) : list;
    }, [machines, facts, filters.machineId]);
    const daemonAgent = daemonAgentFor(filters);
    const content = useContentSearch({
        query: daemonAgent === null || !searching ? '' : q.text,
        agent: daemonAgent ?? undefined,
        machines: scopeMachines,
        debounceMs: CONTENT_DEBOUNCE_MS,
    });

    const rows = useMemo<SessionSearchRow[]>(() => {
        if (!searching) return [];
        const cached = new Map<string, readonly Message[]>();
        const all = storage.getState().sessionMessages;
        for (const f of passing) {
            const m = all[f.doc.sessionId]?.messages;
            if (m && m.length) cached.set(f.doc.sessionId, m);
        }
        const local = searchLocalSessions(passing.map((f) => f.doc), cached, q);
        const rawSessions = Object.values(sessionsById);
        const hits: MachineContentHit[] = [];
        for (const [machineId, list] of content.hits) {
            for (const hit of list) {
                const tracked = findTrackedSessionId(hit.entry.agent, hit.entry.agent === 'claude' ? hit.entry.claudeSessionId : hit.entry.codexThreadId, rawSessions);
                if (!tracked) {
                    if (filters.time !== 'any' && !passesFilters({ archived: false, waiting: false, agent: hit.entry.agent, machineId, projectId: null, updatedAt: hit.entry.updatedAt }, { ...filters, status: 'all', projectId: null }, now)) continue;
                }
                hits.push({
                    machineId,
                    hit,
                    ...(tracked ? { sessionId: tracked.sessionId } : {}),
                    subtitle: [machineName.get(machineId), hit.entry.agent, shortenCwd(hit.entry.cwd, machines.find((m) => m.id === machineId)?.metadata?.homeDir)].filter(Boolean).join(' · '),
                });
            }
        }
        const merged = hits.length ? mergeContentHits(local, hits, docMap, q, { includeImportable: importableAllowed(filters) }) : rankRows(local);
        return merged.slice(0, MAX_ROWS);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searching, passing, q, content.hits, docMap, sessionsById, filters, machineName, machines]);

    const coverage = useMemo(() => summarizeCoverage(content.coverage), [content.coverage]);

    return {
        q, passing, facts, rows, coverage,
        contentSkipped: searching && daemonAgent === null,
        machines, projects, teams, incomingProjects, labels, now,
    };
}
