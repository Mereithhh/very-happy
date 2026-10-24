// @vitest-environment happy-dom
/** B-798 G (P2-8, P2-12): dialog title by entry point; home copy when the list is hidden. */
import { describe, expect, it } from 'vitest';
import { renameDialogTitleKey } from './RenameModal';
import { emptyDetailListHidden } from './EmptyDetail';
import { en } from '@/text/_default';
import { zhHans } from '@/text/translations/zh-Hans';

describe('renameDialogTitleKey', () => {
  it('「标签…」 opens 名称与标签, not 重命名', () => {
    expect(renameDialogTitleKey(true, [])).toBe('renameModal.tagsTitle');
    expect(renameDialogTitleKey(true, ['a'])).toBe('renameModal.tagsTitle');
  });
  it('rename (and title-only daemons) keep 重命名', () => {
    expect(renameDialogTitleKey(false, ['a'])).toBe('common.rename');
    expect(renameDialogTitleKey(undefined, [])).toBe('common.rename');
    expect(renameDialogTitleKey(true, undefined)).toBe('common.rename');
  });
});

describe('emptyDetailListHidden', () => {
  it('is true in the drawer shell and with the sidebar collapsed', () => {
    expect(emptyDetailListHidden({ drawer: true, collapsed: false })).toBe(true);
    expect(emptyDetailListHidden({ drawer: false, collapsed: true })).toBe(true);
    expect(emptyDetailListHidden({ drawer: false, collapsed: false })).toBe(false);
  });
  it('the hidden-list copy does not point "on the left"', () => {
    expect(en.emptyState.pickUpDescriptionListHidden).not.toMatch(/on the left/);
    expect(zhHans.emptyState.pickUpDescriptionListHidden).not.toMatch(/左侧/);
    expect(zhHans.emptyState.showList).toBeTruthy();
    expect(zhHans.renameModal.tagsTitle).toBe('名称与标签');
  });
});
