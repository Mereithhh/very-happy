/** Sessions open a title + tags editor; terminals only support title rename. */
export function rowRenameMenuTranslationKeys(
  isTerminal: boolean,
): readonly ['common.rename'] | readonly ['common.rename', 'renameModal.tagsLabel'] {
  return isTerminal ? ['common.rename'] : ['common.rename', 'renameModal.tagsLabel'];
}
