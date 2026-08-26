import { describe, expect, it } from 'vitest';
import { rowRenameMenuTranslationKeys } from './sidebarRowMenu';

describe('rowRenameMenuTranslationKeys', () => {
  it('makes tag editing explicit for session context menus', () => {
    expect(rowRenameMenuTranslationKeys(true)).toEqual(['common.rename', 'renameModal.tagsLabel']);
  });

  it('does not promise tags when an old terminal daemon lacks support', () => {
    expect(rowRenameMenuTranslationKeys(false)).toEqual(['common.rename']);
  });
});
