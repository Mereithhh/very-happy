/** Google GIS accepts a pixel width and caps standard buttons at 400px. */
export const GOOGLE_BUTTON_MAX_WIDTH = 400;

/**
 * Return the exact width to pass to GIS once its host is measurable.
 * A hidden/unlaid-out host must wait instead of falling back to 400px: rendering
 * at 400 and later squeezing the iframe shell is what clips its inner document.
 */
export function googleButtonWidth(containerWidth: number): number | null {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return null;
  return Math.min(GOOGLE_BUTTON_MAX_WIDTH, Math.floor(containerWidth));
}
