/**
 * Author credit and source links (Owner 10-27: 「带上 github link，说一下是我开发的」).
 * One owner for every place that says who built Very Happy and where the code lives —
 * public footers, the share page, login, Settings → About and Help. Pure module (no React,
 * no i18n) so the anonymous public root can import it without the app bundle.
 */
export const AUTHOR_NAME = 'Mereithhh (JoJo)';
export const AUTHOR_URL = 'https://github.com/Mereithhh';
export const REPO_URL = 'https://github.com/Mereithhh/very-happy';
export const NEW_ISSUE_URL = `${REPO_URL}/issues/new`;

/** Every off-site link opens a new tab without handing this page to the target (no window.opener, no Referer). */
export const EXTERNAL_LINK = { target: '_blank', rel: 'noopener noreferrer' } as const;

/**
 * The build id shown in About. Production builds bake the release commit (VH_VERSION, 40 hex)
 * → its 7-char short sha; a dev build or an old timestamp salt is shown as is.
 */
export function shortBuildId(version: string): string {
  return /^[0-9a-f]{40}$/i.test(version) ? version.slice(0, 7) : version;
}

/** Commit page for a full release sha; null when the build id is not a commit. */
export function buildCommitUrl(version: string): string | null {
  return /^[0-9a-f]{40}$/i.test(version) ? `${REPO_URL}/commit/${version}` : null;
}
