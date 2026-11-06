/**
 * B-895 — the search fields of a session, a project and a team (searchMatch.ts
 * ranks them). Pure: callers resolve names from their stores and pass labels.
 *
 * 「负责人」 is searchable in both languages (`负责人` / `lead`) whatever the UI
 * language; a team's members are searchable by their current and earlier names.
 */
import type { ProjectView, TeamBot, TeamState } from '@slopus/happy-wire';
import { pathFields, prepareSearch, type PreparedSearch, type SearchField } from './searchMatch';

export interface SearchLabels {
  project: string;
  team: string;
  lead: string;
  member: string;
  sharer: string;
  machine: string;
}

const LEAD_WORDS = '负责人 負責人 lead';

export interface SessionSearchContext {
  projectName?: string | null;
  team?: { name: string; bot: Pick<TeamBot, 'name' | 'root' | 'previousNames'> } | null;
  /** Who shared this session (or its project) with me. */
  sharer?: string | null;
  machineName?: string | null;
  path?: string | null;
  /** How the path reads on screen (`~/code/x`). */
  pathDisplay?: string;
  /** Agent, worktree branch — weak signals like the machine. */
  meta?: readonly (string | null | undefined)[];
}

export function sessionSearchFields(ctx: SessionSearchContext, labels: SearchLabels): SearchField[] {
  const fields: SearchField[] = [];
  if (ctx.projectName) fields.push({ kind: 'project', text: ctx.projectName, display: `${labels.project} · ${ctx.projectName}` });
  if (ctx.team) {
    const { name, bot } = ctx.team;
    fields.push({ kind: 'team', text: name, display: `${labels.team} · ${name}` });
    if (bot.root) fields.push({ kind: 'role', text: `${LEAD_WORDS} ${labels.lead}`, display: `${name} › ${labels.lead}` });
    for (const botName of [bot.name, ...(bot.previousNames ?? [])]) {
      if (botName) fields.push({ kind: 'member', text: botName, display: `${name} › ${botName}` });
    }
  }
  if (ctx.sharer) fields.push({ kind: 'sharer', text: ctx.sharer, display: `${labels.sharer} · ${ctx.sharer}` });
  if (ctx.machineName) fields.push({ kind: 'machine', text: ctx.machineName, display: `${labels.machine} · ${ctx.machineName}` });
  for (const m of ctx.meta ?? []) if (m) fields.push({ kind: 'meta', text: m });
  fields.push(...pathFields(ctx.path, ctx.pathDisplay));
  return fields;
}

export type EntityKind = 'project' | 'team';

/** A project or team as a palette result row. */
export interface EntitySearchRow {
  key: string;
  kind: EntityKind;
  title: string;
  href: string;
  archived: boolean;
  projectId: string | null;
  machineId: string | null;
  search: PreparedSearch;
}

/** Projects I own (by name, attached teams) and projects shared with me (by name, sharer). */
export function projectSearchRows(
  projects: readonly ProjectView[],
  teams: readonly TeamState[],
  shared: readonly { id: string; projectId: string; name: string; status: string; owner: { displayName: string } }[],
  labels: SearchLabels,
): EntitySearchRow[] {
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const own = projects.map((p): EntitySearchRow => {
    const archived = p.archivedAt != null;
    return {
      key: `project:${p.id}`,
      kind: 'project',
      title: p.name,
      href: `/projects/${encodeURIComponent(p.id)}`,
      archived,
      projectId: p.id,
      machineId: null,
      search: prepareSearch({
        title: p.name,
        fields: (p.teamIds ?? []).flatMap((id): SearchField[] => {
          const name = teamName.get(id);
          return name ? [{ kind: 'team', text: name, display: `${labels.team} · ${name}` }] : [];
        }),
        updatedAt: p.updatedAt,
        archived,
      }),
    };
  });
  const ownIds = new Set(projects.map((p) => p.id));
  const incoming = shared.filter((s) => s.status === 'active' && !ownIds.has(s.projectId)).map((s): EntitySearchRow => ({
    key: `project-share:${s.id}`,
    kind: 'project',
    title: s.name,
    href: `/shared/project/${encodeURIComponent(s.id)}`,
    archived: false,
    projectId: s.projectId,
    machineId: null,
    search: prepareSearch({
      title: s.name,
      fields: [{ kind: 'sharer', text: s.owner.displayName, display: `${labels.sharer} · ${s.owner.displayName}` }],
    }),
  }));
  return [...own, ...incoming];
}

/** Teams by name, their project, 「负责人」 and every member's name. */
export function teamSearchRows(teams: readonly TeamState[], projectName: (id: string) => string | undefined, labels: SearchLabels): EntitySearchRow[] {
  return teams.map((team): EntitySearchRow => {
    const archived = team.archivedAt != null;
    const project = team.projectId ? projectName(team.projectId) : undefined;
    const fields: SearchField[] = [];
    if (project) fields.push({ kind: 'project', text: project, display: `${labels.project} · ${project}` });
    if (team.bots.some((b) => b.root)) fields.push({ kind: 'role', text: `${LEAD_WORDS} ${labels.lead}`, display: labels.lead });
    for (const bot of team.bots) {
      for (const name of [bot.name, ...(bot.previousNames ?? [])]) {
        if (name) fields.push({ kind: 'member', text: name, display: `${labels.member} · ${name}` });
      }
    }
    const lastEvent = Math.max(team.createdAt, ...team.bots.map((b) => b.lastEventAt ?? 0));
    return {
      key: `team:${team.id}`,
      kind: 'team',
      title: team.name,
      href: `/teams/${encodeURIComponent(team.id)}`,
      archived,
      projectId: team.projectId ?? null,
      machineId: team.machineId,
      search: prepareSearch({ title: team.name, fields, updatedAt: lastEvent, archived }),
    };
  });
}

/**
 * The palette's filter bar on a project / team row. Archived ones follow the
 * status chip; 等你 / agent / time narrow conversations only, so they hide
 * these rows; the project chip keeps its project (and the teams in it), the
 * machine chip keeps the teams on that machine.
 */
export function entityPassesFilters(
  row: Pick<EntitySearchRow, 'kind' | 'archived' | 'projectId' | 'machineId'>,
  f: { status: string; agent: string | null; machineId: string | null; projectId: string | null; time: string },
): boolean {
  if (f.status === 'archived' ? !row.archived : f.status !== 'all' && row.archived) return false;
  if (f.status === 'waiting' || f.agent || f.time !== 'any') return false;
  if (f.projectId && row.projectId !== f.projectId) return false;
  if (f.machineId && (row.kind !== 'team' || row.machineId !== f.machineId)) return false;
  return true;
}
