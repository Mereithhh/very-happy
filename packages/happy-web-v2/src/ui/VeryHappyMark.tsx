import { MARK_PIXELS_16, markPath, pixelPath } from './veryHappyMarkGeometry';

const MARK_D = markPath();
const MARK_16_D = pixelPath(MARK_PIXELS_16);

/**
 * Brand mark — the reverse-video ^_^ block (B-724): a solid cursor block with the
 * kaomoji knocked out, so the face shows whatever surface sits behind it.
 * Monochrome theme ink (--text); --accent stays reserved for live state.
 * At ≤16 px the hand-placed pixel map replaces the vector so the carets stay crisp.
 */
export function VeryHappyMark({ size = 28, className }: { size?: number; className?: string }) {
  const pixel = size <= 16;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={pixel ? '0 0 16 16' : '0 0 96 96'}
      shapeRendering={pixel ? 'crispEdges' : undefined}
      aria-hidden
    >
      <path fill="var(--text)" fillRule="evenodd" d={pixel ? MARK_16_D : MARK_D} />
    </svg>
  );
}
