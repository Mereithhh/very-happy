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
    themePreference: 'adaptive',
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
