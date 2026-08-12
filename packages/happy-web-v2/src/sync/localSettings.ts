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
    // Web terminal (mobile): line-input mode — a plain textarea below the key
    // bar composes whole lines (IME/dictation-friendly, no xterm composition
    // quirks) and sends them to the pty on Enter, instead of per-key input
    // through xterm's hidden textarea. Device-local on purpose: it's an
    // input-hardware preference (phone vs desktop), not an account preference.
    terminalInputBarMode: z.boolean().describe('Use the line-input bar (compose + send) instead of per-key input in the mobile web terminal'),
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
    // Default the desktop files sidebar to a thin rail so it doesn't eat ~25%
    // of width when there are no diffs; one click expands it (and it persists).
    filesSidebarCollapsed: true,
    // Default off: preserve existing per-agent default behavior. When a user
    // opts in, new sessions start in review-first mode.
    newSessionReviewFirst: false,
    acknowledgedCliVersions: {},
    sidebarWidth: null,
    // Safe default: existing users keep the current home screen.
    homeView: 'normal',
    // Default = the lifecycle view (management by task completion).
    boardLayout: 'lifecycle',
    // Existing users keep the current sidebar (manual-order list).
    sidebarView: 'list',
    // Default to per-key mode: it's the full-fidelity terminal; users who hit
    // IME pain opt into the line-input bar from the key bar toggle.
    terminalInputBarMode: false,
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
