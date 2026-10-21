import { BRAND, type BrandConfig } from '@/app/brand';
import { VeryHappyMark } from './VeryHappyMark';
import './brand.css';

function themedPair(light: string, dark: string | null, className: string, style: React.CSSProperties, alt = '') {
  if (!dark) return <img className={className} src={light} alt={alt} style={style} />;
  return (
    <>
      <img className={`${className} vh-brand-light`} src={light} alt={alt} style={style} />
      <img className={`${className} vh-brand-dark`} src={dark} alt={alt} style={style} />
    </>
  );
}

/** Square brand mark: the operator logo (light/dark pair, B-638) or the default VeryHappyMark (B-724). */
export function BrandIcon({ size, className = '', brand = BRAND }: { size: number; className?: string; brand?: BrandConfig }) {
  if (!brand.logoUrl) return <VeryHappyMark size={size} />;
  return themedPair(brand.logoUrl, brand.logoDarkUrl, `brand-icon${className ? ` ${className}` : ''}`, { width: size, height: size });
}

/** Environment tag next to the product name ("Staging"); renders nothing when unset. */
export function BrandEnvBadge({ className = '', brand = BRAND }: { className?: string; brand?: BrandConfig }) {
  if (!brand.envLabel) return null;
  return <span className={`brand-env${className ? ` ${className}` : ''}`}>{brand.envLabel}</span>;
}

/**
 * Brand lockup for auth cards, the public header and connect screens: the
 * VeryHappyMark + wordmark by default, or the operator's logo + name (B-624).
 */
export function BrandMark({ size, className, wordmarkClassName, wordmark, envBadge = true, brand = BRAND }: {
  size: number;
  className?: string;
  wordmarkClassName?: string;
  /** Override the text (e.g. the title-case name on the mobile login header). */
  wordmark?: string;
  /** Show the environment tag after the wordmark (B-638). */
  envBadge?: boolean;
  brand?: BrandConfig;
}) {
  const text = wordmark ?? brand.wordmark;
  const badge = envBadge && <BrandEnvBadge brand={brand} />;
  return (
    <div className={className}>
      <BrandIcon size={size} brand={brand} />
      {wordmarkClassName ? <div className={wordmarkClassName}>{text}{badge}</div> : <span>{text}{badge}</span>}
    </div>
  );
}

/**
 * B-638: where there is room, the operator's horizontal lockup (logo + company
 * wordmark) replaces the icon + name pair. Falls back to `BrandMark`.
 */
export function BrandLockup({ height, size, className, wordmarkClassName, brand = BRAND }: {
  /** Image height when a wordmark asset is configured. */
  height: number;
  /** Icon size for the `BrandMark` fallback. */
  size: number;
  className?: string;
  wordmarkClassName?: string;
  brand?: BrandConfig;
}) {
  if (!brand.wordmarkUrl) return <BrandMark size={size} className={className} wordmarkClassName={wordmarkClassName} brand={brand} />;
  return (
    <div className={`brand-lockup${className ? ` ${className}` : ''}`}>
      {themedPair(brand.wordmarkUrl, brand.wordmarkDarkUrl, 'brand-lockup-img', { height }, brand.name)}
      <BrandEnvBadge brand={brand} />
    </div>
  );
}
