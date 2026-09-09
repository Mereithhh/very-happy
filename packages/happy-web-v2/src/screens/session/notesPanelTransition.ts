import type { SessionPanelTab } from './sessionPanelState';
export interface NotesPanelSnapshot { id: string | undefined; panel: SessionPanelTab | null; open: boolean }
export function notesPanelTransition(previous: NotesPanelSnapshot | null, current: NotesPanelSnapshot): { panel?: SessionPanelTab | null; open?: boolean } {
  if (!previous || previous.id !== current.id) {
    if (current.panel === 'notes') return { open: true };
    if (!current.panel && current.open) return { panel: 'notes' };
    if (current.panel && current.open) return { open: false };
  } else if (previous.panel !== current.panel) {
    if (current.panel === 'notes') return { open: true };
    if (previous.panel === 'notes') return { open: false };
  } else if (previous.open !== current.open) {
    if (current.open && current.panel !== 'notes') return { panel: 'notes' };
    if (!current.open && current.panel === 'notes') return { panel: null };
  }
  return {};
}
