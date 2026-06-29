import type { ReactNode } from 'react';

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
    >
      {left && <span className="vh-item__left">{left}</span>}
      <span className="vh-item__text">
        <span className="vh-item__title">{title}</span>
        {subtitle && <span className="vh-item__subtitle">{subtitle}</span>}
        {detail && <span className="vh-item__detail">{detail}</span>}
      </span>
      {right && <span className="vh-item__right">{right}</span>}
    </Cmp>
  );
}
