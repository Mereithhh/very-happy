import {
    codexContextThreadConfig,
    codexContextWindowsOf,
    readCodexContextMode,
    type CodexContextMode,
    type CodexContextWindows,
    type CodexModelWindowEntry,
} from '@slopus/happy-wire';

export type CodexContextModeFields = {
    codexContextMode: CodexContextMode;
    codexContextWindows?: Record<string, CodexContextWindows>;
};

/**
 * B-977: the session's 「上下文」 choice (standard / extended) and the thread
 * config it maps to. The wrapper is the sole writer of
 * `metadata.codexContextMode`; a message's `meta.codexContext` changes it,
 * taking effect from the next turn (runCodex reloads the thread then).
 */
export class CodexContextModeController {
    private windows = new Map<string, CodexModelWindowEntry>();

    constructor(
        private mode: CodexContextMode,
        private readonly publish: (fields: CodexContextModeFields) => void,
    ) {}

    get current(): CodexContextMode {
        return this.mode;
    }

    /** The catalog's sizes (`codex debug models`); publishes which models can run extended. */
    setCatalog(windows: Map<string, CodexModelWindowEntry>): void {
        this.windows = windows;
        this.publish({ codexContextMode: this.mode, codexContextWindows: this.publishedWindows() });
    }

    /** A message's `meta.codexContext`. True when the mode changed. */
    pick(raw: unknown): boolean {
        const next = readCodexContextMode(raw);
        if (!next || next === this.mode) return false;
        this.mode = next;
        this.publish({ codexContextMode: next });
        return true;
    }

    /** Thread config for a thread running `model` (unknown model → Codex's own default). */
    configFor(model: string | null | undefined): Record<string, number> {
        return codexContextThreadConfig(this.mode, model ? this.windows.get(model) : undefined);
    }

    private publishedWindows(): Record<string, CodexContextWindows> {
        const out: Record<string, CodexContextWindows> = {};
        for (const [model, entry] of this.windows) {
            const windows = codexContextWindowsOf(entry);
            if (windows) out[model] = windows;
        }
        return out;
    }
}
