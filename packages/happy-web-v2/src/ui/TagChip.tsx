import { X } from 'lucide-react';
import { tagHueIndex } from '@/utils/tags';
import './tagchip.css';

/**
 * A session-tag chip. Color derives from a stable hash of the tag text into
 * one of the 6 low-saturation hue slots defined in tagchip.css (Console
 * palette-coordinated, theme-aware). `onRemove` renders the editor variant
 * (rename modal); without it the chip is a compact display atom (sidebar).
 */
export function TagChip({
  tag,
  small,
  onRemove,
  onClick,
}: {
  tag: string;
  /** Sidebar-density variant (smaller type / tighter padding). */
  small?: boolean;
  onRemove?: () => void;
  onClick?: () => void;
}) {
  const hue = tagHueIndex(tag);
  const cls = `vh-tag vh-tag--h${hue}${small ? ' vh-tag--sm' : ''}${onClick ? ' vh-tag--btn' : ''}`;
  const body = (
    <>
      <span className="vh-tag-text">{tag}</span>
      {onRemove && (
        <button
          className="vh-tag-x"
          aria-label={`remove ${tag}`}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <X size={11} />
        </button>
      )}
    </>
  );
  if (onClick) {
    return (
      <button type="button" className={cls} onClick={onClick} title={tag}>
        {body}
      </button>
    );
  }
  return (
    <span className={cls} title={tag}>
      {body}
    </span>
  );
}

/** Overflow marker chip ("+2") — same footprint, neutral color. */
export function TagOverflowChip({ count, small }: { count: number; small?: boolean }) {
  return <span className={`vh-tag vh-tag--more${small ? ' vh-tag--sm' : ''}`}>+{count}</span>;
}
