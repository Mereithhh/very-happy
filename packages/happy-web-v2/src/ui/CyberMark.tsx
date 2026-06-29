/**
 * Brand mark — the geometric "very happy" face. Mark background = text color,
 * face fill = currentColor of the surface, so it auto-inverts per theme.
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
      <rect x="1.5" y="1.5" width="29" height="29" rx="8" stroke="var(--accent)" strokeWidth="2" />
      <circle cx="11" cy="13" r="1.8" fill="var(--accent)" />
      <circle cx="21" cy="13" r="1.8" fill="var(--accent)" />
      <path
        d="M10 19c1.6 2.6 4 3.9 6 3.9s4.4-1.3 6-3.9"
        stroke="var(--accent)"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
