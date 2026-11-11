import { ACCOUNT_SETTINGS_SCHEMA_VERSION, AccountSettingsSchema } from '@slopus/happy-wire';
import type * as z from 'zod';

//
// Settings Schema
//

// Current schema version for backward compatibility
export const SUPPORTED_SCHEMA_VERSION = ACCOUNT_SETTINGS_SCHEMA_VERSION;

export const SettingsSchema = AccountSettingsSchema;

//
// NOTE: Settings must be a flat object with no to minimal nesting, one field == one setting,
// you can name them with a prefix if you want to group them, but don't nest them.
// You can nest if value is a single value (like image with url and width and height)
// Settings are always merged with defaults and field by field.
//
// This structure must be forward and backward compatible. Meaning that some versions of the app
// could be missing some fields or have a new fields. Everything must be preserved and client must
// only touch the fields it knows about.
//

const SettingsSchemaPartial = SettingsSchema.partial();

export type Settings = z.infer<typeof SettingsSchema>;

//
// Defaults
//

export const settingsDefaults: Settings = {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    viewInline: false,
    inferenceOpenAIKey: null,
    expandTodos: true,
    showLineNumbers: true,
    showLineNumbersInToolViews: false,
    wrapLinesInDiffs: true,
    diffStyle: 'unified',
    analyticsOptOut: false,
    // very-happy: experimental features ship enabled by default — this is our
    // build, the "experimental" capabilities are part of the product.
    experiments: true,
    alwaysShowContextSize: true,
    agentInputEnterToSend: true,
    avatarStyle: 'gradient',
    showFlavorIcons: false,

    hideInactiveSessions: true,
    expResumeSession: true,
    fileDiffsSidebar: true,
    groupToolCalls: true,
    expImageUpload: true,
    reviewPromptAnswered: false,
    reviewPromptLikedApp: null,
    voiceAssistantLanguage: null,
    voiceTtsVoiceId: null,
    voiceReadTextReplies: false,
    assistantMachineId: null,
    assistantSkipPermissions: true,
    voicePttSound: true,
    voiceCustomAgentId: null,
    voiceBypassToken: false,
    preferredLanguage: null,
    recentMachinePaths: [],
    promptPresets: [],
    terminalCommands: [],
    // Empty = disabled. Shipping a real command here would silently run it for
    // every account on this server (invite-only but multi-tenant); each user
    // sets their own in Settings → Snippets (synced across devices).
    terminalStartupCommand: '',
    terminalStartupPresets: [],
    sessionPathPresets: [],
    lastUsedAgent: null,
    lastUsedPermissionMode: null,
    lastUsedModelMode: null,
    newSessionAgent: 'claude',
    newSessionAlwaysAsk: false,
    agentDefaultOverrides: {},
    modelFollowLatestMigratedAt: null,
    claudeLongContextOptOut: false,
    pinnedRows: [],
    sidebarOrder: [],
    sidebarSort: 'recent',
    feedbackActiveDays: 0,
    feedbackLastActiveDay: null,
    feedbackPromptShownAt: null,
    feedbackPromptOptOut: false,
    feedbackLastSubmittedAt: null,
};
Object.freeze(settingsDefaults);

//
// Resolving
//

export function settingsParse(settings: unknown): Settings {
    // Handle null/undefined/invalid inputs
    if (!settings || typeof settings !== 'object') {
        return { ...settingsDefaults };
    }

    const parsed = SettingsSchemaPartial.safeParse(settings);
    if (!parsed.success) {
        // This is our OWN decrypted settings, not untrusted input. A single
        // field that doesn't match the current schema (a legacy value, or one
        // written by a newer client) must NOT wipe every other setting back to
        // defaults — that silently drops user content like promptPresets /
        // terminalCommands on the next load. Keep all stored values; defaults
        // only fill in genuinely-missing keys.
        return { ...settingsDefaults, ...(settings as any) };
    }

    // Migration: Convert old 'zh' language code to 'zh-Hans'
    if (parsed.data.preferredLanguage === 'zh') {
        console.log('[Settings Migration] Converting language code from "zh" to "zh-Hans"');
        parsed.data.preferredLanguage = 'zh-Hans';
    }

    // Base on the RAW stored object, then let the validated+migrated values win.
    // Critical: never rely on parsed.data to carry every field — zod's partial
    // parse can omit a present field (observed with the promptPresets /
    // terminalCommands arrays), which previously dropped user content on every
    // load and then got written back, clobbering it server-side. Starting from
    // the raw object preserves both unknown fields AND any known field the parse
    // didn't surface, while defaults only fill genuinely-missing keys.
    return { ...settingsDefaults, ...(settings as any), ...parsed.data };
}

//
// Applying changes
// NOTE: May be something more sophisticated here around defaults and merging, but for now this is fine.
//

export function applySettings(settings: Settings, delta: Partial<Settings>): Settings {
    // Original behavior: start with settings, apply delta, fill in missing with defaults
    const result = { ...settings, ...delta };

    // Fill in any missing fields with defaults
    Object.keys(settingsDefaults).forEach(key => {
        if (!(key in result)) {
            (result as any)[key] = (settingsDefaults as any)[key];
        }
    });

    return result;
}

export function settingsToSyncPayload(settings: Settings): Partial<Settings> {
    const result: Partial<Settings> = { ...settings };
    const compactAgentOverrides = Object.fromEntries(
        Object.entries(settings.agentDefaultOverrides ?? {}).filter(([, value]) => (
            value && typeof value === 'object' && Object.keys(value).length > 0
        )),
    ) as Settings['agentDefaultOverrides'];
    if (Object.keys(compactAgentOverrides).length === 0) {
        delete result.agentDefaultOverrides;
    } else {
        result.agentDefaultOverrides = compactAgentOverrides;
    }
    return result;
}
