import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Spinner } from './Spinner';
import { useDelayedFlag } from './useDelayedFlag';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'xs' | 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  fullWidth?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

/**
 * B-590 (design-language §6 反馈时机): `loading` disables the button at once
 * (no double submit) but the Spinner only appears after ~200ms, so a fast
 * round trip shows nothing. The Spinner never changes the button's width:
 * with a `leftIcon` it stacks in the icon's own slot; without one it is laid
 * over the (transparent) label. `rightIcon` keeps its place while loading.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    fullWidth = false,
    leftIcon,
    rightIcon,
    disabled,
    children,
    className,
    ...rest
  },
  ref,
) {
  const busy = useDelayedFlag(loading);
  const spinner = busy ? (
    <Spinner
      size={size === 'sm' || size === 'xs' ? 12 : 14}
      color={variant === 'primary' ? 'var(--accent-ink)' : 'currentColor'}
      className="vh-btn-spinner"
    />
  ) : null;
  const overlay = busy && !leftIcon;
  return (
    <button
      ref={ref}
      className={[
        'vh-btn',
        `vh-btn--${variant}`,
        `vh-btn--${size}`,
        fullWidth ? 'vh-btn--full' : '',
        overlay ? 'vh-btn--busy' : '',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
      disabled={disabled || loading}
      aria-busy={loading}
      {...rest}
    >
      {leftIcon ? (
        <span className="vh-btn-slot" data-busy={busy || undefined}>
          {leftIcon}
          {spinner}
        </span>
      ) : null}
      {overlay ? <span className="vh-btn-label">{children}</span> : children}
      {rightIcon}
      {overlay && spinner}
    </button>
  );
});
