import type { ReactNode } from 'react';
import { Spinner } from './Spinner';

/**
 * Settings/list row primitives (the v1 ItemList/ItemGroup/Item system, web).
 * Hairline-separated rows; sans label, mono technical sub-line.
 */
export function ItemList({ children }: { children: ReactNode }) {
  return <div className="vh-itemlist">{children}</div>;
}

export function ItemGroup({ title, footer, children }: { title?: string; footer?: ReactNode; children: ReactNode }) {
  return (
    <div className="vh-itemgroup">
      {title && <div className="vh-itemgroup__title eyebrow">{title}</div>}
      <div className="vh-itemgroup__body">{children}</div>
      {footer && <div className="vh-itemgroup__footer">{footer}</div>}
    </div>
  );
}

interface ItemProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** mono technical sub-line */
  detail?: ReactNode;
  left?: ReactNode;
  right?: ReactNode;
  onClick?: () => void;
  selected?: boolean;
  destructive?: boolean;
  multiline?: boolean;
  loading?: boolean;
  disabled?: boolean;
}

export function Item({
  title,
  subtitle,
  detail,
  left,
  right,
  onClick,
  selected,
  destructive,
  multiline,
  loading = false,
  disabled = false,
}: ItemProps) {
  const interactive = !!onClick;
  const Cmp: any = interactive ? 'button' : 'div';
  return (
    <Cmp
      className={[
        'vh-item',
        selected ? 'is-selected' : '',
        destructive ? 'is-destructive' : '',
        multiline ? 'is-multiline' : '',
        interactive ? 'is-interactive' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={onClick}
      type={interactive ? 'button' : undefined}
      disabled={interactive ? disabled || loading : undefined}
      aria-busy={loading || undefined}
    >
      {left && <span className="vh-item__left">{left}</span>}
      <span className="vh-item__text">
        <span className="vh-item__title">{title}</span>
        {subtitle && <span className="vh-item__subtitle">{subtitle}</span>}
        {detail && <span className="vh-item__detail">{detail}</span>}
      </span>
      {(loading || right) && <span className="vh-item__right">{loading ? <Spinner size={14} /> : right}</span>}
    </Cmp>
  );
}
