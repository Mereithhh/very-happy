import type { ProjectView } from '@slopus/happy-wire';
import { suggestProjectFor } from './projectSuggestion';

/**
 * B-757 新建会话弹窗的「所属项目」说明. `suggested` is `suggestProjectFor` for the
 * chosen folder (the one directory rule, B-649/B-755); `picked` is the user's
 * own choice — undefined until they touch the picker, null for「无项目」.
 */
export type NewSessionProjectHint =
  | { kind: 'auto'; project: ProjectView }
  | { kind: 'picked'; project: ProjectView }
  | { kind: 'declined'; suggested: ProjectView }
  | { kind: 'none' };
export function newSessionProjectHint(suggested: ProjectView | null, picked: string | null | undefined, projects: ProjectView[]): NewSessionProjectHint {
  if (picked === undefined) return suggested ? { kind: 'auto', project: suggested } : { kind: 'none' };
  const project = picked ? projects.find((p) => p.id === picked) : undefined;
  if (project) return project.id === suggested?.id ? { kind: 'auto', project } : { kind: 'picked', project };
  return suggested ? { kind: 'declined', suggested } : { kind: 'none' };
}

/**
 * B-757 快捷新建 (sidebar / phone ＋, ⌘N) opens no dialog, so the new session
 * page says once where the session landed: in a project, or in none (with the
 * folder's project, if any, one click away). Null while projects load.
 */
export type QuickSessionProjectNote = { kind: 'member'; project: ProjectView } | { kind: 'suggest'; project: ProjectView } | { kind: 'none' };
export function quickSessionProjectNote(
  sessionId: string,
  session: { machineId?: string | null; path?: string | null } | undefined,
  snap: { status: string; projects: ProjectView[]; members: { sessionId: string; projectId: string }[] },
): QuickSessionProjectNote | null {
  if (snap.status !== 'ready') return null;
  const member = snap.members.find((m) => m.sessionId === sessionId);
  const project = member ? snap.projects.find((p) => p.id === member.projectId) : undefined;
  if (project) return { kind: 'member', project };
  const suggested = session ? suggestProjectFor(session, snap.projects) : null;
  return suggested ? { kind: 'suggest', project: suggested } : { kind: 'none' };
}

const QUICK_KEY = 'vh:quick-session-note:v1';
/** A quick session keeps its note for a day on this device, until dismissed or acted on. */
export const QUICK_NOTE_TTL_MS = 24 * 3600_000;
type QuickMarks = Record<string, number>;
function readQuick(storage: Pick<Storage, 'getItem'> | undefined): QuickMarks {
  try { return (JSON.parse(storage?.getItem(QUICK_KEY) ?? '{}') as QuickMarks) ?? {}; } catch { return {}; }
}
function writeQuick(marks: QuickMarks, storage: Pick<Storage, 'setItem'> | undefined): void {
  try { storage?.setItem(QUICK_KEY, JSON.stringify(marks)); } catch { /* storage unavailable: no note */ }
}
export function markQuickSession(sessionId: string, now = Date.now(), storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = globalThis.localStorage): void {
  const live = Object.entries(readQuick(storage)).filter(([, at]) => now - at < QUICK_NOTE_TTL_MS).slice(-49);
  writeQuick({ ...Object.fromEntries(live), [sessionId]: now }, storage);
}
export function isQuickSession(sessionId: string, now = Date.now(), storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): boolean {
  const at = readQuick(storage)[sessionId];
  return typeof at === 'number' && now - at < QUICK_NOTE_TTL_MS;
}
export function clearQuickSession(sessionId: string, storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = globalThis.localStorage): void {
  const marks = readQuick(storage);
  if (!(sessionId in marks)) return;
  delete marks[sessionId];
  writeQuick(marks, storage);
}

/** The line under the dialog's project picker (zh-Hans / English). */
export function projectHintText(hint: NewSessionProjectHint, zh: boolean): string {
  switch (hint.kind) {
    case 'auto': return zh ? `目录在「${hint.project.name}」里，将加入这个项目。` : `This folder is in “${hint.project.name}”; the session joins it.`;
    case 'picked': return zh ? `将加入项目「${hint.project.name}」。` : `The session joins “${hint.project.name}”.`;
    case 'declined': return zh ? `不加入项目（这个目录属于「${hint.suggested.name}」）。` : `No project (this folder belongs to “${hint.suggested.name}”).`;
    default: return zh ? '不属于任何项目。需要时在上面选择项目。' : 'Not in any project. Choose one above if needed.';
  }
}
