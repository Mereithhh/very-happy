/**
 * Brand mark — the winking terminal window ("very happy" 2026-08 logo).
 * Left eye = prompt chevron ❯, right eye = block cursor ▮, plus the smile —
 * same geometry family as public/icon-512.png (master in skills tmp/vh-logo).
 * All strokes/fills use var(--accent) so it adapts per theme.
 */
export function CyberMark({ size = 28, glow = false }: { size?: number; glow?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden
      style={glow ? { filter: 'drop-shadow(0 0 6px var(--accent-glow))' } : undefined}
    >
      <rect x="1.5" y="1.5" width="29" height="29" rx="7" stroke="var(--accent)" strokeWidth="2" />
      <path
        d="M9 9.6 12.9 12.3 9 15.1"
        stroke="var(--accent)"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="19.1" y="9.2" width="3.9" height="6" rx="0.9" fill="var(--accent)" />
      <path
        d="M9.2 19.5C11 22 13.8 23.4 16 23.4s5-1.4 6.8-3.9"
        stroke="var(--accent)"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
    </svg>
  );
}
