import * as z from 'zod';

//
// Schema
//

export const LocalSettingsSchema = z.object({
    // Developer settings (device-specific)
    debugMode: z.boolean().describe('Enable debug logging'),
    devModeEnabled: z.boolean().describe('Enable developer menu in settings'),
    voiceUpsellOverride: z.enum(['control', 'show-paywall-before-first-voice-chat', 'voice-onboarding-and-upsell']).nullable().describe('Developer-only local override for the voice-upsell PostHog flag'),
    commandPaletteEnabled: z.boolean().describe('Enable CMD+K command palette (web only)'),
    themePreference: z.enum(['light', 'dark', 'adaptive']).describe('Theme preference: light, dark, or adaptive (follows system)'),
    markdownCopyV2: z.boolean().describe('Replace native paragraph selection with long-press modal for full markdown copy'),
    consoleLoggingEnabled: z.boolean().describe('Enable console output in production builds'),
    verboseLogging: z.boolean().describe('Log all network requests and responses'),
    zenMode: z.boolean().describe('Hide all sidebars and non-essential UI for focused work'),
    assistantTranscriptPinned: z.boolean().describe('Keep the /assistant text transcript open (desktop: right side panel)'),
    filesSidebarCollapsed: z.boolean().describe('Collapse the desktop files sidebar to a thin rail to save space'),
    // Safety: when on, new sessions default to a review-first permission mode
    // (the agent proposes changes before they are applied) instead of an
    // auto-apply mode. Device-local on purpose — it is a per-machine safety
    // preference, not a synced setting, so it carries no zod .default() footgun.
    newSessionReviewFirst: z.boolean().describe('Default new sessions to a review-first permission mode instead of auto-applying changes'),
    // CLI version acknowledgments - keyed by machineId
    acknowledgedCliVersions: z.record(z.string(), z.string()).describe('Acknowledged CLI versions per machine'),
    // Desktop sidebar width override (px) set by dragging the divider. null = use
    // the responsive default. Per-device (local).
    sidebarWidth: z.number().nullable().describe('User-dragged desktop sidebar width in px (null = responsive default)'),
    // Files-panel width override (px) set by dragging its divider — shared by
    // BOTH hosts (session FilesPanel sidebar + terminal file browser, B-088).
    // null = responsive default. Per-device (local) like sidebarWidth: panel
    // width is a screen-geometry preference, not account state.
    filesPanelWidth: z.number().nullable().describe('User-dragged files panel width in px, shared by session and terminal hosts (null = responsive default)'),
    // What `/` shows when nothing is open: the classic empty-detail placeholder
    // ('normal') or the global Task Board ('board'). Device-local on purpose.
    homeView: z.enum(['normal', 'board']).describe('Home screen when nothing is open: empty detail or the task board'),
    // Task board layout: 'lifecycle' (default: running / waiting-on-me / done)
    // or 'tasks' (per-task swimlanes). 'status' is the RETIRED V1 four-state
    // layout — it must stay in the enum: localSettings is parsed as one blob
    // (safeParse below), so dropping a stored value would reset EVERY local
    // setting on that device. Renderers treat 'status' as 'lifecycle'.
    // Device-local like homeView — a view preference, not account state.
    boardLayout: z.enum(['status', 'tasks', 'lifecycle']).describe('Task board layout: lifecycle columns or per-task swimlanes (status = legacy alias of lifecycle)'),
    // Sidebar display mode: 'list' (full manual order) or 'status' (lifecycle
    // groups fed by the board classifier). The sidebar's third segment —
    // archived — is deliberately NOT representable here: it's a filter over a
    // different data set, not a display mode, and remembering it would strand
    // users in the archive view on every reload. Device-local like boardLayout.
    // Enum values are only ever ADDED (safeParse parses the whole blob — see
    // the boardLayout note above).
    sidebarView: z.enum(['list', 'status']).describe('Sidebar display mode: manual-order list or lifecycle status groups'),
    // B-091: 列表 view only — render the list grouped by each row's first tag
    // (untagged rows in a trailing 未分组 section). Device-local like
    // sidebarView: a display-mode preference, not account state. NO .default()
    // (localSettings is device-local so the synced-settings footgun doesn't
    // apply, but the schema stays uniform: defaults live in
    // localSettingsDefaults only).
    sidebarGroupByTag: z.boolean().describe('Group the sidebar list view by each session\'s first tag'),
    // Web terminal (mobile): line-input mode — a plain textarea below the key
    // bar composes whole lines (IME/dictation-friendly, no xterm composition
    // quirks) and sends them to the pty on Enter, instead of per-key input
    // through xterm's hidden textarea. Device-local on purpose: it's an
    // input-hardware preference (phone vs desktop), not an account preference.
    terminalInputBarMode: z.boolean().describe('Use the line-input bar (compose + send) instead of per-key input in the mobile web terminal'),
    // Web terminal: WHO owns the keyboard/IME state machine (B-093, spec
    // `specs/2026-08-terminal-input-ownership.md`).
    //   'xterm' — today's path: xterm's hidden helper textarea receives keys
    //             and composition events (+ the imeStuckGuard patch on top).
    //   'own'   — our own controlled input element owns them; xterm degrades
    //             to a renderer + key encoder, and its CompositionHelper can
    //             never be reached (the stuck-composition state that broke CJK
    //             input three times becomes UNREACHABLE by construction).
    // Device-local, like terminalInputBarMode: input hardware is a device
    // trait — and rolling back must not require a release. Enum values are
    // only ever ADDED (the whole blob is safeParse'd; dropping a stored value
    // would reset EVERY local setting on that device — see boardLayout).
    terminalInputOwnership: z.enum(['xterm', 'own']).describe('Who owns the web terminal keyboard/IME state machine: xterm (legacy) or our own input element'),
    // copy_to_clipboard pushes: silently write into this device's clipboard on
    // arrival (toast only). Off = every push lands in history + a clickable
    // "tap to copy" toast instead. Device-local on purpose: whether a browser
    // may auto-write its clipboard is a per-device trust/capability choice.
    clipboardAutoCopy: z.boolean().describe('Auto-copy incoming clipboard pushes into this device\'s clipboard'),
    // ⌘W/⌥W close-session guard, layer 1 (B-089): ask before the shortcut
    // archives the open chat session / closes the open terminal; OFF = act
    // immediately without a dialog. Device-local on purpose — whether the chord
    // even reaches the page depends on THIS device's client (installed PWA vs
    // browser tab), so the preference belongs to the device, not the account.
    closeViewConfirm: z.boolean().describe('Ask for confirmation before ⌘W/⌥W archives the open chat session or closes the open terminal'),
    // Layer 2: arm the browser's native beforeunload dialog while a session view
    // is open — the only thing that can interrupt ⌘W closing a real browser TAB.
    // Separate switch because it is a different mechanism with different costs
    // (it also fires on ⌘R / window close, and its UI belongs to the browser).
    closeTabWarning: z.boolean().describe('Ask the browser to confirm closing/reloading the tab while a session view is open'),
    // Prompt-notes dock (B-094). All device-local like filesPanelWidth: which
    // panel is open / how wide / which tabs are showing is screen geometry,
    // not account state — note CONTENT syncs via account KV (notesStore.ts).
    notesPanelOpen: z.boolean().describe('Notes dock visible (right-side panel on every route)'),
    notesPanelWidth: z.number().nullable().describe('User-dragged notes dock width in px (null = responsive default)'),
    notesOpenTabs: z.array(z.string()).describe('Note ids open as tabs in the notes dock, in tab order'),
    notesActiveTab: z.string().nullable().describe('Note id of the active notes-dock tab (null = list view)'),
});

