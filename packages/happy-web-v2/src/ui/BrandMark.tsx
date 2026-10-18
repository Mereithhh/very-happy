import { BRAND } from '@/app/brand';
import { CyberMark } from './CyberMark';

/**
 * Brand lockup for auth cards, the public header and connect screens: the
 * CyberMark + wordmark by default, or the operator's logo + name (B-624).
 */
export function BrandMark({ size, className, wordmarkClassName, wordmark = BRAND.wordmark }: {
  size: number;
  className?: string;
  wordmarkClassName?: string;
  /** Override the text (e.g. the title-case name on the mobile login header). */
  wordmark?: string;
}) {
  return (
    <div className={className}>
      {BRAND.logoUrl
        ? <img src={BRAND.logoUrl} alt="" width={size} height={size} style={{ width: size, height: size, objectFit: 'contain' }} />
        : <CyberMark size={size} />}
      {wordmarkClassName ? <div className={wordmarkClassName}>{wordmark}</div> : <span>{wordmark}</span>}
    </div>
  );
}
