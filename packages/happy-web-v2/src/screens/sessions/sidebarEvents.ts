/**
 * B-896: ⌘K → sidebar. The 新建项目 dialog lives in Sidebar.tsx, so the
 * palette asks for it with a window event instead of owning a second copy.
 * The mounted sidebar claims the event (preventDefault); when none is mounted
 * (phone detail page) the caller falls back to the /projects list.
 */
export const NEW_PROJECT_EVENT = 'vh:new-project';

/** True when a mounted sidebar opened the dialog. */
export function requestNewProject(): boolean {
  return !window.dispatchEvent(new Event(NEW_PROJECT_EVENT, { cancelable: true }));
}
