import { z } from 'zod';

/**
 * B-920: the machine-local settings (`$HAPPY_HOME_DIR/settings.json`) that
 * `very-happy settings --scope machine` may write, with the value shape each
 * accepts. Only these keys are writable; everything else in the file
 * (`machineId`, `todoProvider`, `webPanels`, credentials, …) is not.
 *
 * Bounds mirror what the daemon already clamps to (hibernation 1h–24h or 0 = off,
 * auto-restore at most 20 terminals) so a value that passes here is the value
 * that takes effect.
 */
export const MACHINE_HIBERNATION_MIN_MS = 60 * 60 * 1000;
export const MACHINE_HIBERNATION_MAX_MS = 24 * 60 * 60 * 1000;
export const MACHINE_AUTO_RESTORE_HARD_MAX = 20;

export const MachineSandboxConfigSchema = z.object({
    enabled: z.boolean(),
    workspaceRoot: z.string().optional(),
    sessionIsolation: z.enum(['strict', 'workspace', 'custom']).optional(),
    customWritePaths: z.array(z.string()).optional(),
    denyReadPaths: z.array(z.string()).optional(),
    extraWritePaths: z.array(z.string()).optional(),
    denyWritePaths: z.array(z.string()).optional(),
    networkMode: z.enum(['blocked', 'allowed', 'custom']).optional(),
    allowedDomains: z.array(z.string()).optional(),
    deniedDomains: z.array(z.string()).optional(),
    allowLocalBinding: z.boolean().optional(),
}).strict();
export type MachineSandboxConfig = z.infer<typeof MachineSandboxConfigSchema>;

const httpUrl = z.string().url().max(2048).refine((value) => /^https?:\/\//i.test(value), 'must be an http(s) URL');

export const MachineSettingsWritableSchema = z.object({
    agentHibernationIdleMs: z.number().int().refine(
        (value) => value === 0 || (value >= MACHINE_HIBERNATION_MIN_MS && value <= MACHINE_HIBERNATION_MAX_MS),
        `0 (off) or ${MACHINE_HIBERNATION_MIN_MS}–${MACHINE_HIBERNATION_MAX_MS} ms`,
    ),
    autoRestartSessions: z.boolean(),
    agentAutoUpdate: z.boolean(),
    cliAutoUpdate: z.enum(['off', 'idle']),
    terminalAutoRestore: z.boolean(),
    terminalAutoRestoreMax: z.number().int().min(0).max(MACHINE_AUTO_RESTORE_HARD_MAX),
    terminalAutoRestoreWindowHours: z.number().positive().max(24 * 30),
    // High-risk keys (an owner decision first; see the CLI's settings policy).
    claudeCredentialStore: z.enum(['auto', 'file']),
    serverUrl: httpUrl,
    webappUrl: httpUrl,
    sandboxConfig: MachineSandboxConfigSchema,
}).partial();
export type MachineSettingsWritable = z.infer<typeof MachineSettingsWritableSchema>;
export type MachineSettingsWritableKey = keyof MachineSettingsWritable;
export const MACHINE_SETTINGS_WRITABLE_KEYS = Object.keys(MachineSettingsWritableSchema.shape) as MachineSettingsWritableKey[];
