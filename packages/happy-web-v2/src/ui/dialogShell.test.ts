import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * B-728 (UI-P1-05/06): one dialog shell. Every form-dialog family wears the
 * shared .vh-dialog classes; no overlay blurs (design-language §5.7); the
 * phone sheet pins its footer.
 */
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const FAMILIES: Record<string, string[]> = {
  '../modal/ModalProvider.tsx': ['vh-dialog-overlay', 'vh-modal-card vh-dialog"', 'vh-dialog-foot'],
  '../screens/sessions/NewSessionModal.tsx': ['vh-dialog-overlay', 'vh-dialog vh-dialog--tall', '<DialogHead', 'vh-dialog-foot'],
  '../screens/sessions/NewTerminalModal.tsx': ['vh-dialog-overlay', 'vh-dialog vh-dialog--tall', '<DialogHead', 'vh-dialog-foot'],
  '../screens/sessions/AttachTmuxModal.tsx': ['vh-dialog-overlay', 'vh-dialog vh-dialog--tall', '<DialogHead', 'vh-dialog-foot'],
  '../screens/sessions/ImportHistoryModal.tsx': ['vh-dialog-overlay', 'vh-dialog vh-dialog--tall', '<DialogHead', 'vh-dialog-foot'],
  '../screens/sessions/RenameModal.tsx': ['vh-dialog-overlay', 'rn-card vh-dialog"', '<DialogHead', 'vh-dialog-foot'],
  '../screens/projects/MoveToProjectModal.tsx': ['vh-dialog-overlay', 'ns-card vh-dialog"', '<DialogHead', 'vh-dialog-foot'],
  '../screens/session/WorktreeSetupBanner.tsx': ['vh-dialog-overlay', 'wts-card vh-dialog', '<DialogHead', 'vh-dialog-foot'],
  '../screens/board/TaskBoardScreen.tsx': ['vh-dialog-overlay', 'bd-modal vh-dialog"', '<DialogHead', 'vh-dialog-foot'],
  '../screens/terminal/TmuxHelpModal.tsx': ['vh-dialog-overlay', 'tmux-card vh-dialog', '<DialogHead'],
  '../screens/session/ClaudeRuntimeDialog.tsx': ['vh-dialog-overlay', 'vh-dialog vh-dialog--flush so-dialog', 'vh-dialog-close'],
  '../screens/session/git/GitActionDialog.tsx': ['vh-dialog-overlay', 'vh-dialog so-dialog', 'vh-dialog-close', 'vh-dialog-foot gd-actions'],
  '../screens/session/ShareDialog.tsx': ['vh-dialog-overlay', 'vh-dialog so-dialog', 'vh-dialog-close'],
  '../components/modelConfig/ModelConfigEditor.tsx': ['vh-dialog-overlay', 'vh-dialog so-dialog', 'vh-dialog-close'],
  '../screens/teams/TeamProject.tsx': ['<TeamDialog', 'team-project-confirm vh-dialog-foot'],
  '../screens/teams/TeamDialog.tsx': ['vh-dialog vh-dialog--tall teams-dialog', 'vh-dialog-head', 'vh-dialog-close'],
};

describe('one dialog shell (B-728)', () => {
  it.each(Object.entries(FAMILIES))('%s wears the shared classes', (file, needles) => {
    const src = read(file);
    for (const n of needles) expect(src, `${file} → ${n}`).toContain(n);
  });

  it('no dialog overlay blurs the page behind it (§5.7)', () => {
    for (const css of ['../modal/modal.css', '../screens/sessions/newsession.css', '../screens/session/sessionOptionsDialog.css',
      '../screens/teams/teams.css', '../screens/terminal/tmuxhelp.css', '../screens/board/board.css',
      '../screens/command/commandpalette.css', '../app/changelogNotice.css', '../styles/dialog.css']) {
      expect(strip(read(css)), css).not.toMatch(/backdrop-filter:\s*blur/);
    }
  });

  it('the shell: scrim backdrop, right-aligned footer, phone sheet with a sticky 48px footer', () => {
    const css = strip(read('../styles/dialog.css'));
    expect(css).toMatch(/\.vh-dialog-overlay \{[^}]*background: var\(--scrim\)/);
    expect(css).toMatch(/\.vh-dialog-foot \{[^}]*justify-content: flex-end/);
    const phone = css.slice(css.indexOf('@media (max-width: 600px)'));
    expect(phone).toMatch(/:root \.vh-dialog-foot \{[^}]*position: sticky;[^}]*bottom: 0/);
    expect(phone).toMatch(/:root \.vh-dialog-foot > :is\(button, a, \.vh-btn\) \{[^}]*min-height: 48px/);
    expect(phone).toMatch(/:root \.vh-dialog \{[^}]*border-radius: var\(--r-lg\) var\(--r-lg\) 0 0/);
    expect(read('../main.tsx')).toContain("import './styles/dialog.css';");
  });

  it('the teams <dialog> no longer autofocuses its ×', () => {
    expect(read('../screens/teams/TeamDialog.tsx')).not.toMatch(/autoFocus/);
  });
});
