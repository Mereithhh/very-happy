import type { ProjectMemberView, ProjectView } from '@slopus/happy-wire';

export interface ProjectListEntry { project: ProjectView; sessions: number; teams: number; attention: number }

/**
 * B-756 `/projects` rows: member sessions, attached teams and 等你处理 (the
 * board's attention set, same as the sidebar head and the project page).
 * Live list: projects with something waiting first, then most recently
 * updated; archived list: most recently archived first.
 */
export function projectListModel(projects: ProjectView[], members: ProjectMemberView[], attentionKeys: ReadonlySet<string>, opts: { archived?: boolean } = {}): ProjectListEntry[] {
  const bySession = new Map<string, string[]>();
  for (const m of members) bySession.set(m.projectId, [...(bySession.get(m.projectId) ?? []), m.sessionId]);
  const rows = projects
    .filter((p) => (opts.archived ? !!p.archivedAt : !p.archivedAt))
    .map((project) => {
      const ids = bySession.get(project.id) ?? [];
      return { project, sessions: ids.length, teams: project.teamIds?.length ?? 0, attention: ids.filter((id) => attentionKeys.has(id)).length };
    });
  return opts.archived
    ? rows.sort((a, b) => (b.project.archivedAt ?? 0) - (a.project.archivedAt ?? 0))
    : rows.sort((a, b) => Number(b.attention > 0) - Number(a.attention > 0) || b.project.updatedAt - a.project.updatedAt);
}
