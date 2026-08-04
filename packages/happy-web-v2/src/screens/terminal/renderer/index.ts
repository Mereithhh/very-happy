/**
 * Renderer factory. Selects a TerminalRenderer implementation by kind. Only
 * 'xterm' exists today; a future ghostty/Restty renderer registers here and can
 * be chosen behind a flag for A/B without touching the terminal screen's core.
 */
import type { TerminalRenderer, RendererKind, RendererOptions } from './TerminalRenderer';
import { createXtermRenderer } from './xtermRenderer';

export type { TerminalRenderer, RendererKind, RendererOptions } from './TerminalRenderer';

export function createTerminalRenderer(kind: RendererKind, opts: RendererOptions): TerminalRenderer {
    switch (kind) {
        case 'xterm':
        default:
            return createXtermRenderer(opts);
    }
}