//
// NOTE: Local settings are device-specific and should NOT be synced.
// These are preferences that make sense to be different on each device.
//

const LocalSettingsSchemaPartial = LocalSettingsSchema.passthrough().partial();

export type LocalSettings = z.infer<typeof LocalSettingsSchema>;

//
// Defaults
//

export const localSettingsDefaults: LocalSettings = {
    debugMode: false,
    devModeEnabled: false,
    voiceUpsellOverride: null,
    // very-happy: CMD+K command palette on by default (web product feature).
    commandPaletteEnabled: true,
    // very-happy: dark is the Console brand default (deck v2). Users can still
    // pick light/adaptive in Settings → Appearance.
    themePreference: 'dark',
    markdownCopyV2: false,
    consoleLoggingEnabled: false,
    verboseLogging: false,
    zenMode: false,
    assistantTranscriptPinned: false,
    // Default the desktop files sidebar to a thin rail so it doesn't eat ~25%
    // of width when there are no diffs; one click expands it (and it persists).
    filesSidebarCollapsed: true,
    // Default off: preserve existing per-agent default behavior. When a user
    // opts in, new sessions start in review-first mode.
    newSessionReviewFirst: false,
    acknowledgedCliVersions: {},
    sidebarWidth: null,
    filesPanelWidth: null,
    // Safe default: existing users keep the current home screen.
    homeView: 'normal',
    // Default = the lifecycle view (management by task completion).
    boardLayout: 'lifecycle',
    // Existing users keep the current sidebar (manual-order list).
    sidebarView: 'list',
    // Flat list by default; tag grouping is an opt-in lens.
    sidebarGroupByTag: false,
    // Default to per-key mode: it's the full-fidelity terminal; users who hit
    // IME pain opt into the line-input bar from the key bar toggle.
    terminalInputBarMode: false,
    // ⚠️ ROLLED BACK to 'xterm' the same day (2026-08-14). Owner field report on
    // the flipped default: Chinese IME still produced only English, plus a green
    // bar tracking the cursor (= the overlay itself, which must be invisible at
    // rest). Root cause not yet known.
    //
    // The process failure that let this ship: the hard gate
    // (`term-input-goldendiff.mjs`) covers NON-TEXT keys only — its README lists
    // "可打印字符与 IME 全线" as an explicit blind spot, and the spec's IME
    // replay scenarios (A–E) were never run. A gate that does not exercise the
    // very failure mode being fixed is not a gate for it. Do not flip this back
    // to 'own' until an IME replay harness reproduces real composition on the
    // new path and passes.
    terminalInputOwnership: 'xterm',
    // Default on: the tool exists to land text in the clipboard without
    // ceremony; the failure path degrades to the tap-to-copy toast.
    clipboardAutoCopy: true,
    // Both close guards default ON (Owner request): losing the open view to a
    // stray ⌘W is the annoyance; one switch each turns them back off.
    closeViewConfirm: true,
    closeTabWarning: true,
    notesPanelOpen: false,
    notesPanelWidth: null,
    notesOpenTabs: [],
    notesActiveTab: null,
};
Object.freeze(localSettingsDefaults);

//
// Parsing
//

export function localSettingsParse(settings: unknown): LocalSettings {
    const parsed = LocalSettingsSchemaPartial.safeParse(settings);
    if (!parsed.success) {
        return { ...localSettingsDefaults };
    }
    return { ...localSettingsDefaults, ...parsed.data };
}

//
// Applying changes
//

export function applyLocalSettings(settings: LocalSettings, delta: Partial<LocalSettings>): LocalSettings {
    return { ...localSettingsDefaults, ...settings, ...delta };
}
