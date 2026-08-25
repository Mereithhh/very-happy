export type DoctorProcessDisplay = {
    pid: number;
    command: string;
};

type DoctorRuntime = {
    pid: number;
    version: string;
    platform: NodeJS.Platform;
    arch: string;
};

/**
 * Process arguments can contain prompts, tokens, or arbitrary ACP adapter
 * flags. Doctor needs the PID and classification for cleanup diagnostics, but
 * never needs to echo argv into shareable terminal output.
 */
export function shareSafeProcessLine(process: DoctorProcessDisplay): string {
    return `PID ${process.pid}: command arguments hidden for privacy`;
}

/**
 * daemon.state.json contains the bearer credential for the loopback control
 * plane. Doctor output is routinely pasted into issues and must never echo the
 * token; presence is enough to diagnose old/new daemon compatibility.
 */
export function shareSafeDaemonState(
    state: DaemonLocallyPersistedState,
): Omit<DaemonLocallyPersistedState, 'controlToken'> & { controlAuthentication: 'configured' | 'legacy' } {
    const { controlToken, ...shareSafeState } = state;
    return {
        ...shareSafeState,
        controlAuthentication: controlToken ? 'configured' : 'legacy',
    };
}

/** Keep startup diagnostics useful without persisting argv, local paths, or usernames. */
export function shareSafeEnvironmentInfo(
    env: NodeJS.ProcessEnv = process.env,
    runtime: DoctorRuntime = process,
): Record<string, boolean | number | string> {
    const knownNodeEnvironments = new Set(['development', 'production', 'test']);
    const nodeEnvironment = env.NODE_ENV
        ? (knownNodeEnvironments.has(env.NODE_ENV) ? env.NODE_ENV : 'custom')
        : 'not set';

    return {
        happyHomeDirConfigured: Boolean(env.HAPPY_HOME_DIR),
        happyVariantConfigured: Boolean(env.HAPPY_VARIANT),
        customServerUrlConfigured: Boolean(env.HAPPY_SERVER_URL),
        projectRootConfigured: Boolean(env.HAPPY_PROJECT_ROOT),
        remoteDebugLoggingEnabled: Boolean(env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING),
        debugEnabled: Boolean(env.DEBUG),
        nodeEnvironment,
        processPid: runtime.pid,
        nodeVersion: runtime.version,
        platform: runtime.platform,
        arch: runtime.arch,
        shellConfigured: Boolean(env.SHELL),
        terminalConfigured: Boolean(env.TERM),
    };
}
import type { DaemonLocallyPersistedState } from '@/persistence';
