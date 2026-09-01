/** Shell-escape a string for safe interpolation into a POSIX shell command
 *  line (single-quote wrapping; embedded quotes become `'\''`). Literal in
 *  sh/bash/zsh/fish single quotes alike. */
export function shellescape(s: string): string {
    return "'" + s.replace(/'/g, "'\\''") + "'";
}
