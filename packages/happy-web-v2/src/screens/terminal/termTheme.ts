/**
 * The xterm palette as a shared module (B-867: the operator terminal pane).
 * Same values as WebTerminalScreen's THEME — console-token-derived hexes,
 * because xterm paints from these strings and cannot resolve var(). The
 * terminal stays dark in both app themes (AGENTS: terminal panes are always
 * dark). Keep in sync with WebTerminalScreen until it imports this too.
 */
export const TERM_THEME: Record<string, string> = {
    background: '#06080C', foreground: '#E8EDF4',
    cursor: '#34E2C4', cursorAccent: '#04110E',
    selectionBackground: 'rgba(52,226,196,0.24)',
    selectionInactiveBackground: 'rgba(52,226,196,0.13)',
    black: '#10161F', brightBlack: '#5B6675',
    red: '#FF6B6B', brightRed: '#FF9B94',
    green: '#68D26E', brightGreen: '#8BE890',
    yellow: '#E6B450', brightYellow: '#F2C97D',
    blue: '#7AA2D6', brightBlue: '#9FC0EF',
    magenta: '#C792EA', brightMagenta: '#DDB3F8',
    cyan: '#34E2C4', brightCyan: '#7CEEDD',
    white: '#B7C2D0', brightWhite: '#E8EDF4',
};
