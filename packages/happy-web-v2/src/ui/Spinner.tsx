interface SpinnerProps {
  size?: number;
  color?: string;
  className?: string;
}

export function Spinner({ size = 16, color, className }: SpinnerProps) {
  return (
    <span
      className={`vh-spinner${className ? ` ${className}` : ''}`}
      style={{
        width: size,
        height: size,
        borderColor: color,
        borderTopColor: 'transparent',
      }}
      aria-label="loading"
      role="status"
    />
  );
}
