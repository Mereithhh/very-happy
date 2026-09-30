/**
 * Generate temporary settings file with Claude hooks for session tracking
 * 
 * Creates a settings.json file that configures Claude's SessionStart hook
 * to notify our HTTP server when sessions change (new session, resume, compact, etc.)
 */

import { join, resolve } from 'node:path';
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { projectPath } from '@/projectPath';

/**
 * Generate a temporary settings file with SessionStart hook configuration
 * 
 * @param port - The port where Happy server is listening
 * @param source - Optional tag the forwarder reports as `?source=` (B-515 prewarm)
 * @returns Path to the generated settings file
 */
export function generateHookSettingsFile(port: number, source?: string): string {
    const hooksDir = join(configuration.happyHomeDir, 'tmp', 'hooks');
    mkdirSync(hooksDir, { recursive: true });

    // Unique filename per process (and per tagged source) to avoid conflicts
    const filename = source ? `session-hook-${process.pid}-${source}.json` : `session-hook-${process.pid}.json`;
    const filepath = join(hooksDir, filename);

    // Path to the hook forwarder script. B-515: a tagged file makes the
    // forwarder post `?source=<source>` so the hook server can tell a
    // prewarmed Claude process's SessionStart apart from the live one's.
    const forwarderScript = resolve(projectPath(), 'scripts', 'session_hook_forwarder.cjs');
    if (source !== undefined && !/^[A-Za-z0-9_.-]{1,64}$/.test(source)) {
        throw new Error('invalid hook source tag');
    }
    const hookCommand = source
        ? `node "${forwarderScript}" ${port} ${source}`
        : `node "${forwarderScript}" ${port}`;

    const settings = {
        hooks: {
            SessionStart: [
                {
                    matcher: "*",
                    hooks: [
                        {
                            type: "command",
                            command: hookCommand
                        }
                    ]
                }
            ]
        }
    };

    writeFileSync(filepath, JSON.stringify(settings, null, 2));
    logger.debug(`[generateHookSettings] Created hook settings file: ${filepath}`);

    return filepath;
}

/**
 * Clean up the temporary hook settings file
 * 
 * @param filepath - Path to the settings file to remove
 */
export function cleanupHookSettingsFile(filepath: string): void {
    try {
        if (existsSync(filepath)) {
            unlinkSync(filepath);
            logger.debug(`[generateHookSettings] Cleaned up hook settings file: ${filepath}`);
        }
    } catch (error) {
        logger.debug(`[generateHookSettings] Failed to cleanup hook settings file: ${error}`);
    }
}

