/**
 * notesPanelState — imperative open/close/tab helpers for the notes dock, so
 * non-hook call sites (command palette `run`, sidebar buttons, ⌘J handler)
 * can drive it. State itself lives in localSettings (device-local — which
 * panel is open on which screen is geometry, not account state).
 */
import { storage } from '@/sync/storage';
import { nextActiveTab } from '@/sync/notes';

export function setNotesPanelOpen(open: boolean): void {
    storage.getState().applyLocalSettings({ notesPanelOpen: open });
}

export function toggleNotesPanel(): void {
    const s = storage.getState();
    s.applyLocalSettings({ notesPanelOpen: !s.localSettings.notesPanelOpen });
}

/** Open a note as a tab (appending if new) and focus it; opens the dock. */
export function openNoteTab(id: string): void {
    const s = storage.getState();
    const tabs = s.localSettings.notesOpenTabs;
    s.applyLocalSettings({
        notesPanelOpen: true,
        notesOpenTabs: tabs.includes(id) ? tabs : [...tabs, id],
        notesActiveTab: id,
    });
}

/** Close a tab (the note itself survives — tabs are just a device-local view). */
export function closeNoteTab(id: string): void {
    const s = storage.getState();
    const tabs = s.localSettings.notesOpenTabs;
    const active = s.localSettings.notesActiveTab;
    s.applyLocalSettings({
        notesOpenTabs: tabs.filter((t) => t !== id),
        notesActiveTab: active === id ? nextActiveTab(tabs, id) : active,
    });
}

/** Show the dock's all-notes list view (no active tab). */
export function showNotesList(): void {
    storage.getState().applyLocalSettings({ notesPanelOpen: true, notesActiveTab: null });
}

/** B-117: pick the note shown in the split view's lower editor (null = none).
 *  Deliberately does NOT touch tabs — split selection is the browse-and-edit
 *  lane, tabs are the pinned lane. */
export function setNotesSplitNote(id: string | null): void {
    storage.getState().applyLocalSettings({ notesSplitNote: id });
}
