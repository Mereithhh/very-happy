import { describe, expect, it } from 'vitest';
import { rowRenameMenuTranslationKeys } from './sidebarRowMenu';

describe('rowRenameMenuTranslationKeys', () => {
  it('makes tag editing explicit for session context menus', () => {
    expect(rowRenameMenuTranslationKeys(false)).toEqual(['common.rename', 'renameModal.tagsLabel']);
  });

  it('does not promise tags for terminals, which only persist titles', () => {
    expect(rowRenameMenuTranslationKeys(true)).toEqual(['common.rename']);
  });
});
