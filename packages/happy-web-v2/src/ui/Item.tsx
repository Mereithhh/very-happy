import type { ReactNode } from 'react';
import { Spinner } from './Spinner';
import { EXTERNAL_LINK } from '@/app/attribution';

/**
 * Settings/list row primitives (the v1 ItemList/ItemGroup/Item system, web).
 * Hairline-separated rows; sans label, mono technical sub-line.
 */
export function ItemList({ children }: { children: ReactNode }) {
  return <div className="vh-itemlist">{children}</div>;
}

/** `settingId` (B-575): stable anchor for settings search deep links
 *  (`data-setting-id`, see screens/settings/settingsIndex.ts). */
export function ItemGroup({ title, footer, children, settingId }: { title?: string; footer?: ReactNode; children: ReactNode; settingId?: string }) {
  return (
    <div className="vh-itemgroup" data-setting-id={settingId}>
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
  /** Off-site link: the row renders as an `<a>` that opens a new tab (noopener noreferrer). */
  href?: string;
  selected?: boolean;
  destructive?: boolean;
  multiline?: boolean;
  loading?: boolean;
  disabled?: boolean;
  /** B-575: settings search anchor, rendered as `data-setting-id`. */
  settingId?: string;
}

export function Item({
  title,
  subtitle,
  detail,
  left,
  right,
  onClick,
  href,
  selected,
  destructive,
  multiline,
  loading = false,
  disabled = false,
  settingId,
}: ItemProps) {
  const interactive = !!onClick || !!href;
  const Cmp: any = href ? 'a' : interactive ? 'button' : 'div';
  const linkProps = href ? { href, ...EXTERNAL_LINK } : { type: interactive ? 'button' : undefined, disabled: interactive ? disabled || loading : undefined };
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
      {...linkProps}
      aria-busy={loading || undefined}
      data-setting-id={settingId}
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
