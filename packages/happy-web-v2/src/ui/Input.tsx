import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string | null;
  valid?: boolean;
  leftIcon?: ReactNode;
  rightSlot?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, valid, leftIcon, rightSlot, className, id, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const describedBy = error ? `${inputId}-err` : hint ? `${inputId}-hint` : undefined;

  return (
    <div className={`vh-field${className ? ` ${className}` : ''}`}>
      {label && (
        <label className="vh-field__label" htmlFor={inputId}>
          {label}
        </label>
      )}
      <div
        className={[
          'vh-input-wrap',
          error ? 'is-error' : '',
          valid ? 'is-valid' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {leftIcon && <span className="vh-input__left">{leftIcon}</span>}
        <input
          ref={ref}
          id={inputId}
          className="vh-input"
          aria-invalid={!!error}
          aria-describedby={describedBy}
          {...rest}
        />
        {rightSlot && <span className="vh-input__right">{rightSlot}</span>}
      </div>
      {error ? (
        <div id={`${inputId}-err`} className="vh-field__error">
          {error}
        </div>
      ) : hint ? (
        <div id={`${inputId}-hint`} className="vh-field__hint">
          {hint}
        </div>
      ) : null}
    </div>
  );
});
