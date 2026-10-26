/**
 * An operator configuration mistake that stops the server from starting.
 *
 * Startup failures are normally logged as `safeErrorMetadata` only, which
 * drops the message. A StartupConfigError's message is written for the
 * operator (what is wrong and how to fix it) and must never carry secrets or
 * request content, so the standalone entrypoints print it verbatim.
 */
export class StartupConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'StartupConfigError';
    }
}

/** The operator-facing fix for a startup config error; undefined for any other error. */
export function startupConfigErrorMessage(error: unknown): string | undefined {
    return error instanceof StartupConfigError ? error.message : undefined;
}
